import { timingSafeEqual } from '@applypilot/core';
import type { MiddlewareHandler } from 'hono';
import { createRemoteJWKSet, jwtVerify, type JWTPayload } from 'jose';
import type { AppContext, Env } from '../env.js';
import { HttpError } from './errors.js';
import { ownerUserId } from './supabase.js';

let jwks: { url: string; set: ReturnType<typeof createRemoteJWKSet> } | null = null;

async function verifySupabaseJwt(token: string, env: Env): Promise<JWTPayload> {
  const issuer = `${env.SUPABASE_URL.replace(/\/$/, '')}/auth/v1`;
  if (env.SUPABASE_JWT_SECRET) {
    const { payload } = await jwtVerify(token, new TextEncoder().encode(env.SUPABASE_JWT_SECRET), { audience: 'authenticated', issuer });
    return payload;
  }
  const url = `${issuer}/.well-known/jwks.json`;
  if (jwks?.url !== url) jwks = { url, set: createRemoteJWKSet(new URL(url), { cooldownDuration: 60_000, cacheMaxAge: 10 * 60_000 }) };
  const { payload } = await jwtVerify(token, jwks.set, { audience: 'authenticated', issuer });
  return payload;
}

function bearer(header: string | undefined): string | null {
  const m = header?.match(/^Bearer\s+(.+)$/i);
  return m?.[1]?.trim() || null;
}

/** Dashboard routes: a valid Supabase session for the single allowed account. */
export const requireUser: MiddlewareHandler<AppContext> = async (c, next) => {
  const token = bearer(c.req.header('Authorization'));
  if (!token) throw new HttpError(401, 'unauthorized', 'Missing bearer token');
  let payload: JWTPayload;
  try {
    payload = await verifySupabaseJwt(token, c.env);
  } catch {
    throw new HttpError(401, 'unauthorized', 'Invalid or expired session');
  }
  const email = typeof payload.email === 'string' ? payload.email : '';
  if (payload.role !== 'authenticated' || !payload.sub) throw new HttpError(401, 'unauthorized', 'Invalid session');
  if (c.env.ALLOWED_USER_EMAIL && email.toLowerCase() !== c.env.ALLOWED_USER_EMAIL.toLowerCase()) {
    throw new HttpError(403, 'forbidden', 'This account is not allowed to use ApplyPilot');
  }
  c.set('userId', payload.sub);
  c.set('userEmail', email);
  c.set('actor', 'user');
  await next();
};

/** Machine routes: constant-time bearer token comparison, then act as the owner account. */
function requireToken(name: 'INTERNAL_API_TOKEN' | 'RUNNER_API_TOKEN', actor: 'n8n' | 'runner'): MiddlewareHandler<AppContext> {
  return async (c, next) => {
    const expected = c.env[name];
    const token = bearer(c.req.header('Authorization'));
    if (!expected || expected.length < 24) throw new HttpError(503, 'not_configured', `${name} is not configured (min 24 chars)`);
    if (!token || !timingSafeEqual(token, expected)) throw new HttpError(401, 'unauthorized', 'Invalid token');
    c.set('userId', await ownerUserId(c.env));
    c.set('userEmail', c.env.ALLOWED_USER_EMAIL ?? '');
    c.set('actor', actor);
    await next();
  };
}

export const requireInternal = requireToken('INTERNAL_API_TOKEN', 'n8n');
export const requireRunner = requireToken('RUNNER_API_TOKEN', 'runner');
