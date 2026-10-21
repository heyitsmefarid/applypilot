import { z } from 'zod';

const str = (max = 500) => z.string().max(max).default('');
const list = (max = 30, itemMax = 600) => z.array(z.string().max(itemMax)).max(max).default([]);

export const SKILL_CATEGORIES = ['language', 'framework', 'library', 'database', 'tool', 'cloud', 'platform', 'soft', 'other'] as const;

export const resumeLinkSchema = z.object({
  label: str(80),
  url: str(400),
});

export const resumeBasicsSchema = z.object({
  name: str(120),
  email: str(200),
  phone: str(60),
  location: str(160),
  headline: str(200),
  summary: str(2000),
  links: z.array(resumeLinkSchema).max(10).default([]),
});

export const resumeEducationSchema = z.object({
  institution: str(200),
  degree: str(200),
  field: str(200),
  start_date: str(40),
  end_date: str(40),
  gpa: str(40),
  highlights: list(10),
});

export const resumeExperienceSchema = z.object({
  company: str(200),
  title: str(200),
  location: str(160),
  start_date: str(40),
  end_date: str(40),
  current: z.boolean().default(false),
  highlights: list(15),
});

export const resumeProjectSchema = z.object({
  name: str(200),
  role: str(160),
  url: str(400),
  technologies: list(30, 80),
  highlights: list(10),
});

export const resumeSkillSchema = z.object({
  name: z.string().min(1).max(80),
  category: z.enum(SKILL_CATEGORIES).default('other'),
});

export const resumeCertificationSchema = z.object({
  name: str(200),
  issuer: str(200),
  date: str(40),
  url: str(400),
});

export const resumeDataSchema = z.object({
  basics: resumeBasicsSchema.default({
    name: '',
    email: '',
    phone: '',
    location: '',
    headline: '',
    summary: '',
    links: [],
  }),
  education: z.array(resumeEducationSchema).max(10).default([]),
  experience: z.array(resumeExperienceSchema).max(20).default([]),
  projects: z.array(resumeProjectSchema).max(20).default([]),
  skills: z.array(resumeSkillSchema).max(120).default([]),
  certifications: z.array(resumeCertificationSchema).max(30).default([]),
});

export type ResumeData = z.infer<typeof resumeDataSchema>;
export type ResumeExperience = z.infer<typeof resumeExperienceSchema>;
export type ResumeEducation = z.infer<typeof resumeEducationSchema>;
export type ResumeProject = z.infer<typeof resumeProjectSchema>;
export type ResumeSkill = z.infer<typeof resumeSkillSchema>;
export type ResumeCertification = z.infer<typeof resumeCertificationSchema>;
export type SkillCategory = (typeof SKILL_CATEGORIES)[number];

export function emptyResume(): ResumeData {
  return resumeDataSchema.parse({});
}

/** Flattens resume content to plain text (used for skill evidence checks and prompts). */
export function resumeToText(r: ResumeData): string {
  const lines: string[] = [];
  const b = r.basics;
  lines.push([b.name, b.headline, b.location, b.email, b.phone].filter(Boolean).join(' | '));
  if (b.summary) lines.push(b.summary);
  for (const l of b.links) lines.push(`${l.label}: ${l.url}`);
  if (r.experience.length) lines.push('EXPERIENCE');
  for (const e of r.experience) {
    lines.push(`${e.title} — ${e.company} (${e.start_date} – ${e.current ? 'Present' : e.end_date}) ${e.location}`);
    for (const h of e.highlights) lines.push(`- ${h}`);
  }
  if (r.education.length) lines.push('EDUCATION');
  for (const e of r.education) {
    lines.push(`${e.degree} ${e.field} — ${e.institution} (${e.start_date} – ${e.end_date}) ${e.gpa}`);
    for (const h of e.highlights) lines.push(`- ${h}`);
  }
  if (r.projects.length) lines.push('PROJECTS');
  for (const p of r.projects) {
    lines.push(`${p.name}${p.role ? ` (${p.role})` : ''}: ${p.technologies.join(', ')} ${p.url}`);
    for (const h of p.highlights) lines.push(`- ${h}`);
  }
  if (r.skills.length) lines.push(`SKILLS: ${r.skills.map((s) => s.name).join(', ')}`);
  if (r.certifications.length) lines.push('CERTIFICATIONS');
  for (const c of r.certifications) lines.push(`${c.name} — ${c.issuer} ${c.date}`);
  return lines.join('\n');
}

export interface ResumeCompleteness {
  score: number;
  missing: string[];
  warnings: string[];
}

/** Deterministic completeness check — complements (never replaces) the AI quality analysis. */
export function assessCompleteness(r: ResumeData): ResumeCompleteness {
  const missing: string[] = [];
  const warnings: string[] = [];
  let score = 0;
  const b = r.basics;
  const add = (ok: boolean, points: number, label: string) => {
    if (ok) score += points;
    else missing.push(label);
  };
  add(Boolean(b.name), 8, 'Full name');
  add(Boolean(b.email), 8, 'Email address');
  add(Boolean(b.phone), 5, 'Phone number');
  add(Boolean(b.location), 4, 'Location');
  add(b.summary.length >= 80, 10, 'Professional summary (2–3 sentences)');
  add(b.links.some((l) => /github|gitlab|portfolio|\.dev|\.io|vercel|netlify/i.test(l.url + l.label)), 7, 'Portfolio or GitHub link');
  add(r.education.length > 0, 12, 'Education');
  add(r.skills.length >= 6, 14, 'At least 6 technical skills');
  add(r.projects.length >= 2, 14, 'At least 2 projects');
  add(r.experience.length > 0 || r.projects.length >= 3, 10, 'Experience (internships, freelance or part-time work)');
  const bullets = [...r.experience.flatMap((e) => e.highlights), ...r.projects.flatMap((p) => p.highlights)];
  add(bullets.length >= 4, 8, 'Achievement bullets for experience/projects');
  if (bullets.length && !bullets.some((h) => /\d/.test(h))) {
    warnings.push('No bullet includes a measurable result (numbers, %, users, time saved).');
  }
  for (const p of r.projects) {
    if (!p.technologies.length) warnings.push(`Project "${p.name || 'Untitled'}" lists no technologies.`);
  }
  for (const e of r.experience) {
    if (!e.highlights.length) warnings.push(`Experience at "${e.company || 'Unknown'}" has no bullet points.`);
  }
  return { score: Math.min(100, score), missing, warnings };
}
