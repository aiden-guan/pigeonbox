-- Bind self-view claims to the authenticated sender's request fingerprint.
alter table public.tracking_self_view_claims
  add column if not exists sender_ip_hash text,
  add column if not exists sender_ua_family text;
