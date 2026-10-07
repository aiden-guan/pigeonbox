/** @vitest-environment jsdom */
import { act } from 'react';
import { createRoot } from 'react-dom/client';
import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import { WaitingView } from './WaitingView';

(globalThis as unknown as { IS_REACT_ACT_ENVIRONMENT: boolean }).IS_REACT_ACT_ENVIRONMENT = true;
let host: HTMLDivElement;
let root: ReturnType<typeof createRoot>;
const open = vi.fn();
const sent = { trackingId: 'tracked', status: 'SENT', sender: 'owner@example.com', recipients: ['Maya'], gmailThreadId: 'abc123', subject: 'Tracked proposal', sentAt: new Date().toISOString(), openCount: 2, clickCount: 1 };
beforeEach(() => {
  open.mockReset();
  vi.stubGlobal('chrome', { runtime: { sendMessage: vi.fn((message, callback) => {
    if (message.type === 'GET_TRACKED_EMAILS') callback({ emails: [sent] });
    else if (message.type === 'ASK_INBOX') callback({ coverageNote: 'Sent coverage is partial.', items: [
      { threadId: 'abc123', subject: 'Tracked proposal', who: 'to Maya', timestamp: sent.sentAt },
      { threadId: 'def456', subject: 'Other proposal', who: 'to Jordan', timestamp: sent.sentAt },
    ] });
    else callback?.({});
  }) }, storage: { onChanged: { addListener: vi.fn(), removeListener: vi.fn() } } });
  host = document.createElement('div'); document.body.append(host); root = createRoot(host);
});
afterEach(() => { act(() => root.unmount()); host.remove(); vi.unstubAllGlobals(); });
it('keeps untracked sent mail accessible, deduplicates tracked threads, and passes the mailbox owner', async () => {
  await act(async () => root.render(<WaitingView purpose="sent" owner={{ email: 'owner@example.com' }} threads={[]} onCount={() => undefined} onOpenThread={open} />));
  expect(chrome.runtime.sendMessage).toHaveBeenCalledWith({ type: 'ASK_INBOX', query: 'my last 50 sent emails', owner: { email: 'owner@example.com' } }, expect.any(Function));
  expect(host.textContent?.match(/Tracked proposal/g)).toHaveLength(1);
  expect(host.textContent).toContain('Opened 2×');
  expect(host.textContent).toContain('1 click');
  expect(host.textContent).toContain('Sent coverage is partial.');
  await act(async () => [...host.querySelectorAll('button')].find((node) => node.textContent?.includes('Other proposal'))!.click());
  expect(open).toHaveBeenCalledWith('def456', 'sent');
});
it('reports a failed sent-mail load without displaying a false empty state', async () => {
  vi.mocked(chrome.runtime.sendMessage).mockImplementation((...args: unknown[]) => {
    const [message, callback] = args as [{ type: string }, (value: unknown) => void];
    callback?.(message.type === 'GET_TRACKED_EMAILS' ? { emails: [] } : message.type === 'ASK_INBOX' ? { error: 'Local index unavailable.' } : {});
    return Promise.resolve();
  });
  await act(async () => root.render(<WaitingView purpose="sent" threads={[]} onCount={() => undefined} onOpenThread={open} />));
  expect(host.querySelector('[role="alert"]')?.textContent).toContain('Local index unavailable.');
  expect(host.textContent).not.toContain('No sent mail indexed yet.');
});
it('bounds tracked rows and reveals older mail on demand', async () => {
  vi.mocked(chrome.runtime.sendMessage).mockImplementation((...args: unknown[]) => {
    const [message, callback] = args as [{ type: string }, (value: unknown) => void];
    callback?.(message.type === 'GET_TRACKED_EMAILS' ? { emails: Array.from({ length: 25 }, (_, index) => ({ ...sent, trackingId: `email-${index}` })) } : { items: [] });
    return Promise.resolve();
  });
  await act(async () => root.render(<WaitingView purpose="sent" threads={[]} onCount={() => undefined} onOpenThread={open} />));
  expect(host.querySelectorAll('button[aria-expanded]')).toHaveLength(20);
  await act(async () => [...host.querySelectorAll('button')].find((node) => node.textContent?.startsWith('Show more tracked mail'))!.click());
  expect(host.querySelectorAll('button[aria-expanded]')).toHaveLength(25);
});
