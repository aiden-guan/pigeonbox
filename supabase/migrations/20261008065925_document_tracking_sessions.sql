-- Viewer sessions are issued by the server, scoped to one link, and never
-- readable through the Data API. Event retries reuse IDs within that session.
alter table public.documents add constraint documents_owner_identity unique (id, user_id);
alter table public.document_recipients add constraint document_recipients_owner_identity unique (id, document_id, user_id);
alter table public.document_recipients add constraint document_recipients_document_owner
  foreign key (document_id, user_id) references public.documents (id, user_id) on delete cascade;
alter table public.document_events add constraint document_events_recipient_owner
  foreign key (recipient_id, document_id, user_id) references public.document_recipients (id, document_id, user_id) on delete cascade;

create table public.document_viewer_sessions (
  id uuid primary key,
  user_id uuid not null references public.profiles (id) on delete cascade,
  document_id uuid not null,
  recipient_id uuid not null,
  token_hash text not null,
  event_class text not null check (event_class in ('RECIPIENT_LIKELY', 'SELF_LIKELY', 'MACHINE_LIKELY', 'UNKNOWN')),
  created_at timestamptz not null,
  expires_at timestamptz not null,
  visible_ms bigint not null default 0 check (visible_ms >= 0),
  started boolean not null default false,
  foreign key (recipient_id, document_id, user_id) references public.document_recipients (id, document_id, user_id) on delete cascade
);
create index document_viewer_sessions_user_idx on public.document_viewer_sessions (user_id);
create index document_viewer_sessions_expiry_idx on public.document_viewer_sessions (expires_at);
select app.protect_user_table('public.document_viewer_sessions', false);

-- Even alternate server callers cannot insert two starts or two observations
-- of the same page in a session. Legacy session IDs continue to be readable.
create unique index document_events_session_start_idx on public.document_events (recipient_id, session_id) where kind = 'view_start' and length(session_id) = 36;
create unique index document_events_session_page_idx on public.document_events (recipient_id, session_id, page) where kind = 'page_view' and length(session_id) = 36;
