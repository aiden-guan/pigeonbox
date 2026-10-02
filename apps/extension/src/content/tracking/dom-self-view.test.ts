/** @vitest-environment jsdom */
import { afterEach, expect, it, vi } from 'vitest';
import { observeDomSelfViews } from './dom-self-view';
import type { InboxSdkMessageViewLike, MessageSelfViewController } from './message-self-view';

let cleanup: (() => void) | undefined;
afterEach(() => { cleanup?.(); cleanup = undefined; document.body.innerHTML = ''; });
it('keeps loading navigation provisional and awaits inspection of rendered DOM messages', async () => {
  location.hash = '#sent/abc123'; document.body.innerHTML = '<div role="main"></div>';
  let complete!: () => void;
  const inspected = vi.fn(); const views: InboxSdkMessageViewLike[] = [];
  const controller = { handleMessageView: vi.fn((view) => views.push(view)), reinspectActive: vi.fn(() => new Promise<void>((resolve) => { complete = resolve; })), getActiveCount: () => views.length, destroy: vi.fn() } satisfies MessageSelfViewController;
  const observer = observeDomSelfViews(controller, inspected); cleanup = observer.destroy;
  expect(inspected).not.toHaveBeenCalled(); expect(controller.reinspectActive).not.toHaveBeenCalled();
  document.querySelector('[role="main"]')!.innerHTML = '<section data-message-id="msg-1"><div class="a3s">Your sent email</div></section>';
  await vi.waitFor(() => expect(views).toHaveLength(1));
  expect(views[0]!.getMessageID?.()).toBe('msg-1');
  expect(views[0]!.getThreadView?.()?.getThreadID?.()).toBe('abc123');
  expect(inspected).not.toHaveBeenCalled(); complete();
  await vi.waitFor(() => expect(inspected).toHaveBeenCalledOnce());
  location.hash = '#inbox'; window.dispatchEvent(new HashChangeEvent('hashchange'));
  expect(views[0]!.destroyed).toBe(true);
});

it('does not treat a hidden ancestor as an expanded message or scan its own UI mutations', async () => {
  location.hash = '#sent/abc123'; document.body.innerHTML = '<div role="main"><section hidden><div class="a3s">Collapsed</div></section><div data-gi-ui="tracking">badge</div></div>';
  const views: InboxSdkMessageViewLike[] = [];
  const controller = { handleMessageView: vi.fn((view) => views.push(view)), reinspectActive: vi.fn(async () => undefined), getActiveCount: () => views.length, destroy: vi.fn() } satisfies MessageSelfViewController;
  const observer = observeDomSelfViews(controller, vi.fn()); cleanup = observer.destroy;
  expect(views[0]!.getViewState?.()).toBe('COLLAPSED');
  // Let JSDOM deliver the hashchange from setting up this document first.
  await new Promise((resolve) => setTimeout(resolve, 10)); controller.reinspectActive.mockClear();
  document.querySelector('[data-gi-ui]')!.textContent = 'updated';
  await new Promise((resolve) => setTimeout(resolve, 10));
  expect(controller.reinspectActive).not.toHaveBeenCalled();
});
