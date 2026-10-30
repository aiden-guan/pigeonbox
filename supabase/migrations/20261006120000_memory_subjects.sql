-- Memory pages. Every fact belongs to one subject: the owner (`self`, shared by
-- all their inboxes), one correspondent, or one topic. `scope_key` becomes the
-- keyed subject digest for new facts; facts written before this migration keep
-- their per-recipient scope with a null subject_type until the consolidation
-- job merges them into pages.
alter table public.personal_memories add column subject_type text check (subject_type in ('self','person','topic'));
create index personal_memories_subject_idx on public.personal_memories(user_id,scope_key,last_confirmed_at desc) where status = 'active';
create index personal_memories_unsorted_idx on public.personal_memories(user_id) where subject_type is null;

-- Labels and synthesized summaries are encrypted; the key is the same digest as
-- personal_memories.scope_key so pages join without decrypting.
create table public.personal_memory_subjects (
  user_id uuid not null references public.profiles(id) on delete cascade,
  subject_key text not null check (length(subject_key) = 64),
  subject_type text not null check (subject_type in ('self','person','topic')),
  content_key_id text not null,
  content_iv text not null,
  content_ciphertext text not null,
  -- Set when a page gains or changes facts; the consolidation job clears it.
  dirty boolean not null default true,
  summarized_at timestamptz,
  -- The facts a summary was written from. A summary is shown or used only while
  -- every one of them is still active, so forgetting, correcting, disconnecting
  -- or Gmail deletion can never leave a removed fact inside a summary.
  summary_memory_ids uuid[] not null default '{}',
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  primary key(user_id,subject_key)
);
select app.protect_user_table('public.personal_memory_subjects', false);
create index personal_memory_subjects_dirty_idx on public.personal_memory_subjects(user_id) where dirty;
