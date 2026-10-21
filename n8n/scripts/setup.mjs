#!/usr/bin/env node
/**
 * Imports ApplyPilot credentials and workflows into the running n8n container.
 *
 *   cd n8n && docker compose up -d   # then create the n8n owner account at http://localhost:5678
 *   node scripts/setup.mjs           # safe to re-run: same ids are updated in place
 *
 * Credentials are passed to `n8n import:credentials` through stdin → a temp file inside the
 * container that is deleted immediately; n8n encrypts them with N8N_ENCRYPTION_KEY.
 */
import { execFileSync, spawnSync } from 'node:child_process';
import { existsSync, readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const root = join(dirname(fileURLToPath(import.meta.url)), '..');
const envFile = join(root, '.env');
if (!existsSync(envFile)) {
  console.error('Missing n8n/.env — copy .env.example and fill it in first.');
  process.exit(1);
}
const env = Object.fromEntries(
  readFileSync(envFile, 'utf8')
    .split(/\r?\n/)
    .filter((l) => l.trim() && !l.trim().startsWith('#') && l.includes('='))
    .map((l) => {
      const i = l.indexOf('=');
      return [l.slice(0, i).trim(), l.slice(i + 1).trim().replace(/^["']|["']$/g, '')];
    }),
);

const fail = (msg) => {
  console.error(`✗ ${msg}`);
  process.exit(1);
};
if (!env.APPLYPILOT_INTERNAL_TOKEN || env.APPLYPILOT_INTERNAL_TOKEN.length < 24) fail('APPLYPILOT_INTERNAL_TOKEN must be at least 24 characters (and equal the Worker INTERNAL_API_TOKEN).');
if (!env.APPLYPILOT_WEBHOOK_TOKEN || env.APPLYPILOT_WEBHOOK_TOKEN.length < 24) fail('APPLYPILOT_WEBHOOK_TOKEN must be at least 24 characters.');

const credentials = [
  { id: 'apInternalApiKey', name: 'ApplyPilot Internal API', type: 'httpHeaderAuth', data: { name: 'Authorization', value: `Bearer ${env.APPLYPILOT_INTERNAL_TOKEN}` } },
  { id: 'apWebhookAuthKey', name: 'ApplyPilot Webhook Auth', type: 'httpHeaderAuth', data: { name: 'X-ApplyPilot-Webhook-Token', value: env.APPLYPILOT_WEBHOOK_TOKEN } },
];
if (env.TELEGRAM_BOT_TOKEN) credentials.push({ id: 'apTelegramBotKey', name: 'ApplyPilot Telegram Bot', type: 'telegramApi', data: { accessToken: env.TELEGRAM_BOT_TOKEN } });

const compose = (args, input) => {
  const r = spawnSync('docker', ['compose', ...args], { cwd: root, input, encoding: 'utf8', stdio: [input ? 'pipe' : 'inherit', 'inherit', 'inherit'] });
  if (r.status !== 0) fail(`docker compose ${args.slice(0, 3).join(' ')} failed`);
};

try {
  const running = execFileSync('docker', ['compose', 'ps', '--status', 'running', '--services'], { cwd: root, encoding: 'utf8' });
  if (!running.includes('n8n')) fail('n8n is not running — run "docker compose up -d" first.');
} catch {
  fail('Docker is not available. Install Docker Desktop and start n8n with "docker compose up -d".');
}

console.log('→ Importing credentials (encrypted by n8n)…');
compose(['exec', '-T', 'n8n', 'sh', '-c', 'umask 077; cat > /tmp/ap-creds.json && n8n import:credentials --input=/tmp/ap-creds.json; status=$?; rm -f /tmp/ap-creds.json; exit $status'], JSON.stringify(credentials));

console.log('→ Importing workflows…');
compose(['exec', '-T', 'n8n', 'n8n', 'import:workflow', '--separate', '--input=/workflows']);

console.log(`
✓ Done. Next steps in the n8n editor (http://localhost:5678):
  1. Open "ApplyPilot 09 · Error Recovery" first and activate (publish) it.
  2. Activate 00 Command Dispatcher, then the workflows you want scheduled (01–08).
  3. ${env.TELEGRAM_BOT_TOKEN ? 'Telegram credential imported.' : 'Optional: set TELEGRAM_BOT_TOKEN in .env and re-run this script for Telegram alerts.'}
Workflows were imported inactive on purpose so you can review them before they run.`);
