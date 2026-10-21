import { WORKFLOW_LABELS, WORKFLOW_WEBHOOK_PATHS, WORKFLOWS, type RunStatus, type RunTrigger, type WorkflowKey } from '@applypilot/core';
import { z } from 'zod';
import type { Env } from '../env.js';
import { HttpError, notFound } from '../lib/errors.js';
import { unwrap, type Db } from '../lib/supabase.js';
import { getRules } from './context.js';
import { notify } from './notifications.js';

export interface RunRow {
  id: string;
  user_id: string;
  workflow: WorkflowKey;
  status: RunStatus;
  trigger: RunTrigger;
  input: Record<string, unknown>;
  output: Record<string, unknown> | null;
  stats: Record<string, unknown>;
  item_errors: unknown[];
  error: string | null;
  attempt: number;
  max_attempts: number;
  idempotency_key: string | null;
  parent_run_id: string | null;
  n8n_execution_id: string | null;
  cancel_requested: boolean;
  timeout_seconds: number;
  queued_at: string;
  started_at: string | null;
  finished_at: string | null;
}

/** Per-workflow timeouts (the stale-run reaper uses them). */
const TIMEOUTS: Record<WorkflowKey, number> = {
  job_discovery: 1800,
  resume_analysis: 600,
  job_matching: 3600,
  application_prep: 900,
  application_submit: 1800,
  gmail_sync: 900,
  follow_up: 600,
  reports: 300,
  error_recovery: 300,
};

export const enqueueSchema = z.object({
  workflow: z.enum(WORKFLOWS),
  input: z.record(z.string(), z.unknown()).default({}),
  trigger: z.enum(['schedule', 'dashboard', 'webhook', 'event', 'retry', 'cron']).default('dashboard'),
  idempotency_key: z.string().min(1).max(200).optional(),
  not_before: z.iso.datetime({ offset: true }).optional(),
  parent_run_id: z.uuid().optional(),
  max_attempts: z.number().int().min(1).max(5).optional(),
});
export type EnqueueInput = z.input<typeof enqueueSchema>;

/** Queues a run. Re-using an idempotency key returns the existing run instead of a duplicate. */
export async function enqueueRun(db: Db, env: Env, userId: string, raw: EnqueueInput): Promise<{ run: RunRow; created: boolean }> {
  const input = enqueueSchema.parse(raw);
  const row = {
    user_id: userId,
    workflow: input.workflow,
    status: 'queued',
    trigger: input.trigger,
    input: input.input,
    idempotency_key: input.idempotency_key ?? null,
    not_before: input.not_before ?? null,
    parent_run_id: input.parent_run_id ?? null,
    max_attempts: input.max_attempts ?? 3,
    timeout_seconds: TIMEOUTS[input.workflow],
  };
  const { data, error } = await db.from('automation_runs').insert(row).select('*').single();
  if (error?.code === '23505' && input.idempotency_key) {
    const existing = unwrap(
      await db.from('automation_runs').select('*').eq('user_id', userId).eq('idempotency_key', input.idempotency_key).single(),
      'load idempotent run',
    );
    return { run: existing as RunRow, created: false };
  }
  if (error) throw new HttpError(500, 'database_error', `enqueue run: ${error.message}`);
  const run = data as RunRow;
  if (!input.not_before) await pushToN8n(db, env, run);
  return { run, created: true };
}

/**
 * Optional push mode: when n8n is reachable over HTTPS (e.g. Cloudflare Tunnel), claim the run
 * and call its webhook directly. On any failure the run is released back to the queue, where the
 * n8n Command Dispatcher will pick it up by polling.
 */
async function pushToN8n(db: Db, env: Env, run: RunRow) {
  if (!env.N8N_WEBHOOK_BASE_URL || !env.N8N_WEBHOOK_TOKEN) return;
  const { data: claimed } = await db
    .from('automation_runs')
    .update({ status: 'running', started_at: new Date().toISOString(), heartbeat_at: new Date().toISOString() })
    .eq('id', run.id)
    .eq('status', 'queued')
    .select('id');
  if (!claimed?.length) return;
  try {
    const res = await fetch(`${env.N8N_WEBHOOK_BASE_URL.replace(/\/$/, '')}/webhook/${WORKFLOW_WEBHOOK_PATHS[run.workflow]}`, {
      method: 'POST',
      headers: { 'content-type': 'application/json', 'X-ApplyPilot-Webhook-Token': env.N8N_WEBHOOK_TOKEN },
      body: JSON.stringify({ run_id: run.id, workflow: run.workflow, input: run.input, trigger: run.trigger }),
      signal: AbortSignal.timeout(8000),
    });
    if (!res.ok) throw new Error(`HTTP ${res.status}`);
    run.status = 'running';
  } catch (e) {
    console.warn('[runs] n8n push failed, falling back to polling:', (e as Error).message);
    await db.from('automation_runs').update({ status: 'queued', started_at: null, heartbeat_at: null }).eq('id', run.id).eq('status', 'running');
  }
}

export async function claimRuns(db: Db, userId: string, limit: number, workflows?: WorkflowKey[]): Promise<RunRow[]> {
  const rows = unwrap(await db.rpc('claim_automation_runs', { p_user: userId, p_limit: limit, p_workflows: workflows ?? null }), 'claim runs');
  return (rows ?? []) as RunRow[];
}

export const startSchema = z.object({
  workflow: z.enum(WORKFLOWS),
  run_id: z.uuid().nullish(),
  trigger: z.enum(['schedule', 'dashboard', 'webhook', 'event', 'retry', 'cron']).default('schedule'),
  n8n_execution_id: z.string().max(100).nullish(),
  input: z.record(z.string(), z.unknown()).default({}),
});

/**
 * Called by every n8n workflow as its first step. Returns the run (created for scheduled
 * executions) and whether the workflow should continue (pause / cancellation).
 */
export async function startRun(db: Db, userId: string, raw: z.input<typeof startSchema>) {
  const input = startSchema.parse(raw);
  const rules = await getRules(db, userId);
  const now = new Date().toISOString();
  let run: RunRow;
  if (input.run_id) {
    const existing = unwrap(await db.from('automation_runs').select('*').eq('id', input.run_id).eq('user_id', userId).maybeSingle(), 'load run');
    if (!existing) throw notFound('Run');
    if (!['queued', 'running'].includes(existing.status)) {
      return { proceed: false, reason: `Run is already ${existing.status}`, run: existing as RunRow, paused: rules.paused };
    }
    run = unwrap(
      await db
        .from('automation_runs')
        .update({ status: 'running', started_at: existing.started_at ?? now, heartbeat_at: now, n8n_execution_id: input.n8n_execution_id ?? existing.n8n_execution_id })
        .eq('id', input.run_id)
        .select('*')
        .single(),
      'start run',
    ) as RunRow;
  } else {
    run = unwrap(
      await db
        .from('automation_runs')
        .insert({
          user_id: userId,
          workflow: input.workflow,
          status: 'running',
          trigger: input.trigger,
          input: input.input,
          started_at: now,
          heartbeat_at: now,
          n8n_execution_id: input.n8n_execution_id ?? null,
          timeout_seconds: TIMEOUTS[input.workflow],
        })
        .select('*')
        .single(),
      'create run',
    ) as RunRow;
  }
  // Error recovery and reports still run while paused (they never act on applications).
  const pausable = !['error_recovery', 'reports'].includes(input.workflow);
  if ((rules.paused && pausable) || run.cancel_requested) {
    const reason = run.cancel_requested ? 'Cancelled by user' : 'Automation is paused';
    await db.from('automation_runs').update({ status: 'cancelled', error: reason, finished_at: now }).eq('id', run.id);
    return { proceed: false, reason, run, paused: rules.paused };
  }
  return { proceed: true, reason: null, run, paused: rules.paused, rules: { mode: rules.mode, notify_min_score: rules.notify_min_score } };
}

export async function heartbeat(db: Db, userId: string, runId: string, stats?: Record<string, unknown>) {
  const update: Record<string, unknown> = { heartbeat_at: new Date().toISOString() };
  if (stats) update.stats = stats;
  const row = unwrap(await db.from('automation_runs').update(update).eq('id', runId).eq('user_id', userId).eq('status', 'running').select('cancel_requested').maybeSingle(), 'heartbeat');
  const rules = await getRules(db, userId);
  return { cancel_requested: Boolean(row?.cancel_requested), paused: rules.paused, running: Boolean(row) };
}

export const finishSchema = z.object({
  status: z.enum(['succeeded', 'partial', 'failed', 'cancelled']),
  stats: z.record(z.string(), z.unknown()).default({}),
  output: z.record(z.string(), z.unknown()).nullish(),
  item_errors: z.array(z.unknown()).max(200).default([]),
  error: z.string().max(4000).nullish(),
});

export async function finishRun(db: Db, userId: string, runId: string, raw: z.input<typeof finishSchema>) {
  const input = finishSchema.parse(raw);
  const run = unwrap(
    await db
      .from('automation_runs')
      .update({
        status: input.status,
        stats: input.stats,
        output: input.output ?? null,
        item_errors: input.item_errors.slice(0, 200),
        error: input.error ?? null,
        finished_at: new Date().toISOString(),
      })
      .eq('id', runId)
      .eq('user_id', userId)
      .in('status', ['running', 'queued'])
      .select('*')
      .maybeSingle(),
    'finish run',
  ) as RunRow | null;
  if (!run) return { finished: false };
  if (input.status === 'failed' && run.attempt >= run.max_attempts) {
    await notify(db, userId, {
      type: 'automation_error',
      severity: 'error',
      title: `${WORKFLOW_LABELS[run.workflow]} failed`,
      body: input.error ?? 'The workflow failed after all retry attempts.',
      link: '/automation',
      dedupe_key: `run_failed:${run.id}`,
      metadata: { run_id: run.id },
    });
  }
  return { finished: true, run };
}

const NON_RETRYABLE = /(paused|not configured|no_verified_resume|validation|not found|forbidden|unauthorized|budget)/i;

/** Error Recovery (Workflow 9): re-queue failed runs with exponential backoff. */
export async function scheduleRetries(db: Db, env: Env, userId: string) {
  const since = new Date(Date.now() - 24 * 3600_000).toISOString();
  const failed = unwrap(
    await db.from('automation_runs').select('*').eq('user_id', userId).eq('status', 'failed').gte('finished_at', since).order('finished_at').limit(20),
    'load failed runs',
  ) as RunRow[];
  const retried: string[] = [];
  const skipped: Array<{ id: string; reason: string }> = [];
  for (const run of failed) {
    if (run.attempt >= run.max_attempts) {
      skipped.push({ id: run.id, reason: 'max attempts reached' });
      continue;
    }
    if (run.error && NON_RETRYABLE.test(run.error)) {
      skipped.push({ id: run.id, reason: 'non-retryable error' });
      continue;
    }
    const backoffMinutes = 2 ** run.attempt * 5; // 10, 20, 40 …
    const { created, run: child } = await enqueueRun(db, env, userId, {
      workflow: run.workflow,
      input: run.input,
      trigger: 'retry',
      idempotency_key: `retry:${run.id}`,
      parent_run_id: run.id,
      not_before: new Date(Date.now() + backoffMinutes * 60_000).toISOString(),
      max_attempts: run.max_attempts,
    });
    if (created) {
      await db.from('automation_runs').update({ attempt: run.attempt + 1 }).eq('id', child.id);
      retried.push(child.id);
    }
  }
  return { retried, skipped };
}

export async function cancelRun(db: Db, userId: string, runId: string) {
  const run = unwrap(await db.from('automation_runs').select('id, status').eq('id', runId).eq('user_id', userId).maybeSingle(), 'load run');
  if (!run) throw notFound('Run');
  if (run.status === 'queued') {
    await db.from('automation_runs').update({ status: 'cancelled', cancel_requested: true, finished_at: new Date().toISOString(), error: 'Cancelled by user' }).eq('id', runId);
    return { status: 'cancelled' };
  }
  if (run.status === 'running') {
    await db.from('automation_runs').update({ cancel_requested: true }).eq('id', runId);
    return { status: 'cancel_requested' };
  }
  return { status: run.status as string };
}

export async function retryRun(db: Db, env: Env, userId: string, runId: string) {
  const run = unwrap(await db.from('automation_runs').select('*').eq('id', runId).eq('user_id', userId).maybeSingle(), 'load run') as RunRow | null;
  if (!run) throw notFound('Run');
  if (['queued', 'running'].includes(run.status)) throw new HttpError(409, 'run_active', 'Run is still active');
  return enqueueRun(db, env, userId, { workflow: run.workflow, input: run.input, trigger: 'retry', parent_run_id: run.id });
}

/** Records an n8n execution failure reported by the Error Trigger workflow. */
export async function failByExecution(db: Db, userId: string, body: { run_id?: string | null; execution_id?: string | null; workflow_name?: string; error?: string; node?: string }) {
  let query = db.from('automation_runs').update({ status: 'failed', error: `${body.node ? `[${body.node}] ` : ''}${body.error ?? 'n8n execution failed'}`.slice(0, 4000), finished_at: new Date().toISOString() }).eq('user_id', userId).eq('status', 'running');
  if (body.run_id) query = query.eq('id', body.run_id);
  else if (body.execution_id) query = query.eq('n8n_execution_id', body.execution_id);
  else return { updated: 0 };
  const { data } = await query.select('id, workflow, attempt, max_attempts');
  for (const r of data ?? []) {
    if ((r.attempt as number) >= (r.max_attempts as number)) {
      await notify(db, userId, {
        type: 'automation_error',
        severity: 'error',
        title: `n8n workflow failed: ${body.workflow_name ?? r.workflow}`,
        body: body.error ?? '',
        link: '/automation',
        dedupe_key: `run_failed:${r.id}`,
      });
    }
  }
  return { updated: data?.length ?? 0 };
}
