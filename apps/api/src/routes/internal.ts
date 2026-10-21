import { WORKFLOWS } from '@applypilot/core';
import { Hono } from 'hono';
import { z } from 'zod';
import type { AppContext } from '../env.js';
import { requireInternal } from '../lib/auth.js';
import { dispatchSchema, dispatchSubmission, prepareApplication, releaseStuckSubmissions } from '../services/applications.js';
import { assertNotPaused } from '../services/context.js';
import { discoveryPlan, expireJobs, ingestJobs, ingestSchema } from '../services/discovery.js';
import { scanFollowUps } from '../services/followups.js';
import { classifyMessage, sendApprovedEmail, syncGmail, unclassifiedMessages } from '../services/gmail.js';
import { pendingMatches, scoreJob } from '../services/matching.js';
import { notify } from '../services/notifications.js';
import { dailyReport, interviewReminders, pendingApprovalsReport, weeklyReport } from '../services/reports.js';
import { pendingResumes, processResume } from '../services/resumes.js';
import { claimRuns, enqueueRun, enqueueSchema, failByExecution, finishRun, finishSchema, heartbeat, scheduleRetries, startRun, startSchema } from '../services/runs.js';
import { aiCtx, body, db, idParam } from './helpers.js';

/** Endpoints called by n8n with the INTERNAL_API_TOKEN. */
export const internalRoutes = new Hono<AppContext>();
internalRoutes.use('*', requireInternal);

const runIdHeader = (c: { req: { header: (n: string) => string | undefined } }) => c.req.header('X-ApplyPilot-Run-Id') ?? null;

// ─── Run lifecycle ──────────────────────────────────────────────────────────
internalRoutes.post('/runs/claim', async (c) => {
  const { limit, workflows } = await body(c, z.object({ limit: z.number().int().min(1).max(25).default(5), workflows: z.array(z.enum(WORKFLOWS)).optional() }));
  return c.json({ runs: await claimRuns(db(c), c.get('userId'), limit, workflows) });
});
internalRoutes.post('/runs/start', async (c) => c.json(await startRun(db(c), c.get('userId'), await body(c, startSchema))));
internalRoutes.post('/runs/enqueue', async (c) => c.json(await enqueueRun(db(c), c.env, c.get('userId'), await body(c, enqueueSchema))));
/** Queue several follow-up runs at once; an empty list is a valid no-op (keeps n8n flows linear). */
internalRoutes.post('/runs/enqueue-batch', async (c) => {
  const { runs } = await body(c, z.object({ runs: z.array(enqueueSchema).max(25).default([]) }));
  const results = [];
  for (const r of runs) {
    const { run, created } = await enqueueRun(db(c), c.env, c.get('userId'), r);
    results.push({ id: run.id, workflow: run.workflow, created });
  }
  return c.json({ queued: results.filter((r) => r.created).length, results });
});
/** The dispatcher could not deliver a claimed run to its webhook: put it back in the queue. */
internalRoutes.post('/runs/:id/release', async (c) => {
  const { error } = await body(c, z.object({ error: z.string().max(500).optional() }));
  const { data } = await db(c)
    .from('automation_runs')
    .update({ status: 'queued', started_at: null, heartbeat_at: null, not_before: new Date(Date.now() + 60_000).toISOString(), error: error ? `Delivery failed: ${error}` : null })
    .eq('id', idParam(c))
    .eq('user_id', c.get('userId'))
    .eq('status', 'running')
    .is('n8n_execution_id', null)
    .select('id');
  return c.json({ released: Boolean(data?.length) });
});
internalRoutes.post('/runs/fail-execution', async (c) =>
  c.json(
    await failByExecution(
      db(c),
      c.get('userId'),
      await body(c, z.object({ run_id: z.uuid().nullish(), execution_id: z.string().max(100).nullish(), workflow_name: z.string().max(200).optional(), error: z.string().max(4000).optional(), node: z.string().max(200).optional() })),
    ),
  ),
);
internalRoutes.post('/runs/:id/heartbeat', async (c) => {
  const { stats } = await body(c, z.object({ stats: z.record(z.string(), z.unknown()).optional() }));
  return c.json(await heartbeat(db(c), c.get('userId'), idParam(c), stats));
});
internalRoutes.post('/runs/:id/finish', async (c) => c.json(await finishRun(db(c), c.get('userId'), idParam(c), await body(c, finishSchema))));
internalRoutes.post('/recovery/scan', async (c) => c.json(await scheduleRetries(db(c), c.env, c.get('userId'))));

// ─── Workflow 1: discovery ──────────────────────────────────────────────────
internalRoutes.get('/discovery/plan', async (c) => {
  await assertNotPaused(db(c), c.get('userId'));
  return c.json(await discoveryPlan(db(c), c.get('userId'), c.req.query('force') === '1'));
});
internalRoutes.post('/jobs/ingest', async (c) => c.json(await ingestJobs(db(c), c.get('userId'), await body(c, ingestSchema))));
internalRoutes.post('/jobs/expire', async (c) => c.json(await expireJobs(db(c), c.get('userId'))));

// ─── Workflow 2: resume analysis ────────────────────────────────────────────
internalRoutes.get('/resumes/pending', async (c) => c.json({ resumes: await pendingResumes(db(c), c.get('userId')) }));
internalRoutes.post('/resumes/:id/process', async (c) => c.json(await processResume(aiCtx(c, runIdHeader(c)), idParam(c))));

// ─── Workflow 3: matching ───────────────────────────────────────────────────
internalRoutes.post('/matching/pending', async (c) => {
  const { limit, job_ids } = await body(c, z.object({ limit: z.number().int().min(1).max(50).default(25), job_ids: z.array(z.uuid()).max(200).optional() }));
  return c.json({ jobs: await pendingMatches(db(c), c.get('userId'), { limit, jobIds: job_ids }) });
});
internalRoutes.post('/matching/:id', async (c) => {
  const { use_ai } = await body(c, z.object({ use_ai: z.boolean().default(true) }));
  await assertNotPaused(db(c), c.get('userId'));
  return c.json(await scoreJob(aiCtx(c, runIdHeader(c)), idParam(c), { useAi: use_ai }));
});

// ─── Workflow 4: preparation ────────────────────────────────────────────────
internalRoutes.post('/applications/prepare', async (c) => {
  const { job_id } = await body(c, z.object({ job_id: z.uuid() }));
  await assertNotPaused(db(c), c.get('userId'));
  return c.json(await prepareApplication(aiCtx(c, runIdHeader(c)), job_id));
});

// ─── Workflow 5: submission ─────────────────────────────────────────────────
internalRoutes.post('/applications/:id/dispatch', async (c) => {
  await assertNotPaused(db(c), c.get('userId'));
  return c.json(await dispatchSubmission(db(c), c.env, c.get('userId'), idParam(c), await body(c, dispatchSchema)));
});
internalRoutes.post('/applications/release-stuck', async (c) => c.json(await releaseStuckSubmissions(db(c), c.get('userId'))));

// ─── Workflow 6: Gmail ──────────────────────────────────────────────────────
internalRoutes.post('/gmail/sync', async (c) => {
  const { max, page_token } = await body(c, z.object({ max: z.number().int().min(1).max(15).default(10), page_token: z.string().max(200).nullish() }));
  return c.json(await syncGmail(c.env, db(c), c.get('userId'), { max, pageToken: page_token }));
});
internalRoutes.get('/gmail/unclassified', async (c) => c.json({ message_ids: await unclassifiedMessages(db(c), c.get('userId'), Number(c.req.query('limit') ?? 10)) }));
internalRoutes.post('/gmail/messages/:id/classify', async (c) => c.json(await classifyMessage(aiCtx(c, runIdHeader(c)), idParam(c))));

// ─── Workflow 7: follow-ups ─────────────────────────────────────────────────
internalRoutes.post('/followups/scan', async (c) => {
  await assertNotPaused(db(c), c.get('userId'));
  return c.json(await scanFollowUps(aiCtx(c, runIdHeader(c))));
});

// ─── Workflow 8: notifications & reports ────────────────────────────────────
internalRoutes.post('/reports/:kind', async (c) => {
  const kind = c.req.param('kind');
  const uid = c.get('userId');
  const handlers: Record<string, () => Promise<{ text: string }>> = {
    daily: () => dailyReport(db(c), uid),
    weekly: () => weeklyReport(db(c), uid),
    interviews: () => interviewReminders(db(c), uid),
    approvals: () => pendingApprovalsReport(db(c), uid),
  };
  const h = handlers[kind];
  if (!h) return c.json({ error: { code: 'not_found', message: 'Unknown report' } }, 404);
  const { data: rules } = await db(c).from('automation_rules').select('telegram_notifications, email_notifications').eq('user_id', uid).maybeSingle();
  const result = await h();
  // Opted-in email reports go only to the user's own connected Gmail address.
  let emailed = false;
  if (rules?.email_notifications && result.text && (kind === 'daily' || kind === 'weekly')) {
    const { data: conn } = await db(c).from('gmail_connections').select('email, status').eq('user_id', uid).maybeSingle();
    if (conn?.status === 'connected' && conn.email) {
      try {
        await sendApprovedEmail(c.env, db(c), uid, { to: conn.email, subject: result.text.split('\n')[0]!.slice(0, 200), body: result.text });
        emailed = true;
      } catch (e) {
        console.warn('[reports] email failed', (e as Error).message);
      }
    }
  }
  return c.json({ ...result, emailed, telegram: Boolean(rules?.telegram_notifications) && Boolean(result.text) });
});
internalRoutes.post('/notifications', async (c) => {
  const n = await body(
    c,
    z.object({
      type: z.enum(['automation_error', 'report', 'system']).default('system'),
      title: z.string().min(1).max(200),
      body: z.string().max(2000).optional(),
      severity: z.enum(['info', 'success', 'warning', 'error']).default('info'),
      link: z.string().regex(/^\//).optional(),
      dedupe_key: z.string().max(200).optional(),
    }),
  );
  return c.json({ created: await notify(db(c), c.get('userId'), n) });
});
