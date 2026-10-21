/**
 * Drop-in replacement for packages/core/src/schemas/job.ts inside the n8n Code-node bundle.
 * zod would add ~440 KB to every discovery workflow; full schema validation happens again in the
 * Worker's /internal/jobs/ingest endpoint, so n8n only needs these cheap structural checks.
 */
import type { NormalizedJob } from '../../packages/core/src/schemas/job.js';

export type { NormalizedJob, NormalizedJobInput, JobListing } from '../../packages/core/src/schemas/job.js';

type Result = { success: true; data: NormalizedJob } | { success: false; error: { issues: Array<{ path: string[]; message: string }> } };

const fail = (path: string, message: string): Result => ({ success: false, error: { issues: [{ path: [path], message }] } });

export const normalizedJobSchema = {
  safeParse(input: unknown): Result {
    const j = input as Record<string, unknown>;
    for (const k of ['source_key', 'external_id', 'title', 'company']) {
      if (typeof j[k] !== 'string' || !(j[k] as string).trim()) return fail(k, 'Required');
    }
    // n8n's Code-node sandbox has no global URL constructor, so use a pattern check here;
    // the Worker validates the URL strictly (z.url()) on ingest.
    if (!/^https?:\/\/[^\s/?#]+\.[^\s]*$/i.test(String(j.apply_url))) return fail('apply_url', 'Invalid URL');
    return { success: true, data: j as unknown as NormalizedJob };
  },
};
