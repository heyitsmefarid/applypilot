-- ApplyPilot AI — grants and Row Level Security
-- The browser uses the publishable (anon) key + the user's JWT → role "authenticated".
-- The Cloudflare Worker uses the secret (service_role) key for privileged, validated operations.

-- Explicit grants (do not rely on project defaults).
revoke all on all tables in schema public from anon;
revoke all on all functions in schema public from anon;
grant usage on schema public to authenticated, service_role;
grant select, insert, update, delete on all tables in schema public to authenticated;
grant all on all tables in schema public to service_role;

-- Enable RLS everywhere.
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
    execute format('alter table public.%I enable row level security', t);
    execute format('alter table public.%I force row level security', t);
  end loop;
end;
$$;

-- Owner-only full access (the user edits these directly from the dashboard).
do $$
declare
  t text;
begin
  foreach t in array array[
    'resumes', 'resume_versions', 'skills', 'job_preferences', 'job_sources', 'job_listings', 'saved_jobs',
    'job_searches', 'applications', 'application_documents', 'application_events', 'recruitment_messages',
    'interview_schedules', 'notifications'
  ]
  loop
    execute format(
      'create policy owner_all on public.%I for all to authenticated using (user_id = (select auth.uid())) with check (user_id = (select auth.uid()))',
      t
    );
  end loop;
end;
$$;

-- Owner read-only (written only by the Worker / automation).
do $$
declare
  t text;
begin
  foreach t in array array['job_matches', 'automation_runs', 'ai_usage_logs', 'audit_logs', 'gmail_connections']
  loop
    execute format('create policy owner_read on public.%I for select to authenticated using (user_id = (select auth.uid()))', t);
    execute format('revoke insert, update, delete on public.%I from authenticated', t);
  end loop;
end;
$$;

-- Profiles: keyed by id.
create policy owner_select on public.profiles for select to authenticated using (id = (select auth.uid()));
create policy owner_update on public.profiles for update to authenticated using (id = (select auth.uid())) with check (id = (select auth.uid()));
revoke insert, delete on public.profiles from authenticated;

-- Automation rules: the user may change settings, but safety-critical toggles are validated by triggers
-- (see 20261020000004). Insert/delete happen only through the bootstrap trigger.
create policy owner_select on public.automation_rules for select to authenticated using (user_id = (select auth.uid()));
create policy owner_update on public.automation_rules for update to authenticated using (user_id = (select auth.uid())) with check (user_id = (select auth.uid()));
-- Column privileges only restrict when the table-level privilege is absent, so grant column lists explicitly.
revoke insert, update, delete on public.automation_rules from authenticated;
grant update (
  mode, paused, paused_at, paused_reason, auto_apply_enabled, auto_apply_opt_in_at, allowed_sources,
  min_match_score, min_salary_hourly_usd, preferred_categories, max_daily_submissions, excluded_companies,
  resume_selection, require_document_approval, auto_prepare_min_score, follow_up_after_days, notify_min_score,
  ai_daily_request_budget, email_notifications, telegram_notifications
) on public.automation_rules to authenticated;

-- Gmail tokens are never selectable by the browser — only connection metadata.
revoke select on public.gmail_connections from authenticated;
grant select (id, user_id, email, scopes, token_expires_at, last_sync_at, status, last_error, created_at, updated_at)
  on public.gmail_connections to authenticated;

-- Applications: the browser may not forge submission evidence, automation approval flags or attempts.
-- Submission approval goes through the Worker so it is audited and queued.
revoke insert, update on public.applications from authenticated;
grant insert (
  job_id, status, mode, channel, company, job_title, company_domain, apply_url, source_key, match_score,
  resume_version_id, notes, submitted_at, confirmed_by, follow_up_interval_days
) on public.applications to authenticated;
grant update (
  status, status_source, mode, channel, company, job_title, company_domain, apply_url, resume_version_id,
  cover_letter_document_id, documents_approved_at, submitted_at, confirmed_by, follow_up_interval_days,
  next_follow_up_at, recruiter_name, recruiter_email, notes, closed_at, needs_manual_action, manual_action_reason
) on public.applications to authenticated;

-- Profiles: the verified resume pointer is set through the Worker (it also syncs the skills table).
revoke update on public.profiles from authenticated;
grant update (full_name, phone, location, headline, timezone, portfolio_url, linkedin_url, github_url, onboarded_at)
  on public.profiles to authenticated;
