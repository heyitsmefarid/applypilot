-- Whether Gmail authenticated the sender (DKIM/SPF/DMARC aligned with the From domain).
-- Only verified senders belonging to the application may change its status automatically;
-- everything else is stored as a suggestion for the user to approve.
alter table public.recruitment_messages
  add column sender_verified boolean not null default false;
