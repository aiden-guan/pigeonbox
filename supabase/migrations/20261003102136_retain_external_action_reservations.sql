-- Gmail sends and Calendar invitations can succeed before their response or
-- audit is persisted. A retry must retain its reservation even if the queue
-- resumes after the ordinary 30-day write-response retention window.
-- These receipts contain only keys and safe status metadata; owner deletion
-- still removes them through idempotency_keys.user_id ON DELETE CASCADE.
create or replace function app.sweep_retention() returns integer
language plpgsql security definer set search_path = '' as $$
declare n integer := 0; m integer;
begin
  delete from public.recall_chunks where expires_at < now();
  get diagnostics m = row_count; n := n + m;
  delete from public.notifications where created_at < now() - interval '90 days';
  get diagnostics m = row_count; n := n + m;
  delete from public.idempotency_keys
   where scope <> 'external_action' and created_at < now() - interval '30 days';
  get diagnostics m = row_count; n := n + m;
  delete from public.rate_limit_windows where window_start < now() - interval '1 day';
  get diagnostics m = row_count; n := n + m;
  return n;
end;
$$;
revoke all on function app.sweep_retention() from public, anon, authenticated;
