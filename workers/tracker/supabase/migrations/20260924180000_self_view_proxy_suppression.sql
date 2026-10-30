-- One-shot sender proxy suppression, separate from the browser fingerprint claim.
alter table public.tracking_self_view_claims
  add column if not exists proxy_consumed_by_event_id text,
  add column if not exists proxy_consumed_at timestamptz;

create index if not exists tracking_self_view_claims_proxy_consumed_at_idx
  on public.tracking_self_view_claims(tracking_id, proxy_consumed_at);
