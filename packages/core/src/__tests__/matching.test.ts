import { describe, expect, it } from 'vitest';
import { INELIGIBLE_SCORE_CAP } from '../constants.js';
import { dedupeJobs, isExpired, jobFingerprint } from '../dedupe.js';
import { evaluateEligibility, fitsSearchProfile, titleMatchesRoles } from '../eligibility.js';
import type { AiMatchOutput } from '../prompts/schemas.js';
import { computeMatch } from '../scoring.js';
import { normalizedJobSchema, type NormalizedJob } from '../schemas/job.js';
import { DEFAULT_PREFERENCES, jobPreferenceSchema } from '../schemas/preferences.js';

const now = new Date('2026-10-20T00:00:00Z');
const internship = jobPreferenceSchema.parse(DEFAULT_PREFERENCES[0]);
const remote = jobPreferenceSchema.parse(DEFAULT_PREFERENCES[1]);

function job(over: Partial<NormalizedJob> = {}): NormalizedJob {
  return normalizedJobSchema.parse({
    source_key: 'test',
    external_id: '1',
    title: 'Frontend Developer',
    company: 'Acme',
    apply_url: 'https://example.com/job/1',
    posted_at: '2026-10-19T00:00:00Z',
    ...over,
  });
}

describe('titleMatchesRoles', () => {
  it('accepts developer titles that share a role keyword', () => {
    expect(titleMatchesRoles('Front-End Developer Intern', internship.roles)).toBe(true);
    expect(titleMatchesRoles('Web Developer Intern', internship.roles)).toBe(true);
    expect(titleMatchesRoles('Marketing Intern', internship.roles)).toBe(false);
    expect(titleMatchesRoles('Full Stack Engineer', remote.roles)).toBe(true);
  });
});

describe('evaluateEligibility — internship profile', () => {
  const base = { work_arrangement: 'onsite' as const, employment_type: 'internship' as const, experience_level: 'internship' as const };
  it('passes an onsite Pasig internship and warns about unknown OJT hours', () => {
    const r = evaluateEligibility(job({ ...base, title: 'Software Developer Intern', location: 'Ortigas, Pasig City' }), internship, now);
    expect(r.passed).toBe(true);
    expect(r.warnings.some((w) => w.includes('OJT hour capacity not stated'))).toBe(true);
  });
  it('fails a location outside the preferred cities', () => {
    const r = evaluateEligibility(job({ ...base, title: 'Backend Developer Intern', location: 'Cebu City' }), internship, now);
    expect(r.passed).toBe(false);
    expect(r.failures.join(' ')).toContain('outside');
  });
  it('fails when the internship offers fewer hours than required', () => {
    const r = evaluateEligibility(
      job({ ...base, title: 'Frontend Developer Intern', location: 'Makati', description: 'OJT for students needing 300 hours only.' }),
      internship,
      now,
    );
    expect(r.failures.join(' ')).toContain('300 hours');
  });
});

describe('evaluateEligibility — remote profile', () => {
  const base = { work_arrangement: 'remote' as const, employment_type: 'full_time' as const, experience_level: 'junior' as const };
  it('does not assume unknown salary or PH eligibility satisfy requirements', () => {
    const r = evaluateEligibility(job({ ...base, title: 'Junior Frontend Developer' }), remote, now);
    expect(r.passed).toBe(true);
    expect(r.warnings.join(' ')).toMatch(/Salary not disclosed/);
    expect(r.warnings.join(' ')).toMatch(/Philippine applicants/);
    expect(r.checks.find((c) => c.rule === 'salary')?.outcome).toBe('unknown');
  });
  it('fails salary below $5/hr and US-only roles', () => {
    const low = evaluateEligibility(job({ ...base, salary_min: 3, salary_max: 4, salary_currency: 'USD', salary_period: 'hour', ph_eligibility: 'eligible' }), remote, now);
    expect(low.passed).toBe(false);
    const us = evaluateEligibility(job({ ...base, ph_eligibility: 'ineligible' }), remote, now);
    expect(us.failures.join(' ')).toMatch(/exclude the Philippines/);
  });
  it('fails senior roles and too many years', () => {
    expect(evaluateEligibility(job({ ...base, title: 'Senior Frontend Developer', experience_level: 'senior' }), remote, now).passed).toBe(false);
    const years = evaluateEligibility(job({ ...base, description: 'Requires 5+ years of experience with React.' }), remote, now);
    expect(years.failures.join(' ')).toMatch(/5\+ years/);
    // Mid level is allowed now: 4 years is within range.
    expect(evaluateEligibility(job({ ...base, ph_eligibility: 'eligible', description: 'Requires 4+ years of experience with React.' }), remote, now).checks.find((c) => c.rule === 'experience')?.outcome).toBe('pass');
  });
  it('treats stale postings as an advisory warning only', () => {
    const r = evaluateEligibility(job({ ...base, ph_eligibility: 'eligible', posted_at: '2026-10-10T00:00:00Z' }), remote, now);
    expect(r.passed).toBe(true);
    expect(r.warnings.join(' ')).toMatch(/Posted 10 days ago/);
  });
});

describe('computeMatch', () => {
  const ai: AiMatchOutput = {
    criteria: {
      technical_skills: { score: 90, reason: 'Strong React' },
      experience: { score: 80, reason: 'Projects count' },
      education: { score: 85, reason: 'CS student' },
      projects: { score: 90, reason: 'Relevant' },
      responsibilities: { score: 80, reason: 'OK' },
      qualifications: { score: 75, reason: 'Most met' },
    },
    matched_skills: ['React', 'Kubernetes'],
    missing_skills: ['Docker'],
    missing_qualifications: [],
    relevant_projects: [],
    eligibility_concerns: [],
    explanation: 'Good fit.',
    resume_suggestions: ['Mention testing'],
    recommendation: 'apply',
  };
  const remoteJob = job({ work_arrangement: 'remote', employment_type: 'full_time', experience_level: 'junior', ph_eligibility: 'eligible', description: 'React, TypeScript and Docker', salary_min: 8, salary_max: 10, salary_currency: 'USD', salary_period: 'hour' });

  it('discards AI-claimed skills that are not on the verified resume', () => {
    const eligibility = evaluateEligibility(remoteJob, remote, now);
    const m = computeMatch({ job: remoteJob, candidateSkills: ['react', 'typescript'], eligibility, ai, minScore: 70 });
    expect(m.matched_skills).toEqual(['react', 'typescript']);
    expect(m.matched_skills).not.toContain('kubernetes');
    expect(m.missing_skills).toContain('docker');
    expect(m.score).toBeGreaterThan(70);
    expect(m.recommendation).toBe('apply');
  });
  it('caps the score when a mandatory rule fails', () => {
    const bad = { ...remoteJob, ph_eligibility: 'ineligible' as const };
    const eligibility = evaluateEligibility(bad, remote, now);
    const m = computeMatch({ job: bad, candidateSkills: ['react', 'typescript', 'docker'], eligibility, ai, minScore: 70 });
    expect(m.score).toBeLessThanOrEqual(INELIGIBLE_SCORE_CAP);
    expect(m.recommendation).toBe('skip');
  });
  it('works without AI (deterministic fallback)', () => {
    const eligibility = evaluateEligibility(remoteJob, remote, now);
    const m = computeMatch({ job: remoteJob, candidateSkills: ['react', 'typescript'], eligibility, ai: null, minScore: 70 });
    expect(m.ai_score).toBeNull();
    expect(m.breakdown.projects.source).toBe('deterministic');
    expect(m.score).toBe(m.deterministic_score);
  });
});

describe('dedupe', () => {
  it('removes exact and cross-source duplicates, keeping the richest listing', () => {
    const a = job({ source_key: 'remotive', external_id: '1', title: 'Frontend Developer (Remote)', company: 'Acme Inc.', location: 'Worldwide' });
    const b = job({ source_key: 'jobicy', external_id: '9', title: 'Frontend Developer', company: 'ACME', location: 'Anywhere', description: 'x'.repeat(500) });
    const c = job({ source_key: 'remotive', external_id: '1' });
    expect(jobFingerprint(a)).toBe(jobFingerprint(b));
    const r = dedupeJobs([a, b, c]);
    expect(r.unique).toHaveLength(1);
    expect(r.unique[0]!.source_key).toBe('jobicy');
    expect(r.duplicates).toHaveLength(2);
  });
  it('detects expiry', () => {
    expect(isExpired({ posted_at: null, expires_at: '2026-10-01T00:00:00Z' }, now)).toBe(true);
    expect(isExpired({ posted_at: '2026-08-01T00:00:00Z', expires_at: null }, now)).toBe(true);
    expect(isExpired({ posted_at: '2026-10-18T00:00:00Z', expires_at: null }, now)).toBe(false);
  });
});

describe('fitsSearchProfile (discovery filter)', () => {
  it('keeps junior and mid roles, drops senior titles and senior levels', () => {
    const prefs = [remote];
    expect(fitsSearchProfile({ title: 'Junior Frontend Developer', experience_level: 'junior' }, prefs)).toBe(true);
    expect(fitsSearchProfile({ title: 'Full Stack Developer', experience_level: 'mid' }, prefs)).toBe(true);
    expect(fitsSearchProfile({ title: 'Backend Engineer', experience_level: 'unknown' }, prefs)).toBe(true);
    expect(fitsSearchProfile({ title: 'Senior Frontend Developer', experience_level: 'senior' }, prefs)).toBe(false);
    expect(fitsSearchProfile({ title: 'Lead Backend Developer', experience_level: 'unknown' }, prefs)).toBe(false);
    expect(fitsSearchProfile({ title: 'Frontend Developer', experience_level: 'senior' }, prefs)).toBe(false);
    expect(fitsSearchProfile({ title: 'Marketing Manager', experience_level: 'unknown' }, prefs)).toBe(false);
  });
  it('accepts a job if any profile fits (internship profile keeps intern roles)', () => {
    expect(fitsSearchProfile({ title: 'Software Developer Intern', experience_level: 'internship' }, [internship, remote])).toBe(true);
  });
});
