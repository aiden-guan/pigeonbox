import { TrackingHttpError, type TrackingClient, type TrackingEvent } from '@pigeonbox/tracking';

type Storage = Pick<chrome.storage.StorageArea, 'get' | 'set'>;
const KEY = 'trackingEventCursors';
type Cursors = Record<string, string>;

/** Cursor advances only after the caller has reconciled and handled its page. */
export class TrackingCatchup {
  constructor(private storage: Storage) {}
  async read(scope: string, client: Pick<TrackingClient, 'getEventPage' | 'getRecentEvents'>): Promise<{ events: TrackingEvent[]; cursorBacked: boolean; acknowledge(): Promise<void> }> {
    const data = (await this.storage.get(KEY))[KEY] as Cursors | undefined;
    const previous = data?.[scope];
    let cursor = typeof previous === 'string' && /^\d{1,20}$/.test(previous) ? previous : null;
    const events: TrackingEvent[] = [];
    try {
      // At most 400 events per poll. The persistent cursor catches up on later
      // polls without losing a burst, while the dedup history retains this batch.
      for (let pages = 0; pages < 4; pages++) {
        const page = await client.getEventPage(cursor);
        if (cursor !== null && BigInt(page.cursor) < BigInt(cursor)) throw new Error('Tracking cursor moved backward');
        if (page.hasMore && page.cursor === cursor) throw new Error('Tracking cursor made no progress');
        events.push(...page.events); cursor = page.cursor;
        if (!page.hasMore) break;
      }
    } catch (error) {
      // Older self-hosted trackers still support protocol v3's bounded snapshot.
      if (error instanceof TrackingHttpError && error.status === 404) return { events: await client.getRecentEvents(), cursorBacked: false, acknowledge: async () => {} };
      throw error;
    }
    const next = cursor!;
    return { events, cursorBacked: true, acknowledge: async () => {
      const current = (await this.storage.get(KEY))[KEY] as Cursors | undefined;
      if (current?.[scope] !== previous) return; // Never overwrite a newer scope revision.
      const keys = Object.keys(current ?? {}).filter(key => key !== scope).slice(-4);
      await this.storage.set({ [KEY]: { ...Object.fromEntries(keys.map(key => [key,current![key]])), [scope]: next } });
    } };
  }
}
