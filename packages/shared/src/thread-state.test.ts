import { describe, expect, it } from 'vitest';
import {
  THREAD_STATES,
  categoryForThreadState,
  deriveThreadState,
  focusScore,
  focusSectionFor,
  threadStateFromCategory,
} from './thread-state';
import { detectPlaceholders, findPlaceholders, hasUnresolvedPlaceholders, placeholderToken } from './placeholders';

const NOW = new Date('2026-09-28T15:00:00Z');

describe('ThreadState', () => {
  it('maps every state to a legacy category and back', () => {
    for (const state of THREAD_STATES) expect(categoryForThreadState(state)).toBeTruthy();
    expect(threadStateFromCategory('RESPOND')).toBe('NEEDS_REPLY');
    expect(threadStateFromCategory('WAITING')).toBe('WAITING_ON_THEM');
    expect(threadStateFromCategory('PROMOTIONS')).toBe('PROMOTION');
    expect(threadStateFromCategory('FYI', { needsReply: true })).toBe('NEEDS_REPLY');
    expect(categoryForThreadState('FOLLOW_UP_DUE')).toBe('WAITING');
    expect(categoryForThreadState('WAITING_ON_ME')).toBe('RESPOND');
  });

  it('prefers the user, then completion, then what the user owes', () => {
    expect(deriveThreadState({ category: 'RESPOND', userState: 'FYI' })).toBe('FYI');
    expect(deriveThreadState({ category: 'RESPOND', done: true })).toBe('DONE');
    expect(deriveThreadState({ category: 'FYI', needsReply: true })).toBe('NEEDS_REPLY');
    expect(deriveThreadState({ category: 'FYI', openCommitmentsByOwner: 1 })).toBe('WAITING_ON_ME');
  });

  it('turns an outbound thread into waiting, then follow-up due', () => {
    const base = { category: 'WAITING' as const, lastMessageFromOwner: true, now: NOW };
    expect(deriveThreadState({ ...base, followUpDueAt: '2026-09-30T13:00:00Z' })).toBe('WAITING_ON_THEM');
    expect(deriveThreadState({ ...base, followUpDueAt: '2026-09-27T13:00:00Z' })).toBe('FOLLOW_UP_DUE');
    expect(deriveThreadState({ ...base, openCommitmentsByOwner: 2 })).toBe('WAITING_ON_ME');
  });

  it('does not let a notification that needs no reply look actionable', () => {
    expect(deriveThreadState({ category: 'NOTIFICATIONS' })).toBe('NOTIFICATION');
    expect(deriveThreadState({ category: 'NOTIFICATIONS', needsReply: true })).toBe('NEEDS_REPLY');
  });
});

describe('Focus Queue ranking', () => {
  it('places items in one section', () => {
    const at = '2026-09-28T10:00:00Z';
    expect(focusSectionFor({ state: 'NEEDS_REPLY', lastMessageAt: at }, NOW)).toBe('respond');
    expect(focusSectionFor({ state: 'FOLLOW_UP_DUE', lastMessageAt: at }, NOW)).toBe('follow_up');
    expect(focusSectionFor({ state: 'WAITING_ON_THEM', lastMessageAt: at }, NOW)).toBe('waiting');
    expect(focusSectionFor({ state: 'FYI', lastMessageAt: at, deadlineAt: '2026-09-29T12:00:00Z' }, NOW)).toBe('soon');
    expect(focusSectionFor({ state: 'PROMOTION', lastMessageAt: at }, NOW)).toBeNull();
    expect(focusSectionFor({ state: 'FYI', lastMessageAt: at, assignedToMe: true }, NOW)).toBe('assigned');
  });

  it('ranks actionable urgency above recency and explains why', () => {
    const urgent = focusScore({ state: 'NEEDS_REPLY', lastMessageAt: '2026-09-25T10:00:00Z', deadlineAt: '2026-09-29T09:00:00Z', relationshipImportance: 'vip' }, NOW);
    const fresh = focusScore({ state: 'FYI', lastMessageAt: '2026-09-28T14:59:00Z' }, NOW);
    expect(urgent.score).toBeGreaterThan(fresh.score);
    expect(urgent.reasons).toEqual(expect.arrayContaining(['They are waiting on your reply', 'Due within a day', 'From someone you marked important', 'Unanswered for 3 days']));
    const unsure = focusScore({ state: 'NEEDS_REPLY', lastMessageAt: '2026-09-28T10:00:00Z', confidence: 0.3 }, NOW);
    expect(unsure.reasons).toContain('PigeonBox is not sure about this one');
  });
});

describe('placeholders', () => {
  it('finds structured and legacy markers', () => {
    const text = 'Could we meet on [DATE NEEDED]? The fee is [CONFIRM PRICE]. See [LINK].';
    expect(findPlaceholders(text).map((p) => [p.token, p.kind, p.mode])).toEqual([
      ['[DATE NEEDED]', 'date', 'needed'],
      ['[CONFIRM PRICE]', 'amount', 'confirm'],
      ['[LINK]', 'link', 'needed'],
    ]);
    expect(detectPlaceholders('See you on [DATE] at [time]')).toEqual(['[DATE]', '[TIME]']);
    expect(hasUnresolvedPlaceholders(text)).toBe(true);
    expect(hasUnresolvedPlaceholders('All set for Friday.')).toBe(false);
  });

  it('does not treat ordinary brackets as placeholders', () => {
    expect(findPlaceholders('[External] Re: [project-x] update')).toEqual([]);
  });

  it('builds canonical markers', () => {
    expect(placeholderToken('date')).toBe('[DATE NEEDED]');
    expect(placeholderToken('amount', 'confirm')).toBe('[CONFIRM PRICE]');
    expect(findPlaceholders(placeholderToken('address'))[0]!.kind).toBe('address');
  });
});
