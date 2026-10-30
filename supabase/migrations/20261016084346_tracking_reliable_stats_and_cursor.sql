-- Exact tracking summaries and an ingestion-order catch-up cursor.
-- Service-role functions only: management callers remain scoped by their server.
create function public.tracking_request_source(p_ua text) returns text
language sql immutable security invoker set search_path = '' as $$
  select case
    when p_ua is null or btrim(p_ua) = '' then 'unknown'
    when p_ua ~* '(googleimageproxy|ggpht)' then 'google_image_proxy'
    when p_ua ~* '(headless|lighthouse|chrome-lighthouse)' then 'headless'
    when p_ua ~* '(scanner|security|barracuda|proofpoint|mimecast|sophos|symantec|trend\s?micro|avast|bitdefender|virustotal|fireeye|paloalto|zscaler|facebookexternalhit|whatsapp|telegrambot|twitterbot|discordbot|googlebot)'
      or p_ua ~* '\m(bot|crawler|spider|slurp|prefetch|preview|mailproxy|imageproxy)\M'
      or (p_ua ~* 'chrome/42\.0\.2311\.135' and p_ua ~* 'edge/12\.246') then 'scanner'
    when (p_ua ~* 'mozilla/\d' and p_ua ~* '(applewebkit|gecko|chrome|safari|firefox|trident|edg)')
      or p_ua ~* '(gmail/|outlook[-/ ](ios|android)|applemail/|iphone mail/|android mail/|samsung email/|yahoo.?mail/)' then 'browser_like'
    else 'unknown' end
$$;

create function public.recompute_tracking_stats(p_tracking_id text , p_user_id uuid default null) returns jsonb
language plpgsql security invoker set search_path = '' as $$
declare
  e record; src text; countable boolean; possible boolean;
  last_open timestamptz; last_possible timestamptz;
  opens integer := 0; clicks integer := 0; pixels integer := 0; possibles integer := 0;
  first_open timestamptz; first_click timestamptz; last_click timestamptz;
begin
  -- Acquire the parent lock BEFORE reading events. Each statement sees the
  -- latest committed history after a competing recomputation releases it.
  perform 1 from public.tracked_emails where tracking_id = p_tracking_id and (p_user_id is null or user_id = p_user_id) for update;
  if not found then raise exception 'unknown tracking id' using errcode = '42501'; end if;
  for e in select * from public.tracking_events where tracking_id = p_tracking_id order by timestamp, id loop
    src := case when coalesce(e.user_agent, '') = '' then null else public.tracking_request_source(e.user_agent) end;
    if e.type = 'OPEN' then
      pixels := pixels + 1;
      countable := not e.suspected_self_open and coalesce(e.classification,'') not in ('SELF_LIKELY','MACHINE_LIKELY','UNKNOWN')
        and coalesce(src,'') not in ('headless','scanner')
        and (e.classification in ('RECIPIENT_LIKELY','PROXY_LIKELY') or
          (e.classification is null and coalesce(src,'') not in ('google_image_proxy','headless','scanner','unknown')));
      if countable and (last_open is null or e.timestamp - last_open >= interval '800 milliseconds') then
        opens := opens + 1; first_open := coalesce(first_open, e.timestamp); last_open := e.timestamp;
      end if;
      possible := not e.suspected_self_open and coalesce(e.classification,'') <> 'SELF_LIKELY'
        and (countable or ((e.classification = 'PROXY_LIKELY' or src = 'google_image_proxy') and coalesce(src,'') not in ('headless','scanner')));
      if possible and (last_possible is null or e.timestamp - last_possible >= interval '800 milliseconds') then
        possibles := possibles + 1; last_possible := e.timestamp;
      end if;
    elsif e.type = 'CLICK' and not e.suspected_self_open
      and coalesce(e.classification,'') not in ('SELF_LIKELY','MACHINE_LIKELY','UNKNOWN')
      and coalesce(src,'') not in ('headless','scanner')
      and (e.classification = 'RECIPIENT_LIKELY' or e.classification is null) then
      clicks := clicks + 1; first_click := coalesce(first_click,e.timestamp); last_click := e.timestamp;
    end if;
  end loop;
  update public.tracked_emails set open_count = opens, first_opened_at = first_open, last_opened_at = last_open,
    click_count = clicks, first_clicked_at = first_click, last_clicked_at = last_click where tracking_id = p_tracking_id;
  return jsonb_build_object('openCount',opens,'firstOpenedAt',first_open,'lastOpenedAt',last_open,
    'clickCount',clicks,'firstClickedAt',first_click,'lastClickedAt',last_click,'pixelLoadCount',pixels,'possibleOpenCount',possibles);
end;
$$;
revoke all on function public.tracking_request_source(text) from public, anon, authenticated;
grant execute on function public.tracking_request_source(text) to service_role;
revoke all on function public.recompute_tracking_stats(text ,uuid) from public, anon, authenticated;
grant execute on function public.recompute_tracking_stats(text ,uuid) to service_role;

create sequence public.tracking_ingest_sequence;
alter table public.tracking_events add column ingest_sequence bigint;
with numbered as (select id, row_number() over (order by timestamp,id) as n from public.tracking_events)
  update public.tracking_events e set ingest_sequence = numbered.n from numbered where e.id = numbered.id;
select setval('public.tracking_ingest_sequence', greatest(1, coalesce((select max(ingest_sequence) from public.tracking_events),0)),
  exists(select 1 from public.tracking_events));
alter table public.tracking_events alter column ingest_sequence set not null;
create index tracking_events_cursor_idx on public.tracking_events (user_id, ingest_sequence);

create function public.assign_tracking_ingest_sequence() returns trigger
language plpgsql security invoker set search_path = '' as $$
begin
  -- Allocate under a transaction-held account lock, so later sequence values
  -- cannot commit ahead of earlier inserts. Observation timestamps may be old
  -- when an offline/queued event finally arrives; ingestion order never is.
  perform pg_catalog.pg_advisory_xact_lock(pg_catalog.hashtextextended(new.user_id::text, 0));
  new.ingest_sequence := nextval('public.tracking_ingest_sequence');
  return new;
end;
$$;
create trigger zz_tracking_events_ingestion_order before insert on public.tracking_events
  for each row execute function public.assign_tracking_ingest_sequence();
revoke all on function public.assign_tracking_ingest_sequence() from public, anon, authenticated;
grant execute on function public.assign_tracking_ingest_sequence() to service_role;
grant usage on sequence public.tracking_ingest_sequence to service_role;

create function public.tracking_event_page(p_after text default null, p_limit integer default 100 , p_user_id uuid default null) returns jsonb
language plpgsql security invoker set search_path = '' as $$
declare result jsonb; next_cursor text; more boolean; page_limit integer := least(200,greatest(1,p_limit));
begin
  if p_after is null then
    select coalesce(max(ingest_sequence),0)::text into next_cursor from public.tracking_events where user_id = p_user_id;
    return jsonb_build_object('events','[]'::jsonb,'cursor',next_cursor,'hasMore',false);
  end if;
  if p_after !~ '^\d{1,20}$' or p_after::numeric > 9223372036854775807 then raise exception 'bad cursor'; end if;
  select coalesce(jsonb_agg((to_jsonb(e) - 'user_id') || jsonb_build_object('ingest_sequence', e.ingest_sequence::text) order by e.ingest_sequence),'[]'::jsonb),
    coalesce(max(e.ingest_sequence)::text,p_after)
    into result,next_cursor from (select * from public.tracking_events where ingest_sequence > p_after::bigint and user_id = p_user_id order by ingest_sequence limit page_limit) e;
  select exists(select 1 from public.tracking_events where ingest_sequence > next_cursor::bigint and user_id = p_user_id) into more;
  return jsonb_build_object('events',result,'cursor',next_cursor,'hasMore',more);
end;
$$;
revoke all on function public.tracking_event_page(text,integer ,uuid) from public, anon, authenticated;
grant execute on function public.tracking_event_page(text,integer ,uuid) to service_role;

-- Bounded administrator repair path for pre-release/stale summaries.
create function public.reconcile_tracking_stats_batch(p_after text default '', p_limit integer default 25) returns jsonb
language plpgsql security invoker set search_path = '' as $$
declare row_before public.tracked_emails%rowtype; result jsonb; last_id text := p_after;
  processed integer := 0; repaired integer := 0;
begin
  for row_before in select * from public.tracked_emails where tracking_id > p_after order by tracking_id limit least(100,greatest(1,p_limit)) loop
    result := public.recompute_tracking_stats(row_before.tracking_id);
    if row_before.open_count <> (result->>'openCount')::integer or row_before.click_count <> (result->>'clickCount')::integer
      or row_before.first_opened_at is distinct from (result->>'firstOpenedAt')::timestamptz
      or row_before.last_opened_at is distinct from (result->>'lastOpenedAt')::timestamptz
      or row_before.first_clicked_at is distinct from (result->>'firstClickedAt')::timestamptz
      or row_before.last_clicked_at is distinct from (result->>'lastClickedAt')::timestamptz then repaired := repaired + 1; end if;
    processed := processed + 1; last_id := row_before.tracking_id;
  end loop;
  return jsonb_build_object('processed',processed,'repaired',repaired,'cursor',last_id,
    'hasMore',exists(select 1 from public.tracked_emails where tracking_id > last_id));
end;
$$;
revoke all on function public.reconcile_tracking_stats_batch(text,integer) from public, anon, authenticated;
grant execute on function public.reconcile_tracking_stats_batch(text,integer) to service_role;
