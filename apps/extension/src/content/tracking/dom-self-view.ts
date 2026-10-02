import { findMain, findMessageBodies, threadIdFromLocation } from '@pigeonbox/gmail';
import type { InboxSdkMessageViewLike, MessageSelfViewController } from './message-self-view';

/** Adapt the DOM fallback's rendered messages to the same self-view controller as InboxSDK. */
export function observeDomSelfViews(controller: MessageSelfViewController, inspected: () => void, doc = document) {
  const views = new Map<HTMLElement, InboxSdkMessageViewLike>();
  let observer: MutationObserver | null = null;
  let observed: HTMLElement | null = null;
  let threadId: string | undefined;
  const refresh = () => {
    const currentId = threadIdFromLocation(location.hash);
    if (currentId !== threadId) { for (const view of views.values()) view.destroyed = true; views.clear(); threadId = currentId; }
    const root = currentId ? findMain(doc) : null;
    if (root !== observed) {
      observer?.disconnect(); observed = root;
      if (root) { observer = new MutationObserver((mutations) => { if (mutations.some((mutation) => !(mutation.target instanceof Element ? mutation.target : mutation.target.parentElement)?.closest('[data-gi-ui], .gi-track-slot, .gi-cat-chip'))) refresh(); }); observer.observe(root, { childList: true, subtree: true, attributes: true, attributeFilter: ['src', 'data-src', 'style', 'class', 'hidden'] }); }
    }
    for (const [body, view] of views) if (!body.isConnected) { view.destroyed = true; views.delete(body); }
    for (const body of root ? findMessageBodies(root) : []) {
      if (views.has(body)) continue;
      const view: InboxSdkMessageViewLike = {
        getViewState: () => body.isConnected && !body.closest('[hidden], [aria-hidden="true"]') && getComputedStyle(body).display !== 'none' && (typeof body.checkVisibility !== 'function' || body.checkVisibility({ checkVisibilityCSS: true })) ? 'EXPANDED' : 'COLLAPSED',
        getBodyElement: () => body,
        isLoaded: () => body.isConnected,
        getMessageID: () => body.closest('[data-legacy-message-id], [data-message-id]')?.getAttribute('data-legacy-message-id') || body.closest('[data-message-id]')?.getAttribute('data-message-id'),
        getThreadView: () => ({ getThreadID: () => currentId }),
      };
      views.set(body, view); controller.handleMessageView(view);
    }
    // A loading Gmail thread is not an inspected thread. Keep its navigation
    // reservation until rendered messages can actually be inspected.
    if (!currentId || views.size) void controller.reinspectActive().then(inspected);
  };
  refresh();
  window.addEventListener('hashchange', refresh);
  return { refresh, destroy: () => { observer?.disconnect(); window.removeEventListener('hashchange', refresh); for (const view of views.values()) view.destroyed = true; views.clear(); } };
}
