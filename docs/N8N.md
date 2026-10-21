# n8n workflows

n8n is the orchestration engine. It owns every schedule, fan-out, retry, rate-limited batch and
next-step hand-off. Business rules and secrets stay in the Worker, so n8n holds exactly one
privileged credential: the internal API token.

The workflows are defined in TypeScript (`n8n/src/workflows.ts`) and generated into importable
JSON (`n8n/workflows/*.json`) by `npm run n8n:build`. CI fails if the JSON drifts from the source.
The job-source adapters run inside n8n as a 19 KB bundle of the same unit-tested
`@applypilot/core` code, so there's no hand-copied logic.

## Credentials (created by `scripts/setup.mjs`)

| Credential | Type | Value | Used by |
|---|---|---|---|
| **ApplyPilot Internal API** (`apInternalApiKey`) | Header Auth | `Authorization: Bearer <INTERNAL_API_TOKEN>` | Every HTTP node calling `/internal/*` |
| **ApplyPilot Webhook Auth** (`apWebhookAuthKey`) | Header Auth | `X-ApplyPilot-Webhook-Token: <APPLYPILOT_WEBHOOK_TOKEN>` | All Webhook triggers, plus the dispatcher's delivery node |
| **ApplyPilot Telegram Bot** (`apTelegramBotKey`) | Telegram API | bot token from @BotFather | Workflow 08 only (optional) |

To set them up manually instead: **Credentials → Add → Header Auth / Telegram API**. Use the exact
names above, then open each workflow and select the credential on any node that shows a warning.

Environment variables read by workflows (non-secret): `APPLYPILOT_API_URL`, `N8N_INTERNAL_WEBHOOK_BASE`
and `TELEGRAM_CHAT_ID`. `N8N_BLOCK_ENV_ACCESS_IN_NODE=false` is set in docker-compose for this reason.

## Common pattern

Every business workflow has the same skeleton:

```
Schedule ─┐
          ├─▶ Resolve run ─▶ Start run ─▶ Gate ─▶ …work… ─▶ Summarize ─▶ Finish run
Webhook ──┘   (run_id?)     (claim/create,  (stops if paused
                             pause check)    or cancelled)
```

- **Idempotency:** dashboard commands become `automation_runs` rows, and the dispatcher claims
  them with `FOR UPDATE SKIP LOCKED`. Follow-up runs use idempotency keys such as `match:<run>`
  and `prep:<run>`.
- **Error isolation:** item-level HTTP nodes use *Continue (regular output)*, so one failed job,
  email or source is recorded in `item_errors` while the rest of the batch completes. A batch
  with failures finishes as `partial`.
- **Retries:** HTTP nodes retry transient errors 2–3 times with waits. Workflow 09 re-queues
  failed runs with 10/20/40-minute backoff, and only for retryable errors.
- **Rate limits:** batching intervals pace Gemini (about 9/min), Gmail and the job sources. The
  Worker enforces the authoritative limits (AI RPM and daily budget, source minimum intervals).
- **Empty batches:** n8n ends a branch on zero items, so empty lists emit one `noop` item (sent
  to `/health`). This keeps the *Finish run* step reliable.
- **Error workflow:** every workflow sets *Error Workflow* to **09 Error Recovery**. That records
  the failure against the run (via `n8n_execution_id`) and notifies you when retries are exhausted.

## Workflows

| File | Triggers | Steps |
|---|---|---|
| `00-command-dispatcher` | every minute | claim ≤ 5 queued runs → POST each to its workflow's local webhook → release any that couldn't be delivered (for example, an inactive workflow). Successful executions aren't saved, to keep history small. |
| `01-job-discovery` | hourly, webhook | load sources & preferences (rate-limit-aware plan) → split requests → **Fetch source** (one per source, retry, continue on fail) → **Normalize listings** (core adapters) → **Store jobs** (validate, dedupe, upsert, chunks of 100) → collect stats → expire stale listings → queue Workflow 03 for new jobs → finish |
| `02-resume-analysis` | every 30 min, webhook | unprocessed resumes → extract (Gemini) + analyze, paced 8 s → finish |
| `03-job-matching` | webhook (from 01), 2-hourly sweep | jobs awaiting a score → **Score job** (rules → Gemini only if eligible, 6.5 s pacing) → summarize → queue Workflow 04 for jobs meeting your auto-prepare rule → finish |
| `04-application-preparation` | webhook | tailored resume (fabrication-guarded), cover letter, email, screening answers per job (30 s pacing, 4 AI calls each) → queue auto-submission **only** in conditional auto-apply with document approval off → finish |
| `05-application-submission` | webhook; 15-min sweep | Worker checks pause → source permission → host allow-list → duplicates → mode/approval → auto-apply rules → daily cap → dispatches GitHub Actions or the local runner. **Never retried automatically.** The runner reports straight to the Worker, which finishes the run. The sweep releases submissions with no report after 1 h. |
| `06-gmail-monitoring` | every 30 min, webhook | incremental sync (≤ 15 messages; alert emails → jobs) → unclassified messages → classify & link (automatic status change only for verified employer or ATS senders at ≥ 0.85 confidence; otherwise suggested) → finish |
| `07-follow-up` | daily 09:00, webhook | draft follow-ups for applications past their interval with no reply (approval required to send) |
| `08-notifications-reports` | daily 08:00, Monday 08:00, hourly, daily 18:00, webhook | daily summary / weekly stats / interview reminders / pending approvals → in-app notification (+ Gmail to yourself if enabled) → Telegram if enabled |
| `09-error-recovery` | Error Trigger; every 15 min | record n8n failures against runs; re-queue retryable failed runs with backoff |

All workflows are imported **inactive** so you can review them first. Activate them in this order:
09, then 00, then the rest.

## Changing a workflow

Edit `n8n/src/workflows.ts`, run `npm run n8n:build`, then re-run `node scripts/setup.mjs`. The
same ids are updated in place. If you edit in the n8n editor instead, export the result over the
JSON file. Note that the next `n8n:build` would overwrite it, so port lasting changes to the TypeScript.
