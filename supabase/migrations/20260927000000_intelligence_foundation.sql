-- PigeonBox Cloud intelligence layer, part 1: connections, sync, jobs, audit.
--
-- Access model
-- ------------
-- The API connects as the database owner and runs every per-user statement
-- inside a transaction switched to the `pigeonbox_app` role with
-- `app.user_id` set (see packages/server/src/db/sql.ts). RLS policies for
-- that role limit each statement to the user's own rows, so server code and
-- background jobs get the same tenant isolation as a client would.
-- Cross-tenant system work (claiming jobs, routing Google push notifications,
-- cron scans) runs as the owner and is kept to a few explicit functions.
--
-- Signed-in Supabase clients (`authenticated`) may read their own rows where a
-- policy says so and write nothing. `pigeonbox_app` is never granted to
-- `authenticator`, so no JWT can assume it through PostgREST.
--
-- Data minimization
-- -----------------
-- No message bodies, snippets or attachments are stored. Threads keep
-- metadata (IDs, participants, timestamps, labels, subject). Derived content
-- that must persist (summaries, commitments, drafts) is encrypted by the
-- server before it reaches these tables.

create extension if not exists pgmq;
create extension if not exists pg_cron;

create schema if not exists app;

do $$
begin
  if not exists (select 1 from pg_roles where rolname = 'pigeonbox_app') then
    create role pigeonbox_app nologin noinherit;
  end if;
end
$$;

-- Let the migration role (the role the API connects as) switch into pigeonbox_app.
do $$
begin
  execute format('grant pigeonbox_app to %I', current_user);
end
$$;

grant usage on schema public to pigeonbox_app;
grant usage on schema app to pigeonbox_app;

-- The user a pigeonbox_app transaction acts for. Null outside one.
create function app.current_user_id() returns uuid
language sql stable as $$
  select nullif(current_setting('app.user_id', true), '')::uuid
$$;
-- app.user_id is only ever set by server code inside a transaction (set_config(..., true)) right
-- after `set local role pigeonbox_app`; PostgREST clients cannot set arbitrary settings.
revoke all on function app.current_user_id() from public;
grant execute on function app.current_user_id() to pigeonbox_app, authenticated;

-- pigeonbox_app reads the profile of the user it acts for (and, later, teammates').
grant select on public.profiles to pigeonbox_app;
create policy "app: own profile" on public.profiles for select to pigeonbox_app using (id = app.current_user_id());

-- Standard protection for a table with a user_id column.
create function app.protect_user_table(p_table regclass, p_client_read boolean) returns void
language plpgsql as $$
begin
  execute format('alter table %s enable row level security', p_table);
  execute format('grant select, insert, update, delete on %s to pigeonbox_app', p_table);
  execute format('create policy "app: own rows" on %s for all to pigeonbox_app using (user_id = app.current_user_id()) with check (user_id = app.current_user_id())', p_table);
  execute format('revoke insert, update, delete, truncate, references, trigger on %s from anon, authenticated', p_table);
  -- Signed-out clients never read user data, not even rows RLS would hide.
  execute format('revoke all on %s from anon', p_table);
  if p_client_read then
    execute format('create policy "client: read own rows" on %s for select to authenticated using (user_id = (select auth.uid()))', p_table);
  else
    execute format('revoke all on %s from anon, authenticated', p_table);
  end if;
end
$$;
revoke all on function app.protect_user_table(regclass, boolean) from public;

-- ---------------------------------------------------------------------------
-- Preferences
-- ---------------------------------------------------------------------------

create table public.user_preferences (
  user_id uuid primary key references public.profiles (id) on delete cascade,
  time_zone text not null default 'UTC',
  workdays smallint[] not null default '{1,2,3,4,5}',
  -- Validated by the server against PreferencesSchema; unknown keys are dropped.
  settings jsonb not null default '{}'::jsonb,
  updated_at timestamptz not null default now()
);
select app.protect_user_table('public.user_preferences', true);

-- ---------------------------------------------------------------------------
-- Google connections
-- ---------------------------------------------------------------------------

create table public.mail_accounts (
  id uuid primary key default gen_random_uuid(),
  user_id uuid not null references public.profiles (id) on delete cascade,
  provider text not null default 'google' check (provider in ('google')),
  google_sub text not null,
  email text not null,
  email_normalized text generated always as (lower(email)) stored,
  display_name text,
  status text not null default 'active' check (status in ('active', 'needs_reauth', 'paused', 'error', 'disconnected')),
  features text[] not null default '{}',
  scopes text[] not null default '{}',
  connected_at timestamptz not null default now(),
  disconnected_at timestamptz,
  last_error_code text,
  updated_at timestamptz not null default now(),
  unique (user_id, google_sub)
);
create index mail_accounts_email_idx on public.mail_accounts (email_normalized) where status <> 'disconnected';
select app.protect_user_table('public.mail_accounts', true);

-- OAuth refresh tokens, AES-GCM sealed by the server (platform/crypto.ts). No client access at all.
create table public.encrypted_credentials (
  id uuid primary key default gen_random_uuid(),
  user_id uuid not null references public.profiles (id) on delete cascade,
  mail_account_id uuid not null references public.mail_accounts (id) on delete cascade,
  kind text not null check (kind in ('google_refresh_token')),
  key_id text not null,
  iv text not null,
  ciphertext text not null,
  created_at timestamptz not null default now(),
  rotated_at timestamptz,
  unique (mail_account_id, kind)
);
select app.protect_user_table('public.encrypted_credentials', false);

-- In-flight Google consent: state (hashed) → user, requested features, sealed PKCE verifier. Single use, short-lived.
create table public.oauth_states (
  state_hash text primary key,
  user_id uuid not null references public.profiles (id) on delete cascade,
  mail_account_id uuid references public.mail_accounts (id) on delete cascade,
  features text[] not null,
  return_to text not null check (return_to in ('extension', 'web')),
  verifier_key_id text not null,
  verifier_iv text not null,
  verifier_ciphertext text not null,
  expires_at timestamptz not null,
  consumed_at timestamptz,
  created_at timestamptz not null default now()
);
create index oauth_states_expires_idx on public.oauth_states (expires_at);
select app.protect_user_table('public.oauth_states', false);

create table public.gmail_sync_state (
  mail_account_id uuid primary key references public.mail_accounts (id) on delete cascade,
  user_id uuid not null references public.profiles (id) on delete cascade,
  history_id numeric(20, 0),
  state text not null default 'initializing' check (state in ('initializing', 'healthy', 'catching_up', 'recovering', 'degraded', 'stalled', 'paused')),
  watch_expires_at timestamptz,
  last_push_at timestamptz,
  last_push_history_id numeric(20, 0),
  last_sync_started_at timestamptz,
  last_sync_completed_at timestamptz,
  consecutive_failures integer not null default 0,
  last_error_code text,
  coverage_since timestamptz,
  backfill_page_token text,
  updated_at timestamptz not null default now()
);
create index gmail_sync_state_watch_idx on public.gmail_sync_state (watch_expires_at);
select app.protect_user_table('public.gmail_sync_state', true);

-- ---------------------------------------------------------------------------
-- Mail metadata (no bodies)
-- ---------------------------------------------------------------------------

create table public.threads (
  id uuid primary key default gen_random_uuid(),
  user_id uuid not null references public.profiles (id) on delete cascade,
  mail_account_id uuid not null references public.mail_accounts (id) on delete cascade,
  gmail_thread_id text not null,
  subject text not null default '',
  participants jsonb not null default '[]'::jsonb,
  label_ids text[] not null default '{}',
  message_count integer not null default 0,
  last_message_id text,
  last_message_at timestamptz,
  last_inbound_at timestamptz,
  last_outbound_at timestamptz,
  last_message_from_owner boolean not null default false,
  has_attachment boolean not null default false,
  is_bulk boolean not null default false,
  -- Changes whenever the set of messages changes; drafts and analyses record the version they used.
  content_version text not null default '',
  analyzed_version text,
  search_tsv tsvector,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  unique (mail_account_id, gmail_thread_id)
);
create index threads_user_last_idx on public.threads (user_id, last_message_at desc);
create index threads_search_idx on public.threads using gin (search_tsv);
select app.protect_user_table('public.threads', true);

create table public.message_metadata (
  id uuid primary key default gen_random_uuid(),
  user_id uuid not null references public.profiles (id) on delete cascade,
  mail_account_id uuid not null references public.mail_accounts (id) on delete cascade,
  thread_id uuid not null references public.threads (id) on delete cascade,
  gmail_message_id text not null,
  rfc822_message_id text,
  internal_date timestamptz not null,
  from_email text,
  from_name text,
  to_emails text[] not null default '{}',
  cc_emails text[] not null default '{}',
  label_ids text[] not null default '{}',
  direction text not null check (direction in ('inbound', 'outbound')),
  is_auto boolean not null default false,
  list_unsubscribe boolean not null default false,
  has_attachment boolean not null default false,
  created_at timestamptz not null default now(),
  unique (mail_account_id, gmail_message_id)
);
create index message_metadata_thread_idx on public.message_metadata (thread_id, internal_date);
create index message_metadata_user_from_idx on public.message_metadata (user_id, lower(from_email));
create index message_metadata_rfc_idx on public.message_metadata (mail_account_id, rfc822_message_id);
select app.protect_user_table('public.message_metadata', true);

-- ---------------------------------------------------------------------------
-- Durable jobs on Supabase Queues (pgmq)
-- ---------------------------------------------------------------------------
-- `jobs` is the record (status, attempts, idempotency, timing, failure code);
-- the pgmq message carries only the job ID and provides delivery with a
-- visibility timeout. A crashed worker's message reappears after the lease.
-- Payloads hold IDs, never mail content.

select pgmq.create('pigeonbox_jobs');

create table public.jobs (
  id uuid primary key default gen_random_uuid(),
  kind text not null,
  user_id uuid references public.profiles (id) on delete cascade,
  mail_account_id uuid references public.mail_accounts (id) on delete cascade,
  idempotency_key text not null unique,
  payload jsonb not null default '{}'::jsonb,
  status text not null default 'queued' check (status in ('queued', 'running', 'retrying', 'succeeded', 'dead', 'cancelled')),
  attempts integer not null default 0,
  max_attempts integer not null default 5 check (max_attempts between 1 and 50),
  run_at timestamptz not null default now(),
  queue_msg_id bigint,
  locked_until timestamptz,
  last_error_code text,
  last_error_at timestamptz,
  created_at timestamptz not null default now(),
  started_at timestamptz,
  completed_at timestamptz,
  updated_at timestamptz not null default now()
);
create index jobs_status_run_idx on public.jobs (status, run_at);
create index jobs_account_status_idx on public.jobs (mail_account_id, status);
create index jobs_user_status_idx on public.jobs (user_id, status);
alter table public.jobs enable row level security;
grant select on public.jobs to pigeonbox_app;
create policy "app: own jobs" on public.jobs for select to pigeonbox_app using (user_id = app.current_user_id());
revoke all on public.jobs from anon, authenticated;

-- Enqueue once per idempotency key. Returns the job and whether it is new.
-- From a user transaction, jobs can only be enqueued for that user.
create function app.enqueue_job(
  p_kind text, p_user_id uuid, p_account_id uuid, p_key text, p_payload jsonb, p_run_at timestamptz, p_max_attempts integer
) returns table (job_id uuid, created boolean)
language plpgsql security definer set search_path = '' as $$
declare
  v_id uuid;
  v_msg bigint;
  v_acting uuid := app.current_user_id();
begin
  if v_acting is not null and p_user_id is distinct from v_acting then
    raise exception 'cannot enqueue a job for another user' using errcode = 'insufficient_privilege';
  end if;
  insert into public.jobs (kind, user_id, mail_account_id, idempotency_key, payload, run_at, max_attempts)
  values (p_kind, p_user_id, p_account_id, p_key, coalesce(p_payload, '{}'::jsonb), coalesce(p_run_at, now()), coalesce(p_max_attempts, 5))
  on conflict (idempotency_key) do nothing
  returning id into v_id;
  if v_id is null then
    select j.id into v_id from public.jobs j where j.idempotency_key = p_key;
    return query select v_id, false;
    return;
  end if;
  select s into v_msg from pgmq.send('pigeonbox_jobs', jsonb_build_object('job_id', v_id),
    greatest(0, floor(extract(epoch from (coalesce(p_run_at, now()) - now()))))::integer) s;
  update public.jobs set queue_msg_id = v_msg where id = v_id;
  return query select v_id, true;
end;
$$;

-- Claim up to p_limit due jobs for p_lease_seconds. System only.
create function app.claim_jobs(p_limit integer, p_lease_seconds integer) returns setof public.jobs
language plpgsql security definer set search_path = '' as $$
declare
  r record;
  v_job public.jobs;
begin
  for r in select * from pgmq.read('pigeonbox_jobs', p_lease_seconds, p_limit) loop
    v_job := null;
    update public.jobs j
       set status = 'running', attempts = j.attempts + 1, started_at = coalesce(j.started_at, now()),
           locked_until = now() + make_interval(secs => p_lease_seconds), queue_msg_id = r.msg_id, updated_at = now()
     where j.id = (r.message ->> 'job_id')::uuid and j.status in ('queued', 'running', 'retrying')
    returning j.* into v_job;
    if v_job.id is null then
      -- Finished, cancelled or deleted with its account: drop the message.
      perform pgmq.delete('pigeonbox_jobs', r.msg_id);
      continue;
    end if;
    if v_job.attempts > v_job.max_attempts then
      -- The job kept losing its lease (crash loop): dead-letter it.
      update public.jobs set status = 'dead', last_error_code = coalesce(last_error_code, 'lease_expired'),
             last_error_at = now(), completed_at = now(), updated_at = now() where id = v_job.id;
      perform pgmq.archive('pigeonbox_jobs', r.msg_id);
      continue;
    end if;
    return next v_job;
  end loop;
end;
$$;

create function app.complete_job(p_job_id uuid) returns void
language plpgsql security definer set search_path = '' as $$
declare v_msg bigint;
begin
  update public.jobs set status = 'succeeded', completed_at = now(), locked_until = null, updated_at = now()
   where id = p_job_id returning queue_msg_id into v_msg;
  if v_msg is not null then perform pgmq.delete('pigeonbox_jobs', v_msg); end if;
end;
$$;

-- Record a failure: retry after p_retry_seconds, or dead-letter (archive) when p_dead.
create function app.fail_job(p_job_id uuid, p_code text, p_retry_seconds integer, p_dead boolean) returns text
language plpgsql security definer set search_path = '' as $$
declare
  v_msg bigint;
  v_attempts integer;
  v_max integer;
  v_status text;
begin
  select queue_msg_id, attempts, max_attempts into v_msg, v_attempts, v_max from public.jobs where id = p_job_id for update;
  if not found then return 'missing'; end if;
  v_status := case when p_dead or v_attempts >= v_max then 'dead' else 'retrying' end;
  update public.jobs set status = v_status, last_error_code = left(p_code, 64), last_error_at = now(), locked_until = null,
         completed_at = case when v_status = 'dead' then now() else null end,
         run_at = case when v_status = 'retrying' then now() + make_interval(secs => p_retry_seconds) else run_at end,
         updated_at = now()
   where id = p_job_id;
  if v_msg is not null then
    if v_status = 'dead' then
      perform pgmq.archive('pigeonbox_jobs', v_msg);
    else
      perform pgmq.set_vt('pigeonbox_jobs', v_msg, greatest(1, p_retry_seconds));
    end if;
  end if;
  return v_status;
end;
$$;

-- Stop pending work for an account (disconnect). Queued messages are dropped on their next read.
create function app.cancel_account_jobs(p_account_id uuid) returns integer
language plpgsql security definer set search_path = '' as $$
declare n integer;
begin
  update public.jobs set status = 'cancelled', completed_at = now(), updated_at = now()
   where mail_account_id = p_account_id and status in ('queued', 'retrying', 'running');
  get diagnostics n = row_count;
  return n;
end;
$$;

-- Waiting is not failing: a job that is not due yet (outside a sending window,
-- at a daily limit, paused) is put back without spending one of its attempts.
create function app.defer_job(p_job_id uuid, p_code text, p_seconds integer) returns void
language plpgsql security definer set search_path = '' as $$
declare
  v_msg bigint;
begin
  select queue_msg_id into v_msg from public.jobs where id = p_job_id for update;
  if not found then return; end if;
  update public.jobs set status = 'retrying', attempts = greatest(attempts - 1, 0), last_error_code = left(p_code, 64), locked_until = null,
         run_at = now() + make_interval(secs => greatest(1, p_seconds)), updated_at = now()
   where id = p_job_id;
  if v_msg is not null then perform pgmq.set_vt('pigeonbox_jobs', v_msg, greatest(1, p_seconds)); end if;
end;
$$;

revoke all on function app.enqueue_job, app.claim_jobs, app.complete_job, app.fail_job, app.defer_job, app.cancel_account_jobs from public, anon, authenticated;
grant execute on function app.enqueue_job to pigeonbox_app;

-- ---------------------------------------------------------------------------
-- Audit log and notifications
-- ---------------------------------------------------------------------------

create table public.audit_events (
  id uuid primary key default gen_random_uuid(),
  user_id uuid not null references public.profiles (id) on delete cascade,
  actor_type text not null check (actor_type in ('user', 'rule', 'automation', 'follow_up', 'sequence', 'mcp', 'system')),
  actor_id text,
  actor_name text not null default '',
  action text not null,
  tier smallint not null check (tier between 0 and 3),
  target_kind text not null,
  target_id text not null,
  target_title text,
  summary text not null,
  policy_decision text not null check (policy_decision in ('allowed', 'shadowed', 'approval_required', 'denied')),
  policy_reason text not null default '',
  reversible boolean not null default false,
  -- Inverse operation (label IDs, thread IDs). Never content.
  undo jsonb,
  undone_at timestamptz,
  undo_of uuid references public.audit_events (id) on delete set null,
  mail_account_id uuid references public.mail_accounts (id) on delete cascade,
  gmail_thread_id text,
  idempotency_key text,
  created_at timestamptz not null default now(),
  unique (user_id, idempotency_key)
);
create index audit_events_user_created_idx on public.audit_events (user_id, created_at desc);
create index audit_events_thread_idx on public.audit_events (mail_account_id, gmail_thread_id);
select app.protect_user_table('public.audit_events', true);

create table public.notifications (
  id uuid primary key default gen_random_uuid(),
  user_id uuid not null references public.profiles (id) on delete cascade,
  kind text not null check (kind in ('approval', 'follow_up_due', 'briefing', 'draft_ready', 'sync_problem', 'mention', 'assignment', 'engagement')),
  title text not null,
  body text not null default '',
  mail_account_id uuid references public.mail_accounts (id) on delete cascade,
  gmail_thread_id text,
  ref_id uuid,
  dedupe_key text not null,
  created_at timestamptz not null default now(),
  read_at timestamptz,
  unique (user_id, dedupe_key)
);
create index notifications_user_created_idx on public.notifications (user_id, created_at desc);
select app.protect_user_table('public.notifications', true);

-- ---------------------------------------------------------------------------
-- Maintenance (Supabase Cron)
-- ---------------------------------------------------------------------------

-- Renew Gmail watches that expire within a day; flag stalled syncs. Enqueue only; the Worker executes.
create function app.enqueue_maintenance() returns integer
language plpgsql security definer set search_path = '' as $$
declare
  r record;
  n integer := 0;
  v_bucket text := to_char(now() at time zone 'utc', 'YYYY-MM-DD"T"HH24');
begin
  for r in
    select s.mail_account_id, s.user_id from public.gmail_sync_state s
      join public.mail_accounts a on a.id = s.mail_account_id
     where a.status = 'active' and 'mail_read' = any (a.features)
       and (s.watch_expires_at is null or s.watch_expires_at < now() + interval '1 day')
  loop
    perform app.enqueue_job('gmail.watch', r.user_id, r.mail_account_id, 'watch:' || r.mail_account_id || ':' || v_bucket, '{}'::jsonb, now(), 5);
    n := n + 1;
  end loop;
  -- A sync with no progress for 6 hours despite being active gets a catch-up sync.
  for r in
    select s.mail_account_id, s.user_id from public.gmail_sync_state s
      join public.mail_accounts a on a.id = s.mail_account_id
     where a.status = 'active' and 'mail_read' = any (a.features)
       and coalesce(s.last_sync_completed_at, s.updated_at) < now() - interval '6 hours'
  loop
    perform app.enqueue_job('gmail.sync', r.user_id, r.mail_account_id, 'sync:catchup:' || r.mail_account_id || ':' || v_bucket, '{}'::jsonb, now(), 8);
    n := n + 1;
  end loop;
  delete from public.oauth_states where expires_at < now() - interval '1 day';
  return n;
end;
$$;
revoke all on function app.enqueue_maintenance from public, anon, authenticated;

select cron.schedule('pigeonbox-maintenance', '*/15 * * * *', $$select app.enqueue_maintenance()$$);
