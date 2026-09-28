/** Desktop notifications for PigeonBox Cloud events (approvals, follow-ups, mentions). */
import type { PigeonBoxCloudClient } from '@pigeonbox/cloud-client';

export const NOTIFICATION_ALARM = 'cloud_notifications';
const SEEN_KEY = 'cloudNotificationsSeenAt';
/** Kinds worth interrupting someone for. Drafts and briefings wait in the side panel. */
const DESKTOP_KINDS = new Set(['approval', 'follow_up_due', 'mention', 'assignment', 'sync_problem']);

type NotificationStore = { get(key: string): Promise<Record<string, unknown>>; set(items: Record<string, unknown>): Promise<void> };

/**
 * Show new Cloud notifications as desktop notifications, once each. Returns
 * how many were shown. The first run only records a starting point, so
 * turning Cloud on does not replay old notifications.
 */
export async function pollNotifications(
  client: PigeonBoxCloudClient,
  store: NotificationStore,
  show: (id: string, kind: string, title: string, message: string) => void,
  now = new Date(),
): Promise<number> {
  const seen = (await store.get(SEEN_KEY))[SEEN_KEY] as string | undefined;
  if (!seen) {
    await store.set({ [SEEN_KEY]: now.toISOString() });
    return 0;
  }
  const prefs = await client.call('preferences', undefined, { timeoutMs: 8_000 }).catch(() => null);
  if (prefs && !prefs.preferences.notifications.extension) {
    await store.set({ [SEEN_KEY]: now.toISOString() });
    return 0;
  }
  const { notifications } = await client.call('notifications', { since: seen, unreadOnly: true, limit: 20 }, { timeoutMs: 8_000 });
  let shown = 0;
  let latest = seen;
  for (const item of notifications) {
    if (item.createdAt > latest) latest = item.createdAt;
    if (!DESKTOP_KINDS.has(item.kind) || item.createdAt <= seen) continue;
    show(`cloud_${item.kind}_${item.id}`, item.kind, item.title, item.body);
    shown += 1;
  }
  await store.set({ [SEEN_KEY]: latest });
  return shown;
}
