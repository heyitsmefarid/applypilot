import { z } from 'zod';
import { EMPLOYMENT_TYPES, EXPERIENCE_LEVELS, SALARY_PERIODS, WORK_ARRANGEMENTS } from '../constants.js';

const strList = (max = 50) => z.array(z.string().trim().min(1).max(120)).max(max).default([]);

/** A job search profile. Mirrors `job_preferences` columns. */
export const jobPreferenceSchema = z.object({
  id: z.string().optional(),
  name: z.string().trim().min(1).max(80),
  is_active: z.boolean().default(true),
  roles: strList(),
  keywords: strList(),
  excluded_keywords: strList(),
  locations: strList(),
  work_arrangements: z.array(z.enum(WORK_ARRANGEMENTS)).default([]),
  employment_types: z.array(z.enum(EMPLOYMENT_TYPES)).default([]),
  experience_levels: z.array(z.enum(EXPERIENCE_LEVELS)).default([]),
  min_salary_amount: z.number().nonnegative().nullable().default(null),
  salary_currency: z.string().max(8).nullable().default('USD'),
  salary_period: z.enum(SALARY_PERIODS).nullable().default('hour'),
  require_ph_eligible: z.boolean().default(false),
  required_ojt_hours: z.number().int().positive().nullable().default(null),
  max_posting_age_days: z.number().int().positive().max(90).default(3),
  min_match_score: z.number().int().min(0).max(100).default(70),
  search_frequency_minutes: z.number().int().min(60).max(10080).default(60),
  excluded_companies: strList(200),
  source_keys: strList(),
  php_per_usd: z.number().positive().default(58),
});

export type JobPreference = z.infer<typeof jobPreferenceSchema>;
export type JobPreferenceInput = z.input<typeof jobPreferenceSchema>;

/** Default search profiles described in the product brief. */
export const DEFAULT_PREFERENCES: JobPreferenceInput[] = [
  {
    name: 'Internship (Onsite, Metro Manila)',
    roles: [
      'Software Developer Intern',
      'Frontend Developer Intern',
      'Backend Developer Intern',
      'Full-stack Developer Intern',
      'Mobile Developer Intern',
      'App Developer Intern',
    ],
    keywords: ['intern', 'internship', 'ojt', 'on-the-job training', 'trainee'],
    excluded_keywords: ['senior', 'lead', 'principal', 'manager'],
    locations: ['Makati', 'Pasig', 'Quezon City'],
    work_arrangements: ['onsite'],
    employment_types: ['internship'],
    experience_levels: ['internship', 'entry'],
    min_salary_amount: null,
    salary_currency: 'PHP',
    salary_period: 'month',
    require_ph_eligible: true,
    required_ojt_hours: 500,
    max_posting_age_days: 3,
    min_match_score: 65,
  },
  {
    name: 'Remote Employment (PH-friendly)',
    roles: [
      'Junior Software Developer',
      'Frontend Developer',
      'Backend Developer',
      'Full-stack Developer',
      'Mobile Developer',
      'Freelance Developer',
      'Part-time Developer',
    ],
    keywords: ['junior', 'entry level', 'entry-level', 'graduate', 'associate'],
    excluded_keywords: ['senior', 'staff', 'principal', 'lead', 'director', 'architect'],
    locations: ['Philippines', 'Worldwide', 'Anywhere', 'APAC', 'Asia'],
    work_arrangements: ['remote'],
    employment_types: ['full_time', 'part_time', 'contract', 'freelance'],
    experience_levels: ['entry', 'junior', 'mid'],
    min_salary_amount: 5,
    salary_currency: 'USD',
    salary_period: 'hour',
    require_ph_eligible: true,
    required_ojt_hours: null,
    max_posting_age_days: 3,
    min_match_score: 70,
  },
];
