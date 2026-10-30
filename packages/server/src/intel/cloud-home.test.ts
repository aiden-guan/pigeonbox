import type { CloudDraft, CloudOverview, DraftListResponse, FocusItem, MailAccount } from '@pigeonbox/api-contract';
import { describe, expect, it } from 'vitest';
import { connectedUser, createIntelHarness, deliverAndSync, type IntelHarness } from '../testing/intel-harness.js';

/**
 * The Cloud Home contract: mail freshness separate from AI review, a global
 * list of prepared drafts, and current work separate from "while you were away".
 */

const ADA = 'ada@work.test';
const BOB = 'bob@work.test';

async function accounts(h: IntelHarness, token: string): Promise<MailAccount[]> {
  return (await h.route<{ accounts: MailAccount[] }>('connections', token)).accounts;
}

/** Two versions of one thread are one conversation being reviewed. */
async function queueAnalysis(h: IntelHarness, userId: string, accountId: string, threadIds: string[]) {
  for (const [index, threadId] of threadIds.entries()) {
    await h.sql(
      `insert into public.jobs (kind, user_id, mail_account_id, idempotency_key, payload, run_at)
       values ('thread.analyze', $1::uuid, $2::uuid, $3, jsonb_build_object('threadId', $4::text), now() + interval '1 day')`,
      [userId, accountId, `test-analyze:${index}`, threadId],
    );
  }
}

async function actionable(h: IntelHarness, owner: string, subject: string) {
  return deliverAndSync(h, owner, { from: 'maya@client.test', fromName: 'Maya Chen', to: [owner], subject, body: `Hi,\n\nCould you send the ${subject.toLowerCase()} before Friday?\n\nThanks,\nMaya` });
}

async function list(h: IntelHarness, token: string, body: Record<string, unknown> = {}) {
  return h.route<DraftListResponse>('draftList', token, body);
}

describe('mail sync phase', () => {
  it('stays up to date while only AI analysis is queued, and counts conversations not jobs', async () => {
    const h = await createIntelHarness();
    const ada = await connectedUser(h, ADA, ['mail_read']);
    const [idle] = await accounts(h, ada.token);
    expect(idle!.sync).toMatchObject({ state: 'healthy', syncBacklog: 0, processingBacklog: 0, phase: 'up_to_date' });

    await queueAnalysis(h, ada.userId, ada.accountId, ['t1', 't2', 't2']);
    const [busy] = await accounts(h, ada.token);
    expect(busy!.sync.backlog).toBe(3);
    expect(busy!.sync.syncBacklog).toBe(0);
    expect(busy!.sync.processingBacklog).toBe(2);
    expect(busy!.sync.phase).toBe('analyzing');
  });

  it('shows catching up only for real Gmail sync work', async () => {
    const h = await createIntelHarness();
    const ada = await connectedUser(h, ADA, ['mail_read']);
    h.google.deliver(ADA, { from: 'maya@client.test', to: [ADA], subject: 'New', body: 'Hello' });
    await h.push(ADA);
    const [pending] = await accounts(h, ada.token);
    expect(pending!.sync.syncBacklog).toBeGreaterThan(0);
    expect(pending!.sync.phase).toBe('catching_up');
    await h.drain();
    expect((await accounts(h, ada.token))[0]!.sync.phase).toBe('up_to_date');
  });

  it('reports importing, degraded, stalled and paused', async () => {
    const h = await createIntelHarness();
    const ada = await connectedUser(h, ADA, ['mail_read']);
    await h.sql(`update public.gmail_sync_state set state = 'initializing', coverage_since = null`);
    expect((await accounts(h, ada.token))[0]!.sync.phase).toBe('importing');
    await h.sql(`update public.gmail_sync_state set state = 'degraded'`);
    expect((await accounts(h, ada.token))[0]!.sync.phase).toBe('degraded');
    await h.sql(`update public.gmail_sync_state set state = 'stalled'`);
    expect((await accounts(h, ada.token))[0]!.sync.phase).toBe('stalled');
    await h.sql(`update public.gmail_sync_state set state = 'healthy'`);
    await h.route('connectionUpdate', ada.token, { accountId: ada.accountId, paused: true });
    expect((await accounts(h, ada.token))[0]!.sync.phase).toBe('paused');
    await h.sql(`update public.mail_accounts set status = 'needs_reauth'`);
    expect((await accounts(h, ada.token))[0]!.sync.phase).toBe('needs_reauth');
  });
});

describe('draft list', () => {
  it('lists only the signed-in user’s drafts with thread metadata and no extra calls', async () => {
    const h = await createIntelHarness();
    const ada = await connectedUser(h, ADA, ['mail_read', 'drafts']);
    const bob = await connectedUser(h, BOB, ['mail_read', 'drafts']);
    const { threadId } = await actionable(h, ADA, 'Slides');
    await actionable(h, BOB, 'Private budget');

    const mine = await list(h, ada.token);
    expect(mine.drafts).toHaveLength(1);
    expect(mine.counts.ready).toBe(1);
    const [item] = mine.drafts;
    expect(item).toMatchObject({ subject: 'Slides', person: { email: 'maya@client.test', name: 'Maya Chen' } });
    expect(item!.draft).toMatchObject({ threadId, accountId: ada.accountId, status: 'ready', kind: 'reply' });
    expect(item!.draft.variants[0]!.body.length).toBeGreaterThan(0);
    expect(JSON.stringify(mine)).not.toContain('Private budget');
    expect((await list(h, bob.token)).drafts.map((entry) => entry.subject)).toEqual(['Private budget']);
    // Another user's account cannot be selected.
    await expect(list(h, ada.token, { accountId: bob.accountId })).rejects.toMatchObject({ status: 404 });
    // Stored text stays encrypted.
    const stored = await h.sql<{ variants_ciphertext: string }>(`select variants_ciphertext from public.draft_versions`);
    for (const row of stored) expect(row.variants_ciphertext).not.toMatch(/Maya|slides|budget/i);
  });

  it('filters by effective status: ready, placed in Gmail, and stale past freshness', async () => {
    const h = await createIntelHarness();
    const ada = await connectedUser(h, ADA, ['mail_read', 'drafts']);
    await actionable(h, ADA, 'Slides');
    await actionable(h, ADA, 'Notes');
    const all = await list(h, ada.token);
    expect(all.counts.ready).toBe(2);

    const target = all.drafts.find((entry) => entry.subject === 'Notes')!.draft;
    const placed = await h.route<{ draft: CloudDraft }>('draftPlace', ada.token, { draftId: target.id, variantId: target.variants[0]!.id, idempotencyKey: 'place-notes-0001' });
    expect(placed.draft.status).toBe('placed');
    const inGmail = await list(h, ada.token, { statuses: ['placed', 'user_edited'] });
    expect(inGmail.drafts.map((entry) => entry.subject)).toEqual(['Notes']);
    expect(inGmail.drafts[0]!.draft.gmailDraftId).toBeTruthy();
    expect((await list(h, ada.token, { statuses: ['ready'] })).drafts.map((entry) => entry.subject)).toEqual(['Slides']);

    await h.advance(8 * 86_400_000);
    const stale = await list(h, ada.token, { statuses: ['stale'] });
    expect(stale.drafts.map((entry) => entry.draft.status).sort()).toEqual(['stale', 'stale']);
    expect(stale.counts).toMatchObject({ ready: 0, placed: 0, stale: 2 });
    expect((await list(h, ada.token, { statuses: ['ready'] })).drafts).toHaveLength(0);
  });

  it('paginates without skipping or repeating drafts', async () => {
    const h = await createIntelHarness();
    const ada = await connectedUser(h, ADA, ['mail_read', 'drafts']);
    for (const subject of ['One', 'Two', 'Three']) await actionable(h, ADA, subject);
    const first = await list(h, ada.token, { limit: 2 });
    expect(first.drafts).toHaveLength(2);
    expect(first.nextCursor).toBeTruthy();
    const second = await list(h, ada.token, { limit: 2, cursor: first.nextCursor });
    expect(second.nextCursor).toBeNull();
    const ids = [...first.drafts, ...second.drafts].map((entry) => entry.draft.id);
    expect(new Set(ids).size).toBe(3);
    await expect(list(h, ada.token, { cursor: 'nonsense' })).rejects.toMatchObject({ status: 400 });
  });

  it('retires a placed draft once the user replies, without touching the Gmail draft', async () => {
    const h = await createIntelHarness();
    const ada = await connectedUser(h, ADA, ['mail_read', 'drafts']);
    const { threadId } = await actionable(h, ADA, 'Venue');
    const draft = (await list(h, ada.token)).drafts[0]!.draft;
    const placed = (await h.route<{ draft: CloudDraft }>('draftPlace', ada.token, { draftId: draft.id, variantId: draft.variants[0]!.id, idempotencyKey: 'place-venue-0001' })).draft;
    await deliverAndSync(h, ADA, { from: ADA, to: ['maya@client.test'], subject: 'Re: Venue', body: 'Sent separately.', threadId });
    const after = await list(h, ada.token);
    expect(after.drafts).toHaveLength(0);
    expect(after.counts.placed).toBe(0);
    expect(h.google.account(ADA).drafts.has(placed.gmailDraftId!)).toBe(true);
  });

  it('requires the drafts capability and allows read-scoped API tokens', async () => {
    const h = await createIntelHarness();
    const removed = await h.signIn('removed@work.test');
    h.config.allowedEmails.splice(0, Infinity, 'kept@work.test');
    await expect(h.route('draftList', removed.accessToken, {})).rejects.toMatchObject({ status: 402 });
    const { TOKEN_ROUTE_SCOPES } = await import('../routes/token-scopes.js');
    expect(TOKEN_ROUTE_SCOPES.draftList).toBe('read');
  });
});

describe('cloud home data', () => {
  it('separates current prepared work from the visit window and routes Focus items to the draft', async () => {
    const h = await createIntelHarness();
    const ada = await connectedUser(h, ADA, ['mail_read', 'drafts']);
    const { threadId } = await actionable(h, ADA, 'Slides');
    const draftId = (await list(h, ada.token)).drafts[0]!.draft.id;

    const later = await h.route<CloudOverview>('cloudOverview', ada.token, { since: new Date(h.now().getTime() + 60_000).toISOString() });
    // Nothing happened "since", yet the prepared draft is still current work.
    expect(later.work).toMatchObject({ threadsAnalyzed: 0, draftsPrepared: 0 });
    expect(later.prepared).toMatchObject({ drafts: { ready: 1, inGmail: 0, needsUpdate: 0, preparing: 0 }, approvalsWaiting: 0 });
    const item = later.focus!.sections.flatMap((section) => section.items).find((entry: FocusItem) => entry.threadId === threadId)!;
    expect(item).toMatchObject({ draftReady: true, draftId, draftStatus: 'ready', approvalId: null, lastMessageFromOwner: false });

    await h.sql(
      `insert into public.approvals (user_id, kind, tier, title, action, responsible_type, mail_account_id, thread_id, gmail_thread_id, idempotency_key)
       select $1::uuid, 'send_email', 3, 'Send reply', '{}'::jsonb, 'user', t.mail_account_id, t.id, t.gmail_thread_id, 'approval-test-0001'
         from public.threads t where t.gmail_thread_id = $2`,
      [ada.userId, threadId],
    );
    const withApproval = await h.route<CloudOverview>('cloudOverview', ada.token, {});
    expect(withApproval.prepared?.approvalsWaiting).toBe(1);
    expect(withApproval.focus!.sections.flatMap((section) => section.items).find((entry) => entry.threadId === threadId)!.approvalId).toBeTruthy();
  });

  it('hides draft counts and ids without the drafts capability', async () => {
    const h = await createIntelHarness();
    const ada = await connectedUser(h, ADA, ['mail_read', 'drafts']);
    await actionable(h, ADA, 'Slides');
    const { cloudOverview } = await import('./overview.js');
    const { openIntel } = await import('../routes/jobs.js');
    const restricted = await cloudOverview(openIntel(h.deps)!, ada.userId, ['cloud_mail_sync']);
    expect(restricted.prepared?.drafts).toBeNull();
    for (const item of restricted.focus!.sections.flatMap((section) => section.items)) expect(item).toMatchObject({ draftReady: false, draftId: null });
  });
});
