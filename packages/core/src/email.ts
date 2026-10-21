import type { ApplicationStatus, EmailCategory } from './constants.js';
import { EMAIL_STATUS_UPDATE_MIN_CONFIDENCE } from './constants.js';
import { normalizeCompany } from './dedupe.js';
import { normalizeText } from './text.js';

/** Gmail search query used for incremental recruitment sync. */
export function buildGmailQuery(newerThanDays = 3): string {
  const terms = [
    'application',
    'applied',
    'interview',
    'assessment',
    'offer',
    'recruit',
    'recruiter',
    'hiring',
    'position',
    'internship',
    'OJT',
    '"job alert"',
    '"thank you for applying"',
    '"next steps"',
    'unfortunately',
  ];
  const senders = ['linkedin.com', 'indeed.com', 'jobstreet.com', 'onlinejobs.ph', 'greenhouse.io', 'lever.co', 'ashbyhq.com', 'workable.com', 'kalibrr.com'];
  return `newer_than:${newerThanDays}d -in:chats -category:promotions {${terms.join(' ')} ${senders.map((s) => `from:${s}`).join(' ')}}`;
}

const ALERT_SENDERS = /(jobalerts-noreply@linkedin\.com|jobs-listings@linkedin\.com|alert@indeed\.com|noreply@indeed\.com|jobstreet|onlinejobs\.ph|jobs-noreply|jobalert)/i;

export interface EmailLike {
  from: string;
  subject: string;
  body: string;
}

/** Cheap keyword pre-filter so obviously irrelevant mail never reaches Gemini. */
export function isLikelyRecruitmentEmail(e: EmailLike): boolean {
  const text = `${e.from}\n${e.subject}\n${e.body.slice(0, 3000)}`.toLowerCase();
  if (ALERT_SENDERS.test(e.from)) return true;
  return /\b(application|applied|applying|interview|assessment|coding (test|challenge)|take[- ]home|offer letter|job offer|recruit|talent acquisition|hiring|candidate|position|internship|ojt|resume|cv\b|shortlist|unfortunately|move forward|next steps)\b/.test(text);
}

/** Keyword fallback classifier used when the AI budget is exhausted. Low confidence by design. */
export function heuristicClassify(e: EmailLike): { category: EmailCategory; confidence: number } {
  const t = `${e.subject}\n${e.body.slice(0, 4000)}`.toLowerCase();
  if (ALERT_SENDERS.test(e.from) || /\bjob alert\b|jobs you may be interested|new jobs for you|recommended jobs/.test(t)) return { category: 'job_alert', confidence: 0.8 };
  if (/unfortunately|not (be )?moving forward|decided to (move|proceed) with other|position has been filled|regret to inform/.test(t)) return { category: 'rejection', confidence: 0.7 };
  if (/\boffer letter\b|pleased to offer|job offer|offer of employment/.test(t)) return { category: 'offer', confidence: 0.6 };
  if (/\binterview\b|schedule a (call|chat)|calendly|availability for a (call|chat)/.test(t)) return { category: 'interview', confidence: 0.6 };
  if (/assessment|coding (test|challenge)|take[- ]home|hackerrank|codility|testgorilla/.test(t)) return { category: 'assessment', confidence: 0.6 };
  if (/thank you for (applying|your application)|we (have )?received your application|application (has been )?received/.test(t)) return { category: 'acknowledgment', confidence: 0.7 };
  if (/\b(recruiter|talent acquisition|came across your profile|opportunity)\b/.test(t)) return { category: 'recruiter_outreach', confidence: 0.5 };
  return { category: 'other', confidence: 0.3 };
}

const CATEGORY_TO_STATUS: Partial<Record<EmailCategory, ApplicationStatus>> = {
  acknowledgment: 'applied',
  assessment: 'assessment',
  interview: 'interview',
  offer: 'offer',
  rejection: 'rejected',
};

/** Ordering prevents an older acknowledgment from moving an application backwards. */
const STATUS_RANK: Partial<Record<ApplicationStatus, number>> = {
  applied: 1,
  assessment: 2,
  interview: 3,
  offer: 4,
  rejected: 4,
};

export interface StatusUpdateDecision {
  update: boolean;
  to: ApplicationStatus | null;
  reason: string;
}

/**
 * Only clear evidence changes a status: high confidence, a linked application, a category that
 * maps to a status, and no backwards transitions. Everything else becomes a notification only.
 */
export function decideStatusFromEmail(
  category: EmailCategory,
  confidence: number,
  current: ApplicationStatus | null,
): StatusUpdateDecision {
  const to = CATEGORY_TO_STATUS[category] ?? null;
  if (!current) return { update: false, to, reason: 'Email is not linked to an application.' };
  if (!to) return { update: false, to: null, reason: `Category "${category}" does not change status.` };
  if (confidence < EMAIL_STATUS_UPDATE_MIN_CONFIDENCE) {
    return { update: false, to, reason: `Confidence ${confidence.toFixed(2)} is below ${EMAIL_STATUS_UPDATE_MIN_CONFIDENCE}.` };
  }
  if (['withdrawn', 'closed', 'offer'].includes(current) && to !== 'offer') return { update: false, to, reason: `Application is already ${current}.` };
  if (current === to) return { update: false, to, reason: 'Status already up to date.' };
  if (to === 'applied' && !['submission_in_progress', 'awaiting_approval', 'draft_prepared', 'saved', 'discovered', 'submission_failed'].includes(current)) {
    return { update: false, to, reason: 'Acknowledgment does not move an advanced application backwards.' };
  }
  const curRank = STATUS_RANK[current] ?? 0;
  const toRank = STATUS_RANK[to] ?? 0;
  if (to !== 'rejected' && toRank < curRank) return { update: false, to, reason: 'Would move status backwards.' };
  return { update: true, to, reason: `High-confidence ${category} email.` };
}

export interface ApplicationRef {
  id: string;
  company: string;
  job_title: string;
  company_domain?: string | null;
  status: ApplicationStatus;
}

function senderDomain(from: string): string | null {
  const m = from.match(/@([a-z0-9.-]+\.[a-z]{2,})/i);
  if (!m) return null;
  const parts = m[1]!.toLowerCase().split('.');
  return parts.slice(-2).join('.');
}

const ATS_DOMAINS = new Set(['greenhouse.io', 'lever.co', 'ashbyhq.com', 'workable.com', 'smartrecruiters.com', 'myworkdayjobs.com', 'icims.com', 'bamboohr.com', 'kalibrr.com', 'jobstreet.com', 'linkedin.com', 'indeed.com', 'gmail.com']);

/**
 * Links an email to an application using sender domain, company name and role title.
 * Returns null unless exactly one application is a convincing match.
 */
export function matchEmailToApplication(
  email: EmailLike & { aiCompany?: string; aiTitle?: string },
  applications: ApplicationRef[],
): { applicationId: string; score: number } | null {
  const domain = senderDomain(email.from);
  const text = normalizeText(`${email.from} ${email.subject} ${email.body.slice(0, 5000)}`);
  const scored = applications.map((a) => {
    let score = 0;
    const company = normalizeCompany(a.company);
    const companyToken = company.split(' ')[0] ?? '';
    if (a.company_domain && domain && a.company_domain.toLowerCase().endsWith(domain)) score += 4;
    if (domain && !ATS_DOMAINS.has(domain) && companyToken.length > 2 && domain.includes(companyToken)) score += 3;
    if (company && ` ${text} `.includes(` ${company} `)) score += 3;
    if (email.aiCompany && normalizeCompany(email.aiCompany) === company) score += 3;
    const title = normalizeText(a.job_title);
    if (title && text.includes(title)) score += 2;
    if (email.aiTitle && normalizeText(email.aiTitle) === title) score += 1;
    return { applicationId: a.id, score };
  });
  scored.sort((x, y) => y.score - x.score);
  const best = scored[0];
  if (!best || best.score < 3) return null;
  if (scored[1] && scored[1].score === best.score) return null; // ambiguous
  return best;
}
