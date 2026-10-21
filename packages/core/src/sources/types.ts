import type { SourceKind } from '../constants.js';
import type { NormalizedJob } from '../schemas/job.js';
import type { JobPreference } from '../schemas/preferences.js';

/** Mirrors a `job_sources` row. */
export interface SourceConfig {
  key: string;
  kind: SourceKind;
  name: string;
  enabled?: boolean;
  config: Record<string, unknown>;
}

/** An HTTP request n8n performs on behalf of an adapter. */
export interface SourceRequest {
  source_key: string;
  kind: SourceKind;
  url: string;
  method: 'GET';
  headers: Record<string, string>;
  /** Free-form context passed back to `normalize` (e.g. the Greenhouse board token). */
  meta: Record<string, string>;
}

export interface NormalizeResult {
  jobs: NormalizedJob[];
  rejected: Array<{ external_id: string; reason: string }>;
}

export interface SourceAdapter {
  kind: SourceKind;
  label: string;
  /** Short description of how access is authorized (shown in Integrations). */
  access: string;
  /** Whether this adapter calls an official public API (vs. alert parsing / manual import). */
  officialApi: boolean;
  defaultMinIntervalMinutes: number;
  buildRequests(source: SourceConfig, preferences: JobPreference[]): SourceRequest[];
  normalize(body: unknown, request: Pick<SourceRequest, 'source_key' | 'meta'>): NormalizeResult;
}

export const USER_AGENT = 'ApplyPilotAI/0.1 (personal job search assistant; +https://github.com/)';
