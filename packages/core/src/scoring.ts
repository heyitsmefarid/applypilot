import { INELIGIBLE_SCORE_CAP } from './constants.js';
import type { EligibilityResult } from './eligibility.js';
import type { AiMatchOutput } from './prompts/schemas.js';
import { compareSkills, extractSkillsFromText, normalizeSkill } from './skills.js';
import type { NormalizedJob } from './schemas/job.js';

export const SCORE_CRITERIA = [
  'technical_skills',
  'experience',
  'education',
  'projects',
  'responsibilities',
  'qualifications',
  'location',
  'work_arrangement',
  'compensation',
  'eligibility',
] as const;
export type ScoreCriterion = (typeof SCORE_CRITERIA)[number];

export const CRITERION_LABELS: Record<ScoreCriterion, string> = {
  technical_skills: 'Technical skills',
  experience: 'Experience',
  education: 'Education',
  projects: 'Relevant projects',
  responsibilities: 'Responsibilities',
  qualifications: 'Required qualifications',
  location: 'Location',
  work_arrangement: 'Work arrangement',
  compensation: 'Compensation',
  eligibility: 'Applicant eligibility',
};

/** Weights sum to 100. */
export const CRITERION_WEIGHTS: Record<ScoreCriterion, number> = {
  technical_skills: 25,
  experience: 12,
  education: 8,
  projects: 12,
  responsibilities: 10,
  qualifications: 10,
  location: 7,
  work_arrangement: 6,
  compensation: 5,
  eligibility: 5,
};

export type Recommendation = 'apply' | 'consider' | 'skip';

export interface CriterionScore {
  score: number;
  source: 'deterministic' | 'ai' | 'blended';
  note: string;
}

export interface MatchResult {
  score: number;
  deterministic_score: number;
  ai_score: number | null;
  breakdown: Record<ScoreCriterion, CriterionScore>;
  matched_skills: string[];
  missing_skills: string[];
  recommendation: Recommendation;
  explanation: string;
  suggestions: string[];
  missing_qualifications: string[];
}

const clamp = (n: number) => Math.max(0, Math.min(100, Math.round(Number.isFinite(n) ? n : 0)));

function outcomeScore(eligibility: EligibilityResult, rule: string, unknownScore = 50): number | null {
  const c = eligibility.checks.find((x) => x.rule === rule);
  if (!c) return null;
  if (c.outcome === 'pass') return 100;
  if (c.outcome === 'fail') return 0;
  return unknownScore;
}

export interface DeterministicInput {
  job: Pick<NormalizedJob, 'title' | 'description' | 'requirements' | 'tags'>;
  candidateSkills: string[];
  eligibility: EligibilityResult;
}

/** Scores that can be computed without AI. Used alone when the AI budget is exhausted. */
export function deterministicCriteria({ job, candidateSkills, eligibility }: DeterministicInput) {
  const jobText = `${job.title}\n${job.description}\n${job.requirements.join('\n')}\n${job.tags.join(', ')}`;
  const jobSkills = extractSkillsFromText(jobText, candidateSkills);
  const overlap = compareSkills(candidateSkills, jobSkills);
  // With no detectable skills in the posting we know nothing — score neutrally.
  const skillsScore = jobSkills.length ? clamp(25 + overlap.ratio * 75) : 50;
  const experience = outcomeScore(eligibility, 'experience', 55) ?? 60;
  const location = outcomeScore(eligibility, 'location', 50) ?? 100;
  const arrangement = outcomeScore(eligibility, 'work_arrangement', 50) ?? 100;
  const compensation = outcomeScore(eligibility, 'salary', 40) ?? 70;
  const mandatoryFailures = eligibility.checks.filter((c) => c.mandatory && c.outcome === 'fail').length;
  const unknowns = eligibility.checks.filter((c) => c.outcome === 'unknown').length;
  const eligibilityScore = mandatoryFailures ? 0 : clamp(100 - unknowns * 12);
  return {
    jobSkills,
    overlap,
    criteria: {
      technical_skills: skillsScore,
      experience,
      location,
      work_arrangement: arrangement,
      compensation,
      eligibility: eligibilityScore,
    },
  };
}

export function recommend(score: number, eligible: boolean, minScore: number): Recommendation {
  if (!eligible) return 'skip';
  if (score >= minScore) return 'apply';
  if (score >= minScore - 15) return 'consider';
  return 'skip';
}

/**
 * Combines deterministic checks with Gemini's qualitative assessment.
 * - The final number is always computed here, never taken from the model.
 * - Skills the model claims are "matched" but which are not in the verified resume are discarded.
 * - A failed mandatory eligibility rule caps the score.
 */
export function computeMatch(params: {
  job: DeterministicInput['job'];
  candidateSkills: string[];
  eligibility: EligibilityResult;
  ai: AiMatchOutput | null;
  minScore: number;
}): MatchResult {
  const { job, candidateSkills, eligibility, ai, minScore } = params;
  const det = deterministicCriteria({ job, candidateSkills, eligibility });
  const verified = new Set(candidateSkills.map(normalizeSkill));

  const breakdown = {} as Record<ScoreCriterion, CriterionScore>;
  const put = (k: ScoreCriterion, score: number, source: CriterionScore['source'], note: string) => {
    breakdown[k] = { score: clamp(score), source, note };
  };

  const aiC = ai?.criteria;
  const aiNote = (k: keyof NonNullable<typeof aiC>) => aiC?.[k]?.reason ?? '';
  // Skills: blend deterministic overlap with AI judgement (AI catches implied skills, e.g. "SPA frameworks").
  if (aiC) put('technical_skills', det.criteria.technical_skills * 0.5 + aiC.technical_skills.score * 0.5, 'blended', aiNote('technical_skills'));
  else put('technical_skills', det.criteria.technical_skills, 'deterministic', `${det.overlap.matched.length}/${det.jobSkills.length} detected skills matched.`);

  if (aiC) put('experience', Math.min(det.criteria.experience === 0 ? 0 : 100, aiC.experience.score * 0.7 + det.criteria.experience * 0.3), 'blended', aiNote('experience'));
  else put('experience', det.criteria.experience, 'deterministic', 'Based on stated experience level / years.');

  for (const k of ['education', 'projects', 'responsibilities', 'qualifications'] as const) {
    if (aiC) put(k, aiC[k].score, 'ai', aiNote(k));
    else put(k, 50, 'deterministic', 'AI analysis unavailable — neutral score.');
  }
  put('location', det.criteria.location, 'deterministic', eligibility.checks.find((c) => c.rule === 'location')?.detail ?? 'No location constraint.');
  put('work_arrangement', det.criteria.work_arrangement, 'deterministic', eligibility.checks.find((c) => c.rule === 'work_arrangement')?.detail ?? 'No arrangement constraint.');
  put('compensation', det.criteria.compensation, 'deterministic', eligibility.checks.find((c) => c.rule === 'salary')?.detail ?? 'No salary floor configured.');
  put('eligibility', det.criteria.eligibility, 'deterministic', eligibility.passed ? `${eligibility.warnings.length} warning(s).` : eligibility.failures.join(' '));

  const weighted = (b: Record<ScoreCriterion, CriterionScore>) =>
    SCORE_CRITERIA.reduce((sum, k) => sum + b[k].score * CRITERION_WEIGHTS[k], 0) / 100;

  let score = clamp(weighted(breakdown));
  if (!eligibility.passed) score = Math.min(score, INELIGIBLE_SCORE_CAP);

  const detOnly = { ...breakdown };
  for (const k of ['education', 'projects', 'responsibilities', 'qualifications'] as const) detOnly[k] = { score: 50, source: 'deterministic', note: '' };
  detOnly.technical_skills = { score: det.criteria.technical_skills, source: 'deterministic', note: '' };
  detOnly.experience = { score: det.criteria.experience, source: 'deterministic', note: '' };
  const deterministicScore = clamp(weighted(detOnly));

  const aiScore = aiC
    ? clamp(
        (['technical_skills', 'experience', 'education', 'projects', 'responsibilities', 'qualifications'] as const).reduce(
          (s, k) => s + aiC[k].score * CRITERION_WEIGHTS[k],
          0,
        ) /
          (CRITERION_WEIGHTS.technical_skills +
            CRITERION_WEIGHTS.experience +
            CRITERION_WEIGHTS.education +
            CRITERION_WEIGHTS.projects +
            CRITERION_WEIGHTS.responsibilities +
            CRITERION_WEIGHTS.qualifications),
      )
    : null;

  const aiMatched = (ai?.matched_skills ?? []).map(normalizeSkill).filter((s) => verified.has(s));
  const matched = [...new Set([...det.overlap.matched, ...aiMatched])].sort();
  const missing = [...new Set([...det.overlap.missing, ...(ai?.missing_skills ?? []).map(normalizeSkill)])].filter((s) => s && !verified.has(s)).sort();

  const explanation = ai?.explanation?.trim()
    ? ai.explanation.trim()
    : eligibility.passed
      ? `Deterministic match: ${matched.length} of ${det.jobSkills.length || 'unknown'} detected skills match your verified resume.`
      : `Not eligible: ${eligibility.failures.join(' ')}`;

  return {
    score,
    deterministic_score: deterministicScore,
    ai_score: aiScore,
    breakdown,
    matched_skills: matched,
    missing_skills: missing,
    recommendation: recommend(score, eligibility.passed, minScore),
    explanation,
    suggestions: (ai?.resume_suggestions ?? []).slice(0, 8),
    missing_qualifications: (ai?.missing_qualifications ?? []).slice(0, 10),
  };
}
