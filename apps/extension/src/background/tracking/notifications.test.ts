import { describe, expect, it } from 'vitest';
import type { TrackingEvent } from '@pigeonbox/tracking';
import { gmailThreadUrl, groupTrackingAlerts, trackingIdFromNotification, trackingNotificationId, TrackingNotificationHistory } from './notifications';

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
