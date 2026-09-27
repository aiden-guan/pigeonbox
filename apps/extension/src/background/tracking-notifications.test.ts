import { describe, expect, it } from 'vitest';
import type { TrackingEvent } from '@pigeonbox/tracking';
import { TrackingNotificationHistory } from './tracking-notifications';

function memoryStorage() {
  const data = new Map<string, unknown>();
  return {
    data,
    async get(key: string) { return { [key]: structuredClone(data.get(key)) }; },
    async set(items: Record<string, unknown>) {
      for (const [key, value] of Object.entries(items)) data.set(key, structuredClone(value));
    },
  };
}

function event(id: string, minute: number): TrackingEvent {
  return { id, tracking_id: 'email-1', type: 'OPEN', timestamp: `2026-09-25T12:${String(minute).padStart(2, '0')}:00.000Z` };
}

describe('tracking notification history', () => {
  it('baselines old events, then alerts once for a new event across worker restarts', async () => {
    const storage = memoryStorage();
    const firstWorker = new TrackingNotificationHistory(storage);
    expect(await firstWorker.claim('tracker-a', [event('old-2', 2), event('old-1', 1)])).toEqual([]);
    expect((await firstWorker.claim('tracker-a', [event('new', 3), event('old-2', 2)])).map((item) => item.id)).toEqual(['new']);

    const restartedWorker = new TrackingNotificationHistory(storage);
    expect(await restartedWorker.claim('tracker-a', [event('new', 3), event('old-2', 2)])).toEqual([]);
    expect((await restartedWorker.claim('tracker-a', [event('newer', 4), event('new', 3)])).map((item) => item.id)).toEqual(['newer']);
  });

  it('starts a separate baseline for another tracker account', async () => {
    const storage = memoryStorage();
    const history = new TrackingNotificationHistory(storage);
    await history.claim('tracker-a/account-1', [event('old', 1)]);
    expect(await history.claim('tracker-a/account-2', [event('other-old', 2)])).toEqual([]);
    expect((await history.claim('tracker-a/account-1', [event('new', 3), event('old', 1)])).map((item) => item.id)).toEqual(['new']);
  });

  it('serializes simultaneous polls and retains the newest IDs when trimming', async () => {
    const storage = memoryStorage();
    const history = new TrackingNotificationHistory(storage);
    await history.claim('tracker-a', []);
    const [first, second] = await Promise.all([
      history.claim('tracker-a', [event('same', 3)]),
      history.claim('tracker-a', [event('same', 3)]),
    ]);
    expect(first.map((item) => item.id)).toEqual(['same']);
    expect(second).toEqual([]);

    const burst = Array.from({ length: 510 }, (_, index) => ({ ...event(`event-${index}`, 4), timestamp: new Date(Date.UTC(2026, 8, 25, 12, 0, index)).toISOString() }));
    await history.claim('tracker-a', burst.reverse());
    const stored = storage.data.get('trackingNotificationHistory') as Record<string, string[]>;
    expect(stored['tracker-a']).toHaveLength(500);
    expect(stored['tracker-a']).toContain('event-509');
  });
});
