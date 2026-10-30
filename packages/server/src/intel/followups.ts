import { featureEnabled } from '../rollout.js';
import type { FollowUp, Preferences } from '@pigeonbox/api-contract';
import { addBusinessDaysInZone, nextLocalTime } from '@pigeonbox/shared';
import { iso, isoOrNull, num, one, type SqlExecutor } from '../db/sql.js';
import { ApiError } from '../http.js';
import { enqueue, type JobRecord } from '../jobs/queue.js';
import { SkipJob } from '../jobs/runner.js';
import { recordAudit } from './audit.js';
import type { IntelDeps } from './context.js';
import { loadPreferences, minutesOf } from './preferences.js';
import { notify } from './notifications.js';

/**
 * Follow-up Autopilot: the state of outbound conversations.
 *
 *   sent → waiting → engaged → reply | follow_up_due → closed
 *
 * Due dates are business days in the user's time zone. A reply from anyone
 * other than the user moves the conversation to `reply`, which makes any
 * scheduled due job a no-op. Nothing is ever sent: when a follow-up is due,
 * PigeonBox prepares a draft for review and tells the user.
 */

export type FollowUpRow = {
  id: string;
  user_id: string;
  mail_account_id: string;
  thread_id: string;
  gmail_thread_id: string;
  stage: FollowUp['stage'];
  reply_expected: boolean;
  expected_from: string[];
  reason: string;
  rule: FollowUp['rule'];
  last_outbound_at: unknown;
  last_outbound_message_id: string | null;
  last_inbound_at: unknown;
  due_at: unknown;
  snoozed_until: unknown;
  draft_id: string | null;
  engagement_opens: number;
  engagement_last_open_at: unknown;
  engagement_clicks: number;
  subject?: string;
};

export const FOLLOW_UP_COLUMNS = `f.id, f.user_id, f.mail_account_id, f.thread_id, t.gmail_thread_id, f.stage, f.reply_expected, f.expected_from, f.reason, f.rule,
  f.last_outbound_at, f.last_outbound_message_id, f.last_inbound_at, f.due_at, f.snoozed_until, f.draft_id,
  f.engagement_opens, f.engagement_last_open_at, f.engagement_clicks, t.subject`;

export function toFollowUp(row: FollowUpRow): FollowUp {
  const hasEngagement = num(row.engagement_opens) > 0 || num(row.engagement_clicks) > 0;
  return {
    id: row.id,
    threadId: row.gmail_thread_id,
    accountId: row.mail_account_id,
    stage: row.stage,
    expectedFrom: row.expected_from.slice(0, 20),
    dueAt: isoOrNull(row.due_at),
    reason: row.reason.slice(0, 300),
    rule: row.rule,
    lastOutboundAt: iso(row.last_outbound_at),
    lastInboundAt: isoOrNull(row.last_inbound_at),
    engagement: hasEngagement
      ? { likelyOpens: num(row.engagement_opens), lastLikelyOpenAt: isoOrNull(row.engagement_last_open_at), clicks: num(row.engagement_clicks) }
      : null,
    draftId: row.draft_id,
    snoozedUntil: isoOrNull(row.snoozed_until),
  };
}

export function followUpDueAt(sentAt: Date, prefs: Preferences, deadline: Date | null): { dueAt: Date; rule: FollowUp['rule'] } {
  const tz = prefs.timeZone;
  const week = { workdays: prefs.workdays };
  const at = prefs.followUp.prepareDraftMorningOf ? minutesOf(prefs.followUp.morningAt) : undefined;
  // They were asked for something by a date: follow up the business day after it passes.
  if (deadline && deadline.getTime() > sentAt.getTime()) {
    return { dueAt: addBusinessDaysInZone(deadline, 1, tz, { ...week, at }), rule: 'deadline' };
  }
  return { dueAt: addBusinessDaysInZone(sentAt, prefs.followUp.defaultBusinessDays, tz, { ...week, at }), rule: 'business_days' };
}

async function scheduleDue(tx: SqlExecutor, userId: string, accountId: string, followUpId: string, dueAt: Date): Promise<void> {
  await enqueue(tx, {
    kind: 'followup.due',
    userId,
    accountId,
    key: `followup:${followUpId}:${dueAt.toISOString()}`,
    payload: { followUpId },
    runAt: dueAt,
    maxAttempts: 6,
  });
}

/**
 * After analysis of a thread whose newest message is the user's: open or
 * refresh the conversation. Idempotent per outbound message.
 */
export async function trackOutbound(
  tx: SqlExecutor,
  input: {
    userId: string;
    accountId: string;
    threadRowId: string;
    prefs: Preferences;
    replyExpected: boolean;
    expectedFrom: string[];
    reason: string;
    lastOutboundAt: Date;
    lastOutboundMessageId: string | null;
    deadline: Date | null;
  },
): Promise<string | null> {
  const existing = await one<{ id: string; last_outbound_message_id: string | null; stage: string }>(
    tx,
    `select id, last_outbound_message_id, stage from public.follow_ups where thread_id = $1::uuid`,
    [input.threadRowId],
  );
  if (existing && existing.last_outbound_message_id === input.lastOutboundMessageId && existing.stage !== 'reply') return existing.id;
  if (!input.replyExpected) {
    if (existing) {
      await tx.query(
        `update public.follow_ups set stage = 'sent', reply_expected = false, last_outbound_at = $2::timestamptz, last_outbound_message_id = $3, due_at = null, updated_at = now() where id = $1::uuid`,
        [existing.id, input.lastOutboundAt, input.lastOutboundMessageId],
      );
      return existing.id;
    }
    const row = await one<{ id: string }>(
      tx,
      `insert into public.follow_ups (user_id, mail_account_id, thread_id, stage, reply_expected, expected_from, reason, rule, last_outbound_at, last_outbound_message_id)
       values ($1::uuid, $2::uuid, $3::uuid, 'sent', false, $4::text[], $5, 'business_days', $6::timestamptz, $7) returning id`,
      [input.userId, input.accountId, input.threadRowId, input.expectedFrom, input.reason.slice(0, 300), input.lastOutboundAt, input.lastOutboundMessageId],
    );
    return row?.id ?? null;
  }
  const { dueAt, rule } = followUpDueAt(input.lastOutboundAt, input.prefs, input.deadline);
  const row = await one<{ id: string }>(
    tx,
    `insert into public.follow_ups (user_id, mail_account_id, thread_id, stage, reply_expected, expected_from, reason, rule, business_days, last_outbound_at, last_outbound_message_id, due_at)
     values ($1::uuid, $2::uuid, $3::uuid, 'waiting', true, $4::text[], $5, $6, $7, $8::timestamptz, $9, $10::timestamptz)
     on conflict (thread_id) do update set stage = 'waiting', reply_expected = true, expected_from = excluded.expected_from, reason = excluded.reason,
       rule = excluded.rule, business_days = excluded.business_days, last_outbound_at = excluded.last_outbound_at,
       last_outbound_message_id = excluded.last_outbound_message_id, due_at = excluded.due_at, snoozed_until = null,
       notified_at = null, closed_reason = null, engagement_opens = 0, engagement_clicks = 0, engagement_last_open_at = null, updated_at = now()
     returning id`,
    [
      input.userId,
      input.accountId,
      input.threadRowId,
      input.expectedFrom.slice(0, 20),
      input.reason.slice(0, 300),
      rule,
      input.prefs.followUp.defaultBusinessDays,
      input.lastOutboundAt,
      input.lastOutboundMessageId,
      dueAt,
    ],
  );
  if (row) await scheduleDue(tx, input.userId, input.accountId, row.id, dueAt);
  return row?.id ?? null;
}

/**
 * Called by sync as soon as a new inbound message lands: a reply cancels the
 * pending follow-up (the due job sees `reply` and does nothing). Returns the
 * follow-ups that became `reply`, and threads that revived after a long quiet.
 */
export async function recordInboundActivity(tx: SqlExecutor, threadRowIds: string[]): Promise<{ replied: string[]; revived: string[] }> {
  if (!threadRowIds.length) return { replied: [], revived: [] };
  const replied = await tx.query<{ id: string }>(
    `update public.follow_ups f
        set stage = 'reply', last_inbound_at = t.last_inbound_at, closed_reason = 'replied', updated_at = now()
       from public.threads t
      where t.id = f.thread_id and f.thread_id = any($1::uuid[])
        and f.stage in ('waiting', 'engaged', 'follow_up_due')
        and t.last_inbound_at > f.last_outbound_at
      returning f.id`,
    [threadRowIds],
  );
  const revived = await tx.query<{ thread_id: string }>(
    `update public.follow_ups f
        set last_inbound_at = t.last_inbound_at, updated_at = now()
       from public.threads t
      where t.id = f.thread_id and f.thread_id = any($1::uuid[])
        and f.stage in ('reply', 'closed', 'sent')
        and t.last_inbound_at > greatest(f.last_outbound_at, coalesce(f.last_inbound_at, f.last_outbound_at)) + interval '14 days'
      returning f.thread_id`,
    [threadRowIds],
  );
  // Drafts written for a follow-up are moot once they replied.
  if (replied.length) {
    await tx.query(
      `update public.drafts set status = 'stale', stale_reason = 'They replied', updated_at = now()
        where id in (select draft_id from public.follow_ups where id = any($1::uuid[]) and draft_id is not null) and status in ('ready', 'preparing')`,
      [replied.map((row) => row.id)],
    );
  }
  return { replied: replied.map((row) => row.id), revived: revived.map((row) => row.thread_id) };
}

/** Human-likely engagement from tracking moves `waiting` to `engaged`, and may pull the follow-up earlier. */
export async function recordEngagement(
  tx: SqlExecutor,
  input: { userId: string; accountId: string; threadRowId: string; opens: number; clicks: number; lastOpenAt: Date | null; prefs: Preferences },
): Promise<void> {
  const row = await one<{ id: string; stage: string; due_at: unknown }>(
    tx,
    `update public.follow_ups set engagement_opens = $2, engagement_clicks = $3, engagement_last_open_at = $4::timestamptz,
            stage = case when stage = 'waiting' and ($2 > 0 or $3 > 0) then 'engaged' else stage end, updated_at = now()
      where thread_id = $1::uuid and stage in ('waiting', 'engaged') returning id, stage, due_at`,
    [input.threadRowId, input.opens, input.clicks, input.lastOpenAt],
  );
  if (!row || !input.prefs.followUp.remindIfOpenedNoReply || !input.lastOpenAt) return;
  // "Remind me tomorrow if they opened it but did not answer."
  const tomorrow = addBusinessDaysInZone(input.lastOpenAt, 1, input.prefs.timeZone, { workdays: input.prefs.workdays, at: minutesOf(input.prefs.followUp.morningAt) });
  const current = row.due_at ? new Date(iso(row.due_at)) : null;
  if (!current || tomorrow.getTime() < current.getTime()) {
    await tx.query(`update public.follow_ups set due_at = $2::timestamptz, rule = 'opened_no_reply', reason = 'Opened but no reply yet', updated_at = now() where id = $1::uuid`, [row.id, tomorrow]);
    await scheduleDue(tx, input.userId, input.accountId, row.id, tomorrow);
  }
}

/** Per user, per rolling window: individual follow-up alerts, and drafts prepared without being asked. */
export const FOLLOW_UP_ALERTS_PER_WINDOW = 3;
export const FOLLOW_UP_DRAFTS_PER_WINDOW = 5;
const FOLLOW_UP_WINDOW_MS = 20 * 3_600_000;

/**
 * One notification for the follow-ups past the alert cap, updated in place as more come due.
 * Keyed to the due hour: a burst shares one due time, so it shares one digest.
 */
async function notifyFollowUpDigest(tx: SqlExecutor, userId: string, since: Date, dueAt: string): Promise<void> {
  const due = num((await one<{ n: number }>(tx, `select count(*)::int as n from public.follow_ups where notified_at > $1::timestamptz`, [since]))?.n);
  const more = Math.max(1, due - FOLLOW_UP_ALERTS_PER_WINDOW);
  const title = `${more} more follow-up${more === 1 ? '' : 's'} due`;
  const body = `${more === 1 ? 'Another conversation has' : `${more} more conversations have`} not had a reply. Open Follow-ups to review ${more === 1 ? 'it' : 'them'}.`;
  const dedupeKey = `followup_digest:${dueAt.slice(0, 13)}`;
  await notify(tx, { userId, kind: 'follow_up_due', title, body, dedupeKey });
  await tx.query(`update public.notifications set title = $2, body = $3, read_at = null where user_id = $1::uuid and dedupe_key = $4`, [userId, title, body, dedupeKey]);
}

/** The due job: mark it due, prepare a draft for review, notify. Never sends. */
export async function runFollowUpDue(deps: IntelDeps, job: JobRecord, canDraft: boolean): Promise<void> {
  const followUpId = String(job.payload.followUpId ?? '');
  if (!job.userId || !followUpId) throw new SkipJob('missing_ids');
  const userId = job.userId;
  await deps.db.asUser(userId, async (tx) => {
    const row = await one<FollowUpRow & { state_user: string | null }>(
      tx,
      `select ${FOLLOW_UP_COLUMNS}, s.user_state as state_user from public.follow_ups f join public.threads t on t.id = f.thread_id
         left join public.thread_states s on s.thread_id = f.thread_id where f.id = $1::uuid`,
      [followUpId],
    );
    if (!row) throw new SkipJob('follow_up_gone');
    const now = deps.now().getTime();
    if (row.stage !== 'waiting' && row.stage !== 'engaged') throw new SkipJob(`stage_${row.stage}`);
    const due = row.due_at ? Date.parse(iso(row.due_at)) : NaN;
    if (!Number.isFinite(due) || due > now + 60_000) throw new SkipJob('rescheduled');
    const snoozed = row.snoozed_until ? Date.parse(iso(row.snoozed_until)) : NaN;
    if (Number.isFinite(snoozed) && snoozed > now) throw new SkipJob('snoozed');

    // Follow-ups that came due earlier in the window. Due dates share one morning time, so a busy
    // sending day comes due all at once; past the caps the rest roll into one digest and get a
    // draft only when the user asks for one (`prepare_draft`).
    const since = new Date(now - FOLLOW_UP_WINDOW_MS);
    const earlier = num(
      (await one<{ n: number }>(tx, `select count(*)::int as n from public.follow_ups where notified_at > $1::timestamptz and id <> $2::uuid`, [since, followUpId]))?.n,
    );
    const prepareDraft = canDraft && earlier < FOLLOW_UP_DRAFTS_PER_WINDOW && featureEnabled(deps.config.rollout, 'followup_drafts', userId);

    await tx.query(`update public.follow_ups set stage = 'follow_up_due', notified_at = $2::timestamptz, updated_at = now() where id = $1::uuid`, [followUpId, new Date(now)]);
    await tx.query(`update public.thread_states set state = 'FOLLOW_UP_DUE', updated_at = now() where thread_id = $1::uuid and user_state is null`, [row.thread_id]);
    const recipients = row.expected_from.slice(0, 3).join(', ');
    if (earlier < FOLLOW_UP_ALERTS_PER_WINDOW) {
      await notify(tx, {
        userId,
        kind: 'follow_up_due',
        title: `Follow up: ${(row.subject || '(no subject)').slice(0, 150)}`,
        body: `${recipients || 'They'} ha${row.expected_from.length === 1 ? 's' : 've'} not replied.${prepareDraft ? ' A follow-up draft is being prepared for you to review.' : ''}`,
        accountId: row.mail_account_id,
        threadId: row.gmail_thread_id,
        refId: followUpId,
        dedupeKey: `followup:${followUpId}:${iso(row.due_at)}`,
      });
    } else {
      await notifyFollowUpDigest(tx, userId, since, iso(row.due_at));
    }
    if (prepareDraft) {
      await enqueue(tx, {
        kind: 'draft.prepare',
        userId,
        accountId: row.mail_account_id,
        key: `draft:followup:${followUpId}:${iso(row.due_at)}`,
        payload: { threadId: row.thread_id, kind: 'follow_up', origin: 'follow_up', followUpId },
        maxAttempts: 4,
      });
    }
    await recordAudit(tx, {
      userId,
      actor: { type: 'follow_up', id: followUpId, name: 'Follow-up Autopilot' },
      action: 'follow_up_due',
      tier: 0,
      target: { kind: 'thread', id: row.gmail_thread_id, title: row.subject ?? null },
      summary: `Follow-up due${recipients ? ` with ${recipients}` : ''}`,
      policy: { decision: 'allowed', reason: 'Read-only reminder' },
      accountId: row.mail_account_id,
      threadId: row.gmail_thread_id,
      idempotencyKey: `followup_due:${followUpId}:${iso(row.due_at)}`,
    });
  });
}

export async function listFollowUps(tx: SqlExecutor, options: { stages?: FollowUp['stage'][]; accountId?: string | null; limit: number }) {
  const params: unknown[] = [options.limit];
  let where = `f.stage <> 'sent'`;
  if (options.stages?.length) {
    params.push(options.stages);
    where = `f.stage = any($${params.length}::text[])`;
  }
  if (options.accountId) {
    params.push(options.accountId);
    where += ` and f.mail_account_id = $${params.length}::uuid`;
  }
  const rows = await tx.query<FollowUpRow & { who: string | null }>(
    `select ${FOLLOW_UP_COLUMNS}, (select coalesce(m.to_emails[1], '') from public.message_metadata m where m.thread_id = f.thread_id and m.direction = 'outbound' order by m.internal_date desc limit 1) as who
       from public.follow_ups f join public.threads t on t.id = f.thread_id
      where ${where}
      order by case f.stage when 'follow_up_due' then 0 when 'engaged' then 1 when 'waiting' then 2 when 'reply' then 3 else 4 end, f.due_at nulls last
      limit $1`,
    params,
  );
  return rows.map((row) => ({ followUp: toFollowUp(row), subject: (row.subject ?? '').slice(0, 998), who: (row.who || row.expected_from[0] || '').slice(0, 320) }));
}

export async function updateFollowUp(
  deps: IntelDeps,
  tx: SqlExecutor,
  userId: string,
  request: { followUpId: string; action: 'snooze' | 'close' | 'reopen' | 'remind_at' | 'prepare_draft'; at?: string },
  canDraft: boolean,
): Promise<FollowUp> {
  const row = await one<FollowUpRow>(tx, `select ${FOLLOW_UP_COLUMNS} from public.follow_ups f join public.threads t on t.id = f.thread_id where f.id = $1::uuid`, [request.followUpId]);
  if (!row) throw new ApiError('not_found', 'That follow-up does not exist.');
  const preferences = await loadPreferences(tx, userId);
  const at = request.at ? new Date(request.at) : null;
  switch (request.action) {
    case 'close':
      await tx.query(`update public.follow_ups set stage = 'closed', closed_reason = 'closed_by_user', updated_at = now() where id = $1::uuid`, [row.id]);
      await tx.query(`update public.thread_states set state = 'DONE', updated_at = now() where thread_id = $1::uuid and user_state is null`, [row.thread_id]);
      break;
    case 'reopen': {
      const dueAt = addBusinessDaysInZone(deps.now(), preferences.followUp.defaultBusinessDays, preferences.timeZone, { workdays: preferences.workdays });
      await tx.query(`update public.follow_ups set stage = 'waiting', due_at = $2::timestamptz, closed_reason = null, updated_at = now() where id = $1::uuid`, [row.id, dueAt]);
      await scheduleDue(tx, userId, row.mail_account_id, row.id, dueAt);
      break;
    }
    case 'snooze':
    case 'remind_at': {
      const until =
        at && at.getTime() > deps.now().getTime()
          ? at
          : nextLocalTime(new Date(deps.now().getTime() + 3_600_000), minutesOf(preferences.followUp.morningAt), preferences.timeZone, { businessDaysOnly: true, workdays: preferences.workdays });
      await tx.query(
        `update public.follow_ups set stage = case when stage in ('follow_up_due', 'reply', 'closed', 'sent') then 'waiting' else stage end,
                snoozed_until = $2::timestamptz, due_at = $2::timestamptz, rule = 'manual', updated_at = now() where id = $1::uuid`,
        [row.id, until],
      );
      await scheduleDue(tx, userId, row.mail_account_id, row.id, until);
      break;
    }
    case 'prepare_draft':
      if (!canDraft) throw new ApiError('entitlement_required', 'Follow-up drafts need prepared drafts, which this server is not configured for.');
      await enqueue(tx, {
        kind: 'draft.prepare',
        userId,
        accountId: row.mail_account_id,
        key: `draft:followup:${row.id}:manual:${deps.now().toISOString().slice(0, 16)}`,
        payload: { threadId: row.thread_id, kind: 'follow_up', origin: 'follow_up', followUpId: row.id },
        maxAttempts: 4,
      });
      break;
  }
  const updated = await one<FollowUpRow>(tx, `select ${FOLLOW_UP_COLUMNS} from public.follow_ups f join public.threads t on t.id = f.thread_id where f.id = $1::uuid`, [row.id]);
  return toFollowUp(updated!);
}
