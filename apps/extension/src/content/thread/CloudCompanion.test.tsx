/**
 * @vitest-environment jsdom
 */
import type { ThreadIntel } from '@pigeonbox/api-contract';
import { act } from 'react';
import { createRoot } from 'react-dom/client';
import { describe, expect, it, vi } from 'vitest';
import { CloudCompanion } from './CloudCompanion';

(globalThis as unknown as { IS_REACT_ACT_ENVIRONMENT: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

function intel(overrides: Partial<ThreadIntel> = {}): ThreadIntel {
  return {
    threadId: 't1',
    accountId: '00000000-0000-4000-8000-000000000001',
    subject: 'Pricing',
    participants: [],
    lastMessageAt: '2026-09-28T10:00:00.000Z',
    lastMessageFromOwner: false,
    state: { state: 'NEEDS_REPLY', priority: 'HIGH', urgency: 'high', confidence: 0.8, deadline: { at: '2026-10-02T21:00:00.000Z', explicit: true, label: 'Friday' }, importanceReason: 'Asks you directly', relationshipImportance: 'known', nextAction: { kind: 'reply', label: 'Reply' }, source: 'model', updatedAt: '2026-09-28T10:00:00.000Z' },
    summary: { oneLine: 'Jordan asks about pricing.', keyPoints: [] },
    commitments: [{ id: '00000000-0000-4000-8000-000000000002', direction: 'mine', owner: 'You', text: 'send the quote', dueAt: null, status: 'open', source: { id: 'thread:t1', kind: 'thread', title: 'Pricing' } }],
    followUp: null,
    draft: {
      id: '00000000-0000-4000-8000-000000000003',
      threadId: 't1',
      accountId: '00000000-0000-4000-8000-000000000001',
      kind: 'reply',
      status: 'ready',
      variants: [
        { id: '00000000-0000-4000-8000-000000000004', label: 'recommended', strategy: 'Direct answer', body: 'Hi Jordan,\n\nThe annual price is [CONFIRM PRICE] and [DATE NEEDED].', placeholders: [] },
        { id: '00000000-0000-4000-8000-000000000005', label: 'shorter', strategy: 'Brief', body: 'Hi Jordan, sending a quote shortly.', placeholders: [] },
      ],
      sources: [{ id: 'thread:t1', kind: 'thread', title: 'Pricing for 50 seats' }],
      freshness: { createdAt: '2026-09-28T10:00:00.000Z', basedOnMessageId: null, staleReason: null, refreshAfter: null },
      voice: 'default',
      gmailDraftId: null,
      placedVariantId: null,
      errorCode: null,
    },
    injectionSuspected: true,
    analyzedAt: '2026-09-28T10:00:00.000Z',
    sources: [],
    ...overrides,
  } as ThreadIntel;
}

function render(node: React.ReactNode) {
  const host = document.createElement('div');
  document.body.append(host);
  const root = createRoot(host);
  act(() => root.render(node));
  return host;
}

describe('Cloud thread companion', () => {
  it('shows state, promises, every placeholder, sources and the injection note, all as text', () => {
    const host = render(<CloudCompanion intel={intel()} onUseDraft={() => undefined} />);
    const text = host.textContent ?? '';
    expect(text).toContain('Needs your reply');
    expect(text).toContain('You: send the quote');
    expect(text).toContain('Fill in [CONFIRM PRICE], [DATE NEEDED] before sending.');
    expect(host.querySelectorAll('mark')).toHaveLength(2);
    expect(text).toContain('Used to prepare this draft: Pricing for 50 seats');
    expect(text).toContain('did not follow them');
  });

  it('switches between real variants and hands the chosen body to Gmail’s composer', () => {
    const use = vi.fn();
    const host = render(<CloudCompanion intel={intel()} onUseDraft={use} />);
    const shorter = [...host.querySelectorAll('button')].find((button) => button.textContent === 'Shorter')!;
    act(() => shorter.click());
    act(() => [...host.querySelectorAll('button')].find((button) => button.textContent === 'Use this draft')!.click());
    expect(use).toHaveBeenCalledWith('Hi Jordan, sending a quote shortly.');
  });

  it('never renders mail content as HTML', () => {
    const host = render(<CloudCompanion intel={intel({ commitments: [], draft: null, injectionSuspected: false, state: { ...intel().state, importanceReason: '<img src=x onerror=alert(1)>' } })} onUseDraft={() => undefined} />);
    expect(host.querySelector('img')).toBeNull();
    expect(host.textContent).toContain('<img src=x onerror=alert(1)>');
  });
});
