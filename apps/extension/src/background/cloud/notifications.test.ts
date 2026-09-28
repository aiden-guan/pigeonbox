import type { PigeonBoxCloudClient } from '@pigeonbox/cloud-client';
import { describe, expect, it, vi } from 'vitest';
import { pollNotifications } from './notifications';

function fakeClient(handler: (route: string, body: unknown) => unknown) {
  const call = vi.fn(async (route: string, body: unknown) => handler(route, body));
  return { client: { call } as unknown as PigeonBoxCloudClient, call };
}

describe('Cloud notifications', () => {
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
