-- A write-only public endpoint persists through the backend service role.
create table public.cloud_waitlist (
  email text primary key check (email = lower(btrim(email)) and length(email) between 3 and 254),
  source text not null check (source in ('website', 'extension')),
  created_at timestamptz not null default now()
);
alter table public.cloud_waitlist enable row level security;
revoke all on public.cloud_waitlist from public, anon, authenticated, service_role;
grant select, insert on public.cloud_waitlist to service_role;
comment on table public.cloud_waitlist is 'Cloud launch waitlist. No client policies or public reads. Export in Supabase; no automatic email.';
