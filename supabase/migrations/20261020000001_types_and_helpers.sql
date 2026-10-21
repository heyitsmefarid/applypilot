-- ApplyPilot AI — enums and shared helpers

create extension if not exists pgcrypto with schema extensions;

create type public.application_status as enum (
  'discovered',
  'saved',
  'draft_prepared',
  'awaiting_approval',
  'submission_in_progress',
  'applied',
  'assessment',
  'interview',
  'offer',
  'rejected',
  'withdrawn',
  'closed',
  'submission_failed'
);

-- Keeps updated_at current on every UPDATE.
create or replace function public.set_updated_at()
returns trigger
language plpgsql
set search_path = ''
as $$
begin
  new.updated_at := now();
  return new;
end;
$$;

-- True when every element of `arr` is in `allowed` (used by array CHECK constraints).
create or replace function public.array_subset(arr text[], allowed text[])
returns boolean
language sql
immutable
set search_path = ''
as $$
  select coalesce(arr <@ allowed, true);
$$;
