import { describe, expect, it } from 'vitest';
import { renderResumePdf } from '../pdf/index.js';
import { DEFAULT_PREFERENCES, jobPreferenceSchema } from '../schemas/preferences.js';
import { resumeDataSchema } from '../schemas/resume.js';
import { ashby, greenhouse, himalayas, lever, remotive } from '../sources/adapters.js';
import { parseJobAlertEmail } from '../sources/gmail-alerts.js';
import { planDiscovery } from '../sources/index.js';
import { extractJobPostings, jobPostingToNormalized } from '../sources/jsonld.js';

const prefs = DEFAULT_PREFERENCES.map((p) => jobPreferenceSchema.parse(p));

describe('source adapters', () => {
  it('normalizes Remotive', () => {
    const r = remotive.normalize(
      {
        jobs: [
          {
            id: 123,
            url: 'https://remotive.com/remote-jobs/software-dev/junior-react-123',
            title: 'Junior React Developer',
            company_name: 'Acme',
            category: 'Software Development',
            tags: ['react', 'typescript'],
            job_type: 'full_time',
            publication_date: '2026-10-19T10:00:00',
            candidate_required_location: 'Worldwide',
            salary: '$1,500 - $2,000 per month',
            description: '<p>Build UIs.</p><h3>Requirements</h3><ul><li>React</li></ul>',
          },
          { id: 124, title: '', company_name: 'X', url: 'https://x.y' },
        ],
      },
      { source_key: 'remotive', meta: {} },
    );
    expect(r.rejected).toHaveLength(1);
    const j = r.jobs[0]!;
    expect(j).toMatchObject({ external_id: '123', work_arrangement: 'remote', employment_type: 'full_time', experience_level: 'junior', ph_eligibility: 'eligible', salary_currency: 'USD', salary_period: 'month', salary_min: 1500 });
    expect(j.posted_at).toBe('2026-10-19T10:00:00.000Z');
    expect(j.requirements).toEqual(['React']);
    expect(j.fingerprint).toMatch(/^[0-9a-f]{16}$/);
  });

  it('normalizes Greenhouse entity-encoded content', () => {
    const r = greenhouse.normalize(
      { jobs: [{ id: 9, title: 'Software Engineer Intern', location: { name: 'Makati City, Philippines' }, absolute_url: 'https://boards.greenhouse.io/acme/jobs/9', updated_at: '2026-10-18T00:00:00Z', content: '&lt;p&gt;Onsite internship&lt;/p&gt;' }] },
      { source_key: 'greenhouse', meta: { board: 'acme' } },
    );
    expect(r.jobs[0]).toMatchObject({ external_id: 'acme:9', company: 'acme', employment_type: 'internship', work_arrangement: 'onsite', ph_eligibility: 'eligible', description: 'Onsite internship' });
  });

  it('normalizes Lever, Ashby and Himalayas', () => {
    const l = lever.normalize(
      [{ id: 'abc', text: 'Backend Developer', categories: { commitment: 'Part-time', location: 'Remote' }, createdAt: 1792000000000, descriptionPlain: 'Node.js APIs', lists: [], hostedUrl: 'https://jobs.lever.co/acme/abc', workplaceType: 'remote', salaryRange: { min: 10, max: 15, currency: 'USD', interval: 'per-hour-wage' } }],
      { source_key: 'lever', meta: { company: 'acme' } },
    );
    expect(l.jobs[0]).toMatchObject({ employment_type: 'part_time', work_arrangement: 'remote', salary_period: 'hour', salary_max: 15 });

    const a = ashby.normalize(
      { jobs: [{ id: 'z', title: 'Full-stack Engineer', location: 'Manila', workplaceType: 'Hybrid', employmentType: 'FullTime', publishedAt: '2026-10-19T00:00:00Z', jobUrl: 'https://jobs.ashbyhq.com/acme/z', descriptionPlain: 'React + Go' }] },
      { source_key: 'ashby', meta: { org: 'acme' } },
    );
    expect(a.jobs[0]).toMatchObject({ work_arrangement: 'hybrid', employment_type: 'full_time' });

    const h = himalayas.normalize(
      { jobs: [{ title: 'Junior Developer', companyName: 'Remote Co', employmentType: 'Full Time', minSalary: 12000, maxSalary: 18000, salaryPeriod: 'annual', currency: 'USD', locationRestrictions: ['Philippines'], pubDate: 1792510075, guid: 'https://himalayas.app/x', applicationLink: 'https://himalayas.app/x/apply', description: '<p>hi</p>' }] },
      { source_key: 'himalayas', meta: {} },
    );
    expect(h.jobs[0]).toMatchObject({ ph_eligibility: 'eligible', salary_period: 'year', salary_max: 18000 });
  });

  it('plans requests respecting rate limits', () => {
    const now = new Date('2026-10-20T12:00:00Z');
    const plan = planDiscovery(
      [
        { key: 'remotive', kind: 'remotive', name: 'Remotive', config: {}, last_run_at: '2026-10-20T10:00:00Z' },
        { key: 'greenhouse', kind: 'greenhouse', name: 'GH', config: { boards: ['acme', 'globex'] }, last_run_at: null },
        { key: 'alerts', kind: 'gmail_alert', name: 'Alerts', config: {} },
      ],
      prefs,
      { now, force: true },
    );
    expect(plan[0]!.requests).toHaveLength(0);
    expect(plan[0]!.skipped).toMatch(/4 fetches\/day/);
    expect(plan[1]!.requests.map((r) => r.url)).toEqual([
      'https://boards-api.greenhouse.io/v1/boards/acme/jobs?content=true',
      'https://boards-api.greenhouse.io/v1/boards/globex/jobs?content=true',
    ]);
    expect(plan[2]!.skipped).toMatch(/No API adapter/);
  });
});

describe('JSON-LD career page import', () => {
  it('reads schema.org JobPosting', () => {
    const html = `<html><head><script type="application/ld+json">${JSON.stringify({
      '@context': 'https://schema.org',
      '@graph': [
        {
          '@type': 'JobPosting',
          title: 'Mobile Developer Intern',
          hiringOrganization: { '@type': 'Organization', name: 'Pasig Apps Inc.' },
          jobLocation: { '@type': 'Place', address: { addressLocality: 'Pasig', addressCountry: 'PH' } },
          datePosted: '2026-10-19',
          validThrough: '2026-12-01',
          employmentType: 'INTERN',
          description: '<p>Flutter internship, 600 hours OJT.</p>',
          baseSalary: { '@type': 'MonetaryAmount', currency: 'PHP', value: { minValue: 8000, maxValue: 10000, unitText: 'MONTH' } },
        },
      ],
    })}</script></head></html>`;
    const postings = extractJobPostings(html);
    expect(postings).toHaveLength(1);
    const r = jobPostingToNormalized(postings[0]!, 'https://careers.example.ph/jobs/1');
    expect('job' in r && r.job).toMatchObject({ company: 'Pasig Apps Inc.', employment_type: 'internship', location: 'Pasig, PH', salary_currency: 'PHP', salary_period: 'month', apply_url: 'https://careers.example.ph/jobs/1' });
  });
});

describe('Gmail job alerts', () => {
  it('extracts LinkedIn jobs from an alert email', () => {
    const jobs = parseJobAlertEmail({
      messageId: 'm1',
      from: 'LinkedIn Job Alerts <jobalerts-noreply@linkedin.com>',
      subject: '“frontend developer”: 2 new jobs',
      html: '<a href="https://www.linkedin.com/comm/jobs/view/4012345678/?trackingId=x">Frontend Developer</a><a href="https://www.linkedin.com/comm/jobs/view/4012345679/">React Developer Intern</a>',
      text: 'Frontend Developer\nAcme Corp · Makati (On-site)\n\nReact Developer Intern\nGlobex\nPasig',
      receivedAt: '2026-10-20T01:00:00Z',
    });
    expect(jobs).toHaveLength(2);
    expect(jobs[0]).toMatchObject({ source_key: 'gmail_alert:linkedin', external_id: 'linkedin:4012345678', title: 'Frontend Developer', company: 'Acme Corp', location: 'Makati (On-site)', apply_url: 'https://www.linkedin.com/jobs/view/4012345678/' });
    expect(jobs[1]).toMatchObject({ company: 'Globex', location: 'Pasig', employment_type: 'internship' });
  });
});

describe('PDF rendering', () => {
  it('renders an ATS-friendly resume PDF', () => {
    const bytes = renderResumePdf(resumeDataSchema.parse({ basics: { name: 'Juan Dela Cruz', email: 'j@x.com' }, skills: [{ name: 'React', category: 'framework' }] }));
    expect(new TextDecoder().decode(bytes.slice(0, 5))).toBe('%PDF-');
    expect(bytes.length).toBeGreaterThan(1000);
  });
});
