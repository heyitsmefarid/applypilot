# Deployment guide (₱0/month)

Each service below runs on a free tier. Nothing here enables paid features. Where a free tier
has limits that matter, they're noted inline.

| Service | Free tier used | Notes |
|---|---|---|
| Supabase | Free project (500 MB DB, 1 GB storage) | Free projects pause after ~7 days without activity; n8n's polling keeps it active |
| Cloudflare Workers | 100k requests/day, 10 ms CPU/request, 50 subrequests/request | Endpoints are designed in small batches for this |
| Cloudflare Pages | Unlimited static requests | |
| Gemini API | Free tier (Flash / Flash-Lite) | Check your live limits in AI Studio; free-tier prompts may be used to improve Google products |
| GitHub Actions | 2,000 min/month on private repos | One run takes about 1–2 min |
| Gmail API | Free quota | Testing-mode OAuth refresh tokens expire after 7 days |
| n8n Community Edition | Self-hosted | Docker on your machine or an Oracle Always Free VM |

## 1. Supabase

1. Create a project at <https://supabase.com/dashboard> (Free plan). Pick a region near you (for example Singapore).
2. Turn off public signups: **Authentication → Sign In / Providers → Email → Allow new users to sign up: off**.
   The migrations also add a database trigger that refuses a second account.
3. Apply the migrations:
   ```bash
   npx supabase login
   npx supabase link --project-ref <your-project-ref>
   npx supabase db push
   ```
   Alternatively, paste each file from `supabase/migrations/` into the SQL editor, in order.
4. Create your account: **Authentication → Users → Add user → Create new user** (email + password, auto-confirm).
5. Copy the keys from **Project Settings → API Keys**:
   - **Publishable key** (`sb_publishable_…`), used by the browser (`VITE_SUPABASE_PUBLISHABLE_KEY`).
   - **Secret key** (`sb_secret_…`), used by the Worker only (`SUPABASE_SECRET_KEY`). Never put it in the frontend.
6. Add your site URLs under **Authentication → URL Configuration** (`http://localhost:5173`, your Pages URL).

## 2. Gemini API key

1. Open <https://aistudio.google.com/apikey> and create a key in a project **without billing** so it stays on the free tier.
2. The models are configured in `apps/api/wrangler.jsonc`. Both default to `gemini-3.5-flash-lite`:
   `GEMINI_MODEL_FAST` for extraction, matching and classification, and `GEMINI_MODEL_QUALITY` for rewriting
   and letters. You can set `GEMINI_MODEL_QUALITY=gemini-3.8-flash`, but a full resume rewrite took about 90 s
   on it, compared with about 8 s on Flash-Lite.
   Use **Integrations → Gemini → Check models** to confirm both are available to your key.
3. The app uses the Interactions API (Google's recommended interface). If you hit API issues,
   set `GEMINI_API_STYLE=generate_content` to switch to the `generateContent` endpoint.
4. Lower **Automation center → Daily Gemini budget** if your AI Studio limits are smaller than the default of 200 requests/day.

## 3. Cloudflare Worker (API)

```bash
cd apps/api
npx wrangler login
# Secrets (repeat for each). Generate random values with:
#   node -e "console.log(require('crypto').randomBytes(32).toString('base64'))"
npx wrangler secret put SUPABASE_URL
npx wrangler secret put SUPABASE_SECRET_KEY
npx wrangler secret put ALLOWED_USER_EMAIL
npx wrangler secret put GEMINI_API_KEY
npx wrangler secret put INTERNAL_API_TOKEN      # also goes in n8n/.env as APPLYPILOT_INTERNAL_TOKEN
npx wrangler secret put RUNNER_API_TOKEN        # also a GitHub secret APPLYPILOT_RUNNER_TOKEN
npx wrangler secret put TOKEN_ENCRYPTION_KEY    # 32 bytes, base64
npx wrangler secret put STATE_SIGNING_KEY
npx wrangler secret put GOOGLE_CLIENT_ID
npx wrangler secret put GOOGLE_CLIENT_SECRET
npx wrangler secret put GOOGLE_REDIRECT_URI     # https://applypilot-api.<you>.workers.dev/oauth/google/callback
# optional:
npx wrangler secret put GITHUB_TOKEN            # fine-grained PAT: this repo only, Actions: read & write
npx wrangler secret put GITHUB_REPO             # e.g. heyitsmefarid/applypilot-ai
npx wrangler secret put N8N_WEBHOOK_BASE_URL    # only for push mode (section 7)
npx wrangler secret put N8N_WEBHOOK_TOKEN
npm run deploy
```

Then set the non-secret variables in `wrangler.jsonc` (`APP_URL`, `CORS_ORIGINS`) to your Pages URL
and deploy again. The cron trigger (`*/15 * * * *`) only reaps stale runs and checks n8n's
heartbeat. It never duplicates the n8n schedules.

For local development, copy `.dev.vars.example` to `.dev.vars` and run `npm run dev:api`.

> **Avast or other HTTPS-scanning antivirus:** if wrangler or Playwright downloads fail with certificate
> errors, run them with `NODE_EXTRA_CA_CERTS=<path to the antivirus root .pem>`.

## 4. Cloudflare Pages (frontend)

```bash
cd apps/web
cp .env.example .env.production.local   # VITE_SUPABASE_URL, VITE_SUPABASE_PUBLISHABLE_KEY, VITE_API_URL
npm run deploy                          # wrangler pages deploy dist --project-name applypilot-ai
```

You can also connect the GitHub repository in the Cloudflare dashboard (build command
`npm run build -w @applypilot/web`, output `apps/web/dist`) and set the three `VITE_*` variables there.
`public/_redirects` handles SPA routing, and `public/_headers` sets the security headers and CSP.
If your Worker lives on a custom domain, add it to the CSP's `connect-src`.

## 5. Google OAuth (Gmail)

1. In <https://console.cloud.google.com>, create a project and enable the **Gmail API**.
2. Configure the **OAuth consent screen** (**Google Auth Platform → Branding / Audience**): choose External,
   keep the app in **Testing** status, and add your Gmail address as a **test user**.
3. Under **Data Access**, add the scopes `gmail.readonly`, `gmail.compose`, `openid` and `email`.
4. Under **Clients**, create an OAuth client of type **Web application**, with the authorized redirect URI
   `https://applypilot-api.<you>.workers.dev/oauth/google/callback` (and
   `http://localhost:8787/oauth/google/callback` for local development).
5. Put the client ID and secret in the Worker secrets, then connect from **Integrations → Gmail**.

While the app is in **Testing**, Google expires refresh tokens after 7 days. When that happens,
ApplyPilot shows a "Reconnect Gmail" notification. Publishing a personal-use app with restricted
scopes requires Google verification; for a portfolio project, reconnecting weekly is the realistic option.

## 6. Playwright runner

### GitHub Actions (recommended)

1. Push the repository to GitHub as a **private** repository (Actions logs include job titles).
2. Under **Settings → Secrets and variables → Actions**, add `APPLYPILOT_API_URL` (your Worker URL) and
   `APPLYPILOT_RUNNER_TOKEN` (the same value as the Worker's `RUNNER_API_TOKEN`).
3. Give the Worker a fine-grained PAT (`GITHUB_TOKEN`) limited to this repository with **Actions: Read and write**, and set `GITHUB_REPO`.
4. Approved submissions now dispatch `.github/workflows/apply-runner.yml` with only the run id.

### Local runner

```bash
export APPLYPILOT_API_URL=http://localhost:8787 APPLYPILOT_RUNNER_TOKEN=...
npx playwright install chromium            # once
npm run watch -w @applypilot/runner        # polls for jobs dispatched to "local"
```

Without `GITHUB_TOKEN` on the Worker, all submissions go to the local runner.

**Allow-listing:** the runner only operates on hosts listed in `RUNNER_ALLOWED_HOSTS` (Worker var),
or in a source's `config.allowed_hosts`, and only for sources with **Allow automated submission**
switched on in Integrations. By default that is the demo site (`localhost`) only.

## 7. n8n (local Docker)

```bash
cd n8n
cp .env.example .env    # set N8N_ENCRYPTION_KEY, N8N_JWT_SECRET, APPLYPILOT_* tokens and API URL
docker compose up -d
# open http://localhost:5678 and create the owner account
node scripts/setup.mjs  # imports encrypted credentials + all 10 workflows (inactive)
```

Activate **09 Error Recovery** first, then **00 Command Dispatcher**, then whichever scheduled
workflows you want. See [N8N.md](N8N.md) for what each node does.

**Back up `N8N_ENCRYPTION_KEY`.** Without it, the stored credentials can't be decrypted.

### Optional instant push (HTTPS without opening ports)

By default n8n *polls* the queue once a minute, so it never needs to be reachable from the internet.
For instant reaction to dashboard clicks:

1. Create a Cloudflare Tunnel (Zero Trust → Networks → Tunnels) that routes only `https://n8n.<your-domain>/webhook/*` to `http://n8n:5678`.
2. Put the tunnel token in `n8n/.env` (`CLOUDFLARE_TUNNEL_TOKEN`) and run `docker compose --profile tunnel up -d`.
3. Set the Worker secrets `N8N_WEBHOOK_BASE_URL=https://n8n.<your-domain>` and `N8N_WEBHOOK_TOKEN` (same as `APPLYPILOT_WEBHOOK_TOKEN`).
4. Optionally protect the editor with Cloudflare Access. All webhooks require the `X-ApplyPilot-Webhook-Token` header either way.

## 8. Optional: n8n on an Oracle Cloud Always Free VM

Local n8n only runs while your computer is on. An Always Free VM gives you 24/7 automation at no
cost, **if capacity is available**: Ampere A1 shapes are often out of stock in popular regions, and
Oracle can reclaim idle Always Free instances. Keep exported workflows and your encryption key backed up.

1. Create an Oracle Cloud account (it requires a card for identity verification; Always Free resources are not charged).
2. **Compute → Instances → Create**: image Ubuntu 24.04, shape **VM.Standard.A1.Flex** (1 OCPU / 6 GB is plenty) or **VM.Standard.E2.1.Micro** if A1 is unavailable. Add your SSH key.
3. Keep the default security list: SSH only. **Don't open port 5678.** Use the Cloudflare Tunnel from section 7 or an SSH tunnel (`ssh -L 5678:localhost:5678 ubuntu@<ip>`) for the editor.
4. On the VM:
   ```bash
   sudo apt update && sudo apt install -y docker.io docker-compose-v2 git nodejs
   sudo usermod -aG docker $USER && newgrp docker
   git clone <your private repo> && cd applypilot-ai/n8n
   cp .env.example .env && nano .env      # APPLYPILOT_API_URL = your deployed Worker URL
   docker compose up -d
   node scripts/setup.mjs
   ```
5. Turn off local n8n so the two instances don't both run the schedules. (The run queue's atomic claim prevents double-processing, but scheduled triggers would still fire twice.)

## 9. First run checklist

1. Sign in, and the default search profiles (Internship and Remote) and job sources are created.
2. **My resume**: upload, review the extraction, then **Verify this version**.
3. **Integrations**: check the Gemini models, connect Gmail, and configure any company boards.
4. **Discover jobs → Run discovery**. n8n picks the run up within a minute.
5. **Automation center**: switch the mode from Manual to **Approval** (new accounts start in Manual).
6. **Discover jobs → Add demo job → Prepare application → Approve documents → Fill form for review**, then **Approve & submit** to watch the full Playwright flow against the local demo form.
