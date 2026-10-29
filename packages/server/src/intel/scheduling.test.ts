import { describe, expect, it } from 'vitest';
import { DEFAULT_PREFERENCES } from './preferences.js';
import { proposeSlots, requestedWindow } from './scheduling.js';

// Monday, October 5, 2026, 09:00 in Los Angeles.
const now = new Date('2026-10-05T16:00:00Z');
const prefs = { ...DEFAULT_PREFERENCES, timeZone: 'America/Los_Angeles' };

describe('the time a scheduling email asks about', () => {
  it('reads a range, a daypart or a point on one day', () => {
    expect(requestedWindow('Hey Ada,\n\nAre you free 1-3pm today?\n\nThanks', now, prefs)).toEqual({
      start: new Date('2026-10-05T20:00:00Z'),
      end: new Date('2026-10-05T22:00:00Z'),
      label: '1–3 PM today',
    });
    expect(requestedWindow('Could we chat Wednesday afternoon?', now, prefs)).toMatchObject({ start: new Date('2026-10-07T19:00:00Z'), end: new Date('2026-10-08T00:00:00Z'), label: '12–5 PM on Wednesday' });
    expect(requestedWindow('Does 2pm tomorrow work for you?', now, prefs)).toMatchObject({ start: new Date('2026-10-06T21:00:00Z'), label: '2 PM tomorrow' });
  });

  it('gives up on a whole day, several days, a past time or a statement that is not a request', () => {
    expect(requestedWindow('Are you free Thursday?', now, prefs)).toBeNull();
    expect(requestedWindow('Are you free Tuesday or Wednesday at 3?', now, prefs)).toBeNull();
    expect(requestedWindow('Were you free at 7am today?', now, prefs)).toBeNull();
    expect(requestedWindow('I had lunch at 1pm tomorrow with the team.', now, prefs)).toBeNull();
  });

  it('starts no earlier than now inside a window that already began', () => {
    const later = new Date('2026-10-05T20:30:00Z');
    expect(requestedWindow('Are you free 1-3pm today?', later, prefs)?.start).toEqual(later);
  });

  it('resolves relative dates against the message date rather than the draft generation date', () => {
    const later = new Date('2026-10-06T16:00:00Z');
    expect(requestedWindow('Does 2pm tomorrow work for you?', later, prefs, now)?.start).toEqual(new Date('2026-10-06T21:00:00Z'));
    expect(requestedWindow('Does 2pm today work for you?', later, prefs, now)).toBeNull();
  });
});

describe('slot spread', () => {
  const window = { start: new Date('2026-10-05T20:00:00Z'), end: new Date('2026-10-05T22:00:00Z') };
  const base = {
    // 1:45–2:15 PM in Los Angeles, with the default 15-minute buffer on each side.
    busy: [{ start: '2026-10-05T20:45:00Z', end: '2026-10-05T21:15:00Z' }],
    window,
    durationMinutes: 30,
    timeZone: 'America/Los_Angeles',
    workdays: prefs.workdays,
    workingHours: prefs.workingHours,
    bufferMinutes: prefs.calendar.bufferMinutes,
    avoidBackToBack: prefs.calendar.avoidBackToBack,
    preferMornings: false,
    focusBlocks: [],
    count: 3,
    now,
    minNoticeMinutes: 30,
  };

  it('offers every open stretch inside a short requested window when asked to', () => {
    expect(proposeSlots({ ...base, spreadMinutes: 30 }).map((slot) => slot.start)).toEqual(['2026-10-05T20:00:00.000Z', '2026-10-05T21:30:00.000Z']);
  });

  it('keeps the two-hour default spread for multi-day proposals', () => {
    expect(proposeSlots(base)).toHaveLength(1);
  });

  it('checks a proposed point time as written even when it falls between the normal half-hour slots', () => {
    const point = { start: new Date('2026-10-05T20:10:00Z'), end: new Date('2026-10-05T20:40:00Z') };
    expect(proposeSlots({ ...base, busy: [], window: point, exactStart: true }).map((slot) => slot.start)).toEqual(['2026-10-05T20:10:00.000Z']);
    expect(proposeSlots({ ...base, window: point, exactStart: true })).toHaveLength(0);
    expect(proposeSlots({ ...base, busy: [], window: { start: new Date('2026-10-05T14:10:00Z'), end: new Date('2026-10-05T14:40:00Z') }, exactStart: true })).toHaveLength(0);
  });
});
