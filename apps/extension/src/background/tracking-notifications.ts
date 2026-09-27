import type { TrackingEvent } from '@pigeonbox/tracking';

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
