import type { ExtensionSettings } from '@pigeonbox/shared';
import type { CloudState } from '@pigeonbox/core';
import type { PigeonBoxCloudClient } from '@pigeonbox/cloud-client';
import { DEFAULT_CLIENT_CONFIG, type ClientConfig } from '@pigeonbox/api-contract';
import { cloudErrorMessage } from '@pigeonbox/cloud-client';
import { isExtensionPageSender, senderMaySend } from '../messaging';
import { cloudThreadStateAvailable, threadIntel } from './thread-state';
import { pageCall } from './page-calls';
import { forgetComposeCheckPreference, handleComposeCheck } from './compose-check';
import { cloudSection } from '../../ui/cloud-features';
import { diagnostics, durationBucket } from '../diagnostics';
import { cloudApiUrl } from '../../config';
import { composeDocument } from './compose-documents';

type Deps = {
  settings: () => ExtensionSettings;
  readState: () => Promise<CloudState>;
  client: () => Promise<PigeonBoxCloudClient | null>;
  documentReceiptScope?: () => Promise<string | null>;
  webUrl: (section?: string) => string | null;
  /** Remote client config in force (defaults when absent). */
  config?: () => Promise<ClientConfig>;
  /** Tell Gmail tabs that remembered context changed, so cached compose answers are dropped. */
  contextChanged?: () => void;
};
const emailPattern = /^[^\s@<>]+@[^\s@<>]+$/;
/** Page calls that change what compose checks can draw on. */
const CONTEXT_ROUTES = new Set(['memoryForget', 'memoryUpdate', 'memoryPurge', 'preferencesUpdate', 'connectionUpdate']);
const gmailId = /^[A-Za-z0-9_-]{1,64}$/;

/** Server routing is isolated from the worker lifecycle. Content callers receive read-only derived context. */
export async function handleCloudRequest(
  message: Record<string, unknown>,
  sender: chrome.runtime.MessageSender,
  deps: Deps,
): Promise<unknown> {
  if (
    [
      'CLOUD_THREAD_INTEL',
      'CLOUD_THREAD_CONTEXT',
      'CLOUD_COMPOSE_CHECK',
      'CLOUD_INTEL_STATE',
      'CLOUD_CALL',
      'CLOUD_OPEN',
      'CLOUD_DOCUMENT_UPLOAD',
      'INSERT_DOCUMENT_LINK',
      'CLOUD_COMPOSE_DOCUMENT',
      'CLOUD_COMPOSE_DOCUMENT_SENT',
      'CLOUD_DOCUMENT_ACTIVITY',
    ].includes(String(message.type)) &&
    !senderMaySend(sender, message.type)
  )
    return { ok: false, code: 'forbidden', reason: 'This caller cannot reach your PigeonBox server.' };
  if (message.type === 'CLOUD_THREAD_INTEL') {
    if (!cloudThreadStateAvailable(await deps.readState(), deps.settings().runMode))
      return { ok: true, available: false, threads: {}, capabilities: [] };
    const client = await deps.client();
    if (!client) return { ok: true, available: false, threads: {}, capabilities: [] };
    const ids = Array.isArray(message.threadIds)
      ? message.threadIds.filter((id): id is string => typeof id === 'string')
      : [];
    const mailbox =
      typeof message.mailbox === 'string' && emailPattern.test(message.mailbox) ? message.mailbox : undefined;
    try {
      const threads = await threadIntel(client, ids, mailbox);
      // Emergency switch: prepared replies are not offered while remote config disables them.
      const preparedOff = (await deps.config?.() ?? DEFAULT_CLIENT_CONFIG).disabledFeatures.includes('prepared_drafts');
      return {
        ok: true,
        available: true,
        threads: preparedOff ? Object.fromEntries(Object.entries(threads).map(([id, intel]) => [id, { ...intel, draft: null }])) : threads,
        capabilities: (await deps.readState()).capabilities,
      };
    } catch (error) {
      return { ok: false, available: true, threads: {}, capabilities: [], reason: cloudErrorMessage(error).message };
    }
  }
  if (message.type === 'CLOUD_THREAD_CONTEXT') {
    const client = await deps.client();
    const state = await deps.readState();
    if (
      !cloudThreadStateAvailable(state, deps.settings().runMode) ||
      !client ||
      typeof message.threadId !== 'string' ||
      !gmailId.test(message.threadId) ||
      !['relationship', 'calendar', 'calendar_status'].includes(String(message.kind))
    )
      return { ok: false, reason: 'This context is unavailable.' };
    const mailbox =
      typeof message.mailbox === 'string' && emailPattern.test(message.mailbox) ? message.mailbox : undefined;
    try {
      const intel = (await threadIntel(client, [message.threadId], mailbox))[message.threadId];
      if (!intel) return { ok: false, reason: 'Your PigeonBox server has not synced this thread yet.' };
      const connections = await client.call('connections');
      const account = connections.accounts.find((item) => item.id === intel.accountId);
      if (!account) return { ok: false, reason: 'Connect this mailbox to your PigeonBox server.' };
      if (message.kind === 'relationship' && state.capabilities.includes('cloud_relationships')) {
        const owners = new Set(connections.accounts.map((item) => item.email.toLowerCase()));
        const other = intel.participants.find((person) => !owners.has(person.email.toLowerCase()));
        if (!other) return { ok: false, reason: 'No other contact was found in this thread.' };
        return { ok: true, data: await client.call('contactBrief', { email: other.email }) };
      }
      // Only whether Calendar is connected for this mailbox: no free/busy is read.
      if (message.kind === 'calendar_status' && state.capabilities.includes('cloud_calendar'))
        return { ok: true, data: { connected: account.features.includes('calendar_read') } };
      if (message.kind === 'calendar' && state.capabilities.includes('cloud_calendar')) {
        if (!account.features.includes('calendar_read'))
          return {
            ok: false,
            reason: 'Calendar is not connected. Add calendar access in Connections on your PigeonBox server.',
            needsConnection: true,
          };
        const prefs = await client.call('preferences');
        const now = Date.now();
        return {
          ok: true,
          data: await client.call('calendarAvailability', {
            accountId: account.id,
            durationMinutes: prefs.preferences.calendar.defaultDurationMinutes,
            window: { start: new Date(now).toISOString(), end: new Date(now + 7 * 86400000).toISOString() },
            timeZone: prefs.preferences.timeZone,
            count: 4,
          }),
        };
      }
      return { ok: false, reason: 'Your PigeonBox server does not offer this for your account.' };
    } catch (error) {
      return { ok: false, reason: cloudErrorMessage(error).message };
    }
  }
  if (message.type === 'CLOUD_COMPOSE_CHECK') {
    // Mode, preference and shape are decided here, in the trusted worker, before anything is sent.
    const started = Date.now();
    const reply = await handleComposeCheck(message.check, { state: await deps.readState(), runMode: deps.settings().runMode, client: deps.client, config: await deps.config?.() });
    // Status and timing only; the clause and the advice never reach diagnostics.
    void diagnostics?.record({ component: 'compose_check', code: reply.status, outcome: reply.status === 'unavailable' ? 'failure' : 'success', duration: durationBucket(Date.now() - started) });
    return reply;
  }
  if (message.type === 'CLOUD_INTEL_STATE') {
    const state = await deps.readState();
    return {
      ok: true,
      available: cloudThreadStateAvailable(state, deps.settings().runMode),
      capabilities: state.capabilities,
      webUrl: deps.webUrl(),
    };
  }
  if (['CLOUD_COMPOSE_DOCUMENT', 'CLOUD_COMPOSE_DOCUMENT_SENT', 'CLOUD_DOCUMENT_ACTIVITY'].includes(String(message.type))) {
    if (message.type === 'CLOUD_COMPOSE_DOCUMENT_SENT') {
      const scope = await deps.documentReceiptScope?.();
      if (!scope) return { ok: false, reason: 'Sign in to your PigeonBox server to link this PDF.' };
      const client = await deps.client();
      if (!client) return { ok: false, reason: 'Sign in to your PigeonBox server to link this PDF.' };
      return composeDocument(message, client, cloudApiUrl(deps.settings()) ?? '', scope);
    }
    const state = await deps.readState();
    if (deps.settings().runMode !== 'cloud' || state.status !== 'ready' || !state.capabilities.includes('cloud_documents'))
      return { ok: false, reason: 'Run PigeonBox on your server to track PDFs.' };
    const client = await deps.client();
    if (!client) return { ok: false, reason: 'Sign in to your PigeonBox server to track PDFs.' };
    if (message.type !== 'CLOUD_DOCUMENT_ACTIVITY') return composeDocument(message, client, cloudApiUrl(deps.settings()) ?? '');
    if (!state.capabilities.includes('cloud_tracking') || typeof message.threadId !== 'string' || !gmailId.test(message.threadId))
      return { ok: false, reason: 'PDF activity is unavailable for this conversation.' };
    try {
      const { events } = await client.call('threadSignals', { threadId: message.threadId });
      return { ok: true, events: events.filter(event => (event.type === 'document_view' || event.type === 'document_download') && event.eventClass === 'RECIPIENT_LIKELY') };
    } catch (error) { return { ok: false, reason: cloudErrorMessage(error).message }; }
  }
  if (!['CLOUD_CALL', 'CLOUD_OPEN', 'CLOUD_DOCUMENT_UPLOAD', 'INSERT_DOCUMENT_LINK'].includes(String(message.type)))
    return undefined;
  if (!isExtensionPageSender(sender))
    return { ok: false, code: 'forbidden', reason: 'This request is only accepted from PigeonBox pages.' };
  if (message.type === 'CLOUD_OPEN') {
    const url = deps.webUrl(cloudSection(message.section));
    if (!url) return { ok: false, code: 'not_configured', reason: 'No PigeonBox server is configured. Add one in Settings → Advanced.' };
    await chrome.tabs.create({ url });
    return { ok: true };
  }
  const client = await deps.client();
  if (!client) return { ok: false, code: 'not_configured', reason: 'Sign in to your PigeonBox server to use this.' };
  if (message.type === 'CLOUD_CALL') {
    if (message.route === 'preferencesUpdate') forgetComposeCheckPreference();
    const result = await pageCall(client, message.route, message.body);
    // Remembered context changed: compose answers cached in Gmail may now be wrong.
    if (CONTEXT_ROUTES.has(String(message.route)) && (result as { ok?: boolean })?.ok) deps.contextChanged?.();
    return result;
  }
  if (!(await deps.readState()).capabilities.includes('cloud_documents'))
    return { ok: false, reason: 'Your PigeonBox server does not offer tracked documents for this account.' };
  if (message.type === 'CLOUD_DOCUMENT_UPLOAD') {
    if (
      typeof message.id !== 'string' ||
      typeof message.bytes !== 'string' ||
      message.bytes.length > 26_666_668 ||
      !/^[A-Za-z0-9+/]*={0,2}$/.test(message.bytes)
    )
      return { ok: false, reason: 'Choose a PDF up to 20 MB.' };
    try {
      const raw = atob(message.bytes);
      const bytes = Uint8Array.from(raw, (character) => character.charCodeAt(0));
      return { ok: true, data: await client.uploadDocument(message.id, bytes) };
    } catch (error) {
      return { ok: false, reason: cloudErrorMessage(error).message };
    }
  }
  try {
    const url = new URL(String(message.url));
    const base = cloudApiUrl(deps.settings());
    if (
      !base ||
      url.origin !== new URL(base).origin ||
      url.username ||
      url.password ||
      url.search ||
      url.hash ||
      !/^\/d\/[A-Za-z0-9_-]{16,200}$/.test(url.pathname)
    )
      return { ok: false, reason: 'Choose a link created by your PigeonBox server.' };
    const stored = await chrome.storage.session.get('documentComposeTarget');
    const target = stored.documentComposeTarget as { tabId?: number; composeId?: string } | undefined;
    if (typeof target?.tabId !== 'number' || !target.composeId)
      return { ok: false, reason: 'Choose “Track PDF” then “More options” in the Gmail composer first.' };
    const tab = await chrome.tabs.get(target.tabId);
    if (!tab.url?.startsWith('https://mail.google.com/'))
      return { ok: false, reason: 'The selected Gmail composer is no longer available.' };
    return await chrome.tabs.sendMessage(target.tabId, {
      type: 'PIGEONBOX_INSERT_DOCUMENT',
      composeId: target.composeId,
      url: url.href,
      title: typeof message.title === 'string' ? message.title.slice(0, 300) : 'Document',
    });
  } catch {
    return { ok: false, reason: 'The selected composer is closed. Choose a Gmail composer and try again.' };
  }
}
