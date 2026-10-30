-- Thumbs up/down on Ask Pigeon answers. The question and the user's note are
-- encrypted like notes; the answer itself is not stored. `request_id` matches
-- the "ask pigeon answered" log line for rounds, tools and latency.
create table public.ask_feedback (
  id uuid primary key default gen_random_uuid(),
  user_id uuid not null references public.profiles (id) on delete cascade,
  request_id text not null check (length(request_id) between 1 and 128),
  rating text not null check (rating in ('up', 'down')),
  question_key_id text,
  question_iv text,
  question_ciphertext text,
  note_key_id text,
  note_iv text,
  note_ciphertext text,
  created_at timestamptz not null default now(),
  unique (user_id, request_id)
);
create index ask_feedback_created_idx on public.ask_feedback (created_at desc);
select app.protect_user_table('public.ask_feedback', false);
