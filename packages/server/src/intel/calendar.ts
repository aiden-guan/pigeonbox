import type { PreparedEvent } from '@pigeonbox/api-contract';
import { safeTimeZone } from '@pigeonbox/shared';
import { iso, one, type SqlExecutor } from '../db/sql.js';
import type { CalendarEvent } from '../google/calendar.js';
import { GoogleApiError } from '../google/errors.js';
import { ApiError } from '../http.js';
import { enqueue, type JobRecord } from '../jobs/queue.js';
import { SkipJob } from '../jobs/runner.js';
import { performAction } from './actions.js';
import { createApproval } from './approvals.js';
import type { IntelDeps } from './context.js';
import { prepareDraft } from './drafts.js';
import { calendarFor, gmailFor, jobErrorFrom, loadAccount, requireFeature, type AccountRow } from './google-access.js';
import { detectMeetingRequest } from './heuristics.js';
import { loadPreferences } from './preferences.js';
import { availability, defaultWindow, windowForConstraints } from './scheduling.js';
import { readThread } from './thread-reader.js';
import { indexCalendarContext } from './calendar-index.js';

/**
 * Calendar Copilot: real availability, scheduling replies, prepared events,
 * and policy-checked event creation. Creating an event that emails invitations
 * is Tier 3 and always goes through the approval queue.
 */

export async function calendarAccount(tx: SqlExecutor, accountId?: string): Promise<AccountRow> {
  const row = accountId
    ? await loadAccount(tx, accountId)
    : await one<AccountRow>(
        tx,
        `select id, user_id, email, google_sub, status, features, display_name from public.mail_accounts where status = 'active' and 'calendar_read' = any (features) order by connected_at limit 1`,
      );
  if (!row) throw new ApiError('conflict', 'Connect Google Calendar to your PigeonBox server first.');
  requireFeature(row, 'calendar_read');
  return row;
}

export async function proposeForThread(deps: IntelDeps, userId: string, input: { accountId: string; threadRowId: string; requestId: string }) {
  const loaded = await deps.db.asUser(userId, async (tx) => {
    const account = await loadAccount(tx, input.accountId);
    const prefs = await loadPreferences(tx, userId);
    const thread = await one<{ gmail_thread_id: string; participants: Array<{ email: string }>; meeting_request: { isScheduling?: boolean; durationMinutes?: number | null; constraints?: string[] } | null; state: string | null }>(
      tx,
      `select t.gmail_thread_id, t.participants, s.meeting_request, coalesce(s.user_state, s.state) as state from public.threads t left join public.thread_states s on s.thread_id = t.id where t.id = $1::uuid`,
      [input.threadRowId],
    );
    return { account, prefs, thread };
  });
  if (!loaded.account || !loaded.thread) throw new ApiError('not_found', 'That thread is not synced.');
  const { account, prefs, thread } = loaded;
  requireFeature(account, 'calendar_read');

  let meeting = thread.meeting_request;
  let durationSource: 'stated' | 'inferred' | 'default' = meeting?.durationMinutes ? 'stated' : 'default';
  if (!meeting?.isScheduling) {
    // Not analyzed as scheduling yet: read the latest message once to check.
    const read = await readThread(gmailFor(deps, account), thread.gmail_thread_id, [account.email]);
    const latest = [...read.messages].reverse().find((message) => message.direction === 'inbound');
    const detected = detectMeetingRequest(latest?.text ?? '');
    meeting = { isScheduling: detected.isScheduling, durationMinutes: detected.durationMinutes, constraints: detected.constraints };
    durationSource = detected.durationMinutes ? 'stated' : 'default';
  }
  const duration = meeting?.durationMinutes ?? prefs.calendar.defaultDurationMinutes;
  const constraints = meeting?.constraints ?? [];
  const window = windowForConstraints(constraints, deps.now(), prefs);
  const preferMornings = constraints.some((constraint) => /morning/i.test(constraint)) ? true : undefined;
  const found = await availability(deps, account, prefs, { durationMinutes: duration, window, count: 4, preferMornings });
  const attendees = (thread.participants ?? []).map((person) => person.email).filter((email) => email !== account.email.toLowerCase());
  let draft = null;
  if (found.slots.length && (thread.state === 'NEEDS_REPLY' || meeting?.isScheduling)) {
    draft = await prepareDraft(deps, userId, {
      threadRowId: input.threadRowId,
      kind: 'scheduling',
      origin: 'scheduling',
      requestId: input.requestId,
      interactive: true,
      meeting: { isScheduling: true, durationMinutes: duration, constraints },
    }).catch(() => null);
  }
  return {
    request: {
      isScheduling: Boolean(meeting?.isScheduling),
      durationMinutes: duration,
      durationSource: durationSource === 'default' && meeting?.durationMinutes ? 'inferred' : durationSource,
      constraints: constraints.slice(0, 6),
      attendees: attendees.slice(0, 50),
      window: { start: window.start.toISOString(), end: window.end.toISOString() },
    },
    slots: found.slots.slice(0, 4),
    timeZone: found.timeZone,
    draft,
    note: found.note,
  };
}

type PreparedRow = {
  id: string;
  title: string;
  start_at: unknown;
  end_at: unknown;
  time_zone: string;
  attendees: string[];
  location: string | null;
  description_key_id: string | null;
  description_iv: string | null;
  description_ciphertext: string | null;
  notify_attendees: boolean;
  gmail_thread_id: string | null;
  status: PreparedEvent['status'];
  calendar_event_id: string | null;
  html_link: string | null;
  approval_id: string | null;
  mail_account_id: string;
  thread_id: string | null;
};

async function toPreparedEvent(deps: IntelDeps, userId: string, row: PreparedRow): Promise<PreparedEvent> {
  let description: string | null = null;
  if (row.description_key_id && row.description_iv && row.description_ciphertext) {
    description = await deps.box.open({ keyId: row.description_key_id, iv: row.description_iv, ciphertext: row.description_ciphertext }, { purpose: 'note', userId, recordId: `event:${row.id}` }).catch(() => null);
  }
  return {
    id: row.id,
    title: row.title.slice(0, 300),
    start: iso(row.start_at),
    end: iso(row.end_at),
    timeZone: row.time_zone,
    attendees: row.attendees.slice(0, 50),
    location: row.location,
    description,
    notifyAttendees: row.notify_attendees,
    threadId: row.gmail_thread_id,
    status: row.status,
    calendarEventId: row.calendar_event_id,
    htmlLink: row.html_link,
    approvalId: row.approval_id,
  };
}

export async function prepareEvent(
  deps: IntelDeps,
  userId: string,
  input: { accountId: string; threadRowId: string | null; gmailThreadId: string | null; title: string; start: string; end: string; timeZone?: string; attendees: string[]; location?: string; description?: string; notifyAttendees: boolean },
): Promise<PreparedEvent> {
  const start = new Date(input.start);
  const end = new Date(input.end);
  if (!(end.getTime() > start.getTime())) throw new ApiError('invalid_request', 'The event must end after it starts.');
  if (end.getTime() - start.getTime() > 12 * 3_600_000) throw new ApiError('invalid_request', 'Events longer than 12 hours are not supported.');
  return deps.db.asUser(userId, async (tx) => {
    const prefs = await loadPreferences(tx, userId);
    const id = crypto.randomUUID();
    const sealed = input.description ? await deps.box.seal(input.description.slice(0, 5_000), { purpose: 'note', userId, recordId: `event:${id}` }) : null;
    await tx.query(
      `insert into public.prepared_events (id, user_id, mail_account_id, thread_id, gmail_thread_id, title, start_at, end_at, time_zone, attendees, location,
          description_key_id, description_iv, description_ciphertext, notify_attendees)
       values ($1::uuid, $2::uuid, $3::uuid, $4::uuid, $5, $6, $7::timestamptz, $8::timestamptz, $9, $10::text[], $11, $12, $13, $14, $15)`,
      [id, userId, input.accountId, input.threadRowId, input.gmailThreadId, input.title.slice(0, 300), start, end, safeTimeZone(input.timeZone ?? prefs.timeZone), input.attendees.map((email) => email.toLowerCase()).slice(0, 50), input.location ?? null, sealed?.keyId ?? null, sealed?.iv ?? null, sealed?.ciphertext ?? null, input.notifyAttendees],
    );
    const row = await one<PreparedRow>(tx, `select * from public.prepared_events where id = $1::uuid`, [id]);
    return toPreparedEvent(deps, userId, row!);
  });
}

/**
 * Put a prepared event on the calendar. Without invitations it is Tier 2 and
 * runs because the user asked. With invitations it is Tier 3: an approval card
 * is created instead, and the event is created only after approval.
 */
export async function createPreparedEvent(deps: IntelDeps, userId: string, input: { preparedEventId: string; idempotencyKey: string; actor?: 'user' | 'mcp' }): Promise<PreparedEvent> {
  const row = await deps.db.asUser(userId, (tx) => one<PreparedRow>(tx, `select * from public.prepared_events where id = $1::uuid`, [input.preparedEventId]));
  if (!row) throw new ApiError('not_found', 'That prepared event does not exist.');
  if (row.status === 'created' || row.status === 'approval_pending') return toPreparedEvent(deps, userId, row);
  const account = await deps.db.asUser(userId, (tx) => loadAccount(tx, row.mail_account_id));
  if (!account) throw new ApiError('conflict', 'That Google account is no longer connected.');
  requireFeature(account, 'calendar_write');
  const spec = { kind: 'create_event' as const, params: { preparedEventId: row.id, notifyAttendees: row.notify_attendees } };
  const target = { accountId: account.id, threadRowId: row.thread_id, gmailThreadId: row.gmail_thread_id, title: row.title };
  const actor = input.actor === 'mcp' ? { type: 'mcp' as const, id: null, name: 'API client', scopes: ['write' as const] } : { type: 'user' as const, id: userId, name: 'You' };
  const outcome = await performAction(deps, userId, { spec, target, actor, userInitiated: input.actor !== 'mcp', idempotencyKey: `event:${input.idempotencyKey}` });
  if (outcome.decision === 'approval_required') {
    await deps.db.asUser(userId, async (tx) => {
      const approval = await createApproval(tx, deps.box, {
        userId,
        kind: 'create_event',
        tier: outcome.tier,
        title: `Send invitations for "${row.title}"`,
        why: 'Creating this event emails invitations to the attendees.',
        sources: row.gmail_thread_id ? [{ id: `thread:${row.gmail_thread_id}`, kind: 'thread', title: row.title, gmailThreadId: row.gmail_thread_id, accountId: account.id }] : [],
        action: spec,
        target,
        preview: { event: { title: row.title, start: iso(row.start_at), end: iso(row.end_at), attendees: row.attendees } },
        responsible: { type: actor.type, id: actor.id, name: actor.name },
        idempotencyKey: `event:${row.id}`,
      });
      await tx.query(`update public.prepared_events set status = 'approval_pending', approval_id = $2::uuid, updated_at = now() where id = $1::uuid`, [row.id, approval.id]);
    });
  } else if (outcome.decision !== 'allowed') {
    throw new ApiError('forbidden', outcome.reason);
  } else if (outcome.errorCode) {
    await deps.db.asUser(userId, (tx) => tx.query(`update public.prepared_events set status = 'failed', updated_at = now() where id = $1::uuid`, [row.id]));
    throw new ApiError('provider_error', 'Google Calendar did not accept the event.');
  }
  const updated = await deps.db.asUser(userId, (tx) => one<PreparedRow>(tx, `select * from public.prepared_events where id = $1::uuid`, [row.id]));
  return toPreparedEvent(deps, userId, updated!);
}

/** Upsert one Google Calendar event into the cache (metadata only: no descriptions). */
async function cacheEvent(tx: SqlExecutor, userId: string, accountId: string, event: CalendarEvent, refreshedAt: Date): Promise<boolean> {
  if (event.status === 'cancelled') {
    await tx.query(`delete from public.calendar_event_cache where mail_account_id = $1::uuid and event_id = $2`, [accountId, event.id]);
    return false;
  }
  const start = event.start?.dateTime ?? (event.start?.date ? `${event.start.date}T00:00:00Z` : null);
  const end = event.end?.dateTime ?? (event.end?.date ? `${event.end.date}T00:00:00Z` : null);
  if (!start || !end) return false;
  const self = event.attendees?.find((attendee) => attendee.self);
  await tx.query(
    `insert into public.calendar_event_cache (user_id, mail_account_id, event_id, title, start_at, end_at, all_day, attendees, organizer, location, html_link, status, self_response, etag, updated_at)
     values ($1::uuid, $2::uuid, $3, $4, $5::timestamptz, $6::timestamptz, $7, $8::text[], $9, $10, $11, $12, $13, $14, $15::timestamptz)
     on conflict (mail_account_id, event_id) do update set title = excluded.title, start_at = excluded.start_at, end_at = excluded.end_at, all_day = excluded.all_day,
       attendees = excluded.attendees, organizer = excluded.organizer, location = excluded.location, html_link = excluded.html_link, status = excluded.status,
       self_response = excluded.self_response, etag = excluded.etag, updated_at = excluded.updated_at`,
    [
      userId,
      accountId,
      event.id,
      (event.summary ?? '').slice(0, 300),
      start,
      end,
      Boolean(event.start?.date),
      (event.attendees ?? []).map((attendee) => (attendee.email ?? '').toLowerCase()).filter(Boolean).slice(0, 100),
      event.organizer?.email?.toLowerCase() ?? null,
      event.location?.slice(0, 300) ?? null,
      event.htmlLink ?? null,
      event.status ?? null,
      self?.responseStatus ?? null,
      event.etag ?? null,
      refreshedAt,
    ],
  );
  return true;
}

/**
 * Make sure an event is in the cache before briefing on it. Events created
 * since the last refresh are fetched directly from the connected calendars.
 */
export async function ensureEventCached(deps: IntelDeps, userId: string, eventId: string, accountId?: string): Promise<void> {
  const cached = await deps.db.asUser(userId, (tx) => one(tx, `select 1 from public.calendar_event_cache where event_id = $1`, [eventId]));
  if (cached) return;
  const accounts = await deps.db.asUser(userId, (tx) =>
    tx.query<{ id: string }>(`select id from public.mail_accounts where status = 'active' and 'calendar_read' = any (features) ${accountId ? 'and id = $1::uuid' : ''} order by connected_at`, accountId ? [accountId] : []),
  );
  for (const { id } of accounts) {
    const account = await deps.db.asUser(userId, (tx) => loadAccount(tx, id));
    if (!account) continue;
    try {
      const event = await calendarFor(deps, account).getEvent(eventId);
      if (await deps.db.asUser(userId, (tx) => cacheEvent(tx, userId, account.id, event, deps.now()))) return;
    } catch (error) {
      if (error instanceof GoogleApiError && error.code === 'not_found') continue;
      throw error;
    }
  }
}

/**
 * Calendar refresh (every 15 minutes via Supabase Cron): cache a bounded 45-day
 * window for context, queue approaching meeting briefs, and invalidate scheduling drafts
 * when availability changed.
 */
export async function runCalendarRefresh(deps: IntelDeps, job: JobRecord, canBrief: boolean): Promise<void> {
  if (!job.userId || !job.accountId) throw new SkipJob('missing_ids');
  const userId = job.userId;
  const account = await deps.db.asUser(userId, (tx) => loadAccount(tx, job.accountId!));
  if (!account || account.status !== 'active' || !account.features.includes('calendar_read')) throw new SkipJob('account_inactive');
  const prefs = await deps.db.asUser(userId, (tx) => loadPreferences(tx, userId));
  const now = deps.now();
  const horizon = new Date(now.getTime() + 45 * 86_400_000);
  try {
    const calendar = calendarFor(deps, account);
    const listed = await calendar.listEvents({ timeMin: now.toISOString(), timeMax: horizon.toISOString(), maxResults: 250 });
    const week = defaultWindow(now, prefs);
    const busy = await calendar.freeBusy({ timeMin: week.start.toISOString(), timeMax: week.end.toISOString(), timeZone: prefs.timeZone });
    const digest = new Uint8Array(await crypto.subtle.digest('SHA-256', new TextEncoder().encode(JSON.stringify(busy.busy))));
    const busyHash = [...digest.slice(0, 12)].map((byte) => byte.toString(16).padStart(2, '0')).join('');
    await deps.db.asUser(userId, async (tx) => {
      for (const event of listed.items ?? []) await cacheEvent(tx, userId, account.id, event, now);
      // Only a complete listing proves deletion. A truncated cache never proves absence.
      if (!listed.nextPageToken) await tx.query(
        `delete from public.calendar_event_cache where mail_account_id = $1::uuid and end_at > $2::timestamptz and start_at < $3::timestamptz and not (event_id = any($4::text[]))`,
        [account.id, now, horizon, (listed.items ?? []).map(event => event.id)]);
      const previous = await one<{ busy_hash: string | null }>(tx, `select busy_hash from public.calendar_sync_state where mail_account_id = $1::uuid`, [account.id]);
      await tx.query(
        `insert into public.calendar_sync_state (mail_account_id, user_id, last_refresh_at, window_start, window_end, busy_hash, events_count, last_error_code, updated_at)
         values ($1::uuid, $2::uuid, now(), $3::timestamptz, $4::timestamptz, $5, $6, null, now())
         on conflict (mail_account_id) do update set last_refresh_at = now(), window_start = excluded.window_start, window_end = excluded.window_end,
           busy_hash = excluded.busy_hash, events_count = excluded.events_count, last_error_code = null, updated_at = now()`,
        [account.id, userId, now, horizon, busyHash, (listed.items ?? []).length],
      );
      if (previous?.busy_hash && previous.busy_hash !== busyHash) {
        // Availability changed: scheduling drafts that offered times may now offer busy ones.
        const stale = await tx.query<{ thread_id: string }>(
          `update public.drafts set status = 'stale', stale_reason = 'Your calendar changed', updated_at = now()
            where mail_account_id = $1::uuid and kind = 'scheduling' and status in ('ready', 'placed') returning thread_id`,
          [account.id],
        );
        for (const draft of stale) {
          await enqueue(tx, { kind: 'draft.prepare', userId, accountId: account.id, key: `draft:${draft.thread_id}:calendar:${busyHash}`, payload: { threadId: draft.thread_id, kind: 'scheduling', origin: 'auto' } });
        }
      }
      const approaching = await tx.query<{ id: string; version: number; minutes: number }>(
        `select id, version, coalesce((trigger_params ->> 'minutesBefore')::int, 30) as minutes from public.automation_rules where enabled and trigger_kind = 'calendar_approaching'`,
      );
      for (const automation of approaching) {
        const soon = await tx.query<{ event_id: string; start_at: unknown }>(
          `select event_id, start_at from public.calendar_event_cache where mail_account_id = $1::uuid and not all_day and start_at between $2::timestamptz and $3::timestamptz`,
          [account.id, new Date(now.getTime() + (automation.minutes - 20) * 60_000), new Date(now.getTime() + (automation.minutes + 5) * 60_000)],
        );
        for (const event of soon) {
          await enqueue(tx, { kind: 'automation.run', userId, accountId: account.id, key: `automation:${automation.id}:v${automation.version}:event:${event.event_id}:${iso(event.start_at)}`, payload: { automationId: automation.id, trigger: 'calendar_approaching', eventId: event.event_id }, maxAttempts: 3 });
        }
      }
      if (canBrief && prefs.briefings.meeting.enabled) {
        const lead = prefs.briefings.meeting.minutesBefore * 60_000;
        const due = await tx.query<{ event_id: string; start_at: unknown; attendees: string[] }>(
          `select event_id, start_at, attendees from public.calendar_event_cache
            where mail_account_id = $1::uuid and not all_day and coalesce(status, 'confirmed') <> 'cancelled'
              and start_at between $2::timestamptz and $3::timestamptz and coalesce(self_response, 'accepted') <> 'declined'`,
          [account.id, new Date(now.getTime() + lead - 20 * 60_000), new Date(now.getTime() + lead + 5 * 60_000)],
        );
        const ownDomain = account.email.split('@')[1];
        for (const event of due) {
          const external = event.attendees.some((email) => email.split('@')[1] !== ownDomain);
          if (prefs.briefings.meeting.externalOnly && !external) continue;
          if (event.attendees.length === 0) continue;
          await enqueue(tx, {
            kind: 'briefing.generate',
            userId,
            accountId: account.id,
            key: `brief:meeting:${event.event_id}:${iso(event.start_at)}`,
            payload: { kind: 'meeting', eventId: event.event_id, accountId: account.id },
            maxAttempts: 3,
          });
        }
      }
    });
    await indexCalendarContext(deps, userId, account.id);
  } catch (error) {
    await deps.db
      .asUser(userId, (tx) =>
        tx.query(
          `insert into public.calendar_sync_state (mail_account_id, user_id, last_error_code) values ($1::uuid, $2::uuid, $3)
           on conflict (mail_account_id) do update set last_error_code = excluded.last_error_code, updated_at = now()`,
          [account.id, userId, (error as { code?: string })?.code ?? 'error'],
        ),
      )
      .catch(() => undefined);
    throw jobErrorFrom(error);
  }
}

export async function eventFromCache(tx: SqlExecutor, eventId: string) {
  return one<{ event_id: string; mail_account_id: string; title: string; start_at: unknown; end_at: unknown; attendees: string[]; organizer: string | null; location: string | null; html_link: string | null }>(
    tx,
    `select event_id, mail_account_id, title, start_at, end_at, attendees, organizer, location, html_link from public.calendar_event_cache where event_id = $1`,
    [eventId],
  );
}
