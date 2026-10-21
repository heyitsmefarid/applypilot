# Security

ApplyPilot handles a resume, a Gmail inbox and the ability to submit job applications, so these
are the controls in place and the threats each one addresses.

## Identity and access

| Control | Where |
|---|---|
| Single user. Public signups are off, a `before insert on auth.users` trigger refuses a second account, and the Worker checks `ALLOWED_USER_EMAIL` | Supabase Auth, migration 0004, `lib/auth.ts` |
| The browser only ever has the publishable key, and Row Level Security covers **every** table (`force row level security`) | migration 0003 |
| Automation-owned tables (`job_matches`, `automation_runs`, `ai_usage_logs`, `audit_logs`) are read-only to the user role | migration 0003 |
| Column grants stop the browser forging `submission_evidence`, `auto_approved`, the attempt counters or the verified-resume pointer | migration 0003 |
| JWTs are verified against the project JWKS (or the legacy HS256 secret), with audience and issuer checks | `lib/auth.ts` |
| Machine tokens (n8n, runner) are separate, at least 24 characters, compared in constant time, and scoped to their own route groups | `lib/auth.ts` |

## Secrets

- Gmail OAuth tokens are encrypted with **AES-256-GCM** (random IV, versioned format) before
  storage. Their columns aren't readable by the browser role. Disconnecting revokes the grant at Google.
- The OAuth `state` is an HMAC-signed token that expires in 10 minutes and binds to the user id.
- The Supabase secret key, Gemini key, Google client secret, encryption keys and GitHub token exist
  only as Worker secrets. n8n stores its two tokens as **encrypted n8n credentials**. GitHub Actions
  stores the runner token as a repository secret.
- `.env`, `.dev.vars` and `n8n/data` are git-ignored, and `.env.example` files contain placeholders only.
- Logs never print tokens. AI usage logs store token counts, not prompts.

## Automation safety

- **Emergency pause** in the status bar cancels queued runs, flags running ones, and every
  automated endpoint refuses to act (HTTP 423) while it's on.
- **Never "applied" without evidence.** A database `CHECK` constraint requires `submitted_at` and
  `confirmed_by` for the `applied` status, and `confirmed_by = 'evidence'` requires a stored
  evidence record. The Worker only records evidence when a screenshot was uploaded *and* a
  confirmation message or reference was detected.
- **Duplicate prevention:** `unique (user_id, job_id)` on applications, plus an atomic conditional
  update that moves an application into `submission_in_progress` exactly once. Submission runs
  are never retried automatically.
- **Auto-apply** requires an explicit opt-in (timestamped by a trigger and enforced by a constraint),
  allowed sources, a minimum score and salary (unknown salary never qualifies), excluded companies
  and a daily cap.
- The runner works only on allow-listed hosts for sources marked as permitting automation. It
  stops at any CAPTCHA or anti-bot challenge and never interacts with one. Consent checkboxes are
  ticked only for user-approved submissions.
- Emails, replies and follow-ups are only ever sent from an explicit dashboard confirmation
  (`confirm: true` in the request body). They're never sent from n8n.

## AI safety

- Untrusted text (job posts, career pages, emails, even the uploaded resume) is wrapped in
  `<untrusted>` blocks. Delimiter tags inside it are neutralized, control and bidi characters are
  stripped, it's truncated, and phrases that look like prompt injection are flagged to the model as data.
- Every response is constrained by a JSON schema and validated with Zod, with one repair retry.
- The model never decides consequential actions. Scores are computed in code, eligibility is
  deterministic, status changes need ≥ 0.85 confidence plus forward-only transitions, and
  submissions go through the rules above.
- The **fabrication guard** compares every AI rewrite with the verified resume. It removes
  unsupported employers, skills, certifications, technologies, links and new numeric claims, and
  restores identity fields and dates. Each violation is shown to the user.

## Network

- **SSRF:** URL import accepts only `https`, blocks private, link-local and internal hostnames, and
  refuses platforms that prohibit automated access.
- The CORS allow-list contains only the configured frontend origins. `secureHeaders` is applied to
  the Worker, and `_headers` gives Pages a CSP, `frame-ancestors 'none'`, `nosniff` and a strict referrer policy.
- The n8n editor binds to `127.0.0.1`. It needs no inbound access. The optional tunnel exposes
  only header-authenticated webhooks.
- GitHub `workflow_dispatch` receives only a UUID, which is validated before use. Personal data is
  fetched at runtime and is never written to Actions artifacts.

## Known limitations

- The per-isolate request limiter is best-effort. The durable limits (AI budget, daily submissions) live in Postgres.
- Free-tier Gemini prompts may be used by Google to improve its products, which is shown in the UI.
- Google OAuth apps in Testing status expire refresh tokens after 7 days.
