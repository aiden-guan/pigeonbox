-- PigeonBox is self-hosted: there are no plans, payments or launch waitlist.
-- Every account on the server's ALLOWED_EMAILS list gets everything the server
-- is configured to serve (packages/server/src/entitlements.ts).
drop function if exists public.apply_subscription(uuid, text, text, text, text, timestamptz, boolean, bigint);
drop function if exists public.begin_stripe_event(text, text);
drop table if exists public.subscriptions;
drop table if exists public.billing_customers;
drop table if exists public.stripe_events;
drop table if exists public.cloud_waitlist;
