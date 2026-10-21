import { assessPhEligibility, inferEmploymentType, inferExperienceLevel, inferWorkArrangement } from '../classify.js';
import type { EmploymentType, SalaryPeriod, WorkArrangement } from '../constants.js';
import { jobFingerprint } from '../dedupe.js';
import { parseSalary } from '../salary.js';
import { normalizedJobSchema, type NormalizedJob } from '../schemas/job.js';
import type { JobPreference } from '../schemas/preferences.js';
import { collapseWhitespace, extractRequirements, stripHtml, toIsoDate, truncate, uniqStrings } from '../text.js';
import type { NormalizeResult } from './types.js';

export interface RawJob {
  source_key: string;
  external_id: string | number | null | undefined;
  title: string | null | undefined;
  company: string | null | undefined;
  company_url?: string | null;
  location?: string | null;
  candidate_locations?: string | null;
  description_html?: string | null;
  description_text?: string | null;
  apply_url: string | null | undefined;
  posted_at?: unknown;
  expires_at?: unknown;
  tags?: Array<string | null | undefined>;
  remote_flag?: boolean | null;
  arrangement_hint?: string | null;
  employment_hint?: string | null;
  level_hint?: string | null;
  salary_text?: string | null;
  salary_min?: number | null;
  salary_max?: number | null;
  salary_currency?: string | null;
  salary_period?: SalaryPeriod | null;
}

const ARRANGEMENT_HINTS: Record<string, WorkArrangement> = {
  remote: 'remote',
  telecommute: 'remote',
  hybrid: 'hybrid',
  onsite: 'onsite',
  'on-site': 'onsite',
  on_site: 'onsite',
  office: 'onsite',
  inperson: 'onsite',
};

const EMPLOYMENT_HINTS: Record<string, EmploymentType> = {
  full_time: 'full_time',
  fulltime: 'full_time',
  'full-time': 'full_time',
  'full time': 'full_time',
  part_time: 'part_time',
  parttime: 'part_time',
  'part-time': 'part_time',
  'part time': 'part_time',
  contract: 'contract',
  contractor: 'contract',
  temporary: 'contract',
  freelance: 'freelance',
  internship: 'internship',
  intern: 'internship',
};

/** Turns an adapter's raw fields into a validated NormalizedJob (or a rejection reason). */
export function finalizeJob(raw: RawJob): { job: NormalizedJob } | { error: string } {
  const title = collapseWhitespace(raw.title ?? '');
  const company = collapseWhitespace(raw.company ?? '');
  const external = raw.external_id === null || raw.external_id === undefined ? '' : String(raw.external_id);
  if (!title || !company || !external || !raw.apply_url) return { error: 'missing title/company/id/url' };

  const description = truncate(raw.description_text ? raw.description_text.trim() : stripHtml(raw.description_html), 30000);
  const location = collapseWhitespace(raw.location ?? '');
  const hint = raw.arrangement_hint ? ARRANGEMENT_HINTS[raw.arrangement_hint.toLowerCase().replace(/\s+/g, '')] : undefined;
  let arrangement: WorkArrangement = hint ?? (raw.remote_flag === true ? 'remote' : inferWorkArrangement(title, location, description.slice(0, 1500)));
  if (arrangement === 'remote' && /\bhybrid\b/i.test(`${title} ${location}`)) arrangement = 'hybrid';

  const employmentHint = raw.employment_hint ? EMPLOYMENT_HINTS[raw.employment_hint.toLowerCase().trim()] : undefined;
  const employment = employmentHint ?? inferEmploymentType(title, raw.employment_hint, description.slice(0, 2000));

  let salary = {
    min: raw.salary_min ?? null,
    max: raw.salary_max ?? null,
    currency: raw.salary_currency ?? null,
    period: raw.salary_period ?? null,
  };
  if (salary.min === null && salary.max === null && raw.salary_text) salary = parseSalary(raw.salary_text);

  const candidate_locations = raw.candidate_locations ? collapseWhitespace(raw.candidate_locations) : null;
  const ph = arrangement === 'onsite' && /philippines|manila|makati|pasig|quezon|taguig|cebu/i.test(location)
    ? 'eligible'
    : assessPhEligibility(candidate_locations ?? (arrangement === 'remote' ? null : location), description);

  const candidate = {
    source_key: raw.source_key,
    external_id: external.slice(0, 300),
    title: title.slice(0, 300),
    company: company.slice(0, 200),
    company_url: raw.company_url || null,
    location: location.slice(0, 300),
    work_arrangement: arrangement,
    employment_type: employment,
    experience_level: inferExperienceLevel(title, description),
    salary_min: salary.min,
    salary_max: salary.max,
    salary_currency: salary.currency,
    salary_period: salary.period,
    salary_text: raw.salary_text ? raw.salary_text.slice(0, 300) : null,
    candidate_locations: candidate_locations?.slice(0, 500) ?? null,
    ph_eligibility: ph,
    description,
    requirements: extractRequirements(description),
    tags: uniqStrings((raw.tags ?? []).filter((t): t is string => Boolean(t)).map((t) => t.slice(0, 80))).slice(0, 40),
    apply_url: raw.apply_url,
    posted_at: toIsoDate(raw.posted_at),
    expires_at: toIsoDate(raw.expires_at),
  };
  const parsed = normalizedJobSchema.safeParse(candidate);
  if (!parsed.success) return { error: parsed.error.issues.map((i) => `${i.path.join('.')}: ${i.message}`).join('; ') };
  return { job: { ...parsed.data, fingerprint: jobFingerprint(parsed.data) } };
}

export function finalizeAll(raws: RawJob[]): NormalizeResult {
  const jobs: NormalizedJob[] = [];
  const rejected: NormalizeResult['rejected'] = [];
  for (const raw of raws) {
    const r = finalizeJob(raw);
    if ('job' in r) jobs.push(r.job);
    else rejected.push({ external_id: String(raw.external_id ?? '?'), reason: r.error });
  }
  return { jobs, rejected };
}

/** Distinct search terms derived from all active preferences, e.g. "frontend developer". */
export function searchTermsFor(preferences: JobPreference[], max = 4): string[] {
  const terms = new Set<string>();
  for (const p of preferences.filter((x) => x.is_active)) {
    for (const r of p.roles) {
      const t = r
        .toLowerCase()
        .replace(/\b(intern|junior|part-time|freelance|entry level)\b/g, '')
        .replace(/\s+/g, ' ')
        .trim();
      if (t) terms.add(t);
    }
  }
  const list = [...terms];
  // Prefer broad terms first so a small request budget still covers most roles.
  list.sort((a, b) => a.length - b.length);
  return list.slice(0, max);
}

export function asArray(body: unknown, key?: string): unknown[] {
  if (Array.isArray(body)) return body;
  if (key && body && typeof body === 'object' && Array.isArray((body as Record<string, unknown>)[key])) {
    return (body as Record<string, unknown[]>)[key]!;
  }
  return [];
}

export type Obj = Record<string, unknown>;
export const str = (v: unknown): string | null => (typeof v === 'string' ? v : typeof v === 'number' ? String(v) : null);
export const num = (v: unknown): number | null => {
  const n = typeof v === 'number' ? v : typeof v === 'string' && v.trim() !== '' ? Number(v) : NaN;
  return Number.isFinite(n) ? n : null;
};
