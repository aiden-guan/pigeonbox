/** @vitest-environment jsdom */
import { act } from 'react';
import { createRoot } from 'react-dom/client';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { MemorySettings } from './MemorySettings';

const call = vi.hoisted(() => vi.fn());
vi.mock('../sidepanel/cloud-api', () => ({ callCloud: call }));
(globalThis as unknown as { IS_REACT_ACT_ENVIRONMENT: boolean }).IS_REACT_ACT_ENVIRONMENT = true;
const id = '11111111-1111-4111-8111-111111111111';
const memory = {
  id,
  kind: 'episodic',
  category: 'classes',
  text: 'Midterm 2 covers through Chapter 8.',
  confidence: 0.9,
  status: 'active',
  validFrom: '2026-10-01T10:00:00Z',
  validUntil: '2026-10-31T10:00:00Z',
  lastConfirmedAt: '2026-10-01T10:00:00Z',
  corrected: false,
  entities: [],
  sources: [{ id: 'source-1', kind: 'message', title: 'Midterm 2 Logistics', at: '2026-10-01T10:00:00Z' }],
};
const preferences = {
  memory: { enabled: true, learnFromReceivedMail: true, learnFromSentMail: true, learnFromDraftEdits: true },
  fastRecall: { enabled: false, retentionDays: 30 },
};

describe('Cloud memory transparency controls', () => {
  let container: HTMLDivElement;
  let root: ReturnType<typeof createRoot>;
  beforeEach(async () => {
    call.mockReset();
    call.mockImplementation(async (route: string) => ({
      ok: true,
      data: route === 'preferences' ? { preferences } : { memories: [memory], nextCursor: null },
    }));
    container = document.createElement('div');
    document.body.appendChild(container);
    root = createRoot(container);
    await act(async () => root.render(<MemorySettings />));
  });
  afterEach(async () => {
    await act(async () => root.unmount());
    container.remove();
  });
  const button = (label: string) => {
    const value = [...container.querySelectorAll('button')].find((element) => element.textContent === label);
    if (!value) throw new Error(`Missing button: ${label}`);
    return value;
  };
  it('shows attribution and separates saved facts, learning and optional excerpts', async () => {
    expect(container.textContent).toContain(memory.text);
    expect(container.textContent).toContain('Midterm 2 Logistics');
    expect(container.textContent).toContain('Fast Recall is off');
    call.mockResolvedValueOnce({ ok: true, data: { preferences: { ...preferences, memory: { ...preferences.memory, enabled: false } } } });
    await act(async () => (container.querySelector('[role="switch"]') as HTMLButtonElement).click());
    expect(call).toHaveBeenLastCalledWith('preferencesUpdate', { preferences: { memory: { enabled: false } } });
    expect(container.querySelector('[role="switch"]')?.getAttribute('aria-checked')).toBe('false');
    expect(container.textContent).toContain(memory.text);
  });
  it('forgets through Cloud and removes the displayed fact without local persistence', async () => {
    call.mockResolvedValueOnce({ ok: true, data: { ok: true } });
    await act(async () => button('Forget').click());
    expect(call).toHaveBeenLastCalledWith('memoryForget', { memoryId: id });
    expect(container.textContent).not.toContain(memory.text);
    expect(container.textContent).toContain('original email is unchanged');
  });
  it('requires typed purge confirmation and shows errors without hiding existing facts', async () => {
    await act(async () => button('Forget all memories…').click());
    expect(button('Forget all memories').disabled).toBe(true);
    expect(call.mock.calls.some(([route]) => route === 'memoryPurge')).toBe(false);
    call.mockResolvedValueOnce({ ok: false, code: 'network', reason: 'Reconnect PigeonBox and try again.' });
    await act(async () => button('Forget').click());
    expect(container.querySelector('[role="alert"]')?.textContent).toContain('Reconnect');
    expect(container.textContent).toContain(memory.text);
  });
});
