/** Remembers which open-tracking events already produced a desktop notification. */
import { isNotifiableTrackingEvent, type TrackingEvent } from '@pigeonbox/tracking';

const STORAGE_KEY = 'trackingNotificationHistory';
const MAX_EVENTS_PER_TRACKER = 500;
const MAX_TRACKERS = 5;

type StorageArea = Pick<chrome.storage.StorageArea, 'get' | 'set'>;
type History = Record<string, string[]>;

/**
 * Keep the recent event IDs across extension and browser restarts. A tracker
 * without history starts with a snapshot of its current events, so upgrading an
 * existing install never replays old opens as desktop notifications.
 */
export class TrackingNotificationHistory {
  private pending: Promise<unknown> = Promise.resolve();

  constructor(private readonly storage: StorageArea) {}

  claim(target: string, events: TrackingEvent[]): Promise<TrackingEvent[]> {
    const next = this.pending.then(() => this.claimNow(target, events));
    this.pending = next.catch(() => undefined);
    return next;
  }

  /** A claim can become provisional while the history write is awaiting storage. */
  release(target: string, ids: string[]): Promise<void> {
    const next = this.pending.then(async () => {
      if (!ids.length) return;
      const history = (await this.storage.get(STORAGE_KEY))[STORAGE_KEY] as History | undefined;
      if (!history || !Array.isArray(history[target])) return;
      const held = new Set(ids);
      await this.storage.set({ [STORAGE_KEY]: { ...history, [target]: history[target].filter((id) => !held.has(id)) } });
    });
    this.pending = next.catch(() => undefined);
    return next;
  }

  private async claimNow(target: string, events: TrackingEvent[]): Promise<TrackingEvent[]> {
    const value = (await this.storage.get(STORAGE_KEY))[STORAGE_KEY];
    const history: History = value && typeof value === 'object' && !Array.isArray(value) ? value as History : {};
    const previous = Array.isArray(history[target]) ? history[target].filter((id): id is string => typeof id === 'string') : null;
    const seen = new Set(previous ?? []);
    const fresh: TrackingEvent[] = [];
    // Tracker APIs return newest first. Store oldest first so trimming retains
    // the newest IDs even after a busy polling interval.
    const ordered = [...events].sort((a, b) => a.timestamp.localeCompare(b.timestamp));
    for (const event of ordered) {
      if (!event.id || seen.has(event.id)) continue;
      seen.add(event.id);
      if (previous !== null) fresh.push(event);
    }
    const keys = Object.keys(history).filter((key) => key !== target).slice(-(MAX_TRACKERS - 1));
    const updated: History = Object.fromEntries(keys.map((key) => [key, history[key]]));
    updated[target] = [...seen].slice(-MAX_EVENTS_PER_TRACKER);
    // Persist before displaying anything. If storage fails, the caller will
    // skip alerts rather than risk replaying the same events on the next poll.
    await this.storage.set({ [STORAGE_KEY]: updated });
    return fresh;
  }
}

/** Opens closer together than this are one render (Gmail's proxy often fetches twice). */
const SAME_RENDER_MS = 800;

/**
 * One desktop alert per email and kind (open or click) per poll, counting
 * distinct detections. Self, machine and unknown fetches never alert; see
 * `isNotifiableTrackingEvent`.
 */
export function groupTrackingAlerts(events: TrackingEvent[]): Array<{ event: TrackingEvent; count: number }> {
  const groups = new Map<string, { event: TrackingEvent; count: number; lastMs: number }>();
  const ordered = [...events].sort((a, b) => a.timestamp.localeCompare(b.timestamp));
  for (const event of ordered) {
    if (!isNotifiableTrackingEvent(event)) continue;
    const key = `${event.tracking_id}:${event.type}`;
    const ms = Date.parse(event.timestamp);
    const current = groups.get(key);
    if (!current) {
      groups.set(key, { event, count: 1, lastMs: ms });
      continue;
    }
    current.event = event;
    if (event.type === 'OPEN' && Number.isFinite(ms) && ms - current.lastMs < SAME_RENDER_MS) continue;
    current.count += 1;
    current.lastMs = ms;
  }
  return [...groups.values()].map(({ event, count }) => ({ event, count }));
}

const NOTIFICATION_PREFIX = 'trkn:';

export function trackingNotificationId(event: Pick<TrackingEvent, 'tracking_id' | 'id'>): string {
  return `${NOTIFICATION_PREFIX}${event.tracking_id}:${event.id}`;
}

export function trackingIdFromNotification(id: string): string | null {
  if (!id.startsWith(NOTIFICATION_PREFIX)) return null;
  const trackingId = id.slice(NOTIFICATION_PREFIX.length).split(':')[0];
  return trackingId && /^[\w-]{1,80}$/.test(trackingId) ? trackingId : null;
}

/**
 * Gmail URL for a tracked email's conversation. Gmail addresses threads by
 * their hex ID; InboxSDK can report the decimal form. Without a usable ID the
 * Sent folder is the honest fallback.
 */
export function gmailThreadUrl(email: { gmailThreadId: string | null; sender?: string | null }): string {
  const account = email.sender && email.sender.includes('@') ? `?authuser=${encodeURIComponent(email.sender)}` : '';
  const base = `https://mail.google.com/mail/${account}`;
  const raw = (email.gmailThreadId || '').trim().replace(/^#/, '').replace(/^thread-[af]:/i, '');
  let hex: string | null = null;
  if (/^[0-9a-f]{12,16}$/i.test(raw) && !/^\d{17,}$/.test(raw)) hex = raw.toLowerCase();
  else if (/^\d{17,20}$/.test(raw)) hex = BigInt(raw).toString(16);
  return hex ? `${base}#all/${hex}` : `${base}#sent`;
}
