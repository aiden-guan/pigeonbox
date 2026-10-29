-- ---------------------------------------------------------------------------
-- The PigeonBox extension's settings, saved to the account from the dashboard
-- so a reinstall (which clears the extension's storage) can restore them.
-- Holds setting values and agent rule lines only. Secrets (AI provider keys,
-- tracker tokens) are never sent here; the API rejects them.
create table public.extension_settings_backups (
  user_id uuid primary key references public.profiles (id) on delete cascade,
  settings jsonb not null default '{}'::jsonb check (jsonb_typeof(settings) = 'object'),
  rules jsonb check (rules is null or jsonb_typeof(rules) = 'array'),
  updated_at timestamptz not null default now()
);
select app.protect_user_table('public.extension_settings_backups', false);
