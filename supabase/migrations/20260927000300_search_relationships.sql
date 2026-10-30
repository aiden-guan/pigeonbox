-- PigeonBox Cloud intelligence layer, part 4: retrieval, Fast Recall,
-- contacts and relationships, and fusion of tracking events into
-- conversation state.

create extension if not exists vector with schema extensions;

-- Server code runs as pigeonbox_app; vector types and operators live in extensions.
grant usage on schema extensions to pigeonbox_app;

-- ---------------------------------------------------------------------------
-- Retrieval
-- ---------------------------------------------------------------------------

-- One embedding per thread version, computed from derived text (subject,
-- participants, summary, commitments), never from raw bodies. Vectors are
-- tenant-scoped by RLS like every other row.
create table public.search_documents (
  id uuid primary key default gen_random_uuid(),
  user_id uuid not null references public.profiles (id) on delete cascade,
  mail_account_id uuid not null references public.mail_accounts (id) on delete cascade,
  thread_id uuid not null unique references public.threads (id) on delete cascade,
  content_version text not null,
  embedding extensions.vector(768) not null,
  model text,
  updated_at timestamptz not null default now()
);
create index search_documents_user_idx on public.search_documents (user_id);
create index search_documents_embedding_idx on public.search_documents using hnsw (embedding extensions.vector_cosine_ops);
select app.protect_user_table('public.search_documents', false);

-- Fast Recall (opt-in, disclosed): encrypted excerpts of synced messages with
-- embeddings, kept for the user's chosen retention and deleted completely on
-- opt-out, disconnect or account deletion.
create table public.recall_chunks (
  id uuid primary key default gen_random_uuid(),
  user_id uuid not null references public.profiles (id) on delete cascade,
  mail_account_id uuid not null references public.mail_accounts (id) on delete cascade,
  thread_id uuid not null references public.threads (id) on delete cascade,
  gmail_message_id text not null,
  chunk_index integer not null,
  text_key_id text not null,
  text_iv text not null,
  text_ciphertext text not null,
  embedding extensions.vector(768) not null,
  message_at timestamptz not null,
  expires_at timestamptz not null,
  created_at timestamptz not null default now(),
  unique (thread_id, gmail_message_id, chunk_index)
);
create index recall_chunks_user_idx on public.recall_chunks (user_id, message_at desc);
create index recall_chunks_expiry_idx on public.recall_chunks (expires_at);
create index recall_chunks_embedding_idx on public.recall_chunks using hnsw (embedding extensions.vector_cosine_ops);
select app.protect_user_table('public.recall_chunks', false);

-- ---------------------------------------------------------------------------
-- Contacts and relationships
-- ---------------------------------------------------------------------------

create table public.companies (
  id uuid primary key default gen_random_uuid(),
  user_id uuid not null references public.profiles (id) on delete cascade,
  domain text not null,
  name text,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  unique (user_id, domain)
);
select app.protect_user_table('public.companies', true);

create table public.contacts (
  id uuid primary key default gen_random_uuid(),
  user_id uuid not null references public.profiles (id) on delete cascade,
  email text not null,
  email_normalized text generated always as (lower(email)) stored,
  name text,
  company_id uuid references public.companies (id) on delete set null,
  aliases text[] not null default '{}',
  vip boolean not null default false,
  tags text[] not null default '{}',
  notes_key_id text,
  notes_iv text,
  notes_ciphertext text,
  first_seen_at timestamptz not null default now(),
  last_inbound_at timestamptz,
  last_outbound_at timestamptz,
  sent_count integer not null default 0,
  received_count integer not null default 0,
  meetings_count integer not null default 0,
  is_bulk boolean not null default false,
  updated_at timestamptz not null default now(),
  unique (user_id, email_normalized)
);
create index contacts_user_recent_idx on public.contacts (user_id, greatest(last_inbound_at, last_outbound_at) desc nulls last);
create index contacts_user_name_idx on public.contacts (user_id, lower(name));
select app.protect_user_table('public.contacts', true);

create table public.relationship_events (
  id uuid primary key default gen_random_uuid(),
  user_id uuid not null references public.profiles (id) on delete cascade,
  contact_id uuid not null references public.contacts (id) on delete cascade,
  kind text not null check (kind in ('email_in', 'email_out', 'meeting', 'open', 'click', 'document_view', 'commitment', 'note')),
  at timestamptz not null,
  thread_id uuid references public.threads (id) on delete cascade,
  gmail_thread_id text,
  ref text not null,
  label text not null default '',
  created_at timestamptz not null default now(),
  unique (contact_id, kind, ref)
);
create index relationship_events_contact_idx on public.relationship_events (contact_id, at desc);
select app.protect_user_table('public.relationship_events', true);

-- ---------------------------------------------------------------------------
-- Tracking → conversation state
-- ---------------------------------------------------------------------------
-- Hosted tracking events are written by the tracker Worker. A trigger queues
-- one signal refresh per tracked email and minute, so follow-ups and the
-- engagement timeline update without polling. Classification stays the
-- tracker's (protocol v3); this only reacts to it.

create function app.queue_tracking_signal() returns trigger
language plpgsql security definer set search_path = '' as $$
declare
  v_owner uuid;
begin
  select user_id into v_owner from public.tracked_emails where tracking_id = new.tracking_id;
  if v_owner is null then return new; end if;
  perform app.enqueue_job('signals.refresh', v_owner, null,
    'signals:' || new.tracking_id || ':' || to_char(date_trunc('minute', coalesce(new.timestamp, now())), 'YYYYMMDDHH24MI'),
    jsonb_build_object('trackingId', new.tracking_id), now() + interval '20 seconds', 3);
  return new;
end;
$$;

create trigger tracking_events_signal after insert or update of classification, suspected_self_open on public.tracking_events
  for each row execute function app.queue_tracking_signal();
revoke all on function app.queue_tracking_signal() from public, anon, authenticated;

-- pigeonbox_app reads the user's own tracking rows for engagement signals and analytics.
grant select on public.tracked_emails, public.tracked_links, public.tracking_events to pigeonbox_app;
create policy "app: own tracked emails" on public.tracked_emails for select to pigeonbox_app using (user_id = app.current_user_id());
create policy "app: own tracked links" on public.tracked_links for select to pigeonbox_app using (user_id = app.current_user_id());
create policy "app: own tracking events" on public.tracking_events for select to pigeonbox_app using (user_id = app.current_user_id());
create index tracked_emails_thread_idx on public.tracked_emails (user_id, gmail_thread_id);
