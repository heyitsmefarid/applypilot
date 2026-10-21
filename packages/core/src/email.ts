import { getDomain } from 'tldts';
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
  /** The change looks right but the sender is unverified — show it for the user to approve. */
  suggested: boolean;
  to: ApplicationStatus | null;
  reason: string;
}

/**
 * Only clear evidence changes a status automatically: high confidence, a linked application, a
 * category that maps to a status, no backwards transitions, AND a verified sender who belongs to
 * the application (see isTrustedSender). Email content and the model's reading of it are untrusted,
 * so an unverified sender can at most produce a suggestion the user approves.
 */
export function decideStatusFromEmail(
  category: EmailCategory,
  confidence: number,
  current: ApplicationStatus | null,
  trustedSender = false,
): StatusUpdateDecision {
  const no = (to: ApplicationStatus | null, reason: string): StatusUpdateDecision => ({ update: false, suggested: false, to, reason });
  const to = CATEGORY_TO_STATUS[category] ?? null;
  if (!current) return no(to, 'Email is not linked to an application.');
  if (!to) return no(null, `Category "${category}" does not change status.`);
  if (confidence < EMAIL_STATUS_UPDATE_MIN_CONFIDENCE) return no(to, `Confidence ${confidence.toFixed(2)} is below ${EMAIL_STATUS_UPDATE_MIN_CONFIDENCE}.`);
  if (['withdrawn', 'closed', 'offer'].includes(current) && to !== 'offer') return no(to, `Application is already ${current}.`);
  if (current === to) return no(to, 'Status already up to date.');
  if (to === 'applied' && !['submission_in_progress', 'awaiting_approval', 'draft_prepared', 'saved', 'discovered', 'submission_failed'].includes(current)) {
    return no(to, 'Acknowledgment does not move an advanced application backwards.');
  }
  const curRank = STATUS_RANK[current] ?? 0;
  const toRank = STATUS_RANK[to] ?? 0;
  if (to !== 'rejected' && toRank < curRank) return no(to, 'Would move status backwards.');
  if (!trustedSender) {
    return { update: false, suggested: true, to, reason: 'Sender could not be verified as this employer or its hiring platform — review the email and apply the suggested status yourself.' };
  }
  return { update: true, suggested: false, to, reason: `High-confidence ${category} email from a verified sender.` };
}

export interface ApplicationRef {
  id: string;
  company: string;
  job_title: string;
  company_domain?: string | null;
  apply_url?: string | null;
  status: ApplicationStatus;
}

/**
 * Registrable domain using the Public Suffix List ("mail.acme.com" → "acme.com",
 * "hr.acme.com.ph" → "acme.com.ph"). A naive last-two-labels cut would treat every
 * ".com.ph" or ".co.uk" sender as the same organisation.
 */
function registrable(host: string | null | undefined): string | null {
  if (!host) return null;
  const h = host.toLowerCase().trim().replace(/^.*@/, '').replace(/[>\s]+$/, '');
  return getDomain(h, { allowPrivateDomains: true }) ?? null;
}

function senderDomain(from: string): string | null {
  const m = from.match(/@([a-z0-9.-]+\.[a-z]{2,})/i);
  return m ? registrable(m[1]) : null;
}

function hostOf(url: string | null | undefined): string | null {
  if (!url) return null;
  try {
    return new URL(url).hostname;
  } catch {
    return null;
  }
}

const ATS_DOMAINS = new Set(['greenhouse.io', 'lever.co', 'ashbyhq.com', 'workable.com', 'smartrecruiters.com', 'myworkdayjobs.com', 'icims.com', 'bamboohr.com', 'kalibrr.com', 'jobstreet.com', 'linkedin.com', 'indeed.com', 'gmail.com']);

/**
 * Applicant-tracking systems keyed by the registrable domain of their apply pages, with the
 * domains they send candidate mail from. An ATS is trusted only for applications whose apply_url
 * is on that ATS. Platforms that relay messages written by arbitrary users (LinkedIn, Indeed,
 * JobStreet, Kalibrr, webmail) are never trusted — their mail can at most be a suggestion.
 */
const ATS_SENDERS: Record<string, string[]> = {
  'greenhouse.io': ['greenhouse.io', 'greenhouse-mail.io'],
  'lever.co': ['lever.co'],
  'ashbyhq.com': ['ashbyhq.com'],
  'workable.com': ['workable.com', 'workablemail.com'],
  'smartrecruiters.com': ['smartrecruiters.com'],
  'myworkdayjobs.com': ['myworkday.com', 'myworkdayjobs.com', 'workday.com'],
  'icims.com': ['icims.com'],
  'bamboohr.com': ['bamboohr.com'],
  'jobvite.com': ['jobvite.com'],
  'teamtailor.com': ['teamtailor.com', 'teamtailor-mail.com'],
  'recruitee.com': ['recruitee.com'],
  'breezy.hr': ['breezy.hr'],
};

/** Job boards and relays: an apply link here says nothing about who the employer is. */
const NOT_EMPLOYER_DOMAINS = new Set(['linkedin.com', 'indeed.com', 'jobstreet.com', 'kalibrr.com', 'onlinejobs.ph', 'remotive.com', 'jobicy.com', 'himalayas.app', 'arbeitnow.com', 'gmail.com', 'googlemail.com', 'yahoo.com', 'outlook.com', 'hotmail.com']);

interface AuthResult {
  method: string;
  result: string;
  props: Record<string, string>;
}

/**
 * Parses one Authentication-Results header (RFC 8601): drops (comments), splits into
 * "method=result prop=value …" entries, and returns them only if the authserv-id is
 * mx.google.com. Anything else — including text an attacker placed inside comments — is ignored.
 */
export function parseAuthenticationResults(header: string | null | undefined): AuthResult[] {
  if (!header) return [];
  let h = header.toLowerCase();
  // Comments may nest; strip innermost first until none remain.
  for (let prev = ''; prev !== h; ) {
    prev = h;
    h = h.replace(/\([^()]*\)/g, ' ');
  }
  const [authserv, ...entries] = h.split(';').map((s) => s.replace(/\s+/g, ' ').trim());
  if (authserv?.split(' ')[0] !== 'mx.google.com') return [];
  const out: AuthResult[] = [];
  for (const entry of entries) {
    const [head, ...rest] = entry.split(' ');
    const m = head?.match(/^([a-z0-9-]+)=([a-z]+)$/);
    if (!m) continue;
    const props: Record<string, string> = {};
    for (const token of rest) {
      const kv = token.match(/^([a-z0-9-]+\.[a-z0-9-]+)=(.+)$/);
      if (kv) props[kv[1]!] = kv[2]!.replace(/^"|"$/g, '');
    }
    out.push({ method: m[1]!, result: m[2]!, props });
  }
  return out;
}

/**
 * Whether Gmail authenticated the visible From domain: DMARC pass for header.from, or a passing
 * DKIM signature whose signing domain is aligned (same registrable domain) with From.
 * SPF alone is not accepted — it authenticates the envelope sender, not the From header.
 */
export function senderAuthenticated(authResults: string | null | undefined, fromEmail: string): boolean {
  const from = senderDomain(fromEmail);
  if (!from) return false;
  return parseAuthenticationResults(authResults).some((r) => {
    if (r.result !== 'pass') return false;
    if (r.method === 'dmarc') return registrable(r.props['header.from']) === from;
    if (r.method === 'dkim') return registrable(r.props['header.d'] ?? r.props['header.i']) === from;
    return false;
  });
}

/**
 * A sender may change an application's status only when Gmail authenticated it and it is either
 * the employer itself (same registrable domain as company_domain, or as the apply link when that
 * link is on the employer's own site) or the ATS that hosts this application's apply link.
 */
export function isTrustedSender(fromEmail: string, app: Pick<ApplicationRef, 'company_domain' | 'apply_url'> | null, authenticated: boolean): boolean {
  if (!authenticated || !app) return false;
  const sender = senderDomain(fromEmail);
  if (!sender || NOT_EMPLOYER_DOMAINS.has(sender)) return false;
  const applyDomain = registrable(hostOf(app.apply_url));
  if (applyDomain && ATS_SENDERS[applyDomain]) return ATS_SENDERS[applyDomain]!.includes(sender);
  const employerDomains = [registrable(app.company_domain), applyDomain && !NOT_EMPLOYER_DOMAINS.has(applyDomain) ? applyDomain : null].filter(Boolean);
  return employerDomains.includes(sender);
}

/**
 * Links an email to an application using sender domain, company name and role title found in the
 * email itself. Deterministic on purpose: the model's reading of the email is never used to link it.
 * Returns null unless exactly one application is a convincing match.
 */
export function matchEmailToApplication(
  email: EmailLike,
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
    const title = normalizeText(a.job_title);
    if (title && text.includes(title)) score += 2;
    return { applicationId: a.id, score };
  });
  scored.sort((x, y) => y.score - x.score);
  const best = scored[0];
  if (!best || best.score < 3) return null;
  if (scored[1] && scored[1].score === best.score) return null; // ambiguous
  return best;
}
