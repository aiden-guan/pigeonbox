-- PigeonBox Cloud intelligence layer, part 3: Smart Views with Shadow Mode,
-- automations, the approval queue, tasks and notes, briefings, calendar.

-- ---------------------------------------------------------------------------
-- Smart Views and rules
-- ---------------------------------------------------------------------------

create table public.smart_views (
  id uuid primary key default gen_random_uuid(),
  user_id uuid not null references public.profiles (id) on delete cascade,
  name text not null,
  prompt text not null default '',
  filter jsonb not null,
  explanation text[] not null default '{}',
  uses_ai boolean not null default false,
  actions jsonb not null default '[]'::jsonb,
  mode text not null default 'view' check (mode in ('view', 'shadow', 'active')),
  enabled boolean not null default true,
  priority integer not null default 50 check (priority between 0 and 100),
  version integer not null default 1,
  matched integer not null default 0,
  shadow_decisions integer not null default 0,
  confirmed integer not null default 0,
  corrected integer not null default 0,
  applied integer not null default 0,
  undone integer not null default 0,
  last_run_at timestamptz,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);
create index smart_views_user_idx on public.smart_views (user_id, priority desc);
select app.protect_user_table('public.smart_views', true);

-- Every change to a rule, for audit and rollback.
create table public.rule_versions (
  id uuid primary key default gen_random_uuid(),
  view_id uuid not null references public.smart_views (id) on delete cascade,
  user_id uuid not null references public.profiles (id) on delete cascade,
  version integer not null,
  name text not null,
  prompt text not null,
  filter jsonb not null,
  actions jsonb not null,
  mode text not null,
  enabled boolean not null,
  changed_by text not null,
  created_at timestamptz not null default now(),
  unique (view_id, version)
);
select app.protect_user_table('public.rule_versions', true);

-- Evaluation cache: whether a thread version matches a rule version, and why.
create table public.rule_matches (
  id uuid primary key default gen_random_uuid(),
  user_id uuid not null references public.profiles (id) on delete cascade,
  view_id uuid not null references public.smart_views (id) on delete cascade,
  thread_id uuid not null references public.threads (id) on delete cascade,
  rule_version integer not null,
  thread_version text not null,
  matched boolean not null,
  why text[] not null default '{}',
  confidence real not null default 1,
  evaluated_at timestamptz not null default now(),
  unique (view_id, thread_id)
);
create index rule_matches_view_idx on public.rule_matches (view_id, matched, evaluated_at desc);
select app.protect_user_table('public.rule_matches', true);

-- What a rule in Shadow Mode would have done. Nothing in Gmail changed.
create table public.shadow_decisions (
  id uuid primary key default gen_random_uuid(),
  user_id uuid not null references public.profiles (id) on delete cascade,
  view_id uuid not null references public.smart_views (id) on delete cascade,
  thread_id uuid not null references public.threads (id) on delete cascade,
  rule_version integer not null,
  thread_version text not null,
  actions jsonb not null,
  why text[] not null default '{}',
  confidence real not null default 1,
  verdict text not null default 'pending' check (verdict in ('pending', 'correct', 'incorrect')),
  created_at timestamptz not null default now(),
  reviewed_at timestamptz,
  unique (view_id, thread_id, rule_version)
);
create index shadow_decisions_view_idx on public.shadow_decisions (view_id, created_at desc);
select app.protect_user_table('public.shadow_decisions', true);

-- ---------------------------------------------------------------------------
-- Automations
-- ---------------------------------------------------------------------------

create table public.automation_rules (
  id uuid primary key default gen_random_uuid(),
  user_id uuid not null references public.profiles (id) on delete cascade,
  name text not null,
  prompt text not null default '',
  trigger_kind text not null check (trigger_kind in ('email_received', 'email_sent', 'reply_received', 'no_reply_by', 'tracking_event', 'state_changed', 'calendar_approaching', 'schedule', 'manual')),
  trigger_params jsonb not null default '{}'::jsonb,
  conditions jsonb not null,
  context text[] not null default '{thread}',
  actions jsonb not null,
  autonomy text not null default 'suggest' check (autonomy in ('suggest', 'auto_reversible', 'auto_draft')),
  schedule_cron text,
  schedule_tz text,
  next_run_at timestamptz,
  mode text not null default 'shadow' check (mode in ('shadow', 'active')),
  enabled boolean not null default true,
  version integer not null default 1,
  explanation text[] not null default '{}',
  runs integer not null default 0,
  failures integer not null default 0,
  last_run_at timestamptz,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);
create index automation_rules_trigger_idx on public.automation_rules (user_id, trigger_kind) where enabled;
create index automation_rules_schedule_idx on public.automation_rules (next_run_at) where enabled and schedule_cron is not null;
select app.protect_user_table('public.automation_rules', true);

create table public.automation_runs (
  id uuid primary key default gen_random_uuid(),
  user_id uuid not null references public.profiles (id) on delete cascade,
  automation_id uuid not null references public.automation_rules (id) on delete cascade,
  trigger text not null,
  thread_id uuid references public.threads (id) on delete set null,
  gmail_thread_id text,
  status text not null default 'running' check (status in ('running', 'completed', 'failed', 'skipped')),
  outcomes jsonb not null default '[]'::jsonb,
  error_code text,
  idempotency_key text not null,
  started_at timestamptz not null default now(),
  completed_at timestamptz,
  unique (user_id, idempotency_key)
);
create index automation_runs_rule_idx on public.automation_runs (automation_id, started_at desc);
select app.protect_user_table('public.automation_runs', true);

-- ---------------------------------------------------------------------------
-- Approvals: one queue for Gmail, the side panel, the web app and MCP.
-- Exact outgoing content is sealed; plain columns describe the action.
-- ---------------------------------------------------------------------------

create table public.approvals (
  id uuid primary key default gen_random_uuid(),
  user_id uuid not null references public.profiles (id) on delete cascade,
  kind text not null,
  tier smallint not null check (tier between 0 and 3),
  status text not null default 'pending' check (status in ('pending', 'approved', 'rejected', 'expired', 'executed', 'failed')),
  title text not null,
  why text not null default '',
  sources jsonb not null default '[]'::jsonb,
  -- The action to run on approval: kind, params and target IDs. No content.
  action jsonb not null,
  preview_key_id text,
  preview_iv text,
  preview_ciphertext text,
  preview_meta jsonb not null default '{}'::jsonb,
  responsible_type text not null check (responsible_type in ('user', 'rule', 'automation', 'follow_up', 'sequence', 'mcp', 'system')),
  responsible_id text,
  responsible_name text not null default '',
  mail_account_id uuid references public.mail_accounts (id) on delete cascade,
  thread_id uuid references public.threads (id) on delete set null,
  gmail_thread_id text,
  expires_at timestamptz,
  decided_at timestamptz,
  executed_at timestamptz,
  result_code text,
  result_message text,
  idempotency_key text not null,
  created_at timestamptz not null default now(),
  unique (user_id, idempotency_key)
);
create index approvals_user_status_idx on public.approvals (user_id, status, created_at desc);
select app.protect_user_table('public.approvals', true);

create table public.tasks (
  id uuid primary key default gen_random_uuid(),
  user_id uuid not null references public.profiles (id) on delete cascade,
  thread_id uuid references public.threads (id) on delete cascade,
  gmail_thread_id text,
  title_key_id text not null,
  title_iv text not null,
  title_ciphertext text not null,
  due_at timestamptz,
  status text not null default 'open' check (status in ('open', 'done', 'cancelled')),
  source text not null default 'user',
  created_at timestamptz not null default now(),
  completed_at timestamptz
);
create index tasks_user_status_idx on public.tasks (user_id, status, due_at);
select app.protect_user_table('public.tasks', true);

-- The user's own notes on threads or contacts; searchable by Ask Pigeon.
create table public.notes (
  id uuid primary key default gen_random_uuid(),
  user_id uuid not null references public.profiles (id) on delete cascade,
  thread_id uuid references public.threads (id) on delete cascade,
  contact_email text,
  body_key_id text not null,
  body_iv text not null,
  body_ciphertext text not null,
  source text not null default 'user',
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);
create index notes_user_idx on public.notes (user_id, created_at desc);
select app.protect_user_table('public.notes', true);

-- ---------------------------------------------------------------------------
-- Briefings
-- ---------------------------------------------------------------------------

create table public.briefings (
  id uuid primary key default gen_random_uuid(),
  user_id uuid not null references public.profiles (id) on delete cascade,
  kind text not null check (kind in ('morning', 'end_of_day', 'meeting')),
  title text not null,
  period_start timestamptz not null,
  period_end timestamptz not null,
  event_id text,
  content_key_id text not null,
  content_iv text not null,
  content_ciphertext text not null,
  generated_at timestamptz not null default now(),
  dedupe_key text not null,
  unique (user_id, dedupe_key)
);
create index briefings_user_idx on public.briefings (user_id, generated_at desc);
select app.protect_user_table('public.briefings', true);

-- ---------------------------------------------------------------------------
-- Calendar
-- ---------------------------------------------------------------------------

create table public.calendar_accounts (
  mail_account_id uuid primary key references public.mail_accounts (id) on delete cascade,
  user_id uuid not null references public.profiles (id) on delete cascade,
  calendar_ids text[] not null default '{primary}',
  time_zone text,
  enabled boolean not null default true,
  updated_at timestamptz not null default now()
);
select app.protect_user_table('public.calendar_accounts', true);

create table public.calendar_sync_state (
  mail_account_id uuid primary key references public.mail_accounts (id) on delete cascade,
  user_id uuid not null references public.profiles (id) on delete cascade,
  last_refresh_at timestamptz,
  window_start timestamptz,
  window_end timestamptz,
  busy_hash text,
  events_count integer not null default 0,
  last_error_code text,
  updated_at timestamptz not null default now()
);
select app.protect_user_table('public.calendar_sync_state', true);

-- Upcoming events for briefings and Ask Pigeon (titles and times, like subjects; no descriptions).
create table public.calendar_event_cache (
  id uuid primary key default gen_random_uuid(),
  user_id uuid not null references public.profiles (id) on delete cascade,
  mail_account_id uuid not null references public.mail_accounts (id) on delete cascade,
  event_id text not null,
  title text not null default '',
  start_at timestamptz not null,
  end_at timestamptz not null,
  all_day boolean not null default false,
  attendees text[] not null default '{}',
  organizer text,
  location text,
  html_link text,
  status text,
  self_response text,
  etag text,
  updated_at timestamptz not null default now(),
  unique (mail_account_id, event_id)
);
create index calendar_event_cache_user_start_idx on public.calendar_event_cache (user_id, start_at);
select app.protect_user_table('public.calendar_event_cache', true);

create table public.prepared_events (
  id uuid primary key default gen_random_uuid(),
  user_id uuid not null references public.profiles (id) on delete cascade,
  mail_account_id uuid not null references public.mail_accounts (id) on delete cascade,
  thread_id uuid references public.threads (id) on delete set null,
  gmail_thread_id text,
  title text not null,
  start_at timestamptz not null,
  end_at timestamptz not null,
  time_zone text not null,
  attendees text[] not null default '{}',
  location text,
  description_key_id text,
  description_iv text,
  description_ciphertext text,
  notify_attendees boolean not null default false,
  status text not null default 'prepared' check (status in ('prepared', 'approval_pending', 'created', 'cancelled', 'failed')),
  calendar_event_id text,
  html_link text,
  approval_id uuid references public.approvals (id) on delete set null,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  check (end_at > start_at)
);
select app.protect_user_table('public.prepared_events', true);

-- ---------------------------------------------------------------------------
-- Scheduled work (Supabase Cron): briefings, calendar refresh, automations
-- ---------------------------------------------------------------------------

-- `p_now` decides what is due (tests pass their own clock); jobs always run as soon as possible.
create function app.enqueue_scheduled(p_now timestamptz default now()) returns integer
language plpgsql security definer set search_path = '' as $$
declare
  r record;
  n integer := 0;
  v_local timestamp;
  v_dow integer;
  v_hhmm text;
  v_date text;
begin
  -- Morning and end-of-day briefings at the user's local time on working days.
  for r in select p.user_id, p.time_zone, p.workdays, p.settings from public.user_preferences p loop
    begin
      v_local := p_now at time zone r.time_zone;
    exception when others then
      v_local := p_now at time zone 'UTC';
    end;
    v_dow := extract(dow from v_local)::integer;
    v_hhmm := to_char(v_local, 'HH24:MI');
    v_date := to_char(v_local, 'YYYY-MM-DD');
    if not (v_dow = any (r.workdays)) then continue; end if;
    if coalesce((r.settings -> 'briefings' -> 'morning' ->> 'enabled')::boolean, true)
       and v_hhmm >= coalesce(r.settings -> 'briefings' -> 'morning' ->> 'at', '08:00')
       and v_hhmm < to_char((coalesce(r.settings -> 'briefings' -> 'morning' ->> 'at', '08:00')::time + interval '45 minutes'), 'HH24:MI') then
      perform app.enqueue_job('briefing.generate', r.user_id, null, 'brief:morning:' || r.user_id || ':' || v_date, jsonb_build_object('kind', 'morning'), null, 3);
      n := n + 1;
    end if;
    if coalesce((r.settings -> 'briefings' -> 'endOfDay' ->> 'enabled')::boolean, false)
       and v_hhmm >= coalesce(r.settings -> 'briefings' -> 'endOfDay' ->> 'at', '17:30')
       and v_hhmm < to_char((coalesce(r.settings -> 'briefings' -> 'endOfDay' ->> 'at', '17:30')::time + interval '45 minutes'), 'HH24:MI') then
      perform app.enqueue_job('briefing.generate', r.user_id, null, 'brief:eod:' || r.user_id || ':' || v_date, jsonb_build_object('kind', 'end_of_day'), null, 3);
      n := n + 1;
    end if;
  end loop;
  -- Calendar refresh for meeting briefs and availability, every 15 minutes.
  for r in select a.id, a.user_id from public.mail_accounts a where a.status = 'active' and 'calendar_read' = any (a.features) loop
    perform app.enqueue_job('calendar.refresh', r.user_id, r.id, 'calendar:' || r.id || ':' || to_char(date_trunc('minute', p_now) - make_interval(mins => (extract(minute from p_now)::integer % 15)), 'YYYY-MM-DD"T"HH24:MI'), '{}'::jsonb, null, 3);
    n := n + 1;
  end loop;
  -- Scheduled automations that are due.
  for r in select a.id, a.user_id, a.next_run_at from public.automation_rules a where a.enabled and a.schedule_cron is not null and a.next_run_at <= p_now loop
    perform app.enqueue_job('automation.run', r.user_id, null, 'automation:' || r.id || ':' || to_char(r.next_run_at, 'YYYY-MM-DD"T"HH24:MI'), jsonb_build_object('automationId', r.id, 'trigger', 'schedule'), null, 3);
    n := n + 1;
  end loop;
  -- Retention sweep once a day (Fast Recall expiry, old notifications).
  perform app.enqueue_job('retention.sweep', null, null, 'retention:' || to_char(p_now at time zone 'utc', 'YYYY-MM-DD'), '{}'::jsonb, null, 3);
  return n;
end;
$$;
revoke all on function app.enqueue_scheduled from public, anon, authenticated;

select cron.schedule('pigeonbox-scheduled', '*/15 * * * *', $$select app.enqueue_scheduled()$$);
