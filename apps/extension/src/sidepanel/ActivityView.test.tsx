/** @vitest-environment jsdom */
import { act } from 'react';
import { createRoot } from 'react-dom/client';
import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import { ActivityView } from './ActivityView';

const call = vi.hoisted(() => vi.fn());
vi.mock('./cloud-api', () => ({ callCloud: call }));
vi.mock('../ui/cloud-features', () => ({ openCloud: vi.fn() }));
(globalThis as unknown as { IS_REACT_ACT_ENVIRONMENT: boolean }).IS_REACT_ACT_ENVIRONMENT = true;
let host: HTMLDivElement;
let root: ReturnType<typeof createRoot>;
const button = (name: string) => [...host.querySelectorAll('button')].find((node) => node.textContent?.trim() === name)!;
const follow = (id: string) => ({ followUp: { id, threadId: `thread-${id}`, accountId: `account-${id}`, expectedFrom: [], reason: `Waiting for ${id}`, stage: 'waiting', dueAt: null }, subject: `Subject ${id}` });
const signals = (label: string) => ({ ok: true, data: { attributionNote: 'Opens are observations.', signals: [{ label, explanation: 'A recipient signal.' }], events: [] } });
beforeEach(async () => {
  call.mockReset();
  call.mockImplementation(async (route: string) => route === 'followUps' ? { ok: true, data: { followUps: [follow('one'), follow('two')] } } : { ok: true, data: { events: [] } });
  host = document.createElement('div'); document.body.append(host); root = createRoot(host);
  await act(async () => root.render(<ActivityView waitingOnly capabilities={['cloud_mail_sync', 'cloud_tracking', 'cloud_automations']} onOpenThread={() => undefined} />));
});
afterEach(() => { act(() => root.unmount()); host.remove(); });

it('expands engagement beside its email immediately and never fetches unrelated activity for Waiting', async () => {
  let finish!: (value: unknown) => void;
  call.mockImplementation(() => new Promise((resolve) => { finish = resolve; }));
  await act(async () => button('View engagement').click());
  const row = button('Hide engagement').closest('.gi-shadow-decision')!;
  expect(row.textContent).toContain('Loading engagement…');
  expect(button('Hide engagement').getAttribute('aria-controls')).toBe(row.querySelector('section')!.id);
  expect(call).toHaveBeenLastCalledWith('threadSignals', { threadId: 'thread-one', accountId: 'account-one' });
  expect(call.mock.calls.map(([route]) => route)).toEqual(['followUps', 'threadSignals']);
  await act(async () => finish(signals('Likely opened')));
  expect(row.textContent).toContain('Likely opened');
  expect(row.textContent).toContain('No observed recipient activity yet.');
  await act(async () => button('Hide engagement').click());
  expect(host.querySelector('.pb-engagement')).toBeNull();
});

it('shows failures in the selected row and can retry', async () => {
  call.mockResolvedValue({ ok: false, reason: 'Network unavailable.' });
  await act(async () => button('View engagement').click());
  const row = button('Hide engagement').closest('.gi-shadow-decision')!;
  expect(row.querySelector('[role="alert"]')?.textContent).toContain('Network unavailable.');
  call.mockResolvedValue(signals('Clicked'));
  await act(async () => button('Try again').click());
  expect(row.textContent).toContain('Clicked');
  expect(row.querySelector('[role="alert"]')).toBeNull();
});

it('ignores an older response when another email is selected and hides self activity', async () => {
  let finishOld!: (value: unknown) => void;
  call.mockImplementationOnce(() => new Promise((resolve) => { finishOld = resolve; }));
  await act(async () => button('View engagement').click());
  call.mockResolvedValue({ ok: true, data: { signals: [], attributionNote: '', events: [{ eventClass: 'SELF_LIKELY', type: 'open', at: new Date().toISOString(), explanation: 'Your own preview' }] } });
  await act(async () => button('View engagement').click());
  await act(async () => finishOld(signals('Old response')));
  expect(host.querySelectorAll('.pb-engagement')).toHaveLength(1);
  const row = host.querySelector('.pb-engagement')!.closest('.gi-shadow-decision')!;
  expect(row.textContent).toContain('Subject two');
  expect(row.textContent).toContain('No observed recipient activity yet.');
  expect(host.textContent).not.toContain('Old response');
  expect(host.textContent).not.toContain('Your own preview');
});
