/**
 * The only way extension pages (side panel, settings) change anything in
 * PigeonBox Cloud: `CLOUD_CALL` with a contract route from an allowlist.
 * Approving, connecting Google and placing drafts all go through here.
 */
import type { RouteName, RouteRequest } from '@pigeonbox/api-contract';
import { CloudApiError, cloudErrorMessage, type PigeonBoxCloudClient } from '@pigeonbox/cloud-client';
import { forgetThreadIntel } from './thread-state';

/** Contract routes extension pages may call. Never billing, account deletion, tokens or webhooks. */
export const PAGE_ROUTES: ReadonlySet<RouteName> = new Set<RouteName>([
  'cloudOverview',
  'briefingGenerate',
  'views', 'viewCompile', 'viewSave', 'viewResults', 'viewShadow', 'viewReview',
  'automations', 'automationCompile', 'automationSave', 'automationRuns',
  'contacts',
  'documents', 'documentCreate', 'documentLinkCreate', 'documentAnalytics',
  'connections',
  'connectStart',
  'connectionUpdate',
  'connectionResync',
  'memoryList', 'memoryGet', 'memoryForget', 'memoryUpdate', 'memoryPurge',
  'preferences',
  'preferencesUpdate',
  'threadsIntel',
  'threadStateUpdate',
  'focusQueue',
  'draftList',
  'draftGet',
  'draftPrepare',
  'draftPlace',
  'draftFeedback',
  'followUps',
  'followUpUpdate',
  'askPigeon',
  'askFeedback',
  'tasks',
  'taskCreate',
  'taskUpdate',
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

/** One allowlisted contract call from an extension page. Errors come back as plain, user-facing text. */
export async function pageCall(client: PigeonBoxCloudClient, route: unknown, body: unknown): Promise<{ ok: true; data: unknown } | { ok: false; code: string; reason: string }> {
  if (typeof route !== 'string' || !PAGE_ROUTES.has(route as RouteName)) return { ok: false, code: 'forbidden', reason: 'That PigeonBox Cloud action is not available here.' };
  try {
    const data = await client.call(route as RouteName, body as RouteRequest<RouteName>);
    // Anything that changes a thread makes cached intelligence stale.
    if (/^(threadStateUpdate|draft(?!List)|followUpUpdate|approvalDecide|actionUndo|eventCreate)/.test(route)) forgetThreadIntel();
    return { ok: true, data };
  } catch (error) {
    const code = error instanceof CloudApiError ? error.code : 'network';
    const fallback = cloudErrorMessage(error).message;
    const reason = error instanceof CloudApiError && ['conflict', 'forbidden', 'invalid_request', 'not_found'].includes(error.code) ? error.message : fallback;
    return { ok: false, code, reason };
  }
}
