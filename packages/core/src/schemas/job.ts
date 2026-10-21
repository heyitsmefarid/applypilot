import { z } from 'zod';
import {
  EMPLOYMENT_TYPES,
  EXPERIENCE_LEVELS,
  PH_ELIGIBILITY,
  SALARY_PERIODS,
  WORK_ARRANGEMENTS,
} from '../constants.js';

const isoDate = z
  .string()
  .refine((v) => !Number.isNaN(Date.parse(v)), 'Invalid date')
  .nullable()
  .default(null);

/** The standard shape every source adapter must produce. Mirrors `job_listings` columns. */
export const normalizedJobSchema = z.object({
  source_key: z.string().min(1).max(80),
  external_id: z.string().min(1).max(300),
  title: z.string().min(1).max(300),
  company: z.string().min(1).max(200),
  company_url: z.string().max(500).nullable().default(null),
  location: z.string().max(300).default(''),
  work_arrangement: z.enum(WORK_ARRANGEMENTS).default('unknown'),
  employment_type: z.enum(EMPLOYMENT_TYPES).default('unknown'),
  experience_level: z.enum(EXPERIENCE_LEVELS).default('unknown'),
  salary_min: z.number().nonnegative().nullable().default(null),
  salary_max: z.number().nonnegative().nullable().default(null),
  salary_currency: z.string().max(8).nullable().default(null),
  salary_period: z.enum(SALARY_PERIODS).nullable().default(null),
  salary_text: z.string().max(300).nullable().default(null),
  candidate_locations: z.string().max(500).nullable().default(null),
  ph_eligibility: z.enum(PH_ELIGIBILITY).default('unknown'),
  description: z.string().max(30000).default(''),
  requirements: z.array(z.string().max(600)).max(40).default([]),
  tags: z.array(z.string().max(80)).max(40).default([]),
  apply_url: z.url().max(2000),
  posted_at: isoDate,
  expires_at: isoDate,
  fingerprint: z.string().max(128).optional(),
});

export type NormalizedJob = z.infer<typeof normalizedJobSchema>;
export type NormalizedJobInput = z.input<typeof normalizedJobSchema>;

/** A stored job listing row (subset used by domain logic). */
export interface JobListing extends NormalizedJob {
  id: string;
  user_id?: string;
  status: 'active' | 'expired' | 'closed';
  is_hidden: boolean;
  discovered_at: string;
  last_seen_at?: string | null;
}
