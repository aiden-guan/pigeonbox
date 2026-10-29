-- Reuse the existing owner-scoped developer grants and revocation UI. OAuth
-- grants contain no bearer secret; the JWT is verified before this row is read.
alter table public.mcp_clients drop constraint mcp_clients_kind_check;
alter table public.mcp_clients add constraint mcp_clients_kind_check check (kind in ('api_token', 'oauth'));
alter table public.mcp_clients add column oauth_client_id uuid;
alter table public.mcp_clients add constraint mcp_clients_oauth_shape check ((kind = 'oauth') = (oauth_client_id is not null));
create unique index mcp_clients_oauth_owner_idx on public.mcp_clients (user_id, oauth_client_id) where kind = 'oauth';

-- The canonical audience is configured by the operator before OAuth is enabled.
-- This private table cannot be read or changed through the Data API.
create table app.mcp_oauth_settings (
  singleton boolean primary key default true check (singleton),
  resource text not null check (resource ~ '^https://[^/?#]+/v1/mcp$')
);
alter table app.mcp_oauth_settings enable row level security;
revoke all on app.mcp_oauth_settings from public, anon, authenticated;

-- Supabase owns PKCE, client registration, refresh and token issuance. Install
-- this as its Custom Access Token Hook (or compose into an existing hook).
-- An OAuth token must never inherit the Data API privileges of a user session.
-- `pigeonbox_mcp` deliberately has no Postgres role or authenticator membership;
-- these tokens work only through the Worker, which checks the live scoped grant.
create function public.pigeonbox_mcp_access_token_hook(event jsonb) returns jsonb
language plpgsql stable security invoker set search_path = '' as $$
declare claims jsonb := event -> 'claims'; resource text;
begin
  if nullif(claims ->> 'client_id', '') is not null then
    select s.resource into resource from app.mcp_oauth_settings s where singleton;
    claims := jsonb_set(claims, '{aud}', to_jsonb(coalesce(resource, 'urn:pigeonbox:mcp:unconfigured')));
    claims := jsonb_set(claims, '{role}', '"pigeonbox_mcp"'::jsonb);
  end if;
  return jsonb_build_object('claims', claims);
end $$;
revoke all on function public.pigeonbox_mcp_access_token_hook(jsonb) from public, anon, authenticated;
-- PGlite has no managed Auth role; production Supabase always does.
do $$ begin
  if exists (select 1 from pg_roles where rolname = 'supabase_auth_admin') then
    grant usage on schema app to supabase_auth_admin;
    grant select on app.mcp_oauth_settings to supabase_auth_admin;
    grant execute on function public.pigeonbox_mcp_access_token_hook(jsonb) to supabase_auth_admin;
    create policy mcp_oauth_settings_auth on app.mcp_oauth_settings for select to supabase_auth_admin using (true);
  end if;
end $$;
