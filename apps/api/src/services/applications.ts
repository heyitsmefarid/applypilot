import { decideSubmission, PROMPTS, toHourlyUsd, type ApplicationStatus } from '@applypilot/core';
import { z } from 'zod';
import { AiBudgetError, runAi, type AiContext } from '../ai/run.js';
import type { Env } from '../env.js';
import { conflict, HttpError, notFound } from '../lib/errors.js';
import { unwrap, type Db } from '../lib/supabase.js';
import { audit, getActivePreferences, getJob, getProfile, getRules, getVerifiedResume, jobForPrompt, type JobRow } from './context.js';
import { notify } from './notifications.js';
import { tailorResume } from './resumes.js';
import { enqueueRun, finishRun } from './runs.js';

export interface ApplicationRow {
  id: string;
  user_id: string;
  job_id: string | null;
  status: ApplicationStatus;
  mode: string;
  channel: string;
  company: string;
  job_title: string;
  apply_url: string | null;
  source_key: string | null;
  match_score: number | null;
  resume_version_id: string | null;
  cover_letter_document_id: string | null;
  documents_approved_at: string | null;
  submission_approved_at: string | null;
  auto_approved: boolean;
  submission_attempts: number;
  submitted_at: string | null;
  needs_manual_action: boolean;
}

const PRE_SUBMISSION: ApplicationStatus[] = ['discovered', 'saved', 'draft_prepared', 'awaiting_approval', 'submission_failed'];
const SUBMITTED: ApplicationStatus[] = ['applied', 'assessment', 'interview', 'offer', 'rejected'];

async function loadApplication(db: Db, userId: string, id: string): Promise<ApplicationRow> {
  const a = unwrap(await db.from('applications').select('*').eq('id', id).eq('user_id', userId).maybeSingle(), 'load application');
  if (!a) throw notFound('Application');
  return a as ApplicationRow;
}

function domainOf(url: string | null): string | null {
  if (!url) return null;
  try {
    return new URL(url).hostname.replace(/^www\./, '');
  } catch {
    return null;
  }
}

/** Returns the application for a job, creating it (status "saved") if needed. */
export async function ensureApplication(db: Db, userId: string, job: JobRow): Promise<ApplicationRow> {
  const existing = unwrap(await db.from('applications').select('*').eq('user_id', userId).eq('job_id', job.id).maybeSingle(), 'find application');
  if (existing) return existing as ApplicationRow;
  const { data: match } = await db.from('job_matches').select('score').eq('user_id', userId).eq('job_id', job.id).maybeSingle();
  const rules = await getRules(db, userId);
  const { data, error } = await db
    .from('applications')
    .insert({
      user_id: userId,
      job_id: job.id,
      status: 'saved',
      status_source: 'system',
      mode: rules.mode,
      channel: 'manual',
      company: job.company,
      job_title: job.title,
      apply_url: job.apply_url,
      company_domain: job.company_url ? domainOf(job.company_url) : null,
      source_key: job.source_key,
      match_score: (match?.score as number | undefined) ?? null,
      follow_up_interval_days: rules.follow_up_after_days,
    })
    .select('*')
    .single();
  if (error?.code === '23505') return ensureApplication(db, userId, job);
  if (error) throw new HttpError(500, 'database_error', `create application: ${error.message}`);
  return data as ApplicationRow;
}

async function nextDocVersion(db: Db, applicationId: string, kind: string): Promise<number> {
  const { data } = await db.from('application_documents').select('version').eq('application_id', applicationId).eq('kind', kind).order('version', { ascending: false }).limit(1);
  return ((data?.[0]?.version as number | undefined) ?? 0) + 1;
}

async function saveDoc(db: Db, userId: string, app: ApplicationRow, doc: { kind: string; title: string; content_text: string; content_json?: unknown; model?: string; prompt_version?: string }) {
  const version = await nextDocVersion(db, app.id, doc.kind);
  return unwrap(
    await db
      .from('application_documents')
      .insert({ user_id: userId, application_id: app.id, job_id: app.job_id, ai_generated: true, status: 'draft', version, ...doc })
      .select('id, kind, version')
      .single(),
    `save ${doc.kind}`,
  ) as { id: string; kind: string; version: number };
}

/**
 * Workflow 4: tailored resume → fabrication guard → cover letter → application email →
 * screening answers. Each step is isolated so one failure doesn't discard the others.
 */
export async function prepareApplication(ai: AiContext, jobId: string) {
  const { db, userId } = ai;
  const [job, resume, profile, prefs, rules] = await Promise.all([
    getJob(db, userId, jobId),
    getVerifiedResume(db, userId),
    getProfile(db, userId),
    getActivePreferences(db, userId),
    getRules(db, userId),
  ]);
  const app = await ensureApplication(db, userId, job);
  if (SUBMITTED.includes(app.status)) throw conflict('already_submitted', 'This application was already submitted.');

  const documents: Array<{ id: string; kind: string; version: number }> = [];
  const errors: Array<{ step: string; error: string }> = [];
  let tailoredVersionId: string | null = null;
  let coverLetterId: string | null = null;
  const promptJob = jobForPrompt(job);

  const step = async (name: string, fn: () => Promise<void>) => {
    try {
      await fn();
    } catch (e) {
      // Budget exhaustion aborts the whole preparation so n8n can retry it later.
      if (e instanceof AiBudgetError) throw e;
      errors.push({ step: name, error: (e as Error).message.slice(0, 300) });
    }
  };

  await step('tailored_resume', async () => {
    const t = await tailorResume(ai, resume.versionId, jobId);
    tailoredVersionId = t.version.id as string;
    documents.push({ id: tailoredVersionId, kind: 'resume', version: t.version.version_number as number });
  });
  await step('cover_letter', async () => {
    const out = await runAi(ai, PROMPTS.coverLetter, { resume: resume.content, job: promptJob }, { relatedId: jobId });
    const signature = profile.full_name || resume.content.basics.name;
    const text = [out.data.greeting, ...out.data.paragraphs, `${out.data.closing}\n${out.data.signature || signature}`].join('\n\n');
    const d = await saveDoc(db, userId, app, { kind: 'cover_letter', title: `Cover letter — ${job.company}`, content_text: text, content_json: { ...out.data, signature: out.data.signature || signature }, model: out.model, prompt_version: out.promptVersion });
    coverLetterId = d.id;
    documents.push(d);
  });
  await step('application_email', async () => {
    const out = await runAi(ai, PROMPTS.applicationEmail, { resume: resume.content, job: promptJob }, { relatedId: jobId });
    documents.push(await saveDoc(db, userId, app, { kind: 'email', title: out.data.subject, content_text: out.data.body, content_json: out.data, model: out.model, prompt_version: out.promptVersion }));
  });
  await step('screening_answers', async () => {
    const pref = prefs[0];
    const summary = prefs
      .map((p) => `${p.name}: ${p.work_arrangements.join('/')} ${p.locations.join(', ')}${p.min_salary_amount ? `, min ${p.salary_currency} ${p.min_salary_amount}/${p.salary_period}` : ''}${p.required_ojt_hours ? `, needs ${p.required_ojt_hours} OJT hours` : ''}`)
      .join('; ');
    const out = await runAi(ai, PROMPTS.screeningAnswers, { resume: resume.content, job: promptJob, preferencesSummary: summary || pref?.name || 'none' }, { relatedId: jobId });
    const text = out.data.answers.map((a) => `Q: ${a.question}\nA: ${a.answer}${a.needs_user_input ? '\n(needs your input)' : ''}`).join('\n\n');
    documents.push(await saveDoc(db, userId, app, { kind: 'screening_answers', title: 'Screening answers', content_text: text, content_json: out.data, model: out.model, prompt_version: out.promptVersion }));
  });

  if (!documents.length) throw new HttpError(502, 'prepare_failed', `No documents could be generated: ${errors.map((e) => e.error).join('; ')}`);

  const autoApprove = rules.mode === 'auto' && !rules.require_document_approval && errors.length === 0;
  const patch: Record<string, unknown> = {
    resume_version_id: tailoredVersionId ?? resume.versionId,
    cover_letter_document_id: coverLetterId,
    status_source: 'n8n',
  };
  if (PRE_SUBMISSION.includes(app.status)) patch.status = autoApprove ? 'awaiting_approval' : 'draft_prepared';
  if (autoApprove) {
    patch.documents_approved_at = new Date().toISOString();
    patch.auto_approved = true;
    await db.from('application_documents').update({ status: 'approved', approved_at: patch.documents_approved_at }).eq('application_id', app.id).eq('status', 'draft');
  }
  await db.from('applications').update(patch).eq('id', app.id);
  await db.from('application_events').insert({
    user_id: userId,
    application_id: app.id,
    type: 'document',
    actor: ai.runId ? 'n8n' : 'user',
    message: `Generated ${documents.length} document(s)${errors.length ? `; ${errors.length} step(s) failed` : ''}`,
    metadata: { documents, errors },
  });
  await notify(db, userId, {
    type: 'docs_ready',
    severity: errors.length ? 'warning' : 'success',
    title: `Application documents ready: ${job.title}`,
    body: `${job.company} — review and approve your tailored resume and cover letter.${errors.length ? ` (${errors.length} step(s) failed)` : ''}`,
    link: `/applications/${app.id}`,
    dedupe_key: `docs_ready:${app.id}:${documents.map((d) => d.version).join('.')}`,
  });
  return { application_id: app.id, documents, errors, next: autoApprove ? 'submit' : 'review' };
}

export async function approveDocuments(db: Db, userId: string, applicationId: string) {
  const app = await loadApplication(db, userId, applicationId);
  const now = new Date().toISOString();
  await db.from('application_documents').update({ status: 'approved', approved_at: now }).eq('application_id', app.id).eq('user_id', userId).eq('status', 'draft');
  if (app.resume_version_id) await db.from('resume_versions').update({ status: 'approved' }).eq('id', app.resume_version_id).eq('user_id', userId).eq('status', 'draft');
  const patch: Record<string, unknown> = { documents_approved_at: now, status_source: 'user' };
  if (['saved', 'discovered', 'draft_prepared'].includes(app.status)) patch.status = 'awaiting_approval';
  await db.from('applications').update(patch).eq('id', app.id);
  await audit(db, userId, 'user', 'documents_approved', 'application', app.id);
  return { approved: true };
}

/** User approves the actual submission (Approval Mode) → queue Workflow 5 in submit mode. */
export async function approveSubmission(db: Db, env: Env, userId: string, applicationId: string) {
  const app = await loadApplication(db, userId, applicationId);
  if (SUBMITTED.includes(app.status)) throw conflict('already_submitted', 'This application was already submitted.');
  if (!app.documents_approved_at) throw new HttpError(409, 'documents_not_approved', 'Approve the application documents first.');
  await db.from('applications').update({ submission_approved_at: new Date().toISOString() }).eq('id', app.id);
  const { run } = await enqueueRun(db, env, userId, {
    workflow: 'application_submit',
    input: { application_id: app.id, mode: 'submit' },
    trigger: 'dashboard',
    idempotency_key: `submit:${app.id}:${app.submission_attempts}`,
    max_attempts: 1,
  });
  await audit(db, userId, 'user', 'submission_approved', 'application', app.id, { run_id: run.id });
  return { run_id: run.id };
}

export async function requestPrefill(db: Db, env: Env, userId: string, applicationId: string) {
  const app = await loadApplication(db, userId, applicationId);
  if (SUBMITTED.includes(app.status)) throw conflict('already_submitted', 'This application was already submitted.');
  const { run } = await enqueueRun(db, env, userId, { workflow: 'application_submit', input: { application_id: app.id, mode: 'prefill' }, trigger: 'dashboard', max_attempts: 1 });
  return { run_id: run.id };
}

export const confirmSchema = z.object({ submitted_at: z.iso.datetime({ offset: true }).optional(), note: z.string().max(2000).optional() });

/** Manual confirmation — the user submitted the application themselves. */
export async function confirmSubmitted(db: Db, userId: string, applicationId: string, body: z.infer<typeof confirmSchema>) {
  const app = await loadApplication(db, userId, applicationId);
  if (SUBMITTED.includes(app.status)) return { status: app.status };
  const rules = await getRules(db, userId);
  const submittedAt = body.submitted_at ?? new Date().toISOString();
  const next = new Date(Date.parse(submittedAt) + rules.follow_up_after_days * 86_400_000).toISOString();
  unwrap(
    await db
      .from('applications')
      .update({ status: 'applied', status_source: 'user', submitted_at: submittedAt, confirmed_by: 'manual', needs_manual_action: false, manual_action_reason: null, next_follow_up_at: next })
      .eq('id', app.id)
      .select('id'),
    'confirm submission',
  );
  if (body.note) await db.from('application_events').insert({ user_id: userId, application_id: app.id, type: 'note', actor: 'user', message: body.note });
  await audit(db, userId, 'user', 'submission_confirmed_manually', 'application', app.id);
  return { status: 'applied' };
}

function allowedHosts(env: Env, sourceConfig: Record<string, unknown> | null): string[] {
  const fromEnv = env.RUNNER_ALLOWED_HOSTS.split(',').map((h) => h.trim().toLowerCase()).filter(Boolean);
  const fromSource = Array.isArray(sourceConfig?.allowed_hosts) ? (sourceConfig!.allowed_hosts as string[]).map((h) => h.toLowerCase()) : [];
  return [...new Set([...fromEnv, ...fromSource])];
}

function startOfManilaDay(): string {
  const now = new Date();
  const manila = new Date(now.getTime() + 8 * 3600_000);
  manila.setUTCHours(0, 0, 0, 0);
  return new Date(manila.getTime() - 8 * 3600_000).toISOString();
}

async function githubDispatch(env: Env, runId: string) {
  const res = await fetch(`https://api.github.com/repos/${env.GITHUB_REPO}/actions/workflows/${env.GITHUB_WORKFLOW}/dispatches`, {
    method: 'POST',
    headers: {
      Authorization: `Bearer ${env.GITHUB_TOKEN}`,
      Accept: 'application/vnd.github+json',
      'X-GitHub-Api-Version': '2022-11-28',
      'User-Agent': 'ApplyPilotAI',
      'content-type': 'application/json',
    },
    // Only the run id is sent — GitHub inputs appear in logs, so no personal data goes there.
    body: JSON.stringify({ ref: env.GITHUB_REF, inputs: { run_id: runId } }),
    signal: AbortSignal.timeout(10_000),
  });
  if (!res.ok && res.status !== 204) throw new Error(`GitHub dispatch failed: HTTP ${res.status} ${(await res.text()).slice(0, 200)}`);
}

export const dispatchSchema = z.object({
  mode: z.enum(['submit', 'prefill']).default('prefill'),
  run_id: z.uuid(),
  runner: z.enum(['auto', 'github', 'local']).default('auto'),
});

/**
 * Workflow 5 steps 1–5: every guard runs here (pause, source permission, host allow-list,
 * duplicates, mode/approval, auto-apply rules, daily cap) before a runner is dispatched.
 */
export async function dispatchSubmission(db: Db, env: Env, userId: string, applicationId: string, raw: z.input<typeof dispatchSchema>) {
  const input = dispatchSchema.parse(raw);
  const [app, rules] = await Promise.all([loadApplication(db, userId, applicationId), getRules(db, userId)]);
  const job = app.job_id ? await getJob(db, userId, app.job_id) : null;
  const sourceKey = (app.source_key ?? job?.source_key ?? 'manual').split(':')[0]!;
  const { data: source } = await db.from('job_sources').select('automation_allowed, config').eq('user_id', userId).eq('key', sourceKey).maybeSingle();
  const { data: match } = app.job_id ? await db.from('job_matches').select('score, eligible').eq('user_id', userId).eq('job_id', app.job_id).maybeSingle() : { data: null };
  const prefs = await getActivePreferences(db, userId);
  const hourly = job && (job.salary_max ?? job.salary_min) !== null ? toHourlyUsd((job.salary_max ?? job.salary_min)!, job.salary_currency, job.salary_period, prefs[0]?.php_per_usd ?? 58) : null;
  const { count: today } = await db.from('applications').select('id', { count: 'exact', head: true }).eq('user_id', userId).eq('channel', 'playwright').gte('submitted_at', startOfManilaDay());

  const decision = decideSubmission(
    rules,
    {
      source_key: sourceKey,
      source_automation_allowed: Boolean(source?.automation_allowed),
      company: app.company,
      title: app.job_title,
      match_score: (match?.score as number | undefined) ?? app.match_score,
      eligible: match?.eligible !== false,
      hourly_usd: hourly,
      already_submitted: SUBMITTED.includes(app.status) || Boolean(app.submitted_at),
      documents_approved: Boolean(app.documents_approved_at),
      user_approved_submission: Boolean(app.submission_approved_at),
    },
    today ?? 0,
  );
  let action = decision.action;
  if (action === 'submit' && input.mode === 'prefill') action = 'prefill';

  const host = (() => {
    try {
      return new URL(app.apply_url ?? '').hostname.toLowerCase();
    } catch {
      return '';
    }
  })();
  if ((action === 'submit' || action === 'prefill') && !allowedHosts(env, (source?.config as Record<string, unknown>) ?? null).includes(host)) {
    action = 'manual';
    decision.reasons.push(`Host "${host || 'unknown'}" is not on the runner allow-list.`);
  }

  if (action === 'manual' || action === 'blocked') {
    if (action === 'manual') {
      await db.from('applications').update({ needs_manual_action: true, manual_action_reason: decision.reasons.join(' '), status_source: 'n8n' }).eq('id', app.id);
      await notify(db, userId, {
        type: 'approval_needed',
        severity: 'warning',
        title: `Manual action needed: ${app.job_title}`,
        body: `${app.company} — ${decision.reasons.join(' ')} Open the original posting to apply yourself, then mark it as applied.`,
        link: `/applications/${app.id}`,
        dedupe_key: `manual:${app.id}`,
      });
    }
    await db.from('application_events').insert({ user_id: userId, application_id: app.id, type: 'automation', actor: 'n8n', message: `Submission ${action}: ${decision.reasons.join(' ')}`, metadata: { decision } });
    await finishRun(db, userId, input.run_id, { status: action === 'manual' ? 'succeeded' : 'cancelled', output: { action, reasons: decision.reasons }, error: action === 'blocked' ? decision.reasons.join(' ') : null });
    return { action, reasons: decision.reasons, runner: null };
  }

  if (action === 'submit') {
    // Atomic lock: only one submission can be in progress, and never after a successful one.
    const { data: locked } = await db
      .from('applications')
      .update({ status: 'submission_in_progress', status_source: 'n8n', channel: 'playwright', submission_attempts: app.submission_attempts + 1, last_error: null })
      .eq('id', app.id)
      .in('status', PRE_SUBMISSION)
      .is('submitted_at', null)
      .select('id');
    if (!locked?.length) {
      await finishRun(db, userId, input.run_id, { status: 'cancelled', error: 'Submission already in progress or completed' });
      return { action: 'blocked', reasons: ['Submission already in progress or completed.'], runner: null };
    }
  }

  // GitHub Actions when configured (its job starts the demo site too), otherwise the local runner polls.
  const runner = input.runner === 'auto' ? (env.GITHUB_TOKEN && env.GITHUB_REPO ? 'github' : 'local') : input.runner;
  await db.from('automation_runs').update({ output: { application_id: app.id, action, runner, runner_state: 'pending' }, heartbeat_at: new Date().toISOString() }).eq('id', input.run_id);
  if (runner === 'github') {
    if (!env.GITHUB_TOKEN || !env.GITHUB_REPO) throw new HttpError(503, 'github_not_configured', 'GITHUB_TOKEN / GITHUB_REPO are not configured');
    try {
      await githubDispatch(env, input.run_id);
    } catch (e) {
      if (action === 'submit') await db.from('applications').update({ status: 'awaiting_approval', status_source: 'system', last_error: (e as Error).message }).eq('id', app.id);
      throw new HttpError(502, 'dispatch_failed', (e as Error).message);
    }
  }
  await db.from('application_events').insert({ user_id: userId, application_id: app.id, type: 'automation', actor: 'n8n', message: `Dispatched ${action} to ${runner} runner`, metadata: { run_id: input.run_id } });
  return { action, reasons: decision.reasons, runner };
}

// ─── Runner endpoints ───────────────────────────────────────────────────────

async function loadSubmitRun(db: Db, userId: string, runId: string) {
  const run = unwrap(await db.from('automation_runs').select('*').eq('id', runId).eq('user_id', userId).eq('workflow', 'application_submit').maybeSingle(), 'load runner run');
  if (!run) throw notFound('Runner job');
  return run as { id: string; status: string; output: Record<string, unknown> | null; input: Record<string, unknown>; cancel_requested: boolean };
}

/** Local runner polling: claims the oldest pending local job. */
export async function nextLocalJob(db: Db, userId: string) {
  const { data } = await db
    .from('automation_runs')
    .select('id, output')
    .eq('user_id', userId)
    .eq('workflow', 'application_submit')
    .eq('status', 'running')
    .eq('output->>runner', 'local')
    .eq('output->>runner_state', 'pending')
    .order('queued_at')
    .limit(1);
  const run = data?.[0];
  if (!run) return null;
  const { data: claimed } = await db
    .from('automation_runs')
    .update({ output: { ...(run.output as object), runner_state: 'claimed' }, heartbeat_at: new Date().toISOString() })
    .eq('id', run.id)
    .eq('output->>runner_state', 'pending')
    .select('id');
  return claimed?.length ? { run_id: run.id as string } : null;
}

export async function runnerPayload(db: Db, env: Env, userId: string, runId: string) {
  const run = await loadSubmitRun(db, userId, runId);
  if (run.status !== 'running') throw new HttpError(409, 'run_not_running', `Run is ${run.status}`);
  const rules = await getRules(db, userId);
  if (rules.paused || run.cancel_requested) throw new HttpError(423, 'automation_paused', 'Automation paused or run cancelled');
  const output = run.output ?? {};
  const app = await loadApplication(db, userId, String(output.application_id ?? run.input.application_id));
  const [profile, docs, version, source] = await Promise.all([
    getProfile(db, userId),
    db.from('application_documents').select('id, kind, content_text, content_json, status, version').eq('application_id', app.id).in('status', ['approved', 'draft']).order('version', { ascending: false }),
    app.resume_version_id ? db.from('resume_versions').select('content').eq('id', app.resume_version_id).maybeSingle() : Promise.resolve({ data: null }),
    db.from('job_sources').select('config').eq('user_id', userId).eq('key', (app.source_key ?? 'manual').split(':')[0]!).maybeSingle(),
  ]);
  const latest = (kind: string) => (docs.data ?? []).find((d: { kind: string; status: string }) => d.kind === kind && (d.status === 'approved' || output.action === 'prefill'));
  const resume = (version.data?.content as Record<string, unknown> | undefined) ?? (await getVerifiedResume(db, userId)).content;
  return {
    run_id: run.id,
    action: output.action as 'submit' | 'prefill',
    application: { id: app.id, company: app.company, job_title: app.job_title, apply_url: app.apply_url, source_key: app.source_key },
    allowed_hosts: allowedHosts(env, (source.data?.config as Record<string, unknown>) ?? null),
    applicant: {
      full_name: profile.full_name,
      email: profile.email,
      phone: profile.phone,
      location: profile.location,
      linkedin_url: profile.linkedin_url,
      github_url: profile.github_url,
      portfolio_url: profile.portfolio_url,
    },
    resume,
    cover_letter: latest('cover_letter')?.content_text ?? '',
    screening_answers: (latest('screening_answers')?.content_json as { answers?: unknown[] } | undefined)?.answers ?? [],
  };
}

export async function evidenceUploadUrl(db: Db, userId: string, runId: string, body: { name: string }) {
  const run = await loadSubmitRun(db, userId, runId);
  const appId = String(run.output?.application_id ?? run.input.application_id);
  const safe = body.name.replace(/[^a-z0-9._-]/gi, '_').slice(0, 80);
  const path = `${userId}/${appId}/${runId}/${safe}`;
  const { data, error } = await db.storage.from('evidence').createSignedUploadUrl(path);
  if (error || !data) throw new HttpError(500, 'storage_error', `Could not create upload URL: ${error?.message}`);
  return { path, signed_url: data.signedUrl, token: data.token };
}

export const runnerResultSchema = z.object({
  outcome: z.enum(['submitted', 'prefilled', 'manual_required', 'failed']),
  confirmation_text: z.string().max(2000).nullish(),
  confirmation_id: z.string().max(200).nullish(),
  final_url: z.string().max(2000).nullish(),
  screenshots: z.array(z.string().max(500)).max(10).default([]),
  fields_filled: z.array(z.object({ field: z.string().max(200), value_preview: z.string().max(200) })).max(80).default([]),
  unanswered_questions: z.array(z.string().max(300)).max(30).default([]),
  captcha_detected: z.boolean().default(false),
  error: z.string().max(2000).nullish(),
  duration_ms: z.number().int().nonnegative().optional(),
});

/**
 * Workflow 5 steps 12–15. "Applied" requires evidence: a screenshot uploaded to the evidence
 * bucket AND a detected confirmation message or reference id. Anything less is not a success.
 */
export async function recordRunnerResult(db: Db, userId: string, runId: string, raw: z.input<typeof runnerResultSchema>) {
  const r = runnerResultSchema.parse(raw);
  const run = await loadSubmitRun(db, userId, runId);
  const app = await loadApplication(db, userId, String(run.output?.application_id ?? run.input.application_id));
  const evidence = {
    run_id: runId,
    screenshots: r.screenshots.filter((p) => p.startsWith(`${userId}/${app.id}/${runId}/`)),
    confirmation_text: r.confirmation_text ?? null,
    confirmation_id: r.confirmation_id ?? null,
    final_url: r.final_url ?? null,
    fields_filled: r.fields_filled,
    unanswered_questions: r.unanswered_questions,
    captcha_detected: r.captcha_detected,
    recorded_at: new Date().toISOString(),
  };
  const hasEvidence = evidence.screenshots.length > 0 && Boolean(evidence.confirmation_text || evidence.confirmation_id);
  const rules = await getRules(db, userId);
  let appStatus: ApplicationStatus = app.status;
  let message: string;
  const patch: Record<string, unknown> = { status_source: 'runner' };

  if (r.outcome === 'submitted' && hasEvidence) {
    const now = new Date().toISOString();
    Object.assign(patch, {
      status: 'applied',
      submitted_at: now,
      confirmed_by: 'evidence',
      submission_evidence: evidence,
      channel: 'playwright',
      needs_manual_action: false,
      manual_action_reason: null,
      next_follow_up_at: new Date(Date.now() + rules.follow_up_after_days * 86_400_000).toISOString(),
    });
    appStatus = 'applied';
    message = `Submitted via Playwright${evidence.confirmation_id ? ` (ref ${evidence.confirmation_id})` : ''}`;
  } else if (r.outcome === 'submitted') {
    Object.assign(patch, { status: 'submission_failed', last_error: 'Submission could not be verified (no confirmation captured). Check the evidence and confirm manually.', needs_manual_action: true, manual_action_reason: 'Unverified submission' });
    appStatus = 'submission_failed';
    message = 'Runner reported submission but no confirmation evidence was captured';
  } else if (r.outcome === 'prefilled') {
    if (app.status === 'submission_in_progress') patch.status = 'awaiting_approval';
    message = `Form prefilled for review (${r.fields_filled.length} fields${r.unanswered_questions.length ? `, ${r.unanswered_questions.length} unanswered` : ''})`;
  } else if (r.outcome === 'manual_required') {
    Object.assign(patch, { status: app.status === 'submission_in_progress' ? 'awaiting_approval' : app.status, needs_manual_action: true, manual_action_reason: r.captcha_detected ? 'CAPTCHA detected — automation stopped' : (r.error ?? 'Unsupported form') });
    message = r.captcha_detected ? 'CAPTCHA detected — moved to manual queue (never bypassed)' : `Manual action required: ${r.error ?? 'unsupported form'}`;
  } else {
    Object.assign(patch, { status: app.status === 'submission_in_progress' ? 'submission_failed' : app.status, last_error: r.error ?? 'Runner failed' });
    appStatus = 'submission_failed';
    message = `Runner failed: ${r.error ?? 'unknown error'}`;
  }
  unwrap(await db.from('applications').update(patch).eq('id', app.id).select('id'), 'update application from runner');
  await db.from('application_events').insert({ user_id: userId, application_id: app.id, type: 'automation', actor: 'runner', message, metadata: { outcome: r.outcome, evidence, duration_ms: r.duration_ms } });

  const success = appStatus === 'applied' || r.outcome === 'prefilled';
  await notify(db, userId, {
    type: r.outcome === 'prefilled' ? 'approval_needed' : 'application_update',
    severity: appStatus === 'applied' ? 'success' : success ? 'info' : 'warning',
    title: appStatus === 'applied' ? `Applied: ${app.job_title} @ ${app.company}` : r.outcome === 'prefilled' ? `Review prefilled form: ${app.job_title}` : `Submission needs attention: ${app.job_title}`,
    body: message,
    link: `/applications/${app.id}`,
    dedupe_key: `runner:${runId}`,
  });
  await finishRun(db, userId, runId, {
    status: success || r.outcome === 'manual_required' ? 'succeeded' : 'failed',
    output: { ...(run.output ?? {}), runner_state: 'done', outcome: r.outcome, verified: hasEvidence },
    error: success ? null : (r.error ?? message),
  });
  return { application_status: patch.status ?? app.status, verified: hasEvidence, message };
}

/** Workflow 5 sweep: submissions stuck "in progress" for over an hour are released. */
export async function releaseStuckSubmissions(db: Db, userId: string) {
  const cutoff = new Date(Date.now() - 3600_000).toISOString();
  const { data } = await db
    .from('applications')
    .update({ status: 'submission_failed', status_source: 'system', last_error: 'Runner did not report back within 1 hour', needs_manual_action: true, manual_action_reason: 'Runner timeout' })
    .eq('user_id', userId)
    .eq('status', 'submission_in_progress')
    .lt('updated_at', cutoff)
    .select('id, job_title');
  for (const a of data ?? []) {
    await notify(db, userId, { type: 'automation_error', severity: 'error', title: `Submission timed out: ${a.job_title}`, link: `/applications/${a.id}`, dedupe_key: `stuck:${a.id}:${cutoff.slice(0, 13)}` });
  }
  return { released: data?.length ?? 0 };
}
