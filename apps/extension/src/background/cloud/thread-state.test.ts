import type { PigeonBoxCloudClient } from '@pigeonbox/cloud-client';
import type { CloudState } from '@pigeonbox/core';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { pageCall } from './page-calls';
import { cloudThreadStateAvailable, forgetThreadIntel, threadIntel } from './thread-state';

const ready: CloudState = { status: 'ready', email: 'a@example.com', plan: 'cloud', capabilities: ['cloud_ai', 'cloud_mail_sync'] };

function fakeClient(handler: (route: string, body: unknown) => unknown) {
  const call = vi.fn(async (route: string, body: unknown) => handler(route, body));
  return { client: { call } as unknown as PigeonBoxCloudClient, call };
}

const intel = (threadId: string) => ({ threadId, subject: `Thread ${threadId}` });

beforeEach(() => forgetThreadIntel());

describe('Cloud thread state gating', () => {
  it('is available only in Cloud mode, signed in, with always-on sync', () => {
    expect(cloudThreadStateAvailable(ready, 'cloud')).toBe(true);
    expect(cloudThreadStateAvailable(ready, 'local')).toBe(false);
    expect(cloudThreadStateAvailable({ ...ready, capabilities: ['cloud_ai'] }, 'cloud')).toBe(false);
    expect(cloudThreadStateAvailable({ ...ready, status: 'signed_out' }, 'cloud')).toBe(false);
  });
});

describe('Cloud thread state', () => {
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
