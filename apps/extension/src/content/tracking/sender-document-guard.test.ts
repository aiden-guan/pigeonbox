/** @vitest-environment jsdom */
import { afterEach, expect, it, vi } from 'vitest';
import { installSenderDocumentGuard, senderDocumentUrl } from './sender-document-guard';
const base = 'https://cloud.test';
const url = `${base}/d/${'x'.repeat(32)}`;
let guard: ReturnType<typeof installSenderDocumentGuard> | undefined;
afterEach(() => { guard?.destroy(); document.body.innerHTML = ''; vi.restoreAllMocks(); vi.useRealTimers(); });
it('recognizes direct and Gmail-wrapped document URLs only from the configured API', () => {
  expect(senderDocumentUrl(url, base)).toBe(url);
  expect(senderDocumentUrl(url + '#preview=old_proof', base)).toBe(url);
  expect(senderDocumentUrl('https://www.google.com/url?q=' + encodeURIComponent(url), base)).toBe(url);
  for (const raw of [url + '?x=1', url + '#x=1', url.replace('cloud.test', 'evil.test'), 'invalid']) expect(senderDocumentUrl(raw, base)).toBeNull();
});
it('resolves a fresh preview on every sender click without changing the sent link or composer', async () => {
  document.body.innerHTML = `<div class="a3s"><a id="sent" href="${url}" target="_blank">Proposal</a></div><div contenteditable="true"><div class="a3s"><a id="draft" href="${url}">Proposal</a></div></div>`;
  const replace = vi.fn(); vi.spyOn(window, 'open').mockReturnValue({ opener: {}, location: { replace } } as unknown as Window);
  const resolve = vi.fn(async () => `${url}#preview=proof`);
  guard = installSenderDocumentGuard({ getApiBase: () => base, resolve });
  const sent = document.getElementById('sent')!;
  sent.dispatchEvent(new MouseEvent('click', { bubbles: true, cancelable: true }));
  await vi.waitFor(() => expect(replace).toHaveBeenCalledWith(`${url}#preview=proof`));
  sent.dispatchEvent(new MouseEvent('click', { bubbles: true, cancelable: true }));
  await vi.waitFor(() => expect(resolve).toHaveBeenCalledTimes(2));
  expect(sent.getAttribute('href')).toBe(url);
  sent.setAttribute('href', url + '#preview=old_proof');
  sent.dispatchEvent(new MouseEvent('click', { bubbles: true, cancelable: true }));
  await vi.waitFor(() => expect(resolve).toHaveBeenCalledTimes(3));
  expect(resolve).toHaveBeenLastCalledWith(url);
  document.getElementById('draft')!.dispatchEvent(new MouseEvent('click', { bubbles: true, cancelable: true }));
  expect(resolve).toHaveBeenCalledTimes(3);
});
it('opens a recipient link normally when ownership lookup returns no preview', async () => {
  document.body.innerHTML = `<div class="a3s"><a href="${url}" target="_blank">Proposal</a></div>`;
  const replace = vi.fn(); vi.spyOn(window, 'open').mockReturnValue({ opener: {}, location: { replace } } as unknown as Window);
  guard = installSenderDocumentGuard({ getApiBase: () => base, resolve: async () => null });
  document.querySelector('a')!.dispatchEvent(new MouseEvent('click', { bubbles: true, cancelable: true, ctrlKey: true }));
  await vi.waitFor(() => expect(replace).toHaveBeenCalledWith(url));
});

it('retains sender preview protection when refreshing a cached proof fails', async () => {
  document.body.innerHTML = `<div class="a3s"><a href="${url}#preview=old_proof" target="_blank">Proposal</a></div>`;
  const replace = vi.fn(); vi.spyOn(window, 'open').mockReturnValue({ opener: {}, location: { replace } } as unknown as Window);
  guard = installSenderDocumentGuard({ getApiBase: () => base, resolve: async () => { throw new Error('offline'); } });
  document.querySelector('a')!.dispatchEvent(new MouseEvent('click', { bubbles: true, cancelable: true }));
  await vi.waitFor(() => expect(replace).toHaveBeenCalledWith(`${url}#preview=old_proof`));
});
