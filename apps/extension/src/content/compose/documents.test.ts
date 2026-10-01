/** @vitest-environment jsdom */
import { afterEach, expect, it, vi } from 'vitest';
import { attachDocumentAction, insertDocumentLink } from './documents';
afterEach(() => {
  vi.unstubAllGlobals();
  document.body.replaceChildren();
});
it('inserts escaped text into the exact composer that invoked tracking and never calls send', () => {
  const sendMessage = vi.fn();
  vi.stubGlobal('chrome', { runtime: { getURL: (path: string) => path, sendMessage } });
  let click: (() => void) | undefined;
  let destroy: (() => void) | undefined;
  const body = document.createElement('div');
  document.body.append(body);
  const other = document.createElement('div');
  document.body.append(other);
  const send = vi.fn();
  const view = {
    addButton: (item: unknown) => {
      click = (item as { onClick: () => void }).onClick;
    },
    getBodyElement: () => body,
    send,
    on: (_event: string, cb: () => void) => {
      destroy = cb;
    },
  };
  attachDocumentAction(view, () => true);
  attachDocumentAction(view, () => true);
  click!();
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
it('rejects unsafe schemes, credentials, query strings and unrecognized compose targets', () => {
  expect(insertDocumentLink({ composeId: 'unknown', url: 'javascript:alert(1)' }).ok).toBe(false);
});
