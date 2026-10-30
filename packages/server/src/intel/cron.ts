import { safeTimeZone, zonedParts } from '@pigeonbox/shared';

/**
 * A small cron subset for automation schedules: `minute hour * * weekday`,
 * where each field is `*`, `*\/n`, a number, a list or a range. Day of month
 * and month must be `*`. Evaluated in the user's time zone.
 */

function field(spec: string, min: number, max: number): Set<number> | null {
  const out = new Set<number>();
  for (const part of spec.split(',')) {
    const step = part.match(/^\*\/(\d+)$/);
    if (part === '*') for (let i = min; i <= max; i += 1) out.add(i);
    else if (step) for (let i = min; i <= max; i += Number(step[1])) out.add(i);
    else if (/^\d+-\d+$/.test(part)) {
      const [a, b] = part.split('-').map(Number);
      if (a! > b! || a! < min || b! > max) return null;
      for (let i = a!; i <= b!; i += 1) out.add(i);
    } else if (/^\d+$/.test(part)) {
      const value = Number(part);
      if (value < min || value > max) return null;
      out.add(value);
    } else return null;
  }
  return out.size ? out : null;
}

export function parseCron(cron: string): { minutes: Set<number>; hours: Set<number>; weekdays: Set<number> } | null {
  const parts = cron.trim().split(/\s+/);
  if (parts.length !== 5 || parts[2] !== '*' || parts[3] !== '*') return null;
  const minutes = field(parts[0]!, 0, 59);
  const hours = field(parts[1]!, 0, 23);
  const weekdays = field(parts[4]!.replace(/7/g, '0'), 0, 6);
  return minutes && hours && weekdays ? { minutes, hours, weekdays } : null;
}

/** The next matching minute strictly after `from`, within 8 days; null if none. */
export function nextCronRun(cron: string, timeZone: string, from: Date): Date | null {
  const parsed = parseCron(cron);
  if (!parsed) return null;
  const zone = safeTimeZone(timeZone);
  let cursor = Math.floor(from.getTime() / 60_000) * 60_000 + 60_000;
  const end = cursor + 8 * 86_400_000;
  while (cursor <= end) {
    const p = zonedParts(new Date(cursor), zone);
    if (!parsed.weekdays.has(p.weekday) || !parsed.hours.has(p.hour)) {
      // Jump to the next hour boundary.
      cursor += (60 - p.minute) * 60_000;
      continue;
    }
    if (parsed.minutes.has(p.minute)) return new Date(cursor);
    cursor += 60_000;
  }
  return null;
}
