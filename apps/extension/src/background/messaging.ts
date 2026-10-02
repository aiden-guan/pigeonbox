/**
 * Trust boundaries for runtime messages.
 *
 * Extension pages (settings, popup, side panel, onboarding, offscreen) run in the
 * extension origin and are trusted. Content scripts run inside Gmail's renderer
 * process; they may only send the message types Gmail integration needs, and
 * they never receive secrets.
 */

/** Messages a Gmail content script is allowed to send. Everything else needs an extension page. */
const CONTENT_SCRIPT_MESSAGES: ReadonlySet<string> = new Set([
  'PING',
  'PRODUCT_EVENT',
  'GET_PUBLIC_SETTINGS',
  'GET_THREAD_INTEL',
  'GET_THREAD_INTEL_MANY',
  'GET_AI_JOB_STATUS',
  'GET_TRACKED_EMAILS',
  'REQUEST_SUMMARY',
  'REQUEST_DRAFT',
  'SUMMARIZE_THREAD',
  'DRAFT_REPLY',
  'WRITE_WITH_AI',
  'INGEST_THREAD',
  'INGEST_THREADS',
  'REPORT_RUNTIME',
  'REPORT_TRACKING',
  'OUTGOING_COMPOSE',
  'CREATE_TRACKED_EMAIL',
  'MARK_TRACKED_SENT',
  'SYNC_TRACKED_LINKS',
  'CANCEL_TRACKED_EMAIL',
  'LINK_TRACKED_EMAIL',
  'SET_NO_REPLY_NOTIFY',
  'TRACKING_POLL',
  'TRACKING_SELF_VIEW',
  // Counted opens and clicks for the tracking card on a sent message. Read-only, no credentials.
  'GET_TRACKING_TIMELINE',
  'SET_CATEGORY',
  'REMIND_THREAD',
  'FOCUS_SIDEPANEL',
  'OPEN_SPLIT',
  'COMMAND',
  'GMAIL_EVENT',
  // Read-only PigeonBox Cloud thread state for the thread card and chips. Decisions stay in extension pages.
  'CLOUD_THREAD_INTEL',
  'CLOUD_THREAD_CONTEXT',
  // InboxSDK's own content-script loader asks the worker to inject its page-world file.
  'inboxsdk__injectPageWorld',
]);

type Sender = { id?: string; url?: string; origin?: string; tab?: { url?: string } };

function extensionOrigin(): string {
  return `chrome-extension://${chrome.runtime.id}`;
}

/** A page served from this extension (settings, popup, side panel, onboarding, offscreen). */
export function isExtensionPageSender(sender: Sender): boolean {
  if (sender.id !== chrome.runtime.id) return false;
  const origin = sender.origin ?? (sender.url ? safeOrigin(sender.url) : null);
  return origin === extensionOrigin();
}

/** A content script from this extension running on Gmail. */
export function isGmailContentScript(sender: Sender): boolean {
  if (sender.id !== chrome.runtime.id) return false;
  const origin = sender.origin ?? (sender.url ? safeOrigin(sender.url) : null);
  return origin === 'https://mail.google.com';
}

export function isContentScriptMessage(type: unknown): boolean {
  return typeof type === 'string' && CONTENT_SCRIPT_MESSAGES.has(type);
}

/** Whether `sender` may send a message of `type`. */
export function senderMaySend(sender: Sender, type: unknown): boolean {
  if (isExtensionPageSender(sender)) return true;
  return isGmailContentScript(sender) && isContentScriptMessage(type);
}

/** `scheme://host[:port]`. Built by hand because URL.origin is "null" for chrome-extension: outside Chrome. */
function safeOrigin(url: string): string | null {
  try {
    const parsed = new URL(url);
    return `${parsed.protocol}//${parsed.host}`;
  } catch {
    return null;
  }
}

/**
 * Keep chrome.storage.local and .session out of content scripts. Settings hold a
 * BYOK key and tracker token, and local storage holds the Cloud refresh token;
 * content scripts get what they need through messages instead.
 */
export async function hardenExtensionStorage(): Promise<void> {
  const areas = [chrome.storage.local, chrome.storage.session] as Array<
    chrome.storage.StorageArea & { setAccessLevel?: (options: { accessLevel: string }) => Promise<void> }
  >;
  for (const area of areas) {
    try {
      await area.setAccessLevel?.({ accessLevel: 'TRUSTED_CONTEXTS' });
    } catch {
      /* Older Chrome without setAccessLevel keeps its default. */
    }
  }
}

/** Push a message to every Gmail tab's content script. Tabs without one are skipped. */
export async function broadcastToGmailTabs(message: unknown): Promise<void> {
  try {
    const tabs = await chrome.tabs.query({ url: 'https://mail.google.com/*' });
    await Promise.all(
      tabs.map((tab) => (tab.id == null ? undefined : chrome.tabs.sendMessage(tab.id, message).catch(() => undefined))),
    );
  } catch {
    /* Worker shutting down. */
  }
}
