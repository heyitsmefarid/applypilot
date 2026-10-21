import type { SalaryPeriod, SourceKind } from '../constants.js';
import type { JobPreference } from '../schemas/preferences.js';
import { asArray, finalizeAll, num, type Obj, type RawJob, searchTermsFor, str } from './normalize.js';
import { USER_AGENT, type SourceAdapter, type SourceConfig, type SourceRequest } from './types.js';

const headers = { 'User-Agent': USER_AGENT, Accept: 'application/json' };

function request(source: SourceConfig, url: string, meta: Record<string, string> = {}): SourceRequest {
  return { source_key: source.key, kind: source.kind, url, method: 'GET', headers, meta };
}

function configList(source: SourceConfig, key: string): string[] {
  const v = source.config[key];
  if (Array.isArray(v)) return v.filter((x): x is string => typeof x === 'string' && x.trim() !== '').map((x) => x.trim());
  if (typeof v === 'string' && v.trim()) return v.split(',').map((x) => x.trim()).filter(Boolean);
  return [];
}

function termsFor(source: SourceConfig, prefs: JobPreference[], max: number): string[] {
  const configured = configList(source, 'search_terms');
  return configured.length ? configured.slice(0, max) : searchTermsFor(prefs, max);
}

const HIMALAYAS_PERIODS: Record<string, SalaryPeriod> = { annual: 'year', yearly: 'year', monthly: 'month', month: 'month', hourly: 'hour', hour: 'hour', weekly: 'week', daily: 'day' };

/** Remotive — official public API. Terms: attribute Remotive, link back, ≤ 4 requests/day. */
export const remotive: SourceAdapter = {
  kind: 'remotive',
  label: 'Remotive',
  access: 'Official public API (attribution + link-back required, max 4 requests/day)',
  officialApi: true,
  defaultMinIntervalMinutes: 360,
  buildRequests(source, prefs) {
    const terms = termsFor(source, prefs, 2);
    const limit = Number(source.config.limit ?? 100);
    // One broad category request plus up to two keyword searches stays within Remotive's guidance.
    return [
      request(source, `https://remotive.com/api/remote-jobs?category=software-dev&limit=${limit}`),
      ...terms.slice(0, 1).map((t) => request(source, `https://remotive.com/api/remote-jobs?search=${encodeURIComponent(t)}&limit=${limit}`, { term: t })),
    ];
  },
  normalize(body, req) {
    const raws: RawJob[] = asArray(body, 'jobs').map((j) => {
      const o = j as Obj;
      return {
        source_key: req.source_key,
        external_id: str(o.id),
        title: str(o.title),
        company: str(o.company_name),
        location: str(o.candidate_required_location) ?? 'Remote',
        candidate_locations: str(o.candidate_required_location),
        description_html: str(o.description),
        apply_url: str(o.url),
        posted_at: str(o.publication_date) ? `${str(o.publication_date)}Z` : null,
        tags: [...(Array.isArray(o.tags) ? (o.tags as string[]) : []), str(o.category) ?? ''],
        remote_flag: true,
        employment_hint: str(o.job_type),
        salary_text: str(o.salary) || null,
      };
    });
    return finalizeAll(raws);
  },
};

/** Arbeitnow — free public job board API (mostly EU/remote). */
export const arbeitnow: SourceAdapter = {
  kind: 'arbeitnow',
  label: 'Arbeitnow',
  access: 'Free public API (link-back appreciated)',
  officialApi: true,
  defaultMinIntervalMinutes: 60,
  buildRequests(source) {
    const pages = Math.min(3, Math.max(1, Number(source.config.pages ?? 1)));
    return Array.from({ length: pages }, (_, i) => request(source, `https://www.arbeitnow.com/api/job-board-api?page=${i + 1}`, { page: String(i + 1) }));
  },
  normalize(body, req) {
    const raws: RawJob[] = asArray(body, 'data').map((j) => {
      const o = j as Obj;
      const types = Array.isArray(o.job_types) ? (o.job_types as string[]) : [];
      return {
        source_key: req.source_key,
        external_id: str(o.slug),
        title: str(o.title),
        company: str(o.company_name),
        location: str(o.location),
        candidate_locations: o.remote === true ? null : str(o.location),
        description_html: str(o.description),
        apply_url: str(o.url),
        posted_at: num(o.created_at),
        tags: [...(Array.isArray(o.tags) ? (o.tags as string[]) : []), ...types],
        remote_flag: o.remote === true,
        employment_hint: types.find((t) => /intern|praktik|part|teilzeit|full|vollzeit|freelance|contract/i.test(t))?.replace(/praktikum/i, 'internship').replace(/teilzeit/i, 'part-time').replace(/vollzeit/i, 'full-time') ?? null,
      };
    });
    return finalizeAll(raws);
  },
};

/** Jobicy — free remote jobs API. Terms: credit Jobicy with a link; apply buttons must use the original URL. */
export const jobicy: SourceAdapter = {
  kind: 'jobicy',
  label: 'Jobicy',
  access: 'Free public API (credit + original apply link required)',
  officialApi: true,
  defaultMinIntervalMinutes: 180,
  buildRequests(source, prefs) {
    const geo = typeof source.config.geo === 'string' ? source.config.geo : '';
    const count = Number(source.config.count ?? 50);
    const tags = configList(source, 'tags');
    const list = tags.length ? tags : termsFor(source, prefs, 2).map((t) => t.split(' ')[0]!);
    return [...new Set(list)].slice(0, 3).map((tag) =>
      request(source, `https://jobicy.com/api/v2/remote-jobs?count=${count}&tag=${encodeURIComponent(tag)}${geo ? `&geo=${encodeURIComponent(geo)}` : ''}`, { tag }),
    );
  },
  normalize(body, req) {
    const raws: RawJob[] = asArray(body, 'jobs').map((j) => {
      const o = j as Obj;
      const min = num(o.annualSalaryMin ?? o.salaryMin);
      const max = num(o.annualSalaryMax ?? o.salaryMax);
      const period = str(o.salaryPeriod);
      return {
        source_key: req.source_key,
        external_id: str(o.id),
        title: str(o.jobTitle),
        company: str(o.companyName),
        location: str(o.jobGeo) ?? 'Remote',
        candidate_locations: str(o.jobGeo),
        description_html: str(o.jobDescription) ?? str(o.jobExcerpt),
        apply_url: str(o.url),
        posted_at: str(o.pubDate),
        tags: [...(Array.isArray(o.jobIndustry) ? (o.jobIndustry as string[]) : []), str(o.jobLevel) ?? ''],
        remote_flag: true,
        employment_hint: Array.isArray(o.jobType) ? (o.jobType as string[])[0] ?? null : str(o.jobType),
        salary_min: min,
        salary_max: max,
        salary_currency: min !== null || max !== null ? (str(o.salaryCurrency) ?? 'USD') : null,
        salary_period: min !== null || max !== null ? ((period && HIMALAYAS_PERIODS[period.toLowerCase()]) || 'year') : null,
      };
    });
    return finalizeAll(raws);
  },
};

/** Himalayas — free remote jobs API with explicit location restrictions. */
export const himalayas: SourceAdapter = {
  kind: 'himalayas',
  label: 'Himalayas',
  access: 'Free public API (cursor pagination)',
  officialApi: true,
  defaultMinIntervalMinutes: 120,
  buildRequests(source) {
    const limit = Math.min(20, Number(source.config.limit ?? 20));
    return [request(source, `https://himalayas.app/jobs/api?limit=${limit}`)];
  },
  normalize(body, req) {
    const raws: RawJob[] = asArray(body, 'jobs').map((j) => {
      const o = j as Obj;
      const restrictions = Array.isArray(o.locationRestrictions) ? (o.locationRestrictions as string[]) : [];
      const period = str(o.salaryPeriod);
      const min = num(o.minSalary);
      const max = num(o.maxSalary);
      return {
        source_key: req.source_key,
        external_id: str(o.guid) ?? str(o.applicationLink),
        title: str(o.title),
        company: str(o.companyName),
        location: restrictions.length ? restrictions.join(', ') : 'Worldwide',
        candidate_locations: restrictions.length ? restrictions.join(', ') : 'Worldwide',
        description_html: str(o.description) ?? str(o.excerpt),
        apply_url: str(o.applicationLink) ?? str(o.guid),
        posted_at: num(o.pubDate),
        expires_at: num(o.expiryDate),
        tags: [...(Array.isArray(o.categories) ? (o.categories as string[]) : []), ...(Array.isArray(o.seniority) ? (o.seniority as string[]) : [])],
        remote_flag: true,
        employment_hint: str(o.employmentType),
        level_hint: Array.isArray(o.seniority) ? (o.seniority as string[]).join(' ') : null,
        salary_min: min,
        salary_max: max,
        salary_currency: min !== null || max !== null ? str(o.currency) : null,
        salary_period: min !== null || max !== null ? ((period && HIMALAYAS_PERIODS[period.toLowerCase()]) || 'year') : null,
      };
    });
    return finalizeAll(raws);
  },
};

/** Greenhouse public Job Board API — one request per configured company board token. */
export const greenhouse: SourceAdapter = {
  kind: 'greenhouse',
  label: 'Greenhouse (company boards)',
  access: 'Official public Job Board API (read-only)',
  officialApi: true,
  defaultMinIntervalMinutes: 60,
  buildRequests(source) {
    return configList(source, 'boards')
      .slice(0, 25)
      .map((b) => request(source, `https://boards-api.greenhouse.io/v1/boards/${encodeURIComponent(b)}/jobs?content=true`, { board: b }));
  },
  normalize(body, req) {
    const company = req.meta.company ?? req.meta.board ?? 'Unknown';
    const raws: RawJob[] = asArray(body, 'jobs').map((j) => {
      const o = j as Obj;
      const loc = (o.location as Obj | undefined)?.name;
      const metadata = Array.isArray(o.metadata) ? (o.metadata as Obj[]) : [];
      const meta = (re: RegExp) => str(metadata.find((m) => re.test(String(m.name)))?.value);
      return {
        source_key: req.source_key,
        external_id: `${req.meta.board}:${str(o.id)}`,
        title: str(o.title),
        company: str(o.company_name) ?? company,
        location: str(loc),
        description_html: str(o.content),
        apply_url: str(o.absolute_url),
        posted_at: str(o.first_published) ?? str(o.updated_at),
        arrangement_hint: meta(/workplace|remote|location type/i),
        employment_hint: meta(/employment|commitment|type/i),
      };
    });
    return finalizeAll(raws);
  },
};

/** Lever public Postings API — one request per configured company slug. */
export const lever: SourceAdapter = {
  kind: 'lever',
  label: 'Lever (company boards)',
  access: 'Official public Postings API (read-only)',
  officialApi: true,
  defaultMinIntervalMinutes: 60,
  buildRequests(source) {
    return configList(source, 'companies')
      .slice(0, 25)
      .map((c) => request(source, `https://api.lever.co/v0/postings/${encodeURIComponent(c)}?mode=json`, { company: c }));
  },
  normalize(body, req) {
    const raws: RawJob[] = asArray(body).map((j) => {
      const o = j as Obj;
      const cat = (o.categories as Obj | undefined) ?? {};
      const lists = Array.isArray(o.lists) ? (o.lists as Obj[]) : [];
      const listText = lists.map((l) => `${str(l.text) ?? ''}\n${(str(l.content) ?? '').replace(/<li>/g, '\n- ').replace(/<[^>]+>/g, ' ')}`).join('\n\n');
      const sr = (o.salaryRange as Obj | undefined) ?? null;
      const interval = sr ? str(sr.interval) : null;
      return {
        source_key: req.source_key,
        external_id: `${req.meta.company}:${str(o.id)}`,
        title: str(o.text),
        company: req.meta.company_name ?? req.meta.company ?? 'Unknown',
        location: str(cat.location) ?? (Array.isArray(cat.allLocations) ? (cat.allLocations as string[]).join(', ') : null),
        description_text: `${str(o.descriptionPlain) ?? ''}\n\n${listText}\n\n${str(o.additionalPlain) ?? ''}`.trim(),
        apply_url: str(o.hostedUrl) ?? str(o.applyUrl),
        posted_at: num(o.createdAt),
        tags: [str(cat.team) ?? '', str(cat.department) ?? ''],
        arrangement_hint: str(o.workplaceType),
        employment_hint: str(cat.commitment),
        salary_min: sr ? num(sr.min) : null,
        salary_max: sr ? num(sr.max) : null,
        salary_currency: sr ? str(sr.currency) : null,
        salary_period: interval ? (/hour/i.test(interval) ? 'hour' : /month/i.test(interval) ? 'month' : 'year') : null,
      };
    });
    return finalizeAll(raws);
  },
};

/** Ashby public Job Board API — one request per configured organization. */
export const ashby: SourceAdapter = {
  kind: 'ashby',
  label: 'Ashby (company boards)',
  access: 'Official public Job Board API (read-only)',
  officialApi: true,
  defaultMinIntervalMinutes: 60,
  buildRequests(source) {
    return configList(source, 'organizations')
      .slice(0, 25)
      .map((org) => request(source, `https://api.ashbyhq.com/posting-api/job-board/${encodeURIComponent(org)}?includeCompensation=true`, { org }));
  },
  normalize(body, req) {
    const raws: RawJob[] = asArray(body, 'jobs').map((j) => {
      const o = j as Obj;
      const comp = (o.compensation as Obj | undefined) ?? null;
      const secondary = Array.isArray(o.secondaryLocations) ? (o.secondaryLocations as Obj[]).map((l) => str(l.location)).filter(Boolean) : [];
      const address = ((o.address as Obj | undefined)?.postalAddress as Obj | undefined) ?? {};
      return {
        source_key: req.source_key,
        external_id: `${req.meta.org}:${str(o.id)}`,
        title: str(o.title),
        company: req.meta.company_name ?? req.meta.org ?? 'Unknown',
        location: [str(o.location), ...secondary].filter(Boolean).join(', ') || str(address.addressCountry),
        description_text: str(o.descriptionPlain),
        description_html: str(o.descriptionHtml),
        apply_url: str(o.applyUrl) ?? str(o.jobUrl),
        posted_at: str(o.publishedAt),
        tags: [str(o.department) ?? '', str(o.team) ?? ''],
        remote_flag: o.isRemote === true ? true : null,
        arrangement_hint: str(o.workplaceType),
        employment_hint: str(o.employmentType)?.replace(/^FullTime$/, 'full_time').replace(/^PartTime$/, 'part_time').replace(/^Intern$/, 'internship') ?? null,
        salary_text: comp ? (str(comp.compensationTierSummary) ?? str(comp.scrapeableCompensationSalarySummary)) : null,
      };
    });
    return finalizeAll(raws);
  },
};

export const API_ADAPTERS: Partial<Record<SourceKind, SourceAdapter>> = {
  remotive,
  arbeitnow,
  jobicy,
  himalayas,
  greenhouse,
  lever,
  ashby,
};
