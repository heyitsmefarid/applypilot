import type { EmploymentType, ExperienceLevel, PhEligibility, WorkArrangement } from './constants.js';
import { normalizeText } from './text.js';

export function inferWorkArrangement(...texts: Array<string | null | undefined | boolean>): WorkArrangement {
  const t = texts.filter((x) => typeof x === 'string').join(' ').toLowerCase();
  if (/\bhybrid\b/.test(t)) return 'hybrid';
  if (/\b(fully remote|100% remote|remote[- ]first|work from home|wfh|remote)\b|telecommute|anywhere/.test(t)) {
    if (/\b(not remote|no remote|onsite only|on-site only)\b/.test(t)) return 'onsite';
    return 'remote';
  }
  if (/\b(on[- ]?site|in[- ]office|office[- ]based|in person|skeleton)\b/.test(t)) return 'onsite';
  return 'unknown';
}

export function inferEmploymentType(...texts: Array<string | null | undefined>): EmploymentType {
  const t = texts.filter(Boolean).join(' ').toLowerCase();
  if (/\b(intern|internship|ojt|on[- ]the[- ]job training|practicum|trainee)\b/.test(t)) return 'internship';
  if (/\bfreelanc/.test(t)) return 'freelance';
  if (/\bpart[- _]?time\b/.test(t)) return 'part_time';
  if (/\b(contract|contractor|temporary|project[- ]based)\b/.test(t)) return 'contract';
  if (/\bfull[- _]?time\b|\bpermanent\b/.test(t)) return 'full_time';
  return 'unknown';
}

/** Parses the strongest "N+ years" requirement in a text (returns null if none). */
export function extractRequiredYears(text: string): number | null {
  const re = /(\d{1,2})\s*(?:\+|plus)?\s*(?:-\s*\d{1,2}\s*)?(?:years?|yrs?)(?:\s+of)?(?:\s+\w+){0,4}\s+(?:experience|exp\b)/gi;
  let best: number | null = null;
  for (const m of text.matchAll(re)) {
    const n = parseInt(m[1]!, 10);
    if (n <= 20 && (best === null || n > best)) best = n;
  }
  if (best === null) {
    const minRe = /(?:minimum|at least|min\.?)\s+(?:of\s+)?(\d{1,2})\s*(?:years?|yrs?)/gi;
    for (const m of text.matchAll(minRe)) {
      const n = parseInt(m[1]!, 10);
      if (n <= 20 && (best === null || n > best)) best = n;
    }
  }
  return best;
}

export function inferExperienceLevel(title: string, description = ''): ExperienceLevel {
  const t = title.toLowerCase();
  if (/\b(intern|internship|ojt|trainee|apprentice)\b/.test(t)) return 'internship';
  if (/\b(senior|sr\.?|staff|principal|lead|head|director|architect|manager)\b/.test(t)) return 'senior';
  if (/\b(junior|jr\.?|entry[- ]level|graduate|associate|new grad)\b/.test(t)) return 'junior';
  if (/\b(mid|intermediate|ii|level 2)\b/.test(t)) return 'mid';
  const years = extractRequiredYears(description);
  if (years !== null) {
    if (years <= 1) return 'entry';
    if (years <= 2) return 'junior';
    if (years <= 4) return 'mid';
    return 'senior';
  }
  if (/\b(entry[- ]level|no experience required|fresh graduates?)\b/i.test(description)) return 'entry';
  return 'unknown';
}

/** Detects stated internship/OJT hour capacity such as "600 hours" or "minimum of 486 hrs". */
export function extractOjtHours(text: string): number | null {
  const re = /(\d{2,4})\s*(?:\+)?\s*(?:training\s+|ojt\s+|internship\s+|rendered\s+)?(?:hours|hrs)\b/gi;
  let best: number | null = null;
  for (const m of text.matchAll(re)) {
    const n = parseInt(m[1]!, 10);
    const ctx = text.slice(Math.max(0, (m.index ?? 0) - 80), (m.index ?? 0) + 80).toLowerCase();
    if (n >= 100 && n <= 2000 && /\b(ojt|intern|internship|practicum|training|required hours|render)/.test(ctx)) {
      if (best === null || n > best) best = n;
    }
  }
  return best;
}

const PH_POSITIVE = [
  'philippines',
  'philippine',
  'filipino',
  'manila',
  'metro manila',
  'ncr',
  'cebu',
  'davao',
  'worldwide',
  'anywhere',
  'global',
  'apac',
  'asia',
  'southeast asia',
  'sea',
  'asia pacific',
  'emea apac',
  'utc+8',
  'gmt+8',
];

const RESTRICTIVE_REGIONS = [
  'usa',
  'us only',
  'united states',
  'u.s.',
  'canada',
  'uk',
  'united kingdom',
  'europe',
  'eu',
  'emea',
  'germany',
  'latam',
  'latin america',
  'americas',
  'north america',
  'india',
  'australia',
  'new zealand',
  'brazil',
  'mexico',
  'poland',
  'spain',
  'france',
  'netherlands',
  'japan',
  'south africa',
  'nigeria',
  'kenya',
];

/**
 * Determines whether a remote job accepts applicants from the Philippines.
 * Unknown is returned whenever the evidence is not explicit — it is never treated as eligible.
 */
export function assessPhEligibility(candidateLocations: string | null | undefined, description = ''): PhEligibility {
  const loc = ` ${normalizeText(candidateLocations ?? '')} `;
  const has = (needle: string) => loc.includes(` ${needle} `) || loc.includes(` ${needle},`);
  if (loc.trim()) {
    if (PH_POSITIVE.some((p) => has(normalizeText(p)))) return 'eligible';
    if (RESTRICTIVE_REGIONS.some((r) => has(normalizeText(r)))) return 'ineligible';
  }
  const d = description.toLowerCase();
  if (/\b(philippines|filipino|ph[- ]based)\b/.test(d)) return 'eligible';
  if (/\b(must (be|reside|live) in|only (accept|hiring)|located in|authori[sz]ed to work in) (the )?(us|usa|united states|uk|eu|canada|europe)/.test(d)) {
    return 'ineligible';
  }
  if (/\b(us|usa|u\.s\.) (citizens?|residents?) only\b|\bus[- ]only\b/.test(d)) return 'ineligible';
  return 'unknown';
}

const LOCATION_ALIASES: Record<string, string[]> = {
  'quezon city': ['qc', 'quezon city', 'q.c.', 'cubao', 'eastwood', 'diliman', 'ugong norte', 'novaliches', 'katipunan', 'vertis north'],
  makati: ['makati', 'makati city', 'ayala', 'legaspi village', 'salcedo village', 'rockwell', 'poblacion makati'],
  pasig: ['pasig', 'pasig city', 'ortigas', 'ortigas center', 'kapitolyo', 'bridgetowne', 'tiendesitas'],
  taguig: ['taguig', 'bgc', 'bonifacio global city', 'mckinley hill', 'uptown bonifacio'],
  mandaluyong: ['mandaluyong', 'shaw boulevard', 'greenfield', 'ortigas mandaluyong'],
  manila: ['manila', 'city of manila', 'ermita', 'malate', 'intramuros', 'sampaloc'],
};

export type LocationMatch = 'match' | 'mismatch' | 'ambiguous' | 'unknown';

/** Matches a job location against preferred city names, understanding district names (e.g. Ortigas → Pasig). */
export function matchPreferredLocation(jobLocation: string | null | undefined, preferred: string[]): LocationMatch {
  const loc = normalizeText(jobLocation ?? '');
  if (!loc) return 'unknown';
  if (!preferred.length) return 'match';
  for (const pref of preferred) {
    const key = normalizeText(pref);
    const aliases = LOCATION_ALIASES[key] ?? [key];
    if (aliases.some((a) => ` ${loc} `.includes(` ${normalizeText(a)} `))) return 'match';
  }
  // Ortigas Center straddles Pasig and Mandaluyong; "Metro Manila"/"NCR" alone is ambiguous.
  if (/\b(metro manila|ncr|national capital region|ortigas)\b/.test(loc)) return 'ambiguous';
  if (/\b(philippines|ph)\b/.test(loc) && loc.split(' ').length <= 2) return 'ambiguous';
  return 'mismatch';
}
