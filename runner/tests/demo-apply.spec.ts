import { expect, test, type APIRequestContext } from '@playwright/test';
import { resumeDataSchema } from '@applypilot/core';
import type { RunnerPayload, RunnerResult } from '../src/api.js';
import { executeRun, type RunnerApiLike } from '../src/run.js';

const DEMO = 'http://localhost:4321/jobs/frontend-intern';

function payload(action: 'submit' | 'prefill', url = DEMO, hosts = ['localhost']): RunnerPayload {
  return {
    run_id: 'run-test',
    action,
    application: { id: 'app-1', company: 'ApplyPilot Demo Co.', job_title: 'Frontend Developer Intern', apply_url: url, source_key: 'demo' },
    allowed_hosts: hosts,
    applicant: { full_name: 'Juan Dela Cruz', email: 'juan@example.com', phone: '+63 917 000 0000', location: 'Quezon City', linkedin_url: 'https://www.linkedin.com/in/juan', github_url: 'https://github.com/juan', portfolio_url: '' },
    resume: resumeDataSchema.parse({ basics: { name: 'Juan Dela Cruz', email: 'juan@example.com' }, skills: [{ name: 'React', category: 'framework' }] }),
    cover_letter: 'Dear Hiring Manager,\n\nI build React apps…',
    screening_answers: [
      { question: 'Are you willing to work onsite in Makati?', answer: 'Yes' },
      { question: 'How many OJT hours are you required to render?', answer: 'I need to render 500 hours.' },
      { question: 'Why do you want to join us?', answer: 'I want to grow as a frontend developer.' },
    ],
  };
}

/** In-memory stand-in for the Worker's runner endpoints. */
function fakeApi(p: RunnerPayload) {
  const uploads: string[] = [];
  let result: RunnerResult | null = null;
  const api: RunnerApiLike = {
    payload: async () => p,
    heartbeat: async () => ({ cancel_requested: false, paused: false, running: true }),
    uploadEvidence: async (runId, name) => {
      const path = `user/app-1/${runId}/${name}`;
      uploads.push(path);
      return path;
    },
    result: async (_runId, r) => {
      result = r;
      return { application_status: r.outcome, verified: true, message: 'ok' };
    },
  };
  return { api, uploads, get result() { return result!; } };
}

async function submissionCount(request: APIRequestContext) {
  return ((await (await request.get('http://localhost:4321/api/submissions')).json()) as unknown[]).length;
}

test('submits the demo application and captures confirmation evidence', async ({ request }) => {
  const before = await submissionCount(request);
  const f = fakeApi(payload('submit'));
  const r = await executeRun(f.api, 'run-submit', { log: () => {} });
  expect(r.outcome).toBe('submitted');
  expect(r.confirmation_id).toMatch(/^DEMO-[0-9A-F]{6}$/);
  expect(r.confirmation_text).toContain('Thank you for applying');
  expect(f.uploads.map((u) => u.split('/').pop())).toEqual(['filled.png', 'confirmation.png']);
  expect(r.fields_filled.map((x) => x.field)).toEqual(expect.arrayContaining(['First name', 'Email address', 'Resume (PDF)', 'How many OJT hours are you required to render?']));
  expect(await submissionCount(request)).toBe(before + 1);
  const latest = ((await (await request.get('http://localhost:4321/api/submissions')).json()) as Array<{ reference: string; answers: { ojt_hours: string; onsite: string }; resume: { type: string } }>).find((s) => s.reference === r.confirmation_id)!;
  expect(latest.answers).toMatchObject({ ojt_hours: '500', onsite: 'Yes' });
  expect(latest.resume.type).toBe('application/pdf');
});

test('prefill mode fills the form for review but never submits', async ({ request }) => {
  const before = await submissionCount(request);
  const f = fakeApi(payload('prefill'));
  const r = await executeRun(f.api, 'run-prefill', { log: () => {} });
  expect(r.outcome).toBe('prefilled');
  expect(r.fields_filled.length).toBeGreaterThan(8);
  // Consent is only given for an approved submission.
  expect(r.fields_filled.find((x) => /privacy/i.test(x.field))).toBeUndefined();
  expect(await submissionCount(request)).toBe(before);
});

test('stops at a CAPTCHA and hands over to the manual queue', async ({ request }) => {
  const before = await submissionCount(request);
  const f = fakeApi(payload('submit', `${DEMO}?captcha=1`));
  const r = await executeRun(f.api, 'run-captcha', { log: () => {} });
  expect(r.outcome).toBe('manual_required');
  expect(r.captcha_detected).toBe(true);
  expect(r.fields_filled).toHaveLength(0);
  expect(await submissionCount(request)).toBe(before);
});

test('refuses hosts that are not allow-listed', async () => {
  const f = fakeApi(payload('submit', DEMO, ['jobs.example.com']));
  const r = await executeRun(f.api, 'run-host', { log: () => {} });
  expect(r.outcome).toBe('manual_required');
  expect(r.error).toMatch(/allow-list/);
});
