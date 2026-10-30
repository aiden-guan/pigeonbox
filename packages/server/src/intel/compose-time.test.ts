import { describe, expect, it } from 'vitest';
import { clockLabel, rangeLabel, resolveClaimInterval, rewriteTime } from './compose-time.js';

// Monday, October 5, 2026, 09:00 in Los Angeles.
const now = new Date('2026-10-05T16:00:00Z');
const base = { now, timeZone: 'America/Los_Angeles', defaultMinutes: 30, workday: { start: 9 * 60, end: 17 * 60 + 30 } };
const resolve = (claim: string, extra: Partial<typeof base> = {}) => resolveClaimInterval(claim, { ...base, ...extra });
const iso = (claim: string, extra: Partial<typeof base> = {}) => {
  const interval = resolve(claim, extra);
  return interval ? [interval.start.toISOString(), interval.end.toISOString(), interval.precision] : null;
};

describe('claim time resolution', () => {
  it('checks explicit all-day availability through the next local midnight, including DST changes', () => {
    expect(iso('I should be free on Sunday all day')).toEqual(['2026-10-11T07:00:00.000Z', '2026-10-12T07:00:00.000Z', 'span']);
    expect(iso('free on Nov 1 the whole day')).toEqual(['2026-11-01T07:00:00.000Z', '2026-11-02T08:00:00.000Z', 'span']);
  });
  it('reads point times in the user’s time zone with the documented am/pm rule', () => {
    expect(iso("I'm free tomorrow at 3")).toEqual(['2026-10-06T22:00:00.000Z', '2026-10-06T22:30:00.000Z', 'point']);
    expect(iso("I'm free tomorrow at 3", { timeZone: 'America/New_York' })).toEqual(['2026-10-06T19:00:00.000Z', '2026-10-06T19:30:00.000Z', 'point']);
    expect(iso('I can meet Wednesday at 11')).toEqual(['2026-10-07T18:00:00.000Z', '2026-10-07T18:30:00.000Z', 'point']);
    expect(iso('Tuesday at 5:30pm works for me')![0]).toBe('2026-10-07T00:30:00.000Z');
    expect(iso('free tomorrow at 9 PM')![0]).toBe('2026-10-07T04:00:00.000Z');
    expect(iso('free tomorrow at noon')![0]).toBe('2026-10-06T19:00:00.000Z');
    expect(iso('free tomorrow at 15:30')![0]).toBe('2026-10-06T22:30:00.000Z');
    expect(iso('Oct 14 at 10am works')![0]).toBe('2026-10-14T17:00:00.000Z');
  });

  it('reads ranges, including a shared am/pm', () => {
    expect(iso('free tomorrow from 2-4')).toEqual(['2026-10-06T21:00:00.000Z', '2026-10-06T23:00:00.000Z', 'range']);
    expect(iso('free tomorrow 10-12pm')).toEqual(['2026-10-06T17:00:00.000Z', '2026-10-06T19:00:00.000Z', 'range']);
    expect(iso('free tomorrow between 11 and 1')).toEqual(['2026-10-06T18:00:00.000Z', '2026-10-06T20:00:00.000Z', 'range']);
  });

  it('uses fixed dayparts, after/before windows and the working day for day-only claims', () => {
    expect(iso("I'm free Thursday morning")).toEqual(['2026-10-08T15:00:00.000Z', '2026-10-08T19:00:00.000Z', 'span']);
    expect(iso('Tuesday afternoon works')).toEqual(['2026-10-06T19:00:00.000Z', '2026-10-07T00:00:00.000Z', 'span']);
    expect(iso('free tomorrow evening')).toEqual(['2026-10-07T00:00:00.000Z', '2026-10-07T04:00:00.000Z', 'span']);
    expect(iso('free this afternoon')![2]).toBe('span');
    expect(iso('free tomorrow after 3')).toEqual(['2026-10-06T22:00:00.000Z', '2026-10-07T01:00:00.000Z', 'span']);
    expect(iso("I'm free tomorrow")).toEqual(['2026-10-06T16:00:00.000Z', '2026-10-07T00:30:00.000Z', 'span']);
    // "morning at 9" is AM; "evening at 7" is PM.
    expect(iso('tomorrow morning at 9 works')![0]).toBe('2026-10-06T16:00:00.000Z');
  });

  it('gives up instead of guessing', () => {
    for (const claim of [
      "I'm free at 3", // no day
      'Free Tuesday or Wednesday at 2', // two days
      "I'm free Monday at 3", // Monday is today: this week or next?
      'free today at 8am', // already over
      'free tomorrow at 25',
      'free tomorrow 4-2pm',
    ])
      expect(resolve(claim), claim).toBeNull();
    expect(resolve("I'm free today at 3")).not.toBeNull();
  });

  it('labels days and keeps the user’s time wording', () => {
    expect(resolve("I'm free tomorrow at 3")).toMatchObject({ dayLabel: 'tomorrow', timeText: { text: 'at 3' } });
    expect(resolve('Wednesday at 11 works')!.dayLabel).toBe('on Wednesday');
    expect(resolve('Oct 14 at 10am works')!.dayLabel).toBe('on Oct 14');
    expect(rangeLabel(14 * 60, 16 * 60)).toBe('2–4 PM');
    expect(rangeLabel(11 * 60, 13 * 60)).toBe('11 AM–1 PM');
    expect(clockLabel(16 * 60 + 30)).toBe('4:30 PM');
    expect(rewriteTime('at 3', 16 * 60 + 30)).toBe('at 4:30');
    expect(rewriteTime('3pm', 16 * 60 + 30)).toBe('4:30pm');
    expect(rewriteTime('at 3 PM', 16 * 60 + 30)).toBe('at 4:30 PM');
    expect(rewriteTime('at 3', 20 * 60)).toBe('at 8 PM');
  });
});
