-- Migration: Support sender self-view claims and expand tracking event classification
-- 1. Update tracking_events classification check constraint to include PROXY_LIKELY and MACHINE_LIKELY
alter table public.tracking_events
  drop constraint if exists tracking_events_classification_check;

alter table public.tracking_events
  add constraint tracking_events_classification_check
  check (
    classification is null or
    classification in ('RECIPIENT_LIKELY', 'SELF_LIKELY', 'PROXY_LIKELY', 'MACHINE_LIKELY', 'UNKNOWN')
  );

-- 2. Update tracking_events type check constraint to include SELF_VIEW
alter table public.tracking_events
  drop constraint if exists tracking_events_type_check;

alter table public.tracking_events
  add constraint tracking_events_type_check
  check (type in ('OPEN', 'CLICK', 'SELF_VIEW'));

-- 3. Create tracking_self_view_claims table
create table if not exists public.tracking_self_view_claims (
  id text primary key,
  tracking_id text not null references public.tracked_emails(tracking_id) on delete cascade,
  gmail_message_id text,
  gmail_thread_id text,
  sender_ip_hash text,
  sender_ua_family text,
  first_observed_at timestamptz not null default now(),
  last_observed_at timestamptz not null default now(),
  expires_at timestamptz not null,
  source text not null check (source in ('ROW_INTERACTION', 'MESSAGE_EXPANDED', 'MESSAGE_LOAD', 'CACHE_REINSPECTION')),
  consumed_by_event_id text,
  consumed_at timestamptz,
  consumed_ua text,
  consumed_ip_hash text,
  created_at timestamptz not null default now()
);

-- 4. Indexes for fast active claim queries
create index if not exists tracking_self_view_claims_tracking_id_idx
  on public.tracking_self_view_claims(tracking_id);

create index if not exists tracking_self_view_claims_expires_at_idx
  on public.tracking_self_view_claims(tracking_id, expires_at);

create index if not exists tracking_self_view_claims_msg_idx
  on public.tracking_self_view_claims(tracking_id, gmail_message_id);

create index if not exists tracking_self_view_claims_consumed_at_idx
  on public.tracking_self_view_claims(tracking_id, consumed_at);

-- 5. RLS: service role used by worker; no anon access
alter table public.tracking_self_view_claims enable row level security;
