import type { z } from 'zod';
import type { AiTask } from '../constants.js';
import type { ResumeData } from '../schemas/resume.js';
import { resumeToText } from '../schemas/resume.js';
import {
  aiCoverLetterSchema,
  aiEmailClassificationSchema,
  aiEmailDraftSchema,
  aiMatchSchema,
  aiResumeAnalysisSchema,
  aiResumeExtractSchema,
  aiResumeRewriteSchema,
  aiScreeningSchema,
} from './schemas.js';
import { UNTRUSTED_DATA_RULES, wrapUntrusted } from './untrusted.js';

export * from './schemas.js';
export * from './untrusted.js';
export { toGeminiSchema } from './gemini-schema.js';

/** "fast" → Flash-Lite model, "quality" → Flash model (both configurable in the Worker). */
export type ModelTier = 'fast' | 'quality';

export interface PromptDefinition<TInput, TSchema extends z.ZodType> {
  id: string;
  version: number;
  task: AiTask;
  tier: ModelTier;
  schema: TSchema;
  system: string;
  build: (input: TInput) => string;
}

const NO_FABRICATION = [
  'NEVER invent or embellish facts. Do not add employers, job titles, dates, degrees, certifications,',
  'skills, technologies, metrics, awards or achievements that are not explicitly present in the source resume.',
  'You may rephrase, reorder, shorten and emphasize existing facts only.',
  'If information is missing, leave the field empty — do not guess.',
].join(' ');

export interface JobForPrompt {
  title: string;
  company: string;
  location: string;
  work_arrangement: string;
  employment_type: string;
  salary_text?: string | null;
  description: string;
  requirements: string[];
}

function jobBlock(job: JobForPrompt, maxChars = 9000): string {
  const header = [
    `Title: ${job.title}`,
    `Company: ${job.company}`,
    `Location: ${job.location || 'not stated'}`,
    `Arrangement: ${job.work_arrangement}`,
    `Employment type: ${job.employment_type}`,
    `Salary: ${job.salary_text || 'not stated'}`,
  ].join('\n');
  const body = `${job.description}\n${job.requirements.length ? `\nRequirements:\n- ${job.requirements.join('\n- ')}` : ''}`;
  return wrapUntrusted('job_posting', `${header}\n\n${body}`, maxChars);
}

function resumeJson(resume: ResumeData): string {
  return JSON.stringify(resume);
}

export const PROMPTS = {
  resumeExtract: {
    id: 'resume-extract',
    version: 1,
    task: 'resume_extract',
    tier: 'fast',
    schema: aiResumeExtractSchema,
    system: [
      'You convert resume text into structured JSON for an applicant tracking system.',
      'Extract only information that is explicitly written in the resume. Keep the original wording of bullet points.',
      'Classify each skill into a category. Dates stay in the format written (e.g. "Jun 2024", "2023").',
      'Use empty strings or empty arrays for missing fields.',
      'Put any ambiguities (e.g. unclear dates, merged columns) in extraction_notes.',
      UNTRUSTED_DATA_RULES,
    ].join(' '),
    build: (input: { text: string }) => `Resume text:\n${wrapUntrusted('resume_file', input.text, 30000)}`,
  } satisfies PromptDefinition<{ text: string }, typeof aiResumeExtractSchema>,

  resumeAnalyze: {
    id: 'resume-analyze',
    version: 1,
    task: 'resume_analyze',
    tier: 'fast',
    schema: aiResumeAnalysisSchema,
    system: [
      'You are an expert technical recruiter reviewing a resume for entry-level and internship software roles in the Philippines and remote markets.',
      'Score overall quality 0-100. Identify concrete, actionable issues per section with severity.',
      'Point out missing information the candidate should ADD THEMSELVES (never fabricate it for them).',
      'Give ATS formatting tips. Be specific and concise.',
    ].join(' '),
    build: (input: { resume: ResumeData; completeness: { score: number; missing: string[] } }) =>
      `Structured resume (JSON):\n${resumeJson(input.resume)}\n\nDeterministic completeness check: ${input.completeness.score}/100. Missing: ${input.completeness.missing.join('; ') || 'none'}.`,
  } satisfies PromptDefinition<{ resume: ResumeData; completeness: { score: number; missing: string[] } }, typeof aiResumeAnalysisSchema>,

  resumeEnhance: {
    id: 'resume-enhance',
    version: 1,
    task: 'resume_enhance',
    tier: 'quality',
    schema: aiResumeRewriteSchema,
    system: [
      'You improve resumes for clarity, structure, concise wording and ATS-friendliness.',
      'Use strong action verbs, remove filler, keep bullets to one or two lines, and keep a professional tone.',
      NO_FABRICATION,
      'Return the full improved resume and a list of changes (section, before, after, reason) for every edited item.',
    ].join(' '),
    build: (input: { resume: ResumeData; instructions?: string }) =>
      `Source resume (JSON):\n${resumeJson(input.resume)}${input.instructions ? `\n\nUser focus: ${input.instructions.slice(0, 500)}` : ''}`,
  } satisfies PromptDefinition<{ resume: ResumeData; instructions?: string }, typeof aiResumeRewriteSchema>,

  resumeTailor: {
    id: 'resume-tailor',
    version: 1,
    task: 'resume_tailor',
    tier: 'quality',
    schema: aiResumeRewriteSchema,
    system: [
      'You tailor a resume to a specific job posting.',
      'Reorder sections and bullets so the most relevant experience and projects come first,',
      'rewrite the summary to target the role, and mirror the posting\'s terminology ONLY where the candidate genuinely has that skill.',
      NO_FABRICATION,
      'Skills the job wants but the candidate lacks must NOT be added. Return the tailored resume plus a list of changes.',
      UNTRUSTED_DATA_RULES,
    ].join(' '),
    build: (input: { resume: ResumeData; job: JobForPrompt }) =>
      `Verified source resume (JSON):\n${resumeJson(input.resume)}\n\nTarget job:\n${jobBlock(input.job)}`,
  } satisfies PromptDefinition<{ resume: ResumeData; job: JobForPrompt }, typeof aiResumeRewriteSchema>,

  match: {
    id: 'job-match',
    version: 1,
    task: 'match',
    tier: 'fast',
    schema: aiMatchSchema,
    system: [
      'You evaluate how well a candidate fits a job. Score each criterion 0-100 with a one-sentence reason:',
      'technical_skills, experience, education, projects (relevance of portfolio projects), responsibilities (can they do the day-to-day work), qualifications (stated must-haves).',
      'matched_skills must only contain skills that appear in the candidate resume. missing_skills are job skills the resume lacks.',
      'Deterministic eligibility results are authoritative facts — do not contradict them.',
      'Unknown information (salary, location eligibility) must not be treated as satisfied.',
      'Write a short, honest explanation and up to 5 resume suggestions that use only the candidate\'s real experience.',
      UNTRUSTED_DATA_RULES,
    ].join(' '),
    build: (input: { resume: ResumeData; job: JobForPrompt; eligibilitySummary: string; profileName: string }) =>
      [
        `Search profile: ${input.profileName}`,
        `Deterministic eligibility findings:\n${input.eligibilitySummary}`,
        `Candidate resume:\n${resumeToText(input.resume).slice(0, 8000)}`,
        `Job:\n${jobBlock(input.job)}`,
      ].join('\n\n'),
  } satisfies PromptDefinition<{ resume: ResumeData; job: JobForPrompt; eligibilitySummary: string; profileName: string }, typeof aiMatchSchema>,

  coverLetter: {
    id: 'cover-letter',
    version: 1,
    task: 'cover_letter',
    tier: 'quality',
    schema: aiCoverLetterSchema,
    system: [
      'Write a concise, specific cover letter (250-350 words, 3-4 paragraphs) for the job.',
      'Reference 1-2 of the candidate\'s real projects or experiences that best match the role and explain why the company interests them using only facts from the posting.',
      'Avoid clichés ("I am writing to express my interest"), avoid exaggeration, and do not claim skills the resume lacks.',
      NO_FABRICATION,
      UNTRUSTED_DATA_RULES,
    ].join(' '),
    build: (input: { resume: ResumeData; job: JobForPrompt; extra?: string }) =>
      `Candidate resume (verified):\n${resumeToText(input.resume).slice(0, 8000)}\n\nJob:\n${jobBlock(input.job)}${input.extra ? `\n\nCandidate notes: ${input.extra.slice(0, 600)}` : ''}`,
  } satisfies PromptDefinition<{ resume: ResumeData; job: JobForPrompt; extra?: string }, typeof aiCoverLetterSchema>,

  applicationEmail: {
    id: 'application-email',
    version: 1,
    task: 'application_email',
    tier: 'fast',
    schema: aiEmailDraftSchema,
    system: [
      'Write a short professional job application email (90-150 words) with a clear subject line',
      '("Application: <Role> — <Full Name>"). Mention that the resume and cover letter are attached.',
      'Plain text, no placeholders except [Hiring Manager] when the name is unknown.',
      NO_FABRICATION,
      UNTRUSTED_DATA_RULES,
    ].join(' '),
    build: (input: { resume: ResumeData; job: JobForPrompt }) =>
      `Candidate: ${input.resume.basics.name} — ${input.resume.basics.headline}\nTop skills: ${input.resume.skills
        .slice(0, 12)
        .map((s) => s.name)
        .join(', ')}\n\nJob:\n${jobBlock(input.job, 4000)}`,
  } satisfies PromptDefinition<{ resume: ResumeData; job: JobForPrompt }, typeof aiEmailDraftSchema>,

  screeningAnswers: {
    id: 'screening-answers',
    version: 1,
    task: 'screening_answers',
    tier: 'fast',
    schema: aiScreeningSchema,
    system: [
      'Suggest answers to likely screening questions for this application: questions explicitly asked in the posting,',
      'plus common ones (why this role, relevant experience, availability/start date, expected salary, work setup, OJT hours if an internship).',
      'Answers must be truthful and based only on the resume and candidate preferences. When the answer depends on information',
      'not provided (e.g. exact start date, salary expectation without a preference), write a short template and set needs_user_input=true.',
      UNTRUSTED_DATA_RULES,
    ].join(' '),
    build: (input: { resume: ResumeData; job: JobForPrompt; preferencesSummary: string }) =>
      `Candidate preferences: ${input.preferencesSummary}\n\nCandidate resume:\n${resumeToText(input.resume).slice(0, 6000)}\n\nJob:\n${jobBlock(input.job, 6000)}`,
  } satisfies PromptDefinition<{ resume: ResumeData; job: JobForPrompt; preferencesSummary: string }, typeof aiScreeningSchema>,

  emailClassify: {
    id: 'email-classify',
    version: 1,
    task: 'email_classify',
    tier: 'fast',
    schema: aiEmailClassificationSchema,
    system: [
      'Classify an email in a job seeker\'s inbox. Categories: job_alert (automated job recommendations), acknowledgment (application received),',
      'assessment (coding test / take-home / exam), interview (invitation or scheduling), offer, rejection, recruiter_outreach, follow_up, other.',
      'confidence is 0-1; use >= 0.85 only when the email is unambiguous. Extract company, role, deadline and interview details (ISO 8601 with offset when possible).',
      'Draft a brief, polite suggested_reply only when a reply is appropriate (interview scheduling, assessment confirmation, recruiter outreach); otherwise leave it empty.',
      'Never include promises the candidate has not made. ',
      UNTRUSTED_DATA_RULES,
    ].join(' '),
    build: (input: { from: string; subject: string; receivedAt: string; body: string; candidateName: string; openApplications: string[] }) =>
      [
        `Candidate name: ${input.candidateName}`,
        `Candidate's open applications (company — role):\n${input.openApplications.slice(0, 40).join('\n') || 'none'}`,
        `Email received at ${input.receivedAt}:`,
        wrapUntrusted('email', `From: ${input.from}\nSubject: ${input.subject}\n\n${input.body}`, 8000),
      ].join('\n\n'),
  } satisfies PromptDefinition<
    { from: string; subject: string; receivedAt: string; body: string; candidateName: string; openApplications: string[] },
    typeof aiEmailClassificationSchema
  >,

  followUp: {
    id: 'follow-up',
    version: 1,
    task: 'follow_up',
    tier: 'fast',
    schema: aiEmailDraftSchema,
    system: [
      'Write a brief, courteous follow-up email (60-120 words) about a job application with no response yet.',
      'Restate interest, mention one relevant qualification from the resume, and ask about next steps. No pressure, no fabricated facts.',
      UNTRUSTED_DATA_RULES,
    ].join(' '),
    build: (input: { candidateName: string; company: string; title: string; appliedOn: string; highlight: string }) =>
      `Candidate: ${input.candidateName}\nApplied on: ${input.appliedOn}\nRelevant highlight: ${input.highlight}\n${wrapUntrusted('application', `Company: ${input.company}\nRole: ${input.title}`, 500)}`,
  } satisfies PromptDefinition<{ candidateName: string; company: string; title: string; appliedOn: string; highlight: string }, typeof aiEmailDraftSchema>,
} as const;

export type PromptKey = keyof typeof PROMPTS;

export function promptVersionTag(p: { id: string; version: number }): string {
  return `${p.id}@${p.version}`;
}
