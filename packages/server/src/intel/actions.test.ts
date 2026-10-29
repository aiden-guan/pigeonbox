import type { Approval } from '@pigeonbox/api-contract';
import { describe, expect, it } from 'vitest';
import { type SqlDatabase } from '../db/sql.js';
import { buildRawMessage } from '../google/mime.js';
import { openIntel } from '../routes/jobs.js';
import { connectedUser, createIntelHarness, type IntelHarness } from '../testing/intel-harness.js';
import { performAction } from './actions.js';
import { createApproval } from './approvals.js';

const ADA = 'ada@dispatch.test';
const raw = buildRawMessage({ to: [{ email: 'controlled@recipient.test' }], subject: 'One approved email', body: 'Send this email once.' });
const inputFor = (accountId: string, key = 'dispatch-once-0001') => ({
  spec: { kind: 'send_email' as const, params: { raw } },
  target: { accountId, threadRowId: null, gmailThreadId: null, title: 'One approved email' },
  actor: { type: 'user' as const, id: null, name: 'You' },
  userInitiated: false,
  approved: true,
  idempotencyKey: key,
});
async function approvalFor(h: IntelHarness, user: { userId: string; accountId: string }) {
  return h.db.asUser(user.userId, tx => createApproval(tx, h.box, {
    userId: user.userId, kind: 'send_email', tier: 3, title: 'One approved email', why: 'You requested it', sources: [],
    action: { kind: 'send_email', params: {} }, target: inputFor(user.accountId).target,
    preview: { to: ['controlled@recipient.test'], subject: 'One approved email', body: 'Send this email once.' },
    responsible: { type: 'user', id: user.userId, name: 'You' }, idempotencyKey: 'dispatch-approval-0001',
  }));
}

describe('irreversible action dispatch', () => {
  it('keeps an accepted send with a lost response visible and never auto-resends it', async () => {
    const h = await createIntelHarness();
    try {
      const user = await connectedUser(h, ADA, ['mail_read', 'send']);
      const approval = await approvalFor(h, user);
      await h.route('approvalDecide', user.token, { id: approval.id, decision: 'approve', idempotencyKey: 'approve-dispatch-0001' });
      const real = h.deps.intel!.fetch;
      let lost = false;
      h.deps.intel!.fetch = async (url, init) => {
        const response = await real(url, init);
        if (!lost && String(url).endsWith('/messages/send')) { lost = true; throw new TypeError('Response lost after acceptance'); }
        return response;
      };
      await h.drain();
      await h.advance(3_600_000);
      await h.drain();
      expect(h.google.account(ADA).sent).toHaveLength(1);
      const listed = await h.route<{ approvals: Approval[] }>('approvals', user.token, { status: 'all' });
      expect(listed.approvals[0]).toMatchObject({ status: 'failed', result: { code: 'action_unconfirmed' } });
      expect(listed.approvals[0]!.result!.message).toMatch(/Check your Sent mail/);
      // Replaying the decision cannot silently authorize a second dispatch.
      await h.route('approvalDecide', user.token, { id: approval.id, decision: 'approve', idempotencyKey: 'approve-dispatch-0002' });
      await h.drain();
      expect(h.google.account(ADA).sent).toHaveLength(1);
    } finally { await h.pg.close(); }
  });

  it('keeps successful duplicate calls idempotent', async () => {
    const h = await createIntelHarness();
    try {
      const user = await connectedUser(h, ADA, ['mail_read', 'send']);
      const deps = openIntel(h.deps)!;
      const first = await performAction(deps, user.userId, inputFor(user.accountId));
      const again = await performAction(deps, user.userId, inputFor(user.accountId));
      expect(first.errorCode).toBeNull();
      expect(again).toMatchObject({ auditId: first.auditId, errorCode: null, reason: 'Already done' });
      expect(h.google.account(ADA).sent).toHaveLength(1);
    } finally { await h.pg.close(); }
  });

  it('reserves one dispatch across concurrent calls', async () => {
    const h = await createIntelHarness();
    try {
      const user = await connectedUser(h, ADA, ['mail_read', 'send']);
      const deps = openIntel(h.deps)!;
      const results = await Promise.all([performAction(deps, user.userId, inputFor(user.accountId)), performAction(deps, user.userId, inputFor(user.accountId))]);
      expect(results.some(result => result.errorCode === null)).toBe(true);
      expect(h.google.account(ADA).sent).toHaveLength(1);
      expect(await h.db.asUser(user.userId, tx => tx.query("select key from public.idempotency_keys where scope = 'external_action'"))).toHaveLength(1);
    } finally { await h.pg.close(); }
  });

  it('permits retry after an explicit provider 429 rejection', async () => {
    const h = await createIntelHarness();
    try {
      const user = await connectedUser(h, ADA, ['mail_read', 'send']);
      const deps = openIntel(h.deps)!;
      h.google.failures.push({ pattern: /messages\/send$/, status: 429, remaining: 1 });
      expect(await performAction(deps, user.userId, inputFor(user.accountId))).toMatchObject({ errorCode: 'google_rate_limited' });
      expect(h.google.account(ADA).sent).toHaveLength(0);
      expect(await h.db.asUser(user.userId, tx => tx.query("select key from public.idempotency_keys where scope = 'external_action'"))).toEqual([]);
      expect(await performAction(deps, user.userId, inputFor(user.accountId))).toMatchObject({ errorCode: null });
      expect(h.google.account(ADA).sent).toHaveLength(1);
    } finally { await h.pg.close(); }
  });

  it('releases validation failures without consuming a dispatch', async () => {
    const h = await createIntelHarness();
    try {
      const user = await connectedUser(h, ADA, ['mail_read', 'send']);
      const deps = openIntel(h.deps)!;
      const input = inputFor(user.accountId);
      expect(await performAction(deps, user.userId, { ...input, spec: { kind: 'send_email', params: { raw: '' } } })).toMatchObject({ errorCode: 'invalid_request' });
      expect(await h.db.asUser(user.userId, tx => tx.query("select key from public.idempotency_keys where scope = 'external_action'"))).toEqual([]);
      expect(await performAction(deps, user.userId, input)).toMatchObject({ errorCode: null });
      expect(h.google.account(ADA).sent).toHaveLength(1);
    } finally { await h.pg.close(); }
  });

  it('does not retry a 5xx response that followed an accepted send', async () => {
    const h = await createIntelHarness();
    try {
      const user = await connectedUser(h, ADA, ['mail_read', 'send']);
      const deps = openIntel(h.deps)!;
      const real = deps.fetch;
      deps.fetch = async (url, init) => {
        const response = await real(url, init);
        return String(url).endsWith('/messages/send') ? new Response('{}', { status: 503 }) : response;
      };
      expect(await performAction(deps, user.userId, inputFor(user.accountId))).toMatchObject({ errorCode: 'action_unconfirmed' });
      expect(await performAction(deps, user.userId, inputFor(user.accountId))).toMatchObject({ errorCode: 'action_unconfirmed' });
      expect(h.google.account(ADA).sent).toHaveLength(1);
    } finally { await h.pg.close(); }
  });

  it('retains the dispatch reservation when audit persistence fails after the send', async () => {
    const h = await createIntelHarness();
    try {
      const user = await connectedUser(h, ADA, ['mail_read', 'send']);
      const deps = openIntel(h.deps)!;
      const db = deps.db;
      let fail = true;
      deps.db = {
        ...db,
        asUser: (userId, fn) => db.asUser(userId, tx => fn({
          async query<T>(text: string, params?: readonly unknown[]) {
            if (fail && text.includes('insert into public.audit_events')) { fail = false; throw new Error('Injected persistence failure'); }
            return tx.query<T>(text, params);
          },
        })),
      } satisfies SqlDatabase;
      await expect(performAction(deps, user.userId, inputFor(user.accountId))).rejects.toThrow('Injected persistence failure');
      expect(await performAction(deps, user.userId, inputFor(user.accountId))).toMatchObject({ errorCode: 'action_unconfirmed' });
      expect(h.google.account(ADA).sent).toHaveLength(1);
    } finally { await h.pg.close(); }
  });

  it('keeps a crash reservation across retention and a delayed queue retry', async () => {
    const h = await createIntelHarness();
    try {
      const user = await connectedUser(h, ADA, ['mail_read', 'send']);
      const approval = await approvalFor(h, user);
      await h.route('approvalDecide', user.token, { id: approval.id, decision: 'approve', idempotencyKey: 'approve-retention-0001' });
      let fail = true;
      const db = h.db;
      const failingDb = {
        ...db,
        asUser: (userId, fn) => db.asUser(userId, tx => fn({
          async query<T>(text: string, params?: readonly unknown[]) {
            if (fail && text.includes('insert into public.audit_events')) { fail = false; throw new Error('Injected post-send crash'); }
            return tx.query<T>(text, params);
          },
        })),
      } satisfies SqlDatabase;
      h.deps.intel!.database = { open: () => failingDb };
      expect(await h.drain(1)).toMatchObject({ retried: 1 });
      expect(h.google.account(ADA).sent).toHaveLength(1);
      expect(await h.sql('select status from public.approvals where id = $1::uuid', [approval.id])).toEqual([{ status: 'approved' }]);
      expect(await h.sql("select status from public.jobs where kind = 'approval.execute'")).toEqual([{ status: 'retrying' }]);
      await h.sql(`insert into public.idempotency_keys (user_id, scope, key, created_at)
                   values ($1::uuid, 'ordinary_write', 'expired-write-response', now() - interval '31 days')`, [user.userId]);
      await h.sql("update public.idempotency_keys set created_at = now() - interval '31 days' where scope = 'external_action'");
      await h.sql('select app.sweep_retention()');
      expect(await h.sql("select key from public.idempotency_keys where scope = 'external_action'")).toHaveLength(1);
      expect(await h.sql("select key from public.idempotency_keys where scope = 'ordinary_write'")).toEqual([]);
      await h.advance(31 * 86_400_000);
      await h.drain();
      expect(h.google.account(ADA).sent).toHaveLength(1);
      const listed = await h.route<{ approvals: Approval[] }>('approvals', user.token, { status: 'all' });
      expect(listed.approvals[0]).toMatchObject({ status: 'failed', result: { code: 'action_unconfirmed' } });
      // Keeping the safety receipt must not retain it after its owner is deleted.
      await h.sql('delete from auth.users where id = $1::uuid', [user.userId]);
      expect(await h.sql("select key from public.idempotency_keys where scope = 'external_action'")).toEqual([]);
    } finally { await h.pg.close(); }
  });

  it('scopes identical dispatch keys and their reads/writes to each user', async () => {
    const h = await createIntelHarness();
    try {
      const ada = await connectedUser(h, ADA, ['mail_read', 'send']);
      const bob = await connectedUser(h, 'bob@dispatch.test', ['mail_read', 'send']);
      const deps = openIntel(h.deps)!;
      await performAction(deps, ada.userId, inputFor(ada.accountId));
      await performAction(deps, bob.userId, inputFor(bob.accountId));
      expect(h.google.account(ADA).sent).toHaveLength(1);
      expect(h.google.account('bob@dispatch.test').sent).toHaveLength(1);
      expect(await h.db.asUser(ada.userId, tx => tx.query("select user_id from public.idempotency_keys where scope = 'external_action'"))).toEqual([{ user_id: ada.userId }]);
      expect(await h.db.asUser(ada.userId, tx => tx.query("delete from public.idempotency_keys where user_id = $1::uuid returning key", [bob.userId]))).toEqual([]);
    } finally { await h.pg.close(); }
  });

  it('does not send duplicate Calendar invitations after an ambiguous response', async () => {
    const h = await createIntelHarness();
    try {
      const user = await connectedUser(h, ADA);
      const start = new Date(h.now().getTime() + 86_400_000).toISOString();
      const end = new Date(h.now().getTime() + 88_200_000).toISOString();
      const prepared = await h.route<{ event: { id: string } }>('eventPrepare', user.token, { title: 'Approved invitation', start, end, attendees: ['controlled@recipient.test'], notifyAttendees: true });
      const pending = await h.route<{ event: { approvalId: string } }>('eventCreate', user.token, { preparedEventId: prepared.event.id, idempotencyKey: 'invite-dispatch-0001' });
      const real = h.deps.intel!.fetch;
      h.deps.intel!.fetch = async (url, init) => {
        const response = await real(url, init);
        return init?.method === 'POST' && String(url).includes('/calendar/v3/') && String(url).includes('/events')
          ? new Response('{}', { status: 503 }) : response;
      };
      await h.route('approvalDecide', user.token, { id: pending.event.approvalId, decision: 'approve', idempotencyKey: 'approve-invite-0001' });
      await h.drain();
      await h.advance(3_600_000);
      await h.drain();
      expect(h.google.account(ADA).events.filter(event => event.summary === 'Approved invitation')).toHaveLength(1);
      const listed = await h.route<{ approvals: Approval[] }>('approvals', user.token, { status: 'all' });
      expect(listed.approvals[0]).toMatchObject({ status: 'failed', result: { code: 'action_unconfirmed' } });
      expect(listed.approvals[0]!.result!.message).toMatch(/Check your calendar/);
    } finally { await h.pg.close(); }
  });
});
