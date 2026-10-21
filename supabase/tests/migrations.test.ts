/**
 * Applies every migration to an in-process Postgres (PGlite) with Supabase stubs and
 * verifies constraints, RLS isolation, column privileges and queue semantics.
 */
import { PGlite } from '@electric-sql/pglite';
import { pgcrypto } from '@electric-sql/pglite/contrib/pgcrypto';
import { readdirSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';

const dir = join(import.meta.dirname, '..', 'migrations');
let db: PGlite;
let owner: string;

async function asUser<T>(uid: string | null, fn: () => Promise<T>): Promise<T> {
  await db.exec(uid ? `set role authenticated; set request.jwt.claim.sub = '${uid}';` : `set role anon; set request.jwt.claim.sub = '';`);
  try {
    return await fn();
  } finally {
    await db.exec(`reset role; set request.jwt.claim.sub = '';`);
  }
}

async function rejects(sql: string, params: unknown[] = []): Promise<string> {
  try {
    await db.query(sql, params);
  } catch (e) {
    return (e as Error).message;
  }
  throw new Error(`Expected failure: ${sql}`);
}

beforeAll(async () => {
  db = await PGlite.create({ extensions: { pgcrypto } });
  await db.exec(readFileSync(join(import.meta.dirname, 'supabase-stubs.sql'), 'utf8'));
  for (const file of readdirSync(dir).filter((f) => f.endsWith('.sql')).sort()) {
    await db.exec(readFileSync(join(dir, file), 'utf8'));
  }
  const r = await db.query<{ id: string }>(`insert into auth.users (email) values ('owner@example.com') returning id`);
  owner = r.rows[0]!.id;
}, 60_000);

afterAll(async () => {
  await db?.close();
});

describe('bootstrap & single-user guard', () => {
  it('creates a profile and automation rules for the owner', async () => {
    const p = await db.query(`select email from public.profiles where id = $1`, [owner]);
    expect(p.rows).toEqual([{ email: 'owner@example.com' }]);
    const r = await db.query(`select mode, paused, auto_apply_enabled from public.automation_rules where user_id = $1`, [owner]);
    expect(r.rows).toEqual([{ mode: 'manual', paused: false, auto_apply_enabled: false }]);
  });
  it('refuses a second account', async () => {
    expect(await rejects(`insert into auth.users (email) values ('intruder@example.com')`)).toMatch(/single-user/);
  });
});

describe('row level security', () => {
  it('isolates rows by user and hides everything from anon', async () => {
    const other = '00000000-0000-0000-0000-000000000099';
    // A foreign row for isolation checks (bypasses the single-user trigger on purpose).
    await db.exec(`set session_replication_role = replica; insert into auth.users (id, email) values ('${other}', 'other@example.com'); set session_replication_role = origin;`);
    await db.query(
      `insert into public.job_listings (user_id, source_key, external_id, fingerprint, title, company, apply_url)
       values ($1, 'test', '1', 'fp1', 'Frontend Developer', 'Acme', 'https://acme.dev/1'),
              ($2, 'test', '2', 'fp2', 'Hidden Job', 'Other', 'https://other.dev/2')`,
      [owner, other],
    );
    const mine = await asUser(owner, () => db.query(`select title from public.job_listings`));
    expect(mine.rows).toEqual([{ title: 'Frontend Developer' }]);
    expect(await asUser(null, () => rejects(`select * from public.job_listings`))).toMatch(/permission denied/);
    expect(await asUser(owner, () => rejects(`insert into public.job_listings (user_id, source_key, external_id, fingerprint, title, company, apply_url) values ($1,'x','x','x','x','x','https://x.y')`, [other]))).toMatch(/row-level security/);
  });

  it('never exposes Gmail tokens to the browser role', async () => {
    await db.query(`insert into public.gmail_connections (user_id, email, refresh_token_enc) values ($1, 'me@gmail.com', 'cipher')`, [owner]);
    const ok = await asUser(owner, () => db.query(`select email, status from public.gmail_connections`));
    expect(ok.rows).toEqual([{ email: 'me@gmail.com', status: 'connected' }]);
    expect(await asUser(owner, () => rejects(`select refresh_token_enc from public.gmail_connections`))).toMatch(/permission denied/);
    expect(await asUser(owner, () => rejects(`update public.gmail_connections set status = 'revoked'`))).toMatch(/permission denied/);
  });

  it('keeps automation-owned tables read-only for the user', async () => {
    expect(await asUser(owner, () => rejects(`insert into public.automation_runs (user_id, workflow) values ($1, 'job_discovery')`, [owner]))).toMatch(/permission denied/);
    expect(await asUser(owner, () => rejects(`update public.automation_rules set n8n_last_seen_at = now()`))).toMatch(/permission denied/);
    const upd = await asUser(owner, () => db.query(`update public.automation_rules set paused = true, paused_reason = 'test' returning paused_at is not null as stamped`));
    expect(upd.rows).toEqual([{ stamped: true }]);
  });

  it('restricts storage to the owner folder', async () => {
    await asUser(owner, () => db.query(`insert into storage.objects (bucket_id, name) values ('resumes', $1)`, [`${owner}/cv.pdf`]));
    expect(await asUser(owner, () => rejects(`insert into storage.objects (bucket_id, name) values ('resumes', 'someone-else/cv.pdf')`))).toMatch(/row-level security/);
    expect(await asUser(owner, () => rejects(`insert into storage.objects (bucket_id, name) values ('evidence', $1)`, [`${owner}/x.png`]))).toMatch(/row-level security/);
  });
});

describe('applications', () => {
  let jobId: string;
  beforeAll(async () => {
    const j = await db.query<{ id: string }>(`select id from public.job_listings where user_id = $1 limit 1`, [owner]);
    jobId = j.rows[0]!.id;
  });

  it('records status history and blocks "applied" without confirmation', async () => {
    const app = await asUser(owner, () =>
      db.query<{ id: string }>(`insert into public.applications (job_id, company, job_title) values ($1, 'Acme', 'Frontend Developer') returning id`, [jobId]),
    );
    const id = app.rows[0]!.id;
    expect(await asUser(owner, () => rejects(`update public.applications set status = 'applied' where id = $1`, [id]))).toMatch(/applied_requires_confirmation/);
    await asUser(owner, () => db.query(`update public.applications set status = 'applied', submitted_at = now(), confirmed_by = 'manual' where id = $1`, [id]));
    const events = await db.query(`select from_status, to_status from public.application_events where application_id = $1 order by created_at, to_status`, [id]);
    expect(events.rows).toEqual([
      { from_status: null, to_status: 'discovered' },
      { from_status: 'discovered', to_status: 'applied' },
    ]);
  });

  it('prevents duplicate applications and forged evidence', async () => {
    expect(await asUser(owner, () => rejects(`insert into public.applications (job_id, company, job_title) values ($1, 'Acme', 'Dup')`, [jobId]))).toMatch(/applications_job_unique/);
    expect(await asUser(owner, () => rejects(`update public.applications set submission_evidence = '{}'::jsonb`))).toMatch(/permission denied/);
    expect(await rejects(`update public.applications set confirmed_by = 'evidence', submission_evidence = null`)).toMatch(/applications_evidence_chk/);
  });
});

describe('automation queue', () => {
  it('claims queued runs exactly once and respects not_before / cancellation', async () => {
    await db.query(
      `insert into public.automation_runs (user_id, workflow, trigger, not_before, cancel_requested) values
        ($1, 'job_discovery', 'dashboard', null, false),
        ($1, 'job_matching', 'event', now() + interval '1 hour', false),
        ($1, 'gmail_sync', 'dashboard', null, true)`,
      [owner],
    );
    const first = await db.query<{ workflow: string; status: string }>(`select workflow, status from public.claim_automation_runs($1, 10)`, [owner]);
    expect(first.rows).toEqual([{ workflow: 'job_discovery', status: 'running' }]);
    const second = await db.query(`select * from public.claim_automation_runs($1, 10)`, [owner]);
    expect(second.rows).toHaveLength(0);
    const seen = await db.query(`select n8n_last_seen_at is not null as seen from public.automation_rules where user_id = $1`, [owner]);
    expect(seen.rows).toEqual([{ seen: true }]);
    expect(await asUser(owner, () => rejects(`select * from public.claim_automation_runs($1, 10)`, [owner]))).toMatch(/permission denied/);
  });

  it('reaps stale runs and cancels cancelled queued runs', async () => {
    await db.query(`update public.automation_runs set heartbeat_at = now() - interval '2 hours' where workflow = 'job_discovery'`);
    const r = await db.query<{ n: number }>(`select public.reap_stale_runs() as n`);
    expect(r.rows[0]!.n).toBe(1);
    const rows = await db.query(`select workflow, status from public.automation_runs order by workflow`);
    expect(rows.rows).toEqual([
      { workflow: 'gmail_sync', status: 'cancelled' },
      { workflow: 'job_discovery', status: 'failed' },
      { workflow: 'job_matching', status: 'queued' },
    ]);
  });

  it('enforces explicit auto-apply opt-in', async () => {
    const r = await asUser(owner, () => db.query(`update public.automation_rules set auto_apply_enabled = true returning auto_apply_opt_in_at is not null as opted`));
    expect(r.rows).toEqual([{ opted: true }]);
    const off = await asUser(owner, () => db.query(`update public.automation_rules set auto_apply_enabled = false returning auto_apply_opt_in_at`));
    expect(off.rows).toEqual([{ auto_apply_opt_in_at: null }]);
  });
});

describe('dashboard_stats', () => {
  it('returns counts scoped to the caller', async () => {
    const r = await asUser(owner, () => db.query<{ s: Record<string, number> }>(`select public.dashboard_stats() as s`));
    expect(r.rows[0]!.s).toMatchObject({ jobs_total: 1, submitted: 1, pending: 1 });
  });
});
