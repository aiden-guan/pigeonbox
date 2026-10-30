-- PigeonBox Cloud: accounts, billing, usage, rate limits.
-- The API uses the service role and scopes every query by the user ID from a
-- verified token. RLS below is defense in depth: signed-in clients may read
-- only their own rows and may write nothing.

create table public.profiles (
  id uuid primary key references auth.users (id) on delete cascade,
  email text,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

create table public.billing_customers (
  user_id uuid primary key references public.profiles (id) on delete cascade,
  stripe_customer_id text not null unique,
  created_at timestamptz not null default now()
);

create table public.subscriptions (
  user_id uuid primary key references public.profiles (id) on delete cascade,
  stripe_subscription_id text not null unique,
  stripe_customer_id text not null,
  status text not null check (status in ('active', 'trialing', 'past_due', 'canceled', 'incomplete', 'incomplete_expired', 'unpaid', 'paused')),
  price_id text,
  current_period_end timestamptz,
  cancel_at_period_end boolean not null default false,
  -- Stripe event.created of the last applied event; older deliveries are ignored.
  last_event_at bigint not null default 0,
  updated_at timestamptz not null default now()
);
create index subscriptions_customer_idx on public.subscriptions (stripe_customer_id);

-- Webhook idempotency. Rows only; payloads are not stored.
create table public.stripe_events (
  id text primary key,
  type text not null,
  status text not null check (status in ('processing', 'processed')),
  received_at timestamptz not null default now(),
  processed_at timestamptz
);

-- One row per Cloud AI request. Operational metadata only: there is no column
-- for prompts, email text, subjects, addresses or model output.
create table public.usage_events (
  id bigint generated always as identity primary key,
  user_id uuid not null references public.profiles (id) on delete cascade,
  operation text not null,
  provider text not null,
  model text,
  status text not null check (status in ('ok', 'error')),
  error_code text,
  latency_ms integer not null,
  input_tokens integer not null default 0,
  output_tokens integer not null default 0,
  estimated_cost_micros bigint not null default 0,
  request_id text not null,
  created_at timestamptz not null default now()
);
create index usage_events_user_created_idx on public.usage_events (user_id, created_at desc);

create table public.usage_daily (
  user_id uuid not null references public.profiles (id) on delete cascade,
  day date not null,
  requests integer not null default 0,
  tokens bigint not null default 0,
  primary key (user_id, day)
);

create table public.usage_global_daily (
  day date primary key,
  requests bigint not null default 0,
  tokens bigint not null default 0
);

create table public.rate_limit_windows (
  key text not null,
  window_start timestamptz not null,
  count integer not null default 0,
  primary key (key, window_start)
);
create index rate_limit_windows_start_idx on public.rate_limit_windows (window_start);

-- Profiles appear when a user first signs in.
create function public.handle_new_user() returns trigger
language plpgsql security definer set search_path = '' as $$
begin
  insert into public.profiles (id, email) values (new.id, new.email) on conflict (id) do nothing;
  return new;
end;
$$;

create trigger on_auth_user_created after insert on auth.users
  for each row execute function public.handle_new_user();

-- Record usage and roll up per-user and global daily totals in one transaction.
create function public.record_usage(
  p_user_id uuid, p_operation text, p_provider text, p_model text, p_status text, p_error_code text,
  p_latency_ms integer, p_input_tokens integer, p_output_tokens integer, p_cost_micros bigint,
  p_request_id text, p_created_at timestamptz
) returns void
language plpgsql security definer set search_path = '' as $$
declare
  v_day date := (p_created_at at time zone 'utc')::date;
  v_tokens bigint := coalesce(p_input_tokens, 0) + coalesce(p_output_tokens, 0);
begin
  insert into public.usage_events (user_id, operation, provider, model, status, error_code, latency_ms, input_tokens, output_tokens, estimated_cost_micros, request_id, created_at)
  values (p_user_id, p_operation, p_provider, p_model, p_status, p_error_code, p_latency_ms, p_input_tokens, p_output_tokens, p_cost_micros, p_request_id, p_created_at);

  insert into public.usage_daily as d (user_id, day, requests, tokens) values (p_user_id, v_day, 1, v_tokens)
  on conflict (user_id, day) do update set requests = d.requests + 1, tokens = d.tokens + excluded.tokens;

  insert into public.usage_global_daily as g (day, requests, tokens) values (v_day, 1, v_tokens)
  on conflict (day) do update set requests = g.requests + 1, tokens = g.tokens + excluded.tokens;
end;
$$;

-- Fixed-window counter shared by every Worker isolate. Returns the count after this hit.
create function public.hit_rate_limit(p_key text, p_window_start timestamptz) returns integer
language plpgsql security definer set search_path = '' as $$
declare
  v_count integer;
begin
  insert into public.rate_limit_windows as r (key, window_start, count) values (p_key, p_window_start, 1)
  on conflict (key, window_start) do update set count = r.count + 1
  returning count into v_count;
  return v_count;
end;
$$;

-- 'new' claims the event; 'duplicate' means already processed; 'in_progress' means another delivery holds it.
create function public.begin_stripe_event(p_id text, p_type text) returns text
language plpgsql security definer set search_path = '' as $$
declare
  v_status text;
begin
  insert into public.stripe_events (id, type, status) values (p_id, p_type, 'processing')
  on conflict (id) do nothing;
  if found then
    return 'new';
  end if;
  select status into v_status from public.stripe_events where id = p_id;
  return case when v_status = 'processed' then 'duplicate' else 'in_progress' end;
end;
$$;

-- Apply a subscription update unless a newer Stripe event already did.
create function public.apply_subscription(
  p_user_id uuid, p_subscription_id text, p_customer_id text, p_status text, p_price_id text,
  p_current_period_end timestamptz, p_cancel_at_period_end boolean, p_last_event_at bigint
) returns boolean
language plpgsql security definer set search_path = '' as $$
begin
  insert into public.subscriptions as s (user_id, stripe_subscription_id, stripe_customer_id, status, price_id, current_period_end, cancel_at_period_end, last_event_at, updated_at)
  values (p_user_id, p_subscription_id, p_customer_id, p_status, p_price_id, p_current_period_end, p_cancel_at_period_end, p_last_event_at, now())
  on conflict (user_id) do update set
    stripe_subscription_id = excluded.stripe_subscription_id,
    stripe_customer_id = excluded.stripe_customer_id,
    status = excluded.status,
    price_id = excluded.price_id,
    current_period_end = excluded.current_period_end,
    cancel_at_period_end = excluded.cancel_at_period_end,
    last_event_at = excluded.last_event_at,
    updated_at = now()
  where s.last_event_at <= excluded.last_event_at;
  return found;
end;
$$;

-- Only the service role may call these.
revoke all on function public.record_usage from public, anon, authenticated;
revoke all on function public.hit_rate_limit from public, anon, authenticated;
revoke all on function public.begin_stripe_event from public, anon, authenticated;
revoke all on function public.apply_subscription from public, anon, authenticated;
grant execute on function public.record_usage, public.hit_rate_limit, public.begin_stripe_event, public.apply_subscription to service_role;

-- Row-level security.
alter table public.profiles enable row level security;
alter table public.billing_customers enable row level security;
alter table public.subscriptions enable row level security;
alter table public.stripe_events enable row level security;
alter table public.usage_events enable row level security;
alter table public.usage_daily enable row level security;
alter table public.usage_global_daily enable row level security;
alter table public.rate_limit_windows enable row level security;

create policy "own profile" on public.profiles for select to authenticated using ((select auth.uid()) = id);
create policy "own subscription" on public.subscriptions for select to authenticated using ((select auth.uid()) = user_id);
create policy "own usage events" on public.usage_events for select to authenticated using ((select auth.uid()) = user_id);
create policy "own daily usage" on public.usage_daily for select to authenticated using ((select auth.uid()) = user_id);
-- billing_customers, stripe_events, usage_global_daily, rate_limit_windows: no client policies (service role only).

revoke all on public.stripe_events, public.usage_global_daily, public.rate_limit_windows, public.billing_customers from anon, authenticated;
