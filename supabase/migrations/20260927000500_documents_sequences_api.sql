-- PigeonBox Cloud intelligence layer, part 6: tracked documents, controlled
-- sequences, developer API/MCP tokens, outbound webhooks and idempotency.

-- ---------------------------------------------------------------------------
-- Tracked documents (files live in a private Supabase Storage bucket)
-- ---------------------------------------------------------------------------

create table public.documents (
  id uuid primary key default gen_random_uuid(),
  user_id uuid not null references public.profiles (id) on delete cascade,
  title text not null,
  filename text not null,
  content_type text not null default 'application/pdf' check (content_type = 'application/pdf'),
  size_bytes integer not null default 0,
  page_count integer,
  sha256 text,
  storage_path text not null,
  status text not null default 'uploading' check (status in ('uploading', 'ready', 'failed', 'deleted')),
  created_at timestamptz not null default now(),
  deleted_at timestamptz
);
create index documents_user_idx on public.documents (user_id, created_at desc);
select app.protect_user_table('public.documents', true);

-- One link per recipient. The token is shown once; only its hash is stored.
create table public.document_recipients (
  id uuid primary key default gen_random_uuid(),
  user_id uuid not null references public.profiles (id) on delete cascade,
  document_id uuid not null references public.documents (id) on delete cascade,
  token_hash text not null unique,
  token_hint text not null,
  -- The link token sealed for the owner, so they can copy the link again. Lookups use the hash.
  token_key_id text not null,
  token_iv text not null,
  token_ciphertext text not null,
  recipient_email text,
  expires_at timestamptz,
  allow_download boolean not null default false,
  watermark boolean not null default true,
  revoked_at timestamptz,
  gmail_thread_id text,
  created_at timestamptz not null default now()
);
create index document_recipients_document_idx on public.document_recipients (document_id);
-- Holds token hashes or sealed secrets: server-only.
select app.protect_user_table('public.document_recipients', false);

-- What the PigeonBox viewer observed. Page events exist only when the viewer rendered and saw the page.
create table public.document_events (
  id uuid primary key default gen_random_uuid(),
  user_id uuid not null references public.profiles (id) on delete cascade,
  document_id uuid not null references public.documents (id) on delete cascade,
  recipient_id uuid not null references public.document_recipients (id) on delete cascade,
  session_id text not null,
  client_event_id text not null,
  kind text not null check (kind in ('view_start', 'page_view', 'heartbeat', 'download', 'view_end', 'file_fetch')),
  page integer,
  visible_ms integer not null default 0 check (visible_ms between 0 and 600000),
  at timestamptz not null default now(),
  ip_hash text,
  ua_family text,
  event_class text not null default 'UNKNOWN' check (event_class in ('RECIPIENT_LIKELY', 'SELF_LIKELY', 'MACHINE_LIKELY', 'PRIVACY_PROXY', 'UNKNOWN')),
  unique (recipient_id, client_event_id)
);
create index document_events_recipient_idx on public.document_events (recipient_id, at);
select app.protect_user_table('public.document_events', true);

-- ---------------------------------------------------------------------------
-- Sequences: user-provided recipients only, conservative limits, stop on
-- reply, suppression first. Every send batch goes through approval.
-- ---------------------------------------------------------------------------

create table public.suppressions (
  id uuid primary key default gen_random_uuid(),
  user_id uuid not null references public.profiles (id) on delete cascade,
  email_normalized text not null,
  reason text not null check (reason in ('unsubscribed', 'bounced', 'complained', 'manual')),
  source_sequence_id uuid,
  created_at timestamptz not null default now(),
  unique (user_id, email_normalized)
);
select app.protect_user_table('public.suppressions', true);

create table public.sequences (
  id uuid primary key default gen_random_uuid(),
  user_id uuid not null references public.profiles (id) on delete cascade,
  mail_account_id uuid not null references public.mail_accounts (id) on delete cascade,
  name text not null,
  status text not null default 'draft' check (status in ('draft', 'active', 'paused', 'completed', 'stopped')),
  daily_limit integer not null default 25 check (daily_limit between 1 and 500),
  window_start text not null default '09:00',
  window_end text not null default '17:00',
  stop_on_reply boolean not null default true,
  track_opens boolean not null default false,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);
select app.protect_user_table('public.sequences', true);

create table public.sequence_steps (
  id uuid primary key default gen_random_uuid(),
  sequence_id uuid not null references public.sequences (id) on delete cascade,
  user_id uuid not null references public.profiles (id) on delete cascade,
  step_index integer not null check (step_index between 0 and 9),
  delay_business_days integer not null default 0 check (delay_business_days between 0 and 60),
  subject_template text not null,
  body_template text not null,
  ai_personalize boolean not null default false,
  unique (sequence_id, step_index)
);
select app.protect_user_table('public.sequence_steps', true);

create table public.sequence_enrollments (
  id uuid primary key default gen_random_uuid(),
  sequence_id uuid not null references public.sequences (id) on delete cascade,
  user_id uuid not null references public.profiles (id) on delete cascade,
  email text not null,
  email_normalized text generated always as (lower(email)) stored,
  merge_key_id text,
  merge_iv text,
  merge_ciphertext text,
  status text not null default 'active' check (status in ('active', 'replied', 'bounced', 'unsubscribed', 'suppressed', 'completed', 'stopped')),
  current_step integer not null default 0,
  next_send_at timestamptz,
  last_sent_at timestamptz,
  gmail_thread_id text,
  stopped_reason text,
  created_at timestamptz not null default now(),
  unique (sequence_id, email_normalized)
);
create index sequence_enrollments_due_idx on public.sequence_enrollments (status, next_send_at);
select app.protect_user_table('public.sequence_enrollments', true);

create table public.sequence_sends (
  id uuid primary key default gen_random_uuid(),
  enrollment_id uuid not null references public.sequence_enrollments (id) on delete cascade,
  user_id uuid not null references public.profiles (id) on delete cascade,
  step_index integer not null,
  status text not null default 'pending_approval' check (status in ('pending_approval', 'approved', 'sent', 'failed', 'skipped')),
  approval_id uuid references public.approvals (id) on delete set null,
  -- Exactly what the user approved for this recipient, sealed.
  content_key_id text,
  content_iv text,
  content_ciphertext text,
  gmail_message_id text,
  gmail_thread_id text,
  tracking_id text,
  scheduled_for timestamptz,
  sent_at timestamptz,
  error_code text,
  -- One-click unsubscribe (RFC 8058), one link per email so every email's link keeps working.
  -- Only the hash of the link token is stored.
  unsubscribe_token_hash text unique,
  created_at timestamptz not null default now(),
  unique (enrollment_id, step_index)
);
create index sequence_sends_user_sent_idx on public.sequence_sends (user_id, sent_at);
select app.protect_user_table('public.sequence_sends', true);

-- ---------------------------------------------------------------------------
-- Developer API and MCP
-- ---------------------------------------------------------------------------

create table public.mcp_clients (
  id uuid primary key default gen_random_uuid(),
  user_id uuid not null references public.profiles (id) on delete cascade,
  name text not null,
  kind text not null default 'api_token' check (kind in ('api_token')),
  token_prefix text not null,
  token_hash text not null unique,
  scopes text[] not null check (scopes <@ array['read', 'prepare', 'write']::text[] and cardinality(scopes) > 0),
  last_used_at timestamptz,
  expires_at timestamptz,
  revoked_at timestamptz,
  created_at timestamptz not null default now()
);
-- Holds token hashes or sealed secrets: server-only.
select app.protect_user_table('public.mcp_clients', false);

-- Responses to writes keyed by client-chosen idempotency keys. IDs and status only.
create table public.idempotency_keys (
  user_id uuid not null references public.profiles (id) on delete cascade,
  scope text not null,
  key text not null,
  result jsonb not null default '{}'::jsonb,
  created_at timestamptz not null default now(),
  primary key (user_id, scope, key)
);
select app.protect_user_table('public.idempotency_keys', false);

create table public.webhooks (
  id uuid primary key default gen_random_uuid(),
  user_id uuid not null references public.profiles (id) on delete cascade,
  url text not null check (url ~ '^https://'),
  events text[] not null,
  secret_key_id text not null,
  secret_iv text not null,
  secret_ciphertext text not null,
  enabled boolean not null default true,
  failures integer not null default 0,
  last_status integer,
  last_delivery_at timestamptz,
  created_at timestamptz not null default now()
);
-- Holds token hashes or sealed secrets: server-only.
select app.protect_user_table('public.webhooks', false);

-- Token lookup for the API/MCP: system scope by hash only, then everything runs as the owner.
create function app.resolve_api_token(p_hash text) returns table (client_id uuid, user_id uuid, scopes text[])
language sql security definer set search_path = '' as $$
  update public.mcp_clients set last_used_at = now()
   where token_hash = p_hash and revoked_at is null and (expires_at is null or expires_at > now())
  returning id, user_id, scopes
$$;
revoke all on function app.resolve_api_token(text) from public, anon, authenticated;

-- Public document viewer: find a link by token hash (system scope), nothing else.
create function app.resolve_document_link(p_hash text) returns table (recipient_id uuid, user_id uuid, document_id uuid)
language sql stable security definer set search_path = '' as $$
  select r.id, r.user_id, r.document_id from public.document_recipients r join public.documents d on d.id = r.document_id
   where r.token_hash = p_hash and r.revoked_at is null and (r.expires_at is null or r.expires_at > now()) and d.status = 'ready'
$$;
revoke all on function app.resolve_document_link(text) from public, anon, authenticated;

-- Unsubscribe by token hash (system scope), for the public one-click endpoint.
create function app.resolve_unsubscribe(p_hash text) returns table (enrollment_id uuid, user_id uuid, sequence_id uuid, email text)
language sql stable security definer set search_path = '' as $$
  select e.id, e.user_id, e.sequence_id, e.email_normalized
    from public.sequence_sends x join public.sequence_enrollments e on e.id = x.enrollment_id
   where x.unsubscribe_token_hash = p_hash
$$;
revoke all on function app.resolve_unsubscribe(text) from public, anon, authenticated;

-- Retention: expire Fast Recall excerpts and old notifications.
create function app.sweep_retention() returns integer
language plpgsql security definer set search_path = '' as $$
declare n integer := 0; m integer;
begin
  delete from public.recall_chunks where expires_at < now();
  get diagnostics m = row_count; n := n + m;
  delete from public.notifications where created_at < now() - interval '90 days';
  get diagnostics m = row_count; n := n + m;
  delete from public.idempotency_keys where created_at < now() - interval '30 days';
  get diagnostics m = row_count; n := n + m;
  delete from public.rate_limit_windows where window_start < now() - interval '1 day';
  get diagnostics m = row_count; n := n + m;
  return n;
end;
$$;
revoke all on function app.sweep_retention() from public, anon, authenticated;
