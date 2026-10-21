import type { SourceKind } from '../constants.js';
import type { JobPreference } from '../schemas/preferences.js';
import { API_ADAPTERS } from './adapters.js';
import type { NormalizeResult, SourceAdapter, SourceConfig, SourceRequest } from './types.js';

export * from './adapters.js';
export * from './gmail-alerts.js';
export * from './jsonld.js';
export { finalizeJob, finalizeAll, searchTermsFor, type RawJob } from './normalize.js';
export * from './types.js';

export interface SourceDescriptor {
  kind: SourceKind;
  label: string;
  access: string;
  officialApi: boolean;
  automation: 'api' | 'alerts' | 'manual';
  note: string;
}

/** Every platform from the brief and how ApplyPilot accesses it (shown in Integrations). */
export const SOURCE_CATALOG: SourceDescriptor[] = [
  { kind: 'remotive', label: 'Remotive', access: 'Official API', officialApi: true, automation: 'api', note: 'Max 4 fetches/day; listings credited and linked to Remotive.' },
  { kind: 'arbeitnow', label: 'Arbeitnow', access: 'Official API', officialApi: true, automation: 'api', note: 'Hourly updates; mostly EU roles.' },
  { kind: 'jobicy', label: 'Jobicy', access: 'Official API', officialApi: true, automation: 'api', note: 'Remote roles; apply via original link.' },
  { kind: 'himalayas', label: 'Himalayas', access: 'Official API', officialApi: true, automation: 'api', note: 'Remote roles with explicit location restrictions.' },
  { kind: 'greenhouse', label: 'Company careers (Greenhouse)', access: 'Public Job Board API', officialApi: true, automation: 'api', note: 'Add company board tokens.' },
  { kind: 'lever', label: 'Company careers (Lever)', access: 'Public Postings API', officialApi: true, automation: 'api', note: 'Add company slugs.' },
  { kind: 'ashby', label: 'Company careers (Ashby)', access: 'Public Job Board API', officialApi: true, automation: 'api', note: 'Add organization names.' },
  { kind: 'gmail_alert', label: 'LinkedIn · Indeed · JobStreet · OnlineJobs.ph · Kalibrr', access: 'Job-alert emails via Gmail API', officialApi: false, automation: 'alerts', note: 'No scraping: jobs are imported from alert emails these platforms send you.' },
  { kind: 'manual', label: 'Any career page', access: 'Manual URL import (schema.org JobPosting)', officialApi: false, automation: 'manual', note: 'Paste a job URL; structured data is read once on your request.' },
];

export function getAdapter(kind: SourceKind): SourceAdapter | undefined {
  return API_ADAPTERS[kind];
}

export interface PlannedSource {
  source: SourceConfig;
  requests: SourceRequest[];
  skipped?: string;
}

/**
 * Builds the HTTP requests for a discovery run, honouring each source's minimum interval
 * (rate limits and API terms) unless `force` is set for a manual run.
 */
export function planDiscovery(
  sources: Array<SourceConfig & { last_run_at?: string | null }>,
  preferences: JobPreference[],
  opts: { now?: Date; force?: boolean } = {},
): PlannedSource[] {
  const now = opts.now ?? new Date();
  return sources
    .filter((s) => s.enabled !== false)
    .map((source) => {
      const adapter = getAdapter(source.kind);
      if (!adapter) return { source, requests: [], skipped: 'No API adapter (alerts/manual source).' };
      const minInterval = Number(source.config.min_interval_minutes ?? adapter.defaultMinIntervalMinutes);
      if (!opts.force && source.last_run_at) {
        const elapsed = (now.getTime() - Date.parse(source.last_run_at)) / 60000;
        // Remotive's terms forbid frequent fetches, so even manual runs respect its interval.
        if (elapsed < minInterval) return { source, requests: [], skipped: `Rate limit: next fetch in ${Math.ceil(minInterval - elapsed)} min.` };
      } else if (opts.force && source.kind === 'remotive' && source.last_run_at) {
        const elapsed = (now.getTime() - Date.parse(source.last_run_at)) / 60000;
        if (elapsed < minInterval) return { source, requests: [], skipped: `Remotive allows at most 4 fetches/day; next in ${Math.ceil(minInterval - elapsed)} min.` };
      }
      const requests = adapter.buildRequests(source, preferences);
      return { source, requests, skipped: requests.length ? undefined : 'Nothing configured (add boards/companies).' };
    });
}

/** Normalizes one fetched response body. Unknown kinds return an empty result. */
export function normalizeResponse(kind: SourceKind, body: unknown, request: Pick<SourceRequest, 'source_key' | 'meta'>): NormalizeResult {
  const adapter = getAdapter(kind);
  if (!adapter) return { jobs: [], rejected: [] };
  return adapter.normalize(body, request);
}
