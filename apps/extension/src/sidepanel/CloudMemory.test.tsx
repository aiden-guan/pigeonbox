/** @vitest-environment jsdom */
import { act } from 'react';
import { createRoot } from 'react-dom/client';
import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import { CloudMemory } from './CloudMemory';
const call = vi.hoisted(() => vi.fn());
vi.mock('./cloud-api', () => ({ callCloud: call }));
vi.mock('../ui/Orb', () => ({ Orb: () => <span /> }));
(globalThis as unknown as { IS_REACT_ACT_ENVIRONMENT: boolean }).IS_REACT_ACT_ENVIRONMENT = true;
const memory = { id: '11111111-1111-4111-8111-111111111111', kind: 'preference' as const, category: 'preferences' as const, text: 'I prefer concise replies.', confidence: 1, status: 'active' as const, validFrom: '2026-10-01T10:00:00Z', validUntil: null, lastConfirmedAt: '2026-10-01T10:00:00Z', corrected: true, entities: [], sources: [] };
let container: HTMLDivElement;
let root: ReturnType<typeof createRoot>;
beforeEach(async () => {
  call.mockReset();
  call.mockImplementation(async (route: string) => ({ ok: true, data: route === 'memorySubjects' ? { subjects: [], organizing: false } : { memories: [memory], nextCursor: null } }));
  container = document.createElement('div'); document.body.appendChild(container); root = createRoot(container);
  await act(async () => root.render(<CloudMemory onOpenThread={() => undefined} />));
});
afterEach(async () => { await act(async () => root.unmount()); container.remove(); });
const button = (text: string) => { const found = [...container.querySelectorAll('button')].find(item => item.textContent === text); if (!found) throw new Error(`Missing ${text}`); return found; };
async function fill(selector: string, value: string) { await act(async () => { const input = container.querySelector(selector)!; Object.getOwnPropertyDescriptor(input.tagName === 'TEXTAREA' ? HTMLTextAreaElement.prototype : HTMLInputElement.prototype, 'value')!.set!.call(input, value); input.dispatchEvent(new Event('input', { bubbles: true })); }); }
async function submit(selector: string) { await act(async () => container.querySelector(selector)!.dispatchEvent(new Event('submit', { bubbles: true, cancelable: true }))); }

it('keeps groups closed, shows honest sources and forgets through the trusted Cloud bridge', async () => {
  expect(container.querySelector('.pb-memory-group')?.hasAttribute('open')).toBe(false);
  expect(container.textContent).toContain('Saved directly by you. No email source.');
  call.mockResolvedValueOnce({ ok: true, data: { ok: true } });
  await act(async () => button('Forget').click());
  expect(call).toHaveBeenCalledWith('memoryForget', { memoryId: memory.id });
  expect(container.textContent).not.toContain(memory.text);
  expect(container.querySelector('[role="status"]')?.textContent).toContain('original email stays in Gmail');
});

it('preserves the message and existing facts after a failed memory request', async () => {
  await fill('textarea', 'Remember: I prefer thoughtful replies.');
  call.mockResolvedValueOnce({ ok: false, code: 'network', reason: 'Reconnect and try again.' });
  await submit('.pb-memory-composer');
  expect(container.querySelector('textarea')?.value).toBe('Remember: I prefer thoughtful replies.');
  expect(container.querySelector('[role="alert"]')?.textContent).toContain('Reconnect');
  expect(container.textContent).toContain(memory.text);
  expect(button('Send').disabled).toBe(false);
});

it('answers with cited facts and keeps questions out of local persistence', async () => {
  await fill('textarea', 'What do you remember about my writing?');
  call.mockResolvedValueOnce({ ok: true, data: { answer: 'You prefer concise replies.', memories: [memory], changes: [] } });
  await submit('.pb-memory-composer');
  expect(call).toHaveBeenLastCalledWith('memoryChat', { message: 'What do you remember about my writing?', subject: undefined, history: [] });
  expect(container.querySelector('.pb-memory-answer')?.textContent).toContain('You prefer concise replies.');
  expect(container.querySelector('.pb-memory-answer summary')?.textContent).toBe('Memories used');
  expect(container.querySelector('textarea')?.value).toBe('');
});

it('uses the submitted search for pagination even if the search draft changes', async () => {
  call.mockImplementation(async (route: string, body?: { query?: string; cursor?: string }) => ({ ok: true, data: route === 'memorySubjects' ? { subjects: [], organizing: false } : { memories: [memory], nextCursor: body?.query && !body.cursor ? '1' : null } }));
  await fill('input[type="search"]', 'tea'); await submit('.pb-memory-search');
  await fill('input[type="search"]', 'coffee');
  await act(async () => button('Load more memories').click());
  expect(call).toHaveBeenLastCalledWith('memoryList', { subject: undefined, query: 'tea', cursor: '1', limit: 20 });
  expect(container.querySelectorAll('.pb-memory-fact')).toHaveLength(1);
});

it('keeps the editor open when saving fails and does not report a false confirmation', async () => {
  await act(async () => button('Edit').click()); await fill('[aria-label="Correct this fact"]', 'I prefer detailed technical replies.');
  call.mockResolvedValueOnce({ ok: false, code: 'conflict', reason: 'That memory changed. Reload it.' });
  await submit('.pb-memory-fact form');
  expect(container.querySelector('[aria-label="Correct this fact"]')).not.toBeNull();
  expect(container.querySelector('[role="alert"]')?.textContent).toContain('That memory changed');
  expect(container.querySelector('.pb-memory-notice')).toBeNull();
});
