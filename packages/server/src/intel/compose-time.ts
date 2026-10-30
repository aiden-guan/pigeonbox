import { addCalendarDays, safeTimeZone, zonedParts, zonedTimeToUtc } from '@pigeonbox/shared';
import { dateAt, type LocalDay } from './heuristics.js';

/**
 * Real-time Pidgy checks: turn the time a user wrote ("tomorrow at 3",
 * "Tuesday afternoon", "Oct 14 from 2–4") into an interval in their
 * PigeonBox time zone. Deterministic, and it gives up rather than guess:
 * no day, two different days, a weekday that is ambiguous with today, or a
 * time that already passed all return null.
 *
 * Dayparts have fixed meanings, used everywhere:
 *   morning 08:00–12:00 · afternoon 12:00–17:00 · evening/tonight 17:00–21:00
 * A time without am/pm is read as 1–7 → PM, 8–11 → AM, 12 → noon.
 */

export const DAYPARTS = {
  morning: { start: 8 * 60, end: 12 * 60 },
  afternoon: { start: 12 * 60, end: 17 * 60 },
  evening: { start: 17 * 60, end: 21 * 60 },
} as const;

export type ClaimInterval = {
  start: Date;
  end: Date;
  /** point: "at 3" (one meeting length); range: "2–4"; span: a daypart, "after 3", or a whole day. */
  precision: 'point' | 'range' | 'span';
  day: LocalDay;
  /** "today", "tomorrow", "on Tuesday", "on Oct 14". */
  dayLabel: string;
  /** The words naming a point time, so a grounded alternative can replace exactly them. */
  timeText: { index: number; text: string } | null;
};

const MERIDIEM = '(am|pm|a\\.m\\.?|p\\.m\\.?)';
const DAY_TOKEN = /\b(?:today|tonight|tomorrow|(?:next |this )?(?:mon|tue|wed|thu|fri|sat|sun)[a-z]*|(?:jan|feb|mar|apr|may|jun|jul|aug|sept?|oct|nov|dec)[a-z]*\.?\s+\d{1,2}|\d{1,2}(?:st|nd|rd|th)?\s+(?:of\s+)?(?:jan|feb|mar|apr|may|jun|jul|aug|sept?|oct|nov|dec)[a-z]*|\d{1,2}\/\d{1,2})\b/gi;
const WEEKDAY_NAMES = ['Sunday', 'Monday', 'Tuesday', 'Wednesday', 'Thursday', 'Friday', 'Saturday'];
const MONTH_NAMES = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'];

const dayKey = (day: Pick<LocalDay, 'year' | 'month' | 'day'>) => `${day.year}-${day.month}-${day.day}`;

function todayIn(now: Date, zone: string): LocalDay {
  const p = zonedParts(now, zone);
  return { year: p.year, month: p.month, day: p.day, weekday: p.weekday };
}

/** Every day the text names. Each match is resolved by the same parser commitments and deadlines use. */
export function daysIn(text: string, now: Date, timeZone: string): Array<{ day: LocalDay; label: string; index: number; text: string }> {
  const zone = safeTimeZone(timeZone);
  const today = todayIn(now, zone);
  const source = text.replace(/\btmrw\b/gi, 'tomorrow');
  const out: Array<{ day: LocalDay; label: string; index: number; text: string }> = [];
  for (const match of source.matchAll(DAY_TOKEN)) {
    const resolved = dateAt(source.slice(match.index), today);
    if (!resolved) continue;
    out.push({ day: resolved.day, label: resolved.label, index: match.index ?? 0, text: match[0] });
  }
  return out;
}

/** The one day the text is about, or null when there is none or more than one. */
export function singleDay(text: string, now: Date, timeZone: string): { day: LocalDay; label: string; index: number; text: string } | null {
  const days = daysIn(text, now, timeZone);
  const distinct = new Set(days.map((item) => dayKey(item.day)));
  return distinct.size === 1 ? days[0]! : null;
}

export function describeDay(day: LocalDay, now: Date, timeZone: string): string {
  const today = todayIn(now, safeTimeZone(timeZone));
  const delta = Math.round((Date.UTC(day.year, day.month - 1, day.day) - Date.UTC(today.year, today.month - 1, today.day)) / 86_400_000);
  if (delta === 0) return 'today';
  if (delta === 1) return 'tomorrow';
  if (delta > 1 && delta < 7) return `on ${WEEKDAY_NAMES[day.weekday]}`;
  return `on ${MONTH_NAMES[day.month - 1]} ${day.day}`;
}

/** Minutes after midnight for an hour/minute/meridiem as written, using the documented am/pm reading. */
function minutesOf(hourText: string, minuteText: string | undefined, meridiem: string | undefined, daypart: keyof typeof DAYPARTS | null): number | null {
  let hour = Number(hourText);
  const minute = minuteText ? Number(minuteText) : 0;
  if (!Number.isInteger(hour) || hour > 23 || minute > 59) return null;
  const m = meridiem?.toLowerCase().replace(/\./g, '');
  if (m) {
    if (hour < 1 || hour > 12) return null;
    if (m === 'pm' && hour < 12) hour += 12;
    if (m === 'am' && hour === 12) hour = 0;
  } else if (hour >= 1 && hour <= 12) {
    if (daypart === 'morning') hour = hour === 12 ? 12 : hour;
    else if (daypart === 'afternoon' || daypart === 'evening') hour = hour < 12 ? hour + 12 : hour;
    else if (hour <= 7) hour += 12;
    // 8–11 stay morning; 12 is noon.
  } else if (hour === 0) return null;
  return hour * 60 + minute;
}

function daypartIn(text: string): keyof typeof DAYPARTS | null {
  if (/\bmorning\b/i.test(text)) return 'morning';
  if (/\bafternoon\b/i.test(text)) return 'afternoon';
  if (/\b(?:evening|tonight)\b/i.test(text)) return 'evening';
  return null;
}

/** "2:30", "4 PM": how a time of day reads in a message. */
export function clockLabel(minutes: number, withMeridiem = true): string {
  const hour = Math.floor(minutes / 60) % 24;
  const minute = minutes % 60;
  const twelve = hour % 12 === 0 ? 12 : hour % 12;
  const base = minute ? `${twelve}:${String(minute).padStart(2, '0')}` : `${twelve}`;
  return withMeridiem ? `${base} ${hour < 12 ? 'AM' : 'PM'}` : base;
}

/** "2–4 PM", "11 AM–1 PM". */
export function rangeLabel(startMinutes: number, endMinutes: number): string {
  const samePeriod = startMinutes < 12 * 60 === endMinutes < 12 * 60;
  return samePeriod ? `${clockLabel(startMinutes, false)}–${clockLabel(endMinutes)}` : `${clockLabel(startMinutes)}–${clockLabel(endMinutes)}`;
}

/** Minutes after local midnight of `date` in `timeZone`. */
export function localMinutes(date: Date, timeZone: string): number {
  const p = zonedParts(date, safeTimeZone(timeZone));
  return p.hour * 60 + p.minute;
}

/**
 * The interval a claim is about, or null when it cannot be resolved reliably.
 * `defaultMinutes` is the length of a meeting at a point time ("at 3").
 * `workday` bounds a claim that names only a day ("free tomorrow").
 */
export function resolveClaimInterval(
  claim: string,
  input: { now: Date; timeZone: string; defaultMinutes: number; workday: { start: number; end: number } },
): ClaimInterval | null {
  const zone = safeTimeZone(input.timeZone);
  const text = claim.replace(/\s+/g, ' ');
  const today = todayIn(input.now, zone);
  const found = singleDay(text, input.now, zone) ?? (/\bthis (?:morning|afternoon|evening)\b/i.test(text) && !daysIn(text, input.now, zone).length ? { day: today, label: 'today', index: -1, text: '' } : null);
  if (!found) return null;
  // "Tuesday" written on a Tuesday could mean today or next week.
  if (dayKey(found.day) === dayKey(today) && !/\b(?:today|tonight|this (?:morning|afternoon|evening))\b/i.test(text)) return null;
  const daypart = daypartIn(text);
  let startMinutes: number | null = null;
  let endMinutes: number | null = null;
  let precision: ClaimInterval['precision'] = 'span';
  let timeText: ClaimInterval['timeText'] = null;

  const range = text.match(new RegExp(`\\b(from |between |at |@ ?)?(\\d{1,2})(?::([0-5]\\d))?\\s*${MERIDIEM}?\\s*(?:-|–|—|to|and|until|till)\\s*(\\d{1,2})(?::([0-5]\\d))?\\s*${MERIDIEM}?(?![\\d/])`, 'i'));
  const point = text.match(new RegExp(`\\b(?:at|@|around)\\s+(\\d{1,2})(?::([0-5]\\d))?(?:\\s*${MERIDIEM})?(?![\\d/:])|\\b(\\d{1,2})(?::([0-5]\\d))?\\s*${MERIDIEM}(?![a-z])|\\b(\\d{1,2}):([0-5]\\d)\\b|\\b(noon|midday)\\b`, 'i'));
  const after = text.match(new RegExp(`\\b(after|before)\\s+(\\d{1,2})(?::([0-5]\\d))?(?:\\s*${MERIDIEM})?(?![\\d/:])`, 'i'));
  if (range && (range[1] || range[4] || range[7])) {
    const endMeridiem = range[7] ?? range[4];
    const end = minutesOf(range[5]!, range[6], endMeridiem, daypart);
    const shared = !range[4] && endMeridiem && Number(range[2]) <= Number(range[5]) ? endMeridiem : undefined;
    let start = minutesOf(range[2]!, range[3], range[4] ?? shared, daypart);
    if (start === null || end === null) return null;
    // "10-12pm": borrowing the end's PM made the start later than the end.
    if (shared && start >= end && start >= 12 * 60 && start - 12 * 60 < end) start -= 12 * 60;
    if (end <= start) return null;
    [startMinutes, endMinutes, precision] = [start, end, 'range'];
  } else if (after) {
    const at = minutesOf(after[2]!, after[3], after[4], daypart);
    if (at === null) return null;
    [startMinutes, endMinutes] = after[1]!.toLowerCase() === 'after' ? [at, Math.min(21 * 60, at + 3 * 60)] : [Math.max(8 * 60, at - 3 * 60), at];
    if (endMinutes <= startMinutes) return null;
  } else if (point) {
    // Groups: 1–3 "at 3[:30][pm]", 4–6 "3[:30]pm", 7–8 "15:30", 9 "noon".
    const start = point[9] ? 12 * 60 : minutesOf(point[1] ?? point[4] ?? point[7]!, point[2] ?? point[5] ?? point[8], point[3] ?? point[6], daypart);
    if (start === null) return null;
    [startMinutes, endMinutes, precision] = [start, start + input.defaultMinutes, 'point'];
    timeText = { index: point.index ?? 0, text: point[0] };
  } else if (daypart) {
    [startMinutes, endMinutes] = [DAYPARTS[daypart].start, DAYPARTS[daypart].end];
  } else if (/\b(?:all\s*day|the\s+whole\s+day|entire\s+day)\b/i.test(text)) {
    [startMinutes, endMinutes] = [0, 24 * 60];
  } else {
    [startMinutes, endMinutes] = [input.workday.start, input.workday.end];
  }
  if (startMinutes === null || endMinutes === null || endMinutes <= startMinutes) return null;
  const at = (minutes: number) => zonedTimeToUtc({ ...found.day, hour: Math.floor(minutes / 60), minute: minutes % 60 }, zone);
  const start = at(startMinutes);
  const end = endMinutes >= 24 * 60 ? zonedTimeToUtc({ ...addCalendarDays(found.day, 1), hour: 0, minute: 0 }, zone) : at(endMinutes);
  if (end.getTime() <= input.now.getTime()) return null;
  return { start, end, precision, day: found.day, dayLabel: describeDay(found.day, input.now, zone), timeText };
}

/**
 * Rewrite a point time the way the user wrote theirs: "at 3" → "at 4:30",
 * "3pm" → "4:30pm", "3 PM" → "4:30 PM". The new time comes from the
 * availability engine, never from a model.
 */
export function rewriteTime(original: string, minutes: number): string {
  const meridiem = original.match(/(\s*)(a\.?m\.?|p\.?m\.?)\s*$/i);
  const prefix = original.match(/^(?:at|@|around)\s+/i)?.[0] ?? '';
  const bare = clockLabel(minutes, false);
  if (meridiem) {
    const word = minutes < 12 * 60 ? 'am' : 'pm';
    const written = meridiem[2]!;
    const styled = written.includes('.') ? `${word[0]}.m.` : word;
    return `${prefix}${bare}${meridiem[1]}${written === written.toUpperCase() ? styled.toUpperCase() : styled}`;
  }
  // Without am/pm the reader applies the same 1–7 PM / 8–11 AM reading; add it when that would mislead.
  const hour = Math.floor(minutes / 60);
  const implied = hour >= 13 && hour <= 19 ? 'pm' : hour >= 8 && hour <= 11 ? 'am' : hour === 12 ? 'pm' : null;
  return `${prefix}${bare}${implied ? '' : ` ${minutes < 12 * 60 ? 'AM' : 'PM'}`}`;
}
