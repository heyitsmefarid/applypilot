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

const ATS_DOMAINS = new Set(['greenhouse.io', 'lever.co', 'ashbyhq.com', 'workable.com', 'smartrecruiters.com', 'myworkdayjobs.com', 'icims.com', 'bamboohr.com', 'kalibrr.com', 'jobstreet.com', 'linkedin.com', 'indeed.com', 'gmail.com']);

/**
 * Domains that can never identify an employer: webmail, job boards, relay platforms and
 * multi-tenant ATS senders (Greenhouse, Lever, … send mail for every company they host, so their
 * domain says nothing about which employer wrote). Applied to company_domain as a guard against a
 * mistaken entry — trust itself comes only from an exact employer-domain match.
 */
const NEVER_EMPLOYER_DOMAINS = new Set([
  'gmail.com', 'googlemail.com', 'yahoo.com', 'outlook.com', 'hotmail.com', 'live.com', 'icloud.com', 'proton.me', 'protonmail.com',
  'linkedin.com', 'indeed.com', 'jobstreet.com', 'kalibrr.com', 'onlinejobs.ph', 'remotive.com', 'jobicy.com', 'himalayas.app', 'arbeitnow.com',
  'greenhouse.io', 'greenhouse-mail.io', 'lever.co', 'ashbyhq.com', 'workable.com', 'workablemail.com', 'smartrecruiters.com', 'myworkday.com',
  'myworkdayjobs.com', 'workday.com', 'icims.com', 'bamboohr.com', 'jobvite.com', 'teamtailor.com', 'teamtailor-mail.com', 'recruitee.com', 'breezy.hr',
]);

/**
 * Splits an Authentication-Results header into ";"-separated parts in a single pass, honouring
 * RFC 5322 comments (nested, with backslash escapes) so that ";" or "=" inside a comment has no
 * meaning. Returns null for anything unusual — quote characters, unbalanced parentheses, a stray
 * backslash — because a header we cannot parse unambiguously must never count as authentication.
 */
function splitAuthenticationResults(header: string): string[] | null {
  if (header.includes('"')) return null;
  const parts: string[] = [];
  let current = '';
  let depth = 0;
  for (let i = 0; i < header.length; i++) {
    const ch = header[i]!;
    if (ch === '\\') {
      if (depth === 0) return null;
      i++; // escaped character inside a comment: skip it
      continue;
    }
    if (ch === '(') {
      depth++;
      continue;
    }
    if (ch === ')') {
      if (depth === 0) return null;
      depth--;
      if (depth === 0) current += ' ';
      continue;
    }
    if (depth > 0) continue;
    if (ch === ';') {
      parts.push(current);
      current = '';
      continue;
    }
    current += ch;
  }
  if (depth !== 0) return null;
  parts.push(current);
  return parts.map((p) => p.replace(/\s+/g, ' ').trim().toLowerCase());
}

/**
 * Returns the domains for which Gmail (authserv-id mx.google.com) reports dmarc=pass.
 * Only DMARC is used: it is the result that binds authentication to the visible From domain.
 */
export function dmarcPassDomains(header: string | null | undefined): string[] {
  if (!header) return [];
  const parts = splitAuthenticationResults(header);
  if (!parts) return [];
  const [authserv, ...entries] = parts;
  if (authserv?.split(' ')[0] !== 'mx.google.com') return [];
  const domains: string[] = [];
  for (const entry of entries) {
    const [head, ...props] = entry.split(' ');
    if (head !== 'dmarc=pass') continue;
    for (const prop of props) {
      const m = prop.match(/^header\.from=([a-z0-9.-]+)$/);
      if (m) domains.push(m[1]!);
    }
  }
  return domains;
}

/** Whether Gmail's DMARC check passed for the From address's registrable domain. */
export function senderAuthenticated(authResults: string | null | undefined, fromEmail: string): boolean {
  const from = senderDomain(fromEmail);
  if (!from) return false;
  return dmarcPassDomains(authResults).some((d) => registrable(d) === from);
}

/**
 * A sender may change an application's status automatically only when Gmail's DMARC check passed
 * and its registrable domain equals the employer domain stored on the application (which the user
 * can set or correct). Nothing else — ATS platforms, apply-link hosts, job boards — grants trust;
 * such mail can at most produce a suggestion the user applies.
 */
export function isTrustedSender(fromEmail: string, app: Pick<ApplicationRef, 'company_domain'> | null, authenticated: boolean): boolean {
  if (!authenticated || !app?.company_domain) return false;
  const sender = senderDomain(fromEmail);
  const employer = registrable(app.company_domain);
  if (!sender || !employer || NEVER_EMPLOYER_DOMAINS.has(employer)) return false;
  return sender === employer;
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
