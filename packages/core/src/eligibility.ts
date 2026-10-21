import { extractOjtHours, extractRequiredYears, matchPreferredLocation } from './classify.js';
import { isExpired, normalizeCompany, postingAgeDays } from './dedupe.js';
import { toHourlyUsd } from './salary.js';
import type { NormalizedJob } from './schemas/job.js';
import type { JobPreference } from './schemas/preferences.js';
import { normalizeText } from './text.js';

export type CheckOutcome = 'pass' | 'fail' | 'unknown' | 'skipped';

export interface EligibilityCheck {
  rule: string;
  outcome: CheckOutcome;
  /** Mandatory checks fail the job; advisory ones only warn. */
  mandatory: boolean;
  detail: string;
}

export interface EligibilityResult {
  passed: boolean;
  checks: EligibilityCheck[];
  failures: string[];
  warnings: string[];
}

type JobForEligibility = Pick<
  NormalizedJob,
  | 'title'
  | 'company'
  | 'location'
  | 'description'
  | 'work_arrangement'
  | 'employment_type'
  | 'experience_level'
  | 'salary_min'
  | 'salary_max'
  | 'salary_currency'
  | 'salary_period'
  | 'ph_eligibility'
  | 'posted_at'
  | 'expires_at'
>;

const ROLE_STOPWORDS = new Set(['developer', 'engineer', 'intern', 'software', 'the', 'and', 'or', 'of', 'a', 'app', 'junior', 'part', 'time', 'freelance']);

/** True when the title shares the role's distinctive words (e.g. "frontend") or the generic developer/engineer stem. */
export function titleMatchesRoles(title: string, roles: string[], keywords: string[] = []): boolean {
  if (!roles.length && !keywords.length) return true;
  const t = ` ${normalizeText(title).replace(/front end/g, 'frontend').replace(/back end/g, 'backend').replace(/full stack/g, 'fullstack').replace(/full-stack/g, 'fullstack')} `;
  const isDevRole = /\b(developer|engineer|programmer|dev|swe)\b/.test(t);
  for (const role of roles) {
    const words = normalizeText(role)
      .replace(/front end/g, 'frontend')
      .replace(/back end/g, 'backend')
      .replace(/full stack/g, 'fullstack')
      .split(' ')
      .filter((w) => w && !ROLE_STOPWORDS.has(w));
    if (isDevRole && (words.length === 0 || words.some((w) => t.includes(` ${w} `) || t.includes(` ${w}/`)))) return true;
  }
  if (!isDevRole) return false;
  // Generic "Software Developer" style titles satisfy generic developer roles.
  return roles.some((r) => /software|developer|engineer/i.test(r)) && /\b(software|web|application|app|mobile|developer|engineer)\b/.test(t);
}

/**
 * Discovery-time filter: a job is worth storing only if at least one active search profile could
 * accept it — matching title, no excluded title keyword (e.g. "senior"), and an allowed experience
 * level. Unknown levels pass here; the full eligibility check judges them when scoring.
 */
export function fitsSearchProfile(
  job: Pick<NormalizedJob, 'title' | 'experience_level'>,
  prefs: Array<Pick<JobPreference, 'roles' | 'keywords' | 'excluded_keywords' | 'experience_levels'>>,
): boolean {
  if (!prefs.length) return true;
  const title = ` ${normalizeText(job.title)} `;
  return prefs.some(
    (p) =>
      titleMatchesRoles(job.title, p.roles, p.keywords) &&
      !p.excluded_keywords.some((k) => title.includes(` ${normalizeText(k)} `)) &&
      (p.experience_levels.length === 0 || job.experience_level === 'unknown' || p.experience_levels.includes(job.experience_level)),
  );
}

/**
 * Deterministic, explainable eligibility rules. These are evaluated before any AI call.
 * Unknown information is never assumed to satisfy a requirement — it becomes a warning
 * (or a failure for rules the user marked mandatory, such as Philippine eligibility).
 */
export function evaluateEligibility(job: JobForEligibility, pref: JobPreference, now = new Date()): EligibilityResult {
  const checks: EligibilityCheck[] = [];
  const add = (rule: string, outcome: CheckOutcome, mandatory: boolean, detail: string) =>
    checks.push({ rule, outcome, mandatory, detail });
  const fullText = `${job.title}\n${job.description}`;

  // 1. Excluded companies
  const company = normalizeCompany(job.company);
  const excluded = pref.excluded_companies.find((c) => normalizeCompany(c) === company);
  add('excluded_company', excluded ? 'fail' : 'pass', true, excluded ? `${job.company} is on your excluded list.` : 'Company is not excluded.');

  // 2. Excluded keywords (title only — descriptions often mention "senior engineers" as teammates)
  const titleNorm = ` ${normalizeText(job.title)} `;
  const badKeyword = pref.excluded_keywords.find((k) => titleNorm.includes(` ${normalizeText(k)} `));
  add('excluded_keyword', badKeyword ? 'fail' : 'pass', true, badKeyword ? `Title contains excluded keyword "${badKeyword}".` : 'No excluded keywords in title.');

  // 3. Role relevance
  const roleOk = titleMatchesRoles(job.title, pref.roles, pref.keywords);
  add('role', roleOk ? 'pass' : 'fail', true, roleOk ? 'Title matches a target role.' : `"${job.title}" does not match any target role.`);

  // 4. Expired
  add('expired', isExpired(job, now) ? 'fail' : 'pass', true, isExpired(job, now) ? 'Listing appears expired.' : 'Listing is active.');

  // 5. Work arrangement
  if (pref.work_arrangements.length) {
    if (job.work_arrangement === 'unknown') {
      add('work_arrangement', 'unknown', false, 'Work arrangement is not stated.');
    } else {
      const ok = pref.work_arrangements.includes(job.work_arrangement);
      add('work_arrangement', ok ? 'pass' : 'fail', true, ok ? `Arrangement "${job.work_arrangement}" matches.` : `Arrangement "${job.work_arrangement}" is not in your preferences (${pref.work_arrangements.join(', ')}).`);
    }
  }

  // 6. Physical location (only meaningful for onsite / hybrid roles)
  const needsLocation = job.work_arrangement === 'onsite' || job.work_arrangement === 'hybrid' || (job.work_arrangement === 'unknown' && pref.work_arrangements.includes('onsite'));
  if (needsLocation && pref.locations.length && !pref.work_arrangements.every((w) => w === 'remote')) {
    const m = matchPreferredLocation(job.location, pref.locations);
    if (m === 'match') add('location', 'pass', true, `${job.location} is in your preferred locations.`);
    else if (m === 'mismatch') add('location', 'fail', true, `${job.location || 'Location'} is outside ${pref.locations.join(', ')}.`);
    else add('location', 'unknown', false, m === 'ambiguous' ? `"${job.location}" is ambiguous — confirm it is in ${pref.locations.join(', ')}.` : 'Job location is not stated.');
  }

  // 7. Philippine applicant eligibility (remote roles)
  if (pref.require_ph_eligible && job.work_arrangement !== 'onsite') {
    if (job.ph_eligibility === 'eligible') add('ph_eligibility', 'pass', true, 'Accepts applicants from the Philippines.');
    else if (job.ph_eligibility === 'ineligible') add('ph_eligibility', 'fail', true, 'Restricted to regions that exclude the Philippines.');
    else add('ph_eligibility', 'unknown', false, 'Not stated whether Philippine applicants are accepted — verify before applying.');
  }

  // 8. Employment type
  if (pref.employment_types.length) {
    if (job.employment_type === 'unknown') add('employment_type', 'unknown', false, 'Employment type is not stated.');
    else {
      const ok = pref.employment_types.includes(job.employment_type);
      add('employment_type', ok ? 'pass' : 'fail', true, ok ? `Employment type "${job.employment_type}" matches.` : `Employment type "${job.employment_type}" is not in your preferences.`);
    }
  }

  // 9. Experience level / years
  if (pref.experience_levels.length) {
    const years = extractRequiredYears(fullText);
    const maxYears = pref.experience_levels.includes('mid') ? 4 : pref.experience_levels.includes('junior') ? 2 : 1;
    if (job.experience_level === 'senior' || (job.experience_level === 'mid' && !pref.experience_levels.includes('mid'))) {
      add('experience', 'fail', true, `Role is ${job.experience_level}-level.`);
    } else if (years !== null && years > maxYears) {
      add('experience', 'fail', true, `Requires ${years}+ years of experience (your profile allows up to ${maxYears}).`);
    } else if (job.experience_level === 'unknown' && years === null) {
      add('experience', 'unknown', false, 'Experience requirement is not stated.');
    } else {
      add('experience', 'pass', true, years !== null ? `Requires ${years} year(s) — within range.` : `Level "${job.experience_level}" fits.`);
    }
  }

  // 10. Salary floor
  if (pref.min_salary_amount !== null && pref.min_salary_amount > 0) {
    const floorHourly = toHourlyUsd(pref.min_salary_amount, pref.salary_currency ?? 'USD', pref.salary_period ?? 'hour', pref.php_per_usd);
    const offered = job.salary_max ?? job.salary_min;
    const offeredHourly = offered !== null ? toHourlyUsd(offered, job.salary_currency, job.salary_period, pref.php_per_usd) : null;
    if (offeredHourly === null || floorHourly === null) {
      add('salary', 'unknown', false, 'Salary not disclosed (or currency unknown) — not assumed to meet your minimum.');
    } else if (offeredHourly >= floorHourly) {
      add('salary', 'pass', true, `Pays about $${offeredHourly.toFixed(2)}/hr (minimum $${floorHourly.toFixed(2)}/hr).`);
    } else {
      add('salary', 'fail', true, `Pays about $${offeredHourly.toFixed(2)}/hr, below your $${floorHourly.toFixed(2)}/hr minimum.`);
    }
  }

  // 11. OJT hours capacity (internships)
  if (pref.required_ojt_hours) {
    const offered = extractOjtHours(fullText);
    if (offered === null) add('ojt_hours', 'unknown', false, `OJT hour capacity not stated — confirm the company can accommodate ${pref.required_ojt_hours} hours.`);
    else if (offered >= pref.required_ojt_hours) add('ojt_hours', 'pass', true, `Offers ${offered} hours (you need ${pref.required_ojt_hours}).`);
    else add('ojt_hours', 'fail', true, `Offers ${offered} hours, but you need ${pref.required_ojt_hours}.`);
  }

  // 12. Freshness (advisory)
  const age = postingAgeDays(job.posted_at, now);
  if (age === null) add('freshness', 'unknown', false, 'Posting date unknown.');
  else if (age <= pref.max_posting_age_days) add('freshness', 'pass', false, `Posted ${Math.floor(age)} day(s) ago.`);
  else add('freshness', 'fail', false, `Posted ${Math.floor(age)} days ago (preference: last ${pref.max_posting_age_days} days).`);

  const failures = checks.filter((c) => c.mandatory && c.outcome === 'fail').map((c) => c.detail);
  const warnings = checks.filter((c) => c.outcome === 'unknown' || (!c.mandatory && c.outcome === 'fail')).map((c) => c.detail);
  return { passed: failures.length === 0, checks, failures, warnings };
}
