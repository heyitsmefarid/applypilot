import { followUpDue, PROMPTS } from '@applypilot/core';
import { AiBudgetError, runAi, type AiContext } from '../ai/run.js';
import { unwrap } from '../lib/supabase.js';
import { getProfile, getRules, getVerifiedResume } from './context.js';
import { notify } from './notifications.js';

/**
 * Workflow 7: finds applications past their follow-up interval with no employer reply,
 * drafts a follow-up (never sends), and asks for approval.
 */
export async function scanFollowUps(ai: AiContext, limit = 5) {
  const { db, userId } = ai;
  const [rules, profile] = await Promise.all([getRules(db, userId), getProfile(db, userId)]);
  const apps = unwrap(
    await db
      .from('applications')
      .select('id, company, job_title, status, submitted_at, last_follow_up_at, follow_up_interval_days, last_employer_message_at, follow_ups_sent, recruiter_email')
      .eq('user_id', userId)
      .in('status', ['applied', 'assessment'])
      .not('submitted_at', 'is', null)
      .order('submitted_at')
      .limit(100),
    'load follow-up candidates',
  ) as Array<{ id: string; company: string; job_title: string; status: 'applied' | 'assessment'; submitted_at: string; last_follow_up_at: string | null; follow_up_interval_days: number | null; last_employer_message_at: string | null; follow_ups_sent: number; recruiter_email: string | null }>;
  if (!apps.length) return { scanned: 0, drafted: 0, skipped: [] };

  const { data: pending } = await db.from('application_documents').select('application_id').eq('user_id', userId).eq('kind', 'follow_up').eq('status', 'draft').in('application_id', apps.map((a) => a.id));
  const pendingSet = new Set((pending ?? []).map((p: { application_id: string }) => p.application_id));

  let resumeHighlight: string;
  try {
    const r = await getVerifiedResume(db, userId);
    resumeHighlight = r.content.projects[0]?.highlights[0] ?? r.content.experience[0]?.highlights[0] ?? r.content.basics.summary;
  } catch {
    resumeHighlight = profile.headline;
  }

  const drafted: string[] = [];
  const skipped: Array<{ id: string; reason: string }> = [];
  for (const a of apps) {
    if (drafted.length >= limit) break;
    const d = followUpDue({ ...a, has_pending_follow_up_draft: pendingSet.has(a.id) }, rules.follow_up_after_days, a.follow_ups_sent);
    if (!d.due) continue;
    try {
      const out = await runAi(ai, PROMPTS.followUp, {
        candidateName: profile.full_name,
        company: a.company,
        title: a.job_title,
        appliedOn: a.submitted_at.slice(0, 10),
        highlight: resumeHighlight.slice(0, 300),
      }, { relatedId: a.id });
      await db.from('application_documents').insert({
        user_id: userId,
        application_id: a.id,
        kind: 'follow_up',
        title: out.data.subject,
        content_text: out.data.body,
        content_json: { ...out.data, to: a.recruiter_email },
        status: 'draft',
        ai_generated: true,
        model: out.model,
        prompt_version: out.promptVersion,
        version: a.follow_ups_sent + 1,
      });
      await notify(db, userId, {
        type: 'follow_up',
        severity: 'info',
        title: `Follow-up ready for approval: ${a.company}`,
        body: `${d.reason} A polite follow-up draft for "${a.job_title}" is waiting for your approval.`,
        link: `/applications/${a.id}`,
        dedupe_key: `followup:${a.id}:${a.follow_ups_sent + 1}`,
      });
      drafted.push(a.id);
    } catch (e) {
      if (e instanceof AiBudgetError) {
        skipped.push({ id: a.id, reason: 'AI budget exhausted' });
        break;
      }
      skipped.push({ id: a.id, reason: (e as Error).message.slice(0, 200) });
    }
  }
  return { scanned: apps.length, drafted: drafted.length, skipped };
}
