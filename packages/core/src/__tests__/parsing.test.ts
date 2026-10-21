import { describe, expect, it } from 'vitest';
import {
  assessPhEligibility,
  extractOjtHours,
  extractRequiredYears,
  inferEmploymentType,
  inferExperienceLevel,
  inferWorkArrangement,
  matchPreferredLocation,
} from '../classify.js';
import { formatSalary, parseSalary, toHourlyUsd } from '../salary.js';
import { compareSkills, extractSkillsFromText, normalizeSkill } from '../skills.js';
import { decodeEntities, extractRequirements, stripHtml, toIsoDate } from '../text.js';

describe('text', () => {
  it('strips HTML into readable lines with bullets', () => {
    const out = stripHtml('<h2>Requirements</h2><ul><li>React &amp; TypeScript</li><li>Git</li></ul><p>Apply&nbsp;now</p>');
    expect(out).toBe('Requirements\n- React & TypeScript\n- Git\nApply now');
  });
  it('decodes entity-encoded HTML (Greenhouse)', () => {
    expect(stripHtml('&lt;p&gt;Hello &amp;amp; welcome&lt;/p&gt;')).toBe('Hello & welcome');
    expect(decodeEntities('&#8217;&#x2014;')).toBe('’—');
  });
  it('extracts requirement bullets from a section', () => {
    const reqs = extractRequirements('About us\nWe build things.\nRequirements:\n- 1 year React\n- Good English\nBenefits\n- HMO');
    expect(reqs).toEqual(['1 year React', 'Good English']);
  });
  it('parses unix seconds, ms and ISO dates', () => {
    expect(toIsoDate(1700000000)).toBe('2023-11-14T22:13:20.000Z');
    expect(toIsoDate(1700000000000)).toBe('2023-11-14T22:13:20.000Z');
    expect(toIsoDate('not a date')).toBeNull();
  });
});

describe('salary', () => {
  it('parses ranges, currencies and periods', () => {
    expect(parseSalary('$60k - $80k / year')).toEqual({ min: 60000, max: 80000, currency: 'USD', period: 'year' });
    expect(parseSalary('₱25,000 per month')).toEqual({ min: 25000, max: 25000, currency: 'PHP', period: 'month' });
    expect(parseSalary('USD 6-8 per hour')).toMatchObject({ min: 6, max: 8, period: 'hour' });
    expect(parseSalary('Competitive')).toEqual({ min: null, max: null, currency: null, period: null });
  });
  it('infers period from magnitude when not stated', () => {
    expect(parseSalary('$1,200').period).toBe('month');
    expect(parseSalary('$45000').period).toBe('year');
  });
  it('converts to hourly USD', () => {
    expect(toHourlyUsd(2080 * 5, 'USD', 'year')).toBeCloseTo(5);
    expect(toHourlyUsd(58 * 10, 'PHP', 'hour', 58)).toBeCloseTo(10);
    expect(toHourlyUsd(100, null, 'hour')).toBeNull();
  });
  it('formats salaries', () => {
    expect(formatSalary({ salary_min: 5, salary_max: 8, salary_currency: 'USD', salary_period: 'hour' })).toBe('USD 5–8 / hour');
    expect(formatSalary({ salary_min: null, salary_max: null, salary_currency: null, salary_period: null })).toBe('Not disclosed');
  });
});

describe('skills', () => {
  it('normalizes aliases', () => {
    expect(normalizeSkill('ReactJS')).toBe('react');
    expect(normalizeSkill('Node')).toBe('node.js');
    expect(normalizeSkill('Postgres')).toBe('postgresql');
  });
  it('extracts skills without ambiguous false positives', () => {
    const skills = extractSkillsFromText('We use React, TypeScript, Node.js and PostgreSQL. Go to our site. We value swift onboarding.');
    expect(skills).toEqual(expect.arrayContaining(['react', 'typescript', 'node.js', 'postgresql']));
    expect(skills).not.toContain('go');
    expect(skills).not.toContain('swift');
    expect(extractSkillsFromText('Experience with C# and .NET Core')).toEqual(expect.arrayContaining(['c#', '.net']));
  });
  it('compares candidate and job skills', () => {
    const r = compareSkills(['React', 'JS', 'Git'], ['react', 'javascript', 'docker']);
    expect(r.matched).toEqual(['react', 'javascript']);
    expect(r.missing).toEqual(['docker']);
    expect(r.ratio).toBeCloseTo(2 / 3);
  });
});

describe('classification', () => {
  it('detects arrangement, employment type and level', () => {
    expect(inferWorkArrangement('Frontend Developer (Hybrid)')).toBe('hybrid');
    expect(inferWorkArrangement('Fully remote role')).toBe('remote');
    expect(inferWorkArrangement('Work onsite in Makati')).toBe('onsite');
    expect(inferEmploymentType('Software Developer Intern')).toBe('internship');
    expect(inferEmploymentType('Part-time React developer')).toBe('part_time');
    expect(inferExperienceLevel('Senior Backend Engineer')).toBe('senior');
    expect(inferExperienceLevel('Developer', 'Requires 5+ years of professional experience')).toBe('senior');
    expect(inferExperienceLevel('Jr. Web Developer')).toBe('junior');
  });
  it('extracts required years and OJT hours', () => {
    expect(extractRequiredYears('At least 2 years of experience with React; 3+ years of JavaScript experience')).toBe(3);
    expect(extractRequiredYears('No experience needed')).toBeNull();
    expect(extractOjtHours('OJT program: interns must render 600 hours')).toBe(600);
    expect(extractOjtHours('We have 24 hours support')).toBeNull();
  });
  it('assesses Philippine eligibility without assuming', () => {
    expect(assessPhEligibility('Worldwide')).toBe('eligible');
    expect(assessPhEligibility('APAC, EMEA')).toBe('eligible');
    expect(assessPhEligibility('USA Only')).toBe('ineligible');
    expect(assessPhEligibility('United States, Canada')).toBe('ineligible');
    expect(assessPhEligibility(null, 'Great remote team culture')).toBe('unknown');
    expect(assessPhEligibility(null, 'Candidates must reside in the United States')).toBe('ineligible');
  });
  it('matches preferred Metro Manila locations including districts', () => {
    const prefs = ['Makati', 'Pasig', 'Quezon City'];
    expect(matchPreferredLocation('Ortigas Center, Pasig City', prefs)).toBe('match');
    expect(matchPreferredLocation('Eastwood, QC', prefs)).toBe('match');
    expect(matchPreferredLocation('BGC, Taguig', prefs)).toBe('mismatch');
    expect(matchPreferredLocation('Metro Manila', prefs)).toBe('ambiguous');
    expect(matchPreferredLocation('', prefs)).toBe('unknown');
  });
});
