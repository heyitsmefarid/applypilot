# Testing & troubleshooting

## Test suites

| Suite | Command | What it proves |
|---|---|---|
| Core (47) | `npm test -w @applypilot/core` | parsing (HTML, salary, dates), skills, location/PH eligibility, eligibility rules for both default profiles, scoring and score caps, dedupe/fingerprints, all source adapters, JSON-LD import, Gmail alert parsing, fabrication guard, auto-apply decisions, email status rules, follow-ups, prompt-injection wrapping, Gemini schema conversion, PDF rendering |
| Worker (14) | `npm test -w @applypilot/api` | AES-GCM tokens, signed OAuth state, rate limiter, Gemini Interactions and generateContent parsing, 429 retry delays, `runAi` repair retry and budget enforcement, auth on all route groups, CORS, security headers |
| Database (12) | `npm run test:db` | all migrations applied to real Postgres (PGlite) with Supabase stubs: single-user trigger, RLS isolation, hidden Gmail token columns, read-only automation tables, storage folder policies, "applied requires confirmation", duplicate prevention, forged-evidence rejection, atomic queue claim, reaper, auto-apply opt-in |
| Web (5) | `npm test -w @applypilot/web` | match indicator accessibility, status labels, chart bucketing |
| n8n (4 + drift check) | `npm test -w @applypilot/n8n` | structural validation of all 10 workflows (node types, credentials, reachability, webhook auth, JS syntax), bundled adapters executed as an n8n Code node, empty-batch handling, generated JSON up to date |
| Runner unit (5) | `npm test -w @applypilot/runner` | screening-answer matching, applicant mapping, token checks |
| Runner e2e (4) | `npm run test:e2e -w @applypilot/runner` | real Chromium against the demo site: full submission with confirmation evidence, prefill without submitting, CAPTCHA stop, host allow-list |

`npm run check` runs lint, typecheck, every suite above except e2e, both builds and the n8n drift check. CI runs e2e as a separate job.

## Manual end-to-end test

1. `npm run demo-site` and the local runner (`npm run watch -w @applypilot/runner`), or GitHub Actions.
2. In the app, set **Automation center → Approval**, open **Discover jobs → Add demo job**, then **Prepare application**.
3. Review the documents and choose **Approve documents**, then **Fill form for review**. Screenshots appear under **Evidence** and the form is not submitted.
4. Choose **Approve & submit**. The application moves to *Applied* with a `DEMO-XXXXXX` reference, and `runner/demo-site/submissions/` contains the record.
5. Repeat with a job whose URL ends in `?captcha=1`. The application lands in the manual-action queue.

## Troubleshooting

| Symptom | Fix |
|---|---|
| Status bar shows **n8n** amber/red | n8n isn't polling. Check `docker compose ps`, make sure **00 Command Dispatcher** is active, and confirm `APPLYPILOT_API_URL` is reachable from the container (`docker compose exec n8n wget -qO- $APPLYPILOT_API_URL/health`). |
| n8n HTTP nodes return 401 | The *ApplyPilot Internal API* credential must be `Bearer <INTERNAL_API_TOKEN>` exactly. Re-run `node scripts/setup.mjs`. |
| Runs stay **queued** | The dispatcher is inactive, or the target workflow is inactive (the run is released and retried each minute). |
| `no_verified_resume` errors | Verify a version in **My resume**. Matching and tailoring only use verified data. |
| Scores say "rules only" | The AI budget is exhausted or `GEMINI_API_KEY` is missing. The deterministic fallback is intentional. Check **Analytics → AI usage**. |
| `ai_invalid_output` | The model returned JSON that failed validation twice. Retry later, or switch `GEMINI_API_STYLE`. |
| Gmail "Reconnect" notification | The refresh token expired (7-day Testing limit) or access was revoked. Reconnect in Integrations. |
| Gmail sync 429 | Gmail quota. Workflow 06 retries on its next schedule. |
| Worker error *exceeded CPU* | A batch was too large for the free plan. Reduce `limit`/`max` in the corresponding n8n node. |
| Playwright download fails with certificate errors | Antivirus HTTPS scanning (for example Avast). Set `NODE_EXTRA_CA_CERTS` to its root certificate. |
| Submission stuck *In progress* | The runner never reported back. The 15-minute sweep moves it to *Submission failed* after 1 h, and you can check the Actions logs. |
| Login says Supabase isn't configured | Create `apps/web/.env.local` from `.env.example`. |
