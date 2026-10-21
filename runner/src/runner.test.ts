import { resumeDataSchema } from '@applypilot/core';
import { describe, expect, it } from 'vitest';
import type { RunnerPayload } from './api.js';
import { RunnerApi } from './api.js';
import { matchAnswer } from './form-filler.js';
import { applicantFrom } from './run.js';

describe('matchAnswer', () => {
  const answers = [
    { question: 'Are you willing to work onsite in Makati?', answer: 'Yes' },
    { question: 'What is your expected salary?', answer: '[fill in]', needs_user_input: true },
  ];
  it('matches reworded questions by word overlap', () => {
    expect(matchAnswer('Willing to work onsite (Makati office)?', answers)).toBe('Yes');
  });
  it('never uses answers that still need user input', () => {
    expect(matchAnswer('Expected salary', answers)).toBeNull();
  });
  it('returns null for unrelated questions', () => {
    expect(matchAnswer('Do you have a driver license?', answers)).toBeNull();
  });
});

describe('applicantFrom', () => {
  const base: RunnerPayload = {
    run_id: 'r',
    action: 'prefill',
    application: { id: 'a', company: 'X', job_title: 'Y', apply_url: 'http://localhost', source_key: 'demo' },
    allowed_hosts: ['localhost'],
    applicant: { full_name: 'Maria Clara Santos', email: '', phone: '', location: '', linkedin_url: '', github_url: 'https://github.com/m', portfolio_url: '' },
    resume: resumeDataSchema.parse({ basics: { email: 'm@x.com', phone: '0917', location: 'Pasig' } }),
    cover_letter: '',
    screening_answers: [],
  };
  it('splits names, falls back to resume contact details, and only consents on submit', () => {
    const a = applicantFrom(base, '/tmp/r.pdf');
    expect(a).toMatchObject({ firstName: 'Maria', lastName: 'Clara Santos', email: 'm@x.com', location: 'Pasig', portfolio: 'https://github.com/m', acceptConsent: false });
    expect(applicantFrom({ ...base, action: 'submit' }, '/tmp/r.pdf').acceptConsent).toBe(true);
  });
});

describe('RunnerApi', () => {
  it('refuses to start without a strong token', () => {
    expect(() => new RunnerApi('http://x', 'short')).toThrow(/RUNNER_TOKEN/);
    expect(() => new RunnerApi('', 'x'.repeat(30))).toThrow(/API_URL/);
  });
});
