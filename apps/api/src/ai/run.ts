import { promptVersionTag, toGeminiSchema, type PromptDefinition } from '@applypilot/core';
import type { z } from 'zod';
import type { Env } from '../env.js';
import { HttpError } from '../lib/errors.js';
import { takeToken } from '../lib/ratelimit.js';
import type { Db } from '../lib/supabase.js';
import { GeminiClient, GeminiError, parseJsonLoose } from './gemini.js';

export class AiBudgetError extends HttpError {
  constructor(message: string, retryAfter: number | null = null) {
    super(429, 'ai_budget_exceeded', message, { retry_after_seconds: retryAfter });
  }
}

export interface AiContext {
  env: Env;
  db: Db;
  userId: string;
  runId?: string | null;
  /** Injected in tests. */
  client?: GeminiClient;
}

export interface AiOutcome<T> {
  data: T;
  model: string;
  promptVersion: string;
}

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));
const schemaCache = new WeakMap<object, Record<string, unknown>>();

function geminiSchemaFor(schema: z.ZodType): Record<string, unknown> {
  let s = schemaCache.get(schema);
  if (!s) {
    s = toGeminiSchema(schema);
    schemaCache.set(schema, s);
  }
  return s;
}

async function log(ctx: AiContext, row: Record<string, unknown>) {
  const { error } = await ctx.db.from('ai_usage_logs').insert({ user_id: ctx.userId, run_id: ctx.runId ?? null, ...row });
  if (error) console.error('[ai] usage log failed', error.message);
}

/** Daily budget (rolling 24 h) and per-minute pacing, enforced in Postgres so all isolates agree. */
export async function checkAiBudget(ctx: AiContext): Promise<void> {
  const rpm = Math.max(1, Number(ctx.env.GEMINI_RPM || 10));
  const local = takeToken(`gemini:${ctx.userId}`, rpm, rpm / 60);
  if (!local.ok) throw new AiBudgetError(`Gemini pacing: retry in ${local.retryAfter}s`, local.retryAfter);

  const [{ data: rules }, day, minute] = await Promise.all([
    ctx.db.from('automation_rules').select('ai_daily_request_budget').eq('user_id', ctx.userId).maybeSingle(),
    ctx.db
      .from('ai_usage_logs')
      .select('id', { count: 'exact', head: true })
      .eq('user_id', ctx.userId)
      .neq('status', 'budget_exceeded')
      .gte('created_at', new Date(Date.now() - 86_400_000).toISOString()),
    ctx.db
      .from('ai_usage_logs')
      .select('id', { count: 'exact', head: true })
      .eq('user_id', ctx.userId)
      .neq('status', 'budget_exceeded')
      .gte('created_at', new Date(Date.now() - 60_000).toISOString()),
  ]);
  const budget = (rules?.ai_daily_request_budget as number | undefined) ?? 200;
  if ((day.count ?? 0) >= budget) throw new AiBudgetError(`Daily AI budget of ${budget} requests reached. Deterministic fallbacks are used where available.`);
  if ((minute.count ?? 0) >= rpm) throw new AiBudgetError(`Gemini free-tier pacing (${rpm}/min) reached — retry shortly.`, 30);
}

/**
 * Runs a versioned prompt: budget check → Gemini structured output → JSON parse → Zod validation
 * (one repair retry) → usage log. Transient failures (5xx, timeouts, short 429s) are retried.
 */
export async function runAi<TInput, TSchema extends z.ZodType>(
  ctx: AiContext,
  prompt: PromptDefinition<TInput, TSchema>,
  input: TInput,
  opts: { relatedId?: string | null; maxOutputTokens?: number } = {},
): Promise<AiOutcome<z.infer<TSchema>>> {
  if (!ctx.env.GEMINI_API_KEY) throw new HttpError(503, 'gemini_not_configured', 'GEMINI_API_KEY is not configured');
  const promptVersion = promptVersionTag(prompt);
  const model = prompt.tier === 'quality' ? ctx.env.GEMINI_MODEL_QUALITY : ctx.env.GEMINI_MODEL_FAST;
  try {
    await checkAiBudget(ctx);
  } catch (e) {
    if (e instanceof AiBudgetError) await log(ctx, { task: prompt.task, model, prompt_version: promptVersion, status: 'budget_exceeded', error: e.message, related_id: opts.relatedId ?? null });
    throw e;
  }

  const client = ctx.client ?? new GeminiClient(ctx.env.GEMINI_API_KEY, ctx.env.GEMINI_API_STYLE);
  const schema = geminiSchemaFor(prompt.schema);
  const started = Date.now();
  let userInput = prompt.build(input);
  let attempts = 0;
  let lastError = '';
  let tokens = { inputTokens: null as number | null, outputTokens: null as number | null, totalTokens: null as number | null };

  while (attempts < 3) {
    attempts++;
    try {
      // Full-document rewrites are slow on larger models; give the quality tier more time.
      const timeoutMs = prompt.tier === 'quality' ? 150_000 : 60_000;
      const res = await client.generate({ model, system: prompt.system, input: userInput, schema, maxOutputTokens: opts.maxOutputTokens, timeoutMs });
      tokens = res;
      let parsed: unknown;
      try {
        parsed = parseJsonLoose(res.text);
      } catch (e) {
        lastError = (e as Error).message;
        userInput = `${prompt.build(input)}\n\nYour previous answer was not valid JSON. Respond with JSON that matches the schema only.`;
        continue;
      }
      const result = prompt.schema.safeParse(parsed);
      if (!result.success) {
        lastError = result.error.issues.slice(0, 5).map((i) => `${i.path.join('.')}: ${i.message}`).join('; ');
        userInput = `${prompt.build(input)}\n\nYour previous answer failed validation (${lastError}). Return corrected JSON only.`;
        continue;
      }
      await log(ctx, {
        task: prompt.task,
        model,
        prompt_version: promptVersion,
        status: 'success',
        input_tokens: tokens.inputTokens,
        output_tokens: tokens.outputTokens,
        total_tokens: tokens.totalTokens,
        latency_ms: Date.now() - started,
        attempts,
        related_id: opts.relatedId ?? null,
      });
      return { data: result.data, model, promptVersion };
    } catch (e) {
      if (!(e instanceof GeminiError)) throw e;
      lastError = e.message;
      // A timeout is retried once at most — repeating a slow request rarely helps and multiplies the wait.
      const maxTries = e.kind === 'timeout' ? 2 : 3;
      if (e.retryable && attempts < maxTries) {
        const wait = e.kind === 'rate_limited' ? (e.retryAfterSeconds ?? 5) * 1000 : 800 * 2 ** attempts + Math.random() * 400;
        await sleep(Math.min(wait, 20_000));
        continue;
      }
      await log(ctx, {
        task: prompt.task,
        model,
        prompt_version: promptVersion,
        status: e.kind === 'rate_limited' ? 'rate_limited' : e.kind === 'timeout' ? 'timeout' : 'error',
        latency_ms: Date.now() - started,
        attempts,
        error: e.message.slice(0, 500),
        related_id: opts.relatedId ?? null,
      });
      if (e.kind === 'rate_limited') throw new AiBudgetError(e.message, e.retryAfterSeconds);
      throw new HttpError(502, 'ai_error', e.message);
    }
  }
  await log(ctx, {
    task: prompt.task,
    model,
    prompt_version: promptVersion,
    status: 'invalid_output',
    input_tokens: tokens.inputTokens,
    output_tokens: tokens.outputTokens,
    total_tokens: tokens.totalTokens,
    latency_ms: Date.now() - started,
    attempts,
    error: lastError.slice(0, 500),
    related_id: opts.relatedId ?? null,
  });
  throw new HttpError(502, 'ai_invalid_output', `AI output failed validation: ${lastError}`);
}
