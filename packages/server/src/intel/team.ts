import type { SharedThread } from '@pigeonbox/api-contract';
import { attempt, iso, isoOrNull, one, type SqlExecutor } from '../db/sql.js';
import { ApiError } from '../http.js';
import { randomToken, sha256Hex, type SecretBox } from '../platform/crypto.js';
import { recordAudit } from './audit.js';
import type { IntelDeps } from './context.js';
import { notify } from './notifications.js';
import { decryptSummary } from './threads.js';

/**
 * Workspaces and collaboration. Authorization lives in RLS (see the teams
 * migration); these functions add the product rules and keep shared content
 * encrypted with a workspace binding so any member can read it and nobody
 * outside can.
 */

type Role = 'owner' | 'admin' | 'member';

export async function listWorkspaces(tx: SqlExecutor) {
  const rows = await tx.query<{ id: string; name: string; role: Role }>(
    `select w.id, w.name, m.role from public.workspaces w join public.workspace_members m on m.workspace_id = w.id and m.user_id = app.current_user_id() order by w.created_at`,
  );
  const out = [];
  for (const row of rows) {
    const members = await tx.query<{ user_id: string; role: Role; display_name: string; email: string | null }>(
      `select m.user_id, m.role, m.display_name, p.email from public.workspace_members m left join public.profiles p on p.id = m.user_id where m.workspace_id = $1::uuid order by m.joined_at`,
      [row.id],
    );
    out.push({
      id: row.id,
      name: row.name.slice(0, 120),
      role: row.role,
      members: members.map((member) => ({ userId: member.user_id, name: (member.display_name || member.email?.split('@')[0] || 'Member').slice(0, 200), email: (member.email ?? '').slice(0, 320), role: member.role })),
    });
  }
  return out;
}

export async function createWorkspace(tx: SqlExecutor, userId: string, name: string, displayName: string) {
  const workspace = await one<{ id: string }>(tx, `insert into public.workspaces (name, created_by) values ($1, $2::uuid) returning id`, [name.trim().slice(0, 120), userId]);
  await tx.query(`insert into public.workspace_members (workspace_id, user_id, role, display_name) values ($1::uuid, $2::uuid, 'owner', $3)`, [workspace!.id, userId, displayName.slice(0, 200)]);
  await recordAudit(tx, { userId, actor: { type: 'user', id: userId, name: 'You' }, action: 'create_workspace', tier: 0, target: { kind: 'workspace', id: workspace!.id, title: name }, summary: `Created workspace "${name}"`, policy: { decision: 'allowed', reason: 'User request' } });
  return workspace!.id;
}

/** An invitation link for one email address. Only its hash is stored; the link is shown once. */
export async function inviteMember(tx: SqlExecutor, userId: string, input: { workspaceId: string; email: string; role: 'admin' | 'member' }, appUrl: string) {
  const token = randomToken(24);
  const hash = await sha256Hex(token);
  const row = await attempt(tx, () =>
    one<{ id: string }>(
      tx,
      `insert into public.workspace_invitations (workspace_id, email_normalized, role, token_hash, invited_by, expires_at)
       values ($1::uuid, lower($2), $3, $4, $5::uuid, now() + interval '14 days') returning id`,
      [input.workspaceId, input.email, input.role, hash, userId],
    ),
  );
  if (!row) throw new ApiError('forbidden', 'Only workspace admins can invite people.');
  return { id: row.id, url: `${appUrl.replace(/\/+$/, '')}/app?invite=${encodeURIComponent(token)}#team` };
}

export async function acceptInvitation(tx: SqlExecutor, token: string): Promise<string> {
  const hash = await sha256Hex(token);
  const row = await attempt(tx, () => one<{ workspace_id: string }>(tx, `select app.accept_invitation($1) as workspace_id`, [hash]));
  if (!row?.workspace_id) throw new ApiError('not_found', 'This invitation is invalid, expired, or for a different email address.');
  return row.workspace_id;
}

export async function updateMember(tx: SqlExecutor, input: { workspaceId: string; userId: string; role?: 'admin' | 'member'; remove?: boolean }): Promise<void> {
  if (input.remove) {
    const rows = await tx.query(`delete from public.workspace_members where workspace_id = $1::uuid and user_id = $2::uuid and role <> 'owner' returning user_id`, [input.workspaceId, input.userId]);
    if (!rows.length) throw new ApiError('forbidden', 'You cannot remove this member.');
    // Their open assignments go back to unassigned.
    await attempt(tx, () =>
      tx.query(`update public.assignments set status = 'done', note = coalesce(note, '') || ' (member removed)' where workspace_id = $1::uuid and assignee_id = $2::uuid and status = 'open'`, [input.workspaceId, input.userId]),
    );
    return;
  }
  const rows = await tx.query(`update public.workspace_members set role = $3 where workspace_id = $1::uuid and user_id = $2::uuid and role <> 'owner' returning user_id`, [input.workspaceId, input.userId, input.role]);
  if (!rows.length) throw new ApiError('forbidden', 'Only admins can change roles.');
}

type ShareRow = {
  id: string;
  workspace_id: string;
  workspace_name: string;
  gmail_thread_id: string;
  owner_id: string;
  owner_name: string | null;
  fields: string[];
  subject: string | null;
  participants: string[] | null;
  summary_key_id: string | null;
  summary_iv: string | null;
  summary_ciphertext: string | null;
  state: string | null;
  created_at: unknown;
};

async function toShared(tx: SqlExecutor, box: SecretBox, row: ShareRow): Promise<SharedThread> {
  let summary: string | null = null;
  if (row.summary_key_id && row.summary_iv && row.summary_ciphertext) {
    summary = await box.open({ keyId: row.summary_key_id, iv: row.summary_iv, ciphertext: row.summary_ciphertext }, { purpose: 'note', userId: row.workspace_id, recordId: `share:${row.id}` }).catch(() => null);
  }
  const assignment = await one<{ id: string; assignee_id: string; assignee_name: string | null; status: 'open' | 'done'; note: string | null; updated_at: unknown }>(
    tx,
    `select a.id, a.assignee_id, coalesce(nullif(m.display_name, ''), split_part(p.email, '@', 1)) as assignee_name, a.status, a.note, a.updated_at
       from public.assignments a left join public.workspace_members m on m.workspace_id = a.workspace_id and m.user_id = a.assignee_id
       left join public.profiles p on p.id = a.assignee_id
      where a.shared_thread_id = $1::uuid order by a.status = 'open' desc, a.updated_at desc limit 1`,
    [row.id],
  );
  const comments = await tx.query<{ id: string; author_id: string; author_name: string | null; body_key_id: string; body_iv: string; body_ciphertext: string; created_at: unknown; edited_at: unknown }>(
    `select c.id, c.author_id, coalesce(nullif(m.display_name, ''), split_part(p.email, '@', 1)) as author_name, c.body_key_id, c.body_iv, c.body_ciphertext, c.created_at, c.edited_at
       from public.comments c left join public.workspace_members m on m.workspace_id = c.workspace_id and m.user_id = c.author_id
       left join public.profiles p on p.id = c.author_id where c.shared_thread_id = $1::uuid order by c.created_at limit 200`,
    [row.id],
  );
  const out: SharedThread['comments'] = [];
  for (const comment of comments) {
    const body = await box.open({ keyId: comment.body_key_id, iv: comment.body_iv, ciphertext: comment.body_ciphertext }, { purpose: 'note', userId: row.workspace_id, recordId: `comment:${comment.id}` }).catch(() => '');
    const mentions = await tx.query<{ user_id: string; name: string | null }>(
      `select mn.user_id, coalesce(nullif(m.display_name, ''), split_part(p.email, '@', 1)) as name from public.mentions mn
         left join public.workspace_members m on m.workspace_id = mn.workspace_id and m.user_id = mn.user_id left join public.profiles p on p.id = mn.user_id where mn.comment_id = $1::uuid`,
      [comment.id],
    );
    out.push({
      id: comment.id,
      author: { userId: comment.author_id, name: (comment.author_name ?? 'Member').slice(0, 200) },
      body: body.slice(0, 5_000),
      mentions: mentions.map((mention) => ({ userId: mention.user_id, name: (mention.name ?? 'Member').slice(0, 200) })),
      createdAt: iso(comment.created_at),
      editedAt: isoOrNull(comment.edited_at),
    });
  }
  return {
    id: row.id,
    workspaceId: row.workspace_id,
    workspaceName: row.workspace_name.slice(0, 120),
    threadId: row.gmail_thread_id,
    sharedBy: { userId: row.owner_id, name: (row.owner_name ?? 'Member').slice(0, 200) },
    fields: row.fields as SharedThread['fields'],
    subject: row.fields.includes('subject') ? row.subject : null,
    participants: row.fields.includes('participants') ? row.participants : null,
    summary: row.fields.includes('summary') ? summary?.slice(0, 400) ?? null : null,
    state: row.fields.includes('state') ? row.state : null,
    assignment: assignment
      ? { id: assignment.id, assignee: { userId: assignment.assignee_id, name: (assignment.assignee_name ?? 'Member').slice(0, 200) }, status: assignment.status, note: assignment.note, updatedAt: iso(assignment.updated_at) }
      : null,
    comments: out,
    sharedAt: iso(row.created_at),
  };
}

const SHARE_SELECT = `select s.id, s.workspace_id, w.name as workspace_name, s.gmail_thread_id, s.owner_id, coalesce(nullif(m.display_name, ''), split_part(p.email, '@', 1)) as owner_name,
  s.fields, s.subject, s.participants, s.summary_key_id, s.summary_iv, s.summary_ciphertext, s.state, s.created_at
  from public.shared_threads s join public.workspaces w on w.id = s.workspace_id
  left join public.workspace_members m on m.workspace_id = s.workspace_id and m.user_id = s.owner_id left join public.profiles p on p.id = s.owner_id`;

export async function sharesForThread(tx: SqlExecutor, box: SecretBox, gmailThreadId: string) {
  const rows = await tx.query<ShareRow>(`${SHARE_SELECT} where s.gmail_thread_id = $1 order by s.created_at`, [gmailThreadId]);
  return Promise.all(rows.map((row) => toShared(tx, box, row)));
}

export async function shareById(tx: SqlExecutor, box: SecretBox, id: string) {
  const row = await one<ShareRow>(tx, `${SHARE_SELECT} where s.id = $1::uuid`, [id]);
  if (!row) throw new ApiError('not_found', 'That shared thread does not exist or you are not a member.');
  return toShared(tx, box, row);
}

/** Threads assigned to the current user across workspaces (for the Focus Queue and web app). */
export async function myAssignments(tx: SqlExecutor, box: SecretBox) {
  const rows = await tx.query<ShareRow>(`${SHARE_SELECT} join public.assignments a on a.shared_thread_id = s.id and a.status = 'open' and a.assignee_id = app.current_user_id() order by a.updated_at desc limit 50`);
  return Promise.all(rows.map((row) => toShared(tx, box, row)));
}

/**
 * Share a thread into a workspace (only the fields the owner chose) and assign
 * it to a member. RLS enforces that the sharer owns the mailbox and both
 * people are members.
 */
export async function assignThread(
  deps: IntelDeps,
  userId: string,
  input: { workspaceId: string; accountId: string; threadRowId: string; assigneeUserId: string; fields: string[]; note?: string },
): Promise<SharedThread> {
  const shared = await deps.db.asUser(userId, async (tx) => {
    const thread = await one<{ gmail_thread_id: string; subject: string; participants: Array<{ email: string }>; id: string; summary_key_id: string | null; summary_iv: string | null; summary_ciphertext: string | null; state: string | null }>(
      tx,
      `select t.id, t.gmail_thread_id, t.subject, t.participants, s.summary_key_id, s.summary_iv, s.summary_ciphertext, coalesce(s.user_state, s.state) as state
         from public.threads t left join public.thread_states s on s.thread_id = t.id where t.id = $1::uuid`,
      [input.threadRowId],
    );
    if (!thread) throw new ApiError('not_found', 'That thread is not synced.');
    const fields = [...new Set(input.fields)];
    const summary = fields.includes('summary') ? (await decryptSummary(deps.box, userId, thread))?.oneLine ?? null : null;
    const existing = await one<{ id: string }>(tx, `select id from public.shared_threads where workspace_id = $1::uuid and mail_account_id = $2::uuid and gmail_thread_id = $3`, [input.workspaceId, input.accountId, thread.gmail_thread_id]);
    const shareId = existing?.id ?? crypto.randomUUID();
    const sealed = summary ? await deps.box.seal(summary, { purpose: 'note', userId: input.workspaceId, recordId: `share:${shareId}` }) : null;
    const saved = await attempt(tx, async () => {
      await tx.query(
        `insert into public.shared_threads (id, workspace_id, owner_id, mail_account_id, gmail_thread_id, fields, subject, participants, summary_key_id, summary_iv, summary_ciphertext, state)
         values ($1::uuid, $2::uuid, $3::uuid, $4::uuid, $5, $6::text[], $7, $8::text[], $9, $10, $11, $12)
         on conflict (workspace_id, mail_account_id, gmail_thread_id) do update set fields = excluded.fields, subject = excluded.subject, participants = excluded.participants,
           summary_key_id = excluded.summary_key_id, summary_iv = excluded.summary_iv, summary_ciphertext = excluded.summary_ciphertext, state = excluded.state, updated_at = now()`,
        [
          shareId,
          input.workspaceId,
          userId,
          input.accountId,
          thread.gmail_thread_id,
          fields,
          fields.includes('subject') ? thread.subject.slice(0, 998) : null,
          fields.includes('participants') ? (thread.participants ?? []).map((person) => person.email).slice(0, 50) : null,
          sealed?.keyId ?? null,
          sealed?.iv ?? null,
          sealed?.ciphertext ?? null,
          fields.includes('state') ? thread.state : null,
        ],
      );
      await tx.query(`update public.assignments set status = 'done', updated_at = now() where shared_thread_id = $1::uuid and status = 'open'`, [shareId]);
      await tx.query(
        `insert into public.assignments (workspace_id, shared_thread_id, assignee_id, assigned_by, note) values ($1::uuid, $2::uuid, $3::uuid, $4::uuid, $5)`,
        [input.workspaceId, shareId, input.assigneeUserId, userId, input.note?.slice(0, 500) ?? null],
      );
      return true;
    });
    if (!saved) throw new ApiError('forbidden', 'You can only assign your own threads to members of your workspace.');
    await recordAudit(tx, {
      userId,
      actor: { type: 'user', id: userId, name: 'You' },
      action: 'assign_thread',
      tier: 0,
      target: { kind: 'thread', id: thread.gmail_thread_id, title: thread.subject },
      summary: `Shared ${fields.join(', ')} with a workspace and assigned it`,
      policy: { decision: 'allowed', reason: 'Workspace membership checked' },
    });
    return shareById(tx, deps.box, shareId);
  });
  if (input.assigneeUserId !== userId) {
    // The assignee's notification is written outside the sharer's RLS scope, after membership was verified above.
    await deps.db.system((tx) =>
      notify(tx, {
        userId: input.assigneeUserId,
        kind: 'assignment',
        title: `Assigned to you: ${shared.subject ?? 'a shared thread'}`.slice(0, 200),
        body: `${shared.sharedBy.name} assigned this in ${shared.workspaceName}.${input.note ? ` Note: ${input.note}` : ''}`.slice(0, 500),
        refId: shared.id,
        dedupeKey: `assignment:${shared.assignment?.id}`,
      }),
    );
  }
  return shared;
}

export async function updateAssignment(deps: IntelDeps, userId: string, assignmentId: string, status: 'open' | 'done'): Promise<SharedThread> {
  return deps.db.asUser(userId, async (tx) => {
    const rows = await tx.query<{ shared_thread_id: string }>(`update public.assignments set status = $2, updated_at = now() where id = $1::uuid returning shared_thread_id`, [assignmentId, status]);
    if (!rows.length) throw new ApiError('forbidden', 'Only the assignee, the person who assigned it, or an admin can change this.');
    return shareById(tx, deps.box, rows[0]!.shared_thread_id);
  });
}

export async function addComment(deps: IntelDeps, userId: string, input: { shareId: string; body: string; mentions: string[] }): Promise<SharedThread> {
  const result = await deps.db.asUser(userId, async (tx) => {
    const share = await one<{ workspace_id: string; subject: string | null }>(tx, `select workspace_id, subject from public.shared_threads where id = $1::uuid`, [input.shareId]);
    if (!share) throw new ApiError('not_found', 'That shared thread does not exist or you are not a member.');
    const id = crypto.randomUUID();
    const sealed = await deps.box.seal(input.body, { purpose: 'note', userId: share.workspace_id, recordId: `comment:${id}` });
    await tx.query(
      `insert into public.comments (id, workspace_id, shared_thread_id, author_id, body_key_id, body_iv, body_ciphertext) values ($1::uuid, $2::uuid, $3::uuid, $4::uuid, $5, $6, $7)`,
      [id, share.workspace_id, input.shareId, userId, sealed.keyId, sealed.iv, sealed.ciphertext],
    );
    const mentioned: string[] = [];
    for (const mention of [...new Set(input.mentions)].slice(0, 20)) {
      const inserted = await attempt(tx, () => tx.query(`insert into public.mentions (workspace_id, comment_id, user_id) values ($1::uuid, $2::uuid, $3::uuid) on conflict do nothing returning user_id`, [share.workspace_id, id, mention]));
      if (inserted?.length && mention !== userId) mentioned.push(mention);
    }
    return { share: await shareById(tx, deps.box, input.shareId), mentioned, commentId: id };
  });
  for (const mention of result.mentioned) {
    await deps.db.system((tx) =>
      notify(tx, { userId: mention, kind: 'mention', title: `Mentioned in ${result.share.workspaceName}`, body: (result.share.subject ?? 'A shared thread').slice(0, 500), refId: result.share.id, dedupeKey: `mention:${result.commentId}:${mention}` }),
    );
  }
  return result.share;
}
