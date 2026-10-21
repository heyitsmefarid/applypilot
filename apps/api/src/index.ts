import { Hono } from 'hono';
import { cors } from 'hono/cors';
import { secureHeaders } from 'hono/secure-headers';
import type { AppContext, Env } from './env.js';
import { errorResponse, HttpError } from './lib/errors.js';
import { ownerUserId, serviceClient } from './lib/supabase.js';
import { internalRoutes } from './routes/internal.js';
import { runnerRoutes } from './routes/runner.js';
import { userRoutes } from './routes/user.js';
import { gmailCallback } from './services/gmail.js';
import { notify } from './services/notifications.js';

export const app = new Hono<AppContext>();

app.use('*', secureHeaders());
app.use(
  '/api/*',
  cors({
    origin: (origin, c) => {
      const allowed = (c.env as Env).CORS_ORIGINS.split(',').map((o) => o.trim());
      return allowed.includes(origin) ? origin : null;
    },
    allowHeaders: ['Authorization', 'Content-Type'],
    allowMethods: ['GET', 'POST', 'OPTIONS'],
    maxAge: 600,
  }),
);

app.onError(errorResponse);
app.notFound((c) => c.json({ error: { code: 'not_found', message: 'Route not found' } }, 404));

// GET for uptime checks; POST lets n8n no-op items flow through without special branching.
app.on(['GET', 'POST'], '/health', (c) => c.json({ ok: true, service: 'applypilot-api', time: new Date().toISOString() }));

app.get('/oauth/google/callback', async (c) => {
  const appUrl = c.env.APP_URL.replace(/\/$/, '');
  const error = c.req.query('error');
  if (error) return c.redirect(`${appUrl}/integrations?gmail=error&reason=${encodeURIComponent(error)}`);
  const code = c.req.query('code');
  const state = c.req.query('state');
  if (!code || !state) throw new HttpError(400, 'bad_request', 'Missing code or state');
  try {
    await gmailCallback(c.env, serviceClient(c.env), code, state);
    return c.redirect(`${appUrl}/integrations?gmail=connected`);
  } catch (e) {
    const reason = e instanceof HttpError ? e.message : 'unexpected error';
    return c.redirect(`${appUrl}/integrations?gmail=error&reason=${encodeURIComponent(reason)}`);
  }
});

app.route('/api', userRoutes);
app.route('/internal', internalRoutes);
app.route('/runner', runnerRoutes);

/**
 * Cloudflare Cron (every 15 min) — independent maintenance only, so it never duplicates the
 * n8n schedules: reap stale runs and warn when n8n has stopped polling (e.g. laptop asleep).
 */
export async function scheduled(env: Env) {
  const db = serviceClient(env);
  const { data: reaped, error } = await db.rpc('reap_stale_runs');
  if (error) console.error('[cron] reap failed', error.message);
  let userId: string;
  try {
    userId = await ownerUserId(env);
  } catch {
    return;
  }
  const { data: rules } = await db.from('automation_rules').select('n8n_last_seen_at, paused').eq('user_id', userId).maybeSingle();
  const lastSeen = rules?.n8n_last_seen_at ? Date.parse(rules.n8n_last_seen_at as string) : 0;
  if (!rules?.paused && lastSeen && Date.now() - lastSeen > 3 * 3600_000) {
    const { count } = await db.from('automation_runs').select('id', { count: 'exact', head: true }).eq('user_id', userId).eq('status', 'queued');
    await notify(db, userId, {
      type: 'automation_error',
      severity: 'warning',
      title: 'n8n is offline',
      body: `n8n has not checked the queue for ${Math.round((Date.now() - lastSeen) / 3600_000)} h. ${count ?? 0} run(s) are waiting. Local n8n stops when your computer is off.`,
      link: '/automation',
      dedupe_key: `n8n_offline:${new Date().toISOString().slice(0, 10)}`,
    });
  }
  if (reaped) console.log(`[cron] reaped ${reaped} stale run(s)`);
}

export default {
  fetch: app.fetch,
  async scheduled(_event: ScheduledController, env: Env, ctx: ExecutionContext) {
    ctx.waitUntil(scheduled(env));
  },
} satisfies ExportedHandler<Env>;
