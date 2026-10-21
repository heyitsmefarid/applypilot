/**
 * Per-isolate token bucket. Cloudflare may run several isolates, so this is a first line of
 * defence against bursts; durable limits (AI budget, daily submissions) live in Postgres.
 */
interface Bucket {
  tokens: number;
  updated: number;
}

const buckets = new Map<string, Bucket>();

export function takeToken(key: string, capacity: number, refillPerSecond: number, now = Date.now()): { ok: boolean; retryAfter: number } {
  const b = buckets.get(key) ?? { tokens: capacity, updated: now };
  const elapsed = (now - b.updated) / 1000;
  b.tokens = Math.min(capacity, b.tokens + elapsed * refillPerSecond);
  b.updated = now;
  if (b.tokens >= 1) {
    b.tokens -= 1;
    buckets.set(key, b);
    return { ok: true, retryAfter: 0 };
  }
  buckets.set(key, b);
  return { ok: false, retryAfter: Math.ceil((1 - b.tokens) / refillPerSecond) };
}

export function resetBuckets() {
  buckets.clear();
}
