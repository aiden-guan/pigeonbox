/**
 * PigeonBox Cloud intelligence for the extension: thread state, prepared
 * drafts, approvals, Ask Pigeon and notifications from the always-on service.
 *
 * Boundaries:
 * - Only in Cloud mode, signed in, with `cloud_mail_sync`. Local mode never
 *   contacts PigeonBox servers from here, not even with thread IDs.
 * - Gmail content scripts may only read thread intelligence
 *   (`CLOUD_THREAD_INTEL`). Everything that changes something (approving,
 *   connecting Google, placing drafts) goes through extension pages, via
 *   `CLOUD_CALL` and an allowlist of contract routes.
 * - Google credentials never reach the extension; the Cloud session token
 *   stays in the service worker.
 */
import type { RouteName, RouteRequest, ThreadIntel } from '@pigeonbox/api-contract';
import { CloudApiError, cloudErrorMessage, InflightCache, type PigeonBoxCloudClient } from '@pigeonbox/cloud-client';
import type { CloudState } from '@pigeonbox/core';

/** Contract routes extension pages may call. Never billing, account deletion, tokens or webhooks. */
export const PAGE_ROUTES: ReadonlySet<RouteName> = new Set<RouteName>([
  'connections',
  'connectStart',
  'connectionUpdate',
  'connectionResync',
  'preferences',
  'preferencesUpdate',
  'threadsIntel',
  'threadStateUpdate',
  'focusQueue',
  'draftGet',
  'draftPrepare',
  'draftPlace',
  'draftFeedback',
  'followUps',
  'followUpUpdate',
  'askPigeon',
  'calendarAvailability',
  'schedulePropose',
  'eventPrepare',
  'eventCreate',
  'meetingBrief',
  'briefings',
  'briefingGet',
  'contactBrief',
  'radar',
  'threadSignals',
  'approvals',
  'approvalDecide',
  'auditList',
  'actionUndo',
  'notifications',
  'notificationsAck',
  'threadTeam',
  'assign',
  'assignmentUpdate',
  'commentAdd',
  'workspaces',
  'snippets',
  'snippetRender',
]);

export function cloudIntelAvailable(state: CloudState, runMode: string): boolean {
  return runMode === 'cloud' && (state.status === 'ready' || state.status === 'not_entitled') && state.capabilities.includes('cloud_mail_sync');
}

/** Gmail asks for the same threads from chips, the thread card and the side panel at once. */
const intelCache = new InflightCache<ThreadIntel | null>(20_000, 400);

export function forgetThreadIntel(threadId?: string): void {
  intelCache.invalidate(threadId);
}

const cacheKey = (mailbox: string | undefined, threadId: string) => `${mailbox ?? ''}|${threadId}`;

/**
 * Thread intelligence for up to 40 threads, fetched in one request and cached
 * briefly. Threads Cloud has not synced come back absent.
 */
export async function threadIntel(client: PigeonBoxCloudClient, threadIds: string[], mailbox?: string): Promise<Record<string, ThreadIntel>> {
  const ids = [...new Set(threadIds.filter((id) => typeof id === 'string' && /^[A-Za-z0-9_-]{1,64}$/.test(id)))].slice(0, 40);
  const result: Record<string, ThreadIntel> = {};
  const missing: string[] = [];
  for (const id of ids) {
    const cached = intelCache.peek(cacheKey(mailbox, id));
    if (cached === undefined) missing.push(id);
    else if (cached) result[id] = cached;
  }
  if (missing.length) {
    const response = await client.call('threadsIntel', { threadIds: missing, ...(mailbox ? { mailbox } : {}) }, { timeoutMs: 8_000 });
    for (const id of missing) {
      const intel = response.threads[id] ?? null;
      intelCache.set(cacheKey(mailbox, id), intel);
      if (intel) result[id] = intel;
    }
  }
  return result;
}

/** One allowlisted contract call from an extension page. Errors come back as plain, user-facing text. */
export async function pageCall(client: PigeonBoxCloudClient, route: unknown, body: unknown): Promise<{ ok: true; data: unknown } | { ok: false; code: string; reason: string }> {
  if (typeof route !== 'string' || !PAGE_ROUTES.has(route as RouteName)) return { ok: false, code: 'forbidden', reason: 'That PigeonBox Cloud action is not available here.' };
  try {
    const data = await client.call(route as RouteName, body as RouteRequest<RouteName>);
    // Anything that changes a thread makes cached intelligence stale.
    if (/^(threadStateUpdate|draft|followUpUpdate|approvalDecide|actionUndo|eventCreate)/.test(route)) forgetThreadIntel();
    return { ok: true, data };
  } catch (error) {
    const code = error instanceof CloudApiError ? error.code : 'network';
    const fallback = cloudErrorMessage(error).message;
    const reason = error instanceof CloudApiError && ['conflict', 'forbidden', 'invalid_request', 'not_found'].includes(error.code) ? error.message : fallback;
    return { ok: false, code, reason };
  }
}

// ---------------------------------------------------------------------------
// Notifications
// ---------------------------------------------------------------------------

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
