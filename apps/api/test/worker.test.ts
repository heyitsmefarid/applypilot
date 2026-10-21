import { PROMPTS, resumeDataSchema } from '@applypilot/core';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { GeminiClient, GeminiError, interactionText, parseJsonLoose } from '../src/ai/gemini.js';
import { AiBudgetError, runAi } from '../src/ai/run.js';
import type { Env } from '../src/env.js';
import { app } from '../src/index.js';
import { decryptSecret, encryptSecret, signToken, verifyToken } from '../src/lib/crypto.js';
import { resetBuckets, takeToken } from '../src/lib/ratelimit.js';
import { fakeDb } from './fake-db.js';

const KEY = btoa(String.fromCharCode(...new Uint8Array(32).map((_, i) => i + 1)));

const env = {
  APP_URL: 'http://localhost:5173',
  CORS_ORIGINS: 'http://localhost:5173',
  SUPABASE_URL: 'https://example.supabase.co',
  SUPABASE_SECRET_KEY: 'sb_secret_test',
  GEMINI_API_KEY: 'test-key',
  GEMINI_MODEL_FAST: 'gemini-3.5-flash-lite',
  GEMINI_MODEL_QUALITY: 'gemini-3.8-flash',
  GEMINI_API_STYLE: 'interactions',
  GEMINI_RPM: '10',
  INTERNAL_API_TOKEN: 'internal-token-internal-token-123',
  RUNNER_API_TOKEN: 'runner-token-runner-token-runner-1',
  TOKEN_ENCRYPTION_KEY: KEY,
  STATE_SIGNING_KEY: 'state-secret',
  GITHUB_WORKFLOW: 'apply-runner.yml',
  GITHUB_REF: 'main',
  RUNNER_ALLOWED_HOSTS: 'localhost',
} as Env;

beforeEach(() => resetBuckets());

describe('crypto', () => {
  it('round-trips AES-GCM secrets with random IVs', async () => {
    const a = await encryptSecret('refresh-token-123', KEY);
    const b = await encryptSecret('refresh-token-123', KEY);
    expect(a).not.toBe(b);
    expect(a.startsWith('v1.')).toBe(true);
    expect(await decryptSecret(a, KEY)).toBe('refresh-token-123');
  });
  it('rejects tampered ciphertext', async () => {
    const a = await encryptSecret('secret', KEY);
    const tampered = a.slice(0, -4) + (a.endsWith('AAAA') ? 'BBBB' : 'AAAA');
    await expect(decryptSecret(tampered, KEY)).rejects.toThrow();
  });
  it('signs and verifies expiring state tokens', async () => {
    const t = await signToken({ uid: 'u1' }, 'k', 60);
    expect(await verifyToken(t, 'k')).toMatchObject({ uid: 'u1' });
    expect(await verifyToken(t, 'other')).toBeNull();
    expect(await verifyToken(`${t.split('.')[0]}.bad`, 'k')).toBeNull();
    const expired = await signToken({ uid: 'u1' }, 'k', -10);
    expect(await verifyToken(expired, 'k')).toBeNull();
  });
});

describe('rate limiter', () => {
  it('allows bursts up to capacity then refills', () => {
    const t0 = 1_000_000;
    for (let i = 0; i < 3; i++) expect(takeToken('k', 3, 1, t0).ok).toBe(true);
    expect(takeToken('k', 3, 1, t0)).toMatchObject({ ok: false, retryAfter: 1 });
    expect(takeToken('k', 3, 1, t0 + 1100).ok).toBe(true);
  });
});

describe('Gemini client', () => {
  it('reads text from Interactions API steps', () => {
    expect(interactionText({ steps: [{ type: 'user_input' }, { type: 'model_output', content: [{ type: 'text', text: '{"a":' }, { type: 'text', text: '1}' }] }] })).toBe('{"a":1}');
    expect(parseJsonLoose('```json\n{"ok":true}\n```')).toEqual({ ok: true });
  });

  it('sends a structured-output interaction and parses usage', async () => {
    const fetcher = vi.fn(async (_url: string | URL | Request, init?: RequestInit) => {
      const payload = JSON.parse(String(init?.body));
      expect(payload.response_format.mime_type).toBe('application/json');
      expect(payload.store).toBe(false);
      return new Response(JSON.stringify({ status: 'completed', steps: [{ type: 'model_output', content: [{ type: 'text', text: '{"x":1}' }] }], usage: { total_input_tokens: 10, total_output_tokens: 5, total_tokens: 15 } }));
    });
    const client = new GeminiClient('k', 'interactions', fetcher as typeof fetch);
    const r = await client.generate({ model: 'm', system: 's', input: 'i', schema: { type: 'object' } });
    expect(r).toMatchObject({ text: '{"x":1}', inputTokens: 10, outputTokens: 5, totalTokens: 15 });
    expect(String(fetcher.mock.calls[0]![0])).toBe('https://generativelanguage.googleapis.com/v1beta/interactions');
  });

  it('maps 429 with retryDelay to a rate-limit error', async () => {
    const fetcher = async () => new Response(JSON.stringify({ error: { message: 'quota', details: [{ '@type': 'type.googleapis.com/google.rpc.RetryInfo', retryDelay: '12s' }] } }), { status: 429 });
    const client = new GeminiClient('k', 'interactions', fetcher as typeof fetch);
    const err = await client.generate({ model: 'm', system: 's', input: 'i', schema: {} }).catch((e) => e);
    expect(err).toBeInstanceOf(GeminiError);
    expect(err).toMatchObject({ kind: 'rate_limited', retryAfterSeconds: 12 });
    expect(err.retryable).toBe(true);
  });

  it('supports the legacy generateContent style', async () => {
    const fetcher = async () => new Response(JSON.stringify({ candidates: [{ content: { parts: [{ text: 'thinking', thought: true }, { text: '{"y":2}' }] }, finishReason: 'STOP' }], usageMetadata: { promptTokenCount: 3, candidatesTokenCount: 4, totalTokenCount: 7 } }));
    const client = new GeminiClient('k', 'generate_content', fetcher as typeof fetch);
    expect((await client.generate({ model: 'm', system: 's', input: 'i', schema: {} })).text).toBe('{"y":2}');
  });
});

describe('runAi', () => {
  const validMatch = {
    criteria: Object.fromEntries(['technical_skills', 'experience', 'education', 'projects', 'responsibilities', 'qualifications'].map((k) => [k, { score: 80, reason: 'ok' }])),
    matched_skills: ['react'],
    missing_skills: [],
    missing_qualifications: [],
    relevant_projects: [],
    eligibility_concerns: [],
    explanation: 'Good',
    resume_suggestions: [],
    recommendation: 'apply',
  };
  const input = { resume: resumeDataSchema.parse({ basics: { name: 'A' } }), job: { title: 'Dev', company: 'X', location: '', work_arrangement: 'remote', employment_type: 'full_time', description: 'React', requirements: [] }, eligibilitySummary: '', profileName: 'Remote' };

  it('retries once with a repair prompt when validation fails, then logs success', async () => {
    const { db, inserts } = fakeDb({ single: { automation_rules: { ai_daily_request_budget: 200 } } });
    const generate = vi
      .fn()
      .mockResolvedValueOnce({ text: '{"criteria":{}}', inputTokens: 1, outputTokens: 1, totalTokens: 2 })
      .mockResolvedValueOnce({ text: JSON.stringify(validMatch), inputTokens: 5, outputTokens: 5, totalTokens: 10 });
    const out = await runAi({ env, db, userId: 'u', client: { generate } as never }, PROMPTS.match, input);
    expect(out.data.recommendation).toBe('apply');
    expect(out.promptVersion).toBe('job-match@1');
    expect(generate.mock.calls[1]![0].input).toContain('failed validation');
    expect(inserts.find((i) => i.table === 'ai_usage_logs')?.row).toMatchObject({ status: 'success', attempts: 2, total_tokens: 10 });
  });

  it('enforces the daily AI budget without calling Gemini', async () => {
    const { db, inserts } = fakeDb({ counts: { ai_usage_logs: 200 }, single: { automation_rules: { ai_daily_request_budget: 200 } } });
    const generate = vi.fn();
    await expect(runAi({ env, db, userId: 'u', client: { generate } as never }, PROMPTS.match, input)).rejects.toBeInstanceOf(AiBudgetError);
    expect(generate).not.toHaveBeenCalled();
    expect(inserts[0]?.row).toMatchObject({ status: 'budget_exceeded' });
  });
});

describe('HTTP routes', () => {
  it('serves health and rejects unauthenticated requests', async () => {
    expect((await app.request('/health', {}, env)).status).toBe(200);
    const me = await app.request('/api/me', {}, env);
    expect(me.status).toBe(401);
    expect(await me.json()).toMatchObject({ error: { code: 'unauthorized' } });
    expect((await app.request('/internal/runs/claim', { method: 'POST', headers: { Authorization: 'Bearer wrong' } }, env)).status).toBe(401);
    expect((await app.request('/runner/jobs/next', { headers: { Authorization: `Bearer ${env.INTERNAL_API_TOKEN}` } }, env)).status).toBe(401);
  });
  it('refuses machine routes when tokens are too weak', async () => {
    const res = await app.request('/internal/runs/claim', { method: 'POST', headers: { Authorization: 'Bearer short' } }, { ...env, INTERNAL_API_TOKEN: 'short' });
    expect(res.status).toBe(503);
  });
  it('only allows configured CORS origins', async () => {
    const ok = await app.request('/api/me', { method: 'OPTIONS', headers: { Origin: 'http://localhost:5173', 'Access-Control-Request-Method': 'GET' } }, env);
    expect(ok.headers.get('access-control-allow-origin')).toBe('http://localhost:5173');
    const bad = await app.request('/api/me', { method: 'OPTIONS', headers: { Origin: 'https://evil.example', 'Access-Control-Request-Method': 'GET' } }, env);
    expect(bad.headers.get('access-control-allow-origin')).toBeNull();
  });
  it('sets security headers', async () => {
    const res = await app.request('/health', {}, env);
    expect(res.headers.get('x-content-type-options')).toBe('nosniff');
  });
});

describe('bootstrap defaults', () => {
  it('gives every default source row the same columns (supabase-js bulk upsert sends missing keys as NULL)', async () => {
    const { defaultSourceRows } = await import('../src/services/discovery.js');
    const rows = defaultSourceRows('u1');
    const keys = JSON.stringify(Object.keys(rows[0]!).sort());
    expect(rows.every((r) => JSON.stringify(Object.keys(r).sort()) === keys)).toBe(true);
    expect(rows.every((r) => typeof r.automation_allowed === 'boolean')).toBe(true);
    expect(rows.filter((r) => r.automation_allowed).map((r) => r.key)).toEqual(['demo']);
  });
});
