import type { ActionKind, ActionSpec, RiskTier } from '@pigeonbox/api-contract';
import { ThreadStateSchema, categoryForThreadState } from '@pigeonbox/shared';
import { one } from '../db/sql.js';
import { GoogleApiError } from '../google/errors.js';
import { ApiError } from '../http.js';
import { enqueue } from '../jobs/queue.js';
import { recordAudit, type ActorType } from './audit.js';
import type { IntelDeps } from './context.js';
import { calendarFor, gmailFor, loadAccount, requireFeature, type AccountRow } from './google-access.js';
import { notify } from './notifications.js';
import { actionTier, ACTION_LABELS, decide, type Autonomy, type PolicyDecision } from './policy.js';
import { loadPreferences } from './preferences.js';
import { addBusinessDaysInZone } from '@pigeonbox/shared';
import { minutesOf } from './preferences.js';

/**
 * The action registry. Every action PigeonBox takes on the user's behalf goes
 * through `performAction`: tier → policy decision → execution (or shadow
 * record, or approval request) → audit row with an undo recipe. New action
 * kinds are added by registering an executor here; nothing else calls Gmail
 * or Calendar to change state.
 */

export type ActionTarget = { accountId: string; threadRowId: string | null; gmailThreadId: string | null; title: string | null };

export type ActionActor = { type: ActorType; id: string | null; name: string; autonomy?: Autonomy; mode?: 'shadow' | 'active' | 'view'; scopes?: Array<'read' | 'prepare' | 'write'> };

export type ExecutionResult = { summary: string; reversible: boolean; undo: Record<string, unknown> | null };

type ExecutorContext = { deps: IntelDeps; userId: string; account: AccountRow; target: ActionTarget; params: ActionSpec['params'] };
type Executor = (ctx: ExecutorContext) => Promise<ExecutionResult>;

async function labelIdFor(ctx: ExecutorContext, name: string): Promise<string> {
  const system: Record<string, string> = { inbox: 'INBOX', important: 'IMPORTANT', starred: 'STARRED', unread: 'UNREAD' };
  if (system[name.toLowerCase()]) return system[name.toLowerCase()]!;
  const gmail = gmailFor(ctx.deps, ctx.account);
  const labels = (await gmail.listLabels()).labels ?? [];
  const existing = labels.find((label) => label.name.toLowerCase() === name.toLowerCase());
  if (existing) return existing.id;
  return (await gmail.createLabel(name.slice(0, 100))).id;
}

function requireThreadTarget(ctx: ExecutorContext): string {
  if (!ctx.target.gmailThreadId) throw new ApiError('invalid_request', 'This action needs a thread.');
  return ctx.target.gmailThreadId;
}

async function modifyLabels(ctx: ExecutorContext, add: string[], remove: string[], summary: string): Promise<ExecutionResult> {
  requireFeature(ctx.account, 'organize');
  const threadId = requireThreadTarget(ctx);
  await gmailFor(ctx.deps, ctx.account).modifyThread(threadId, { addLabelIds: add, removeLabelIds: remove });
  return { summary, reversible: true, undo: { op: 'modify_labels', gmailThreadId: threadId, addLabelIds: remove, removeLabelIds: add } };
}

async function scheduleReminder(ctx: ExecutorContext, remindAt: Date, reason: string, restoreInbox: boolean): Promise<string> {
  return ctx.deps.db.asUser(ctx.userId, async (tx) => {
    const row = await one<{ id: string }>(
      tx,
      `insert into public.reminders (user_id, mail_account_id, thread_id, remind_at, reason, source) values ($1::uuid, $2::uuid, $3::uuid, $4::timestamptz, $5, 'rule') returning id`,
      [ctx.userId, ctx.account.id, ctx.target.threadRowId, remindAt, reason.slice(0, 300)],
    );
    await enqueue(tx, {
      kind: 'reminder.fire',
      userId: ctx.userId,
      accountId: ctx.account.id,
      key: `reminder:${row!.id}`,
      payload: { reminderId: row!.id, restoreInbox, gmailThreadId: ctx.target.gmailThreadId },
      runAt: remindAt,
      maxAttempts: 4,
    });
    return row!.id;
  });
}

async function remindTime(ctx: ExecutorContext): Promise<Date> {
  const prefs = await ctx.deps.db.asUser(ctx.userId, (tx) => loadPreferences(tx, ctx.userId));
  const at = typeof ctx.params.at === 'string' && Number.isFinite(Date.parse(ctx.params.at)) ? new Date(ctx.params.at) : null;
  if (at && at.getTime() > ctx.deps.now().getTime()) return at;
  const days = typeof ctx.params.businessDays === 'number' ? Math.max(0, Math.min(60, ctx.params.businessDays)) : 1;
  return addBusinessDaysInZone(ctx.deps.now(), days, prefs.timeZone, { workdays: prefs.workdays, at: minutesOf(prefs.followUp.morningAt) });
}

const EXECUTORS: Record<ActionKind, Executor> = {
  classify: async () => ({ summary: 'Classified the thread', reversible: false, undo: null }),
  set_state: async (ctx) => {
    const state = ThreadStateSchema.parse(ctx.params.state);
    if (!ctx.target.threadRowId) throw new ApiError('invalid_request', 'This action needs a synced thread.');
    const previous = await ctx.deps.db.asUser(ctx.userId, async (tx) => {
      const before = await one<{ state: string }>(tx, `select state from public.thread_states where thread_id = $1::uuid`, [ctx.target.threadRowId]);
      await tx.query(`update public.thread_states set state = $2, category = $3, source = 'rule', updated_at = now() where thread_id = $1::uuid and user_state is null`, [
        ctx.target.threadRowId,
        state,
        categoryForThreadState(state),
      ]);
      return before?.state ?? null;
    });
    return { summary: `Set the thread to ${state.toLowerCase().replace(/_/g, ' ')}`, reversible: Boolean(previous), undo: previous ? { op: 'set_state', threadRowId: ctx.target.threadRowId, state: previous } : null };
  },
  run_analysis: async (ctx) => {
    if (!ctx.target.threadRowId) throw new ApiError('invalid_request', 'This action needs a synced thread.');
    await ctx.deps.db.asUser(ctx.userId, (tx) =>
      enqueue(tx, { kind: 'thread.analyze', userId: ctx.userId, accountId: ctx.account.id, key: `analyze:${ctx.target.threadRowId}:forced:${ctx.deps.now().toISOString().slice(0, 16)}`, payload: { threadId: ctx.target.threadRowId, force: true } }),
    );
    return { summary: 'Queued a fresh analysis', reversible: false, undo: null };
  },
  create_note: async (ctx) => {
    const text = String(ctx.params.text ?? '').slice(0, 2_000) || 'Flagged by an automation';
    await ctx.deps.db.asUser(ctx.userId, async (tx) => {
      const id = crypto.randomUUID();
      const sealed = await ctx.deps.box.seal(text, { purpose: 'note', userId: ctx.userId, recordId: id });
      await tx.query(`insert into public.notes (id, user_id, thread_id, body_key_id, body_iv, body_ciphertext, source) values ($1::uuid, $2::uuid, $3::uuid, $4, $5, $6, 'automation')`, [
        id,
        ctx.userId,
        ctx.target.threadRowId,
        sealed.keyId,
        sealed.iv,
        sealed.ciphertext,
      ]);
    });
    return { summary: 'Added an internal note', reversible: false, undo: null };
  },
  notify: async (ctx) => {
    await ctx.deps.db.asUser(ctx.userId, (tx) =>
      notify(tx, {
        userId: ctx.userId,
        kind: 'engagement',
        title: String(ctx.params.title ?? ctx.target.title ?? 'PigeonBox').slice(0, 200),
        body: String(ctx.params.message ?? 'An automation flagged this thread.').slice(0, 500),
        accountId: ctx.account.id,
        threadId: ctx.target.gmailThreadId,
        dedupeKey: `notify:${ctx.target.gmailThreadId ?? 'none'}:${String(ctx.params.key ?? ctx.deps.now().toISOString().slice(0, 13))}`,
      }),
    );
    return { summary: 'Sent you a notification', reversible: false, undo: null };
  },
  draft_reply: async (ctx) => {
    if (!ctx.target.threadRowId) throw new ApiError('invalid_request', 'This action needs a synced thread.');
    await ctx.deps.db.asUser(ctx.userId, (tx) =>
      enqueue(tx, {
        kind: 'draft.prepare',
        userId: ctx.userId,
        accountId: ctx.account.id,
        key: `draft:${ctx.target.threadRowId}:action:${String(ctx.params.key ?? ctx.deps.now().toISOString().slice(0, 13))}`,
        payload: { threadId: ctx.target.threadRowId, kind: 'reply', origin: 'automation', instructions: ctx.params.instructions ?? null },
      }),
    );
    return { summary: 'Queued a reply draft for review', reversible: false, undo: null };
  },
  draft_follow_up: async (ctx) => {
    if (!ctx.target.threadRowId) throw new ApiError('invalid_request', 'This action needs a synced thread.');
    await ctx.deps.db.asUser(ctx.userId, (tx) =>
      enqueue(tx, {
        kind: 'draft.prepare',
        userId: ctx.userId,
        accountId: ctx.account.id,
        key: `draft:${ctx.target.threadRowId}:followup-action:${String(ctx.params.key ?? ctx.deps.now().toISOString().slice(0, 13))}`,
        payload: { threadId: ctx.target.threadRowId, kind: 'follow_up', origin: 'automation' },
      }),
    );
    return { summary: 'Queued a follow-up draft for review', reversible: false, undo: null };
  },
  prepare_event: async (ctx) => {
    const title = String(ctx.params.title ?? ctx.target.title ?? 'Meeting').slice(0, 300);
    return { summary: `Prepared "${title}" for you to schedule`, reversible: false, undo: null };
  },
  label: async (ctx) => {
    const name = String(ctx.params.label ?? '').trim();
    if (!name) throw new ApiError('invalid_request', 'Which label?');
    const id = await labelIdFor(ctx, name);
    return modifyLabels(ctx, [id], [], `Applied the label "${name}"`);
  },
  remove_label: async (ctx) => {
    const name = String(ctx.params.label ?? '').trim();
    const id = await labelIdFor(ctx, name);
    return modifyLabels(ctx, [], [id], `Removed the label "${name}"`);
  },
  archive: (ctx) => modifyLabels(ctx, [], ['INBOX'], 'Archived (moved out of the inbox)'),
  mark_important: (ctx) => modifyLabels(ctx, ['IMPORTANT'], [], 'Marked important'),
  star: (ctx) => modifyLabels(ctx, ['STARRED'], [], 'Starred'),
  snooze: async (ctx) => {
    const until = await remindTime(ctx);
    const result = await modifyLabels(ctx, [], ['INBOX'], 'Snoozed');
    const reminderId = await scheduleReminder(ctx, until, 'Snoozed thread is back', true);
    return { summary: `Snoozed until ${until.toISOString().slice(0, 16).replace('T', ' ')} UTC`, reversible: true, undo: { ...result.undo, reminderId } };
  },
  remind: async (ctx) => {
    const at = await remindTime(ctx);
    const reminderId = await scheduleReminder(ctx, at, String(ctx.params.reason ?? 'Reminder').slice(0, 300), false);
    return { summary: `Reminder set for ${at.toISOString().slice(0, 16).replace('T', ' ')} UTC`, reversible: true, undo: { op: 'cancel_reminder', reminderId } };
  },
  create_task: async (ctx) => {
    const title = String(ctx.params.title ?? `Follow up: ${ctx.target.title ?? 'thread'}`).slice(0, 300);
    const id = crypto.randomUUID();
    await ctx.deps.db.asUser(ctx.userId, async (tx) => {
      const sealed = await ctx.deps.box.seal(title, { purpose: 'note', userId: ctx.userId, recordId: id });
      await tx.query(
        `insert into public.tasks (id, user_id, thread_id, gmail_thread_id, title_key_id, title_iv, title_ciphertext, source) values ($1::uuid, $2::uuid, $3::uuid, $4, $5, $6, $7, 'automation')`,
        [id, ctx.userId, ctx.target.threadRowId, ctx.target.gmailThreadId, sealed.keyId, sealed.iv, sealed.ciphertext],
      );
    });
    return { summary: 'Created a task', reversible: true, undo: { op: 'cancel_task', taskId: id } };
  },
  create_event: async (ctx) => {
    requireFeature(ctx.account, 'calendar_write');
    const preparedId = String(ctx.params.preparedEventId ?? '');
    const event = await ctx.deps.db.asUser(ctx.userId, (tx) =>
      one<{ id: string; title: string; start_at: Date; end_at: Date; time_zone: string; attendees: string[]; location: string | null; notify_attendees: boolean; status: string }>(
        tx,
        `select id, title, start_at, end_at, time_zone, attendees, location, notify_attendees, status from public.prepared_events where id = $1::uuid`,
        [preparedId],
      ),
    );
    if (!event) throw new ApiError('not_found', 'That prepared event does not exist.');
    const created = await calendarFor(ctx.deps, ctx.account).insertEvent(
      {
        summary: event.title,
        location: event.location ?? undefined,
        start: { dateTime: new Date(event.start_at).toISOString(), timeZone: event.time_zone },
        end: { dateTime: new Date(event.end_at).toISOString(), timeZone: event.time_zone },
        attendees: event.attendees.map((email) => ({ email })),
      },
      event.notify_attendees ? 'all' : 'none',
    );
    await ctx.deps.db.asUser(ctx.userId, (tx) =>
      tx.query(`update public.prepared_events set status = 'created', calendar_event_id = $2, html_link = $3, updated_at = now() where id = $1::uuid`, [event.id, created.id, created.htmlLink ?? null]),
    );
    return {
      summary: event.notify_attendees ? `Created "${event.title}" and sent invitations` : `Added "${event.title}" to your calendar`,
      reversible: !event.notify_attendees,
      undo: event.notify_attendees ? null : { op: 'delete_calendar_event', calendarEventId: created.id, preparedEventId: event.id },
    };
  },
  send_email: async (ctx) => {
    requireFeature(ctx.account, 'send');
    const raw = String(ctx.params.raw ?? '');
    if (!raw) throw new ApiError('invalid_request', 'Nothing to send.');
    // Stamp the actual dispatch attempt, after the irreversible-action
    // reservation. A retry of a definitively rejected request gets a fresh
    // send time; an uncertain dispatch cannot reach this executor again.
    if (typeof ctx.params.trackingId === 'string' && /^trk_[0-9a-f]{32}$/.test(ctx.params.trackingId)) {
      await ctx.deps.store.trackerStoreFor(ctx.userId).updateEmail(ctx.params.trackingId, { status: 'PENDING', sent_at: ctx.deps.now().toISOString() });
    }
    const sent = await gmailFor(ctx.deps, ctx.account).sendMessage(raw, ctx.target.gmailThreadId);
    return { summary: 'Sent the approved email', reversible: false, undo: { op: 'none', gmailMessageId: sent.id, gmailThreadId: sent.threadId ?? null } };
  },
};

export type PerformOutcome = {
  decision: PolicyDecision;
  reason: string;
  tier: RiskTier;
  auditId: string | null;
  result: ExecutionResult | null;
  errorCode: string | null;
};

/**
 * Decide and (when allowed) run one action. Shadow and approval outcomes are
 * returned to the caller, which records them in its own place (shadow
 * decisions, approval queue). Allowed actions are executed and audited.
 */
export async function performAction(
  deps: IntelDeps,
  userId: string,
  input: { spec: ActionSpec; target: ActionTarget; actor: ActionActor; userInitiated: boolean; approved?: boolean; idempotencyKey?: string | null },
): Promise<PerformOutcome> {
  const tier = actionTier(input.spec);
  const prefs = tier === 2 ? await deps.db.asUser(userId, (tx) => loadPreferences(tx, userId)) : null;
  const policy = decide({
    tier,
    actor: input.actor.type,
    userInitiated: input.userInitiated,
    approved: input.approved,
    mode: input.actor.mode,
    autonomy: input.actor.autonomy,
    scopes: input.actor.scopes,
    autoPlaceDrafts: prefs?.autoDrafts.placeInGmail,
  });
  if (policy.decision !== 'allowed') return { decision: policy.decision, reason: policy.reason, tier, auditId: null, result: null, errorCode: null };

  if (input.idempotencyKey) {
    const existing = await deps.db.asUser(userId, (tx) => one<{ id: string }>(tx, `select id from public.audit_events where idempotency_key = $1`, [`action:${input.idempotencyKey}`]));
    if (existing) return { decision: 'allowed', reason: 'Already done', tier, auditId: existing.id, result: null, errorCode: null };
  }
  const account = await deps.db.asUser(userId, (tx) => loadAccount(tx, input.target.accountId));
  if (!account) throw new ApiError('not_found', 'That Google account is not connected.');
  // Gmail send and Calendar invitations have no provider idempotency key.
  // Commit the reservation before dispatch: a lost response or Worker restart
  // must never replay an irreversible action whose result is uncertain.
  // external_action reservations are exempt from ordinary receipt retention.
  const dispatchKey = tier === 3 ? input.idempotencyKey : null;
  const unconfirmedReason = input.spec.kind === 'send_email'
    ? 'Delivery was not confirmed. Check your Sent mail before repeating this action.'
    : 'Completion was not confirmed. Check your calendar before repeating this action.';
  if (tier === 3 && !dispatchKey) throw new ApiError('invalid_request', 'This action needs an idempotency key.');
  if (dispatchKey) {
    const reserved = await deps.db.asUser(userId, (tx) => tx.query(
      `insert into public.idempotency_keys (user_id, scope, key, result)
       values ($1::uuid, 'external_action', $2, '{"status":"started"}'::jsonb)
       on conflict (user_id, scope, key) do nothing returning key`,
      [userId, dispatchKey],
    ));
    if (!reserved.length) return { decision: 'allowed', reason: unconfirmedReason, tier, auditId: null, result: null, errorCode: 'action_unconfirmed' };
  }
  let result: ExecutionResult;
  try {
    result = await EXECUTORS[input.spec.kind]({ deps, userId, account, target: input.target, params: input.spec.params ?? {} });
  } catch (error) {
    const code = error instanceof GoogleApiError ? `google_${error.code}` : error instanceof ApiError ? error.code : (error as { code?: string })?.code ?? 'failed';
    if (dispatchKey) {
      // Explicit request rejection is safe to retry; transport failures, 5xx,
      // and persistence errors may follow an accepted side effect.
      const rejected = (error instanceof GoogleApiError && error.status >= 400 && error.status < 500)
        || (error instanceof ApiError && ['invalid_request', 'not_found', 'conflict', 'forbidden', 'not_configured'].includes(error.code));
      await deps.db.asUser(userId, (tx) => rejected
        ? tx.query(`delete from public.idempotency_keys where scope = 'external_action' and key = $1`, [dispatchKey])
        : tx.query(`update public.idempotency_keys set result = $2::jsonb where scope = 'external_action' and key = $1`, [dispatchKey, { status: 'unconfirmed', code: String(code).slice(0, 64) }]));
      if (!rejected) return { decision: 'allowed', reason: unconfirmedReason, tier, auditId: null, result: null, errorCode: 'action_unconfirmed' };
    }
    return { decision: 'allowed', reason: policy.reason, tier, auditId: null, result: null, errorCode: String(code).slice(0, 64) };
  }
  const audit = await deps.db.asUser(userId, (tx) =>
    recordAudit(tx, {
      userId,
      actor: { type: input.actor.type, id: input.actor.id, name: input.actor.name },
      action: input.spec.kind,
      tier,
      target: { kind: input.target.gmailThreadId ? 'thread' : 'account', id: input.target.gmailThreadId ?? input.target.accountId, title: input.target.title },
      summary: result.summary,
      policy,
      reversible: result.reversible,
      undo: result.undo,
      accountId: input.target.accountId,
      threadId: input.target.gmailThreadId,
      idempotencyKey: input.idempotencyKey ? `action:${input.idempotencyKey}` : null,
    }),
  );
  return { decision: 'allowed', reason: policy.reason, tier, auditId: audit.id, result, errorCode: null };
}

/** Reverse an audited action from its undo recipe. */
export async function undoAction(deps: IntelDeps, userId: string, auditId: string, idempotencyKey: string): Promise<string> {
  const row = await deps.db.asUser(userId, (tx) =>
    one<{ id: string; action: string; tier: number; reversible: boolean; undone_at: unknown; undo: Record<string, unknown> | null; mail_account_id: string | null; gmail_thread_id: string | null; target_title: string | null }>(
      tx,
      `select id, action, tier, reversible, undone_at, undo, mail_account_id, gmail_thread_id, target_title from public.audit_events where id = $1::uuid`,
      [auditId],
    ),
  );
  if (!row) throw new ApiError('not_found', 'That action does not exist.');
  const already = await deps.db.asUser(userId, (tx) => one<{ id: string }>(tx, `select id from public.audit_events where idempotency_key = $1`, [`undo:${idempotencyKey}`]));
  if (already) return already.id;
  if (!row.reversible || row.undone_at || !row.undo) throw new ApiError('conflict', 'This action cannot be undone.');
  const account = row.mail_account_id ? await deps.db.asUser(userId, (tx) => loadAccount(tx, row.mail_account_id!)) : null;
  const undo = row.undo;
  switch (undo.op) {
    case 'modify_labels':
      if (!account) throw new ApiError('conflict', 'The Google account is no longer connected.');
      await gmailFor(deps, account).modifyThread(String(undo.gmailThreadId), { addLabelIds: undo.addLabelIds as string[], removeLabelIds: undo.removeLabelIds as string[] });
      if (undo.reminderId) await deps.db.asUser(userId, (tx) => tx.query(`update public.reminders set status = 'cancelled' where id = $1::uuid`, [undo.reminderId]));
      break;
    case 'delete_gmail_draft':
      if (!account) throw new ApiError('conflict', 'The Google account is no longer connected.');
      await gmailFor(deps, account).deleteDraft(String(undo.gmailDraftId)).catch((error) => {
        if (!(error instanceof GoogleApiError && error.code === 'not_found')) throw error;
      });
      await deps.db.asUser(userId, (tx) => tx.query(`update public.drafts set status = 'ready', gmail_draft_id = null, placed_hash = null, placed_variant_id = null, updated_at = now() where id = $1::uuid`, [undo.draftId]));
      break;
    case 'delete_calendar_event':
      if (!account) throw new ApiError('conflict', 'The Google account is no longer connected.');
      await calendarFor(deps, account).deleteEvent(String(undo.calendarEventId));
      await deps.db.asUser(userId, (tx) => tx.query(`update public.prepared_events set status = 'cancelled', updated_at = now() where id = $1::uuid`, [undo.preparedEventId]));
      break;
    case 'set_state':
      await deps.db.asUser(userId, (tx) => tx.query(`update public.thread_states set state = $2, updated_at = now() where thread_id = $1::uuid`, [undo.threadRowId, undo.state]));
      break;
    case 'cancel_reminder':
      await deps.db.asUser(userId, (tx) => tx.query(`update public.reminders set status = 'cancelled' where id = $1::uuid and status = 'pending'`, [undo.reminderId]));
      break;
    case 'cancel_task':
      await deps.db.asUser(userId, (tx) => tx.query(`update public.tasks set status = 'cancelled' where id = $1::uuid`, [undo.taskId]));
      break;
    default:
      throw new ApiError('conflict', 'This action cannot be undone.');
  }
  return deps.db.asUser(userId, async (tx) => {
    await tx.query(`update public.audit_events set undone_at = now() where id = $1::uuid`, [row.id]);
    const audit = await recordAudit(tx, {
      userId,
      actor: { type: 'user', id: userId, name: 'You' },
      action: 'undo',
      tier: Math.min(1, row.tier) as RiskTier,
      target: { kind: 'audit', id: row.id, title: row.target_title },
      summary: `Undid: ${ACTION_LABELS[row.action as ActionKind] ?? row.action}`,
      policy: { decision: 'allowed', reason: 'You asked for this' },
      accountId: row.mail_account_id,
      threadId: row.gmail_thread_id,
      idempotencyKey: `undo:${idempotencyKey}`,
      undoOf: row.id,
    });
    // Rules count undos, which feeds their activation statistics.
    await tx.query(
      `update public.smart_views set undone = undone + 1 where id::text = (select actor_id from public.audit_events where id = $1::uuid and actor_type = 'rule')`,
      [row.id],
    );
    return audit.id;
  });
}
