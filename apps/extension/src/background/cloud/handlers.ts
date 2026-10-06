import type { ExtensionSettings } from '@pigeonbox/shared';
import type { CloudState } from '@pigeonbox/core';
import type { PigeonBoxCloudClient } from '@pigeonbox/cloud-client';
import { cloudErrorMessage } from '@pigeonbox/cloud-client';
import { isExtensionPageSender, senderMaySend } from '../messaging';
import { cloudThreadStateAvailable, threadIntel } from './thread-state';
import { pageCall } from './page-calls';
import { forgetComposeCheckPreference, handleComposeCheck } from './compose-check';
import { cloudSection } from '../../ui/cloud-features';
import { CLOUD_WAITLIST_URL, cloudApiUrl } from '../../config';

type Deps = {
  settings: () => ExtensionSettings;
  readState: () => Promise<CloudState>;
  client: () => Promise<PigeonBoxCloudClient | null>;
  webUrl: (section?: string) => string | null;
};
const emailPattern = /^[^\s@<>]+@[^\s@<>]+$/;
const gmailId = /^[A-Za-z0-9_-]{1,64}$/;

/** Cloud routing is isolated from the worker lifecycle. Content callers receive read-only derived context. */
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
    ].includes(String(message.type)) &&
    !senderMaySend(sender, message.type)
  )
    return { ok: false, code: 'forbidden', reason: 'This caller cannot access PigeonBox Cloud.' };
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
      return {
        ok: true,
        available: true,
        threads: await threadIntel(client, ids, mailbox),
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
      !['relationship', 'calendar'].includes(String(message.kind))
    )
      return { ok: false, reason: 'This context is unavailable.' };
    const mailbox =
      typeof message.mailbox === 'string' && emailPattern.test(message.mailbox) ? message.mailbox : undefined;
    try {
      const intel = (await threadIntel(client, [message.threadId], mailbox))[message.threadId];
      if (!intel) return { ok: false, reason: 'Cloud has not synced this thread yet.' };
      const connections = await client.call('connections');
      const account = connections.accounts.find((item) => item.id === intel.accountId);
      if (!account) return { ok: false, reason: 'Connect this mailbox to Cloud.' };
      if (message.kind === 'relationship' && state.capabilities.includes('cloud_relationships')) {
        const owners = new Set(connections.accounts.map((item) => item.email.toLowerCase()));
        const other = intel.participants.find((person) => !owners.has(person.email.toLowerCase()));
        if (!other) return { ok: false, reason: 'No other contact was found in this thread.' };
        return { ok: true, data: await client.call('contactBrief', { email: other.email }) };
      }
      if (message.kind === 'calendar' && state.capabilities.includes('cloud_calendar')) {
        if (!account.features.includes('calendar_read'))
          return {
            ok: false,
            reason: 'Calendar is not connected. Add calendar access in Cloud Connections.',
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
      return { ok: false, reason: 'This context is not granted for your Cloud account.' };
    } catch (error) {
      return { ok: false, reason: cloudErrorMessage(error).message };
    }
  }
  if (message.type === 'CLOUD_COMPOSE_CHECK') {
    // Mode, preference and shape are decided here, in the trusted worker, before anything is sent.
    return handleComposeCheck(message.check, { state: await deps.readState(), runMode: deps.settings().runMode, client: deps.client });
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
  if (!['CLOUD_CALL', 'CLOUD_OPEN', 'CLOUD_DOCUMENT_UPLOAD', 'INSERT_DOCUMENT_LINK'].includes(String(message.type)))
    return undefined;
  if (!isExtensionPageSender(sender))
    return { ok: false, code: 'forbidden', reason: 'This request is only accepted from PigeonBox pages.' };
  if (message.type === 'CLOUD_OPEN') {
    const url = deps.webUrl(cloudSection(message.section)) ?? CLOUD_WAITLIST_URL;
    await chrome.tabs.create({ url });
    return { ok: true };
  }
  const client = await deps.client();
  if (!client) return { ok: false, code: 'not_configured', reason: 'Turn on Cloud and sign in to use this.' };
  if (message.type === 'CLOUD_CALL') {
    if (message.route === 'preferencesUpdate') forgetComposeCheckPreference();
    return pageCall(client, message.route, message.body);
  }
  if (!(await deps.readState()).capabilities.includes('cloud_documents'))
    return { ok: false, reason: 'Tracked documents are not available for this Cloud connection.' };
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
      return { ok: false, reason: 'Choose a link created by this Cloud connection.' };
    const stored = await chrome.storage.session.get('documentComposeTarget');
    const target = stored.documentComposeTarget as { tabId?: number; composeId?: string } | undefined;
    if (typeof target?.tabId !== 'number' || !target.composeId)
      return { ok: false, reason: 'Choose “Track with PigeonBox” in the Gmail composer first.' };
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
