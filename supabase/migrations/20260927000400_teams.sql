-- PigeonBox Cloud intelligence layer, part 5: workspaces and collaboration.
--
-- A shared thread is a permissioned PigeonBox record keyed to the owner's
-- Gmail thread. The Gmail thread is never copied into a teammate's mailbox;
-- the owner chooses which fields (subject, participants, summary, state,
-- commitments) the workspace can see. Every team table has RLS for both the
-- server role and signed-in clients; UI hiding is never the control.

create table public.workspaces (
  id uuid primary key default gen_random_uuid(),
  name text not null check (length(name) between 1 and 120),
  created_by uuid references public.profiles (id) on delete set null,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

create table public.workspace_members (
  workspace_id uuid not null references public.workspaces (id) on delete cascade,
  user_id uuid not null references public.profiles (id) on delete cascade,
  role text not null check (role in ('owner', 'admin', 'member')),
  display_name text not null default '',
  joined_at timestamptz not null default now(),
  primary key (workspace_id, user_id)
);
create index workspace_members_user_idx on public.workspace_members (user_id);

create table public.workspace_invitations (
  id uuid primary key default gen_random_uuid(),
  workspace_id uuid not null references public.workspaces (id) on delete cascade,
  email_normalized text not null,
  role text not null default 'member' check (role in ('admin', 'member')),
  token_hash text not null unique,
  invited_by uuid references public.profiles (id) on delete set null,
  expires_at timestamptz not null,
  accepted_at timestamptz,
  revoked_at timestamptz,
  created_at timestamptz not null default now()
);

-- Membership checks. Security definer so policies on workspace_members itself do not recurse.
create function app.acting_user() returns uuid
language sql stable as $$ select coalesce(app.current_user_id(), auth.uid()) $$;

create function app.is_member(p_workspace uuid) returns boolean
language sql stable security definer set search_path = '' as $$
  select exists (select 1 from public.workspace_members m where m.workspace_id = p_workspace and m.user_id = app.acting_user())
$$;

create function app.is_admin(p_workspace uuid) returns boolean
language sql stable security definer set search_path = '' as $$
  select exists (select 1 from public.workspace_members m where m.workspace_id = p_workspace and m.user_id = app.acting_user() and m.role in ('owner', 'admin'))
$$;

create function app.shares_workspace(p_user uuid) returns boolean
language sql stable security definer set search_path = '' as $$
  select exists (
    select 1 from public.workspace_members a join public.workspace_members b on a.workspace_id = b.workspace_id
     where a.user_id = app.acting_user() and b.user_id = p_user)
$$;

revoke all on function app.acting_user(), app.is_member(uuid), app.is_admin(uuid), app.shares_workspace(uuid) from public, anon;
grant execute on function app.acting_user(), app.is_member(uuid), app.is_admin(uuid), app.shares_workspace(uuid) to pigeonbox_app, authenticated;
grant usage on schema app to authenticated;

-- Teammates can see each other's profile (email) and nothing else about each other.
create policy "app: teammate profiles" on public.profiles for select to pigeonbox_app using (app.shares_workspace(id));
create policy "client: teammate profiles" on public.profiles for select to authenticated using (app.shares_workspace(id));

create table public.shared_threads (
  id uuid primary key default gen_random_uuid(),
  workspace_id uuid not null references public.workspaces (id) on delete cascade,
  owner_id uuid not null references public.profiles (id) on delete cascade,
  mail_account_id uuid not null references public.mail_accounts (id) on delete cascade,
  gmail_thread_id text not null,
  fields text[] not null check (fields <@ array['subject', 'participants', 'summary', 'state', 'commitments']::text[]),
  subject text,
  participants text[],
  summary_key_id text,
  summary_iv text,
  summary_ciphertext text,
  state text,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  unique (workspace_id, mail_account_id, gmail_thread_id)
);
create index shared_threads_account_thread_idx on public.shared_threads (mail_account_id, gmail_thread_id);

create table public.assignments (
  id uuid primary key default gen_random_uuid(),
  workspace_id uuid not null references public.workspaces (id) on delete cascade,
  shared_thread_id uuid not null references public.shared_threads (id) on delete cascade,
  assignee_id uuid not null references public.profiles (id) on delete cascade,
  assigned_by uuid references public.profiles (id) on delete set null,
  status text not null default 'open' check (status in ('open', 'done')),
  note text,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);
create unique index assignments_open_idx on public.assignments (shared_thread_id) where status = 'open';
create index assignments_assignee_idx on public.assignments (assignee_id, status);

create table public.comments (
  id uuid primary key default gen_random_uuid(),
  workspace_id uuid not null references public.workspaces (id) on delete cascade,
  shared_thread_id uuid not null references public.shared_threads (id) on delete cascade,
  author_id uuid not null references public.profiles (id) on delete cascade,
  body_key_id text not null,
  body_iv text not null,
  body_ciphertext text not null,
  created_at timestamptz not null default now(),
  edited_at timestamptz
);
create index comments_thread_idx on public.comments (shared_thread_id, created_at);

create table public.mentions (
  id uuid primary key default gen_random_uuid(),
  workspace_id uuid not null references public.workspaces (id) on delete cascade,
  comment_id uuid not null references public.comments (id) on delete cascade,
  user_id uuid not null references public.profiles (id) on delete cascade,
  created_at timestamptz not null default now(),
  read_at timestamptz,
  unique (comment_id, user_id)
);

create table public.shared_notes (
  id uuid primary key default gen_random_uuid(),
  workspace_id uuid not null references public.workspaces (id) on delete cascade,
  shared_thread_id uuid references public.shared_threads (id) on delete cascade,
  contact_email text,
  author_id uuid not null references public.profiles (id) on delete cascade,
  body_key_id text not null,
  body_iv text not null,
  body_ciphertext text not null,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

create table public.snippets (
  id uuid primary key default gen_random_uuid(),
  user_id uuid not null references public.profiles (id) on delete cascade,
  workspace_id uuid references public.workspaces (id) on delete cascade,
  name text not null check (length(name) between 1 and 120),
  body text not null,
  allowed_sources text[] not null default '{thread,profile}' check (allowed_sources <@ array['thread', 'calendar', 'contact', 'profile']::text[]),
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);
create index snippets_user_idx on public.snippets (user_id);
create index snippets_workspace_idx on public.snippets (workspace_id);

create table public.automation_templates (
  id uuid primary key default gen_random_uuid(),
  workspace_id uuid not null references public.workspaces (id) on delete cascade,
  created_by uuid references public.profiles (id) on delete set null,
  name text not null,
  prompt text not null,
  definition jsonb not null,
  created_at timestamptz not null default now()
);

-- ---------------------------------------------------------------------------
-- Row-level security for team tables (server role and signed-in clients)
-- ---------------------------------------------------------------------------

alter table public.workspaces enable row level security;
alter table public.workspace_members enable row level security;
alter table public.workspace_invitations enable row level security;
alter table public.shared_threads enable row level security;
alter table public.assignments enable row level security;
alter table public.comments enable row level security;
alter table public.mentions enable row level security;
alter table public.shared_notes enable row level security;
alter table public.snippets enable row level security;
alter table public.automation_templates enable row level security;

grant select, insert, update, delete on public.workspaces, public.workspace_members, public.workspace_invitations, public.shared_threads,
  public.assignments, public.comments, public.mentions, public.shared_notes, public.snippets, public.automation_templates to pigeonbox_app;
revoke insert, update, delete, truncate on public.workspaces, public.workspace_members, public.workspace_invitations, public.shared_threads,
  public.assignments, public.comments, public.mentions, public.shared_notes, public.snippets, public.automation_templates from anon, authenticated;
revoke all on public.workspaces, public.workspace_members, public.shared_threads, public.assignments, public.comments,
  public.mentions, public.shared_notes, public.snippets, public.automation_templates from anon;
revoke all on public.workspace_invitations from anon, authenticated;

-- workspaces
create policy "app: member reads workspace" on public.workspaces for select to pigeonbox_app using (app.is_member(id) or created_by = app.current_user_id());
create policy "app: create workspace" on public.workspaces for insert to pigeonbox_app with check (created_by = app.current_user_id());
create policy "app: admin updates workspace" on public.workspaces for update to pigeonbox_app using (app.is_admin(id)) with check (app.is_admin(id));
create policy "app: owner deletes workspace" on public.workspaces for delete to pigeonbox_app
  using (exists (select 1 from public.workspace_members m where m.workspace_id = id and m.user_id = app.current_user_id() and m.role = 'owner'));
create policy "client: member reads workspace" on public.workspaces for select to authenticated using (app.is_member(id));

-- members: admins manage; anyone may leave; the creator adds themselves as owner once.
create policy "app: member reads members" on public.workspace_members for select to pigeonbox_app using (app.is_member(workspace_id));
create policy "app: admin adds members" on public.workspace_members for insert to pigeonbox_app
  with check (app.is_admin(workspace_id)
    or (user_id = app.current_user_id() and role = 'owner'
        and exists (select 1 from public.workspaces w where w.id = workspace_id and w.created_by = app.current_user_id())
        and not exists (select 1 from public.workspace_members m where m.workspace_id = workspace_members.workspace_id)));
create policy "app: admin updates members" on public.workspace_members for update to pigeonbox_app using (app.is_admin(workspace_id)) with check (app.is_admin(workspace_id));
create policy "app: admin removes or member leaves" on public.workspace_members for delete to pigeonbox_app using (app.is_admin(workspace_id) or user_id = app.current_user_id());
create policy "client: member reads members" on public.workspace_members for select to authenticated using (app.is_member(workspace_id));

create policy "app: admin manages invitations" on public.workspace_invitations for all to pigeonbox_app using (app.is_admin(workspace_id)) with check (app.is_admin(workspace_id));

-- shared threads: members read; only the mailbox owner shares (from their own connected account) and unshares.
create policy "app: member reads shares" on public.shared_threads for select to pigeonbox_app using (app.is_member(workspace_id));
create policy "app: owner shares own thread" on public.shared_threads for insert to pigeonbox_app
  with check (owner_id = app.current_user_id() and app.is_member(workspace_id)
    and exists (select 1 from public.mail_accounts a where a.id = mail_account_id and a.user_id = app.current_user_id()));
create policy "app: owner updates share" on public.shared_threads for update to pigeonbox_app using (owner_id = app.current_user_id()) with check (owner_id = app.current_user_id() and app.is_member(workspace_id));
create policy "app: owner or admin unshares" on public.shared_threads for delete to pigeonbox_app using (owner_id = app.current_user_id() or app.is_admin(workspace_id));
create policy "client: member reads shares" on public.shared_threads for select to authenticated using (app.is_member(workspace_id));

-- assignments: members read; members assign to members; assignee, assigner or admin update.
create policy "app: member reads assignments" on public.assignments for select to pigeonbox_app using (app.is_member(workspace_id));
create policy "app: member assigns member" on public.assignments for insert to pigeonbox_app
  with check (app.is_member(workspace_id) and assigned_by = app.current_user_id()
    and exists (select 1 from public.workspace_members m where m.workspace_id = assignments.workspace_id and m.user_id = assignee_id)
    and exists (select 1 from public.shared_threads s where s.id = shared_thread_id and s.workspace_id = assignments.workspace_id));
create policy "app: involved updates assignment" on public.assignments for update to pigeonbox_app
  using (app.is_member(workspace_id) and (assignee_id = app.current_user_id() or assigned_by = app.current_user_id() or app.is_admin(workspace_id)))
  with check (app.is_member(workspace_id));
create policy "app: admin deletes assignment" on public.assignments for delete to pigeonbox_app using (app.is_admin(workspace_id) or assigned_by = app.current_user_id());
create policy "client: member reads assignments" on public.assignments for select to authenticated using (app.is_member(workspace_id));

-- comments: members read and write their own.
create policy "app: member reads comments" on public.comments for select to pigeonbox_app using (app.is_member(workspace_id));
create policy "app: member comments" on public.comments for insert to pigeonbox_app
  with check (author_id = app.current_user_id() and app.is_member(workspace_id)
    and exists (select 1 from public.shared_threads s where s.id = shared_thread_id and s.workspace_id = comments.workspace_id));
create policy "app: author edits comment" on public.comments for update to pigeonbox_app using (author_id = app.current_user_id()) with check (author_id = app.current_user_id() and app.is_member(workspace_id));
create policy "app: author or admin deletes comment" on public.comments for delete to pigeonbox_app using (author_id = app.current_user_id() or app.is_admin(workspace_id));
create policy "client: member reads comments" on public.comments for select to authenticated using (app.is_member(workspace_id));

create policy "app: member reads mentions" on public.mentions for select to pigeonbox_app using (app.is_member(workspace_id));
create policy "app: author mentions member" on public.mentions for insert to pigeonbox_app
  with check (app.is_member(workspace_id) and exists (select 1 from public.workspace_members m where m.workspace_id = mentions.workspace_id and m.user_id = mentions.user_id));
create policy "app: mentioned marks read" on public.mentions for update to pigeonbox_app using (user_id = app.current_user_id()) with check (user_id = app.current_user_id());

create policy "app: member reads notes" on public.shared_notes for select to pigeonbox_app using (app.is_member(workspace_id));
create policy "app: member writes note" on public.shared_notes for insert to pigeonbox_app with check (author_id = app.current_user_id() and app.is_member(workspace_id));
create policy "app: author edits note" on public.shared_notes for update to pigeonbox_app using (author_id = app.current_user_id()) with check (author_id = app.current_user_id() and app.is_member(workspace_id));
create policy "app: author or admin deletes note" on public.shared_notes for delete to pigeonbox_app using (author_id = app.current_user_id() or app.is_admin(workspace_id));

-- snippets: personal ones are private; workspace ones are readable by members and managed by the creator or admins.
create policy "app: read snippets" on public.snippets for select to pigeonbox_app
  using ((workspace_id is null and user_id = app.current_user_id()) or (workspace_id is not null and app.is_member(workspace_id)));
create policy "app: create snippets" on public.snippets for insert to pigeonbox_app
  with check (user_id = app.current_user_id() and (workspace_id is null or app.is_member(workspace_id)));
create policy "app: manage snippets" on public.snippets for update to pigeonbox_app
  using (user_id = app.current_user_id() or (workspace_id is not null and app.is_admin(workspace_id)))
  with check (workspace_id is null and user_id = app.current_user_id() or (workspace_id is not null and app.is_member(workspace_id)));
create policy "app: delete snippets" on public.snippets for delete to pigeonbox_app
  using (user_id = app.current_user_id() or (workspace_id is not null and app.is_admin(workspace_id)));
create policy "client: read snippets" on public.snippets for select to authenticated
  using ((workspace_id is null and user_id = (select auth.uid())) or (workspace_id is not null and app.is_member(workspace_id)));

create policy "app: member reads templates" on public.automation_templates for select to pigeonbox_app using (app.is_member(workspace_id));
create policy "app: admin writes templates" on public.automation_templates for insert to pigeonbox_app with check (app.is_admin(workspace_id) and created_by = app.current_user_id());
create policy "app: admin deletes templates" on public.automation_templates for delete to pigeonbox_app using (app.is_admin(workspace_id));

-- Accept an invitation by token. The token hash is the secret; the invitation must be for the caller's email.
create function app.accept_invitation(p_token_hash text) returns uuid
language plpgsql security definer set search_path = '' as $$
declare
  v_user uuid := app.current_user_id();
  v_email text;
  v_invite record;
begin
  if v_user is null then raise exception 'not signed in' using errcode = 'insufficient_privilege'; end if;
  select lower(email) into v_email from public.profiles where id = v_user;
  select * into v_invite from public.workspace_invitations
   where token_hash = p_token_hash and accepted_at is null and revoked_at is null and expires_at > now() for update;
  if not found then raise exception 'invitation not found' using errcode = 'no_data_found'; end if;
  if v_invite.email_normalized <> v_email then raise exception 'invitation is for another email' using errcode = 'insufficient_privilege'; end if;
  insert into public.workspace_members (workspace_id, user_id, role, display_name)
  values (v_invite.workspace_id, v_user, v_invite.role, '') on conflict (workspace_id, user_id) do nothing;
  update public.workspace_invitations set accepted_at = now() where id = v_invite.id;
  return v_invite.workspace_id;
end;
$$;
revoke all on function app.accept_invitation(text) from public, anon, authenticated;
grant execute on function app.accept_invitation(text) to pigeonbox_app;
