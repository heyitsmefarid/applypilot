import {
  computeMatch,
  evaluateEligibility,
  PROMPTS,
  shouldAutoPrepare,
  titleMatchesRoles,
  type AiMatchOutput,
  type EligibilityResult,
  type JobPreference,
} from '@applypilot/core';
import { AiBudgetError, runAi, type AiContext } from '../ai/run.js';
import { HttpError } from '../lib/errors.js';
import { unwrap, type Db } from '../lib/supabase.js';
import { getActivePreferences, getJob, getRules, getVerifiedResume, jobForPrompt } from './context.js';
import { notify } from './notifications.js';

function summarizeEligibility(e: EligibilityResult): string {
  return e.checks.map((c) => `- [${c.outcome.toUpperCase()}${c.mandatory ? ', mandatory' : ''}] ${c.rule}: ${c.detail}`).join('\n');
}

/** Chooses the search profile a job belongs to: eligible first, then fewest failures/warnings. */
export function pickPreference(prefs: JobPreference[], evaluate: (p: JobPreference) => EligibilityResult) {
  const scored = prefs.map((p) => ({ pref: p, elig: evaluate(p) }));
  scored.sort((a, b) => {
    if (a.elig.passed !== b.elig.passed) return a.elig.passed ? -1 : 1;
    if (a.elig.failures.length !== b.elig.failures.length) return a.elig.failures.length - b.elig.failures.length;
    return a.elig.warnings.length - b.elig.warnings.length;
  });
  return scored[0] ?? null;
}

export interface ScoreOptions {
  useAi?: boolean;
}

/**
 * Workflow 3 core: deterministic eligibility → (if eligible) Gemini qualitative scoring →
 * score computed in code → upsert job_matches → high-match notification.
 */
export async function scoreJob(ai: AiContext, jobId: string, opts: ScoreOptions = {}) {
  const { db, userId } = ai;
  const [job, prefs, resume, rules] = await Promise.all([getJob(db, userId, jobId), getActivePreferences(db, userId), getVerifiedResume(db, userId), getRules(db, userId)]);
  if (!prefs.length) throw new HttpError(409, 'no_preferences', 'Create at least one active search profile first.');

  const best = pickPreference(prefs, (p) => evaluateEligibility(job, p))!;
  const { pref, elig } = best;

  let aiOut: AiMatchOutput | null = null;
  let model = 'deterministic';
  let promptVersion = 'deterministic@1';
  let aiNote: string | null = null;
  if (elig.passed && opts.useAi !== false) {
    try {
      const out = await runAi(
        ai,
        PROMPTS.match,
        { resume: resume.content, job: jobForPrompt(job), eligibilitySummary: summarizeEligibility(elig), profileName: pref.name },
        { relatedId: jobId },
      );
      aiOut = out.data;
      model = out.model;
      promptVersion = out.promptVersion;
    } catch (e) {
      // Budget/pacing/no key → deterministic fallback, flagged in the result.
      if (e instanceof AiBudgetError || (e instanceof HttpError && e.code === 'gemini_not_configured')) aiNote = e.message;
      else throw e;
    }
  }

  const result = computeMatch({ job, candidateSkills: resume.skills, eligibility: elig, ai: aiOut, minScore: pref.min_match_score });
  const row = {
    user_id: userId,
    job_id: jobId,
    preference_id: pref.id ?? null,
    resume_version_id: resume.versionId,
    status: elig.passed ? 'scored' : 'ineligible',
    score: result.score,
    deterministic_score: result.deterministic_score,
    ai_score: result.ai_score,
    breakdown: result.breakdown,
    eligibility: { ...elig, profile: pref.name, ai_note: aiNote },
    eligible: elig.passed,
    matched_skills: result.matched_skills,
    missing_skills: result.missing_skills,
    missing_qualifications: result.missing_qualifications,
    explanation: result.explanation,
    suggestions: result.suggestions,
    recommendation: result.recommendation,
    model,
    prompt_version: promptVersion,
    error: null,
    scored_at: new Date().toISOString(),
  };
  const saved = unwrap(await db.from('job_matches').upsert(row, { onConflict: 'user_id,job_id,preference_id' }).select('id, notified_at').single(), 'save match');
  // One match per job: drop stale rows scored against other profiles.
  await db.from('job_matches').delete().eq('user_id', userId).eq('job_id', jobId).neq('id', saved.id);

  const highMatch = elig.passed && result.score >= rules.notify_min_score;
  if (highMatch && !saved.notified_at) {
    const created = await notify(db, userId, {
      type: 'high_match',
      severity: 'success',
      title: `${result.score}% match: ${job.title}`,
      body: `${job.company} · ${job.location || job.work_arrangement} — ${result.explanation.slice(0, 240)}`,
      link: `/jobs/${jobId}`,
      dedupe_key: `high_match:${jobId}`,
      metadata: { job_id: jobId, score: result.score },
    });
    if (created) await db.from('job_matches').update({ notified_at: new Date().toISOString() }).eq('id', saved.id);
  }
  return {
    match_id: saved.id as string,
    job_id: jobId,
    score: result.score,
    eligible: elig.passed,
    recommendation: result.recommendation,
    used_ai: Boolean(aiOut),
    ai_note: aiNote,
    high_match: highMatch,
    auto_prepare: shouldAutoPrepare(rules, result.score, elig.passed),
  };
}

/**
 * Jobs waiting for a score. A cheap title pre-filter avoids spending AI calls on clearly
 * irrelevant postings (they are still scored deterministically).
 */
export async function pendingMatches(db: Db, userId: string, opts: { limit?: number; jobIds?: string[] } = {}) {
  const limit = Math.min(opts.limit ?? 25, 50);
  let query = db.from('job_listings').select('id, title, discovered_at, job_matches(id)').eq('user_id', userId).eq('status', 'active').eq('is_hidden', false).order('discovered_at', { ascending: false }).limit(200);
  if (opts.jobIds?.length) query = query.in('id', opts.jobIds.slice(0, 200));
  const rows = unwrap(await query, 'pending matches') as Array<{ id: string; title: string; job_matches: unknown[] }>;
  const prefs = await getActivePreferences(db, userId);
  const unscored = rows.filter((r) => !r.job_matches?.length);
  return unscored.slice(0, limit).map((r) => ({
    job_id: r.id,
    title: r.title,
    use_ai: prefs.some((p) => titleMatchesRoles(r.title, p.roles, p.keywords)),
  }));
}
