# ApplyPilot AI — System Architecture

ApplyPilot AI is a single-user job discovery and application platform. It runs on
free tiers: Cloudflare Pages + Workers, Supabase Free, the Gemini API free tier,
self-hosted n8n (Docker) and Playwright on GitHub Actions or a local machine.

## 1. High-level topology

```
                ┌──────────────────────────── Cloudflare ────────────────────────────┐
 Browser ──────►│ Pages: React SPA (apps/web)                                         │
   │            │                                                                     │
   │  JWT       │ Worker: REST API (apps/api)                                         │
   └───────────►│  /api/*       user routes (Supabase JWT, single allowed user)       │
                │  /internal/*  n8n + runner routes (bearer token, constant-time)     │
                │  cron         stale-run reaper, n8n heartbeat watchdog              │
                └───────┬───────────────┬──────────────────┬─────────────────────────┘
                        │ secret key    │ API key          │ OAuth tokens (AES-GCM at rest)
                        ▼               ▼                  ▼
                 Supabase (DB,      Gemini API        Gmail API
                 Auth, Storage)     (free tier)
                        ▲
   RLS-scoped reads/    │
   writes from browser ─┘

 Local machine / Oracle VM                         GitHub Actions
 ┌───────────────────────────────┐                ┌───────────────────────────┐
 │ n8n (Docker Compose)          │  workflow_     │ Playwright runner         │
 │  • schedules every workflow   │  dispatch      │  (runner/)                │
 │  • polls /internal/runs/claim │ ─────────────► │  • fills authorized forms │
 │  • fetches job sources        │  (via Worker)  │  • uploads evidence       │
 │  • normalizes with core lib   │                │  • reports to Worker      │
 │  • calls Worker internal API  │                └───────────────────────────┘
 └───────────────────────────────┘
```

### Responsibilities

| Component | Owns | Never does |
|---|---|---|
| **React SPA** | UI, RLS-scoped CRUD, resume text extraction (pdf.js / mammoth), PDF export | Hold service keys, call Gemini or Gmail directly |
| **Worker API** | Auth, Gemini calls (prompt versions, schema validation, budgets), Gmail OAuth/token custody, privileged DB writes, submission guards, run queue | Long-running browser automation, scheduling the main workflows |
| **n8n** | **Orchestration**: schedules, triggers, fan-out, retries, rate-limited batching, source fetching, next-step chaining, notifications (in-app/Telegram) | Hold Supabase or Gemini credentials (it only holds the Worker internal token) |
| **Playwright runner** | Browser form filling on allow-listed hosts, evidence capture | Bypass CAPTCHAs, run on non-allow-listed hosts, mark applications applied |
| **Supabase** | Postgres + RLS, Auth (signups disabled), private Storage buckets | — |

### Why n8n talks to the Worker, not straight to Supabase

n8n gets one scoped credential, the internal API token. That token can only reach the
`/internal/*` endpoints, and each endpoint enforces business rules: the pause switch,
duplicate prevention, daily limits, the AI budget and schema validation. n8n never
holds the Supabase service key, so a leaked n8n instance cannot dump the database.

### Command queue (no public n8n exposure)

Dashboard actions such as "Run discovery now", "Prepare application" and "Approve
submission" insert a `queued` row into `automation_runs`. The **Command Dispatcher**
n8n workflow polls `POST /internal/runs/claim` every minute. The claim is an atomic
`FOR UPDATE SKIP LOCKED` update, so a run can't be claimed twice. The dispatcher then
calls the matching workflow's local webhook. Because local n8n only makes outbound
HTTPS calls, it never has to be exposed.

Optional push mode: if `N8N_WEBHOOK_BASE_URL` is configured, for example through a
Cloudflare Tunnel, the Worker claims the run itself and pushes it to the n8n webhook with
a shared header secret. If the push fails, the run is released back to `queued`.

### Scheduling (no duplicate executions)

* **n8n schedules** all of the main workflows: discovery, matching, Gmail, follow-ups and reports.
* **Cloudflare Cron** does only two jobs, and neither depends on n8n:
  1. Reap runs stuck in `running` past their timeout and mark them failed.
  2. Watchdog: notify if n8n has not polled the queue for 3+ hours.

  Neither job duplicates an n8n workflow.

> **Local n8n stops when your computer is off.** Queued commands wait in Supabase
> until n8n comes back, and nothing is lost. For unattended, 24/7 operation, host n8n
> on an always-on machine such as the Oracle Cloud Always Free VM guide in
> `docs/DEPLOYMENT.md`.

## 2. Data flow per feature

1. **Resume upload**: the browser stores the file in the private `resumes/{uid}/…` bucket,
   extracts the text, then inserts a `resumes` row with status `uploaded`. It then calls
   `POST /api/ai/resumes/:id/extract`, which has Gemini produce structured `ResumeData`
   and saves it as resume version 1 (`kind = extracted`). The user reviews the data,
   corrects it and **verifies** it. Only verified versions feed matching and tailoring.
   Workflow 2 catches uploads that were never analyzed.
2. **Discovery** (Workflow 1): plan → fetch sources → normalize with `@applypilot/core`
   adapters (bundled into the n8n Code node) → `/internal/jobs/ingest`. Ingest
   deduplicates on `(source_key, external_id)` and a cross-source fingerprint, upserts,
   and returns the new IDs. The workflow then queues a `job_matching` run.
3. **Matching** (Workflow 3): deterministic eligibility runs first and is free. Only jobs
   that pass the pre-filter go to Gemini for the qualitative criteria. The final score is
   computed in code, and a failed eligibility check caps it at 35. AI-claimed skills that
   aren't on the resume are discarded.
4. **Preparation** (Workflow 4): tailored resume → the fabrication guard compares it with
   the verified resume → cover letter → application email → screening answers. Every
   document is stored as a `draft` in `application_documents`, and the application moves
   to `draft_prepared`.
5. **Submission** (Workflow 5): the guards are paused switch → source
   `automation_allowed` → duplicate check → mode and approval → daily limit (auto mode).
   The Worker then calls GitHub `workflow_dispatch`, or the local runner picks the job
   up. The runner fills the form, stops at CAPTCHA, and submits only in submit mode. It
   uploads screenshots and posts the result. The Worker marks the application `applied`
   **only** when there is evidence.
6. **Gmail** (Workflow 6): incremental sync (Gmail search query + `historyId`) →
   keyword pre-filter → Gemini classification → deterministic linking to an application
   (sender domain, company and title in the email) → an automatic status change only for a
   Gmail-verified sender belonging to that employer or a hiring platform, with confidence
   ≥ 0.85. Anything else becomes a suggestion you approve. Reply drafts are saved and
   **never sent without explicit approval**.

## 3. Repository layout

```
.
├── apps/
│   ├── web/                 React 19 + Vite + TS + Tailwind v4 + shadcn-style components
│   │   └── src/{components,features,hooks,lib,pages,routes}
│   └── api/                 Cloudflare Worker (Hono) — routes, services, Gemini, Gmail
├── packages/
│   └── core/                Shared TS: schemas, constants, eligibility, scoring,
│                            salary/location parsing, dedupe, fabrication guard,
│                            source adapters, prompts, PDF rendering
├── supabase/
│   ├── config.toml          signups disabled
│   ├── migrations/          schema, RLS, storage, RPC
│   └── tests/               SQL smoke tests
├── n8n/
│   ├── docker-compose.yml   n8n + Postgres, persistent volumes, encryption key
│   ├── src/                 typed workflow builders (source of truth)
│   ├── workflows/           generated importable JSON (committed)
│   └── scripts/             credential + workflow import
├── runner/                  Playwright runner, adapters, demo application site, e2e tests
├── .github/workflows/       ci.yml, apply-runner.yml
└── docs/                    architecture, deployment, n8n, security, testing, status
```

## 4. Database schema (Supabase Postgres)

Every table has `user_id → auth.users`, `created_at`, `updated_at` (trigger) and RLS
`user_id = (select auth.uid())`. The Worker uses the secret key for internal routes and
always filters by the single owner's id.

| Table | Purpose / key columns |
|---|---|
| `profiles` | 1:1 with auth user; contact info, timezone, `verified_resume_version_id` |
| `resumes` | uploaded file metadata, `extracted_text`, `analysis`, `status` |
| `resume_versions` | `content` (ResumeData JSON), `kind` (extracted/manual/ai_enhanced/tailored), `status` (draft/approved/rejected), `is_verified`, `ai_changes`, `job_id` for tailored |
| `skills` | normalized verified skills (unique per user + normalized name) |
| `job_preferences` | search profiles (Internship, Remote) — roles, keywords, locations, arrangement, salary floor, OJT hours, freshness, min score |
| `job_sources` | adapters + config, `enabled`, `automation_allowed`, rate limits, last status |
| `job_listings` | normalized jobs; unique `(user_id, source_key, external_id)`, `fingerprint`, FTS vector, freshness/expiry, hidden flag |
| `job_matches` | score, breakdown, matched/missing skills, eligibility, explanation, recommendation, model + prompt version |
| `saved_jobs` | bookmarks |
| `job_searches` | manual search history |
| `applications` | one per job (unique), `status` enum (13 states), mode, channel, documents, evidence, follow-up fields |
| `application_documents` | tailored resume / cover letter / email / screening answers / follow-up drafts with versions + approval |
| `application_events` | status history and audit trail (trigger-written) |
| `gmail_connections` | encrypted tokens (column privileges hide them from the browser), historyId |
| `recruitment_messages` | stored Gmail messages, category, confidence, extracted data, linked application, suggested reply |
| `interview_schedules` | interviews from email or manual entry |
| `automation_rules` | mode, auto-apply rules, daily cap, emergency pause, notification settings |
| `automation_runs` | queue + execution log, idempotency key, attempts, heartbeat, n8n execution id |
| `notifications` | in-app notifications with dedupe key |
| `ai_usage_logs` | per-call tokens, latency, status → daily budget enforcement |
| `audit_logs` | security-relevant actions (pause, approvals, Gmail connect/send) |

Key RPCs: `claim_automation_runs` and `begin_application_submission`, both limited to
the service role, and `dashboard_stats`, which the user can call.

## 5. n8n workflows

| # | Workflow | Triggers | Core steps |
|---|---|---|---|
| 00 | Command Dispatcher | every 1 min | claim queued runs → POST local webhook |
| 01 | Job Discovery | hourly + webhook | start run → plan → fetch each source (retry, continue on fail) → normalize (core bundle) → ingest → expire stale → queue matching → finish |
| 02 | Resume Analysis | every 30 min + webhook | pending resumes → extract/analyze → finish |
| 03 | Job Matching | webhook (+ every 2 h sweep) | pending matches → score each (4.5 s spacing) → queue prep for rule-matching jobs → finish |
| 04 | Application Preparation | webhook | prepare docs → notify docs ready → finish |
| 05 | Application Submission | webhook + 5 min result sweep | dispatch to runner (guards in Worker) → result notifications |
| 06 | Gmail Monitoring | every 30 min + webhook | sync batch → classify each → finish |
| 07 | Follow-up | daily 09:00 | scan due applications → drafts + approval notifications |
| 08 | Notifications & Reports | daily 08:00, weekly Mon 08:00, hourly interviews | build report → in-app + optional Telegram |
| 09 | Error Recovery | n8n Error Trigger + every 15 min | record failure, notify, auto-retry retryable runs with backoff |

Every workflow: header-authenticated webhook, `Start run` (pause check), per-item
error isolation (`onError: continueRegularOutput`), retries with backoff on HTTP nodes,
and `Finish run` with stats.

## 6. AI architecture

* `apps/api/src/ai/gemini.ts`: Interactions API client (`generateContent` fallback),
  timeout, retries with jitter that respect `retryDelay`, and model configuration.
* `packages/core/src/prompts`: versioned prompts (`resume-extract@1`, `job-match@1`, …) plus Zod
  output schemas. Each schema is converted to the JSON Schema subset Gemini supports.
* Every AI response is parsed and validated with Zod. Invalid output is retried once,
  then stored as `invalid_output`.
* Untrusted text (job posts, web pages, emails) is wrapped in delimited blocks with
  explicit "this is data" instructions and truncated. Any action the model proposes
  goes through deterministic guards. The model can never trigger a send or submit.
* `ai_usage_logs` sets a daily request budget (default 200). When the budget runs out,
  matching falls back to deterministic scoring.

## 7. Security model

* Single user: `enable_signup = false`, and a DB trigger refuses a second `auth.users`
  row. The Worker also checks `ALLOWED_USER_EMAIL`.
* The browser only ever has the publishable key, with RLS on. The secret key,
  Gemini key, Google client secret, token-encryption key and GitHub token live in
  Worker secrets.
* Gmail tokens are encrypted with AES-256-GCM, and their columns are revoked from `anon`
  and `authenticated`.
* The internal API uses a bearer token with constant-time comparison. n8n webhooks use
  a header-auth secret. The runner uses its own token, scoped to runner routes.
* Rate limiting: the API has a per-isolate token bucket, the AI has a DB-backed daily
  budget, and job sources have minimum-interval checks.
