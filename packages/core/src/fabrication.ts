import type { ResumeData } from './schemas/resume.js';
import { resumeToText } from './schemas/resume.js';
import { normalizeSkill } from './skills.js';
import { normalizeText } from './text.js';

export interface FabricationViolation {
  section: 'basics' | 'experience' | 'education' | 'projects' | 'skills' | 'certifications' | 'metrics';
  item: string;
  action: 'removed' | 'restored' | 'flagged';
  reason: string;
}

export interface FabricationGuardResult {
  resume: ResumeData;
  violations: FabricationViolation[];
}


/** Numbers like "40%", "3x", "1,200 users", "10k" — any figure must exist in the source resume. */
function metricTokens(text: string): string[] {
  return [...text.matchAll(/\d[\d,.]*\s*(%|x\b|k\b|\+)?/gi)].map((m) => m[0].replace(/[,\s]/g, '').toLowerCase());
}

function similar(a: string, b: string): boolean {
  const na = normalizeText(a);
  const nb = normalizeText(b);
  if (!na || !nb) return false;
  return na === nb || na.includes(nb) || nb.includes(na);
}

/**
 * Compares an AI-produced resume against the verified source and removes anything the
 * source cannot support. This runs on every enhancement and tailoring result.
 */
export function guardAgainstFabrication(source: ResumeData, candidate: ResumeData): FabricationGuardResult {
  const violations: FabricationViolation[] = [];
  const sourceText = normalizeText(resumeToText(source));
  const sourceMetrics = new Set(metricTokens(resumeToText(source)));
  const out: ResumeData = structuredClone(candidate);

  // Basics: identity and contact details always come from the source.
  for (const f of ['name', 'email', 'phone', 'location'] as const) {
    if (out.basics[f] !== source.basics[f]) {
      if (out.basics[f]) violations.push({ section: 'basics', item: f, action: 'restored', reason: `${f} must match the verified resume.` });
      out.basics[f] = source.basics[f];
    }
  }
  const sourceUrls = new Set(source.basics.links.map((l) => l.url.trim().toLowerCase()));
  out.basics.links = out.basics.links.filter((l) => {
    const ok = sourceUrls.has(l.url.trim().toLowerCase());
    if (!ok) violations.push({ section: 'basics', item: l.url, action: 'removed', reason: 'Link not present in source resume.' });
    return ok;
  });

  // Experience: employer + title must exist; dates are restored from the source.
  out.experience = out.experience.filter((e) => {
    const match = source.experience.find((s) => similar(s.company, e.company) && similar(s.title, e.title));
    if (!match) {
      violations.push({ section: 'experience', item: `${e.title} at ${e.company}`, action: 'removed', reason: 'Employer/title not in source resume.' });
      return false;
    }
    if (e.start_date !== match.start_date || e.end_date !== match.end_date || e.current !== match.current) {
      violations.push({ section: 'experience', item: `${e.title} at ${e.company}`, action: 'restored', reason: 'Dates restored from source.' });
    }
    e.company = match.company;
    e.title = match.title;
    e.start_date = match.start_date;
    e.end_date = match.end_date;
    e.current = match.current;
    return true;
  });

  out.education = out.education.filter((e) => {
    const match = source.education.find((s) => similar(s.institution, e.institution));
    if (!match) {
      violations.push({ section: 'education', item: e.institution, action: 'removed', reason: 'Institution not in source resume.' });
      return false;
    }
    if (e.degree !== match.degree || e.gpa !== match.gpa || e.start_date !== match.start_date || e.end_date !== match.end_date) {
      violations.push({ section: 'education', item: e.institution, action: 'restored', reason: 'Degree, GPA and dates restored from source.' });
    }
    Object.assign(e, { institution: match.institution, degree: match.degree, field: match.field, gpa: match.gpa, start_date: match.start_date, end_date: match.end_date });
    return true;
  });

  out.certifications = out.certifications.filter((c) => {
    const ok = source.certifications.some((s) => similar(s.name, c.name));
    if (!ok) violations.push({ section: 'certifications', item: c.name, action: 'removed', reason: 'Certification not in source resume.' });
    return ok;
  });

  // Skills: must be listed in the source skills or literally mentioned somewhere in the source text.
  const sourceSkills = new Set(source.skills.map((s) => normalizeSkill(s.name)));
  const supported = (skill: string) => {
    const n = normalizeSkill(skill);
    return sourceSkills.has(n) || ` ${sourceText} `.includes(` ${normalizeText(skill)} `);
  };
  out.skills = out.skills.filter((s) => {
    const ok = supported(s.name);
    if (!ok) violations.push({ section: 'skills', item: s.name, action: 'removed', reason: 'Skill not evidenced in source resume.' });
    return ok;
  });

  out.projects = out.projects.filter((p) => {
    const match = source.projects.find((s) => similar(s.name, p.name));
    if (!match) {
      violations.push({ section: 'projects', item: p.name, action: 'removed', reason: 'Project not in source resume.' });
      return false;
    }
    p.name = match.name;
    p.url = match.url;
    const srcTech = new Set([...match.technologies.map(normalizeSkill), ...sourceSkills]);
    p.technologies = p.technologies.filter((t) => {
      const ok = srcTech.has(normalizeSkill(t)) || supported(t);
      if (!ok) violations.push({ section: 'projects', item: `${p.name}: ${t}`, action: 'removed', reason: 'Technology not evidenced in source.' });
      return ok;
    });
    return true;
  });

  // Metrics: drop bullets that introduce numbers not found anywhere in the source.
  const scrub = (bullets: string[], where: string) =>
    bullets.filter((b) => {
      const novel = metricTokens(b).filter((m) => !sourceMetrics.has(m));
      if (novel.length) {
        violations.push({ section: 'metrics', item: `${where}: "${b.slice(0, 120)}"`, action: 'removed', reason: `Introduces unverified figure(s): ${novel.join(', ')}.` });
        return false;
      }
      return true;
    });
  for (const e of out.experience) e.highlights = scrub(e.highlights, e.company);
  for (const p of out.projects) p.highlights = scrub(p.highlights, p.name);
  for (const e of out.education) e.highlights = scrub(e.highlights, e.institution);
  const summaryNovel = metricTokens(out.basics.summary).filter((m) => !sourceMetrics.has(m));
  if (summaryNovel.length) {
    violations.push({ section: 'metrics', item: 'summary', action: 'restored', reason: `Summary introduced unverified figure(s): ${summaryNovel.join(', ')}.` });
    out.basics.summary = source.basics.summary;
  }

  return { resume: out, violations };
}

/** Lists the skills a job wants that the verified resume cannot support (for "missing" displays). */
export function unsupportedSkills(source: ResumeData, skills: string[]): string[] {
  const text = ` ${normalizeText(resumeToText(source))} `;
  const have = new Set(source.skills.map((s) => normalizeSkill(s.name)));
  return skills.filter((s) => !have.has(normalizeSkill(s)) && !text.includes(` ${normalizeText(s)} `));
}

// Exported for tests.
export const __testing = { metricTokens };
