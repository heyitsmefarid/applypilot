import { normalizeText } from './text.js';

/** Canonical name → aliases. Used for normalization and deterministic skill matching. */
const SKILL_ALIASES: Record<string, string[]> = {
  javascript: ['js', 'ecmascript', 'es6', 'es2015', 'vanilla js'],
  typescript: ['ts'],
  react: ['reactjs', 'react.js', 'react js'],
  'react native': ['react-native', 'rn'],
  'next.js': ['nextjs', 'next js', 'next'],
  'vue.js': ['vue', 'vuejs', 'vue js'],
  'nuxt.js': ['nuxt', 'nuxtjs'],
  angular: ['angularjs', 'angular.js'],
  svelte: ['sveltekit'],
  'node.js': ['node', 'nodejs', 'node js'],
  'express.js': ['express', 'expressjs'],
  nestjs: ['nest.js', 'nest'],
  python: ['py', 'python3'],
  django: [],
  flask: [],
  fastapi: [],
  java: [],
  'spring boot': ['spring', 'springboot'],
  kotlin: [],
  swift: ['swiftui'],
  dart: [],
  flutter: [],
  php: [],
  laravel: [],
  'c#': ['csharp', 'c sharp'],
  '.net': ['dotnet', 'asp.net', '.net core', 'asp.net core'],
  'c++': ['cpp'],
  c: [],
  go: ['golang'],
  rust: [],
  ruby: [],
  'ruby on rails': ['rails', 'ror'],
  html: ['html5'],
  css: ['css3'],
  sass: ['scss'],
  'tailwind css': ['tailwind', 'tailwindcss'],
  bootstrap: [],
  sql: [],
  postgresql: ['postgres', 'psql'],
  mysql: ['mariadb'],
  mongodb: ['mongo'],
  sqlite: [],
  redis: [],
  firebase: ['firestore'],
  supabase: [],
  graphql: [],
  'rest api': ['rest', 'restful', 'restful api', 'rest apis', 'restful apis'],
  git: [],
  github: [],
  gitlab: [],
  docker: [],
  kubernetes: ['k8s'],
  aws: ['amazon web services'],
  gcp: ['google cloud', 'google cloud platform'],
  azure: ['microsoft azure'],
  'cloudflare workers': ['cloudflare'],
  linux: [],
  'ci/cd': ['cicd', 'ci cd', 'continuous integration'],
  jest: [],
  vitest: [],
  playwright: [],
  cypress: [],
  figma: [],
  redux: ['redux toolkit'],
  'jquery': [],
  android: ['android development'],
  ios: ['ios development'],
  'machine learning': ['ml'],
  'n8n': [],
  'agile': ['scrum'],
};

const aliasIndex = new Map<string, string>();
for (const [canonical, aliases] of Object.entries(SKILL_ALIASES)) {
  aliasIndex.set(normalizeText(canonical), canonical);
  for (const a of aliases) aliasIndex.set(normalizeText(a), canonical);
}

/** Returns a canonical, lowercase skill name ("ReactJS" → "react"). Unknown skills are just normalized. */
export function normalizeSkill(skill: string): string {
  const n = normalizeText(skill).replace(/\s*\(.*\)$/, '');
  return aliasIndex.get(n) ?? n;
}

export function isKnownSkill(skill: string): boolean {
  return aliasIndex.has(normalizeText(skill));
}

function escapeRegExp(s: string): string {
  return s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

/** Word-boundary aware search that also works for skills such as "c#", "c++" and ".net". */
function containsTerm(haystack: string, term: string): boolean {
  if (!term) return false;
  const pattern = new RegExp(`(^|[^a-z0-9+#])${escapeRegExp(term)}(?![a-z0-9+#])`, 'i');
  return pattern.test(haystack);
}

/**
 * Finds known technical skills mentioned in free text.
 * Single letters ("c") and the ambiguous "go"/"next"/"nest"/"spring"/"rest" aliases need
 * stronger context, so they are only matched in their canonical or explicit form.
 */
export function extractSkillsFromText(text: string, extraVocabulary: string[] = []): string[] {
  const hay = ` ${normalizeText(text)} `;
  const found = new Set<string>();
  const ambiguous = new Set(['c', 'go', 'next', 'nest', 'spring', 'rest', 'swift', 'rn', 'ts', 'js', 'py', 'ml', 'express', 'node', 'scrum', 'agile']);
  for (const [alias, canonical] of aliasIndex) {
    if (ambiguous.has(alias)) continue;
    if (containsTerm(hay, alias)) found.add(canonical);
  }
  if (/\bgolang\b|\bgo (developer|engineer|language)\b|\bin go\b/i.test(text)) found.add('go');
  if (/\bnode(\.js|js)?\b/i.test(text) && /\b(node\.js|nodejs|node js|node backend|node developer)\b/i.test(text)) found.add('node.js');
  if (/\bexpress(\.js|js)?\b/i.test(text) && /\b(express\.js|expressjs|node\b)/i.test(text)) found.add('express.js');
  if (/\brest(ful)?\s+api/i.test(text)) found.add('rest api');
  // Capitalized only: "swift onboarding" is an adjective, "Swift" is the language.
  if (/\bSwift(UI)?\b/.test(text)) found.add('swift');
  for (const v of extraVocabulary) {
    const n = normalizeSkill(v);
    if (n.length > 1 && containsTerm(hay, normalizeText(v))) found.add(n);
  }
  return [...found].sort();
}

export interface SkillOverlap {
  matched: string[];
  missing: string[];
  ratio: number;
}

/**
 * Compares the candidate's verified skills with skills required by a job.
 * `jobSkills` and `candidateSkills` may be in any spelling.
 */
export function compareSkills(candidateSkills: string[], jobSkills: string[]): SkillOverlap {
  const have = new Set(candidateSkills.map(normalizeSkill));
  const need = [...new Set(jobSkills.map(normalizeSkill))].filter(Boolean);
  const matched = need.filter((s) => have.has(s));
  const missing = need.filter((s) => !have.has(s));
  return { matched, missing, ratio: need.length ? matched.length / need.length : 0 };
}
