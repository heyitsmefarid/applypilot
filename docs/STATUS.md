# Feature status

**Implemented** means built and covered by automated tests or verified locally. Items marked
**needs credentials** are implemented in code but could only be tested against stubs here,
because they need your own accounts (Supabase project, Gemini key, Google OAuth client, GitHub
repository, running n8n).

## Implemented

| Area | Status | Notes |
|---|---|---|
| Database schema, RLS, storage, RPC | Implemented | 4 migrations, 21 tables, verified on real Postgres (PGlite) |
| Single-user auth | Implemented | Signup off, DB trigger, Worker email check |
| React app (13 pages + details + login) | Implemented | Light/dark, collapsible sidebar, mobile layout checked at 390 px for overflow, skeletons, empty states, confirmation dialogs, realtime refresh |
| Dashboard & analytics | Implemented | Live Supabase data, validated chart palette, table views |
| Resume upload / preview / download / replace / delete | Implemented | Private bucket, browser-side PDF/DOCX text extraction |
| Resume extraction, analysis, enhancement, tailoring | Implemented · needs credentials (Gemini) | Versioned prompts, schema validation, fabrication guard (tested) |
| Resume comparison, manual editing, approval, verification | Implemented | |
| ATS-friendly PDF export (resume, cover letter) | Implemented | jsPDF, real selectable text |
| Job discovery: Remotive, Jobicy, Himalayas, Arbeitnow, Greenhouse, Lever, Ashby | Implemented | Adapters verified against live API response shapes; rate limits and terms honoured |
| Job alerts: LinkedIn, Indeed, JobStreet, OnlineJobs.ph, Kalibrr | Implemented · needs credentials (Gmail) | Parsed from alert emails |
| Career-page import (schema.org JobPosting) | Implemented | With manual-entry fallback |
| Search, filters, freshness, dedupe, expiry, bookmarks, hidden jobs, search history | Implemented | |
| Deterministic eligibility + explainable scoring | Implemented | Both default profiles tested |
| AI matching, cover letter, email, screening answers | Implemented · needs credentials (Gemini) | |
| Application tracking (Kanban + table, 13 statuses, history, notes, evidence) | Implemented | |
| Automation modes, rules, emergency pause | Implemented | Enforced in Worker and DB |
| Playwright runner + demo form | Implemented | e2e-tested with real Chromium |
| GitHub Actions dispatch | Implemented · needs credentials (GitHub PAT) | |
| Gmail OAuth, sync, classification, linking, interviews, approved sending | Implemented · needs credentials (Google OAuth) | |
| Follow-up drafts | Implemented · needs credentials (Gemini) | |
| Notifications (in-app realtime, Gmail-to-self, Telegram) | Implemented · Telegram needs a bot token | |
| n8n: 10 workflows, Docker Compose, credential import | Implemented · needs Docker | Validated structurally; Code nodes execute in tests. Not yet run inside a live n8n instance (no Docker on the build machine) |
| Cloudflare Worker + Pages configuration | Implemented | Worker bundles at 356 KB gzip; deploy needs your Cloudflare account |

## Partially implemented

| Item | What's missing |
|---|---|
| Generic ATS form filling | Works on standard labelled forms (verified on the demo site). Multi-step wizards, custom widgets and login-gated portals go to the manual queue. |
| Gmail push notifications (Pub/Sub watch) | A scheduled sync every 30 min is used instead. Gmail watch needs a Pub/Sub topic plus a public push endpoint (or a pull subscriber), which adds setup for little gain at this volume. |
| n8n workflow activation | Workflows are imported inactive on purpose. Activation is a manual step in the editor. |
| Interview time zones | Uses the time zone the email gives (ISO offset). Ambiguous times are marked "needs confirmation". |

## Deliberately unsupported

| Item | Why |
|---|---|
| Scraping LinkedIn, Indeed, JobStreet or OnlineJobs.ph, or auto-submitting to them | Their terms prohibit automated access. Jobs arrive through their alert emails and you apply yourself. |
| CAPTCHA solving or anti-bot evasion | Never. The runner stops and hands over. |
| Automatic email replies | Sending always requires your confirmation. |
| Ollama / paid OpenAI APIs | Out of scope by design. Gemini free tier only. |
| Multi-user accounts | Single-user system by design. |
