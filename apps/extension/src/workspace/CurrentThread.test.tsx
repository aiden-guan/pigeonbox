/** @vitest-environment jsdom */
import { act } from 'react';
import { createRoot } from 'react-dom/client';
import { afterEach, expect, it, vi } from 'vitest';
import { CurrentThread } from './CurrentThread';
import type { WorkspaceContext } from './context';

vi.mock('../ui/product-state', () => ({ useProductState: () => ({ has: () => false, state: { cloudOrigins: [], cloud: {}, capabilities: [], runMode: 'local' } }) }));
vi.mock('./Tasks', () => ({ Tasks: () => null }));

afterEach(() => { vi.unstubAllGlobals(); document.body.replaceChildren(); });

it('keeps the current reader mounted and populated during drafting and pending updates', async () => {
  vi.stubGlobal('IS_REACT_ACT_ENVIRONMENT', true);
  let release: ((value: unknown) => void) | undefined;
  const sendMessage = vi.fn(async (message) => {
    if (message.type === 'GET_TRACKED_EMAILS') return { emails: [] };
    if (message.type === 'GET_THREAD_INTEL') {
      if (release) return new Promise((resolve) => { release = resolve; });
      return { classification: { category: 'RESPOND', needsReply: true }, summary: { source: 'model', aiStatus: 'success', summary: { oneLine: 'A long conversation that stays visible.', keyPoints: ['First detail', 'Second detail'] } } };
    }
    return {};
  });
  vi.stubGlobal('chrome', { runtime: { sendMessage }, storage: { onChanged: { addListener: vi.fn(), removeListener: vi.fn() } } });
  const host = document.createElement('div'); document.body.append(host);
  const root = createRoot(host);
  const context: WorkspaceContext = { tabId: 1, threadId: 'abc123', subject: 'Proposal', owner: { email: 'owner@example.test' } };
  await act(async () => root.render(<CurrentThread context={context} onAsk={() => undefined} />));
  expect(host.textContent).toContain('A long conversation that stays visible.');
  const reader = host.querySelector('.pb-current-thread');
  release = () => undefined;
  await act(async () => root.render(<CurrentThread context={{ ...context, drafting: true, pending: 'Drafting…' }} onAsk={() => undefined} />));
  expect(host.querySelector('.pb-current-thread')).toBe(reader);
  expect(host.textContent).toContain('A long conversation that stays visible.');
  expect(sendMessage.mock.calls.filter(([message]) => message.type === 'GET_THREAD_INTEL')).toHaveLength(1);
  await act(async () => root.render(<CurrentThread context={{ ...context, drafting: false }} onAsk={() => undefined} />));
  expect(host.textContent).toContain('A long conversation that stays visible.');
  await act(async () => root.unmount());
});
