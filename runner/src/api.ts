import type { ResumeData } from '@applypilot/core';

export interface RunnerPayload {
  run_id: string;
  action: 'submit' | 'prefill';
  application: { id: string; company: string; job_title: string; apply_url: string; source_key: string | null };
  allowed_hosts: string[];
  applicant: { full_name: string; email: string; phone: string; location: string; linkedin_url: string; github_url: string; portfolio_url: string };
  resume: ResumeData;
  cover_letter: string;
  screening_answers: Array<{ question: string; answer: string; needs_user_input?: boolean }>;
}

export interface RunnerResult {
  outcome: 'submitted' | 'prefilled' | 'manual_required' | 'failed';
  confirmation_text?: string | null;
  confirmation_id?: string | null;
  final_url?: string | null;
  screenshots: string[];
  fields_filled: Array<{ field: string; value_preview: string }>;
  unanswered_questions: string[];
  captcha_detected: boolean;
  error?: string | null;
  duration_ms?: number;
}

/** Client for the Worker's /runner/* endpoints (RUNNER_API_TOKEN). */
export class RunnerApi {
  constructor(
    private baseUrl: string,
    private token: string,
  ) {
    if (!baseUrl) throw new Error('APPLYPILOT_API_URL is required');
    if (!token || token.length < 24) throw new Error('APPLYPILOT_RUNNER_TOKEN is required (min 24 chars)');
  }

  private async call<T>(path: string, init: RequestInit = {}): Promise<T> {
    const res = await fetch(`${this.baseUrl.replace(/\/$/, '')}/runner${path}`, {
      ...init,
      headers: { Authorization: `Bearer ${this.token}`, 'content-type': 'application/json', ...(init.headers ?? {}) },
      signal: AbortSignal.timeout(30_000),
    });
    const body = (await res.json().catch(() => ({}))) as T & { error?: { message?: string } };
    if (!res.ok) throw new Error(`Runner API ${path} → HTTP ${res.status}: ${body.error?.message ?? 'error'}`);
    return body;
  }

  next() {
    return this.call<{ job: { run_id: string } | null }>('/jobs/next');
  }
  payload(runId: string) {
    return this.call<RunnerPayload>(`/runs/${runId}`);
  }
  heartbeat(runId: string) {
    return this.call<{ cancel_requested: boolean; paused: boolean; running: boolean }>(`/runs/${runId}/heartbeat`, { method: 'POST', body: '{}' });
  }
  result(runId: string, result: RunnerResult) {
    return this.call<{ application_status: string; verified: boolean; message: string }>(`/runs/${runId}/result`, { method: 'POST', body: JSON.stringify(result) });
  }

  /** Uploads evidence straight to the private Supabase bucket via a one-time signed URL. */
  async uploadEvidence(runId: string, name: string, bytes: Uint8Array, contentType = 'image/png'): Promise<string> {
    const { signed_url, path } = await this.call<{ signed_url: string; path: string }>(`/runs/${runId}/evidence-url`, { method: 'POST', body: JSON.stringify({ name }) });
    const res = await fetch(signed_url, { method: 'PUT', headers: { 'content-type': contentType, 'x-upsert': 'true' }, body: bytes as BodyInit });
    if (!res.ok) throw new Error(`Evidence upload failed: HTTP ${res.status}`);
    return path;
  }
}
