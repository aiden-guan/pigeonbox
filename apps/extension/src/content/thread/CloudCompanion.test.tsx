/**
 * @vitest-environment jsdom
 */
import type { ThreadIntel } from '@pigeonbox/api-contract';
import { act } from 'react';
import { createRoot } from 'react-dom/client';
import { describe, expect, it, vi } from 'vitest';
import { CloudCompanion, cloudOwnsReply, companionIntent, schedulingHeadline, sourceSummary } from './CloudCompanion';

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
  it('leads with the promise, keeps every placeholder visible and opens sources only because trust needs them', () => {
    const host = render(<CloudCompanion intel={intel()} onUseDraft={() => undefined} />);
    const text = host.textContent ?? '';
    expect(text).toContain('You promised: send the quote');
    expect(text).toContain('Fill in [CONFIRM PRICE], [DATE NEEDED] before sending.');
    expect(host.querySelectorAll('mark')).toHaveLength(2);
    expect(text).toContain('did not follow them');
    // Placeholders and injected instructions: provenance comes forward on its own.
    expect(host.querySelector<HTMLDetailsElement>('.pb-cc-sources')!.open).toBe(true);
    expect(host.querySelector('.pb-cc-sources summary')!.textContent).toBe('1 email');
    expect(text).not.toContain('Used to prepare this draft');
    expect(text).not.toContain('Reply prepared');
  });

  it('keeps sources one click away when nothing is wrong', () => {
    const clean = intel({ injectionSuspected: false, draft: { ...intel().draft!, variants: [{ ...intel().draft!.variants[1]! }] } });
    const host = render(<CloudCompanion intel={clean} onUseDraft={() => undefined} />);
    expect(host.querySelector<HTMLDetailsElement>('.pb-cc-sources')!.open).toBe(false);
  });

  it('switches between real variants and hands the chosen body to Gmail’s composer with one action', () => {
    const use = vi.fn();
    const host = render(<CloudCompanion intel={intel()} onUseDraft={use} />);
    const shorter = [...host.querySelectorAll('button')].find((button) => button.textContent === 'Shorter')!;
    act(() => shorter.click());
    expect(host.querySelectorAll('.gi-action')).toHaveLength(1);
    act(() => [...host.querySelectorAll('button')].find((button) => button.textContent === 'Use reply')!.click());
    expect(use).toHaveBeenCalledWith('Hi Jordan, sending a quote shortly.');
  });

  it('shows a scheduling thread without any calendar card, and one dominant action', () => {
    const scheduling = intel({
      commitments: [],
      injectionSuspected: false,
      state: { ...intel().state, nextAction: { kind: 'schedule', label: 'Propose times' } },
      draft: { ...intel().draft!, kind: 'scheduling', variants: [{ ...intel().draft!.variants[0]!, body: 'Hey Maya,\n\nI can do 1:00–1:30 or 2:30–3:00 today. Either work?\n\nBest,\nAiden' }], sources: [{ id: 'thread:t1', kind: 'thread', title: 'Quick question' }, { id: 'availability:x', kind: 'calendar_event', title: 'Your availability · 2 open times' }] },
    });
    const ask = vi.fn();
    const host = render(<CloudCompanion intel={scheduling} capabilities={['cloud_calendar']} onUseDraft={() => undefined} onAsk={ask} />);
    const text = host.textContent ?? '';
    expect(companionIntent(scheduling)).toBe('scheduling');
    expect(text).toContain('Scheduling · 2 times open');
    expect(text).not.toMatch(/Calendar availability|Check availability|Insert availability/);
    expect(host.querySelectorAll('.gi-action')).toHaveLength(1);
    expect(host.querySelector('.pb-cc-sources summary')!.textContent).toBe('Calendar + 1 email');
    act(() => [...host.querySelectorAll('button')].find((button) => button.textContent === 'Change times')!.click());
    expect(ask).toHaveBeenCalledWith(expect.stringMatching(/free/i));
  });

  it('asks only whether Calendar is connected when a scheduling reply could not use it, and says so quietly', async () => {
    const sendMessage = vi.fn((message: { kind?: string }, reply: (value: unknown) => void) => reply(message.kind === 'calendar_status' ? { ok: true, data: { connected: false } } : {}));
    vi.stubGlobal('chrome', { runtime: { sendMessage, lastError: undefined } });
    try {
      const scheduling = intel({ commitments: [], injectionSuspected: false, draft: { ...intel().draft!, kind: 'scheduling' } });
      const host = render(<CloudCompanion intel={scheduling} capabilities={['cloud_calendar']} onUseDraft={() => undefined} />);
      await act(async () => undefined);
      expect(sendMessage).toHaveBeenCalledWith(expect.objectContaining({ type: 'CLOUD_THREAD_CONTEXT', kind: 'calendar_status' }), expect.any(Function));
      const connect = [...host.querySelectorAll('button')].find((button) => button.textContent === 'Connect Calendar to suggest times')!;
      expect(connect.className).not.toContain('gi-action');
    } finally {
      vi.unstubAllGlobals();
    }
  });

  it('shows how long a thread has waited, offers Follow up when due, and nothing for a done thread', () => {
    const now = Date.now();
    const followUp = { id: '00000000-0000-4000-8000-000000000009', threadId: 't1', accountId: '00000000-0000-4000-8000-000000000001', stage: 'follow_up_due', expectedFrom: [], dueAt: null, reason: 'No reply yet', rule: 'business_days', lastOutboundAt: new Date(now - 4 * 86_400_000 - 1000).toISOString(), lastInboundAt: null, engagement: { likelyOpens: 2, lastLikelyOpenAt: null, clicks: 0 }, draftId: null, snoozedUntil: null } as const;
    const waiting = intel({ commitments: [], draft: null, injectionSuspected: false, lastMessageFromOwner: true, followUp, state: { ...intel().state, state: 'FOLLOW_UP_DUE' } });
    const follow = vi.fn();
    const host = render(<CloudCompanion intel={waiting} onUseDraft={() => undefined} onFollowUp={follow} />);
    expect(host.textContent).toContain('Waiting 4 days · opened 2× · follow-up due');
    expect(cloudOwnsReply(waiting)).toBe(true);
    act(() => [...host.querySelectorAll('button')].find((button) => button.textContent === 'Follow up')!.click());
    expect(follow).toHaveBeenCalled();
    const done = intel({ commitments: [], draft: null, injectionSuspected: false, state: { ...intel().state, state: 'DONE' } });
    expect(render(<CloudCompanion intel={done} onUseDraft={() => undefined} />).textContent).toBe('');
  });

  it('describes a reply already in Gmail without offering to insert it again', () => {
    const placed = intel({ draft: { ...intel().draft!, status: 'placed', gmailDraftId: 'r123' } });
    const host = render(<CloudCompanion intel={placed} onUseDraft={() => undefined} />);
    expect(host.textContent).toContain('Reply drafted in Gmail');
    expect(host.querySelector('.gi-action')).toBeNull();
  });

  it('reads the calendar result for the scheduling headline, never inventing a count', () => {
    const at = (title: string) => [{ id: 'availability:x', kind: 'calendar_event' as const, title }];
    expect(schedulingHeadline(at('Your availability · 1 open time'))).toBe('Scheduling · 1 time open');
    expect(schedulingHeadline(at('Your availability · busy then · 3 other times'))).toBe('Scheduling · busy then · 3 other times');
    expect(schedulingHeadline(at('Your availability'))).toBe('Scheduling · times from your calendar');
    expect(schedulingHeadline([{ id: 'thread:t1', kind: 'thread', title: 'Quick question' }])).toBeNull();
  });

  it('summarizes provenance in one phrase', () => {
    expect(sourceSummary([{ id: 'a', kind: 'calendar_event', title: 'x' }, { id: 'b', kind: 'thread', title: 'y' }, { id: 'c', kind: 'message', title: 'z' }])).toBe('Calendar + 2 emails');
  });

  it('never renders mail content as HTML', () => {
    const host = render(<CloudCompanion intel={intel({ commitments: [], draft: null, injectionSuspected: false, state: { ...intel().state, importanceReason: '<img src=x onerror=alert(1)>' } })} onUseDraft={() => undefined} />);
    expect(host.querySelector('img')).toBeNull();
    expect(host.textContent).toContain('<img src=x onerror=alert(1)>');
  });
});
