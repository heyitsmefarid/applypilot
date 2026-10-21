import { z } from 'zod';
import { EMAIL_CATEGORIES } from '../constants.js';
import { resumeDataSchema } from '../schemas/resume.js';

const score = z.number().min(0).max(100);
const reasoned = z.object({ score, reason: z.string().max(400).default('') });
const strs = (max = 12, len = 400) => z.array(z.string().max(len)).max(max).default([]);

export const aiResumeExtractSchema = z.object({
  resume: resumeDataSchema,
  extraction_notes: strs(10),
});
export type AiResumeExtractOutput = z.infer<typeof aiResumeExtractSchema>;

export const aiResumeAnalysisSchema = z.object({
  overall_score: score,
  summary: z.string().max(1200).default(''),
  strengths: strs(10),
  issues: z
    .array(
      z.object({
        section: z.string().max(60),
        severity: z.enum(['high', 'medium', 'low']),
        issue: z.string().max(400),
        suggestion: z.string().max(500),
      }),
    )
    .max(20)
    .default([]),
  missing_information: strs(12),
  ats_tips: strs(10),
});
export type AiResumeAnalysisOutput = z.infer<typeof aiResumeAnalysisSchema>;

export const aiResumeChangeSchema = z.object({
  section: z.string().max(60),
  before: z.string().max(1200).default(''),
  after: z.string().max(1200).default(''),
  reason: z.string().max(400).default(''),
});
export type AiResumeChange = z.infer<typeof aiResumeChangeSchema>;

export const aiResumeRewriteSchema = z.object({
  resume: resumeDataSchema,
  changes: z.array(aiResumeChangeSchema).max(40).default([]),
});
export type AiResumeRewriteOutput = z.infer<typeof aiResumeRewriteSchema>;

export const aiMatchSchema = z.object({
  criteria: z.object({
    technical_skills: reasoned,
    experience: reasoned,
    education: reasoned,
    projects: reasoned,
    responsibilities: reasoned,
    qualifications: reasoned,
  }),
  matched_skills: strs(40, 80),
  missing_skills: strs(40, 80),
  missing_qualifications: strs(12),
  relevant_projects: strs(6, 200),
  eligibility_concerns: strs(8),
  explanation: z.string().max(1500).default(''),
  resume_suggestions: strs(8),
  recommendation: z.enum(['apply', 'consider', 'skip']).default('consider'),
});
export type AiMatchOutput = z.infer<typeof aiMatchSchema>;

export const aiCoverLetterSchema = z.object({
  greeting: z.string().max(200),
  paragraphs: z.array(z.string().max(1500)).min(2).max(5),
  closing: z.string().max(200),
  signature: z.string().max(200).default(''),
});
export type AiCoverLetterOutput = z.infer<typeof aiCoverLetterSchema>;

export const aiEmailDraftSchema = z.object({
  subject: z.string().max(200),
  body: z.string().max(5000),
});
export type AiEmailDraftOutput = z.infer<typeof aiEmailDraftSchema>;

export const aiScreeningSchema = z.object({
  answers: z
    .array(
      z.object({
        question: z.string().max(300),
        answer: z.string().max(1500),
        needs_user_input: z.boolean().default(false),
      }),
    )
    .max(15)
    .default([]),
});
export type AiScreeningOutput = z.infer<typeof aiScreeningSchema>;

export const aiEmailClassificationSchema = z.object({
  is_recruitment_related: z.boolean(),
  category: z.enum(EMAIL_CATEGORIES),
  confidence: z.number().min(0).max(1),
  company: z.string().max(200).default(''),
  job_title: z.string().max(200).default(''),
  summary: z.string().max(600).default(''),
  action_required: z.boolean().default(false),
  deadline_iso: z.string().max(40).nullable().default(null),
  interview: z
    .object({
      datetime_iso: z.string().max(40).nullable().default(null),
      timezone: z.string().max(60).default(''),
      duration_minutes: z.number().int().min(0).max(600).nullable().default(null),
      location: z.string().max(300).default(''),
      meeting_url: z.string().max(500).default(''),
      stage: z.enum(['screening', 'technical', 'hr', 'final', 'other']).default('other'),
    })
    .nullable()
    .default(null),
  assessment_url: z.string().max(500).default(''),
  instructions: strs(8),
  suggested_reply: z.string().max(3000).default(''),
});
export type AiEmailClassificationOutput = z.infer<typeof aiEmailClassificationSchema>;
