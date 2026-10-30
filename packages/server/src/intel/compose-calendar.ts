import { addCalendarDays, safeTimeZone, zonedParts, zonedTimeToUtc } from '@pigeonbox/shared';
import type { CalendarEvent } from '../google/calendar.js';
import type { IntelDeps } from './context.js';
import { calendarFor, type AccountRow } from './google-access.js';
import { one } from '../db/sql.js';
import { daysIn, resolveClaimInterval, singleDay } from './compose-time.js';
import type { ContextItem } from './memory/rank.js';
import { safeMemoryText } from './memory/policy.js';

/** One ephemeral snapshot of verified event metadata, never a stored memory. */
export function composeCalendarItem(event: CalendarEvent, account: AccountRow, now: Date, timeZone: string): ContextItem | null {
  const title = (event.summary ?? '').replace(/\s+/g, ' ').trim();
  const self = event.attendees?.find(person => person.self || person.email?.toLowerCase() === account.email.toLowerCase());
  if (!title || !safeMemoryText(title) || event.status === 'cancelled' || ['declined', 'needsAction', 'tentative'].includes(self?.responseStatus ?? '')) return null;
  const timestamp = (time: CalendarEvent['start']): string | null => {
    if (time?.dateTime && Number.isFinite(Date.parse(time.dateTime))) return new Date(time.dateTime).toISOString();
    const date = time?.date?.match(/^(\d{4})-(\d{2})-(\d{2})$/);
    return date ? zonedTimeToUtc({ year: Number(date[1]), month: Number(date[2]), day: Number(date[3]), hour: 0, minute: 0 }, safeTimeZone(timeZone)).toISOString() : null;
  };
  const start = timestamp(event.start), end = timestamp(event.end);
  if (!start || !end || Date.parse(end) <= Date.parse(start) || Date.parse(end) <= now.getTime()) return null;
  let url: string | undefined;
  try {
    const parsed = new URL(event.htmlLink ?? '');
    if (parsed.protocol === 'https:' && !parsed.username && !parsed.password && (parsed.hostname === 'calendar.google.com' || (parsed.hostname === 'www.google.com' && parsed.pathname.startsWith('/calendar/')))) url = parsed.href;
  } catch { /* Metadata without a safe link still establishes the event. */ }
  const allDay = !event.start?.dateTime;
  const text = JSON.stringify({ title: title.slice(0, 120), start, end, allDay,
    participants: event.attendees?.filter(person => person.responseStatus !== 'declined').length ?? 0,
    videoCall: Boolean(event.hangoutLink), showAs: event.transparency === 'transparent' ? 'free' : 'busy',
    attendance: self?.responseStatus ?? 'calendar owner',
  });
  return {
    ref: { id: `live-event:${event.id}`.slice(0, 128), kind: 'calendar_event', title: title.slice(0, 300), accountId: account.id, at: start, ...(event.etag ? { version: event.etag } : {}), ...(url ? { url } : {}) },
    text, confidence: 1, importance: 0.9, semantic: 0, recipientMatch: false, threadMatch: false, openLoop: false,
    at: now.toISOString(), validUntil: end, durable: false, status: 'active',
    calendar: { rowId: '', liveEventId: event.id, start, end, allDay, location: null, refreshedAt: now.toISOString(), version: event.etag ?? null },
  };
}

/** Shared chronological bounds for retrieval and validation, independent of assertion wording. */
export function composeCalendarWindow(claim: string, now: Date, timeZone: string): { from: number; until: number } | null {
  const zone = safeTimeZone(timeZone), p = zonedParts(now, zone);
  let from = now.getTime(), until = now.getTime() + 45 * 86_400_000;
  const day = singleDay(claim, now, zone);
  if (!day && daysIn(claim, now, zone).length) return null;
  if (day) {
    from = zonedTimeToUtc({ ...day.day, hour: 0, minute: 0 }, zone).getTime();
    until = zonedTimeToUtc({ ...addCalendarDays(day.day, 1), hour: 0, minute: 0 }, zone).getTime();
  } else if (/\b(?:this|later this|later in the) month\b/i.test(claim)) {
    until = zonedTimeToUtc({ year: p.month === 12 ? p.year + 1 : p.year, month: p.month === 12 ? 1 : p.month + 1, day: 1, hour: 0, minute: 0 }, zone).getTime();
  } else if (/\b(?:this|next|that) weekend\b/i.test(claim)) {
    if (/\bthat weekend\b/i.test(claim)) return null;
    const saturday = addCalendarDays(p, ((6 - p.weekday + 7) % 7) || (/next weekend/i.test(claim) ? 7 : 0));
    from = zonedTimeToUtc({ ...saturday, hour: 0, minute: 0 }, zone).getTime();
    until = zonedTimeToUtc({ ...addCalendarDays(saturday, 2), hour: 0, minute: 0 }, zone).getTime();
  } else if (/\b(?:this|next) week\b/i.test(claim)) {
    const monday = addCalendarDays(p, -((p.weekday + 6) % 7) + (/next week/i.test(claim) ? 7 : 0));
    from = zonedTimeToUtc({ ...monday, hour: 0, minute: 0 }, zone).getTime();
    until = zonedTimeToUtc({ ...addCalendarDays(monday, 7), hour: 0, minute: 0 }, zone).getTime();
  }
  const daypart = /\b(?:morning|afternoon|evening|tonight)\b/i.test(claim);
  const boundary = /\b(after|before)\s+(?=\d|noon|midday)/i.exec(claim);
  if (day || daypart) {
    const source = boundary ? claim.replace(boundary[0], 'at ') : claim;
    const interval = resolveClaimInterval(day ? source : `${source} today`, { now, timeZone: zone, defaultMinutes: 30, workday: { start: 0, end: 24 * 60 } });
    if (!interval) return null;
    if (boundary?.[1]?.toLowerCase() === 'before') until = interval.start.getTime();
    else if (boundary) from = interval.start.getTime();
    else if (interval.precision !== 'span' || daypart) {
      from = interval.start.getTime();
      until = interval.end.getTime();
    }
  }
  from = Math.max(from, now.getTime());
  return until > from ? { from, until } : null;
}

/** Date/time parsing bounds retrieval; the model interprets the personal assertion. */
export async function liveComposeCalendarContext(deps: IntelDeps, userId: string, selected: AccountRow, claim: string, now: Date, timeZone: string): Promise<ContextItem[]> {
  const account = selected.features.includes('calendar_read') ? selected : await deps.db.asUser(userId, tx => one<AccountRow>(tx,
    `select id,user_id,email,google_sub,status,features,display_name from public.mail_accounts where status = 'active' and 'calendar_read' = any(features) order by connected_at limit 1`));
  if (!account) return [];
  const window = composeCalendarWindow(claim, now, timeZone);
  if (!window) return [];
  const result = await calendarFor(deps, account).listEvents({ timeMin: new Date(window.from).toISOString(), timeMax: new Date(window.until).toISOString(), maxResults: 50 });
  return (result.items ?? []).slice(0, 50).flatMap(event => {
    const item = composeCalendarItem(event, account, now, timeZone);
    return item ? [item] : [];
  }).slice(0, 4);
}
