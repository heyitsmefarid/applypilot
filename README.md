# ApplyPilot AI

A self-hosted job discovery and application platform for one person. It finds jobs from
authorized sources, scores them against your **verified** resume, and tailors application
documents without inventing qualifications. It submits only through channels that permit it,
and only with your approval, then tracks replies in Gmail.

**Stack:** React + Vite + TypeScript + Tailwind v4 (Cloudflare Pages) · Cloudflare Workers (Hono) ·
Supabase (Postgres, Auth, Storage) · Gemini API free tier · **self-hosted n8n** (orchestration) ·
Playwright (GitHub Actions or local) · Gmail API. Designed to cost **₱0/month**.

```
Browser ─▶ Cloudflare Pages (React) ─JWT─▶ Cloudflare Worker ─▶ Supabase · Gemini · Gmail
                                                  ▲
           n8n (Docker, your machine/VM) ─────────┘  polls the run queue, runs every schedule
           Playwright runner (GitHub Actions/local) ─▶ Worker /runner/* (evidence, results)
```

See [docs/ARCHITECTURE.md](docs/ARCHITECTURE.md) for the full design, including the schema, workflows and security model.

## What it does

| Area | Highlights |
|---|---|
| **Discovery** | Remotive, Jobicy, Himalayas, Arbeitnow, Greenhouse/Lever/Ashby company boards, schema.org career pages (URL import), and **LinkedIn / Indeed / JobStreet / OnlineJobs.ph / Kalibrr via job-alert emails**, with no scraping. It respects per-source rate limits, removes duplicates across sources, and detects freshness and expiry. |
| **Matching** | Deterministic eligibility rules run first: location (Makati / Pasig / QC districts), Philippine applicant eligibility, salary floor (USD/PHP conversion), OJT hours, experience and freshness. Unknown values are **never assumed to qualify**. Gemini then scores the qualitative criteria. The 0–100 score is computed in code and is explainable. |
| **Resume Studio** | PDF/DOCX upload → in-browser text extraction → Gemini extraction → **your review and verification**. You can run a general enhancement, tailor to a specific job, and compare versions side by side. A **fabrication guard** removes invented employers, skills, certifications and metrics. Exports ATS-friendly PDFs. |
| **Applications** | Tailored resume, cover letter, application email and screening answers for each job, with version history and approval. A Kanban board and table cover 13 statuses, with the status history and audit trail. |
| **Automation modes** | **Manual**, **Approval** (prefill for review, then you approve) and **Conditional auto-apply** (explicit opt-in, allowed sources, minimum score and salary, excluded companies, daily cap). An emergency pause is always visible. |
| **Playwright** | Fills forms only on allow-listed hosts. It **stops at CAPTCHAs** and sends the application to the manual queue. It captures screenshots and a confirmation reference. An application is marked *applied* **only with evidence**, or when you confirm it manually. |
| **Gmail** | OAuth 2.0 with AES-256-GCM token storage. Incremental sync imports job alerts and classifies employer replies. A status changes only at ≥ 0.85 confidence. Interviews are extracted into a calendar view (.ics). Reply and follow-up drafts are **sent only after you confirm**. |
| **n8n** | 10 importable workflows: dispatcher, discovery, resume analysis, matching, preparation, submission, Gmail, follow-up, reports (in-app, Gmail and Telegram) and error recovery (retries with backoff). |

## Repository layout

```
apps/web        React app (13 pages + job/application detail + login)
apps/api        Cloudflare Worker API (user, n8n-internal and runner routes + cron)
packages/core   Shared TypeScript: schemas, eligibility, scoring, adapters, prompts, PDF, guards
supabase        Migrations (schema, RLS, storage, RPC) + PGlite test suite
n8n             docker-compose, typed workflow builders, generated workflows/*.json, setup script
runner          Playwright runner, demo application site, e2e tests
.github         CI + apply-runner (workflow_dispatch)
docs            Architecture, deployment, n8n, security, testing, feature status
```

## Quick start (local)

Prerequisites: Node ≥ 22.22, Docker Desktop (for n8n), a free Supabase project, a Gemini API key
(Google AI Studio) and, optionally, a Google Cloud OAuth client for Gmail.

```bash
npm install

# 1. Database: apply the migrations to your Supabase project
npx supabase link --project-ref <ref> && npx supabase db push
#    Then create your single account: Supabase dashboard → Authentication → Users → Add user.
#    Keep "Allow new users to sign up" OFF (Authentication → Providers → Email).

# 2. Worker API
cp apps/api/.dev.vars.example apps/api/.dev.vars    # fill in secrets
npm run dev:api                                     # http://localhost:8787

# 3. Web app
cp apps/web/.env.example apps/web/.env.local        # publishable key only
npm run dev:web                                     # http://localhost:5173

# 4. n8n
cd n8n && cp .env.example .env && docker compose up -d
#    create the n8n owner at http://localhost:5678, then:
node scripts/setup.mjs                              # imports credentials + 10 workflows

# 5. Try the full flow safely with the demo application form
npm run demo-site                                   # http://localhost:4321
#    Discover jobs → "Add demo job" → Prepare application → Approve → Fill form / Approve & submit
npm run watch -w @applypilot/runner                 # local Playwright runner (if not using GitHub Actions)
```

Full instructions for every service, including Google OAuth, GitHub Actions secrets, Cloudflare
deploys and the Oracle Cloud Always Free VM, are in **[docs/DEPLOYMENT.md](docs/DEPLOYMENT.md)**.

> **Local n8n stops when your computer is off or asleep.** Dashboard commands wait safely in the
> queue and run when n8n is back. The status bar and a Cloudflare Cron watchdog warn you about this.
> For unattended 24/7 automation, host n8n on an always-on VM.

## Scripts

| Command | What it does |
|---|---|
| `npm run check` | lint + typecheck + all tests + builds + n8n workflow drift check |
| `npm test` | core, Worker, web, n8n and runner unit tests + database migration tests (PGlite) |
| `npm run test:e2e -w @applypilot/runner` | Playwright runner against the demo application site |
| `npm run n8n:build` | regenerate `n8n/workflows/*.json` from the typed builders |

## Documentation

- [Architecture](docs/ARCHITECTURE.md): components, data flows, schema and workflows
- [Deployment](docs/DEPLOYMENT.md): Supabase, Worker, Pages, Google OAuth, GitHub runner, n8n local and Oracle VM
- [n8n workflows](docs/N8N.md): each workflow, its nodes and its credentials
- [Security](docs/SECURITY.md): threat model and controls
- [Testing & troubleshooting](docs/TESTING.md)
- [Feature status](docs/STATUS.md): what is implemented, what is partial, and what is deliberately unsupported

## Responsible automation

ApplyPilot never scrapes platforms that restrict automated access, never bypasses CAPTCHAs or
anti-bot systems, and never submits to a source you haven't explicitly marked as permitting
automation. LinkedIn, Indeed, JobStreet and OnlineJobs.ph jobs reach you through their own
job-alert emails, and you apply to them yourself.
