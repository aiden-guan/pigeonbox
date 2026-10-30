-- Extend the existing owned/RLS-protected event cache; no duplicate plaintext,
-- new table, provider, vector dimension, or compose-time backfill.
alter table public.calendar_event_cache
  add column embedding extensions.vector(768),
  add column embedding_model text,
  add column embedding_hash text,
  add column search_tsv tsvector generated always as
    (to_tsvector('simple', title || ' ' || coalesce(location, ''))) stored;
create index calendar_event_cache_search_idx on public.calendar_event_cache using gin(search_tsv);
create index calendar_event_cache_embedding_idx on public.calendar_event_cache
  using hnsw(embedding extensions.vector_cosine_ops) where embedding is not null;
-- Any changed metadata or cancelled/declined event immediately loses its vector,
-- even if the background indexing budget is exhausted.
create function app.invalidate_calendar_embedding() returns trigger
language plpgsql security invoker set search_path = '' as $$
begin
  if (new.title, new.location, new.start_at, new.end_at, new.status, new.self_response)
     is distinct from (old.title, old.location, old.start_at, old.end_at, old.status, old.self_response)
     or new.status = 'cancelled' or new.self_response = 'declined' then
    new.embedding := null;
    new.embedding_model := null;
    new.embedding_hash := null;
  end if;
  return new;
end;
$$;
revoke all on function app.invalidate_calendar_embedding() from public, anon, authenticated;
grant execute on function app.invalidate_calendar_embedding() to pigeonbox_app;
create trigger calendar_embedding_current before update on public.calendar_event_cache
for each row execute function app.invalidate_calendar_embedding();
