import type { PigeonBoxCloudClient } from '@pigeonbox/cloud-client';
import { CloudApiError } from '@pigeonbox/cloud-client';
import type { CloudState } from '@pigeonbox/core';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { cloudIntelAvailable, forgetThreadIntel, PAGE_ROUTES, pageCall, pollNotifications, threadIntel } from './cloud-intel';

const ready: CloudState = { status: 'ready', email: 'a@example.com', plan: 'cloud', capabilities: ['cloud_ai', 'cloud_mail_sync'] };

function fakeClient(handler: (route: string, body: unknown) => unknown) {
  const call = vi.fn(async (route: string, body: unknown) => handler(route, body));
  return { client: { call } as unknown as PigeonBoxCloudClient, call };
}

const intel = (threadId: string) => ({ threadId, subject: `Thread ${threadId}` });

beforeEach(() => forgetThreadIntel());

describe('Cloud intelligence gating', () => {
  it('is available only in Cloud mode, signed in, with always-on sync', () => {
    expect(cloudIntelAvailable(ready, 'cloud')).toBe(true);
    expect(cloudIntelAvailable(ready, 'local')).toBe(false);
    expect(cloudIntelAvailable({ ...ready, capabilities: ['cloud_ai'] }, 'cloud')).toBe(false);
    expect(cloudIntelAvailable({ ...ready, status: 'signed_out' }, 'cloud')).toBe(false);
  });

  it('never lets extension pages reach billing, account deletion, tokens or webhooks', async () => {
    for (const route of ['billingCheckout', 'billingPortal', 'accountDelete', 'authToken', 'connectionDisconnect']) expect(PAGE_ROUTES.has(route as never)).toBe(false);
    const { client, call } = fakeClient(() => ({}));
    expect(await pageCall(client, 'accountDelete', { confirm: 'delete my account' })).toMatchObject({ ok: false, code: 'forbidden' });
    expect(await pageCall(client, 'controlTokenCreate', {})).toMatchObject({ ok: false, code: 'forbidden' });
    expect(call).not.toHaveBeenCalled();
  });

  it('turns contract errors into plain reasons', async () => {
    const { client } = fakeClient(() => {
      throw new CloudApiError({ code: 'conflict', status: 409, message: 'Fill in [DATE NEEDED] before approving. Nothing was sent.' });
    });
    expect(await pageCall(client, 'approvalDecide', { id: 'x' })).toEqual({ ok: false, code: 'conflict', reason: 'Fill in [DATE NEEDED] before approving. Nothing was sent.' });
  });
});

describe('thread intelligence', () => {
  it('batches, caches, and remembers threads Cloud has not synced', async () => {
    const { client, call } = fakeClient((_route, body) => {
      const ids = (body as { threadIds: string[] }).threadIds;
      return { threads: Object.fromEntries(ids.filter((id) => id !== 'unsynced').map((id) => [id, intel(id)])), synced: true, accountId: null };
    });
    const first = await threadIntel(client, ['a', 'b', 'unsynced', 'a'], 'me@example.com');
    expect(Object.keys(first).sort()).toEqual(['a', 'b']);
    expect(call).toHaveBeenCalledTimes(1);
    expect(call.mock.calls[0]![1]).toEqual({ threadIds: ['a', 'b', 'unsynced'], mailbox: 'me@example.com' });
    await threadIntel(client, ['a', 'unsynced'], 'me@example.com');
    expect(call).toHaveBeenCalledTimes(1);
    await threadIntel(client, ['a', 'c'], 'me@example.com');
    expect(call.mock.calls[1]![1]).toEqual({ threadIds: ['c'], mailbox: 'me@example.com' });
  });

  it('ignores malformed thread IDs from the page', async () => {
    const { client, call } = fakeClient(() => ({ threads: {}, synced: true, accountId: null }));
    await threadIntel(client, ['../../etc', 'ok_1'], undefined);
    expect(call.mock.calls[0]![1]).toEqual({ threadIds: ['ok_1'] });
  });

  it('invalidates cached state after a page changes a thread', async () => {
    let subject = 'Before';
    const { client } = fakeClient((route) => (route === 'threadsIntel' ? { threads: { t: { threadId: 't', subject } }, synced: true, accountId: null } : { ok: true }));
    expect((await threadIntel(client, ['t']))['t']).toMatchObject({ subject: 'Before' });
    subject = 'After';
    await pageCall(client, 'threadStateUpdate', { threadId: 't', state: 'DONE' });
    expect((await threadIntel(client, ['t']))['t']).toMatchObject({ subject: 'After' });
  });
});

describe('notifications', () => {
  function store() {
    const data: Record<string, unknown> = {};
    return { data, get: async (key: string) => ({ [key]: data[key] }), set: async (items: Record<string, unknown>) => void Object.assign(data, items) };
  }
  const note = (id: string, kind: string, createdAt: string) => ({ id, kind, title: `T${id}`, body: 'b', threadId: null, accountId: null, refId: null, createdAt, readAt: null });

  it('starts from now on first run, then shows each new important notification once', async () => {
    const s = store();
    const shown: string[] = [];
    const show = (id: string) => shown.push(id);
    const items = [note('1', 'approval', '2026-09-28T10:00:00.000Z'), note('2', 'draft_ready', '2026-09-28T10:01:00.000Z'), note('3', 'mention', '2026-09-28T10:02:00.000Z')];
    const { client } = fakeClient((route) => (route === 'preferences' ? { preferences: { notifications: { extension: true } } } : { notifications: items, unread: 3 }));
    expect(await pollNotifications(client, s, show, new Date('2026-09-28T09:00:00Z'))).toBe(0);
    expect(await pollNotifications(client, s, show)).toBe(2);
    expect(shown).toEqual(['cloud_approval_1', 'cloud_mention_3']);
    expect(await pollNotifications(client, s, show)).toBe(0);
  });

  it('respects the person turning extension notifications off', async () => {
    const s = store();
    s.data.cloudNotificationsSeenAt = '2026-09-28T09:00:00.000Z';
    const { client, call } = fakeClient((route) => (route === 'preferences' ? { preferences: { notifications: { extension: false } } } : { notifications: [note('1', 'approval', '2026-09-28T10:00:00.000Z')], unread: 1 }));
    expect(await pollNotifications(client, s, () => undefined)).toBe(0);
    expect(call.mock.calls.map((c) => c[0])).toEqual(['preferences']);
  });
});
