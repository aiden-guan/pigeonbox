import type { AskApproval } from '@pigeonbox/api-contract';
import { safeTimeZone, zonedTimeToUtc } from '@pigeonbox/shared';
import { one } from '../db/sql.js';
import { performAction } from './actions.js';
import { prepareEvent } from './calendar.js';
import type { IntelDeps } from './context.js';
import { calendarFor, type AccountRow } from './google-access.js';

/**
 * Calendar events and reminders that Chat proposes. Like mailbox changes,
 * nothing happens when Pigeon proposes one: the plan below is sealed into an
 * approval card (ask-approval.ts) and carried out only after Allow, through
 * the same action registry and policy as every other action. Emailing
 * invitations is Tier 3, so the card always says so separately.
 */

export type EventPlan = {
  kind: 'calendar_event';
  title: string;
  accountId: string;
  accountEmail: string;
  summary: string;
  start: string;
  end: string;
  timeZone: string;
  attendees: string[];
  /** Google emails each attendee an invitation (cannot be taken back). */
  invite: boolean;
  googleMeet: boolean;
  location: string | null;
  description: string | null;
  /** Busy blocks overlapping the event when it was proposed, as the user reads them. */
  conflicts: string[];
  gmailThreadId: string | null;
};

export type ReminderPlan = {
  kind: 'reminder';
  title: string;
  accountId: string;
  at: string;
  timeZone: string;
  note: string;
  /** Archive the thread now and put it back in the inbox at `at`. */
  snooze: boolean;
  gmailThreadId: string | null;
  subject: string | null;
};

/** Longest event Chat proposes; matches prepared events. */
const MAX_EVENT_MS = 12 * 3_600_000;
/** Furthest ahead Chat schedules an event or reminder. */
const MAX_AHEAD_MS = 2 * 366 * 86_400_000;

/**
 * "2026-10-22T12:30" in the user's time zone, or a full ISO time with an
 * offset. Models usually think in the user's local time; a bare local time is
 * never read as UTC.
 */
export function parseLocalTime(value: string, timeZone: string): Date | null {
  const trimmed = value.trim();
  const local = trimmed.match(/^(\d{4})-(\d{2})-(\d{2})[T ](\d{1,2}):(\d{2})(?::(\d{2}))?(?:\.\d+)?$/);
  if (local) {
    const [year, month, day, hour, minute] = local.slice(1, 6).map(Number) as [number, number, number, number, number];
    if (month < 1 || month > 12 || day < 1 || day > 31 || hour > 23 || minute > 59) return null;
    const at = zonedTimeToUtc({ year, month, day, hour, minute }, safeTimeZone(timeZone));
    return Number.isNaN(at.getTime()) ? null : at;
  }
  if (!/^\d{4}-\d{2}-\d{2}T\d{1,2}:\d{2}(?::\d{2}(?:\.\d+)?)?(?:Z|[+-]\d{2}:?\d{2})$/i.test(trimmed)) return null;
  const at = new Date(trimmed);
  return Number.isNaN(at.getTime()) ? null : at;
}

/** "Thu, Oct 22, 12:30–1:00 PM PDT" (or across days, both dates). */
export function formatRange(start: Date, end: Date, timeZone: string): string {
  const day = new Intl.DateTimeFormat('en-US', { timeZone, weekday: 'short', month: 'short', day: 'numeric' });
  // ICU puts a narrow no-break space before AM/PM; plain spaces read the same and compare simply.
  const time = (at: Date) => new Intl.DateTimeFormat('en-US', { timeZone, hour: 'numeric', minute: '2-digit' }).format(at).replace(/\u202f/g, ' ');
  const zone = new Intl.DateTimeFormat('en-US', { timeZone, timeZoneName: 'short' }).formatToParts(start).find((part) => part.type === 'timeZoneName')?.value ?? timeZone;
  if (day.format(start) !== day.format(end)) return `${day.format(start)}, ${time(start)} – ${day.format(end)}, ${time(end)} ${zone}`;
  const [from, to] = [time(start), time(end)];
  // "12:30–1:00 PM" when both halves share AM or PM.
  return `${day.format(start)}, ${from.slice(-2) === to.slice(-2) ? from.slice(0, -3) : from}–${to} ${zone}`;
}

export function formatMoment(at: Date, timeZone: string): string {
  return new Intl.DateTimeFormat('en-US', { timeZone, weekday: 'short', month: 'short', day: 'numeric', hour: 'numeric', minute: '2-digit', timeZoneName: 'short' }).format(at).replace(/\u202f/g, ' ');
}

const quoted = (value: string) => `“${value}”`;

export function eventSteps(plan: EventPlan): AskApproval['steps'] {
  const when = formatRange(new Date(plan.start), new Date(plan.end), plan.timeZone);
  const extras = [plan.googleMeet ? 'Google Meet link' : '', plan.location ? `Location: ${plan.location}` : ''].filter(Boolean);
  const steps: AskApproval['steps'] = [{ text: `Add ${quoted(plan.summary)} to your calendar (${plan.accountEmail}): ${when}`.slice(0, 300), examples: extras.slice(0, 5), destructive: false }];
  if (plan.conflicts.length) steps.push({ text: `It overlaps ${plan.conflicts.length === 1 ? 'something already' : `${plan.conflicts.length} things already`} on your calendar`, examples: plan.conflicts.slice(0, 5), destructive: false });
  if (plan.attendees.length) {
    steps.push(plan.invite
      ? { text: `Email ${plan.attendees.length === 1 ? 'an invitation' : `${plan.attendees.length} invitations`} from Google Calendar. This can’t be unsent.`, count: plan.attendees.length, examples: plan.attendees.slice(0, 5), destructive: true }
      : { text: `List ${plan.attendees.length === 1 ? 'a guest' : `${plan.attendees.length} guests`} without emailing them`, count: plan.attendees.length, examples: plan.attendees.slice(0, 5), destructive: false });
  }
  return steps;
}

export function reminderSteps(plan: ReminderPlan): AskApproval['steps'] {
  const when = formatMoment(new Date(plan.at), plan.timeZone);
  const about = plan.subject ? ` about ${quoted(plan.subject)}` : '';
  const steps: AskApproval['steps'] = [{ text: `Remind you${about} on ${when}`.slice(0, 300), examples: plan.note && plan.note !== plan.subject ? [plan.note.slice(0, 200)] : [], destructive: false }];
  if (plan.snooze) steps.unshift({ text: 'Archive this thread now; it comes back to your inbox at the reminder', examples: plan.subject ? [plan.subject.slice(0, 200)] : [], destructive: false });
  return steps;
}

/** Busy time that overlaps the proposed event, read from free/busy only. */
export async function eventConflicts(deps: IntelDeps, account: AccountRow, start: Date, end: Date, timeZone: string): Promise<string[]> {
  try {
    const { busy } = await calendarFor(deps, account).freeBusyWithSelectedCalendars({ timeMin: start.toISOString(), timeMax: end.toISOString(), timeZone });
    const blocks = busy
      .map((block) => ({ start: new Date(block.start), end: new Date(block.end) }))
      .filter((block) => block.end > start && block.start < end)
      .sort((a, b) => a.start.getTime() - b.start.getTime());
    const seen = new Set<string>();
    return blocks.map((block) => `Busy ${formatRange(block.start, block.end, timeZone)}`).filter((text) => !seen.has(text) && Boolean(seen.add(text))).slice(0, 5);
  } catch {
    return [];
  }
}

export function validWindow(now: Date, start: Date, end?: Date): string | null {
  if (start.getTime() < now.getTime() - 5 * 60_000) return 'That time has already passed. Use a future time.';
  if (start.getTime() - now.getTime() > MAX_AHEAD_MS) return 'That is more than two years away.';
  if (end) {
    if (end.getTime() <= start.getTime()) return 'The event must end after it starts.';
    if (end.getTime() - start.getTime() > MAX_EVENT_MS) return 'Events longer than 12 hours are not supported here.';
  }
  return null;
}

/** Put an allowed event on the calendar. `approvalId` makes a retried Allow a no-op. */
export async function createChatEvent(deps: IntelDeps, userId: string, plan: EventPlan, approvalId: string, requestId: string) {
  const threadRowId = plan.gmailThreadId
    ? (await deps.db.asUser(userId, (tx) => one<{ id: string }>(tx, `select id from public.threads where mail_account_id = $1::uuid and gmail_thread_id = $2`, [plan.accountId, plan.gmailThreadId])))?.id ?? null
    : null;
  const prepared = await prepareEvent(deps, userId, {
    accountId: plan.accountId,
    threadRowId,
    gmailThreadId: plan.gmailThreadId,
    title: plan.summary,
    start: plan.start,
    end: plan.end,
    timeZone: plan.timeZone,
    attendees: plan.attendees,
    location: plan.location ?? undefined,
    description: plan.description ?? undefined,
    notifyAttendees: plan.invite && plan.attendees.length > 0,
  });
  const outcome = await performAction(deps, userId, {
    spec: { kind: 'create_event', params: { preparedEventId: prepared.id, notifyAttendees: prepared.notifyAttendees, googleMeet: plan.googleMeet } },
    target: { accountId: plan.accountId, threadRowId, gmailThreadId: plan.gmailThreadId, title: plan.summary },
    actor: { type: 'user', id: userId, name: 'Chat' },
    userInitiated: true,
    // The user allowed this exact event, invitations included, on the card.
    approved: true,
    idempotencyKey: `chat-event:${approvalId}`,
  });
  if (outcome.errorCode || !outcome.result) {
    await deps.db.asUser(userId, (tx) => tx.query(`update public.prepared_events set status = 'failed', updated_at = now() where id = $1::uuid and status = 'prepared'`, [prepared.id]));
    deps.log('warn', 'chat event failed', { requestId, code: outcome.errorCode ?? 'not_allowed' });
    return { created: false as const, problem: outcome.errorCode === 'action_unconfirmed' ? outcome.reason : outcome.errorCode?.startsWith('google_') ? `Google Calendar did not accept the event (${outcome.errorCode.slice(7)}).` : outcome.reason };
  }
  const row = await deps.db.asUser(userId, (tx) => one<{ calendar_event_id: string | null; html_link: string | null }>(tx, `select calendar_event_id, html_link from public.prepared_events where id = $1::uuid`, [prepared.id]));
  let meetLink: string | null = null;
  if (plan.googleMeet && row?.calendar_event_id) {
    meetLink = await calendarFor(deps, { id: plan.accountId, user_id: userId }).getEvent(row.calendar_event_id)
      .then((event) => event.hangoutLink ?? null)
      .catch(() => null);
  }
  return { created: true as const, eventId: row?.calendar_event_id ?? null, link: row?.html_link ?? null, meetLink, invited: prepared.notifyAttendees ? plan.attendees : [], undoable: Boolean(outcome.result.reversible) };
}

/** Schedule an allowed reminder (and snooze). */
export async function createChatReminder(deps: IntelDeps, userId: string, plan: ReminderPlan, approvalId: string) {
  const threadRowId = plan.gmailThreadId
    ? (await deps.db.asUser(userId, (tx) => one<{ id: string }>(tx, `select id from public.threads where mail_account_id = $1::uuid and gmail_thread_id = $2`, [plan.accountId, plan.gmailThreadId])))?.id ?? null
    : null;
  const outcome = await performAction(deps, userId, {
    spec: { kind: plan.snooze ? 'snooze' : 'remind', params: { at: plan.at, reason: (plan.note || plan.subject || 'Reminder').slice(0, 300), source: 'manual' } },
    target: { accountId: plan.accountId, threadRowId, gmailThreadId: plan.gmailThreadId, title: plan.subject },
    actor: { type: 'user', id: userId, name: 'Chat' },
    userInitiated: true,
    approved: true,
    idempotencyKey: `chat-reminder:${approvalId}`,
  });
  if (outcome.errorCode || !outcome.result) return { done: false as const, problem: outcome.errorCode === 'missing_feature' ? 'PigeonBox is not allowed to organize this inbox, so it could not snooze the thread.' : outcome.errorCode === 'action_unconfirmed' ? outcome.reason : `It could not be scheduled (${outcome.errorCode ?? outcome.reason}).` };
  return { done: true as const, at: formatMoment(new Date(plan.at), plan.timeZone), snoozed: plan.snooze };
}
