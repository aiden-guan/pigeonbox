-- Monthly Cloud AI limits are a cost budget, not a token count: input, cached
-- input and output tokens cost very different amounts, and the token cap
-- stopped users long before real spend mattered. usage_daily keeps a running
-- estimated cost alongside tokens; both recording functions add to it.

alter table public.usage_daily add column cost_micros bigint not null default 0;

-- This month's spend so far, so budgets apply from the first deploy.
update public.usage_daily d
   set cost_micros = e.cost
  from (
    select user_id, (created_at at time zone 'utc')::date as day, sum(estimated_cost_micros)::bigint as cost
      from public.usage_events
     where created_at >= date_trunc('month', now() at time zone 'utc') at time zone 'utc'
     group by 1, 2
  ) e
 where d.user_id = e.user_id and d.day = e.day;

create or replace function public.record_usage(
  p_user_id uuid, p_operation text, p_provider text, p_model text, p_status text, p_error_code text,
  p_latency_ms integer, p_input_tokens integer, p_output_tokens integer, p_cost_micros bigint,
  p_request_id text, p_created_at timestamptz
) returns void
language plpgsql security definer set search_path = '' as $$
declare
  v_day date := (p_created_at at time zone 'utc')::date;
  v_tokens bigint := coalesce(p_input_tokens, 0) + coalesce(p_output_tokens, 0);
  v_cost bigint := greatest(coalesce(p_cost_micros, 0), 0);
begin
  insert into public.usage_events (user_id, operation, provider, model, status, error_code, latency_ms, input_tokens, output_tokens, estimated_cost_micros, request_id, created_at)
  values (p_user_id, p_operation, p_provider, p_model, p_status, p_error_code, p_latency_ms, p_input_tokens, p_output_tokens, p_cost_micros, p_request_id, p_created_at);

  insert into public.usage_daily as d (user_id, day, requests, tokens, cost_micros) values (p_user_id, v_day, 1, v_tokens, v_cost)
  on conflict (user_id, day) do update set requests = d.requests + 1, tokens = d.tokens + excluded.tokens, cost_micros = d.cost_micros + excluded.cost_micros;

  insert into public.usage_global_daily as g (day, requests, tokens) values (v_day, 1, v_tokens)
  on conflict (day) do update set requests = g.requests + 1, tokens = g.tokens + excluded.tokens;
end;
$$;

create or replace function public.record_background_usage(
  p_user_id uuid, p_operation text, p_provider text, p_model text, p_status text, p_error_code text,
  p_latency_ms integer, p_input_tokens integer, p_output_tokens integer, p_cost_micros bigint,
  p_request_id text, p_created_at timestamptz
) returns void
language plpgsql security definer set search_path = '' as $$
declare
  v_day date := (p_created_at at time zone 'utc')::date;
  v_tokens bigint := coalesce(p_input_tokens, 0) + coalesce(p_output_tokens, 0);
  v_cost bigint := greatest(coalesce(p_cost_micros, 0), 0);
begin
  if app.current_user_id() is not null and p_user_id is distinct from app.current_user_id() then
    raise exception 'cannot record usage for another user' using errcode = 'insufficient_privilege';
  end if;
  insert into public.usage_events (user_id, operation, provider, model, status, error_code, latency_ms, input_tokens, output_tokens, estimated_cost_micros, request_id, created_at)
  values (p_user_id, p_operation, p_provider, p_model, p_status, p_error_code, p_latency_ms, p_input_tokens, p_output_tokens, p_cost_micros, p_request_id, p_created_at);
  insert into public.usage_daily as d (user_id, day, requests, tokens, background_requests, cost_micros) values (p_user_id, v_day, 0, v_tokens, 1, v_cost)
  on conflict (user_id, day) do update set tokens = d.tokens + excluded.tokens, background_requests = d.background_requests + 1, cost_micros = d.cost_micros + excluded.cost_micros;
  insert into public.usage_global_daily as g (day, requests, tokens) values (v_day, 1, v_tokens)
  on conflict (day) do update set requests = g.requests + 1, tokens = g.tokens + excluded.tokens;
end;
$$;
