-- PigeonBox Cloud hosted tracking. Same columns as the public self-host
-- tracker schema, plus an owner on every row. No mailbox bodies are stored.

create table public.tracked_emails (
  tracking_id text primary key,
  user_id uuid not null references public.profiles (id) on delete cascade,
  status text not null default 'PENDING' check (status in ('PENDING', 'SENT', 'CANCELLED', 'FAILED')),
  subject text not null,
  sender text not null,
  recipients jsonb not null default '[]'::jsonb,
  gmail_thread_id text,
  gmail_message_id text,
  created_at timestamptz not null default now(),
  sent_at timestamptz,
  first_opened_at timestamptz,
  last_opened_at timestamptz,
  open_count integer not null default 0,
  first_clicked_at timestamptz,
  last_clicked_at timestamptz,
  click_count integer not null default 0
);
create index tracked_emails_user_sent_idx on public.tracked_emails (user_id, sent_at desc nulls last);

create table public.tracked_links (
  click_id text primary key,
  tracking_id text not null references public.tracked_emails (tracking_id) on delete cascade,
  user_id uuid not null references public.profiles (id) on delete cascade,
  destination text not null check (destination ~* '^https?://'),
  created_at timestamptz not null default now()
);
create index tracked_links_tracking_idx on public.tracked_links (tracking_id);

create table public.tracking_events (
  id text primary key,
  tracking_id text not null references public.tracked_emails (tracking_id) on delete cascade,
  user_id uuid not null references public.profiles (id) on delete cascade,
  type text not null check (type in ('OPEN', 'CLICK', 'SELF_VIEW')),
  timestamp timestamptz not null default now(),
  user_agent text,
  ip_hash text,
  suspected_self_open boolean not null default false,
  confidence real,
  classification text check (classification is null or classification in ('RECIPIENT_LIKELY', 'SELF_LIKELY', 'PROXY_LIKELY', 'MACHINE_LIKELY', 'UNKNOWN')),
  click_id text,
  destination text
);
create index tracking_events_tracking_ts_idx on public.tracking_events (tracking_id, timestamp desc);
create index tracking_events_user_ts_idx on public.tracking_events (user_id, timestamp desc);

create table public.tracking_self_view_claims (
  id text primary key,
  tracking_id text not null references public.tracked_emails (tracking_id) on delete cascade,
  user_id uuid not null references public.profiles (id) on delete cascade,
  gmail_message_id text,
  gmail_thread_id text,
  sender_ip_hash text,
  sender_ua_family text,
  first_observed_at timestamptz not null default now(),
  last_observed_at timestamptz not null default now(),
  expires_at timestamptz not null,
  source text not null check (source in ('ROW_INTERACTION', 'MESSAGE_EXPANDED', 'MESSAGE_LOAD', 'CACHE_REINSPECTION', 'PAGE_RELOAD')),
  consumed_by_event_id text,
  consumed_at timestamptz,
  consumed_ua text,
  consumed_ip_hash text,
  proxy_consumed_by_event_id text,
  proxy_consumed_at timestamptz,
  created_at timestamptz not null default now()
);
create index tracking_claims_tracking_expires_idx on public.tracking_self_view_claims (tracking_id, expires_at);
create index tracking_claims_tracking_consumed_idx on public.tracking_self_view_claims (tracking_id, consumed_at);
create index tracking_claims_tracking_proxy_idx on public.tracking_self_view_claims (tracking_id, proxy_consumed_at);

-- Child rows take their owner from the tracked email. Public pixel/click
-- inserts leave user_id empty; a mismatching owner is rejected outright.
create function public.tracking_row_owner() returns trigger
language plpgsql security definer set search_path = '' as $$
declare
  v_owner uuid;
begin
  select user_id into v_owner from public.tracked_emails where tracking_id = new.tracking_id;
  if v_owner is null then
    raise exception 'unknown tracking id' using errcode = 'foreign_key_violation';
  end if;
  if new.user_id is not null and new.user_id <> v_owner then
    raise exception 'tracking row owner mismatch' using errcode = 'insufficient_privilege';
  end if;
  new.user_id := v_owner;
  return new;
end;
$$;

create trigger tracked_links_owner before insert or update of tracking_id, user_id on public.tracked_links
  for each row execute function public.tracking_row_owner();
create trigger tracking_events_owner before insert or update of tracking_id, user_id on public.tracking_events
  for each row execute function public.tracking_row_owner();
create trigger tracking_claims_owner before insert or update of tracking_id, user_id on public.tracking_self_view_claims
  for each row execute function public.tracking_row_owner();

alter table public.tracked_emails enable row level security;
alter table public.tracked_links enable row level security;
alter table public.tracking_events enable row level security;
alter table public.tracking_self_view_claims enable row level security;

create policy "own tracked emails" on public.tracked_emails for select to authenticated using ((select auth.uid()) = user_id);
create policy "own tracked links" on public.tracked_links for select to authenticated using ((select auth.uid()) = user_id);
create policy "own tracking events" on public.tracking_events for select to authenticated using ((select auth.uid()) = user_id);
-- Claims are internal to open classification: no client policy.
