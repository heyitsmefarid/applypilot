import {
  assessCompleteness,
  guardAgainstFabrication,
  normalizeSkill,
  PROMPTS,
  resumeDataSchema,
  type ResumeData,
} from '@applypilot/core';
import { AiBudgetError, runAi, type AiContext } from '../ai/run.js';
import { HttpError, notFound } from '../lib/errors.js';
import { unwrap, type Db } from '../lib/supabase.js';
import { getJob, jobForPrompt } from './context.js';

interface ResumeRow {
  id: string;
  user_id: string;
  title: string;
  extracted_text: string | null;
  status: string;
}

interface VersionRow {
  id: string;
  resume_id: string;
  version_number: number;
  content: unknown;
  kind: string;
  job_id: string | null;
}

async function loadResume(db: Db, userId: string, resumeId: string): Promise<ResumeRow> {
  const r = unwrap(await db.from('resumes').select('id, user_id, title, extracted_text, status').eq('id', resumeId).eq('user_id', userId).maybeSingle(), 'load resume');
  if (!r) throw notFound('Resume');
  return r as ResumeRow;
}

async function loadVersion(db: Db, userId: string, versionId: string): Promise<VersionRow & { content: ResumeData }> {
  const v = unwrap(await db.from('resume_versions').select('id, resume_id, version_number, content, kind, job_id').eq('id', versionId).eq('user_id', userId).maybeSingle(), 'load version');
  if (!v) throw notFound('Resume version');
  return { ...(v as VersionRow), content: resumeDataSchema.parse(v.content) };
}

async function nextVersionNumber(db: Db, resumeId: string): Promise<number> {
  const { data } = await db.from('resume_versions').select('version_number').eq('resume_id', resumeId).order('version_number', { ascending: false }).limit(1);
  return ((data?.[0]?.version_number as number | undefined) ?? 0) + 1;
}

async function insertVersion(db: Db, userId: string, resumeId: string, row: Record<string, unknown>) {
  // Retry once on a version-number race (unique constraint).
  for (let i = 0; i < 2; i++) {
    const version_number = await nextVersionNumber(db, resumeId);
    const { data, error } = await db.from('resume_versions').insert({ user_id: userId, resume_id: resumeId, version_number, ...row }).select('*').single();
    if (!error) return data;
    if (error.code !== '23505') throw new HttpError(500, 'database_error', `save resume version: ${error.message}`);
  }
  throw new HttpError(409, 'conflict', 'Could not allocate a version number');
}

/** AI extraction of structured data from the uploaded file's text → version (kind "extracted"). */
export async function extractResume(ai: AiContext, resumeId: string) {
  const { db, userId } = ai;
  const resume = await loadResume(db, userId, resumeId);
  if (!resume.extracted_text || resume.extracted_text.trim().length < 50) {
    throw new HttpError(409, 'no_text', 'No readable text was extracted from this file. Upload a text-based PDF or DOCX.');
  }
  await db.from('resumes').update({ status: 'extracting', analysis_error: null }).eq('id', resumeId);
  try {
    const out = await runAi(ai, PROMPTS.resumeExtract, { text: resume.extracted_text }, { relatedId: resumeId });
    const version = await insertVersion(db, userId, resumeId, {
      kind: 'extracted',
      label: 'Extracted from upload',
      content: out.data.resume,
      ai_changes: out.data.extraction_notes.map((note) => ({ section: 'extraction', before: '', after: '', reason: note })),
      model: out.model,
      prompt_version: out.promptVersion,
    });
    await db.from('resumes').update({ status: 'extracted' }).eq('id', resumeId);
    return { version, notes: out.data.extraction_notes };
  } catch (e) {
    await db.from('resumes').update({ status: 'failed', analysis_error: (e as Error).message.slice(0, 500) }).eq('id', resumeId);
    throw e;
  }
}

/** Quality analysis: deterministic completeness + Gemini review (falls back to deterministic only). */
export async function analyzeResume(ai: AiContext, resumeId: string, versionId?: string) {
  const { db, userId } = ai;
  await loadResume(db, userId, resumeId);
  let version: VersionRow & { content: ResumeData };
  if (versionId) version = await loadVersion(db, userId, versionId);
  else {
    const latest = unwrap(await db.from('resume_versions').select('id').eq('resume_id', resumeId).eq('user_id', userId).order('version_number', { ascending: false }).limit(1), 'latest version');
    if (!latest?.[0]) throw new HttpError(409, 'not_extracted', 'Extract the resume before analyzing it.');
    version = await loadVersion(db, userId, latest[0].id as string);
  }
  const completeness = assessCompleteness(version.content);
  await db.from('resumes').update({ status: 'analyzing' }).eq('id', resumeId);
  let aiAnalysis: unknown = null;
  let aiError: string | null = null;
  let model: string | null = null;
  try {
    const out = await runAi(ai, PROMPTS.resumeAnalyze, { resume: version.content, completeness }, { relatedId: resumeId });
    aiAnalysis = out.data;
    model = out.model;
  } catch (e) {
    if (!(e instanceof AiBudgetError) && !(e instanceof HttpError && e.code === 'gemini_not_configured')) {
      await db.from('resumes').update({ status: 'failed', analysis_error: (e as Error).message.slice(0, 500) }).eq('id', resumeId);
      throw e;
    }
    aiError = e.message;
  }
  const analysis = { version_id: version.id, completeness, ai: aiAnalysis, ai_error: aiError, model, analyzed_at: new Date().toISOString() };
  await db.from('resumes').update({ status: 'analyzed', analysis, analyzed_at: analysis.analyzed_at, analysis_error: aiError }).eq('id', resumeId);
  return analysis;
}

async function rewrite(ai: AiContext, versionId: string, mode: 'enhance' | 'tailor', extra: { instructions?: string; jobId?: string }) {
  const { db, userId } = ai;
  const source = await loadVersion(db, userId, versionId);
  let out;
  let label: string;
  if (mode === 'tailor') {
    if (!extra.jobId) throw new HttpError(400, 'bad_request', 'job_id is required');
    const job = await getJob(db, userId, extra.jobId);
    out = await runAi(ai, PROMPTS.resumeTailor, { resume: source.content, job: jobForPrompt(job) }, { relatedId: extra.jobId });
    label = `Tailored: ${job.title} @ ${job.company}`.slice(0, 160);
  } else {
    out = await runAi(ai, PROMPTS.resumeEnhance, { resume: source.content, instructions: extra.instructions }, { relatedId: versionId });
    label = 'AI-enhanced';
  }
  const guarded = guardAgainstFabrication(source.content, out.data.resume);
  const version = await insertVersion(db, userId, source.resume_id, {
    kind: mode === 'tailor' ? 'tailored' : 'ai_enhanced',
    label,
    content: guarded.resume,
    based_on_version_id: source.id,
    job_id: extra.jobId ?? null,
    ai_changes: out.data.changes,
    guard_violations: guarded.violations,
    model: out.model,
    prompt_version: out.promptVersion,
  });
  return { version, changes: out.data.changes, violations: guarded.violations };
}

export const enhanceResume = (ai: AiContext, versionId: string, instructions?: string) => rewrite(ai, versionId, 'enhance', { instructions });
export const tailorResume = (ai: AiContext, versionId: string, jobId: string) => rewrite(ai, versionId, 'tailor', { jobId });

/**
 * Marks a version as the verified source of truth: approves it, points the profile at it and
 * syncs the normalized `skills` table (manual skills are preserved).
 */
export async function verifyVersion(db: Db, userId: string, versionId: string) {
  const v = await loadVersion(db, userId, versionId);
  if (v.kind === 'tailored') throw new HttpError(400, 'bad_request', 'Tailored versions are job-specific and cannot be the verified master resume.');
  const now = new Date().toISOString();
  unwrap(await db.from('resume_versions').update({ status: 'approved', is_verified: true, verified_at: now }).eq('id', versionId).eq('user_id', userId).select('id'), 'verify version');
  unwrap(await db.from('profiles').update({ verified_resume_version_id: versionId }).eq('id', userId).select('id'), 'set verified pointer');
  await db.from('resumes').update({ is_primary: false }).eq('user_id', userId).neq('id', v.resume_id);
  await db.from('resumes').update({ is_primary: true }).eq('id', v.resume_id);

  const b = v.content.basics;
  const profilePatch: Record<string, string> = {};
  if (b.name) profilePatch.full_name = b.name;
  if (b.phone) profilePatch.phone = b.phone;
  if (b.location) profilePatch.location = b.location;
  if (b.headline) profilePatch.headline = b.headline;
  for (const l of b.links) {
    if (/github\.com/i.test(l.url)) profilePatch.github_url = l.url;
    else if (/linkedin\.com/i.test(l.url)) profilePatch.linkedin_url = l.url;
    else if (!profilePatch.portfolio_url) profilePatch.portfolio_url = l.url;
  }
  if (Object.keys(profilePatch).length) await db.from('profiles').update(profilePatch).eq('id', userId);

  const skills = new Map<string, { name: string; category: string }>();
  for (const s of v.content.skills) skills.set(normalizeSkill(s.name), { name: s.name, category: s.category });
  const rows = [...skills.entries()].map(([normalized_name, s]) => ({
    user_id: userId,
    name: s.name,
    normalized_name,
    category: s.category,
    source: 'resume',
    verified: true,
    resume_version_id: versionId,
  }));
  if (rows.length) unwrap(await db.from('skills').upsert(rows, { onConflict: 'user_id,normalized_name' }).select('id'), 'sync skills');
  const keep = [...skills.keys()];
  let stale = db.from('skills').delete().eq('user_id', userId).eq('source', 'resume');
  if (keep.length) stale = stale.not('normalized_name', 'in', `(${keep.map((k) => `"${k.replace(/"/g, '')}"`).join(',')})`);
  await stale;
  return { version_id: versionId, skills: rows.length };
}

/** Workflow 2: resumes uploaded but never processed. */
export async function pendingResumes(db: Db, userId: string, limit = 5) {
  const rows = unwrap(
    await db.from('resumes').select('id, status, extracted_text').eq('user_id', userId).in('status', ['uploaded', 'extracted']).order('created_at').limit(limit),
    'pending resumes',
  );
  return (rows ?? []).filter((r: { extracted_text: string | null }) => (r.extracted_text ?? '').length >= 50).map((r: { id: string; status: string }) => ({ id: r.id, status: r.status }));
}

export async function processResume(ai: AiContext, resumeId: string) {
  const resume = await loadResume(ai.db, ai.userId, resumeId);
  let extracted = null;
  if (resume.status === 'uploaded' || resume.status === 'failed') extracted = await extractResume(ai, resumeId);
  const analysis = await analyzeResume(ai, resumeId);
  return { extracted_version_id: extracted?.version?.id ?? null, completeness: analysis.completeness.score, ai: Boolean(analysis.ai) };
}
