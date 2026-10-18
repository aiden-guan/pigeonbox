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
 * Opening a Gmail conversation renders every tracked message in it, so each
 * pixel fires within moments of the others. Detections in one conversation
 * this close together, each one chained to the last, are one opening.
 */
export const CONVERSATION_RENDER_MS = 60_000;

export type TrackingAlert = {
  /** The newest detection, which names the email in the alert. */
  event: TrackingEvent;
  /** Distinct openings (or clicks) of the conversation. */
  count: number;
  /** Conversation, or the single email when its thread is unknown. */
  key: string;
  /** How many tracked emails in the conversation were detected. */
  emails: number;
  /** The oldest detection, which may continue an opening a previous poll alerted. */
  first: TrackingEvent;
  firstMs: number;
  lastMs: number;
  /** When each email was last detected in the latest opening. */
  render: Record<string, number>;
};

/**
 * One desktop alert per conversation and kind (open or click) per poll,
 * counting distinct openings rather than one per tracked email. Self, machine
 * and unknown fetches never alert; see `isNotifiableTrackingEvent`.
 */
export function groupTrackingAlerts(
  events: TrackingEvent[],
  threadOf: (trackingId: string) => string | null | undefined = () => null,
): TrackingAlert[] {
  type Group = TrackingAlert & { ids: Set<string> };
  const groups = new Map<string, Group>();
  const ordered = [...events].sort((a, b) => a.timestamp.localeCompare(b.timestamp));
  for (const event of ordered) {
    if (!isNotifiableTrackingEvent(event)) continue;
    const key = `${conversationKey(event.tracking_id, threadOf(event.tracking_id))}:${event.type}`;
    const ms = Date.parse(event.timestamp);
    const current = groups.get(key);
    if (!current) {
      groups.set(key, { event, count: 1, key, emails: 1, first: event, firstMs: ms, lastMs: ms, ids: new Set([event.tracking_id]), render: { [event.tracking_id]: ms } });
      continue;
    }
    current.event = event;
    current.ids.add(event.tracking_id);
    current.emails = current.ids.size;
    if (sameRender(current.render, current.lastMs, event, ms)) {
      current.render[event.tracking_id] = ms;
    } else {
      current.count += 1;
      current.render = { [event.tracking_id]: ms };
    }
    current.lastMs = ms;
  }
  return [...groups.values()].map(({ ids: _ids, ...alert }) => alert);
}

/**
 * Whether a detection belongs to the opening already under way: another email
 * of the conversation arriving soon after, or a proxy refetch of the same one.
 * Clicks are deliberate, so every click counts.
 */
function sameRender(render: Record<string, number>, lastMs: number, event: TrackingEvent, ms: number): boolean {
  if (event.type !== 'OPEN' || !Number.isFinite(ms) || !Number.isFinite(lastMs)) return false;
  if (ms - lastMs >= CONVERSATION_RENDER_MS) return false;
  const seen = render[event.tracking_id];
  return seen === undefined || ms - seen < SAME_RENDER_MS;
}

/** Gmail's hex thread ID; InboxSDK can report the decimal `thread-f:` form. */
export function gmailThreadHex(threadId: string | null | undefined): string | null {
  const raw = (threadId || '').trim().replace(/^#/, '').replace(/^thread-[af]:/i, '');
  if (/^[0-9a-f]{12,16}$/i.test(raw) && !/^\d{17,}$/.test(raw)) return raw.toLowerCase();
  if (/^\d{17,20}$/.test(raw)) return BigInt(raw).toString(16);
  return null;
}

function conversationKey(trackingId: string, threadId: string | null | undefined): string {
  const hex = gmailThreadHex(threadId);
  return hex ? `thread:${hex}` : `email:${trackingId}`;
}

const SHOWN_KEY = 'trackingAlertsShown';
const MAX_SHOWN = 100;

export type AlertPlan =
  | { action: 'show'; count: number; render: Record<string, number> }
  | { action: 'merge'; id: string; count: number; render: Record<string, number> }
  | { action: 'skip' };

type Shown = Record<string, { id: string; count: number; lastMs: number; render: Record<string, number> }>;

/**
 * Remembers the alert last shown for each conversation, so an opening whose
 * pixels land on both sides of a poll updates that alert instead of raising a
 * second one. Session storage: a browser restart starts afresh.
 */
export class ConversationAlerts {
  private pending: Promise<unknown> = Promise.resolve();

  constructor(private readonly storage: StorageArea) {}

  /**
   * `show` raises a new alert; `merge` quietly updates the shown one with the
   * combined count; `skip` means this alert was already shown (a replay).
   */
  plan(scope: string, alert: TrackingAlert): Promise<AlertPlan> {
    const next = this.pending.then(async (): Promise<AlertPlan> => {
      const prior = (await this.read())[`${scope}\n${alert.key}`];
      const fresh: AlertPlan = { action: 'show', count: alert.count, render: alert.render };
      if (!prior || !Number.isFinite(alert.firstMs)) return fresh;
      if (alert.lastMs <= prior.lastMs) return { action: 'skip' };
      if (alert.firstMs - prior.lastMs >= CONVERSATION_RENDER_MS) return fresh;
      // The first detection here may continue the opening the shown alert already counted.
      const continues = sameRender(prior.render ?? {}, prior.lastMs, alert.first, alert.firstMs);
      return {
        action: 'merge',
        id: prior.id,
        count: prior.count + alert.count - (continues ? 1 : 0),
        render: continues && alert.count === 1 ? { ...prior.render, ...alert.render } : alert.render,
      };
    });
    this.pending = next.catch(() => undefined);
    return next;
  }

  record(scope: string, alert: TrackingAlert, id: string, { count, render }: { count: number; render: Record<string, number> }): Promise<void> {
    const next = this.pending.then(async () => {
      const shown = await this.read();
      const key = `${scope}\n${alert.key}`;
      delete shown[key];
      shown[key] = { id, count, lastMs: alert.lastMs, render };
      const entries = Object.entries(shown).slice(-MAX_SHOWN);
      await this.storage.set({ [SHOWN_KEY]: Object.fromEntries(entries) });
    });
    this.pending = next.catch(() => undefined);
    return next;
  }

  private async read(): Promise<Shown> {
    const value = (await this.storage.get(SHOWN_KEY))[SHOWN_KEY];
    return value && typeof value === 'object' && !Array.isArray(value) ? { ...(value as Shown) } : {};
  }
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
  const hex = gmailThreadHex(email.gmailThreadId);
  return hex ? `${base}#all/${hex}` : `${base}#sent`;
}
