import type { SharedThread } from '@pigeonbox/api-contract';
import { describe, expect, it } from 'vitest';
import { connectedUser, createIntelHarness, deliverAndSync, type IntelHarness } from '../testing/intel-harness.js';

const ALICE = 'alice@team.test';
const BOB = 'bob@team.test';
const CAROL = 'carol@other.test';

async function member(h: IntelHarness, email: string) {
  const session = await h.signIn(email);
  return { token: session.accessToken, userId: session.user.id };
}

/** Alice owns "Sales" with Bob as a member; Carol has her own workspace. */
async function setup() {
  const h = await createIntelHarness();
  const alice = await connectedUser(h, ALICE);
  const bob = await member(h, BOB);
  const carol = await member(h, CAROL);
  const { id: workspaceId } = await h.route<{ id: string }>('controlWorkspaceCreate', alice.token, { name: 'Sales' });
  const invite = await h.route<{ url: string }>('controlWorkspaceInvite', alice.token, { workspaceId, email: BOB });
  const token = new URL(invite.url).searchParams.get('invite')!;
  // An invitation link only works for the address it was sent to.
  await expect(h.route('controlWorkspaceAccept', carol.token, { token })).rejects.toMatchObject({ code: 'not_found' });
  await h.route('controlWorkspaceAccept', bob.token, { token });
  await h.route('controlWorkspaceCreate', carol.token, { name: 'Other team' });
  const { threadId } = await deliverAndSync(h, ALICE, { from: 'buyer@customer.test', fromName: 'Pat Buyer', to: [ALICE], subject: 'Renewal pricing', body: 'Can you confirm the renewal price for next year?' });
  const { share } = await h.route<{ share: SharedThread }>('assign', alice.token, { workspaceId, threadId, assigneeUserId: bob.userId, fields: ['subject', 'summary'], note: 'Can you take this?' });
  return { h, alice, bob, carol, workspaceId, threadId, share };
}

async function asAuthenticated<T>(h: IntelHarness, userId: string, sql: string): Promise<T[]> {
  return h.pg.transaction(async (tx) => {
    await tx.query(`set local role authenticated`);
    await tx.query(`select set_config('request.jwt.claim.sub', $1, true)`, [userId]);
    return (await tx.query<T>(sql)).rows;
  });
}

describe('Teams', () => {
  it('shares only the fields the sharer chose, never the Gmail thread', async () => {
    const { h, bob, share } = await setup();
    expect(share).toMatchObject({ subject: 'Renewal pricing', participants: null, state: null, fields: ['subject', 'summary'] });
    expect(share.assignment).toMatchObject({ assignee: { userId: bob.userId }, status: 'open', note: 'Can you take this?' });
    const assigned = await h.route<{ shares: SharedThread[] }>('controlAssigned', bob.token);
    expect(assigned.shares.map((item) => item.id)).toEqual([share.id]);
    // Bob has no Gmail connection and nothing from Alice's mailbox was copied to him.
    expect(await h.sql(`select 1 from public.threads where user_id = $1::uuid`, [bob.userId])).toHaveLength(0);
    const notes = await h.route<{ notifications: Array<{ kind: string; title: string }> }>('notifications', bob.token, {});
    expect(notes.notifications.some((item) => item.kind === 'assignment')).toBe(true);
  });

  it('keeps other workspaces out, through the API and through direct database access', async () => {
    const { h, bob, carol, share } = await setup();
    await expect(h.route('controlShare', carol.token, { shareId: share.id })).rejects.toMatchObject({ code: 'not_found' });
    await expect(h.route('commentAdd', carol.token, { shareId: share.id, body: 'hi' })).rejects.toMatchObject({ code: 'not_found' });
    // Same answer whether or not the assignment exists, so its existence does not leak.
    await expect(h.route('assignmentUpdate', carol.token, { assignmentId: share.assignment!.id, status: 'done' })).rejects.toMatchObject({ code: 'forbidden' });
    await expect(h.route('assignmentUpdate', carol.token, { assignmentId: crypto.randomUUID(), status: 'done' })).rejects.toMatchObject({ code: 'forbidden' });
    expect((await h.route<{ shares: SharedThread[] }>('controlAssigned', carol.token)).shares).toHaveLength(0);

    // The same holds for a browser session talking to Supabase directly (anon key + user JWT).
    for (const table of ['shared_threads', 'assignments', 'comments', 'threads', 'thread_states', 'encrypted_credentials', 'drafts']) {
      const rows = await asAuthenticated<{ n: number }>(h, carol.userId, `select count(*)::int as n from public.${table}`).catch(() => [{ n: 0 }]);
      expect(rows[0]!.n, table).toBe(0);
    }
    const memberships = await asAuthenticated<{ user_id: string }>(h, carol.userId, `select user_id from public.workspace_members`);
    expect(memberships.map((row) => row.user_id)).toEqual([carol.userId]);
    const visible = await asAuthenticated<{ id: string }>(h, bob.userId, `select id from public.shared_threads`);
    expect(visible.map((row) => row.id)).toEqual([share.id]);
    // Encrypted credentials are never readable from the browser, even by their owner.
    await expect(asAuthenticated(h, bob.userId, `select * from public.encrypted_credentials`)).rejects.toThrow();
  });

  it('lets members comment and mention teammates, and the assignee close the assignment', async () => {
    const { h, alice, bob, carol, share } = await setup();
    const withComment = await h.route<{ share: SharedThread }>('commentAdd', bob.token, { shareId: share.id, body: 'On it. @Alice do we have the old quote?', mentions: [alice.userId, carol.userId] });
    const comment = withComment.share.comments[0]!;
    expect(comment.author.userId).toBe(bob.userId);
    // Only workspace members can be mentioned.
    expect(comment.mentions.map((item) => item.userId)).toEqual([alice.userId]);
    const [stored] = await h.sql<{ body_ciphertext: string }>(`select body_ciphertext from public.comments`);
    expect(stored!.body_ciphertext).not.toContain('old quote');

    const done = await h.route<{ share: SharedThread }>('assignmentUpdate', bob.token, { assignmentId: share.assignment!.id, status: 'done' });
    expect(done.share.assignment!.status).toBe('done');
    const seen = await h.route<{ share: SharedThread }>('controlShare', alice.token, { shareId: share.id });
    expect(seen.share.assignment!.status).toBe('done');
    expect(seen.share.comments.map((item) => item.body)).toEqual(['On it. @Alice do we have the old quote?']);
  });

  it('removes access the moment a member is removed, and only admins can manage members', async () => {
    const { h, alice, bob, workspaceId, share } = await setup();
    await expect(h.route('controlWorkspaceInvite', bob.token, { workspaceId, email: 'dan@team.test' })).rejects.toMatchObject({ code: 'forbidden' });
    await expect(h.route('controlMemberUpdate', bob.token, { workspaceId, userId: alice.userId, remove: true })).rejects.toMatchObject({ code: 'forbidden' });
    await h.route('controlMemberUpdate', alice.token, { workspaceId, userId: bob.userId, remove: true });
    expect((await h.route<{ shares: SharedThread[] }>('controlAssigned', bob.token)).shares).toHaveLength(0);
    await expect(h.route('controlShare', bob.token, { shareId: share.id })).rejects.toMatchObject({ code: 'not_found' });
    await expect(h.route('commentAdd', bob.token, { shareId: share.id, body: 'still here?' })).rejects.toMatchObject({ code: 'not_found' });
    expect(await asAuthenticated(h, bob.userId, `select id from public.shared_threads`)).toHaveLength(0);
  });

  it('cannot assign to someone outside the workspace', async () => {
    const { h, alice, carol, workspaceId, threadId } = await setup();
    await expect(h.route('assign', alice.token, { workspaceId, threadId, assigneeUserId: carol.userId, fields: ['subject'] })).rejects.toMatchObject({ code: 'forbidden' });
  });
});
