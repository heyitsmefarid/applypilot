#!/usr/bin/env node
/**
 * ApplyPilot Playwright runner.
 *
 *   tsx src/cli.ts --run-id <uuid>     run one dispatched job (GitHub Actions passes this)
 *   tsx src/cli.ts --watch             local runner: poll the Worker for jobs dispatched to "local"
 *
 * Env: APPLYPILOT_API_URL, APPLYPILOT_RUNNER_TOKEN, HEADLESS=false to watch the browser.
 */
import { existsSync } from 'node:fs';
import { RunnerApi } from './api.js';
import { executeRun } from './run.js';

// Local runs read runner/.env; GitHub Actions passes real environment variables instead.
if (existsSync('.env')) process.loadEnvFile('.env');

const args = process.argv.slice(2);
const arg = (name: string) => {
  const i = args.indexOf(name);
  return i >= 0 ? args[i + 1] : undefined;
};

const api = new RunnerApi(process.env.APPLYPILOT_API_URL ?? '', process.env.APPLYPILOT_RUNNER_TOKEN ?? '');
const headless = process.env.HEADLESS !== 'false';

async function main() {
  const runId = arg('--run-id');
  if (runId) {
    const r = await executeRun(api, runId, { headless });
    process.exitCode = r.outcome === 'failed' ? 1 : 0;
    return;
  }
  if (args.includes('--watch')) {
    const interval = Number(process.env.POLL_SECONDS ?? 20) * 1000;
    console.log(`[runner] watching for local jobs every ${interval / 1000}s (Ctrl+C to stop)`);
    let stopping = false;
    process.on('SIGINT', () => {
      stopping = true;
      console.log('\n[runner] stopping after the current job…');
    });
    while (!stopping) {
      try {
        const { job } = await api.next();
        if (job) await executeRun(api, job.run_id, { headless });
      } catch (e) {
        console.error('[runner]', (e as Error).message);
      }
      await new Promise((r) => setTimeout(r, interval));
    }
    return;
  }
  console.error('Usage: tsx src/cli.ts --run-id <uuid> | --watch');
  process.exitCode = 2;
}

main().catch((e) => {
  console.error(e);
  process.exitCode = 1;
});
