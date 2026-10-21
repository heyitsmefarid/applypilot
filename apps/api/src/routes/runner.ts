import { Hono } from 'hono';
import { z } from 'zod';
import type { AppContext } from '../env.js';
import { requireRunner } from '../lib/auth.js';
import { evidenceUploadUrl, nextLocalJob, recordRunnerResult, runnerPayload, runnerResultSchema } from '../services/applications.js';
import { heartbeat } from '../services/runs.js';
import { body, db, idParam } from './helpers.js';

/** Endpoints for the Playwright runner (GitHub Actions or local), authenticated with RUNNER_API_TOKEN. */
export const runnerRoutes = new Hono<AppContext>();
runnerRoutes.use('*', requireRunner);

runnerRoutes.get('/jobs/next', async (c) => c.json({ job: await nextLocalJob(db(c), c.get('userId')) }));
runnerRoutes.get('/runs/:id', async (c) => c.json(await runnerPayload(db(c), c.env, c.get('userId'), idParam(c))));
runnerRoutes.post('/runs/:id/heartbeat', async (c) => c.json(await heartbeat(db(c), c.get('userId'), idParam(c))));
runnerRoutes.post('/runs/:id/evidence-url', async (c) => {
  const input = await body(c, z.object({ name: z.string().min(1).max(100).regex(/\.(png|jpe?g|json|txt)$/i) }));
  return c.json(await evidenceUploadUrl(db(c), c.get('userId'), idParam(c), input));
});
runnerRoutes.post('/runs/:id/result', async (c) => c.json(await recordRunnerResult(db(c), c.get('userId'), idParam(c), await body(c, runnerResultSchema))));
