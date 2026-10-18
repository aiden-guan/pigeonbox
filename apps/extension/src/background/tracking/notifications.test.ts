import { describe, expect, it } from 'vitest';
import type { TrackingEvent } from '@pigeonbox/tracking';
import { ConversationAlerts, gmailThreadUrl, groupTrackingAlerts, trackingIdFromNotification, trackingNotificationId, TrackingNotificationHistory } from './notifications';

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

  it('releases an event that became provisional during storage without losing its eventual recipient alert', async () => {
    const storage = memoryStorage();
    const history = new TrackingNotificationHistory(storage);
    await history.claim('tracker-a', []);
    expect((await history.claim('tracker-a', [event('held', 3)])).map((item) => item.id)).toEqual(['held']);
    await history.release('tracker-a', ['held']);
    expect((await history.claim('tracker-a', [event('held', 3)])).map((item) => item.id)).toEqual(['held']);
    expect(await history.claim('tracker-a', [event('held', 3)])).toEqual([]);
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

describe('tracking alerts', () => {
  const proxy = 'Mozilla/5.0 (Windows NT 5.1; rv:11.0) Gecko Firefox/11.0 (via ggpht.com GoogleImageProxy)';
  const event = (id: string, at: string, extra: Partial<TrackingEvent> = {}): TrackingEvent => ({
    id,
    tracking_id: 'trk_a',
    type: 'OPEN',
    timestamp: at,
    user_agent: proxy,
    classification: 'PROXY_LIKELY',
    ...extra,
  });

  it('sends one alert per email and kind, counting a proxy double-fetch once', () => {
    const alerts = groupTrackingAlerts([
      event('e1', '2026-09-22T15:00:00.000Z'),
      event('e2', '2026-09-22T15:00:00.300Z'),
      event('e3', '2026-09-22T15:04:00.000Z'),
      event('c1', '2026-09-22T15:05:00.000Z', { type: 'CLICK', classification: 'RECIPIENT_LIKELY', user_agent: 'Mozilla/5.0 (Macintosh) AppleWebKit/537.36 Chrome/130 Safari/537.36' }),
    ]);
    expect(alerts.map((alert) => [alert.event.type, alert.event.id, alert.count])).toEqual([
      ['OPEN', 'e3', 2],
      ['CLICK', 'c1', 1],
    ]);
  });

  it('never alerts on self, machine or unknown detections', () => {
    expect(groupTrackingAlerts([
      event('s', '2026-09-22T15:00:00.000Z', { classification: 'SELF_LIKELY', suspected_self_open: true }),
      event('m', '2026-09-22T15:01:00.000Z', { classification: 'MACHINE_LIKELY' }),
      event('u', '2026-09-22T15:02:00.000Z', { classification: 'UNKNOWN', user_agent: undefined }),
      event('v', '2026-09-22T15:03:00.000Z', { type: 'SELF_VIEW', classification: 'SELF_LIKELY' }),
    ])).toEqual([]);
  });

  describe('conversations', () => {
    const hex = '18c1f5a3b2d4e6f7';
    const threads: Record<string, string> = { trk_a: hex, trk_b: `thread-f:${BigInt(`0x${hex}`).toString()}`, trk_c: hex, trk_other: '18c1f5a3b2d4e6aa' };
    const threadOf = (id: string) => threads[id];
    const at = (seconds: number) => new Date(Date.UTC(2026, 9, 17, 15, 0, seconds)).toISOString();
    const open = (id: string, trackingId: string, seconds: number) => event(id, at(seconds), { tracking_id: trackingId });

    it('sends one alert when opening a conversation fires every tracked message in it', () => {
      const alerts = groupTrackingAlerts([
        open('a1', 'trk_a', 0),
        open('a2', 'trk_a', 0.3),
        open('b1', 'trk_b', 2),
        open('c1', 'trk_c', 5),
        open('x1', 'trk_other', 3),
      ], threadOf);
      expect(alerts.map((alert) => [alert.key, alert.event.id, alert.count, alert.emails])).toEqual([
        [`thread:${hex}:OPEN`, 'c1', 1, 3],
        ['thread:18c1f5a3b2d4e6aa:OPEN', 'x1', 1, 1],
      ]);
    });

    it('counts a later reopening of the conversation, and every click', () => {
      const alerts = groupTrackingAlerts([
        open('a1', 'trk_a', 0),
        open('b1', 'trk_b', 1),
        open('a2', 'trk_a', 10),
        open('b2', 'trk_b', 300),
        event('k1', at(301), { tracking_id: 'trk_a', type: 'CLICK', classification: 'RECIPIENT_LIKELY', user_agent: 'Mozilla/5.0 (Macintosh) AppleWebKit/537.36 Chrome/130 Safari/537.36' }),
        event('k2', at(302), { tracking_id: 'trk_b', type: 'CLICK', classification: 'RECIPIENT_LIKELY', user_agent: 'Mozilla/5.0 (Macintosh) AppleWebKit/537.36 Chrome/130 Safari/537.36' }),
      ], threadOf);
      // a2 reopens trk_a within the same minute; b2 is a fresh opening five minutes on.
      expect(alerts.map((alert) => [alert.event.type, alert.count])).toEqual([['OPEN', 3], ['CLICK', 2]]);
    });

    it('updates the shown alert when one opening lands on both sides of a poll', async () => {
      const shown = new ConversationAlerts(memoryStorage());
      const [first] = groupTrackingAlerts([open('a1', 'trk_a', 0)], threadOf);
      const plan = await shown.plan('scope', first!);
      expect(plan).toMatchObject({ action: 'show', count: 1 });
      if (plan.action === 'skip') throw new Error('unexpected');
      await shown.record('scope', first!, 'trkn:trk_a:a1', plan);

      const [rest] = groupTrackingAlerts([open('b1', 'trk_b', 4), open('c1', 'trk_c', 6)], threadOf);
      const merged = await shown.plan('scope', rest!);
      expect(merged).toMatchObject({ action: 'merge', id: 'trkn:trk_a:a1', count: 1 });
      if (merged.action !== 'merge') throw new Error('unexpected');
      await shown.record('scope', rest!, merged.id, merged);

      // A replay after a worker restart is already on screen.
      expect(await shown.plan('scope', rest!)).toEqual({ action: 'skip' });
      // The same email fetched again a few seconds later is a reopening, still merged.
      const [again] = groupTrackingAlerts([open('a2', 'trk_a', 20)], threadOf);
      expect(await shown.plan('scope', again!)).toMatchObject({ action: 'merge', count: 2 });
      // Other trackers and much later openings raise their own alert.
      expect(await shown.plan('other-scope', again!)).toMatchObject({ action: 'show', count: 1 });
      const [later] = groupTrackingAlerts([open('a3', 'trk_a', 600)], threadOf);
      expect(await shown.plan('scope', later!)).toMatchObject({ action: 'show', count: 1 });
    });
  });

  it('round-trips the tracking ID through the notification ID', () => {
    const id = trackingNotificationId({ tracking_id: 'trk_a', id: 'evt_1' });
    expect(trackingIdFromNotification(id)).toBe('trk_a');
    expect(trackingIdFromNotification('cloud_approval_1')).toBeNull();
    expect(trackingIdFromNotification('trkn:../x:1')).toBeNull();
  });

  it('opens the Gmail conversation, or the Sent folder when the thread is unknown', () => {
    expect(gmailThreadUrl({ gmailThreadId: '18c1f5a3b2d4e6f7', sender: 'me@example.com' })).toBe('https://mail.google.com/mail/?authuser=me%40example.com#all/18c1f5a3b2d4e6f7');
    expect(gmailThreadUrl({ gmailThreadId: 'thread-f:1782436781398375655', sender: 'me' })).toBe(`https://mail.google.com/mail/#all/${BigInt('1782436781398375655').toString(16)}`);
    expect(gmailThreadUrl({ gmailThreadId: null, sender: 'me@example.com' })).toBe('https://mail.google.com/mail/?authuser=me%40example.com#sent');
    expect(gmailThreadUrl({ gmailThreadId: 'pending:x', sender: null })).toBe('https://mail.google.com/mail/#sent');
  });
});
