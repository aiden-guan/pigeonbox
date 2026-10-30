import type { CloudNotification, Preferences } from '@pigeonbox/api-contract';
import { addBusinessDaysInZone, isBusinessDay, safeTimeZone, zonedParts } from '@pigeonbox/shared';
import { iso, isoOrNull, num, type SqlExecutor } from '../db/sql.js';
import { enqueue } from '../jobs/queue.js';
import { loadPreferences, minutesOf } from './preferences.js';

type Row = {
  id: string;
  kind: CloudNotification['kind'];
  title: string;
  body: string;
  gmail_thread_id: string | null;
  mail_account_id: string | null;
  ref_id: string | null;
  created_at: unknown;
  read_at: unknown;
};

export async function listNotifications(tx: SqlExecutor, options: { since?: string; unreadOnly: boolean; limit: number }): Promise<{ notifications: CloudNotification[]; unread: number }> {
  const params: unknown[] = [options.limit];
  // A row held for quiet hours carries its delivery time as created_at and stays hidden until then.
  let where = 'created_at <= now()';
  if (options.since && Number.isFinite(Date.parse(options.since))) {
    params.push(new Date(options.since));
    where += ` and created_at > $${params.length}::timestamptz`;
  }
  if (options.unreadOnly) where += ' and read_at is null';
  const rows = await tx.query<Row>(`select * from public.notifications where ${where} order by created_at desc limit $1`, params);
  const unread = await tx.query<{ n: number }>(`select count(*)::int as n from public.notifications where read_at is null and created_at <= now()`);
  return {
    notifications: rows.map((row) => ({
      id: row.id,
      kind: row.kind,
      title: row.title.slice(0, 200),
      body: row.body.slice(0, 500),
      threadId: row.gmail_thread_id,
      accountId: row.mail_account_id,
      refId: row.ref_id,
      createdAt: iso(row.created_at),
      readAt: isoOrNull(row.read_at),
    })),
    unread: num(unread[0]?.n),
  };
}

export async function ackNotifications(tx: SqlExecutor, ids: string[]): Promise<void> {
  await tx.query(`update public.notifications set read_at = coalesce(read_at, now()) where id = any($1::uuid[])`, [ids]);
}

/**
 * How each kind may interrupt. Immediate kinds always notify: an approval, a
 * sync or re-auth problem, or a person asking for you is never batched or
 * dropped. Batchable kinds are routine background results; past a per-person
 * budget they collapse into one digest per kind and day, updated in place.
 * Follow-ups have their own cap and digest in followups.ts. Routine successful
 * work that is not listed here belongs on the dashboard, not in notifications.
 */
export const NOTIFICATION_CLASS: Record<CloudNotification['kind'], 'immediate' | 'batchable'> = {
  approval: 'immediate',
  sync_problem: 'immediate',
  mention: 'immediate',
  assignment: 'immediate',
  follow_up_due: 'batchable',
  draft_ready: 'batchable',
  engagement: 'batchable',
  briefing: 'batchable',
};
/** Individual notifications per person per window before a kind collapses into its digest. */
export const NOTIFICATION_BUDGET: Partial<Record<CloudNotification['kind'], number>> = { draft_ready: 5, engagement: 6 };
export const NOTIFICATION_WINDOW_MS = 20 * 3_600_000;

const DIGEST_COPY: Partial<Record<CloudNotification['kind'], (more: number) => { title: string; body: string }>> = {
  draft_ready: (more) => ({ title: `${more} more draft${more === 1 ? '' : 's'} ready`, body: `PigeonBox prepared ${more === 1 ? 'another draft' : `${more} more drafts`} for you to review. Nothing was sent.` }),
  engagement: (more) => ({ title: `${more} more tracking update${more === 1 ? '' : 's'}`, body: 'Open Tracking to see recent opens and clicks.' }),
};

/** The preference toggle that switches each kind off. Kinds not listed always notify. */
const PREFERENCE_TOGGLE: Partial<Record<CloudNotification['kind'], 'followUpsDue' | 'approvals' | 'engagement'>> = {
  follow_up_due: 'followUpsDue',
  approval: 'approvals',
  engagement: 'engagement',
};
/** Routine kinds that wait out the person's quiet hours. Briefings keep the time the person chose. */
const QUIET_HOURS_KINDS: ReadonlySet<CloudNotification['kind']> = new Set(['follow_up_due', 'draft_ready', 'engagement']);

/**
 * When a quiet-hours kind created at `now` should be delivered: `now` inside the
 * person's day, otherwise the start of their next one. Quiet hours come from
 * settings people already have: the day runs on workdays from the earlier of
 * working-hours start and the follow-up morning time, to working-hours end.
 */
export function deliveryTime(prefs: Preferences, now: Date): Date {
  const zone = safeTimeZone(prefs.timeZone);
  const morning = minutesOf(prefs.followUp.morningAt);
  const work = minutesOf(prefs.workingHours.start);
  const start = morning.hour * 60 + morning.minute < work.hour * 60 + work.minute ? morning : work;
  const end = minutesOf(prefs.workingHours.end);
  // Hours that end at 23:59 run to midnight.
  const endMinute = end.hour * 60 + end.minute >= 1439 ? 1440 : end.hour * 60 + end.minute;
  const local = zonedParts(now, zone);
  const minute = local.hour * 60 + local.minute;
  const week = { workdays: prefs.workdays };
  if (isBusinessDay(local, week) && minute < endMinute) {
    if (minute >= start.hour * 60 + start.minute) return now;
    return addBusinessDaysInZone(now, 0, zone, { ...week, at: start });
  }
  return addBusinessDaysInZone(now, 1, zone, { ...week, at: start });
}

export async function notify(
  tx: SqlExecutor,
  input: {
    userId: string; kind: CloudNotification['kind']; title: string; body: string; accountId?: string | null; threadId?: string | null; refId?: string | null; dedupeKey: string;
    /** The person picked this exact time (a reminder they set): no toggle or quiet hours applies. */
    chosenTime?: boolean;
  },
  now: Date = new Date(),
): Promise<void> {
  const toggle = input.chosenTime ? undefined : PREFERENCE_TOGGLE[input.kind];
  let deliverAt: Date | null = null;
  if (!input.chosenTime && (toggle || QUIET_HOURS_KINDS.has(input.kind))) {
    const prefs = await loadPreferences(tx, input.userId);
    // Switched off in Preferences: the work still happens and shows on the dashboard, without an alert.
    if (toggle && !prefs.notifications[toggle]) return;
    if (QUIET_HOURS_KINDS.has(input.kind)) {
      const at = deliveryTime(prefs, now);
      if (at.getTime() > now.getTime()) deliverAt = at;
    }
  }
  const budget = NOTIFICATION_CLASS[input.kind] === 'batchable' ? NOTIFICATION_BUDGET[input.kind] : undefined;
  if (budget !== undefined && !input.dedupeKey.startsWith('digest:')) {
    // One writer per person and kind at a time, so a concurrent burst cannot overshoot the budget.
    await tx.query(`select pg_advisory_xact_lock(hashtext($1))`, [`notify:${input.userId}:${input.kind}`]);
    const key = input.dedupeKey.slice(0, 200);
    if ((await tx.query(`select 1 from public.notifications where user_id = $1::uuid and dedupe_key = $2`, [input.userId, key])).length) return;
    const [counts] = await tx.query<{ individual: number }>(
      `select count(*)::int as individual from public.notifications
        where user_id = $1::uuid and kind = $2 and created_at > now() - make_interval(secs => $3) and dedupe_key not like 'digest:%'`,
      [input.userId, input.kind, NOTIFICATION_WINDOW_MS / 1000],
    );
    if (num(counts?.individual) >= budget) {
      const digestKey = `digest:${input.kind}:${now.toISOString().slice(0, 10)}`;
      const existing = await tx.query<{ title: string }>(`select title from public.notifications where user_id = $1::uuid and dedupe_key = $2`, [input.userId, digestKey]);
      // Every digest title starts with its count ("3 more drafts ready").
      const more = existing.length ? num(Number.parseInt(existing[0]!.title, 10) || 0) + 1 : 1;
      const copy = (DIGEST_COPY[input.kind] ?? ((n: number) => ({ title: `${n} more updates`, body: 'Open PigeonBox to review them.' })))(more);
      await insert(tx, { ...input, ...copy, accountId: null, threadId: null, refId: null, dedupeKey: digestKey }, deliverAt);
      // Updated in place and marked unread, like the follow-up digest; never a second notification.
      await tx.query(`update public.notifications set title = $3, body = $4, read_at = null where user_id = $1::uuid and dedupe_key = $2`, [input.userId, digestKey, copy.title, copy.body]);
      return;
    }
  }
  await insert(tx, input, deliverAt);
}

async function insert(
  tx: SqlExecutor,
  input: { userId: string; kind: CloudNotification['kind']; title: string; body: string; accountId?: string | null; threadId?: string | null; refId?: string | null; dedupeKey: string },
  deliverAt: Date | null = null,
): Promise<void> {
  const rows = await tx.query<{ id: string }>(
    `insert into public.notifications (user_id, kind, title, body, mail_account_id, gmail_thread_id, ref_id, dedupe_key, created_at)
     values ($1::uuid, $2, $3, $4, $5::uuid, $6, $7::uuid, $8, coalesce($9::timestamptz, now())) on conflict (user_id, dedupe_key) do nothing returning id`,
    [input.userId, input.kind, input.title.slice(0, 200), input.body.slice(0, 500), input.accountId ?? null, input.threadId ?? null, input.refId ?? null, input.dedupeKey.slice(0, 200), deliverAt],
  );
  if (!rows.length) return;
  // Developer webhooks subscribed to this kind get a signed delivery job.
  const hooks = await tx.query<{ id: string }>(`select id from public.webhooks where user_id = $1::uuid and enabled and $2 = any (events)`, [input.userId, input.kind]);
  for (const hook of hooks) {
    await enqueue(tx, { kind: 'webhook.deliver', userId: input.userId, accountId: null, key: `webhook:${hook.id}:${rows[0]!.id}`, payload: { webhookId: hook.id, notificationId: rows[0]!.id }, maxAttempts: 8 });
  }
}
