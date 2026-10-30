import type { Preferences, Slot } from '@pigeonbox/api-contract';
import { addCalendarDays, isBusinessDay, safeTimeZone, zonedParts, zonedTimeToUtc } from '@pigeonbox/shared';
import { clockLabel, localMinutes, rangeLabel, resolveClaimInterval } from './compose-time.js';
import type { IntelDeps } from './context.js';
import { calendarFor, requireFeature, type AccountRow } from './google-access.js';
import { minutesOf } from './preferences.js';

/**
 * Calendar Copilot slot finding. Availability comes only from the user's real
 * free/busy data; a slot is proposed only if it is inside working hours, on a
 * working day, clear of every busy interval plus buffers and focus blocks, and
 * far enough in the future. Nothing here invents availability.
 */

export type Interval = { start: number; end: number };

export type SlotRequest = {
  busy: Array<{ start: string; end: string }>;
  window: { start: Date; end: Date };
  durationMinutes: number;
  timeZone: string;
  workdays: number[];
  workingHours: { start: string; end: string };
  bufferMinutes: number;
  avoidBackToBack: boolean;
  preferMornings: boolean;
  focusBlocks: Preferences['calendar']['focusBlocks'];
  count: number;
  now: Date;
  /** Minimum notice before a proposed start. */
  minNoticeMinutes?: number;
  stepMinutes?: number;
  /** Extra options after the best one per day must start at least this far apart. Default two hours. */
  spreadMinutes?: number;
  /** Check a proposed point time without rounding it to the usual slot grid. */
  exactStart?: boolean;
};

const MINUTE = 60_000;

function overlaps(a: Interval, b: Interval): boolean {
  return a.start < b.end && b.start < a.end;
}

export function proposeSlots(request: SlotRequest): Slot[] {
  const zone = safeTimeZone(request.timeZone);
  const duration = request.durationMinutes * MINUTE;
  const buffer = Math.max(request.bufferMinutes, request.avoidBackToBack ? 15 : 0) * MINUTE;
  const step = (request.stepMinutes ?? 30) * MINUTE;
  const earliest = Math.max(request.window.start.getTime(), request.now.getTime() + (request.minNoticeMinutes ?? 120) * MINUTE);
  const latest = request.window.end.getTime();
  const busy: Interval[] = request.busy
    .map((interval) => ({ start: Date.parse(interval.start), end: Date.parse(interval.end) }))
    .filter((interval) => Number.isFinite(interval.start) && Number.isFinite(interval.end) && interval.end > interval.start);
  const blocked = busy.map((interval) => ({ start: interval.start - buffer, end: interval.end + buffer }));
  const work = { start: minutesOf(request.workingHours.start), end: minutesOf(request.workingHours.end) };

  const candidates: Array<Slot & { dayKey: string; startMs: number }> = [];
  const first = zonedParts(new Date(earliest), zone);
  let day = { year: first.year, month: first.month, day: first.day, weekday: first.weekday };
  for (let i = 0; i < 60; i += 1) {
    const dayStart = zonedTimeToUtc({ ...day, hour: work.start.hour, minute: work.start.minute }, zone).getTime();
    if (dayStart > latest) break;
    if (isBusinessDay(day, { workdays: request.workdays })) {
      const dayEnd = zonedTimeToUtc({ ...day, hour: work.end.hour, minute: work.end.minute }, zone).getTime();
      const focus: Interval[] = request.focusBlocks
        .filter((block) => block.day === day.weekday)
        .map((block) => ({
          start: zonedTimeToUtc({ ...day, ...minutesOf(block.start) }, zone).getTime(),
          end: zonedTimeToUtc({ ...day, ...minutesOf(block.end) }, zone).getTime(),
        }));
      for (let start = request.exactStart ? request.window.start.getTime() : dayStart; start + duration <= dayEnd; start += step) {
        const slot = { start, end: start + duration };
        if (slot.start < dayStart || slot.start < earliest || slot.end > latest) continue;
        if (blocked.some((interval) => overlaps(slot, interval)) || focus.some((interval) => overlaps(slot, interval))) continue;
        const local = zonedParts(new Date(start), zone);
        const reasons: string[] = [];
        let score = 1;
        if (request.preferMornings && local.hour < 12) {
          score += 0.6;
          reasons.push('Morning, as you prefer');
        }
        const gapBefore = Math.min(...busy.filter((interval) => interval.end <= slot.start).map((interval) => slot.start - interval.end), Infinity);
        const gapAfter = Math.min(...busy.filter((interval) => interval.start >= slot.end).map((interval) => interval.start - slot.end), Infinity);
        if (gapBefore >= 60 * MINUTE && gapAfter >= 60 * MINUTE) {
          score += 0.3;
          reasons.push('Nothing right before or after');
        }
        if (local.minute === 0) score += 0.1;
        score -= i * 0.04;
        candidates.push({
          start: new Date(slot.start).toISOString(),
          end: new Date(slot.end).toISOString(),
          score: Math.round(score * 100) / 100,
          reasons,
          dayKey: `${day.year}-${day.month}-${day.day}`,
          startMs: slot.start,
        });
      }
    }
    day = addCalendarDays(day, 1);
  }

  // Best slot per day first, so options span several days; then fill.
  const byScore = [...candidates].sort((a, b) => b.score - a.score || a.startMs - b.startMs);
  const picked: typeof candidates = [];
  const days = new Set<string>();
  for (const candidate of byScore) {
    if (picked.length >= request.count) break;
    if (days.has(candidate.dayKey)) continue;
    days.add(candidate.dayKey);
    picked.push(candidate);
  }
  for (const candidate of byScore) {
    if (picked.length >= request.count) break;
    if (!picked.includes(candidate) && picked.every((other) => Math.abs(other.startMs - candidate.startMs) >= (request.spreadMinutes ?? 120) * MINUTE)) picked.push(candidate);
  }
  if (picked.length && !picked.some((slot) => slot.reasons.length)) picked[0]!.reasons.push('Soonest opening');
  return picked
    .sort((a, b) => a.startMs - b.startMs)
    .map(({ start, end, score, reasons }) => ({ start, end, score, reasons: reasons.slice(0, 4) }));
}

export function formatSlot(slot: Pick<Slot, 'start' | 'end'>, timeZone: string): string {
  const zone = safeTimeZone(timeZone);
  const start = new Date(slot.start);
  const end = new Date(slot.end);
  const day = new Intl.DateTimeFormat('en-US', { timeZone: zone, weekday: 'long', month: 'short', day: 'numeric' }).format(start);
  const time = new Intl.DateTimeFormat('en-US', { timeZone: zone, hour: 'numeric', minute: '2-digit' });
  const zoneName = new Intl.DateTimeFormat('en-US', { timeZone: zone, timeZoneName: 'short' }).formatToParts(start).find((part) => part.type === 'timeZoneName')?.value ?? zone;
  return `${day}, ${time.format(start)}–${time.format(end)} ${zoneName}`;
}

export type Availability = { slots: Slot[]; calendarsChecked: number; busyHash: string; timeZone: string; note: string };

/** Real free/busy from Google Calendar, then slot proposal. */
export async function availability(
  deps: IntelDeps,
  account: AccountRow,
  prefs: Preferences,
  request: { durationMinutes: number; window: { start: Date; end: Date }; count: number; preferMornings?: boolean; timeZone?: string; minNoticeMinutes?: number; spreadMinutes?: number; exactStart?: boolean },
): Promise<Availability> {
  requireFeature(account, 'calendar_read');
  const timeZone = safeTimeZone(request.timeZone ?? prefs.timeZone);
  const result = await calendarFor(deps, account).freeBusy({ timeMin: request.window.start.toISOString(), timeMax: request.window.end.toISOString(), timeZone });
  const slots = proposeSlots({
    busy: result.busy,
    window: request.window,
    durationMinutes: request.durationMinutes,
    timeZone,
    workdays: prefs.workdays,
    workingHours: prefs.workingHours,
    bufferMinutes: prefs.calendar.bufferMinutes,
    avoidBackToBack: prefs.calendar.avoidBackToBack,
    preferMornings: request.preferMornings ?? prefs.calendar.preferMornings,
    focusBlocks: prefs.calendar.focusBlocks,
    count: request.count,
    now: deps.now(),
    ...(request.minNoticeMinutes !== undefined ? { minNoticeMinutes: request.minNoticeMinutes } : {}),
    ...(request.spreadMinutes !== undefined ? { spreadMinutes: request.spreadMinutes } : {}),
    ...(request.exactStart !== undefined ? { exactStart: request.exactStart } : {}),
  });
  const digest = new Uint8Array(await crypto.subtle.digest('SHA-256', new TextEncoder().encode(JSON.stringify(result.busy))));
  const busyHash = [...digest.slice(0, 12)].map((byte) => byte.toString(16).padStart(2, '0')).join('');
  const note =
    result.errors > 0
      ? 'Some calendars could not be read; these times are based on the calendars PigeonBox could check.'
      : slots.length
        ? `Checked ${result.calendarsChecked} calendar${result.calendarsChecked === 1 ? '' : 's'} in ${timeZone}.`
        : 'No open times matched your working hours, buffers and focus blocks in that window.';
  return { slots, calendarsChecked: result.calendarsChecked, busyHash, timeZone, note };
}

/** The next `businessDays` working days starting tomorrow, as a search window. */
export function defaultWindow(now: Date, prefs: Preferences, businessDays = 7): { start: Date; end: Date } {
  const zone = safeTimeZone(prefs.timeZone);
  const p = zonedParts(now, zone);
  let day = addCalendarDays({ year: p.year, month: p.month, day: p.day }, 0);
  let counted = 0;
  let end = day;
  for (let i = 0; i < 30 && counted < businessDays; i += 1) {
    day = addCalendarDays(day, 1);
    if (isBusinessDay(day, { workdays: prefs.workdays })) {
      counted += 1;
      end = day;
    }
  }
  return { start: now, end: zonedTimeToUtc({ ...end, hour: 23, minute: 59 }, zone) };
}

/** "next week" → next Monday–Friday; "this week" → through Friday; otherwise the next seven business days. */
export function windowForConstraints(constraints: string[], now: Date, prefs: Preferences): { start: Date; end: Date } {
  const zone = safeTimeZone(prefs.timeZone);
  if (constraints.some((constraint) => /next week/i.test(constraint))) {
    const p = zonedParts(now, zone);
    const toMonday = (8 - p.weekday) % 7 || 7;
    const monday = addCalendarDays({ year: p.year, month: p.month, day: p.day }, toMonday);
    let last = monday;
    for (let i = 1; i < 7; i += 1) {
      const day = addCalendarDays(monday, i);
      if (isBusinessDay(day, { workdays: prefs.workdays })) last = day;
    }
    return { start: zonedTimeToUtc({ ...monday, hour: 0, minute: 0 }, zone), end: zonedTimeToUtc({ ...last, hour: 23, minute: 59 }, zone) };
  }
  if (constraints.some((constraint) => /this week/i.test(constraint))) {
    const p = zonedParts(now, zone);
    const toFriday = (5 - p.weekday + 7) % 7;
    const friday = addCalendarDays({ year: p.year, month: p.month, day: p.day }, toFriday);
    return { start: now, end: zonedTimeToUtc({ ...friday, hour: 23, minute: 59 }, zone) };
  }
  return defaultWindow(now, prefs);
}

export type RequestedWindow = { start: Date; end: Date; label: string };

/**
 * The specific time an incoming message asks about ("Are you free 1–3pm
 * today?", "anything Thursday afternoon?", "does 2pm tomorrow work?"), read
 * with the same deterministic parser real-time checks use, or null when the
 * message names no single day with a time. Only sentences that ask (a question
 * or an availability word) are read, so a signature or an aside cannot steer it.
 */
export function requestedWindow(text: string, now: Date, prefs: Preferences, reference = now): RequestedWindow | null {
  const zone = safeTimeZone(prefs.timeZone);
  const sentences = text
    .replace(/\r\n?/g, '\n')
    .split(/(?<=[.?!])\s+|\n+/)
    .map((sentence) => sentence.trim())
    .filter((sentence) => sentence && /\?|\b(?:free|available|availability|works? for you|open)\b/i.test(sentence))
    .slice(0, 6);
  const work = { start: minutesOf(prefs.workingHours.start), end: minutesOf(prefs.workingHours.end) };
  for (const sentence of sentences) {
    const interval = resolveClaimInterval(sentence, {
      now: reference,
      timeZone: zone,
      defaultMinutes: prefs.calendar.defaultDurationMinutes,
      workday: { start: work.start.hour * 60 + work.start.minute, end: work.end.hour * 60 + work.end.minute },
    });
    // A whole working day ("free Thursday?") is not a request for specific times.
    if (!interval || (interval.precision === 'span' && !/\b(?:morning|afternoon|evening|tonight|after|before)\b/i.test(sentence))) continue;
    const start = new Date(Math.max(interval.start.getTime(), now.getTime()));
    if (interval.end.getTime() - start.getTime() < 15 * 60_000) continue;
    const range = interval.precision === 'point' ? clockLabel(localMinutes(interval.start, zone)) : rangeLabel(localMinutes(interval.start, zone), localMinutes(interval.end, zone));
    return { start, end: interval.end, label: `${range} ${interval.dayLabel}` };
  }
  return null;
}
