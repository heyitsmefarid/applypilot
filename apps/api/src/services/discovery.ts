import {
  DEFAULT_PREFERENCES,
  dedupeJobs,
  isExpired,
  jobFingerprint,
  jobPreferenceSchema,
  normalizedJobSchema,
  fitsSearchProfile,
  type NormalizedJob,
  type SourceKind,
} from '@applypilot/core';
import { extractJobPostings, jobPostingToNormalized, openGraphFallback, planDiscovery, finalizeJob, USER_AGENT, type SourceConfig } from '@applypilot/core/sources';
import { z } from 'zod';
import { HttpError } from '../lib/errors.js';
import { unwrap, type Db } from '../lib/supabase.js';
import { getActivePreferences } from './context.js';

const DEFAULT_SOURCES: Array<{ key: string; kind: SourceKind; name: string; enabled: boolean; config: Record<string, unknown>; automation_allowed?: boolean }> = [
  { key: 'remotive', kind: 'remotive', name: 'Remotive', enabled: true, config: { limit: 100 } },
  { key: 'jobicy', kind: 'jobicy', name: 'Jobicy', enabled: true, config: { count: 50 } },
  { key: 'himalayas', kind: 'himalayas', name: 'Himalayas', enabled: true, config: { limit: 20 } },
  { key: 'arbeitnow', kind: 'arbeitnow', name: 'Arbeitnow', enabled: false, config: { pages: 1 } },
  { key: 'greenhouse', kind: 'greenhouse', name: 'Company careers (Greenhouse)', enabled: false, config: { boards: [] } },
  { key: 'lever', kind: 'lever', name: 'Company careers (Lever)', enabled: false, config: { companies: [] } },
  { key: 'ashby', kind: 'ashby', name: 'Company careers (Ashby)', enabled: false, config: { organizations: [] } },
  { key: 'gmail_alert', kind: 'gmail_alert', name: 'Gmail job alerts (LinkedIn, Indeed, JobStreet, OnlineJobs.ph)', enabled: true, config: {} },
  { key: 'manual', kind: 'manual', name: 'Manual URL import', enabled: true, config: {} },
  // The local demo application form is the only source automation may submit to by default.
  { key: 'demo', kind: 'demo', name: 'Demo application form (local testing)', enabled: true, config: {}, automation_allowed: true },
];

/**
 * Rows for a bulk upsert. supabase-js sends a key missing from any row as NULL, so every row
 * must carry the same columns explicitly.
 */
export function defaultSourceRows(userId: string) {
  return DEFAULT_SOURCES.map((s) => ({ user_id: userId, key: s.key, kind: s.kind, name: s.name, enabled: s.enabled, config: s.config, automation_allowed: s.automation_allowed ?? false }));
}

/** Creates default search profiles and sources on first login (idempotent). */
export async function bootstrapDefaults(db: Db, userId: string) {
  const { count } = await db.from('job_preferences').select('id', { count: 'exact', head: true }).eq('user_id', userId);
  let preferences = 0;
  if (!count) {
    const rows = DEFAULT_PREFERENCES.map((p) => ({ user_id: userId, ...jobPreferenceSchema.parse(p) }));
    unwrap(await db.from('job_preferences').insert(rows).select('id'), 'seed preferences');
    preferences = rows.length;
  }
  const sources = unwrap(
    await db.from('job_sources').upsert(defaultSourceRows(userId), { onConflict: 'user_id,key', ignoreDuplicates: true }).select('id'),
    'seed sources',
  );
  await db.from('profiles').update({ onboarded_at: new Date().toISOString() }).eq('id', userId).is('onboarded_at', null);
  return { preferences_created: preferences, sources_created: sources?.length ?? 0 };
}

/** Workflow 1 step 1–2: which HTTP requests n8n should perform right now. */
export async function discoveryPlan(db: Db, userId: string, force = false) {
  const [sources, prefs] = await Promise.all([
    db.from('job_sources').select('key, kind, name, enabled, config, last_run_at').eq('user_id', userId).eq('enabled', true),
    getActivePreferences(db, userId),
  ]);
  const rows = unwrap(sources, 'load sources') as Array<SourceConfig & { last_run_at: string | null }>;
  const plan = planDiscovery(rows, prefs, { force });
  return {
    requests: plan.flatMap((p) => p.requests),
    skipped: plan.filter((p) => p.skipped).map((p) => ({ source_key: p.source.key, reason: p.skipped })),
    preferences: prefs.map((p) => p.name),
  };
}

export const ingestSchema = z.object({
  run_id: z.uuid().nullish(),
  source_key: z.string().min(1).max(80),
  jobs: z.array(z.unknown()).max(500),
  fetch_errors: z.array(z.object({ url: z.string().optional(), error: z.string() })).max(50).default([]),
  rejected: z.number().int().min(0).default(0),
});

const isRelevant = (job: NormalizedJob, prefs: Awaited<ReturnType<typeof getActivePreferences>>) => fitsSearchProfile(job, prefs);

/**
 * Workflow 1 steps 3–7: validates normalized jobs, drops irrelevant/expired ones, removes
 * duplicates (within the batch, against the same source, and across sources by fingerprint)
 * and upserts. Returns the ids of brand-new listings for matching.
 */
export async function ingestJobs(db: Db, userId: string, raw: z.input<typeof ingestSchema>, opts: { skipRelevance?: boolean } = {}) {
  const input = ingestSchema.parse(raw);
  const prefs = await getActivePreferences(db, userId);
  const invalid: string[] = [];
  const valid: NormalizedJob[] = [];
  for (const j of input.jobs) {
    const parsed = normalizedJobSchema.safeParse(j);
    if (!parsed.success) {
      invalid.push(parsed.error.issues[0]?.message ?? 'invalid');
      continue;
    }
    valid.push({ ...parsed.data, fingerprint: parsed.data.fingerprint ?? jobFingerprint(parsed.data) });
  }
  const now = new Date();
  const fresh = valid.filter((j) => !isExpired(j, now));
  const relevant = opts.skipRelevance ? fresh : fresh.filter((j) => isRelevant(j, prefs));
  const { unique, duplicates } = dedupeJobs(relevant);

  const { data: sourceRow } = await db.from('job_sources').select('id').eq('user_id', userId).eq('key', input.source_key.split(':')[0]!).maybeSingle();

  // Existing rows from this source → update last_seen; other sources with same fingerprint → cross-source duplicate.
  const externalIds = unique.map((j) => j.external_id);
  const fingerprints = unique.map((j) => j.fingerprint!);
  const [sameSource, sameFp] = await Promise.all([
    externalIds.length ? db.from('job_listings').select('id, source_key, external_id').eq('user_id', userId).in('external_id', externalIds) : Promise.resolve({ data: [], error: null }),
    fingerprints.length ? db.from('job_listings').select('id, source_key, external_id, fingerprint').eq('user_id', userId).in('fingerprint', fingerprints) : Promise.resolve({ data: [], error: null }),
  ]);
  const existingKeys = new Map((sameSource.data ?? []).map((r: { id: string; source_key: string; external_id: string }) => [`${r.source_key}::${r.external_id}`, r.id]));
  const fpOwners = new Map((sameFp.data ?? []).map((r: { id: string; fingerprint: string; source_key: string; external_id: string }) => [r.fingerprint, `${r.source_key}::${r.external_id}`]));

  const toInsert: Array<Record<string, unknown>> = [];
  const seenIds: string[] = [];
  let crossSourceDuplicates = 0;
  for (const j of unique) {
    const key = `${j.source_key}::${j.external_id}`;
    const existingId = existingKeys.get(key);
    if (existingId) {
      seenIds.push(existingId);
      continue;
    }
    const owner = fpOwners.get(j.fingerprint!);
    if (owner && owner !== key) {
      crossSourceDuplicates++;
      continue;
    }
    toInsert.push({
      ...j,
      user_id: userId,
      source_id: sourceRow?.id ?? null,
      discovery_run_id: input.run_id ?? null,
      discovered_at: now.toISOString(),
      last_seen_at: now.toISOString(),
    });
  }
  let insertedIds: string[] = [];
  if (toInsert.length) {
    const res = await db.from('job_listings').upsert(toInsert, { onConflict: 'user_id,source_key,external_id', ignoreDuplicates: true }).select('id');
    insertedIds = unwrap(res, 'insert jobs').map((r: { id: string }) => r.id);
  }
  if (seenIds.length) await db.from('job_listings').update({ last_seen_at: now.toISOString() }).in('id', seenIds);

  const stats = {
    received: input.jobs.length,
    invalid: invalid.length + input.rejected,
    expired: valid.length - fresh.length,
    irrelevant: fresh.length - relevant.length,
    duplicates_in_batch: duplicates.length,
    duplicates_cross_source: crossSourceDuplicates,
    already_known: seenIds.length,
    inserted: insertedIds.length,
    fetch_errors: input.fetch_errors.length,
  };
  if (sourceRow?.id) {
    await db
      .from('job_sources')
      .update({
        last_run_at: now.toISOString(),
        last_status: input.fetch_errors.length ? (input.jobs.length ? 'partial' : 'error') : 'ok',
        last_error: input.fetch_errors[0]?.error?.slice(0, 500) ?? null,
        last_job_count: insertedIds.length,
      })
      .eq('id', sourceRow.id);
  }
  return { inserted_ids: insertedIds, stats };
}

/** Workflow 1 step 6: marks listings expired by deadline, age, or disappearance from their API. */
export async function expireJobs(db: Db, userId: string) {
  const now = Date.now();
  const res1 = await db.from('job_listings').update({ status: 'expired' }).eq('user_id', userId).eq('status', 'active').lt('expires_at', new Date(now).toISOString()).select('id');
  const res2 = await db.from('job_listings').update({ status: 'expired' }).eq('user_id', userId).eq('status', 'active').lt('posted_at', new Date(now - 45 * 86_400_000).toISOString()).select('id');
  // API listings not seen for 10 days were most likely taken down (alerts/manual imports excluded).
  const res3 = await db
    .from('job_listings')
    .update({ status: 'expired' })
    .eq('user_id', userId)
    .eq('status', 'active')
    .in('source_key', ['remotive', 'arbeitnow', 'jobicy', 'himalayas', 'greenhouse', 'lever', 'ashby'])
    .lt('last_seen_at', new Date(now - 10 * 86_400_000).toISOString())
    .select('id');
  return { expired: (res1.data?.length ?? 0) + (res2.data?.length ?? 0) + (res3.data?.length ?? 0) };
}

const PRIVATE_HOST = /^(localhost|127\.|10\.|192\.168\.|172\.(1[6-9]|2\d|3[01])\.|169\.254\.|0\.|\[?::1\]?|\[?f[cd][0-9a-f]{2}:)|\.(local|internal|lan|home)$/i;

export function assertPublicUrl(raw: string): URL {
  let url: URL;
  try {
    url = new URL(raw);
  } catch {
    throw new HttpError(400, 'bad_url', 'Invalid URL');
  }
  if (url.protocol !== 'https:') throw new HttpError(400, 'bad_url', 'Only https:// job URLs can be imported');
  if (PRIVATE_HOST.test(url.hostname)) throw new HttpError(400, 'bad_url', 'Private network addresses are not allowed');
  if (/(^|\.)linkedin\.com$|(^|\.)indeed\.[a-z.]+$/i.test(url.hostname)) {
    throw new HttpError(
      400,
      'restricted_platform',
      'LinkedIn and Indeed do not permit automated access. Use their job-alert emails (Gmail integration) or add the job manually.',
    );
  }
  return url;
}

/** Imports one job from a career page URL using its schema.org JobPosting data (user-initiated). */
export async function importJobFromUrl(db: Db, userId: string, rawUrl: string, manual?: Partial<{ title: string; company: string; description: string; location: string }>) {
  const url = assertPublicUrl(rawUrl);
  let job: NormalizedJob | null = null;
  let note = '';
  try {
    const res = await fetch(url.toString(), { headers: { 'User-Agent': USER_AGENT, Accept: 'text/html' }, redirect: 'follow', signal: AbortSignal.timeout(12_000) });
    if (!res.ok) throw new Error(`HTTP ${res.status}`);
    const html = (await res.text()).slice(0, 1_500_000);
    const postings = extractJobPostings(html);
    if (postings[0]) {
      const r = jobPostingToNormalized(postings[0], url.toString(), 'manual');
      if ('job' in r) job = r.job;
      else note = r.error;
    }
    if (!job) {
      const og = openGraphFallback(html, url.toString());
      const r = finalizeJob({
        source_key: 'manual',
        external_id: url.toString(),
        title: manual?.title || og.title,
        company: manual?.company || og.site,
        location: manual?.location ?? '',
        description_text: manual?.description || og.description || 'Imported manually — open the original page for details.',
        apply_url: url.toString(),
        posted_at: new Date().toISOString(),
      });
      if ('job' in r) {
        job = r.job;
        note = 'No structured job data found; imported from page metadata. Review the details.';
      } else note = r.error;
    }
  } catch (e) {
    if (!manual?.title || !manual.company) throw new HttpError(422, 'import_failed', `Could not read the page (${(e as Error).message}). Enter the title and company manually.`);
    const r = finalizeJob({ source_key: 'manual', external_id: url.toString(), title: manual.title, company: manual.company, location: manual.location ?? '', description_text: manual.description ?? '', apply_url: url.toString(), posted_at: new Date().toISOString() });
    if ('job' in r) job = r.job;
  }
  if (!job) throw new HttpError(422, 'import_failed', note || 'Could not import this job');
  const result = await ingestJobs(db, userId, { source_key: 'manual', jobs: [job] }, { skipRelevance: true });
  let jobId = result.inserted_ids[0];
  if (!jobId) {
    const existing = await db.from('job_listings').select('id').eq('user_id', userId).eq('fingerprint', job.fingerprint!).limit(1);
    jobId = existing.data?.[0]?.id as string | undefined;
  }
  return { job_id: jobId ?? null, duplicate: !result.inserted_ids.length, note, stats: result.stats };
}
