-- PigeonBox Cloud intelligence layer, part 2: thread state, commitments,
-- follow-ups, reminders, writing profiles and grounded drafts.
--
-- Sensitive derived content (summaries, commitment text, draft text) is
-- stored only as AES-GCM ciphertext produced by the server (key_id, iv,
-- ciphertext columns). Plain columns hold states, dates, IDs and subjects.

create table public.thread_states (
  thread_id uuid primary key references public.threads (id) on delete cascade,
  user_id uuid not null references public.profiles (id) on delete cascade,
  mail_account_id uuid not null references public.mail_accounts (id) on delete cascade,
  state text not null check (state in ('NEEDS_REPLY', 'WAITING_ON_THEM', 'WAITING_ON_ME', 'FYI', 'NOTIFICATION', 'PROMOTION', 'NEWS', 'SCHEDULED', 'FOLLOW_UP_DUE', 'DONE')),
  category text not null check (category in ('RESPOND', 'WAITING', 'FYI', 'NOTIFICATIONS', 'PROMOTIONS', 'NEWS')),
  priority text not null default 'NORMAL' check (priority in ('HIGH', 'NORMAL', 'LOW')),
  urgency text not null default 'normal' check (urgency in ('critical', 'high', 'normal', 'low')),
  confidence real not null default 0.5 check (confidence between 0 and 1),
  needs_reply boolean not null default false,
  reply_expected_from text not null default 'nobody' check (reply_expected_from in ('owner', 'them', 'nobody')),
  deadline_at timestamptz,
  deadline_explicit boolean not null default false,
  deadline_label text,
  importance_reason text not null default '',
  relationship_importance text not null default 'unknown' check (relationship_importance in ('vip', 'close', 'known', 'new', 'unknown')),
  next_action_kind text not null default 'none',
  next_action_label text not null default '',
  source text not null default 'heuristic' check (source in ('model', 'heuristic', 'rule', 'user', 'system')),
  -- An explicit choice by the user; derived state never overrides it.
  user_state text check (user_state is null or user_state in ('NEEDS_REPLY', 'WAITING_ON_THEM', 'WAITING_ON_ME', 'FYI', 'NOTIFICATION', 'PROMOTION', 'NEWS', 'SCHEDULED', 'FOLLOW_UP_DUE', 'DONE')),
  user_state_version text,
  injection_suspected boolean not null default false,
  meeting_request jsonb,
  summary_key_id text,
  summary_iv text,
  summary_ciphertext text,
  analyzed_version text,
  -- Hash of the exact inference input; unchanged input is never re-classified.
  input_fingerprint text,
  model text,
  analyzed_at timestamptz,
  updated_at timestamptz not null default now()
);
create index thread_states_user_state_idx on public.thread_states (user_id, state);
create index thread_states_user_deadline_idx on public.thread_states (user_id, deadline_at) where deadline_at is not null;
select app.protect_user_table('public.thread_states', true);

-- Every classification decision and correction, for audit and evaluation. No content.
create table public.classifications (
  id uuid primary key default gen_random_uuid(),
  user_id uuid not null references public.profiles (id) on delete cascade,
  thread_id uuid not null references public.threads (id) on delete cascade,
  source text not null check (source in ('model', 'heuristic', 'rule', 'user', 'system')),
  state text not null,
  category text not null,
  confidence real not null,
  model text,
  input_fingerprint text,
  thread_version text,
  created_at timestamptz not null default now()
);
create index classifications_thread_idx on public.classifications (thread_id, created_at desc);
select app.protect_user_table('public.classifications', true);

-- Preferences learned from the user's own corrections. Personal only; nothing trains a shared model.
create table public.learned_preferences (
  id uuid primary key default gen_random_uuid(),
  user_id uuid not null references public.profiles (id) on delete cascade,
  scope text not null check (scope in ('sender', 'domain')),
  key text not null,
  preferred_state text not null,
  corrections integer not null default 1,
  last_corrected_at timestamptz not null default now(),
  unique (user_id, scope, key, preferred_state)
);
select app.protect_user_table('public.learned_preferences', true);

create table public.commitments (
  id uuid primary key default gen_random_uuid(),
  user_id uuid not null references public.profiles (id) on delete cascade,
  mail_account_id uuid not null references public.mail_accounts (id) on delete cascade,
  thread_id uuid not null references public.threads (id) on delete cascade,
  direction text not null check (direction in ('mine', 'theirs')),
  counterparty text,
  owner_label text not null default '',
  text_key_id text not null,
  text_iv text not null,
  text_ciphertext text not null,
  due_at timestamptz,
  status text not null default 'open' check (status in ('open', 'done', 'cancelled')),
  source_message_id text,
  fingerprint text not null,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  resolved_at timestamptz,
  unique (thread_id, fingerprint)
);
create index commitments_user_open_idx on public.commitments (user_id, status, due_at);
create index commitments_counterparty_idx on public.commitments (user_id, lower(counterparty));
select app.protect_user_table('public.commitments', true);

-- ---------------------------------------------------------------------------
-- Drafts with versions and provenance
-- ---------------------------------------------------------------------------

create table public.drafts (
  id uuid primary key default gen_random_uuid(),
  user_id uuid not null references public.profiles (id) on delete cascade,
  mail_account_id uuid not null references public.mail_accounts (id) on delete cascade,
  thread_id uuid not null references public.threads (id) on delete cascade,
  kind text not null check (kind in ('reply', 'follow_up', 'scheduling', 'acknowledgment', 'info_request')),
  status text not null default 'preparing' check (status in ('preparing', 'ready', 'stale', 'user_edited', 'placed', 'sent', 'discarded', 'failed')),
  origin text not null check (origin in ('auto', 'user', 'follow_up', 'scheduling', 'ask', 'automation')),
  based_on_message_id text,
  based_on_version text,
  voice_level text not null default 'default' check (voice_level in ('recipient', 'domain', 'email_type', 'global', 'default')),
  stale_reason text,
  refresh_after timestamptz,
  gmail_draft_id text,
  placed_variant_id uuid,
  -- sha256 of the text PigeonBox placed in Gmail; a different Gmail draft body means the user edited it.
  placed_hash text,
  error_code text,
  current_version integer not null default 0,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);
-- At most one live draft per thread and kind.
create unique index drafts_live_idx on public.drafts (thread_id, kind) where status in ('preparing', 'ready', 'stale', 'user_edited', 'placed');
create index drafts_user_idx on public.drafts (user_id, updated_at desc);
select app.protect_user_table('public.drafts', true);

create table public.draft_versions (
  id uuid primary key default gen_random_uuid(),
  draft_id uuid not null references public.drafts (id) on delete cascade,
  user_id uuid not null references public.profiles (id) on delete cascade,
  version integer not null,
  -- Sealed JSON: [{ id, label, strategy, subject, body, placeholders }]
  variants_key_id text not null,
  variants_iv text not null,
  variants_ciphertext text not null,
  variant_count integer not null,
  grounding_edits integer not null default 0,
  model text,
  created_at timestamptz not null default now(),
  unique (draft_id, version)
);
select app.protect_user_table('public.draft_versions', false);

create table public.draft_sources (
  id uuid primary key default gen_random_uuid(),
  draft_id uuid not null references public.drafts (id) on delete cascade,
  user_id uuid not null references public.profiles (id) on delete cascade,
  version integer not null,
  ordinal integer not null,
  kind text not null check (kind in ('thread', 'message', 'calendar_event', 'document', 'contact', 'tracking', 'note', 'commitment', 'web')),
  ref_id text not null,
  title text not null,
  gmail_thread_id text,
  gmail_message_id text,
  url text,
  at timestamptz,
  who text,
  source_version text
);
create index draft_sources_draft_idx on public.draft_sources (draft_id, version, ordinal);
select app.protect_user_table('public.draft_sources', false);

-- ---------------------------------------------------------------------------
-- Follow-ups (conversation state) and reminders
-- ---------------------------------------------------------------------------

create table public.follow_ups (
  id uuid primary key default gen_random_uuid(),
  user_id uuid not null references public.profiles (id) on delete cascade,
  mail_account_id uuid not null references public.mail_accounts (id) on delete cascade,
  thread_id uuid not null unique references public.threads (id) on delete cascade,
  stage text not null check (stage in ('sent', 'waiting', 'engaged', 'reply', 'follow_up_due', 'closed')),
  reply_expected boolean not null default true,
  expected_from text[] not null default '{}',
  reason text not null default '',
  rule text not null default 'business_days' check (rule in ('business_days', 'opened_no_reply', 'revived', 'promised', 'deadline', 'manual')),
  business_days integer,
  last_outbound_at timestamptz not null,
  last_outbound_message_id text,
  last_inbound_at timestamptz,
  due_at timestamptz,
  snoozed_until timestamptz,
  draft_id uuid references public.drafts (id) on delete set null,
  engagement_opens integer not null default 0,
  engagement_last_open_at timestamptz,
  engagement_clicks integer not null default 0,
  notified_at timestamptz,
  closed_reason text,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);
create index follow_ups_user_stage_idx on public.follow_ups (user_id, stage, due_at);
select app.protect_user_table('public.follow_ups', true);

create table public.reminders (
  id uuid primary key default gen_random_uuid(),
  user_id uuid not null references public.profiles (id) on delete cascade,
  mail_account_id uuid references public.mail_accounts (id) on delete cascade,
  thread_id uuid references public.threads (id) on delete cascade,
  remind_at timestamptz not null,
  reason text not null,
  source text not null check (source in ('manual', 'rule', 'automation', 'commitment', 'follow_up')),
  status text not null default 'pending' check (status in ('pending', 'fired', 'cancelled')),
  created_at timestamptz not null default now(),
  fired_at timestamptz
);
create index reminders_due_idx on public.reminders (status, remind_at);
select app.protect_user_table('public.reminders', true);

-- ---------------------------------------------------------------------------
-- Writing profiles: structure only (greeting shape, sign-off, length, tone)
-- ---------------------------------------------------------------------------

create table public.writing_profiles (
  id uuid primary key default gen_random_uuid(),
  user_id uuid not null references public.profiles (id) on delete cascade,
  level text not null check (level in ('global', 'recipient', 'domain', 'email_type')),
  key text not null default '',
  sample_count integer not null default 0,
  -- Normalized shapes, e.g. "Hi {first}," and "Best". Names are replaced; no message text is kept.
  greeting text,
  signoff text,
  avg_words real,
  avg_sentence_words real,
  question_rate real,
  bullet_rate real,
  emoji_rate real,
  exclamation_rate real,
  formality real,
  directness real,
  edit_shorten_rate real,
  scheduling_style text,
  updated_at timestamptz not null default now(),
  unique (user_id, level, key)
);
select app.protect_user_table('public.writing_profiles', true);

-- ---------------------------------------------------------------------------
-- Background AI usage is metered separately from interactive requests,
-- but shares the monthly token limit and the global budget.
-- ---------------------------------------------------------------------------

alter table public.usage_daily add column background_requests integer not null default 0;

create function public.record_background_usage(
  p_user_id uuid, p_operation text, p_provider text, p_model text, p_status text, p_error_code text,
  p_latency_ms integer, p_input_tokens integer, p_output_tokens integer, p_cost_micros bigint,
  p_request_id text, p_created_at timestamptz
) returns void
language plpgsql security definer set search_path = '' as $$
declare
  v_day date := (p_created_at at time zone 'utc')::date;
  v_tokens bigint := coalesce(p_input_tokens, 0) + coalesce(p_output_tokens, 0);
begin
  if app.current_user_id() is not null and p_user_id is distinct from app.current_user_id() then
    raise exception 'cannot record usage for another user' using errcode = 'insufficient_privilege';
  end if;
  insert into public.usage_events (user_id, operation, provider, model, status, error_code, latency_ms, input_tokens, output_tokens, estimated_cost_micros, request_id, created_at)
  values (p_user_id, p_operation, p_provider, p_model, p_status, p_error_code, p_latency_ms, p_input_tokens, p_output_tokens, p_cost_micros, p_request_id, p_created_at);
  insert into public.usage_daily as d (user_id, day, requests, tokens, background_requests) values (p_user_id, v_day, 0, v_tokens, 1)
  on conflict (user_id, day) do update set tokens = d.tokens + excluded.tokens, background_requests = d.background_requests + 1;
  insert into public.usage_global_daily as g (day, requests, tokens) values (v_day, 1, v_tokens)
  on conflict (day) do update set requests = g.requests + 1, tokens = g.tokens + excluded.tokens;
end;
$$;
revoke all on function public.record_background_usage from public, anon, authenticated;
grant execute on function public.record_background_usage to service_role, pigeonbox_app;
grant select on public.usage_daily to pigeonbox_app;
create policy "app: own daily usage" on public.usage_daily for select to pigeonbox_app using (user_id = app.current_user_id());
grant select on public.usage_global_daily to pigeonbox_app;
create policy "app: read global budget" on public.usage_global_daily for select to pigeonbox_app using (true);
alter table public.usage_events enable row level security;
