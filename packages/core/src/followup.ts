import type { ApplicationStatus } from './constants.js';

export interface FollowUpCandidate {
  id: string;
  status: ApplicationStatus;
  submitted_at: string | null;
  last_follow_up_at: string | null;
  follow_up_interval_days: number | null;
  last_employer_message_at: string | null;
  has_pending_follow_up_draft: boolean;
}

export interface FollowUpDecision {
  due: boolean;
  reason: string;
}

const DAY = 86_400_000;

/**
 * An application needs a follow-up when it was submitted, has no employer reply since,
 * the configured interval has elapsed, and no follow-up draft is already waiting.
 * At most two follow-ups are suggested per application.
 */
export function followUpDue(c: FollowUpCandidate, defaultIntervalDays: number, followUpsSent: number, now = new Date()): FollowUpDecision {
  if (!['applied', 'assessment'].includes(c.status)) return { due: false, reason: `Status is ${c.status}.` };
  if (!c.submitted_at) return { due: false, reason: 'No submission date.' };
  if (c.has_pending_follow_up_draft) return { due: false, reason: 'A follow-up draft is already awaiting approval.' };
  if (followUpsSent >= 2) return { due: false, reason: 'Two follow-ups already sent.' };
  const interval = (c.follow_up_interval_days ?? defaultIntervalDays) * DAY;
  const anchor = Math.max(Date.parse(c.submitted_at), c.last_follow_up_at ? Date.parse(c.last_follow_up_at) : 0);
  if (c.last_employer_message_at && Date.parse(c.last_employer_message_at) > anchor) {
    return { due: false, reason: 'Employer replied after the last contact.' };
  }
  if (now.getTime() - anchor < interval) return { due: false, reason: 'Follow-up interval has not elapsed.' };
  return { due: true, reason: `No response for ${Math.floor((now.getTime() - anchor) / DAY)} days.` };
}
