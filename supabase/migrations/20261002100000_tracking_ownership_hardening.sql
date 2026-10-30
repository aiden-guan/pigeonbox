-- Hosted tracking hardening.
--
-- 1. Ownership is immutable. The owner trigger already copies user_id from the
--    tracked email on insert and rejects a mismatch. It now also rejects any
--    update that changes tracking_id or user_id, including the conflict branch
--    of an upsert, so a row can never be moved to another account or email.
--    Claim IDs can derive from client idempotency keys; without this an upsert
--    from one account could take over a claim row belonging to another.
-- 2. tracked_emails keeps its owner and ID for life.
-- 3. Owner indexes on the child tables that lacked them, so deleting an account
--    (profiles cascade) does not scan every link and claim.

create or replace function public.tracking_row_owner() returns trigger
language plpgsql security definer set search_path = '' as $$
declare
  v_owner uuid;
begin
  if tg_op = 'UPDATE' and (new.tracking_id is distinct from old.tracking_id or new.user_id is distinct from old.user_id) then
    raise exception 'tracking row owner is immutable' using errcode = 'insufficient_privilege';
  end if;
  select user_id into v_owner from public.tracked_emails where tracking_id = new.tracking_id;
  if v_owner is null then
    raise exception 'unknown tracking id' using errcode = 'foreign_key_violation';
  end if;
  if new.user_id is not null and new.user_id <> v_owner then
    raise exception 'tracking row owner mismatch' using errcode = 'insufficient_privilege';
  end if;
  new.user_id := v_owner;
  return new;
end;
$$;

create function public.tracked_email_identity_immutable() returns trigger
language plpgsql set search_path = '' as $$
begin
  if new.tracking_id is distinct from old.tracking_id or new.user_id is distinct from old.user_id then
    raise exception 'tracked email owner is immutable' using errcode = 'insufficient_privilege';
  end if;
  return new;
end;
$$;
revoke all on function public.tracked_email_identity_immutable() from public, anon, authenticated;

create trigger tracked_emails_identity_immutable before update of tracking_id, user_id on public.tracked_emails
  for each row execute function public.tracked_email_identity_immutable();

create index if not exists tracked_links_user_idx on public.tracked_links (user_id);
create index if not exists tracking_claims_user_idx on public.tracking_self_view_claims (user_id);
