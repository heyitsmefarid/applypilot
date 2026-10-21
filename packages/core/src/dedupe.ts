import type { NormalizedJob } from './schemas/job.js';
import { normalizeText } from './text.js';

const COMPANY_SUFFIXES = /\b(inc|incorporated|llc|ltd|limited|corp|corporation|co|company|gmbh|pte|plc|sa|bv|ag|opc|philippines|ph)\b/g;
const TITLE_NOISE = /\b(remote|hybrid|onsite|on site|urgent|hiring|wfh|work from home|immediate start|apply now)\b/g;

export function normalizeCompany(company: string): string {
  return normalizeText(company).replace(COMPANY_SUFFIXES, ' ').replace(/[.]/g, '').replace(/\s+/g, ' ').trim();
}

export function normalizeTitle(title: string): string {
  return normalizeText(title)
    .replace(/\(.*?\)|\[.*?\]/g, ' ')
    .replace(TITLE_NOISE, ' ')
    .replace(/\bsr\b/g, 'senior')
    .replace(/\bjr\b/g, 'junior')
    .replace(/\bfront end\b/g, 'frontend')
    .replace(/\bback end\b/g, 'backend')
    .replace(/\bfull stack\b/g, 'fullstack')
    .replace(/\s+/g, ' ')
    .trim();
}

function normalizeLocation(loc: string): string {
  const n = normalizeText(loc);
  if (!n || /\b(remote|anywhere|worldwide|global)\b/.test(n)) return 'remote';
  return n.split(/[,/|]/)[0]!.trim();
}

/** FNV-1a 64-bit (as hex) — fast, dependency-free, deterministic across runtimes. */
export function fnv1a64(input: string): string {
  let h = 0xcbf29ce484222325n;
  const prime = 0x100000001b3n;
  for (let i = 0; i < input.length; i++) {
    h ^= BigInt(input.charCodeAt(i));
    h = (h * prime) & 0xffffffffffffffffn;
  }
  return h.toString(16).padStart(16, '0');
}

/** Cross-source identity of a posting: same company + title + primary location. */
export function jobFingerprint(job: Pick<NormalizedJob, 'company' | 'title' | 'location'>): string {
  return fnv1a64(`${normalizeCompany(job.company)}|${normalizeTitle(job.title)}|${normalizeLocation(job.location)}`);
}

function completeness(job: NormalizedJob): number {
  let s = job.description.length > 200 ? 3 : 0;
  if (job.salary_min !== null || job.salary_max !== null) s += 2;
  if (job.posted_at) s += 1;
  if (job.candidate_locations) s += 1;
  if (job.requirements.length) s += 1;
  return s;
}

export interface DedupeResult {
  unique: NormalizedJob[];
  duplicates: Array<{ job: NormalizedJob; duplicateOf: string }>;
}

/**
 * Removes duplicates within a batch: exact `(source_key, external_id)` repeats and
 * cross-source repeats with the same fingerprint (keeps the most complete listing).
 */
export function dedupeJobs(jobs: NormalizedJob[]): DedupeResult {
  const byKey = new Map<string, NormalizedJob>();
  const duplicates: DedupeResult['duplicates'] = [];
  for (const job of jobs) {
    const fp = job.fingerprint ?? jobFingerprint(job);
    const withFp = { ...job, fingerprint: fp };
    const key = `${job.source_key}::${job.external_id}`;
    if (byKey.has(key)) {
      duplicates.push({ job: withFp, duplicateOf: key });
      continue;
    }
    byKey.set(key, withFp);
  }
  const byFp = new Map<string, NormalizedJob>();
  for (const job of byKey.values()) {
    const existing = byFp.get(job.fingerprint!);
    if (!existing) {
      byFp.set(job.fingerprint!, job);
    } else if (completeness(job) > completeness(existing)) {
      duplicates.push({ job: existing, duplicateOf: `${job.source_key}::${job.external_id}` });
      byFp.set(job.fingerprint!, job);
    } else {
      duplicates.push({ job, duplicateOf: `${existing.source_key}::${existing.external_id}` });
    }
  }
  return { unique: [...byFp.values()], duplicates };
}

export function postingAgeDays(postedAt: string | null | undefined, now = new Date()): number | null {
  if (!postedAt) return null;
  const t = Date.parse(postedAt);
  if (Number.isNaN(t)) return null;
  return Math.max(0, (now.getTime() - t) / 86_400_000);
}

/** A listing is expired when its deadline passed, or it is older than `staleAfterDays` (default 45). */
export function isExpired(
  job: Pick<NormalizedJob, 'posted_at' | 'expires_at'>,
  now = new Date(),
  staleAfterDays = 45,
): boolean {
  if (job.expires_at && Date.parse(job.expires_at) < now.getTime()) return true;
  const age = postingAgeDays(job.posted_at, now);
  return age !== null && age > staleAfterDays;
}
