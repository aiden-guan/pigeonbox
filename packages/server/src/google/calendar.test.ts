import { describe, expect, it } from 'vitest';
import { CalendarClient } from './calendar.js';

const window = { timeMin: '2026-10-11T07:00:00Z', timeMax: '2026-10-12T07:00:00Z', timeZone: 'America/Los_Angeles' };
const busy = { start: '2026-10-11T16:00:00.000Z', end: '2026-10-12T04:00:00.000Z' };
const tokens = { get: async () => 'test-token', invalidate: () => {} };
const json = (value: unknown) => new Response(JSON.stringify(value), { headers: { 'Content-Type': 'application/json' } });

describe('selected-calendar availability', () => {
  it('does not count a missing or errored free/busy calendar as checked', async () => {
    const client = new CalendarClient(tokens, async () => json({ calendars: { primary: { busy: [] }, bad: { busy: [busy], errors: [{ reason: 'notFound' }] } } }));
    expect(await client.freeBusy({ ...window, calendarIds: ['primary', 'missing', 'bad'] })).toEqual({ busy: [], calendarsChecked: 1, errors: 2 });
  });

  it('reads selected calendars on later pages and ignores hidden, deleted and deselected calendars', async () => {
    const requested: string[] = [];
    const client = new CalendarClient(tokens, async (input, init) => {
      const url = new URL(String(input));
      if (url.pathname.endsWith('/calendarList')) return json(url.searchParams.has('pageToken')
        ? { items: [{ id: 'feed', selected: true, accessRole: 'reader' }] }
        : { items: [{ id: 'owner@work.test', primary: true }, { id: 'off', selected: false }, { id: 'hidden', selected: true, hidden: true }, { id: 'deleted', selected: true, deleted: true }], nextPageToken: 'page-two' });
      const body = JSON.parse(String(init?.body));
      requested.push(...body.items.map((item: { id: string }) => item.id));
      return json({ calendars: { primary: { busy: [] }, feed: { busy: [busy] } } });
    });
    expect(await client.freeBusyWithSelectedCalendars(window)).toEqual({ busy: [busy], calendarsChecked: 2, errors: 0 });
    expect(requested).toEqual(['primary', 'feed']);
  });

  it('falls back to readable feed events without treating free, cancelled or declined events as busy', async () => {
    const client = new CalendarClient(tokens, async input => {
      const url = new URL(String(input));
      if (url.pathname.endsWith('/calendarList')) return json({ items: [{ id: 'feed', selected: true, accessRole: 'reader' }] });
      if (url.pathname.endsWith('/freeBusy')) return json({ calendars: { primary: { busy: [] }, feed: { errors: [{ reason: 'notFound' }] } } });
      expect(url.searchParams.get('fields')).toBe('items(start,end,status,transparency,attendees(self,responseStatus)),nextPageToken');
      const event = { id: 'event', start: { dateTime: busy.start }, end: { dateTime: busy.end } };
      return json({ items: [event, { ...event, transparency: 'transparent' }, { ...event, status: 'cancelled' }, { ...event, attendees: [{ self: true, responseStatus: 'declined' }] }] });
    });
    expect(await client.freeBusyWithSelectedCalendars(window)).toEqual({ busy: [busy], calendarsChecked: 2, errors: 0 });
  });

  it('does not request event details for a calendar that grants only free/busy access', async () => {
    const calls: string[] = [];
    const client = new CalendarClient(tokens, async input => {
      const url = new URL(String(input)); calls.push(url.pathname);
      return url.pathname.endsWith('/calendarList')
        ? json({ items: [{ id: 'feed', selected: true, accessRole: 'freeBusyReader' }] })
        : json({ calendars: { primary: { busy: [] }, feed: { errors: [{ reason: 'notFound' }] } } });
    });
    expect(await client.freeBusyWithSelectedCalendars(window)).toEqual({ busy: [], calendarsChecked: 1, errors: 1 });
    expect(calls).toHaveLength(2);
  });
});
