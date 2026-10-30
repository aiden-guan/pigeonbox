-- Derived personal context only. No plaintext fact, excerpt, or model evidence.
-- Match search_documents / recall_chunks: configured embedding dimension is 768.
create table public.personal_memory_state (
  user_id uuid primary key references public.profiles(id) on delete cascade,
  generation uuid not null default gen_random_uuid(),
  learn_after timestamptz,
  hash_key_id text not null,
  hash_iv text not null,
  hash_ciphertext text not null,
  updated_at timestamptz not null default now()
);
select app.protect_user_table('public.personal_memory_state', false);

create table public.personal_memories (
  id uuid primary key default gen_random_uuid(),
  user_id uuid not null references public.profiles(id) on delete cascade,
  kind text not null check (kind in ('episodic','semantic','preference','instruction','decision','goal','relationship_fact')),
  category text not null check (category in ('people','projects','classes','logistics','decisions','preferences','other')),
  text_key_id text not null,
  text_iv text not null,
  text_ciphertext text not null,
  fingerprint text not null check (length(fingerprint) = 64),
  scope_key text not null check (length(scope_key) = 64),
  concept_key text check (length(concept_key) = 64),
  importance real not null check (importance between 0 and 1),
  confidence real not null check (confidence between 0 and 1),
  valid_from timestamptz not null,
  valid_until timestamptz,
  last_confirmed_at timestamptz not null,
  last_accessed_at timestamptz,
  superseded_by uuid,
  status text not null default 'active' check (status in ('active','superseded')),
  corrected boolean not null default false,
  explicit_update boolean not null default false,
  embedding extensions.vector(768),
  embedding_model text,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  unique (id,user_id),
  unique (user_id,fingerprint),
  foreign key (superseded_by,user_id) references public.personal_memories(id,user_id),
  check (valid_until is null or valid_until > valid_from),
  check (superseded_by is null or superseded_by <> id)
);
select app.protect_user_table('public.personal_memories', false);
create index personal_memories_active_idx on public.personal_memories(user_id,category,last_confirmed_at desc) where status = 'active';
create index personal_memories_concept_idx on public.personal_memories(user_id,concept_key) where status = 'active';
create index personal_memories_embedding_idx on public.personal_memories using hnsw(embedding extensions.vector_cosine_ops) where status = 'active';

-- Entity keys are keyed digests, including topics/projects guessed by a model.
-- Human-readable entity labels travel inside the encrypted fact envelope.
create table public.personal_memory_entities (
  memory_id uuid not null,
  user_id uuid not null references public.profiles(id) on delete cascade,
  entity_type text not null check (entity_type in ('contact','company','email','course','project','topic','event','thread')),
  entity_key text not null check (length(entity_key) = 64),
  reliability real not null check (reliability between 0 and 1),
  primary key(memory_id,entity_type,entity_key),
  foreign key(memory_id,user_id) references public.personal_memories(id,user_id) on delete cascade
);
select app.protect_user_table('public.personal_memory_entities', false);
create index personal_memory_entities_lookup_idx on public.personal_memory_entities(user_id,entity_type,entity_key,memory_id);

create table public.personal_memory_sources (
  id uuid primary key default gen_random_uuid(),
  memory_id uuid not null,
  user_id uuid not null references public.profiles(id) on delete cascade,
  mail_account_id uuid not null references public.mail_accounts(id) on delete cascade,
  thread_id uuid not null references public.threads(id) on delete cascade,
  gmail_message_id text not null check (length(gmail_message_id) between 1 and 64),
  source_at timestamptz not null,
  source_version text not null check (length(source_version) between 1 and 128),
  foreign key(memory_id,user_id) references public.personal_memories(id,user_id) on delete cascade,
  foreign key(mail_account_id,gmail_message_id) references public.message_metadata(mail_account_id,gmail_message_id) on delete cascade,
  unique(memory_id,mail_account_id,gmail_message_id)
);
select app.protect_user_table('public.personal_memory_sources', false);
create index personal_memory_sources_account_idx on public.personal_memory_sources(user_id,mail_account_id);
create index personal_memory_sources_thread_idx on public.personal_memory_sources(thread_id);

-- An FK alone does not enforce tenant ownership of account/thread pointers.
-- Invoker trigger checks ownership and message attribution inside the app's RLS scope.
create function app.check_memory_source_owner() returns trigger
language plpgsql security invoker set search_path = '' as $$
begin
  if not exists (select 1 from public.threads t join public.mail_accounts a on a.id = t.mail_account_id
                 join public.message_metadata m on m.thread_id = t.id
                 where t.id = new.thread_id and t.user_id = new.user_id
                   and a.id = new.mail_account_id and a.user_id = new.user_id
                   and m.user_id = new.user_id and m.gmail_message_id = new.gmail_message_id) then
    raise exception 'memory_source_owner_mismatch';
  end if;
  return new;
end $$;
revoke all on function app.check_memory_source_owner() from public,anon,authenticated;
create trigger personal_memory_sources_owner before insert or update on public.personal_memory_sources
for each row execute function app.check_memory_source_owner();

-- Content-free forget tombstones prevent resync/retries from relearning a fact.
create table public.personal_memory_blocks (
  user_id uuid not null references public.profiles(id) on delete cascade,
  fingerprint text not null check (length(fingerprint) = 64),
  created_at timestamptz not null default now(),
  primary key(user_id,fingerprint)
);
select app.protect_user_table('public.personal_memory_blocks', false);

-- Forgetting a fact also hides its historical summary/excerpts from automatic
-- context. Explicitly opening that Gmail thread still provides working context.
create table public.personal_memory_exclusions (
  user_id uuid not null references public.profiles(id) on delete cascade,
  thread_id uuid not null references public.threads(id) on delete cascade,
  created_at timestamptz not null default now(),
  primary key(user_id,thread_id)
);
select app.protect_user_table('public.personal_memory_exclusions', false);

-- Content-free extraction checkpoints make completed job replay cheap.
create table public.personal_memory_extractions (
  user_id uuid not null references public.profiles(id) on delete cascade,
  thread_id uuid not null references public.threads(id) on delete cascade,
  generation uuid not null,
  content_version text not null,
  completed_at timestamptz not null default now(),
  primary key(user_id,thread_id,generation,content_version)
);
select app.protect_user_table('public.personal_memory_extractions', false);

-- Gmail deletion/disconnect can cascade source rows without going through an API.
-- A derived fact with no remaining provenance must not stay active.
create function app.remove_orphan_memory() returns trigger
language plpgsql security invoker set search_path = '' as $$
begin
  if exists(select 1 from public.personal_memories m where m.id = old.memory_id and not m.corrected)
     and not exists(select 1 from public.personal_memory_sources s where s.memory_id = old.memory_id) then
    update public.personal_memories set superseded_by = null where superseded_by = old.memory_id and user_id = old.user_id;
    delete from public.personal_memories where id = old.memory_id and user_id = old.user_id and not corrected;
  end if;
  return old;
end $$;
revoke all on function app.remove_orphan_memory() from public,anon,authenticated;
create trigger personal_memory_source_removed after delete on public.personal_memory_sources for each row execute function app.remove_orphan_memory();
