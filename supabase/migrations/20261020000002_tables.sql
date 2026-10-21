-- ApplyPilot AI — core tables
-- Every row is owned by a single auth user (user_id). RLS is enabled in the next migration.

-- ─── Profile ────────────────────────────────────────────────────────────────
create table public.profiles (
  id uuid primary key references auth.users (id) on delete cascade,
  email text not null,
  full_name text not null default '',
  phone text not null default '',
  location text not null default '',
  headline text not null default '',
  timezone text not null default 'Asia/Manila',
  portfolio_url text not null default '',
  linkedin_url text not null default '',
  github_url text not null default '',
  verified_resume_version_id uuid,
  onboarded_at timestamptz,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  constraint profiles_email_len check (char_length(email) <= 320)
);

-- ─── Resumes ────────────────────────────────────────────────────────────────
create table public.resumes (
  id uuid primary key default gen_random_uuid(),
  user_id uuid not null default auth.uid() references auth.users (id) on delete cascade,
  title text not null,
  file_path text not null,
  file_name text not null,
  mime_type text not null,
  file_size integer not null,
  extracted_text text,
  status text not null default 'uploaded',
  analysis jsonb,
  analysis_error text,
  analyzed_at timestamptz,
  is_primary boolean not null default false,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  constraint resumes_status_chk check (status in ('uploaded', 'extracting', 'extracted', 'analyzing', 'analyzed', 'failed')),
  constraint resumes_mime_chk check (mime_type in ('application/pdf', 'application/vnd.openxmlformats-officedocument.wordprocessingml.document')),
  constraint resumes_size_chk check (file_size > 0 and file_size <= 10485760),
  constraint resumes_title_len check (char_length(title) between 1 and 160)
);
create index resumes_user_idx on public.resumes (user_id, created_at desc);
create unique index resumes_one_primary on public.resumes (user_id) where is_primary;

create table public.resume_versions (
  id uuid primary key default gen_random_uuid(),
  user_id uuid not null default auth.uid() references auth.users (id) on delete cascade,
  resume_id uuid not null references public.resumes (id) on delete cascade,
  version_number integer not null,
  label text not null default '',
  kind text not null,
  content jsonb not null,
  based_on_version_id uuid references public.resume_versions (id) on delete set null,
  job_id uuid,
  ai_changes jsonb not null default '[]'::jsonb,
  guard_violations jsonb not null default '[]'::jsonb,
  status text not null default 'draft',
  is_verified boolean not null default false,
  verified_at timestamptz,
  model text,
  prompt_version text,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  constraint resume_versions_kind_chk check (kind in ('extracted', 'manual', 'ai_enhanced', 'tailored')),
  constraint resume_versions_status_chk check (status in ('draft', 'approved', 'rejected')),
  constraint resume_versions_verified_chk check (not is_verified or status = 'approved'),
  constraint resume_versions_unique unique (resume_id, version_number)
);
create index resume_versions_user_idx on public.resume_versions (user_id, created_at desc);
create index resume_versions_job_idx on public.resume_versions (job_id) where job_id is not null;

alter table public.profiles
  add constraint profiles_verified_version_fk
  foreign key (verified_resume_version_id) references public.resume_versions (id) on delete set null;

create table public.skills (
  id uuid primary key default gen_random_uuid(),
  user_id uuid not null default auth.uid() references auth.users (id) on delete cascade,
  name text not null,
  normalized_name text not null,
  category text not null default 'other',
  proficiency text,
  years numeric(4, 1),
  source text not null default 'resume',
  verified boolean not null default true,
  resume_version_id uuid references public.resume_versions (id) on delete set null,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  constraint skills_category_chk check (category in ('language', 'framework', 'library', 'database', 'tool', 'cloud', 'platform', 'soft', 'other')),
  constraint skills_proficiency_chk check (proficiency is null or proficiency in ('beginner', 'intermediate', 'advanced')),
  constraint skills_source_chk check (source in ('resume', 'manual')),
  constraint skills_years_chk check (years is null or years between 0 and 50),
  constraint skills_unique unique (user_id, normalized_name)
);

-- ─── Job search configuration ───────────────────────────────────────────────
create table public.job_preferences (
  id uuid primary key default gen_random_uuid(),
  user_id uuid not null default auth.uid() references auth.users (id) on delete cascade,
  name text not null,
  is_active boolean not null default true,
  roles text[] not null default '{}',
  keywords text[] not null default '{}',
  excluded_keywords text[] not null default '{}',
  locations text[] not null default '{}',
  work_arrangements text[] not null default '{}',
  employment_types text[] not null default '{}',
  experience_levels text[] not null default '{}',
  min_salary_amount numeric(12, 2),
  salary_currency text default 'USD',
  salary_period text default 'hour',
  require_ph_eligible boolean not null default false,
  required_ojt_hours integer,
  max_posting_age_days integer not null default 3,
  min_match_score integer not null default 70,
  search_frequency_minutes integer not null default 60,
  excluded_companies text[] not null default '{}',
  source_keys text[] not null default '{}',
  php_per_usd numeric(8, 2) not null default 58,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  constraint job_prefs_name_len check (char_length(name) between 1 and 80),
  constraint job_prefs_arrangements_chk check (public.array_subset(work_arrangements, array['remote', 'hybrid', 'onsite', 'unknown'])),
  constraint job_prefs_employment_chk check (public.array_subset(employment_types, array['full_time', 'part_time', 'contract', 'freelance', 'internship', 'unknown'])),
  constraint job_prefs_levels_chk check (public.array_subset(experience_levels, array['internship', 'entry', 'junior', 'mid', 'senior', 'unknown'])),
  constraint job_prefs_period_chk check (salary_period is null or salary_period in ('hour', 'day', 'week', 'month', 'year')),
  constraint job_prefs_salary_chk check (min_salary_amount is null or min_salary_amount >= 0),
  constraint job_prefs_ojt_chk check (required_ojt_hours is null or required_ojt_hours between 1 and 5000),
  constraint job_prefs_age_chk check (max_posting_age_days between 1 and 90),
  constraint job_prefs_score_chk check (min_match_score between 0 and 100),
  constraint job_prefs_freq_chk check (search_frequency_minutes between 60 and 10080),
  constraint job_prefs_fx_chk check (php_per_usd > 0)
);
create index job_preferences_user_idx on public.job_preferences (user_id);

create table public.job_sources (
  id uuid primary key default gen_random_uuid(),
  user_id uuid not null default auth.uid() references auth.users (id) on delete cascade,
  key text not null,
  kind text not null,
  name text not null,
  enabled boolean not null default true,
  config jsonb not null default '{}'::jsonb,
  -- Playwright may only submit applications for sources explicitly marked as permitted.
  automation_allowed boolean not null default false,
  last_run_at timestamptz,
  last_status text,
  last_error text,
  last_job_count integer,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  constraint job_sources_kind_chk check (kind in ('remotive', 'arbeitnow', 'jobicy', 'himalayas', 'greenhouse', 'lever', 'ashby', 'gmail_alert', 'manual', 'demo')),
  constraint job_sources_key_chk check (key ~ '^[a-z0-9_:-]{2,60}$'),
  constraint job_sources_status_chk check (last_status is null or last_status in ('ok', 'partial', 'error', 'skipped')),
  constraint job_sources_unique unique (user_id, key)
);

-- ─── Jobs ───────────────────────────────────────────────────────────────────
create table public.job_listings (
  id uuid primary key default gen_random_uuid(),
  user_id uuid not null default auth.uid() references auth.users (id) on delete cascade,
  source_id uuid references public.job_sources (id) on delete set null,
  source_key text not null,
  external_id text not null,
  fingerprint text not null,
  title text not null,
  company text not null,
  company_url text,
  location text not null default '',
  work_arrangement text not null default 'unknown',
  employment_type text not null default 'unknown',
  experience_level text not null default 'unknown',
  salary_min numeric(12, 2),
  salary_max numeric(12, 2),
  salary_currency text,
  salary_period text,
  salary_text text,
  candidate_locations text,
  ph_eligibility text not null default 'unknown',
  description text not null default '',
  requirements text[] not null default '{}',
  tags text[] not null default '{}',
  apply_url text not null,
  posted_at timestamptz,
  expires_at timestamptz,
  discovered_at timestamptz not null default now(),
  last_seen_at timestamptz not null default now(),
  status text not null default 'active',
  is_hidden boolean not null default false,
  hidden_reason text,
  discovery_run_id uuid,
  search_tsv tsvector generated always as (
    to_tsvector('english', coalesce(title, '') || ' ' || coalesce(company, '') || ' ' || coalesce(location, '') || ' ' || left(coalesce(description, ''), 8000))
  ) stored,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  constraint job_listings_arrangement_chk check (work_arrangement in ('remote', 'hybrid', 'onsite', 'unknown')),
  constraint job_listings_employment_chk check (employment_type in ('full_time', 'part_time', 'contract', 'freelance', 'internship', 'unknown')),
  constraint job_listings_level_chk check (experience_level in ('internship', 'entry', 'junior', 'mid', 'senior', 'unknown')),
  constraint job_listings_ph_chk check (ph_eligibility in ('eligible', 'ineligible', 'unknown')),
  constraint job_listings_period_chk check (salary_period is null or salary_period in ('hour', 'day', 'week', 'month', 'year')),
  constraint job_listings_status_chk check (status in ('active', 'expired', 'closed')),
  constraint job_listings_url_chk check (apply_url ~* '^https?://'),
  constraint job_listings_unique unique (user_id, source_key, external_id)
);
create index job_listings_user_posted_idx on public.job_listings (user_id, posted_at desc nulls last);
create index job_listings_user_discovered_idx on public.job_listings (user_id, discovered_at desc);
create index job_listings_fingerprint_idx on public.job_listings (user_id, fingerprint);
create index job_listings_status_idx on public.job_listings (user_id, status, is_hidden);
create index job_listings_tsv_idx on public.job_listings using gin (search_tsv);

alter table public.resume_versions
  add constraint resume_versions_job_fk foreign key (job_id) references public.job_listings (id) on delete set null;

create table public.job_matches (
  id uuid primary key default gen_random_uuid(),
  user_id uuid not null default auth.uid() references auth.users (id) on delete cascade,
  job_id uuid not null references public.job_listings (id) on delete cascade,
  preference_id uuid references public.job_preferences (id) on delete cascade,
  resume_version_id uuid references public.resume_versions (id) on delete set null,
  status text not null default 'pending',
  score integer,
  deterministic_score integer,
  ai_score integer,
  breakdown jsonb not null default '{}'::jsonb,
  eligibility jsonb not null default '{}'::jsonb,
  eligible boolean,
  matched_skills text[] not null default '{}',
  missing_skills text[] not null default '{}',
  missing_qualifications text[] not null default '{}',
  explanation text,
  suggestions text[] not null default '{}',
  recommendation text,
  model text,
  prompt_version text,
  error text,
  scored_at timestamptz,
  notified_at timestamptz,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  constraint job_matches_status_chk check (status in ('pending', 'scored', 'failed', 'ineligible')),
  constraint job_matches_score_chk check (score is null or score between 0 and 100),
  constraint job_matches_recommendation_chk check (recommendation is null or recommendation in ('apply', 'consider', 'skip')),
  constraint job_matches_unique unique (user_id, job_id, preference_id)
);
create index job_matches_user_score_idx on public.job_matches (user_id, score desc nulls last);
create index job_matches_job_idx on public.job_matches (job_id);
create index job_matches_pending_idx on public.job_matches (user_id, status) where status = 'pending';

create table public.saved_jobs (
  id uuid primary key default gen_random_uuid(),
  user_id uuid not null default auth.uid() references auth.users (id) on delete cascade,
  job_id uuid not null references public.job_listings (id) on delete cascade,
  note text not null default '',
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  constraint saved_jobs_unique unique (user_id, job_id)
);

create table public.job_searches (
  id uuid primary key default gen_random_uuid(),
  user_id uuid not null default auth.uid() references auth.users (id) on delete cascade,
  query text not null default '',
  filters jsonb not null default '{}'::jsonb,
  result_count integer not null default 0,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);
create index job_searches_user_idx on public.job_searches (user_id, created_at desc);

-- ─── Applications ───────────────────────────────────────────────────────────
create table public.applications (
  id uuid primary key default gen_random_uuid(),
  user_id uuid not null default auth.uid() references auth.users (id) on delete cascade,
  job_id uuid references public.job_listings (id) on delete set null,
  status public.application_status not null default 'discovered',
  status_source text not null default 'user',
  mode text not null default 'manual',
  channel text not null default 'manual',
  company text not null,
  job_title text not null,
  company_domain text,
  apply_url text,
  source_key text,
  match_score integer,
  resume_version_id uuid references public.resume_versions (id) on delete set null,
  cover_letter_document_id uuid,
  documents_approved_at timestamptz,
  submission_approved_at timestamptz,
  auto_approved boolean not null default false,
  submission_attempts integer not null default 0,
  submitted_at timestamptz,
  confirmed_by text,
  submission_evidence jsonb,
  last_error text,
  -- Manual-action queue: automation could not (or may not) complete this submission.
  needs_manual_action boolean not null default false,
  manual_action_reason text,
  follow_up_interval_days integer,
  next_follow_up_at timestamptz,
  last_follow_up_at timestamptz,
  follow_ups_sent integer not null default 0,
  last_employer_message_at timestamptz,
  recruiter_name text,
  recruiter_email text,
  notes text not null default '',
  closed_at timestamptz,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  constraint applications_status_source_chk check (status_source in ('user', 'n8n', 'runner', 'gmail', 'system')),
  constraint applications_mode_chk check (mode in ('manual', 'approval', 'auto')),
  constraint applications_channel_chk check (channel in ('manual', 'email', 'playwright', 'ats_portal')),
  constraint applications_confirmed_chk check (confirmed_by is null or confirmed_by in ('evidence', 'manual', 'email')),
  -- An application can never be "applied" without evidence or explicit manual confirmation.
  constraint applications_applied_requires_confirmation check (
    status <> 'applied' or (submitted_at is not null and confirmed_by is not null)
  ),
  constraint applications_evidence_chk check (confirmed_by is distinct from 'evidence' or submission_evidence is not null),
  constraint applications_score_chk check (match_score is null or match_score between 0 and 100),
  constraint applications_followup_chk check (follow_up_interval_days is null or follow_up_interval_days between 1 and 60),
  -- Duplicate application prevention: one application per job.
  constraint applications_job_unique unique (user_id, job_id)
);
create index applications_user_status_idx on public.applications (user_id, status);
create index applications_user_updated_idx on public.applications (user_id, updated_at desc);
create index applications_submitted_idx on public.applications (user_id, submitted_at desc) where submitted_at is not null;
create index applications_manual_idx on public.applications (user_id) where needs_manual_action;
create index applications_followup_idx on public.applications (user_id, next_follow_up_at) where next_follow_up_at is not null;

create table public.application_documents (
  id uuid primary key default gen_random_uuid(),
  user_id uuid not null default auth.uid() references auth.users (id) on delete cascade,
  application_id uuid references public.applications (id) on delete cascade,
  job_id uuid references public.job_listings (id) on delete set null,
  kind text not null,
  title text not null,
  content_text text not null default '',
  content_json jsonb,
  file_path text,
  version integer not null default 1,
  status text not null default 'draft',
  ai_generated boolean not null default false,
  model text,
  prompt_version text,
  approved_at timestamptz,
  sent_at timestamptz,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  constraint app_docs_kind_chk check (kind in ('resume', 'cover_letter', 'email', 'screening_answers', 'follow_up', 'reply')),
  constraint app_docs_status_chk check (status in ('draft', 'approved', 'rejected', 'sent')),
  constraint app_docs_sent_chk check (status <> 'sent' or sent_at is not null)
);
create index app_docs_application_idx on public.application_documents (application_id, kind, version desc);
create index app_docs_user_idx on public.application_documents (user_id, created_at desc);

alter table public.applications
  add constraint applications_cover_letter_fk foreign key (cover_letter_document_id) references public.application_documents (id) on delete set null;

create table public.application_events (
  id uuid primary key default gen_random_uuid(),
  user_id uuid not null default auth.uid() references auth.users (id) on delete cascade,
  application_id uuid not null references public.applications (id) on delete cascade,
  type text not null,
  from_status public.application_status,
  to_status public.application_status,
  message text not null default '',
  metadata jsonb not null default '{}'::jsonb,
  actor text not null default 'user',
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  constraint app_events_type_chk check (type in ('status_change', 'note', 'email', 'automation', 'follow_up', 'document', 'interview')),
  constraint app_events_actor_chk check (actor in ('user', 'n8n', 'runner', 'gmail', 'system'))
);
create index app_events_application_idx on public.application_events (application_id, created_at desc);

-- ─── Gmail ──────────────────────────────────────────────────────────────────
create table public.gmail_connections (
  id uuid primary key default gen_random_uuid(),
  user_id uuid not null default auth.uid() references auth.users (id) on delete cascade,
  email text not null,
  scopes text[] not null default '{}',
  -- AES-256-GCM ciphertext (base64). Never readable by the browser (column grants below).
  access_token_enc text,
  refresh_token_enc text,
  token_expires_at timestamptz,
  history_id text,
  last_sync_at timestamptz,
  status text not null default 'connected',
  last_error text,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  constraint gmail_status_chk check (status in ('connected', 'error', 'revoked')),
  constraint gmail_one_per_user unique (user_id)
);

create table public.recruitment_messages (
  id uuid primary key default gen_random_uuid(),
  user_id uuid not null default auth.uid() references auth.users (id) on delete cascade,
  gmail_message_id text not null,
  thread_id text,
  from_email text not null default '',
  from_name text not null default '',
  to_email text not null default '',
  subject text not null default '',
  snippet text not null default '',
  body_text text not null default '',
  received_at timestamptz not null,
  labels text[] not null default '{}',
  category text,
  confidence numeric(3, 2),
  classification jsonb,
  classified_by text,
  application_id uuid references public.applications (id) on delete set null,
  status_update jsonb,
  processed_status text not null default 'new',
  suggested_reply text,
  is_important boolean not null default false,
  is_read boolean not null default false,
  error text,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  constraint messages_category_chk check (category is null or category in ('job_alert', 'acknowledgment', 'assessment', 'interview', 'offer', 'rejection', 'recruiter_outreach', 'follow_up', 'other')),
  constraint messages_confidence_chk check (confidence is null or confidence between 0 and 1),
  constraint messages_processed_chk check (processed_status in ('new', 'classified', 'ignored', 'error')),
  constraint messages_classified_by_chk check (classified_by is null or classified_by in ('ai', 'heuristic', 'user')),
  constraint messages_unique unique (user_id, gmail_message_id)
);
create index messages_user_received_idx on public.recruitment_messages (user_id, received_at desc);
create index messages_unprocessed_idx on public.recruitment_messages (user_id, processed_status) where processed_status = 'new';
create index messages_application_idx on public.recruitment_messages (application_id) where application_id is not null;

create table public.interview_schedules (
  id uuid primary key default gen_random_uuid(),
  user_id uuid not null default auth.uid() references auth.users (id) on delete cascade,
  application_id uuid references public.applications (id) on delete cascade,
  message_id uuid references public.recruitment_messages (id) on delete set null,
  title text not null,
  stage text not null default 'other',
  scheduled_at timestamptz,
  duration_minutes integer,
  timezone text not null default 'Asia/Manila',
  location text not null default '',
  meeting_url text not null default '',
  interviewer text not null default '',
  status text not null default 'scheduled',
  source text not null default 'manual',
  notes text not null default '',
  reminded_at timestamptz,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  constraint interviews_stage_chk check (stage in ('screening', 'technical', 'hr', 'final', 'other')),
  constraint interviews_status_chk check (status in ('scheduled', 'completed', 'cancelled', 'rescheduled', 'needs_confirmation')),
  constraint interviews_source_chk check (source in ('email', 'manual')),
  constraint interviews_duration_chk check (duration_minutes is null or duration_minutes between 5 and 600)
);
create index interviews_user_time_idx on public.interview_schedules (user_id, scheduled_at);

-- ─── Automation ─────────────────────────────────────────────────────────────
create table public.automation_rules (
  id uuid primary key default gen_random_uuid(),
  user_id uuid not null default auth.uid() references auth.users (id) on delete cascade,
  mode text not null default 'manual',
  paused boolean not null default false,
  paused_at timestamptz,
  paused_reason text,
  auto_apply_enabled boolean not null default false,
  auto_apply_opt_in_at timestamptz,
  allowed_sources text[] not null default '{}',
  min_match_score integer not null default 80,
  min_salary_hourly_usd numeric(8, 2),
  preferred_categories text[] not null default '{}',
  max_daily_submissions integer not null default 3,
  excluded_companies text[] not null default '{}',
  resume_selection text not null default 'tailored',
  require_document_approval boolean not null default true,
  auto_prepare_min_score integer not null default 80,
  follow_up_after_days integer not null default 7,
  notify_min_score integer not null default 75,
  ai_daily_request_budget integer not null default 200,
  email_notifications boolean not null default false,
  telegram_notifications boolean not null default false,
  n8n_last_seen_at timestamptz,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  constraint rules_mode_chk check (mode in ('manual', 'approval', 'auto')),
  constraint rules_auto_optin_chk check (not auto_apply_enabled or auto_apply_opt_in_at is not null),
  constraint rules_score_chk check (min_match_score between 0 and 100 and auto_prepare_min_score between 0 and 100 and notify_min_score between 0 and 100),
  constraint rules_daily_chk check (max_daily_submissions between 0 and 25),
  constraint rules_resume_chk check (resume_selection in ('primary', 'tailored')),
  constraint rules_followup_chk check (follow_up_after_days between 1 and 60),
  constraint rules_budget_chk check (ai_daily_request_budget between 0 and 5000),
  constraint rules_one_per_user unique (user_id)
);

create table public.automation_runs (
  id uuid primary key default gen_random_uuid(),
  user_id uuid not null default auth.uid() references auth.users (id) on delete cascade,
  workflow text not null,
  status text not null default 'queued',
  trigger text not null default 'dashboard',
  input jsonb not null default '{}'::jsonb,
  output jsonb,
  stats jsonb not null default '{}'::jsonb,
  item_errors jsonb not null default '[]'::jsonb,
  error text,
  attempt integer not null default 1,
  max_attempts integer not null default 3,
  idempotency_key text,
  parent_run_id uuid references public.automation_runs (id) on delete set null,
  n8n_execution_id text,
  cancel_requested boolean not null default false,
  not_before timestamptz,
  timeout_seconds integer not null default 900,
  queued_at timestamptz not null default now(),
  started_at timestamptz,
  heartbeat_at timestamptz,
  finished_at timestamptz,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  constraint runs_workflow_chk check (workflow in ('job_discovery', 'resume_analysis', 'job_matching', 'application_prep', 'application_submit', 'gmail_sync', 'follow_up', 'reports', 'error_recovery')),
  constraint runs_status_chk check (status in ('queued', 'running', 'succeeded', 'partial', 'failed', 'cancelled')),
  constraint runs_trigger_chk check (trigger in ('schedule', 'dashboard', 'webhook', 'event', 'retry', 'cron')),
  constraint runs_attempt_chk check (attempt between 1 and 10 and max_attempts between 1 and 10),
  constraint runs_timeout_chk check (timeout_seconds between 30 and 21600),
  constraint runs_idempotency_unique unique (user_id, idempotency_key)
);
create index runs_queue_idx on public.automation_runs (queued_at) where status = 'queued';
create index runs_user_created_idx on public.automation_runs (user_id, created_at desc);
create index runs_user_workflow_idx on public.automation_runs (user_id, workflow, created_at desc);
create index runs_running_idx on public.automation_runs (heartbeat_at) where status = 'running';

create table public.notifications (
  id uuid primary key default gen_random_uuid(),
  user_id uuid not null default auth.uid() references auth.users (id) on delete cascade,
  type text not null,
  severity text not null default 'info',
  title text not null,
  body text not null default '',
  link text,
  metadata jsonb not null default '{}'::jsonb,
  dedupe_key text,
  read_at timestamptz,
  delivered_channels text[] not null default '{in_app}',
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  constraint notifications_type_chk check (type in ('high_match', 'docs_ready', 'approval_needed', 'application_update', 'interview', 'email', 'automation_error', 'report', 'follow_up', 'system')),
  constraint notifications_severity_chk check (severity in ('info', 'success', 'warning', 'error')),
  constraint notifications_link_chk check (link is null or link ~ '^/'),
  constraint notifications_dedupe_unique unique (user_id, dedupe_key)
);
create index notifications_user_idx on public.notifications (user_id, created_at desc);
create index notifications_unread_idx on public.notifications (user_id) where read_at is null;

create table public.ai_usage_logs (
  id uuid primary key default gen_random_uuid(),
  user_id uuid not null default auth.uid() references auth.users (id) on delete cascade,
  task text not null,
  model text not null,
  prompt_version text not null,
  status text not null,
  input_tokens integer,
  output_tokens integer,
  total_tokens integer,
  latency_ms integer,
  attempts integer not null default 1,
  error text,
  related_id uuid,
  run_id uuid references public.automation_runs (id) on delete set null,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  constraint ai_usage_status_chk check (status in ('success', 'error', 'rate_limited', 'invalid_output', 'budget_exceeded', 'timeout'))
);
create index ai_usage_user_created_idx on public.ai_usage_logs (user_id, created_at desc);

create table public.audit_logs (
  id uuid primary key default gen_random_uuid(),
  user_id uuid not null default auth.uid() references auth.users (id) on delete cascade,
  actor text not null,
  action text not null,
  entity text,
  entity_id uuid,
  metadata jsonb not null default '{}'::jsonb,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  constraint audit_actor_chk check (actor in ('user', 'n8n', 'runner', 'gmail', 'system'))
);
create index audit_user_created_idx on public.audit_logs (user_id, created_at desc);

-- ─── updated_at triggers ────────────────────────────────────────────────────
do $$
declare
  t text;
begin
  foreach t in array array[
    'profiles', 'resumes', 'resume_versions', 'skills', 'job_preferences', 'job_sources', 'job_listings',
    'job_matches', 'saved_jobs', 'job_searches', 'applications', 'application_documents', 'application_events',
    'gmail_connections', 'recruitment_messages', 'interview_schedules', 'automation_rules', 'automation_runs',
    'notifications', 'ai_usage_logs', 'audit_logs'
  ]
  loop
    execute format('create trigger set_updated_at before update on public.%I for each row execute function public.set_updated_at()', t);
  end loop;
end;
$$;
