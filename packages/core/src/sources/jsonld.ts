import type { SalaryPeriod } from '../constants.js';
import { decodeEntities } from '../text.js';
import { finalizeJob, num, type Obj, str } from './normalize.js';
import type { NormalizedJob } from '../schemas/job.js';

/**
 * Extracts schema.org JobPosting data from a career page's HTML.
 * Many company career sites and ATS pages embed this structured data for search engines,
 * which makes it a reliable, permission-friendly way to import a single job by URL.
 */
export function extractJobPostings(html: string): Obj[] {
  const out: Obj[] = [];
  const re = /<script[^>]+type=["']application\/ld\+json["'][^>]*>([\s\S]*?)<\/script>/gi;
  for (const m of html.matchAll(re)) {
    const raw = m[1]!.trim();
    let data: unknown;
    try {
      data = JSON.parse(raw);
    } catch {
      try {
        data = JSON.parse(decodeEntities(raw));
      } catch {
        continue;
      }
    }
    const visit = (node: unknown) => {
      if (Array.isArray(node)) return node.forEach(visit);
      if (!node || typeof node !== 'object') return;
      const o = node as Obj;
      const type = o['@type'];
      if (type === 'JobPosting' || (Array.isArray(type) && type.includes('JobPosting'))) out.push(o);
      if (o['@graph']) visit(o['@graph']);
    };
    visit(data);
  }
  return out;
}

function addressText(loc: unknown): string {
  const list = Array.isArray(loc) ? loc : [loc];
  return list
    .map((l) => {
      const a = ((l as Obj | undefined)?.address ?? l) as Obj | string | undefined;
      if (typeof a === 'string') return a;
      if (!a) return '';
      return [str(a.addressLocality), str(a.addressRegion), typeof a.addressCountry === 'string' ? a.addressCountry : str((a.addressCountry as Obj | undefined)?.name)]
        .filter(Boolean)
        .join(', ');
    })
    .filter(Boolean)
    .join(' / ');
}

const UNIT_TO_PERIOD: Record<string, SalaryPeriod> = { HOUR: 'hour', DAY: 'day', WEEK: 'week', MONTH: 'month', YEAR: 'year' };

export function jobPostingToNormalized(p: Obj, pageUrl: string, sourceKey = 'manual'): { job: NormalizedJob } | { error: string } {
  const org = p.hiringOrganization as Obj | string | undefined;
  const company = typeof org === 'string' ? org : str(org?.name);
  const salary = p.baseSalary as Obj | undefined;
  const value = (salary?.value as Obj | undefined) ?? undefined;
  const unit = str(value?.unitText)?.toUpperCase();
  const applicantReq = p.applicantLocationRequirements;
  const remote = str(p.jobLocationType)?.toUpperCase() === 'TELECOMMUTE';
  const identifier = p.identifier as Obj | string | undefined;
  const id = typeof identifier === 'string' ? identifier : str(identifier?.value);
  const employment = Array.isArray(p.employmentType) ? (p.employmentType as string[])[0] : str(p.employmentType);
  return finalizeJob({
    source_key: sourceKey,
    external_id: id ?? str(p.url) ?? pageUrl,
    title: str(p.title),
    company,
    company_url: typeof org === 'object' ? str(org?.sameAs) ?? str(org?.url) : null,
    location: addressText(p.jobLocation) || (remote ? 'Remote' : ''),
    candidate_locations: applicantReq ? addressText(applicantReq) || str((applicantReq as Obj).name) : null,
    description_html: str(p.description),
    apply_url: str(p.url) ?? pageUrl,
    posted_at: str(p.datePosted),
    expires_at: str(p.validThrough),
    remote_flag: remote || null,
    employment_hint: employment?.toLowerCase().replace('_', ' ') ?? null,
    salary_min: num(value?.minValue ?? value?.value),
    salary_max: num(value?.maxValue ?? value?.value),
    salary_currency: str(salary?.currency),
    salary_period: unit ? (UNIT_TO_PERIOD[unit] ?? null) : null,
  });
}

/** Fallback when a page has no JobPosting data: title/company from Open Graph tags. */
export function openGraphFallback(html: string, pageUrl: string): { title: string | null; site: string | null; description: string | null } {
  const meta = (prop: string) => {
    const m = html.match(new RegExp(`<meta[^>]+(?:property|name)=["']${prop}["'][^>]+content=["']([^"']*)["']`, 'i')) ??
      html.match(new RegExp(`<meta[^>]+content=["']([^"']*)["'][^>]+(?:property|name)=["']${prop}["']`, 'i'));
    return m?.[1] ? decodeEntities(m[1]) : null;
  };
  const title = meta('og:title') ?? html.match(/<title[^>]*>([^<]*)<\/title>/i)?.[1]?.trim() ?? null;
  let site = meta('og:site_name');
  if (!site) {
    try {
      site = new URL(pageUrl).hostname.replace(/^www\./, '');
    } catch {
      site = null;
    }
  }
  return { title, site, description: meta('og:description') ?? meta('description') };
}
