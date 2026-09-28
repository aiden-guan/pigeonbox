-- PigeonBox tracking schema
-- Mailbox contents are NEVER stored here.

create extension if not exists "pgcrypto";

create table if not exists tracked_emails (
  tracking_id text primary key,
  subject text not null,
  sender text not null,
  recipients jsonb not null default '[]'::jsonb,
  gmail_thread_id text,
  gmail_message_id text,
  sent_at timestamptz not null default now(),
  first_opened_at timestamptz,
  last_opened_at timestamptz,
  open_count integer not null default 0,
  first_clicked_at timestamptz,
  last_clicked_at timestamptz,
  click_count integer not null default 0,
  created_at timestamptz not null default now()
);

create table if not exists tracked_links (
  click_id text primary key,
  tracking_id text not null references tracked_emails(tracking_id) on delete cascade,
  destination text not null,
  created_at timestamptz not null default now()
);

create index if not exists tracked_links_tracking_id_idx on tracked_links(tracking_id);

create table if not exists tracking_events (
  id text primary key,
  tracking_id text not null references tracked_emails(tracking_id) on delete cascade,
  type text not null check (type in ('OPEN', 'CLICK')),
  timestamp timestamptz not null default now(),
  user_agent text,
  ip_hash text,
  suspected_self_open boolean default false,
  confidence real,
  click_id text,
  destination text
);

create index if not exists tracking_events_tracking_id_idx on tracking_events(tracking_id);
create index if not exists tracking_events_timestamp_idx on tracking_events(timestamp desc);

-- RLS: service role used by worker; no anon access to management data.
alter table tracked_emails enable row level security;
alter table tracked_links enable row level security;
alter table tracking_events enable row level security;

-- No policies for anon/authenticated — worker uses service role.
