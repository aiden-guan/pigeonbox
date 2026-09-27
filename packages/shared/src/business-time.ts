/**
 * Calendar and business-day arithmetic in a named IANA time zone.
 *
 * Follow-ups, reminders and briefings are about the user's working week, not
 * about "72 hours after send". Everything here takes an explicit time zone and
 * uses only `Intl`, so it behaves the same in the extension, a Worker and Node.
 */

export type LocalDate = { year: number; month: number; day: number };
export type LocalDateTime = LocalDate & { hour: number; minute: number; second?: number };
export type ZonedParts = LocalDateTime & { second: number; weekday: number };

export type WorkWeek = {
  /** Days that count as business days, 0 = Sunday. Default Monday–Friday. */
  workdays?: readonly number[];
  /** Local dates (`YYYY-MM-DD`) that never count, e.g. public holidays. */
  holidays?: readonly string[];
};

export const DEFAULT_WORKDAYS: readonly number[] = [1, 2, 3, 4, 5];
export const DEFAULT_TIME_ZONE = 'UTC';

const formatters = new Map<string, Intl.DateTimeFormat>();
const WEEKDAYS: Record<string, number> = { Sun: 0, Mon: 1, Tue: 2, Wed: 3, Thu: 4, Fri: 5, Sat: 6 };

function formatter(timeZone: string): Intl.DateTimeFormat {
  let existing = formatters.get(timeZone);
  if (!existing) {
    existing = new Intl.DateTimeFormat('en-US', {
      timeZone,
      hourCycle: 'h23',
      year: 'numeric',
      month: '2-digit',
      day: '2-digit',
      hour: '2-digit',
      minute: '2-digit',
      second: '2-digit',
      weekday: 'short',
    });
    formatters.set(timeZone, existing);
  }
  return existing;
}

export function isValidTimeZone(timeZone: string | null | undefined): timeZone is string {
  if (!timeZone || typeof timeZone !== 'string' || timeZone.length > 64) return false;
  try {
    formatter(timeZone);
    return true;
  } catch {
    return false;
  }
}

/** A usable zone: the given one when valid, otherwise UTC. Never throws. */
export function safeTimeZone(timeZone: string | null | undefined): string {
  return isValidTimeZone(timeZone) ? timeZone : DEFAULT_TIME_ZONE;
}

/** Wall-clock fields of `date` in `timeZone`. */
export function zonedParts(date: Date, timeZone: string): ZonedParts {
  const parts: Record<string, string> = {};
  for (const part of formatter(timeZone).formatToParts(date)) parts[part.type] = part.value;
  return {
    year: Number(parts.year),
    month: Number(parts.month),
    day: Number(parts.day),
    hour: Number(parts.hour) % 24,
    minute: Number(parts.minute),
    second: Number(parts.second),
    weekday: WEEKDAYS[parts.weekday ?? 'Sun'] ?? 0,
  };
}

function offsetMs(date: Date, timeZone: string): number {
  const p = zonedParts(date, timeZone);
  const asUtc = Date.UTC(p.year, p.month - 1, p.day, p.hour, p.minute, p.second);
  return asUtc - (date.getTime() - date.getUTCMilliseconds());
}

/**
 * The instant at which the wall clock in `timeZone` shows `local`. For a time
 * skipped by a daylight-saving jump the result lands just after the gap; for a
 * repeated hour the earlier instant wins.
 */
export function zonedTimeToUtc(local: LocalDateTime, timeZone: string): Date {
  const guess = Date.UTC(local.year, local.month - 1, local.day, local.hour, local.minute, local.second ?? 0);
  const first = offsetMs(new Date(guess), timeZone);
  let result = guess - first;
  const second = offsetMs(new Date(result), timeZone);
  if (second !== first) {
    const alternative = guess - second;
    // Prefer the candidate whose wall clock actually matches, else the later one (inside a gap).
    const check = zonedParts(new Date(alternative), timeZone);
    result = check.hour === local.hour && check.minute === local.minute ? Math.min(result, alternative) : Math.max(result, alternative);
  }
  return new Date(result);
}

export function localDateKey(date: Date, timeZone: string): string {
  const p = zonedParts(date, timeZone);
  return `${p.year}-${pad(p.month)}-${pad(p.day)}`;
}

function pad(value: number): string {
  return String(value).padStart(2, '0');
}

/** Pure calendar step on a local date, independent of time zones. */
export function addCalendarDays(date: LocalDate, days: number): LocalDate & { weekday: number } {
  const utc = new Date(Date.UTC(date.year, date.month - 1, date.day + days));
  return { year: utc.getUTCFullYear(), month: utc.getUTCMonth() + 1, day: utc.getUTCDate(), weekday: utc.getUTCDay() };
}

function dateKey(date: LocalDate): string {
  return `${date.year}-${pad(date.month)}-${pad(date.day)}`;
}

export function isBusinessDay(date: LocalDate & { weekday: number }, week: WorkWeek = {}): boolean {
  const workdays = week.workdays ?? DEFAULT_WORKDAYS;
  if (!workdays.includes(date.weekday)) return false;
  return !(week.holidays ?? []).includes(dateKey(date));
}

/**
 * `days` business days after `from` in the user's zone. The wall-clock time is
 * kept unless `at` is given ("the morning it is due"). Zero days returns the
 * same local day, moved to `at` when given.
 */
export function addBusinessDaysInZone(
  from: Date,
  days: number,
  timeZone: string,
  options: WorkWeek & { at?: { hour: number; minute: number } } = {},
): Date {
  const zone = safeTimeZone(timeZone);
  const start = zonedParts(from, zone);
  let cursor: LocalDate & { weekday: number } = { year: start.year, month: start.month, day: start.day, weekday: start.weekday };
  let remaining = Math.max(0, Math.floor(days));
  let guard = 0;
  while (remaining > 0 && guard < 3_700) {
    cursor = addCalendarDays(cursor, 1);
    if (isBusinessDay(cursor, options)) remaining -= 1;
    guard += 1;
  }
  const time = options.at ?? { hour: start.hour, minute: start.minute };
  return zonedTimeToUtc({ ...cursor, hour: time.hour, minute: time.minute, second: options.at ? 0 : start.second }, zone);
}

/**
 * Whole business days elapsed from `from` to `to` in the user's zone: the
 * number of business days strictly after `from`'s local date up to and
 * including `to`'s local date. Same local day → 0.
 */
export function businessDaysBetween(from: Date, to: Date, timeZone: string, week: WorkWeek = {}): number {
  if (to.getTime() <= from.getTime()) return 0;
  const zone = safeTimeZone(timeZone);
  const a = zonedParts(from, zone);
  const end = localDateKey(to, zone);
  let cursor: LocalDate & { weekday: number } = { year: a.year, month: a.month, day: a.day, weekday: a.weekday };
  let count = 0;
  let guard = 0;
  while (dateKey(cursor) < end && guard < 3_700) {
    cursor = addCalendarDays(cursor, 1);
    if (isBusinessDay(cursor, week)) count += 1;
    guard += 1;
  }
  return count;
}

/**
 * The next instant at or after `from` when the local clock reads `at`, on a
 * business day when `businessDaysOnly`. Used for "prepare it the morning it is
 * due" and scheduled briefings.
 */
export function nextLocalTime(
  from: Date,
  at: { hour: number; minute: number },
  timeZone: string,
  options: WorkWeek & { businessDaysOnly?: boolean } = {},
): Date {
  const zone = safeTimeZone(timeZone);
  const start = zonedParts(from, zone);
  let cursor: LocalDate & { weekday: number } = { year: start.year, month: start.month, day: start.day, weekday: start.weekday };
  for (let i = 0; i < 400; i += 1) {
    const candidate = zonedTimeToUtc({ ...cursor, hour: at.hour, minute: at.minute }, zone);
    const allowed = !options.businessDaysOnly || isBusinessDay(cursor, options);
    if (allowed && candidate.getTime() >= from.getTime()) return candidate;
    cursor = addCalendarDays(cursor, 1);
  }
  return new Date(from.getTime() + 24 * 3_600_000);
}

/** Midnight at the start of `date`'s local day. */
export function startOfLocalDay(date: Date, timeZone: string): Date {
  const zone = safeTimeZone(timeZone);
  const p = zonedParts(date, zone);
  return zonedTimeToUtc({ year: p.year, month: p.month, day: p.day, hour: 0, minute: 0 }, zone);
}

/** Minutes since local midnight. */
export function localMinuteOfDay(date: Date, timeZone: string): number {
  const p = zonedParts(date, safeTimeZone(timeZone));
  return p.hour * 60 + p.minute;
}
