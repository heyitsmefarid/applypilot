import { WORKFLOW_WEBHOOK_PATHS } from '@applypilot/core';
import { API, api, code, ERR_HELPER, Flow, GATE, RESOLVE_RUN, schedule, startRunBody, webhook, WORKFLOW_IDS, type N8nWorkflow } from './lib.js';

const P = WORKFLOW_WEBHOOK_PATHS;
const RUN = "$('Gate').first().json.run_id";
const INPUT = "$('Gate').first().json.input";

/** Trigger(s) → Resolve run → Start run → Gate. Returns the Gate node name. */
function preamble(f: Flow, workflow: string, triggers: string[]) {
  f.add(code('Resolve run', RESOLVE_RUN));
  for (const t of triggers) f.connect(t, 'Resolve run');
  f.add(api('Start run', { path: '/internal/runs/start', body: startRunBody(workflow), notes: 'Creates/claims the run, checks the emergency pause' }));
  f.add(code('Gate', GATE));
  f.chain('Resolve run', 'Start run', 'Gate');
  f.place(triggers, 0, 0);
  f.place(['Resolve run', 'Start run', 'Gate'], 0, 1);
  return 'Gate';
}

function finish(f: Flow, from: string, statsNode: string) {
  f.add(
    api('Finish run', {
      path: `/internal/runs/{{ ${RUN} }}/finish`,
      body: `{ status: $('${statsNode}').first().json.status, stats: $('${statsNode}').first().json.stats, item_errors: $('${statsNode}').first().json.item_errors ?? [], output: $('${statsNode}').first().json.output ?? null }`,
    }),
  );
  f.connect(from, 'Finish run');
}

// ─── 00 Command Dispatcher ──────────────────────────────────────────────────
export function dispatcher(): N8nWorkflow {
  const f = new Flow(WORKFLOW_IDS.dispatcher);
  f.add(schedule('Every minute', { minutes: 1 }));
  f.add(api('Claim queued runs', { path: '/internal/runs/claim', body: '{ limit: 5 }', retry: { tries: 2, waitMs: 2000 }, notes: 'Atomic claim (FOR UPDATE SKIP LOCKED) — a run is never delivered twice' }));
  f.add(
    code(
      'Route to workflows',
      `
const PATHS = ${JSON.stringify(P)};
const runs = $input.first().json.runs ?? [];
// Each claimed run is forwarded to the local webhook of the workflow that handles it.
return runs.filter((r) => PATHS[r.workflow]).map((r) => ({ json: { run_id: r.id, workflow: r.workflow, input: r.input ?? {}, path: PATHS[r.workflow] } }));
`,
    ),
  );
  f.add({
    name: 'Deliver to workflow webhook',
    type: 'n8n-nodes-base.httpRequest',
    typeVersion: 4.2,
    parameters: {
      method: 'POST',
      url: "={{ ($env.N8N_INTERNAL_WEBHOOK_BASE || 'http://localhost:5678') + '/webhook/' + $json.path }}",
      authentication: 'genericCredentialType',
      genericAuthType: 'httpHeaderAuth',
      sendBody: true,
      specifyBody: 'json',
      jsonBody: '={{ JSON.stringify({ run_id: $json.run_id, workflow: $json.workflow, input: $json.input }) }}',
      options: { timeout: 15000 },
    },
    credentials: { httpHeaderAuth: { id: 'apWebhookAuthKey', name: 'ApplyPilot Webhook Auth' } },
    onError: 'continueRegularOutput',
  });
  f.add(
    code(
      'Find undelivered',
      `
${ERR_HELPER}
const routed = $('Route to workflows').all();
// Delivery fails when the target workflow is inactive; such runs go back to the queue.
return $input.all().map((it, i) => ({ json: { run_id: routed[i]?.json.run_id, error: errOf(it.json) } })).filter((x) => x.error && x.run_id);
`,
    ),
  );
  f.add(api('Release run', { path: '/internal/runs/{{ $json.run_id }}/release', body: '{ error: $json.error }', retry: false, continueOnFail: true }));
  f.chain('Every minute', 'Claim queued runs', 'Route to workflows', 'Deliver to workflow webhook', 'Find undelivered', 'Release run');
  return f.build('ApplyPilot 00 · Command Dispatcher', { saveSuccess: false, description: 'Polls the Supabase-backed run queue every minute and starts the matching workflow.' });
}

// ─── 01 Job Discovery ───────────────────────────────────────────────────────
export function discovery(coreBundle: string): N8nWorkflow {
  const f = new Flow(WORKFLOW_IDS.discovery);
  f.add(schedule('Every hour', { hours: 1 }));
  f.add(webhook('Run request', P.job_discovery));
  const gate = preamble(f, 'job_discovery', ['Every hour', 'Run request']);
  f.add(api('Load sources & preferences', { method: 'GET', path: `/internal/discovery/plan?force={{ ${INPUT}.force ? 1 : 0 }}`, notes: 'Plan honours each source rate limit (e.g. Remotive ≤ 4/day)' }));
  f.add(
    code(
      'Split requests',
      `
const plan = $input.first().json;
const requests = (plan.requests ?? []).map((r) => ({ json: r }));
// n8n ends a branch on zero items; a single no-op keeps the run lifecycle (finish step) intact.
return requests.length ? requests : [{ json: { noop: true, source_key: 'none', kind: 'none', url: $env.APPLYPILOT_API_URL + '/health', method: 'GET', headers: {}, meta: {} } }];
`,
    ),
  );
  f.add({
    name: 'Fetch source',
    type: 'n8n-nodes-base.httpRequest',
    typeVersion: 4.2,
    parameters: {
      method: 'GET',
      url: '={{ $json.url }}',
      sendHeaders: true,
      specifyHeaders: 'json',
      jsonHeaders: '={{ JSON.stringify($json.headers ?? {}) }}',
      options: { timeout: 45000, batching: { batch: { batchSize: 1, batchInterval: 1500 } }, response: { response: { responseFormat: 'json' } } },
    },
    retryOnFail: true,
    maxTries: 3,
    waitBetweenTries: 5000,
    onError: 'continueRegularOutput',
    notes: 'Official/public APIs only. One failing source never stops the batch.',
    notesInFlow: true,
  });
  f.add(
    code(
      'Normalize listings',
      `
${coreBundle}
${ERR_HELPER}
const requests = $('Split requests').all();
const bySource = new Map();
const bucket = (key) => {
  if (!bySource.has(key)) bySource.set(key, { source_key: key, jobs: [], fetch_errors: [], rejected: 0 });
  return bySource.get(key);
};
$input.all().forEach((item, i) => {
  const req = requests[i]?.json;
  if (!req || req.noop) return;
  const b = bucket(req.source_key);
  const err = errOf(item.json);
  if (err) { b.fetch_errors.push({ url: req.url, error: err }); return; }
  try {
    const result = ApplyPilotCore.normalizeResponse(req.kind, item.json, { source_key: req.source_key, meta: req.meta ?? {} });
    b.jobs.push(...result.jobs);
    b.rejected += result.rejected.length;
  } catch (e) {
    b.fetch_errors.push({ url: req.url, error: 'normalize: ' + e.message });
  }
});
// Ingest in chunks of 100 so each Worker request stays small.
const out = [];
for (const b of bySource.values()) {
  if (!b.jobs.length) { out.push({ json: { ...b, run_id: $('Gate').first().json.run_id } }); continue; }
  for (let i = 0; i < b.jobs.length; i += 100) {
    out.push({ json: { ...b, jobs: b.jobs.slice(i, i + 100), fetch_errors: i === 0 ? b.fetch_errors : [], rejected: i === 0 ? b.rejected : 0, run_id: $('Gate').first().json.run_id } });
  }
}
return out.length ? out : [{ json: { source_key: 'none', jobs: [], fetch_errors: [], rejected: 0, run_id: $('Gate').first().json.run_id } }];
`,
    ),
  );
  f.add(api('Store jobs', { path: '/internal/jobs/ingest', body: '{ run_id: $json.run_id, source_key: $json.source_key, jobs: $json.jobs, fetch_errors: $json.fetch_errors, rejected: $json.rejected }', batch: { size: 1, intervalMs: 300 }, continueOnFail: true, notes: 'Validates, removes duplicates (same source + cross-source fingerprint), upserts' }));
  f.add(
    code(
      'Collect results',
      `
${ERR_HELPER}
const sent = $('Normalize listings').all();
const stats = { requests: $('Split requests').all().filter((r) => !r.json.noop).length, received: 0, inserted: 0, duplicates: 0, invalid: 0, irrelevant: 0, expired: 0, fetch_errors: 0 };
const ids = [];
const item_errors = [];
$input.all().forEach((it, i) => {
  const err = errOf(it.json);
  if (err) { item_errors.push({ source_key: sent[i]?.json.source_key, error: err }); return; }
  const s = it.json.stats ?? {};
  stats.received += s.received ?? 0;
  stats.inserted += s.inserted ?? 0;
  stats.duplicates += (s.duplicates_in_batch ?? 0) + (s.duplicates_cross_source ?? 0) + (s.already_known ?? 0);
  stats.invalid += s.invalid ?? 0;
  stats.irrelevant += s.irrelevant ?? 0;
  stats.expired += s.expired ?? 0;
  stats.fetch_errors += s.fetch_errors ?? 0;
  ids.push(...(it.json.inserted_ids ?? []));
});
for (const s of sent) for (const fe of s.json.fetch_errors ?? []) item_errors.push({ source_key: s.json.source_key, ...fe });
const status = item_errors.length ? (stats.inserted || stats.received ? 'partial' : 'failed') : 'succeeded';
return [{ json: { status, stats, item_errors, new_job_ids: ids, output: { new_job_ids: ids.slice(0, 200) } } }];
`,
    ),
  );
  f.add(api('Expire stale listings', { path: '/internal/jobs/expire', continueOnFail: true }));
  f.add(
    api('Queue matching', {
      path: '/internal/runs/enqueue-batch',
      body: `{ runs: $('Collect results').first().json.new_job_ids.length ? [{ workflow: 'job_matching', trigger: 'event', input: { job_ids: $('Collect results').first().json.new_job_ids.slice(0, 200) }, idempotency_key: 'match:' + ${RUN} }] : [] }`,
      notes: 'Hands new jobs to Workflow 3 (independent, retryable)',
    }),
  );
  f.chain(gate, 'Load sources & preferences', 'Split requests', 'Fetch source', 'Normalize listings', 'Store jobs', 'Collect results', 'Expire stale listings', 'Queue matching');
  finish(f, 'Queue matching', 'Collect results');
  f.place(['Load sources & preferences', 'Split requests', 'Fetch source', 'Normalize listings', 'Store jobs', 'Collect results', 'Expire stale listings', 'Queue matching', 'Finish run'], 1, 1);
  return f.build('ApplyPilot 01 · Job Discovery', { description: 'Fetches authorized job sources, normalizes, deduplicates, stores and queues matching.' });
}

// ─── 02 Resume Analysis ─────────────────────────────────────────────────────
export function resumeAnalysis(): N8nWorkflow {
  const f = new Flow(WORKFLOW_IDS.resume);
  f.add(schedule('Every 30 minutes', { minutes: 30 }));
  f.add(webhook('Run request', P.resume_analysis));
  const gate = preamble(f, 'resume_analysis', ['Every 30 minutes', 'Run request']);
  f.add(api('Find unprocessed resumes', { method: 'GET', path: '/internal/resumes/pending' }));
  f.add(code('Split resumes', `
const ids = ($input.first().json.resumes ?? []).map((r) => r.id);
const requested = $('Gate').first().json.input.resume_id;
const list = requested && !ids.includes(requested) ? [requested, ...ids] : ids;
return list.length ? list.map((id) => ({ json: { resume_id: id } })) : [{ json: { noop: true } }];
`));
  f.add({
    ...api('Extract & analyze', { path: '/internal/resumes/{{ $json.resume_id }}/process', batch: { size: 1, intervalMs: 8000 }, timeoutMs: 180_000, continueOnFail: true, runIdExpr: RUN, retry: { tries: 2, waitMs: 20000 } }),
    parameters: {
      ...api('x', { path: '' }).parameters,
      url: `={{ $json.noop ? $env.APPLYPILOT_API_URL + '/health' : $env.APPLYPILOT_API_URL + '/internal/resumes/' + $json.resume_id + '/process' }}`,
      sendHeaders: true,
      headerParameters: { parameters: [{ name: 'X-ApplyPilot-Run-Id', value: `={{ ${RUN} }}` }] },
      options: { timeout: 180000, batching: { batch: { batchSize: 1, batchInterval: 8000 } } },
    },
  });
  f.add(code('Summarize', `
${ERR_HELPER}
const reqs = $('Split resumes').all();
const item_errors = [];
let processed = 0;
$input.all().forEach((it, i) => {
  if (reqs[i]?.json.noop) return;
  const err = errOf(it.json);
  if (err) item_errors.push({ resume_id: reqs[i]?.json.resume_id, error: err });
  else processed++;
});
return [{ json: { status: item_errors.length ? (processed ? 'partial' : 'failed') : 'succeeded', stats: { processed, failed: item_errors.length }, item_errors } }];
`));
  f.chain(gate, 'Find unprocessed resumes', 'Split resumes', 'Extract & analyze', 'Summarize');
  finish(f, 'Summarize', 'Summarize');
  f.place(['Find unprocessed resumes', 'Split resumes', 'Extract & analyze', 'Summarize', 'Finish run'], 1, 1);
  return f.build('ApplyPilot 02 · Resume Analysis', { description: 'Extracts structured data and quality analysis for uploaded resumes.' });
}

// ─── 03 AI Job Matching ─────────────────────────────────────────────────────
export function matching(): N8nWorkflow {
  const f = new Flow(WORKFLOW_IDS.matching);
  f.add(schedule('Every 2 hours (sweep)', { hours: 2 }));
  f.add(webhook('Run request', P.job_matching));
  const gate = preamble(f, 'job_matching', ['Every 2 hours (sweep)', 'Run request']);
  f.add(api('Jobs awaiting a score', { path: '/internal/matching/pending', body: `{ limit: 25, job_ids: ${INPUT}.job_ids }` }));
  f.add(code('Split jobs', `
const jobs = $input.first().json.jobs ?? [];
return jobs.length ? jobs.map((j) => ({ json: j })) : [{ json: { noop: true } }];
`));
  f.add({
    ...api('Score job', { path: '' }),
    parameters: {
      ...api('x', { path: '', body: '{ use_ai: $json.use_ai !== false }' }).parameters,
      url: `={{ $json.noop ? $env.APPLYPILOT_API_URL + '/health' : $env.APPLYPILOT_API_URL + '/internal/matching/' + $json.job_id }}`,
      sendHeaders: true,
      headerParameters: { parameters: [{ name: 'X-ApplyPilot-Run-Id', value: `={{ ${RUN} }}` }] },
      // ~9 requests/minute keeps Gemini free-tier pacing (Worker enforces RPM + daily budget too).
      options: { timeout: 120000, batching: { batch: { batchSize: 1, batchInterval: 6500 } } },
    },
    retryOnFail: true,
    maxTries: 2,
    waitBetweenTries: 30000,
    onError: 'continueRegularOutput',
    notes: 'Deterministic eligibility first; Gemini only for eligible jobs',
    notesInFlow: true,
  });
  f.add(code('Summarize', `
${ERR_HELPER}
const reqs = $('Split jobs').all();
const item_errors = [];
const prep = [];
let scored = 0, high = 0, eligible = 0, ai = 0;
$input.all().forEach((it, i) => {
  if (reqs[i]?.json.noop) return;
  const err = errOf(it.json);
  if (err) { item_errors.push({ job_id: reqs[i]?.json.job_id, error: err }); return; }
  scored++;
  if (it.json.eligible) eligible++;
  if (it.json.high_match) high++;
  if (it.json.used_ai) ai++;
  if (it.json.auto_prepare) prep.push(it.json.job_id);
});
const status = item_errors.length ? (scored ? 'partial' : 'failed') : 'succeeded';
return [{ json: { status, stats: { scored, eligible, high_matches: high, ai_scored: ai, queued_for_prep: prep.length, failed: item_errors.length }, item_errors, prep_job_ids: prep } }];
`));
  f.add(api('Queue preparation', {
    path: '/internal/runs/enqueue-batch',
    body: `{ runs: $json.prep_job_ids.length ? [{ workflow: 'application_prep', trigger: 'event', input: { job_ids: $json.prep_job_ids.slice(0, 10) }, idempotency_key: 'prep:' + ${RUN} }] : [] }`,
    notes: 'Only for jobs meeting your auto-prepare rule (approval/auto modes)',
  }));
  f.chain(gate, 'Jobs awaiting a score', 'Split jobs', 'Score job', 'Summarize', 'Queue preparation');
  finish(f, 'Queue preparation', 'Summarize');
  f.place(['Jobs awaiting a score', 'Split jobs', 'Score job', 'Summarize', 'Queue preparation', 'Finish run'], 1, 1);
  return f.build('ApplyPilot 03 · AI Job Matching', { description: 'Scores new jobs against the verified resume and notifies about high matches.' });
}

// ─── 04 Application Preparation ─────────────────────────────────────────────
export function preparation(): N8nWorkflow {
  const f = new Flow(WORKFLOW_IDS.prep);
  f.add(webhook('Run request', P.application_prep));
  const gate = preamble(f, 'application_prep', ['Run request']);
  f.add(code('Split jobs', `
const input = $('Gate').first().json.input;
const ids = [...new Set([...(input.job_ids ?? []), ...(input.job_id ? [input.job_id] : [])])];
return ids.length ? ids.map((id) => ({ json: { job_id: id } })) : [{ json: { noop: true } }];
`));
  f.add({
    ...api('Prepare documents', { path: '' }),
    parameters: {
      ...api('x', { path: '', body: '{ job_id: $json.job_id }' }).parameters,
      url: `={{ $json.noop ? $env.APPLYPILOT_API_URL + '/health' : $env.APPLYPILOT_API_URL + '/internal/applications/prepare' }}`,
      sendHeaders: true,
      headerParameters: { parameters: [{ name: 'X-ApplyPilot-Run-Id', value: `={{ ${RUN} }}` }] },
      // Each preparation uses 4 Gemini calls (resume, cover letter, email, screening answers).
      options: { timeout: 240000, batching: { batch: { batchSize: 1, batchInterval: 30000 } } },
    },
    retryOnFail: true,
    maxTries: 2,
    waitBetweenTries: 60000,
    onError: 'continueRegularOutput',
  });
  f.add(code('Summarize', `
${ERR_HELPER}
const reqs = $('Split jobs').all();
const item_errors = [];
const submit = [];
let prepared = 0;
$input.all().forEach((it, i) => {
  if (reqs[i]?.json.noop) return;
  const err = errOf(it.json);
  if (err) { item_errors.push({ job_id: reqs[i]?.json.job_id, error: err }); return; }
  prepared++;
  for (const e of it.json.errors ?? []) item_errors.push({ job_id: reqs[i]?.json.job_id, step: e.step, error: e.error });
  // Only conditional auto-apply with document approval disabled continues automatically.
  if (it.json.next === 'submit') submit.push(it.json.application_id);
});
return [{ json: { status: item_errors.length ? (prepared ? 'partial' : 'failed') : 'succeeded', stats: { prepared, failed: item_errors.length, queued_for_submission: submit.length }, item_errors, submit_ids: submit } }];
`));
  f.add(api('Queue auto-submission', {
    path: '/internal/runs/enqueue-batch',
    body: `{ runs: $json.submit_ids.map((id) => ({ workflow: 'application_submit', trigger: 'event', input: { application_id: id, mode: 'submit' }, idempotency_key: 'autosubmit:' + id, max_attempts: 1 })) }`,
    notes: 'The Worker re-checks every auto-apply rule before dispatching',
  }));
  f.chain(gate, 'Split jobs', 'Prepare documents', 'Summarize', 'Queue auto-submission');
  finish(f, 'Queue auto-submission', 'Summarize');
  f.place(['Split jobs', 'Prepare documents', 'Summarize', 'Queue auto-submission', 'Finish run'], 1, 1);
  return f.build('ApplyPilot 04 · Application Preparation', { description: 'Tailored resume, cover letter, email and screening answers for selected jobs.' });
}

// ─── 05 Application Submission (Playwright) ─────────────────────────────────
export function submission(): N8nWorkflow {
  const f = new Flow(WORKFLOW_IDS.submit);
  f.add(webhook('Run request', P.application_submit));
  const gate = preamble(f, 'application_submit', ['Run request']);
  f.add(api('Check rules & dispatch runner', {
    path: `/internal/applications/{{ ${INPUT}.application_id }}/dispatch`,
    body: `{ mode: ${INPUT}.mode === 'submit' ? 'submit' : 'prefill', run_id: ${RUN} }`,
    retry: false,
    continueOnFail: true,
    notes: 'Pause, source permission, host allow-list, duplicates, approval and daily cap are all checked here. Never retried automatically (no duplicate submissions).',
  }));
  f.add(code('Dispatch failed?', `
${ERR_HELPER}
const err = errOf($input.first().json);
// On success the runner (GitHub Actions or local) reports back to the Worker, which finishes this run.
if (!err) return [];
return [{ json: { status: 'failed', stats: {}, item_errors: [], output: { error: err } } }];
`));
  f.add(api('Mark run failed', {
    path: `/internal/runs/{{ ${RUN} }}/finish`,
    body: "{ status: 'failed', error: $json.output.error, stats: {} }",
  }));
  f.chain(gate, 'Check rules & dispatch runner', 'Dispatch failed?', 'Mark run failed');
  f.place(['Check rules & dispatch runner', 'Dispatch failed?', 'Mark run failed'], 1, 1);
  // Sweep: release submissions whose runner never reported back.
  f.add(schedule('Every 15 minutes', { minutes: 15 }));
  f.add(api('Release stuck submissions', { path: '/internal/applications/release-stuck', continueOnFail: true }));
  f.chain('Every 15 minutes', 'Release stuck submissions');
  f.place(['Every 15 minutes', 'Release stuck submissions'], 3, 0);
  return f.build('ApplyPilot 05 · Application Submission', { description: 'Guarded dispatch of approved submissions to the Playwright runner.' });
}

// ─── 06 Gmail Recruitment Monitoring ────────────────────────────────────────
export function gmail(): N8nWorkflow {
  const f = new Flow(WORKFLOW_IDS.gmail);
  f.add(schedule('Every 30 minutes', { minutes: 30 }));
  f.add(webhook('Run request', P.gmail_sync));
  const gate = preamble(f, 'gmail_sync', ['Every 30 minutes', 'Run request']);
  f.add(api('Sync recruitment emails', { path: '/internal/gmail/sync', body: '{ max: 15 }', retry: { tries: 2, waitMs: 30000 }, continueOnFail: true, notes: 'Incremental Gmail search; job-alert emails become jobs' }));
  f.add(api('Unclassified messages', { method: 'GET', path: '/internal/gmail/unclassified?limit=12', executeOnce: true }));
  f.add(code('Split messages', `
const ids = $input.first().json.message_ids ?? [];
return ids.length ? ids.map((id) => ({ json: { message_id: id } })) : [{ json: { noop: true } }];
`));
  f.add({
    ...api('Classify & link', { path: '' }),
    parameters: {
      ...api('x', { path: '' }).parameters,
      url: `={{ $json.noop ? $env.APPLYPILOT_API_URL + '/health' : $env.APPLYPILOT_API_URL + '/internal/gmail/messages/' + $json.message_id + '/classify' }}`,
      sendHeaders: true,
      headerParameters: { parameters: [{ name: 'X-ApplyPilot-Run-Id', value: `={{ ${RUN} }}` }] },
      options: { timeout: 120000, batching: { batch: { batchSize: 1, batchInterval: 6500 } } },
    },
    retryOnFail: true,
    maxTries: 2,
    waitBetweenTries: 30000,
    onError: 'continueRegularOutput',
    notes: 'Status changes only at ≥ 0.85 confidence; replies are drafted, never sent',
    notesInFlow: true,
  });
  f.add(code('Summarize', `
${ERR_HELPER}
const sync = $('Sync recruitment emails').first().json;
const reqs = $('Split messages').all();
const item_errors = [];
const syncErr = errOf(sync);
if (syncErr) item_errors.push({ step: 'sync', error: syncErr });
let classified = 0, status_changes = 0, important = 0;
$input.all().forEach((it, i) => {
  if (reqs[i]?.json.noop) return;
  const err = errOf(it.json);
  if (err) { item_errors.push({ message_id: reqs[i]?.json.message_id, error: err }); return; }
  classified++;
  if (it.json.status_changed) status_changes++;
  if (['interview', 'offer', 'assessment', 'rejection'].includes(it.json.category)) important++;
});
const stats = { fetched: sync.fetched ?? 0, alert_jobs: sync.alert_jobs ?? 0, classified, status_changes, important, failed: item_errors.length };
return [{ json: { status: item_errors.length ? (classified || stats.fetched ? 'partial' : 'failed') : 'succeeded', stats, item_errors, output: { has_more: Boolean(sync.has_more) } } }];
`));
  f.chain(gate, 'Sync recruitment emails', 'Unclassified messages', 'Split messages', 'Classify & link', 'Summarize');
  finish(f, 'Summarize', 'Summarize');
  f.place(['Sync recruitment emails', 'Unclassified messages', 'Split messages', 'Classify & link', 'Summarize', 'Finish run'], 1, 1);
  return f.build('ApplyPilot 06 · Gmail Recruitment Monitoring', { description: 'Imports recruitment emails and job alerts, classifies and links them to applications.' });
}

// ─── 07 Follow-up ───────────────────────────────────────────────────────────
export function followUp(): N8nWorkflow {
  const f = new Flow(WORKFLOW_IDS.followUp);
  f.add(schedule('Daily 09:00', { cron: '0 9 * * *' }));
  f.add(webhook('Run request', P.follow_up));
  const gate = preamble(f, 'follow_up', ['Daily 09:00', 'Run request']);
  f.add(api('Draft due follow-ups', { path: '/internal/followups/scan', timeoutMs: 240_000, runIdExpr: RUN, notes: 'Drafts only — sending needs your approval in the dashboard' }));
  f.add(code('Summarize', `
const r = $input.first().json;
return [{ json: { status: 'succeeded', stats: { scanned: r.scanned ?? 0, drafted: r.drafted ?? 0, skipped: (r.skipped ?? []).length }, item_errors: r.skipped ?? [] } }];
`));
  f.chain(gate, 'Draft due follow-ups', 'Summarize');
  finish(f, 'Summarize', 'Summarize');
  f.place(['Draft due follow-ups', 'Summarize', 'Finish run'], 1, 1);
  return f.build('ApplyPilot 07 · Application Follow-up', { description: 'Finds applications without a reply and drafts follow-ups for approval.' });
}

// ─── 08 Notifications & Reports ─────────────────────────────────────────────
export function reports(): N8nWorkflow {
  const f = new Flow(WORKFLOW_IDS.reports);
  const kinds: Array<[string, string, { cron?: string; hours?: number }]> = [
    ['Daily summary 08:00', 'daily', { cron: '0 8 * * *' }],
    ['Weekly statistics Mon 08:00', 'weekly', { cron: '0 8 * * 1' }],
    ['Interview reminders hourly', 'interviews', { hours: 1 }],
    ['Pending approvals 18:00', 'approvals', { cron: '0 18 * * *' }],
  ];
  const triggers: string[] = [];
  for (const [name, kind, rule] of kinds) {
    f.add(schedule(name, rule));
    f.add(code(`Set ${kind}`, `return [{ json: { body: { input: { kind: '${kind}' } } } }];`));
    f.connect(name, `Set ${kind}`);
    triggers.push(`Set ${kind}`);
  }
  f.add(webhook('Run request', P.reports));
  triggers.push('Run request');
  const gate = preamble(f, 'reports', triggers);
  f.add(api('Build report', { path: `/internal/reports/{{ ${INPUT}.kind || 'daily' }}` }));
  f.add(code('Summarize', `
const r = $input.first().json;
return [{ json: { status: 'succeeded', stats: { kind: $('Gate').first().json.input.kind || 'daily', emailed: Boolean(r.emailed), telegram: Boolean(r.telegram) }, item_errors: [], text: r.text ?? '', telegram: Boolean(r.telegram) } }];
`));
  f.add(code('Telegram enabled?', `
const s = $('Summarize').first().json;
// Sent only when enabled in Settings, a chat id is configured, and there is something to say.
if (!s.telegram || !s.text || !$env.TELEGRAM_CHAT_ID) return [];
return [{ json: { text: s.text.slice(0, 4000) } }];
`));
  f.add({
    name: 'Send Telegram message',
    type: 'n8n-nodes-base.telegram',
    typeVersion: 1.2,
    parameters: { chatId: '={{ $env.TELEGRAM_CHAT_ID }}', text: '={{ $json.text }}', additionalFields: { appendAttribution: false } },
    credentials: { telegramApi: { id: 'apTelegramBotKey', name: 'ApplyPilot Telegram Bot' } },
    onError: 'continueRegularOutput',
    notes: 'Optional — requires the Telegram credential and TELEGRAM_CHAT_ID',
    notesInFlow: true,
  });
  f.chain(gate, 'Build report', 'Summarize');
  finish(f, 'Summarize', 'Summarize');
  f.chain('Finish run', 'Telegram enabled?', 'Send Telegram message');
  f.place(kinds.map((k) => k[0]).concat('Run request'), 0, 0);
  f.place(triggers, 1, 1);
  f.place(['Resolve run', 'Start run', 'Gate', 'Build report', 'Summarize', 'Finish run', 'Telegram enabled?', 'Send Telegram message'], 2, 1);
  return f.build('ApplyPilot 08 · Notifications & Reports', { description: 'Daily/weekly summaries, interview reminders and pending approvals (in-app, Gmail, Telegram).' });
}

// ─── 09 Error Recovery ──────────────────────────────────────────────────────
export function recovery(): N8nWorkflow {
  const f = new Flow(WORKFLOW_IDS.recovery);
  // Part A — every other workflow names this one as its Error Workflow.
  f.add({ name: 'On workflow error', type: 'n8n-nodes-base.errorTrigger', typeVersion: 1, parameters: {} });
  f.add(code('Describe failure', `
const e = $input.first().json;
return [{ json: {
  execution_id: e.execution?.id ? String(e.execution.id) : null,
  workflow_name: e.workflow?.name ?? 'unknown',
  node: e.execution?.lastNodeExecuted ?? null,
  error: (e.execution?.error?.message ?? 'Unknown error').slice(0, 3000),
} }];
`));
  f.add(api('Record failure', { path: '/internal/runs/fail-execution', body: '$json', retry: { tries: 3, waitMs: 10000 }, notes: 'Marks the run failed and notifies when retries are exhausted' }));
  f.chain('On workflow error', 'Describe failure', 'Record failure');
  f.place(['On workflow error', 'Describe failure', 'Record failure'], 0, 0);
  // Part B — scheduled retries with exponential backoff.
  f.add(schedule('Every 15 minutes', { minutes: 15 }));
  f.add(webhook('Run request', P.error_recovery));
  f.add(code('Resolve run', RESOLVE_RUN));
  f.connect('Every 15 minutes', 'Resolve run');
  f.connect('Run request', 'Resolve run');
  f.add(api('Start run', { path: '/internal/runs/start', body: startRunBody('error_recovery') }));
  f.add(code('Gate', GATE));
  f.add(api('Schedule retries', { path: '/internal/recovery/scan', notes: 'Retryable failures only; backoff 10 → 20 → 40 min' }));
  f.add(code('Summarize', `
const r = $input.first().json;
return [{ json: { status: 'succeeded', stats: { retried: (r.retried ?? []).length, skipped: (r.skipped ?? []).length }, item_errors: [] } }];
`));
  f.chain('Resolve run', 'Start run', 'Gate', 'Schedule retries', 'Summarize');
  finish(f, 'Summarize', 'Summarize');
  f.place(['Every 15 minutes', 'Run request'], 2, 0);
  f.place(['Resolve run', 'Start run', 'Gate', 'Schedule retries', 'Summarize', 'Finish run'], 2, 1);
  // The error workflow must not point at itself.
  return f.build('ApplyPilot 09 · Error Recovery', { errorWorkflow: false, description: 'Records n8n failures and retries failed runs with backoff.' });
}

export const ALL_WORKFLOWS = (bundle: string) => [dispatcher(), discovery(bundle), resumeAnalysis(), matching(), preparation(), submission(), gmail(), followUp(), reports(), recovery()];
export { API };
