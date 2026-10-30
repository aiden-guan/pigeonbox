-- ---------------------------------------------------------------------------
-- Mailing lists the user unsubscribed from through PigeonBox. One row per
-- sender per connected mailbox. `silence` keeps archiving new mail from the
-- sender on sync, for lists that ignore the unsubscribe or have no
-- List-Unsubscribe header at all. Holds addresses and dates, never mail content.
create table public.mail_unsubscribes (
  id uuid primary key default gen_random_uuid(),
  user_id uuid not null references public.profiles (id) on delete cascade,
  mail_account_id uuid not null references public.mail_accounts (id) on delete cascade,
  sender_email text not null check (length(sender_email) between 3 and 320),
  sender_name text check (length(sender_name) <= 200),
  method text not null check (method in ('one_click', 'link', 'mailto', 'archive_only')),
  status text not null check (status in ('done', 'needs_user', 'failed')),
  silence boolean not null default false,
  archived_count integer not null default 0,
  unsubscribed_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  unique (mail_account_id, sender_email)
);
create index mail_unsubscribes_user_idx on public.mail_unsubscribes (user_id, unsubscribed_at desc);
select app.protect_user_table('public.mail_unsubscribes', false);
