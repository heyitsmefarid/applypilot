import { supabase } from './supabase';

const API_URL = ((import.meta.env.VITE_API_URL as string | undefined) ?? 'http://localhost:8787').replace(/\/$/, '');

export class ApiError extends Error {
  constructor(
    message: string,
    public status: number,
    public code: string,
    public details?: unknown,
  ) {
    super(message);
  }
}

/** Calls the Cloudflare Worker with the current Supabase session token. */
export async function api<T = unknown>(path: string, init: { method?: 'GET' | 'POST'; body?: unknown } = {}): Promise<T> {
  const { data } = await supabase.auth.getSession();
  const token = data.session?.access_token;
  if (!token) throw new ApiError('You are signed out. Sign in again.', 401, 'unauthorized');
  let res: Response;
  try {
    res = await fetch(`${API_URL}/api${path}`, {
      method: init.method ?? (init.body === undefined ? 'GET' : 'POST'),
      headers: { Authorization: `Bearer ${token}`, ...(init.body !== undefined ? { 'Content-Type': 'application/json' } : {}) },
      body: init.body === undefined ? undefined : JSON.stringify(init.body),
    });
  } catch {
    throw new ApiError(`Can't reach the ApplyPilot API at ${API_URL}. Check that the Worker is running.`, 0, 'network');
  }
  const text = await res.text();
  const json = text ? (JSON.parse(text) as unknown) : null;
  if (!res.ok) {
    const err = (json as { error?: { message?: string; code?: string; details?: unknown } } | null)?.error;
    throw new ApiError(err?.message ?? `Request failed (HTTP ${res.status})`, res.status, err?.code ?? 'error', err?.details);
  }
  return json as T;
}

export const post = <T = unknown>(path: string, body: unknown = {}) => api<T>(path, { method: 'POST', body });
