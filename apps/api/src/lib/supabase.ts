import { createClient, type SupabaseClient } from '@supabase/supabase-js';
import type { Env } from '../env.js';

export type Db = SupabaseClient;

let cached: { url: string; client: Db } | null = null;

/** Service-role client. Bypasses RLS — every query MUST filter by the owner's user_id. */
export function serviceClient(env: Env): Db {
  if (cached?.url === env.SUPABASE_URL) return cached.client;
  const client = createClient(env.SUPABASE_URL, env.SUPABASE_SECRET_KEY, {
    auth: { persistSession: false, autoRefreshToken: false, detectSessionInUrl: false },
    global: { headers: { 'x-application-name': 'applypilot-api' } },
  });
  cached = { url: env.SUPABASE_URL, client };
  return client;
}

let ownerCache: { id: string; at: number } | null = null;

/**
 * Resolves the single owner account. Internal (n8n / runner / cron) requests act on behalf of
 * this user; the single-user DB trigger guarantees there is at most one profile.
 */
export async function ownerUserId(env: Env): Promise<string> {
  if (ownerCache && Date.now() - ownerCache.at < 10 * 60_000) return ownerCache.id;
  const db = serviceClient(env);
  let query = db.from('profiles').select('id, email').limit(2);
  if (env.ALLOWED_USER_EMAIL) query = query.ilike('email', env.ALLOWED_USER_EMAIL);
  const { data, error } = await query;
  if (error) throw new Error(`Owner lookup failed: ${error.message}`);
  if (!data?.length) throw new Error('No owner account exists yet. Create it in Supabase Auth first.');
  if (data.length > 1) throw new Error('More than one profile found; single-user invariant violated.');
  ownerCache = { id: data[0]!.id as string, at: Date.now() };
  return ownerCache.id;
}

/** Untyped PostgREST row (the schema lives in SQL migrations; services cast to local interfaces). */
// eslint-disable-next-line @typescript-eslint/no-explicit-any
export type Row = any;

export function unwrap<T = Row>(res: { data: unknown; error: { message: string; code?: string } | null }, context: string): T {
  if (res.error) {
    console.error(`[db] ${context}:`, res.error.code, res.error.message);
    throw new Error(`${context}: ${res.error.message}`);
  }
  return res.data as T;
}
