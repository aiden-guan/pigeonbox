import type { SdkComposeView } from '../tracking/compose-tracking';

type View = SdkComposeView & { insertLinkIntoBodyAtCursor?: (text: string, url: string) => void };
const views = new Map<string, View>();
const attached = new WeakSet<object>();

/** Track links are inserted into exactly the composer that invoked the flow. No sending method is called. */
export function attachDocumentAction(view: View, available: () => boolean) {
  if (attached.has(view) || !view.addButton) return;
  attached.add(view);
  const id = crypto.randomUUID();
  views.set(id, view);
  view.on?.('destroy', () => views.delete(id));
  view.addButton({
    title: 'Track with PigeonBox',
    iconUrl: chrome.runtime.getURL('icons/icon16.png'),
    onClick: () => {
      if (!available()) return;
      chrome.runtime.sendMessage({ type: 'FOCUS_SIDEPANEL', mode: 'cloud', section: 'documents', composeId: id });
    },
  });
}

export function insertDocumentLink(message: { composeId?: unknown; url?: unknown; title?: unknown }): {
  ok: boolean;
  reason?: string;
} {
  const view = typeof message.composeId === 'string' ? views.get(message.composeId) : undefined;
  if (!view || typeof message.url !== 'string')
    return { ok: false, reason: 'The selected composer is closed. Choose a composer and try again.' };
  try {
    const url = new URL(message.url);
    if (url.protocol !== 'https:' && !(url.protocol === 'http:' && ['127.0.0.1', 'localhost'].includes(url.hostname)))
      return { ok: false, reason: 'This document link is invalid.' };
    if (url.username || url.password || url.search || url.hash || !/^\/d\/[A-Za-z0-9_-]{16,200}$/.test(url.pathname))
      return { ok: false, reason: 'This document link is invalid.' };
    const title = typeof message.title === 'string' ? message.title.slice(0, 300) : 'Document';
    if (view.insertLinkIntoBodyAtCursor) view.insertLinkIntoBodyAtCursor(title, url.href);
    else {
      const body = view.getBodyElement?.();
      if (!body?.isConnected) return { ok: false, reason: 'Open the selected composer and try again.' };
      const anchor = document.createElement('a');
      anchor.textContent = title;
      anchor.href = url.href;
      body.append(document.createElement('br'), anchor);
      body.dispatchEvent(new Event('input', { bubbles: true }));
    }
    return { ok: true };
  } catch {
    return { ok: false, reason: 'Could not insert the link into this composer.' };
  }
}
