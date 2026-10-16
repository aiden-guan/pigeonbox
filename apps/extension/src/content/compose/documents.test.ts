/** @vitest-environment jsdom */
import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import { attachDocumentAction, documentActionForCompose, insertDocumentLink } from './documents';
beforeEach(() => {
  HTMLDialogElement.prototype.showModal = function () { this.open = true; };
  HTMLDialogElement.prototype.close = function () { this.open = false; this.dispatchEvent(new Event('close')); };
});
afterEach(() => {
  vi.unstubAllGlobals();
  document.body.replaceChildren();
});
it('inserts escaped text into the exact composer that invoked tracking and never calls send', () => {
  const sendMessage = vi.fn();
  vi.stubGlobal('chrome', { runtime: { getURL: (path: string) => path, sendMessage } });
  let destroy: (() => void) | undefined;
  const body = document.createElement('div');
  document.body.append(body);
  const other = document.createElement('div');
  document.body.append(other);
  const send = vi.fn();
  const view = {
    getBodyElement: () => body,
    send,
    on: (event: string, cb: () => void) => {
      if (event === 'destroy') destroy = cb;
    },
  };
  attachDocumentAction(view, () => true);
  attachDocumentAction(view, () => true);
  documentActionForCompose(body)!();
  expect(document.querySelector('[data-gi-ui="document-picker"]')).not.toBeNull();
  [...document.querySelectorAll<HTMLButtonElement>('dialog button')].find(button => button.textContent === 'More options')!.click();
  const composeId = sendMessage.mock.calls[0][0].composeId as string;
  expect(
    insertDocumentLink({
      composeId,
      url: 'https://cloud.test/d/' + 'a'.repeat(20),
      title: '<img src=x onerror=alert(1)>',
    }),
  ).toEqual({ ok: true });
  expect(body.querySelector('img')).toBeNull();
  expect(body.querySelector('a')!.textContent).toContain('<img');
  expect(other.childNodes).toHaveLength(0);
  expect(send).not.toHaveBeenCalled();
  for (const url of [
    'javascript:alert(1)',
    'https://user:pass@cloud.test/d/' + 'a'.repeat(20),
    'https://cloud.test/d/' + 'a'.repeat(20) + '?token=other',
    'https://cloud.test/d/' + 'a'.repeat(20) + '#other',
  ])
    expect(insertDocumentLink({ composeId, url }).ok).toBe(false);
  destroy!();
  expect(insertDocumentLink({ composeId, url: 'https://cloud.test/d/' + 'a'.repeat(20) }).ok).toBe(false);
});
it('adds no Gmail toolbar icon; Track PDF lives in the tracking menu', () => {
  vi.stubGlobal('chrome', { runtime: { getURL: (path: string) => path, sendMessage: vi.fn() } });
  const body = document.createElement('div'); document.body.append(body);
  const addButton = vi.fn();
  attachDocumentAction({ getBodyElement: () => body, addButton }, () => true);
  expect(addButton).not.toHaveBeenCalled();
  expect(documentActionForCompose(body)).toBeTypeOf('function');
});
it('rejects unsafe schemes, credentials, query strings and unrecognized compose targets', () => {
  expect(insertDocumentLink({ composeId: 'unknown', url: 'javascript:alert(1)' }).ok).toBe(false);
});

it('uploads and inserts in the invoking composer, blocks a send in flight, and associates only after Gmail sends', async () => {
  const body = document.createElement('div'); document.body.append(body);
  const events = new Map<string, (event?: any) => void>();
  let finishUpload!: (response: unknown) => void;
  const sendMessage = vi.fn((message, respond) => {
    if (message.type === 'CLOUD_COMPOSE_DOCUMENT') finishUpload = respond;
    else respond?.({ ok: true });
  });
  vi.stubGlobal('chrome', { runtime: { getURL: (path: string) => path, sendMessage } });
  const send = vi.fn();
  attachDocumentAction({ getBodyElement: () => body, on: (name, fn) => { events.set(name, fn); }, send }, () => true);
  documentActionForCompose(body)!();
  const input = document.querySelector<HTMLInputElement>('dialog input')!;
  Object.defineProperty(input, 'files', { value: [{ name: 'Proposal.pdf', size: 16, arrayBuffer: async () => new TextEncoder().encode('%PDF-1.7\nfixture').buffer }] });
  input.dispatchEvent(new Event('change'));
  await vi.waitFor(() => expect(sendMessage).toHaveBeenCalledWith(expect.objectContaining({ type: 'CLOUD_COMPOSE_DOCUMENT', filename: 'Proposal.pdf' }), expect.any(Function)));
  const cancel = vi.fn(); events.get('presending')!({ cancel }); expect(cancel).toHaveBeenCalledOnce();
  expect(body.querySelector('a')).toBeNull();
  finishUpload({ ok: true, link: { id: 'link-id', url: 'https://cloud.test/d/' + 'a'.repeat(32) } });
  await vi.waitFor(() => expect(body.querySelector('a')?.textContent).toBe('Proposal.pdf'));
  expect(document.querySelector('[role="status"]')?.textContent).toContain('Tracked PDF added');
  expect(send).not.toHaveBeenCalled();
  expect(sendMessage.mock.calls.some(([message]) => message.type === 'CLOUD_COMPOSE_DOCUMENT_SENT')).toBe(false);
  events.get('presending')!({ cancel: vi.fn() });
  body.replaceChildren(); // Gmail clears the composer before its receipt resolves.
  events.get('sent')!({ getThreadID: async () => 'abc123' });
  await vi.waitFor(() => expect(sendMessage).toHaveBeenCalledWith({ type: 'CLOUD_COMPOSE_DOCUMENT_SENT', threadId: 'abc123', urls: ['https://cloud.test/d/' + 'a'.repeat(32)] }, expect.any(Function)));
});

it('recovers tracked PDFs from reopened drafts and ignores a removed link', async () => {
  const events = new Map<string, (event?: any) => void>();
  const body = document.createElement('div'); document.body.append(body);
  const url = 'https://cloud.test/d/' + 'a'.repeat(32);
  body.innerHTML = `<a href="${url}">Saved PDF</a>`;
  const sendMessage = vi.fn((_message, callback) => callback?.({ ok: true }));
  vi.stubGlobal('chrome', { runtime: { getURL: (path: string) => path, sendMessage } });
  attachDocumentAction({ getBodyElement: () => body, on: (name, fn) => { events.set(name, fn); } }, () => true);
  events.get('presending')!({}); events.get('sent')!({ getThreadID: async () => 'abc123' });
  await vi.waitFor(() => expect(sendMessage).toHaveBeenCalledWith({ type: 'CLOUD_COMPOSE_DOCUMENT_SENT', threadId: 'abc123', urls: [url] }, expect.any(Function)));
  sendMessage.mockClear(); body.replaceChildren();
  events.get('presending')!({}); events.get('sent')!({ getThreadID: async () => 'abc123' });
  await Promise.resolve(); expect(sendMessage).not.toHaveBeenCalled();
});

it('uses the async Gmail receipt and retains the exact PDF snapshot while the composer disappears', async () => {
  const events = new Map<string, (event?: any) => void>();
  const body = document.createElement('div'); document.body.append(body);
  const url = 'https://cloud.test/d/' + 'a'.repeat(32);
  body.innerHTML = `<a href="${url}">PDF</a>`;
  const sendMessage = vi.fn((_message, callback) => callback?.({ ok: true }));
  vi.stubGlobal('chrome', { runtime: { getURL: (path: string) => path, sendMessage } });
  attachDocumentAction({ getBodyElement: () => body, on: (name, fn) => { events.set(name, fn); } }, () => true);
  events.get('presending')!({});
  let receive!: (id: string) => void;
  events.get('sent')!({ getThreadIDAsync: () => new Promise(resolve => { receive = resolve; }) });
  await Promise.resolve();
  body.replaceChildren(); events.get('presending')!({}); events.get('destroy')!();
  receive('abc123');
  await vi.waitFor(() => expect(sendMessage).toHaveBeenCalledWith({ type: 'CLOUD_COMPOSE_DOCUMENT_SENT', threadId: 'abc123', urls: [url] }, expect.any(Function)));
});

it('leaves Gmail untouched on an invalid file or a failed upload', async () => {
  const body = document.createElement('div'); document.body.append(body);
  const sendMessage = vi.fn((_message, callback) => callback?.({ ok: false, reason: 'Upload unavailable' }));
  vi.stubGlobal('chrome', { runtime: { getURL: (path: string) => path, sendMessage } });
  attachDocumentAction({ getBodyElement: () => body }, () => true);
  documentActionForCompose(body)!();
  const input = document.querySelector<HTMLInputElement>('dialog input')!;
  Object.defineProperty(input, 'files', { configurable: true, value: [{ name: 'broken.pdf', size: 6, arrayBuffer: async () => new TextEncoder().encode('broken').buffer }] });
  input.dispatchEvent(new Event('change'));
  await vi.waitFor(() => expect(document.querySelector('[role="status"]')?.textContent).toContain('valid PDF'));
  expect(sendMessage).not.toHaveBeenCalled();
  Object.defineProperty(input, 'files', { value: [{ name: 'Proposal.pdf', size: 10, arrayBuffer: async () => new TextEncoder().encode('%PDF-1.7').buffer }] });
  input.dispatchEvent(new Event('change'));
  await vi.waitFor(() => expect(document.querySelector('[role="status"]')?.textContent).toBe('Upload unavailable'));
  expect(body.childNodes).toHaveLength(0);
});
