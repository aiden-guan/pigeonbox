import { describe, expect, it } from 'vitest';
import {
  addBusinessDaysInZone,
  businessDaysBetween,
  isValidTimeZone,
  localDateKey,
  nextLocalTime,
  safeTimeZone,
  startOfLocalDay,
  zonedParts,
  zonedTimeToUtc,
} from './business-time';

const NY = 'America/New_York';
const TOKYO = 'Asia/Tokyo';

describe('zoned time', () => {
  it('round-trips wall-clock time through a zone', () => {
    const instant = zonedTimeToUtc({ year: 2026, month: 3, day: 4, hour: 9, minute: 30 }, NY);
    expect(instant.toISOString()).toBe('2026-03-04T14:30:00.000Z');
    expect(zonedParts(instant, NY)).toMatchObject({ year: 2026, month: 3, day: 4, hour: 9, minute: 30, weekday: 3 });
  });

  it('handles daylight saving transitions in New York', () => {
    // 2026-03-08: clocks jump from 02:00 to 03:00 EST→EDT.
    expect(zonedTimeToUtc({ year: 2026, month: 3, day: 8, hour: 9, minute: 0 }, NY).toISOString()).toBe('2026-03-08T13:00:00.000Z');
    expect(zonedTimeToUtc({ year: 2026, month: 3, day: 7, hour: 9, minute: 0 }, NY).toISOString()).toBe('2026-03-07T14:00:00.000Z');
    // A time inside the gap lands just after it rather than failing.
    const gap = zonedTimeToUtc({ year: 2026, month: 3, day: 8, hour: 2, minute: 30 }, NY);
    expect(zonedParts(gap, NY).hour).toBe(3);
    // 2026-11-01: 01:30 happens twice; the earlier instant wins.
    expect(zonedTimeToUtc({ year: 2026, month: 11, day: 1, hour: 1, minute: 30 }, NY).toISOString()).toBe('2026-11-01T05:30:00.000Z');
  });

  it('keys local dates by the zone, not UTC', () => {
    const lateEvening = new Date('2026-09-26T03:00:00Z'); // Friday 23:00 in New York, Saturday noon in Tokyo
    expect(localDateKey(lateEvening, NY)).toBe('2026-09-25');
    expect(localDateKey(lateEvening, TOKYO)).toBe('2026-09-26');
    expect(startOfLocalDay(lateEvening, NY).toISOString()).toBe('2026-09-25T04:00:00.000Z');
  });

  it('validates zones and falls back to UTC', () => {
    expect(isValidTimeZone(NY)).toBe(true);
    expect(isValidTimeZone('Mars/Olympus')).toBe(false);
    expect(safeTimeZone('Mars/Olympus')).toBe('UTC');
    expect(safeTimeZone(undefined)).toBe('UTC');
  });
});

describe('business days', () => {
  it('skips weekends in the user zone', () => {
    // Thursday 2026-09-24 16:00 New York + 3 business days = Tuesday 2026-09-29 16:00.
    const sent = zonedTimeToUtc({ year: 2026, month: 9, day: 24, hour: 16, minute: 0 }, NY);
    const due = addBusinessDaysInZone(sent, 3, NY);
    expect(zonedParts(due, NY)).toMatchObject({ year: 2026, month: 9, day: 29, hour: 16, minute: 0 });
  });

  it('uses the local weekday, which can differ from UTC', () => {
    // Friday 23:00 in New York is already Saturday in UTC. One business day later is Monday.
    const friday = new Date('2026-09-26T03:00:00Z');
    expect(localDateKey(addBusinessDaysInZone(friday, 1, NY), NY)).toBe('2026-09-28');
    // In Tokyo the same instant is Saturday, so one business day later is Monday too, not Tuesday.
    expect(localDateKey(addBusinessDaysInZone(friday, 1, TOKYO), TOKYO)).toBe('2026-09-28');
  });

  it('moves to a fixed local time for "the morning it is due"', () => {
    const sent = zonedTimeToUtc({ year: 2026, month: 9, day: 25, hour: 17, minute: 45 }, NY);
    const due = addBusinessDaysInZone(sent, 2, NY, { at: { hour: 8, minute: 0 } });
    expect(zonedParts(due, NY)).toMatchObject({ day: 29, hour: 8, minute: 0 });
  });

  it('respects holidays and custom work weeks', () => {
    const monday = zonedTimeToUtc({ year: 2026, month: 12, day: 21, hour: 10, minute: 0 }, NY);
    const due = addBusinessDaysInZone(monday, 4, NY, { holidays: ['2026-12-24', '2026-12-25'] });
    expect(localDateKey(due, NY)).toBe('2026-12-29');
    // Sunday–Thursday week.
    const thursday = zonedTimeToUtc({ year: 2026, month: 9, day: 24, hour: 10, minute: 0 }, 'Asia/Jerusalem');
    expect(localDateKey(addBusinessDaysInZone(thursday, 1, 'Asia/Jerusalem', { workdays: [0, 1, 2, 3, 4] }), 'Asia/Jerusalem')).toBe('2026-09-27');
  });

  it('counts elapsed business days', () => {
    const thursday = zonedTimeToUtc({ year: 2026, month: 9, day: 24, hour: 9, minute: 0 }, NY);
    const nextWednesday = zonedTimeToUtc({ year: 2026, month: 9, day: 30, hour: 9, minute: 0 }, NY);
    expect(businessDaysBetween(thursday, nextWednesday, NY)).toBe(4);
    expect(businessDaysBetween(thursday, thursday, NY)).toBe(0);
    expect(businessDaysBetween(nextWednesday, thursday, NY)).toBe(0);
  });

  it('finds the next local time on a business day', () => {
    const saturday = zonedTimeToUtc({ year: 2026, month: 9, day: 26, hour: 7, minute: 0 }, NY);
    const next = nextLocalTime(saturday, { hour: 8, minute: 0 }, NY, { businessDaysOnly: true });
    expect(zonedParts(next, NY)).toMatchObject({ day: 28, hour: 8, minute: 0, weekday: 1 });
    const sameDay = nextLocalTime(saturday, { hour: 8, minute: 0 }, NY);
    expect(zonedParts(sameDay, NY)).toMatchObject({ day: 26, hour: 8 });
  });
});
