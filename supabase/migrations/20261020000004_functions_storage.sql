-- ApplyPilot AI — triggers, RPCs, storage buckets and realtime

-- ─── Single-user enforcement ────────────────────────────────────────────────
-- Signups are disabled in Auth settings; this trigger is a second, database-level guard.
create or replace function public.enforce_single_user()
returns trigger
language plpgsql
security definer
set search_path = ''
as $$
begin
  if exists (select 1 from public.profiles) then
    raise exception 'ApplyPilot AI is a single-user system: registration is disabled.'
      using errcode = 'P0001';
  end if;
  return new;
end;
$$;

create trigger enforce_single_user
  before insert on auth.users
  for each row execute function public.enforce_single_user();

-- Creates the profile and automation settings for the owner account.
create or replace function public.handle_new_user()
returns trigger
language plpgsql
security definer
set search_path = ''
as $$
begin
  insert into public.profiles (id, email, full_name)
  values (new.id, coalesce(new.email, ''), coalesce(new.raw_user_meta_data ->> 'full_name', ''));
  insert into public.automation_rules (user_id) values (new.id);
  return new;
end;
$$;

create trigger on_auth_user_created
  after insert on auth.users
  for each row execute function public.handle_new_user();

-- ─── Application status history ─────────────────────────────────────────────
create or replace function public.log_application_status()
returns trigger
language plpgsql
security definer
set search_path = ''
as $$
begin
  if tg_op = 'INSERT' then
    insert into public.application_events (user_id, application_id, type, to_status, message, actor)
    values (new.user_id, new.id, 'status_change', new.status, 'Application created', new.status_source);
  elsif new.status is distinct from old.status then
    insert into public.application_events (user_id, application_id, type, from_status, to_status, message, actor)
    values (new.user_id, new.id, 'status_change', old.status, new.status,
            format('Status changed from %s to %s', old.status, new.status), new.status_source);
    if new.status in ('rejected', 'withdrawn', 'closed', 'offer') and new.closed_at is null then
      new.closed_at := now();
    end if;
  end if;
  return new;
end;
$$;

-- BEFORE so closed_at can be set; the event insert references the existing row id.
create trigger log_application_status_update
  before update of status on public.applications
  for each row execute function public.log_application_status();

create trigger log_application_status_insert
  after insert on public.applications
  for each row execute function public.log_application_status();

-- Pausing records when it happened; enabling auto-apply records the explicit opt-in.
create or replace function public.automation_rules_guard()
returns trigger
language plpgsql
set search_path = ''
as $$
begin
  if new.paused and not old.paused then
    new.paused_at := now();
  elsif not new.paused then
    new.paused_at := null;
    new.paused_reason := null;
  end if;
  if new.auto_apply_enabled and not old.auto_apply_enabled and new.auto_apply_opt_in_at is null then
    new.auto_apply_opt_in_at := now();
  end if;
  if not new.auto_apply_enabled then
    new.auto_apply_opt_in_at := null;
  end if;
  return new;
end;
$$;

create trigger automation_rules_guard
  before update on public.automation_rules
  for each row execute function public.automation_rules_guard();

-- ─── Automation queue ───────────────────────────────────────────────────────
-- Atomically claims queued runs (FOR UPDATE SKIP LOCKED prevents double-processing).
create or replace function public.claim_automation_runs(p_user uuid, p_limit integer default 5, p_workflows text[] default null)
returns setof public.automation_runs
language plpgsql
security definer
set search_path = ''
as $$
begin
  update public.automation_rules set n8n_last_seen_at = now() where user_id = p_user;
  return query
  update public.automation_runs r
     set status = 'running', started_at = now(), heartbeat_at = now()
   where r.id in (
     select q.id
       from public.automation_runs q
      where q.user_id = p_user
        and q.status = 'queued'
        and not q.cancel_requested
        and (q.not_before is null or q.not_before <= now())
        and (p_workflows is null or q.workflow = any (p_workflows))
      order by q.queued_at
      limit greatest(1, least(p_limit, 25))
      for update skip locked
   )
  returning r.*;
end;
$$;

-- Marks runs that stopped heart-beating as failed (called by the Worker cron).
create or replace function public.reap_stale_runs()
returns integer
language plpgsql
security definer
set search_path = ''
as $$
declare
  n integer;
begin
  update public.automation_runs
     set status = 'failed',
         error = coalesce(error, 'Timed out: no heartbeat within the run timeout'),
         finished_at = now()
   where status = 'running'
     and coalesce(heartbeat_at, started_at, queued_at) < now() - make_interval(secs => timeout_seconds);
  get diagnostics n = row_count;
  update public.automation_runs
     set status = 'cancelled', finished_at = now(), error = 'Cancelled before start'
   where status = 'queued' and cancel_requested;
  return n;
end;
$$;

revoke all on function public.claim_automation_runs(uuid, integer, text[]) from public, anon, authenticated;
revoke all on function public.reap_stale_runs() from public, anon, authenticated;
grant execute on function public.claim_automation_runs(uuid, integer, text[]) to service_role;
grant execute on function public.reap_stale_runs() to service_role;
revoke all on function public.enforce_single_user() from public, anon, authenticated;
revoke all on function public.handle_new_user() from public, anon, authenticated;
-- Trigger functions are never meant to be called through the API.
revoke all on function public.log_application_status() from public, anon, authenticated;
revoke all on function public.automation_rules_guard() from public, anon, authenticated;
revoke all on function public.set_updated_at() from public, anon, authenticated;

-- ─── Dashboard statistics (runs with the caller's RLS) ──────────────────────
create or replace function public.dashboard_stats()
returns jsonb
language sql
stable
security invoker
set search_path = ''
as $$
  select jsonb_build_object(
    'jobs_total', (select count(*) from public.job_listings where status = 'active' and not is_hidden),
    'jobs_new_24h', (select count(*) from public.job_listings where discovered_at > now() - interval '24 hours'),
    'high_matches', (select count(distinct m.job_id) from public.job_matches m
                       join public.job_listings j on j.id = m.job_id and j.status = 'active' and not j.is_hidden
                      where m.status = 'scored' and m.eligible and m.score >= 75),
    'saved', (select count(*) from public.saved_jobs),
    'submitted', (select count(*) from public.applications where status in ('applied', 'assessment', 'interview', 'offer', 'rejected')),
    'pending', (select count(*) from public.applications where status in ('applied', 'assessment')),
    'awaiting_action', (select count(*) from public.applications where status in ('draft_prepared', 'awaiting_approval', 'submission_failed')),
    'interviews_upcoming', (select count(*) from public.interview_schedules where status = 'scheduled' and scheduled_at > now()),
    'rejected', (select count(*) from public.applications where status = 'rejected'),
    'offers', (select count(*) from public.applications where status = 'offer'),
    'runs_failed_24h', (select count(*) from public.automation_runs where status = 'failed' and created_at > now() - interval '24 hours'),
    'runs_active', (select count(*) from public.automation_runs where status in ('queued', 'running')),
    'unread_notifications', (select count(*) from public.notifications where read_at is null),
    'unread_messages', (select count(*) from public.recruitment_messages where not is_read and category is distinct from 'job_alert')
  );
$$;
revoke all on function public.dashboard_stats() from public, anon;
grant execute on function public.dashboard_stats() to authenticated;

-- ─── Storage (private buckets, owner folder = auth.uid()) ───────────────────
insert into storage.buckets (id, name, public, file_size_limit, allowed_mime_types)
values
  ('resumes', 'resumes', false, 10485760, array[
    'application/pdf',
    'application/vnd.openxmlformats-officedocument.wordprocessingml.document'
  ]),
  ('documents', 'documents', false, 10485760, array['application/pdf', 'text/plain']),
  ('evidence', 'evidence', false, 10485760, array['image/png', 'image/jpeg', 'application/json', 'text/plain'])
on conflict (id) do nothing;

create policy "owner rw resumes and documents"
  on storage.objects for all to authenticated
  using (bucket_id in ('resumes', 'documents') and (storage.foldername(name))[1] = (select auth.uid())::text)
  with check (bucket_id in ('resumes', 'documents') and (storage.foldername(name))[1] = (select auth.uid())::text);

-- Evidence is written only by the Worker/runner; the owner can read it.
create policy "owner read evidence"
  on storage.objects for select to authenticated
  using (bucket_id = 'evidence' and (storage.foldername(name))[1] = (select auth.uid())::text);

-- ─── Realtime for live dashboard updates ────────────────────────────────────
do $$
begin
  if exists (select 1 from pg_publication where pubname = 'supabase_realtime') then
    alter publication supabase_realtime add table public.notifications, public.automation_runs, public.applications;
  end if;
end;
$$;
