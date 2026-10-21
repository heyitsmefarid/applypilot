import type { AutomationMode } from './constants.js';
import { normalizeCompany } from './dedupe.js';
import { normalizeText } from './text.js';

/** Mirrors the `automation_rules` table. */
export interface AutomationRules {
  mode: AutomationMode;
  paused: boolean;
  auto_apply_enabled: boolean;
  auto_apply_opt_in_at: string | null;
  allowed_sources: string[];
  min_match_score: number;
  min_salary_hourly_usd: number | null;
  preferred_categories: string[];
  max_daily_submissions: number;
  excluded_companies: string[];
  require_document_approval: boolean;
  auto_prepare_min_score: number;
}

export interface SubmissionCandidate {
  source_key: string;
  source_automation_allowed: boolean;
  company: string;
  title: string;
  match_score: number | null;
  eligible: boolean;
  hourly_usd: number | null;
  already_submitted: boolean;
  documents_approved: boolean;
  user_approved_submission: boolean;
}

export interface SubmissionDecision {
  allowed: boolean;
  /** "submit" = may submit now; "prefill" = may only fill the form for review; "manual" = manual queue. */
  action: 'submit' | 'prefill' | 'manual' | 'blocked';
  reasons: string[];
}

/**
 * Decides what the automation may do with an application. Every rule is enforced in code
 * (and re-checked in the database) — the model never decides whether to submit.
 */
export function decideSubmission(rules: AutomationRules, c: SubmissionCandidate, submittedToday: number): SubmissionDecision {
  const reasons: string[] = [];
  if (rules.paused) return { allowed: false, action: 'blocked', reasons: ['Automation is paused (emergency stop).'] };
  if (c.already_submitted) return { allowed: false, action: 'blocked', reasons: ['An application for this job was already submitted.'] };
  if (!c.source_automation_allowed) {
    return { allowed: false, action: 'manual', reasons: [`Source "${c.source_key}" does not permit automated submission — moved to the manual queue.`] };
  }
  if (rules.mode === 'manual') return { allowed: false, action: 'manual', reasons: ['Manual mode: you submit applications yourself.'] };
  if (!c.documents_approved && rules.require_document_approval) reasons.push('Application documents are not approved yet.');

  if (rules.mode === 'approval') {
    if (reasons.length) return { allowed: false, action: 'blocked', reasons };
    if (!c.user_approved_submission) return { allowed: true, action: 'prefill', reasons: ['Approval mode: form will be filled for your review, not submitted.'] };
    return { allowed: true, action: 'submit', reasons: ['Submission approved by you.'] };
  }

  // Conditional auto-apply
  if (!rules.auto_apply_enabled || !rules.auto_apply_opt_in_at) reasons.push('Auto-apply is not enabled (explicit opt-in required).');
  if (rules.allowed_sources.length && !rules.allowed_sources.includes(c.source_key)) reasons.push(`Source "${c.source_key}" is not in your auto-apply sources.`);
  if (!c.eligible) reasons.push('Job failed a mandatory eligibility rule.');
  if (c.match_score === null || c.match_score < rules.min_match_score) reasons.push(`Match score ${c.match_score ?? 'n/a'} is below ${rules.min_match_score}.`);
  if (rules.min_salary_hourly_usd !== null) {
    if (c.hourly_usd === null) reasons.push('Salary unknown — auto-apply requires a disclosed salary.');
    else if (c.hourly_usd < rules.min_salary_hourly_usd) reasons.push(`Salary $${c.hourly_usd.toFixed(2)}/hr is below $${rules.min_salary_hourly_usd}/hr.`);
  }
  const company = normalizeCompany(c.company);
  if (rules.excluded_companies.some((x) => normalizeCompany(x) === company)) reasons.push(`${c.company} is excluded.`);
  if (rules.preferred_categories.length) {
    const t = normalizeText(c.title);
    if (!rules.preferred_categories.some((cat) => t.includes(normalizeText(cat)))) reasons.push('Title is outside your preferred job categories.');
  }
  if (submittedToday >= rules.max_daily_submissions) reasons.push(`Daily limit reached (${rules.max_daily_submissions}).`);

  if (reasons.length) {
    // Falls back to approval behaviour: still useful to prefill when the only issue is approval.
    return { allowed: false, action: 'blocked', reasons };
  }
  return { allowed: true, action: 'submit', reasons: ['All auto-apply rules satisfied.'] };
}

/** Whether Workflow 4 should prepare documents automatically for a scored job. */
export function shouldAutoPrepare(rules: Pick<AutomationRules, 'paused' | 'mode' | 'auto_prepare_min_score'>, score: number, eligible: boolean): boolean {
  if (rules.paused || !eligible) return false;
  if (rules.mode === 'manual') return false;
  return score >= rules.auto_prepare_min_score;
}
