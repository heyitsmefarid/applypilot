import type { Context } from 'hono';
import type { z } from 'zod';
import type { AiContext } from '../ai/run.js';
import type { AppContext } from '../env.js';
import { HttpError } from '../lib/errors.js';
import { serviceClient } from '../lib/supabase.js';

export type Ctx = Context<AppContext>;

export function aiCtx(c: Ctx, runId?: string | null): AiContext {
  return { env: c.env, db: serviceClient(c.env), userId: c.get('userId'), runId: runId ?? null };
}

export const db = (c: Ctx) => serviceClient(c.env);

export async function body<T extends z.ZodType>(c: Ctx, schema: T): Promise<z.infer<T>> {
  let raw: unknown = {};
  const text = await c.req.text();
  if (text) {
    try {
      raw = JSON.parse(text);
    } catch {
      throw new HttpError(400, 'bad_json', 'Request body must be JSON');
    }
  }
  return schema.parse(raw);
}

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

export function idParam(c: Ctx, name = 'id'): string {
  const v = c.req.param(name);
  if (!v || !UUID.test(v)) throw new HttpError(400, 'bad_request', `Invalid ${name}`);
  return v;
}
