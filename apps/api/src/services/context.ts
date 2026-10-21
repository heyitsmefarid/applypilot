import {
  jobPreferenceSchema,
  resumeDataSchema,
  type AutomationRules,
  type JobPreference,
  type NormalizedJob,
  type ResumeData,
} from '@applypilot/core';
import { HttpError, locked } from '../lib/errors.js';
import { unwrap, type Db } from '../lib/supabase.js';

export interface OwnerProfile {
  id: string;
  email: string;
  full_name: string;
  phone: string;
  location: string;
  headline: string;
  timezone: string;
  portfolio_url: string;
  linkedin_url: string;
  github_url: string;
  verified_resume_version_id: string | null;
}

export type RulesRow = AutomationRules & {
  id: string;
  follow_up_after_days: number;
  notify_min_score: number;
  ai_daily_request_budget: number;
  email_notifications: boolean;
  telegram_notifications: boolean;
  paused_reason: string | null;
  resume_selection: 'primary' | 'tailored';
};

export async function getProfile(db: Db, userId: string): Promise<OwnerProfile> {
  const p = unwrap(await db.from('profiles').select('*').eq('id', userId).maybeSingle(), 'load profile');
  if (!p) throw new HttpError(404, 'no_profile', 'Profile not found');
  return p as OwnerProfile;
}

export async function getRules(db: Db, userId: string): Promise<RulesRow> {
  const r = unwrap(await db.from('automation_rules').select('*').eq('user_id', userId).maybeSingle(), 'load automation rules');
  if (!r) throw new HttpError(404, 'no_rules', 'Automation rules not found');
  return r as RulesRow;
}

/** Throws 423 when the emergency pause is on. Every automated action calls this first. */
export async function assertNotPaused(db: Db, userId: string): Promise<RulesRow> {
  const rules = await getRules(db, userId);
  if (rules.paused) throw locked(`Automation is paused${rules.paused_reason ? `: ${rules.paused_reason}` : ''}`);
  return rules;
}

export async function getActivePreferences(db: Db, userId: string): Promise<JobPreference[]> {
  const rows = unwrap(await db.from('job_preferences').select('*').eq('user_id', userId).eq('is_active', true).order('created_at'), 'load preferences');
  return (rows ?? []).map((r: Record<string, unknown>) =>
    jobPreferenceSchema.parse({
      ...r,
      min_salary_amount: r.min_salary_amount === null ? null : Number(r.min_salary_amount),
      php_per_usd: Number(r.php_per_usd ?? 58),
    }),
  );
}

export interface VerifiedResume {
  versionId: string;
  resumeId: string;
  content: ResumeData;
  skills: string[];
}

/** The verified resume version is the only source of truth for matching and tailoring. */
export async function getVerifiedResume(db: Db, userId: string): Promise<VerifiedResume> {
  const profile = await getProfile(db, userId);
  if (!profile.verified_resume_version_id) {
    throw new HttpError(409, 'no_verified_resume', 'Verify your resume in "My Resume" before using matching or tailoring.');
  }
  const v = unwrap(
    await db.from('resume_versions').select('id, resume_id, content, is_verified').eq('id', profile.verified_resume_version_id).eq('user_id', userId).maybeSingle(),
    'load verified resume',
  );
  if (!v || !v.is_verified) throw new HttpError(409, 'no_verified_resume', 'Your verified resume version is missing.');
  const skillsRows = unwrap(await db.from('skills').select('name').eq('user_id', userId).eq('verified', true), 'load skills');
  const content = resumeDataSchema.parse(v.content);
  const skills = [...new Set([...(skillsRows ?? []).map((s: { name: string }) => s.name), ...content.skills.map((s) => s.name)])];
  return { versionId: v.id as string, resumeId: v.resume_id as string, content, skills };
}

export type JobRow = NormalizedJob & {
  id: string;
  user_id: string;
  status: 'active' | 'expired' | 'closed';
  is_hidden: boolean;
  discovered_at: string;
  source_id: string | null;
};

export async function getJob(db: Db, userId: string, jobId: string): Promise<JobRow> {
  const j = unwrap(await db.from('job_listings').select('*').eq('id', jobId).eq('user_id', userId).maybeSingle(), 'load job');
  if (!j) throw new HttpError(404, 'not_found', 'Job not found');
  return {
    ...j,
    salary_min: j.salary_min === null ? null : Number(j.salary_min),
    salary_max: j.salary_max === null ? null : Number(j.salary_max),
  } as JobRow;
}

export function jobForPrompt(job: JobRow) {
  return {
    title: job.title,
    company: job.company,
    location: job.location,
    work_arrangement: job.work_arrangement,
    employment_type: job.employment_type,
    salary_text: job.salary_text,
    description: job.description,
    requirements: job.requirements,
  };
}

export async function audit(db: Db, userId: string, actor: string, action: string, entity?: string, entityId?: string | null, metadata: Record<string, unknown> = {}) {
  const { error } = await db.from('audit_logs').insert({ user_id: userId, actor, action, entity: entity ?? null, entity_id: entityId ?? null, metadata });
  if (error) console.error('[audit] failed', error.message);
}
