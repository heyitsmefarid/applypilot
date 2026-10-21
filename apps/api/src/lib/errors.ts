import type { Context } from 'hono';
import type { ContentfulStatusCode } from 'hono/utils/http-status';
import { ZodError } from 'zod';

export class HttpError extends Error {
  constructor(
    public status: ContentfulStatusCode,
    public code: string,
    message: string,
    public details?: unknown,
  ) {
    super(message);
  }
}

export const badRequest = (message: string, details?: unknown) => new HttpError(400, 'bad_request', message, details);
export const notFound = (what: string) => new HttpError(404, 'not_found', `${what} not found`);
export const conflict = (code: string, message: string) => new HttpError(409, code, message);
export const locked = (message = 'Automation is paused') => new HttpError(423, 'automation_paused', message);

/** Thrown by DB helpers; keeps PostgREST error details out of client responses. */
export function dbError(context: string, error: { message: string; code?: string } | null): never {
  console.error(`[db] ${context}:`, error?.code, error?.message);
  if (error?.code === '23505') throw conflict('duplicate', `${context}: already exists`);
  throw new HttpError(500, 'database_error', `${context} failed`);
}

export function errorResponse(err: unknown, c: Context) {
  if (err instanceof HttpError) {
    return c.json({ error: { code: err.code, message: err.message, details: err.details } }, err.status);
  }
  if (err instanceof ZodError) {
    return c.json({ error: { code: 'validation_error', message: 'Invalid request', details: err.issues.slice(0, 20) } }, 400);
  }
  console.error('[unhandled]', err instanceof Error ? `${err.name}: ${err.message}` : err);
  return c.json({ error: { code: 'internal_error', message: 'Unexpected server error' } }, 500);
}
