import { WORKFLOWS } from '@applypilot/core';
import { Hono } from 'hono';
import { z } from 'zod';
import { GeminiClient } from '../ai/gemini.js';
import { integrationStatus, type AppContext } from '../env.js';
import { requireUser } from '../lib/auth.js';
import { HttpError } from '../lib/errors.js';
import { takeToken } from '../lib/ratelimit.js';
import { unwrap } from '../lib/supabase.js';
import {
  approveDocuments,
  approveSubmission,
  confirmSchema,
  confirmSubmitted,
  ensureApplication,
  prepareApplication,
  requestPrefill,
} from '../services/applications.js';
import { audit, getJob, getProfile, getRules } from '../services/context.js';
import { bootstrapDefaults, importJobFromUrl } from '../services/discovery.js';
import { classifyMessage, disconnectGmail, gmailAuthUrl, sendApprovedEmail, syncGmail } from '../services/gmail.js';
import { scoreJob } from '../services/matching.js';
import { analyzeResume, enhanceResume, extractResume, tailorResume, verifyVersion } from '../services/resumes.js';
import { cancelRun, enqueueRun, retryRun } from '../services/runs.js';
import { aiCtx, body, db, idParam } from './helpers.js';

export const userRoutes = new Hono<AppContext>();

userRoutes.use('*', requireUser);
userRoutes.use('*', async (c, next) => {
  const limit = takeToken(`user:${c.get('userId')}`, 60, 1);
  if (!limit.ok) throw new HttpError(429, 'rate_limited', `Too many requests — retry in ${limit.retryAfter}s`);
  await next();
});

userRoutes.get('/me', async (c) => {
  const [profile, rules] = await Promise.all([getProfile(db(c), c.get('userId')), getRules(db(c), c.get('userId'))]);
  return c.json({ user: { id: c.get('userId'), email: c.get('userEmail') }, profile, rules, integrations: integrationStatus(c.env) });
});

userRoutes.post('/bootstrap', async (c) => c.json(await bootstrapDefaults(db(c), c.get('userId'))));

userRoutes.get('/integrations/status', async (c) => {
  const status = integrationStatus(c.env);
  let models: Record<string, { ok: boolean; detail: string }> | null = null;
  if (c.req.query('check') === '1' && c.env.GEMINI_API_KEY) {
    const client = new GeminiClient(c.env.GEMINI_API_KEY, c.env.GEMINI_API_STYLE);
    const [fast, quality] = await Promise.all([client.checkModel(c.env.GEMINI_MODEL_FAST), client.checkModel(c.env.GEMINI_MODEL_QUALITY)]);
    models = { [c.env.GEMINI_MODEL_FAST]: fast, [c.env.GEMINI_MODEL_QUALITY]: quality };
  }
  const { data: gmail } = await db(c).from('gmail_connections').select('email, status, last_sync_at, last_error, scopes').eq('user_id', c.get('userId')).maybeSingle();
  const { data: rules } = await db(c).from('automation_rules').select('n8n_last_seen_at').eq('user_id', c.get('userId')).maybeSingle();
  return c.json({ ...status, model_checks: models, gmail, n8n_last_seen_at: rules?.n8n_last_seen_at ?? null });
});

// ─── Resumes ────────────────────────────────────────────────────────────────
userRoutes.post('/resumes/:id/extract', async (c) => c.json(await extractResume(aiCtx(c), idParam(c))));
userRoutes.post('/resumes/:id/analyze', async (c) => {
  const { version_id } = await body(c, z.object({ version_id: z.uuid().optional() }));
  return c.json(await analyzeResume(aiCtx(c), idParam(c), version_id));
});
userRoutes.post('/resume-versions/:id/enhance', async (c) => {
  const { instructions } = await body(c, z.object({ instructions: z.string().max(500).optional() }));
  return c.json(await enhanceResume(aiCtx(c), idParam(c), instructions));
});
userRoutes.post('/resume-versions/:id/tailor', async (c) => {
  const { job_id } = await body(c, z.object({ job_id: z.uuid() }));
  return c.json(await tailorResume(aiCtx(c), idParam(c), job_id));
});
userRoutes.post('/resume-versions/:id/verify', async (c) => c.json(await verifyVersion(db(c), c.get('userId'), idParam(c))));

// ─── Jobs ───────────────────────────────────────────────────────────────────
userRoutes.post('/jobs/:id/match', async (c) => c.json(await scoreJob(aiCtx(c), idParam(c))));
userRoutes.post('/jobs/import-url', async (c) => {
  const input = await body(
    c,
    z.object({
      url: z.url(),
      title: z.string().max(300).optional(),
      company: z.string().max(200).optional(),
      location: z.string().max(300).optional(),
      description: z.string().max(30000).optional(),
    }),
  );
  return c.json(await importJobFromUrl(db(c), c.get('userId'), input.url, input));
});
userRoutes.post('/jobs/:id/track', async (c) => {
  const job = await getJob(db(c), c.get('userId'), idParam(c));
  const app = await ensureApplication(db(c), c.get('userId'), job);
  return c.json({ application_id: app.id });
});

/** Creates a job pointing at the local demo application form (safe end-to-end testing). */
userRoutes.post('/demo/job', async (c) => {
  const { base_url } = await body(c, z.object({ base_url: z.url().default('http://localhost:4321') }));
  const host = new URL(base_url).hostname;
  if (!['localhost', '127.0.0.1'].includes(host)) throw new HttpError(400, 'bad_request', 'The demo form must run on localhost');
  const n = Date.now().toString(36);
  const row = {
    user_id: c.get('userId'),
    source_key: 'demo',
    external_id: `demo-${n}`,
    fingerprint: `demo-${n}`,
    title: 'Frontend Developer Intern (Demo)',
    company: 'ApplyPilot Demo Co.',
    location: 'Makati City, Metro Manila',
    work_arrangement: 'onsite',
    employment_type: 'internship',
    experience_level: 'internship',
    ph_eligibility: 'eligible',
    description:
      'DEMO LISTING for testing ApplyPilot automation safely.\nResponsibilities:\n- Build React components\n- Write TypeScript\nRequirements:\n- React\n- TypeScript\n- Git\nOJT: interns render up to 600 hours.',
    requirements: ['React', 'TypeScript', 'Git'],
    tags: ['demo'],
    apply_url: `${base_url.replace(/\/$/, '')}/jobs/frontend-intern?ref=${n}`,
    posted_at: new Date().toISOString(),
  };
  const job = unwrap(await db(c).from('job_listings').insert(row).select('id').single(), 'create demo job');
  return c.json({ job_id: job.id });
});

// ─── Applications ───────────────────────────────────────────────────────────
userRoutes.post('/applications/prepare', async (c) => {
  const { job_id } = await body(c, z.object({ job_id: z.uuid() }));
  return c.json(await prepareApplication(aiCtx(c), job_id));
});
userRoutes.post('/applications/:id/approve-documents', async (c) => c.json(await approveDocuments(db(c), c.get('userId'), idParam(c))));
userRoutes.post('/applications/:id/approve-submission', async (c) => c.json(await approveSubmission(db(c), c.env, c.get('userId'), idParam(c))));
userRoutes.post('/applications/:id/prefill', async (c) => c.json(await requestPrefill(db(c), c.env, c.get('userId'), idParam(c))));
userRoutes.post('/applications/:id/confirm-submitted', async (c) => c.json(await confirmSubmitted(db(c), c.get('userId'), idParam(c), await body(c, confirmSchema))));
userRoutes.get('/applications/:id/evidence', async (c) => {
  const id = idParam(c);
  const app = unwrap(await db(c).from('applications').select('submission_evidence').eq('id', id).eq('user_id', c.get('userId')).maybeSingle(), 'load evidence');
  const { data: events } = await db(c).from('application_events').select('metadata').eq('application_id', id).eq('actor', 'runner');
  const paths = new Set<string>([
    ...(((app?.submission_evidence as { screenshots?: string[] } | null)?.screenshots ?? []) as string[]),
    ...(events ?? []).flatMap((e: { metadata: { evidence?: { screenshots?: string[] } } }) => e.metadata?.evidence?.screenshots ?? []),
  ]);
  const urls = await Promise.all(
    [...paths].map(async (p) => {
      const { data } = await db(c).storage.from('evidence').createSignedUrl(p, 600);
      return { path: p, url: data?.signedUrl ?? null };
    }),
  );
  return c.json({ evidence: app?.submission_evidence ?? null, screenshots: urls });
});

// ─── Automation ─────────────────────────────────────────────────────────────
userRoutes.post('/automation/trigger', async (c) => {
  const input = await body(c, z.object({ workflow: z.enum(WORKFLOWS), input: z.record(z.string(), z.unknown()).default({}) }));
  if (input.workflow === 'application_submit') throw new HttpError(400, 'bad_request', 'Use the application approval endpoints to submit.');
  const { run, created } = await enqueueRun(db(c), c.env, c.get('userId'), { workflow: input.workflow, input: { ...input.input, force: true }, trigger: 'dashboard' });
  return c.json({ run, created });
});
userRoutes.post('/automation/runs/:id/cancel', async (c) => c.json(await cancelRun(db(c), c.get('userId'), idParam(c))));
userRoutes.post('/automation/runs/:id/retry', async (c) => c.json(await retryRun(db(c), c.env, c.get('userId'), idParam(c))));
userRoutes.post('/automation/pause', async (c) => {
  const { paused, reason } = await body(c, z.object({ paused: z.boolean(), reason: z.string().max(300).optional() }));
  const uid = c.get('userId');
  unwrap(await db(c).from('automation_rules').update({ paused, paused_reason: paused ? (reason ?? 'Emergency pause') : null }).eq('user_id', uid).select('id'), 'pause');
  if (paused) {
    // Stop anything not yet started; running runs see the pause on their next heartbeat.
    await db(c).from('automation_runs').update({ status: 'cancelled', error: 'Automation paused', finished_at: new Date().toISOString() }).eq('user_id', uid).eq('status', 'queued');
    await db(c).from('automation_runs').update({ cancel_requested: true }).eq('user_id', uid).eq('status', 'running');
  }
  await audit(db(c), uid, 'user', paused ? 'automation_paused' : 'automation_resumed', 'automation_rules', null, { reason });
  return c.json({ paused });
});

// ─── Gmail ──────────────────────────────────────────────────────────────────
userRoutes.get('/integrations/gmail/auth-url', async (c) => c.json({ url: await gmailAuthUrl(c.env, c.get('userId')) }));
userRoutes.post('/integrations/gmail/disconnect', async (c) => c.json(await disconnectGmail(c.env, db(c), c.get('userId'))));
userRoutes.post('/integrations/gmail/sync', async (c) => c.json(await syncGmail(c.env, db(c), c.get('userId'), { max: 10 })));
userRoutes.post('/messages/:id/classify', async (c) => c.json(await classifyMessage(aiCtx(c), idParam(c))));
userRoutes.post('/messages/:id/send-reply', async (c) => {
  const id = idParam(c);
  const input = await body(c, z.object({ body: z.string().min(1).max(10000), subject: z.string().max(300).optional(), confirm: z.literal(true) }));
  const msg = unwrap(await db(c).from('recruitment_messages').select('gmail_message_id, thread_id, from_email, subject').eq('id', id).eq('user_id', c.get('userId')).maybeSingle(), 'load message');
  if (!msg) throw new HttpError(404, 'not_found', 'Message not found');
  const subject = input.subject ?? (/^re:/i.test(msg.subject) ? msg.subject : `Re: ${msg.subject}`);
  const sent = await sendApprovedEmail(c.env, db(c), c.get('userId'), { to: msg.from_email, subject, body: input.body, threadId: msg.thread_id, inReplyToMessageId: msg.gmail_message_id });
  return c.json({ sent: true, id: sent.id });
});
userRoutes.post('/documents/:id/send', async (c) => {
  const id = idParam(c);
  const input = await body(c, z.object({ to: z.email(), subject: z.string().min(1).max(300).optional(), body: z.string().min(1).max(10000).optional(), confirm: z.literal(true) }));
  const uid = c.get('userId');
  const doc = unwrap(await db(c).from('application_documents').select('id, kind, title, content_text, application_id, status').eq('id', id).eq('user_id', uid).maybeSingle(), 'load document');
  if (!doc) throw new HttpError(404, 'not_found', 'Document not found');
  if (!['email', 'follow_up', 'reply'].includes(doc.kind)) throw new HttpError(400, 'bad_request', 'Only email documents can be sent');
  if (doc.status === 'sent') throw new HttpError(409, 'already_sent', 'This email was already sent');
  const sent = await sendApprovedEmail(c.env, db(c), uid, { to: input.to, subject: input.subject ?? doc.title, body: input.body ?? doc.content_text });
  const now = new Date().toISOString();
  await db(c).from('application_documents').update({ status: 'sent', sent_at: now, approved_at: now }).eq('id', id);
  if (doc.kind === 'follow_up' && doc.application_id) {
    const { data: app } = await db(c).from('applications').select('follow_ups_sent').eq('id', doc.application_id).single();
    await db(c).from('applications').update({ last_follow_up_at: now, follow_ups_sent: ((app?.follow_ups_sent as number) ?? 0) + 1 }).eq('id', doc.application_id);
    await db(c).from('application_events').insert({ user_id: uid, application_id: doc.application_id, type: 'follow_up', actor: 'user', message: `Follow-up sent to ${input.to}` });
  }
  return c.json({ sent: true, id: sent.id });
});
