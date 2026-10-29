import { GoogleApiError, googleErrorFrom } from './errors.js';
import type { AccessTokenSource } from './gmail.js';
import { safeTimeZone, zonedTimeToUtc } from '@pigeonbox/shared';

/** Google Calendar REST client for one connected account. Server-side only. */

export type CalendarEventTime = { dateTime?: string; date?: string; timeZone?: string };
export type CalendarListEntry = { id: string; primary?: boolean; selected?: boolean; hidden?: boolean; deleted?: boolean; accessRole?: string; timeZone?: string };

export type CalendarEvent = {
  id: string;
  status?: string;
  summary?: string;
  description?: string;
  location?: string;
  htmlLink?: string;
  start?: CalendarEventTime;
  end?: CalendarEventTime;
  attendees?: Array<{ email?: string; displayName?: string; self?: boolean; responseStatus?: string; organizer?: boolean }>;
  organizer?: { email?: string; self?: boolean };
  transparency?: string;
  updated?: string;
  etag?: string;
  hangoutLink?: string;
};

export type NewCalendarEvent = {
  summary: string;
  description?: string;
  location?: string;
  start: { dateTime: string; timeZone: string };
  end: { dateTime: string; timeZone: string };
  attendees?: Array<{ email: string }>;
  transparency?: 'opaque' | 'transparent';
};

export class CalendarClient {
  constructor(
    private readonly tokens: AccessTokenSource,
    private readonly fetchImpl: typeof fetch,
    private readonly base: string = 'https://www.googleapis.com/calendar/v3',
  ) {}

  private async request<T>(method: string, path: string, options: { query?: Record<string, string | undefined>; body?: unknown } = {}): Promise<T> {
    const url = new URL(`${this.base}${path}`);
    for (const [key, value] of Object.entries(options.query ?? {})) if (value !== undefined) url.searchParams.set(key, value);
    const send = async (token: string) => {
      try {
        return await this.fetchImpl(url.toString(), {
          method,
          headers: { Authorization: `Bearer ${token}`, Accept: 'application/json', ...(options.body !== undefined ? { 'Content-Type': 'application/json' } : {}) },
          body: options.body === undefined ? undefined : JSON.stringify(options.body),
          signal: AbortSignal.timeout(15_000),
        });
      } catch {
        throw new GoogleApiError('network', 0);
      }
    };
    let response = await send(await this.tokens.get());
    if (response.status === 401) {
      this.tokens.invalidate();
      response = await send(await this.tokens.get());
    }
    if (!response.ok) throw await googleErrorFrom(response);
    const text = await response.text();
    return (text ? JSON.parse(text) : undefined) as T;
  }

  /** Busy intervals across the given calendars. Only times, never event details. */
  async freeBusy(params: { timeMin: string; timeMax: string; calendarIds?: string[]; timeZone?: string }) {
    const { busy, calendarsChecked, errors } = await this.busyForCalendars(params);
    return { busy, calendarsChecked, errors };
  }

  private async busyForCalendars(params: { timeMin: string; timeMax: string; calendarIds?: string[]; timeZone?: string }) {
    const ids = [...new Set(params.calendarIds?.length ? params.calendarIds : ['primary'])];
    const result = await this.request<{ calendars?: Record<string, { busy?: Array<{ start: string; end: string }>; errors?: unknown[] }> }>('POST', '/freeBusy', {
      body: { timeMin: params.timeMin, timeMax: params.timeMax, timeZone: params.timeZone, items: ids.map((id) => ({ id })) },
    });
    const busy: Array<{ start: string; end: string }> = [];
    const failedCalendarIds: string[] = [];
    for (const id of ids) {
      const calendar = result.calendars?.[id];
      if (!calendar || calendar.errors?.length || !Array.isArray(calendar.busy)) failedCalendarIds.push(id);
      else busy.push(...calendar.busy);
    }
    return { busy, calendarsChecked: ids.length - failedCalendarIds.length, errors: failedCalendarIds.length, failedCalendarIds };
  }

  /** Compose reminders include calendars selected in Google's UI, within existing read consent.
   * Subscribed feeds may not support free/busy; readable events are a bounded fallback.
   * Calendar names and event details are neither returned nor persisted here.
   */
  async freeBusyWithSelectedCalendars(params: { timeMin: string; timeMax: string; timeZone: string }) {
    const calendars = new Map<string, CalendarListEntry>([['primary', { id: 'primary', accessRole: 'owner' }]]);
    let pageToken: string | undefined;
    let omitted = 0;
    for (let page = 0; page < 4; page += 1) {
      const result = await this.request<{ items?: CalendarListEntry[]; nextPageToken?: string }>('GET', '/users/me/calendarList', {
        query: { maxResults: '250', minAccessRole: 'freeBusyReader', showHidden: 'false', showDeleted: 'false', fields: 'items(id,primary,selected,hidden,deleted,accessRole,timeZone),nextPageToken', pageToken },
      });
      for (const calendar of result.items ?? []) {
        if (calendar.primary || !calendar.id || calendar.selected !== true || calendar.hidden || calendar.deleted || calendars.has(calendar.id)) continue;
        if (calendars.size < 50) calendars.set(calendar.id, calendar);
        else omitted += 1;
      }
      pageToken = result.nextPageToken;
      if (!pageToken) break;
    }
    if (pageToken) omitted += 1;
    const result = await this.busyForCalendars({ ...params, calendarIds: [...calendars.keys()] });
    let { calendarsChecked, errors } = result;
    const busy = [...result.busy];
    await Promise.all(result.failedCalendarIds.map(async id => {
      const calendar = calendars.get(id)!;
      if (calendar.accessRole === 'freeBusyReader') return;
      try {
        let next: string | undefined;
        const fallback: Array<{ start: string; end: string }> = [];
        for (let page = 0; page < 4; page += 1) {
          const events = await this.listEvents({ ...params, calendarId: id, maxResults: 250, pageToken: next, fields: 'items(start,end,status,transparency,attendees(self,responseStatus)),nextPageToken' });
          for (const event of events.items ?? []) {
            if (event.status === 'cancelled' || event.transparency === 'transparent' || event.attendees?.some(person => person.self && person.responseStatus === 'declined')) continue;
            const timestamp = (time: CalendarEventTime | undefined) => {
              if (time?.dateTime && Number.isFinite(Date.parse(time.dateTime))) return new Date(time.dateTime).toISOString();
              const date = time?.date?.match(/^(\d{4})-(\d{2})-(\d{2})$/);
              return date ? zonedTimeToUtc({ year: Number(date[1]), month: Number(date[2]), day: Number(date[3]), hour: 0, minute: 0 }, safeTimeZone(calendar.timeZone ?? params.timeZone)).toISOString() : null;
            };
            const start = timestamp(event.start), end = timestamp(event.end);
            if (start && end && Date.parse(end) > Date.parse(start)) fallback.push({ start, end });
          }
          next = events.nextPageToken;
          if (!next) break;
        }
        busy.push(...fallback);
        if (!next) { calendarsChecked += 1; errors -= 1; }
      } catch { /* An unreadable feed establishes no availability. */ }
    }));
    return { busy, calendarsChecked, errors: errors + omitted };
  }

  listEvents(params: { timeMin: string; timeMax: string; maxResults?: number; calendarId?: string; q?: string; pageToken?: string; fields?: string }) {
    return this.request<{ items?: CalendarEvent[]; timeZone?: string; nextPageToken?: string }>('GET', `/calendars/${encodeURIComponent(params.calendarId ?? 'primary')}/events`, {
      query: {
        timeMin: params.timeMin,
        timeMax: params.timeMax,
        singleEvents: 'true',
        orderBy: 'startTime',
        maxResults: String(params.maxResults ?? 100),
        q: params.q,
        pageToken: params.pageToken,
        fields: params.fields,
      },
    });
  }

  getEvent(eventId: string, calendarId = 'primary') {
    return this.request<CalendarEvent>('GET', `/calendars/${encodeURIComponent(calendarId)}/events/${encodeURIComponent(eventId)}`);
  }

  /** `sendUpdates: 'all'` emails invitations (Tier 3); `'none'` only writes the user's calendar (Tier 2). */
  insertEvent(event: NewCalendarEvent, sendUpdates: 'all' | 'none', calendarId = 'primary') {
    return this.request<CalendarEvent>('POST', `/calendars/${encodeURIComponent(calendarId)}/events`, { query: { sendUpdates }, body: event });
  }

  /** Remove an event PigeonBox created (undo). Already-deleted events are fine. */
  async deleteEvent(eventId: string, calendarId = 'primary'): Promise<void> {
    try {
      await this.request<void>('DELETE', `/calendars/${encodeURIComponent(calendarId)}/events/${encodeURIComponent(eventId)}`, { query: { sendUpdates: 'none' } });
    } catch (error) {
      if (error instanceof GoogleApiError && (error.code === 'not_found' || error.status === 410)) return;
      throw error;
    }
  }

  settingsTimeZone() {
    return this.request<{ value?: string }>('GET', '/users/me/settings/timezone');
  }
}
