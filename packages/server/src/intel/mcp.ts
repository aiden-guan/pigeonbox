import { EmailAddressSchema } from '@pigeonbox/api-contract';
import { ThreadStateSchema } from '@pigeonbox/shared';
import { z } from 'zod';
import { iso, one } from '../db/sql.js';
import { ApiError } from '../http.js';
import { toApiError } from '../routes/errors.js';
import { performAction } from './actions.js';
import { withIdempotency, type Scope } from './api-tokens.js';
import { createApproval, getApproval } from './approvals.js';
import { recordAudit } from './audit.js';
import { createPreparedEvent, prepareEvent } from './calendar.js';
import type { IntelDeps } from './context.js';
import { placeDraft, prepareDraft } from './drafts.js';
import { listFollowUps } from './followups.js';
import { normalizeGmailId, resolveAccount, threadRowId } from './ids.js';
import { loadPreferences } from './preferences.js';
import { listContacts, relationshipBrief } from './relationships.js';
import { parseQuery } from './research.js';
import { availability, defaultWindow } from './scheduling.js';
import { deriveSignals, threadSignals } from './signals.js';
import { approvalTrackingId, requireSendTracking, TRACKING_LIMITS } from './mcp-tracking.js';
import { loadThreadIntel } from './threads.js';

/**
 * PigeonBox MCP server (Model Context Protocol, Streamable HTTP, stateless
 * JSON responses). Tools are grouped by scope; a tool can only be called with
 * a token that has its scope, and every write goes through `performAction`
 * with an MCP actor, an idempotency key, a policy decision and an audit row.
 * There is no send tool: `request_send` creates an approval card.
 */

export const MCP_PROTOCOL_VERSION = '2025-06-18';

type ToolContext = { deps: IntelDeps; userId: string; scopes: Scope[]; clientId: string; requestId: string };
type Tool = {
  name: string;
  scope: Scope;
  description: string;
  input: z.ZodTypeAny;
  schema: Record<string, unknown>;
  annotations: { readOnlyHint: boolean; destructiveHint: boolean; idempotentHint: boolean };
  run: (ctx: ToolContext, args: any) => Promise<unknown>;
};

const key = z.string().regex(/^[A-Za-z0-9._:-]{8,128}$/);
const threadId = z.string().min(1).max(64);
const str = (description: string, extra: Record<string, unknown> = {}) => ({ type: 'string', description, ...extra });
const obj = (properties: Record<string, unknown>, required: string[]) => ({ type: 'object', properties, required, additionalProperties: false });
const IDEMPOTENCY = str('A unique key for this write; retries with the same key do nothing new.', { pattern: '^[A-Za-z0-9._:-]{8,128}$' });

async function findThread(ctx: ToolContext, gmailThreadId: string, mailbox?: string) {
  return ctx.deps.db.asUser(ctx.userId, async (tx) => {
    const account = await resolveAccount(tx, { mailbox });
    if (!account) throw new ApiError('not_found', 'No connected mailbox.');
    const id = await threadRowId(tx, account.id, gmailThreadId);
    if (!id) throw new ApiError('not_found', 'That thread is not synced.');
    const row = await one<{ subject: string }>(tx, `select subject from public.threads where id = $1::uuid`, [id]);
    return { account, threadRowId: id, gmailThreadId: normalizeGmailId(gmailThreadId), subject: row?.subject ?? '' };
  });
}

async function mcpAction(ctx: ToolContext, spec: { kind: Parameters<typeof performAction>[2]['spec']['kind']; params: Record<string, string | number | boolean> }, target: { accountId: string; threadRowId: string | null; gmailThreadId: string | null; title: string | null }, idempotencyKey: string) {
  const outcome = await performAction(ctx.deps, ctx.userId, {
    spec,
    target,
    actor: { type: 'mcp', id: ctx.clientId, name: 'MCP client', scopes: ctx.scopes },
    userInitiated: false,
    idempotencyKey: `mcp:${ctx.clientId}:${idempotencyKey}`,
  });
  if (outcome.decision === 'approval_required') {
    const approval = await ctx.deps.db.asUser(ctx.userId, (tx) =>
      createApproval(tx, ctx.deps.box, {
        userId: ctx.userId,
        kind: spec.kind,
        tier: outcome.tier,
        title: `API request: ${spec.kind.replace(/_/g, ' ')}`,
        why: 'An MCP client asked for this. It runs only if you approve.',
        sources: target.gmailThreadId ? [{ id: `thread:${target.gmailThreadId}`, kind: 'thread', title: target.title || '(no subject)', gmailThreadId: target.gmailThreadId, accountId: target.accountId }] : [],
        action: spec,
        target,
        preview: { change: `${spec.kind.replace(/_/g, ' ')}${target.title ? ` on "${target.title}"` : ''}` },
        responsible: { type: 'mcp', id: ctx.clientId, name: 'MCP client' },
        idempotencyKey: `mcp:${ctx.clientId}:${idempotencyKey}`,
      }),
    );
    return { decision: outcome.decision, reason: outcome.reason, approvalId: approval.id };
  }
  return { decision: outcome.decision, reason: outcome.reason, auditId: outcome.auditId, error: outcome.errorCode, summary: outcome.result?.summary ?? null };
}

export const TOOLS: Tool[] = [
  // --- read ---------------------------------------------------------------
  {
    name: 'search_mail',
    scope: 'read',
    description: 'Find synced email threads by words, people or time ("invoices from Acme this month"). Returns thread IDs, subjects, states and summaries.',
    input: z.object({ query: z.string().min(1).max(500), limit: z.number().int().min(1).max(25).default(10) }),
    schema: obj({ query: str('What to look for'), limit: { type: 'integer', minimum: 1, maximum: 25 } }, ['query']),
    annotations: { readOnlyHint: true, destructiveHint: false, idempotentHint: true },
    run: async (ctx, args) =>
      ctx.deps.db.asUser(ctx.userId, async (tx) => {
        const prefs = await loadPreferences(tx, ctx.userId);
        const parsed = await parseQuery(tx, args.query, ctx.deps.now(), prefs.timeZone);
        const terms = parsed.terms.map((term) => term.replace(/[^a-z0-9]/g, '')).filter(Boolean);
        const params: unknown[] = [args.limit, parsed.window.from ?? new Date(0), parsed.window.to ?? new Date(ctx.deps.now().getTime() + 86_400_000)];
        let where = 't.last_message_at between $2::timestamptz and $3::timestamptz';
        if (terms.length) {
          params.push(terms.join(' | '));
          where += ` and t.search_tsv @@ to_tsquery('simple', $${params.length})`;
        }
        if (parsed.people.length) {
          params.push(parsed.people.map((person) => person.email));
          where += ` and exists (select 1 from jsonb_array_elements(t.participants) p where p ->> 'email' = any ($${params.length}::text[]))`;
        }
        const rows = await tx.query<{ id: string }>(`select t.id from public.threads t where ${where} order by t.last_message_at desc limit $1`, params);
        const intel = await loadThreadIntel(tx, ctx.deps.box, ctx.userId, rows.map((row) => row.id), false);
        return { threads: [...intel.values()].map((thread) => ({ threadId: thread.threadId, subject: thread.subject, state: thread.state.state, lastMessageAt: thread.lastMessageAt, participants: thread.participants.map((p) => p.email), summary: thread.summary?.oneLine ?? null })) };
      }),
  },
  {
    name: 'get_thread',
    scope: 'read',
    description: 'Thread intelligence: state, summary, commitments, follow-up and the prepared draft. Message bodies are not returned.',
    input: z.object({ thread_id: threadId, mailbox: EmailAddressSchema.optional() }),
    schema: obj({ thread_id: str('Gmail thread ID'), mailbox: str('Gmail address, when several are connected') }, ['thread_id']),
    annotations: { readOnlyHint: true, destructiveHint: false, idempotentHint: true },
    run: async (ctx, args) => {
      const found = await findThread(ctx, args.thread_id, args.mailbox);
      return ctx.deps.db.asUser(ctx.userId, async (tx) => ({ thread: (await loadThreadIntel(tx, ctx.deps.box, ctx.userId, [found.threadRowId], true)).get(found.threadRowId) ?? null }));
    },
  },
  {
    name: 'get_contact',
    scope: 'read',
    description: 'Look up people you email by name or address, with counts, last contact and open promises.',
    input: z.object({ query: z.string().min(1).max(200) }),
    schema: obj({ query: str('Name or email') }, ['query']),
    annotations: { readOnlyHint: true, destructiveHint: false, idempotentHint: true },
    run: (ctx, args) => ctx.deps.db.asUser(ctx.userId, (tx) => listContacts(tx, { query: args.query, limit: 10 })),
  },
  {
    name: 'get_relationship_brief',
    scope: 'read',
    description: 'A relationship brief for one person: what you last discussed, what you owe each other, the next meeting and a timeline.',
    input: z.object({ email: EmailAddressSchema }),
    schema: obj({ email: str('Their email address') }, ['email']),
    annotations: { readOnlyHint: true, destructiveHint: false, idempotentHint: true },
    run: (ctx, args) => ctx.deps.db.asUser(ctx.userId, async (tx) => ({ brief: await relationshipBrief(tx, ctx.deps.box, ctx.userId, { email: args.email }, ctx.deps.now()) })),
  },
  {
    name: 'get_waiting_threads',
    scope: 'read',
    description: 'Conversations where you are waiting for someone else to reply, with how long and when a follow-up is due.',
    input: z.object({ limit: z.number().int().min(1).max(50).default(20) }),
    schema: obj({ limit: { type: 'integer', minimum: 1, maximum: 50 } }, []),
    annotations: { readOnlyHint: true, destructiveHint: false, idempotentHint: true },
    run: (ctx, args) => ctx.deps.db.asUser(ctx.userId, async (tx) => ({ waiting: await listFollowUps(tx, { stages: ['waiting', 'engaged', 'follow_up_due'], limit: args.limit }) })),
  },
  {
    name: 'get_followups',
    scope: 'read',
    description: 'Follow-ups in any stage (sent, waiting, engaged, reply, follow_up_due, closed).',
    input: z.object({ stages: z.array(z.enum(['sent', 'waiting', 'engaged', 'reply', 'follow_up_due', 'closed'])).max(6).optional(), limit: z.number().int().min(1).max(100).default(30) }),
    schema: obj({ stages: { type: 'array', items: { type: 'string', enum: ['sent', 'waiting', 'engaged', 'reply', 'follow_up_due', 'closed'] } }, limit: { type: 'integer' } }, []),
    annotations: { readOnlyHint: true, destructiveHint: false, idempotentHint: true },
    run: (ctx, args) => ctx.deps.db.asUser(ctx.userId, async (tx) => ({ followUps: await listFollowUps(tx, { stages: args.stages, limit: args.limit }) })),
  },
  {
    name: 'get_tracking_activity',
    scope: 'read',
    description: 'Engagement signals for a tracked thread, each with a confidence and an explanation. Opens are signals, not proof of reading.',
    input: z.object({ thread_id: threadId }),
    schema: obj({ thread_id: str('Gmail thread ID') }, ['thread_id']),
    annotations: { readOnlyHint: true, destructiveHint: false, idempotentHint: true },
    run: (ctx, args) => ctx.deps.db.asUser(ctx.userId, (tx) => threadSignals(tx, normalizeGmailId(args.thread_id), ctx.deps.now())),
  },
  {
    name: 'get_send_status',
    scope: 'read',
    description: 'Check an email requested through PigeonBox: pending approval, sent, rejected, failed or unconfirmed. Includes its tracking ID and Gmail IDs after sending. Never retry an unconfirmed send automatically.',
    input: z.object({ approval_id: z.string().uuid() }).strict(),
    schema: obj({ approval_id: str('Approval ID from request_send') }, ['approval_id']),
    annotations: { readOnlyHint: true, destructiveHint: false, idempotentHint: true },
    run: async (ctx, args) => {
      const approval = await ctx.deps.db.asUser(ctx.userId, (tx) => getApproval(tx, ctx.deps.box, ctx.userId, args.approval_id));
      if (!approval || approval.kind !== 'send_email' || approval.responsible.type !== 'mcp') throw new ApiError('not_found', 'That send request does not exist.');
      const tracked = await ctx.deps.store.trackerStoreFor(ctx.userId).getEmail(await approvalTrackingId(ctx.userId, approval.id));
      const receipt = await ctx.deps.db.asUser(ctx.userId, (tx) => one<{ undo: { gmailMessageId?: string; gmailThreadId?: string | null } }>(tx, `select undo from public.audit_events where idempotency_key = $1`, [`action:approval:${approval.id}`]));
      return { approvalId: approval.id, status: approval.status, deliveryStatus: approval.result?.code === 'action_unconfirmed' ? 'unconfirmed' : approval.status === 'executed' ? 'sent' : approval.status, result: approval.result, trackingId: tracked?.tracking_id ?? null,
        gmailMessageId: tracked?.gmail_message_id ?? receipt?.undo?.gmailMessageId ?? null, gmailThreadId: tracked?.gmail_thread_id ?? receipt?.undo?.gmailThreadId ?? null,
        trackingStatus: tracked?.status ?? null, limitations: TRACKING_LIMITS };
    },
  },
  {
    name: 'get_tracked_email',
    scope: 'read',
    description: 'Read message-level open/click counts and classified activity by tracking ID. Includes privacy-proxy, scanner and self-view explanations. Does not fetch the pixel or visit tracked links. Signals never prove reading or identify which recipient opened a group email.',
    input: z.object({ tracking_id: z.string().regex(/^trk_[0-9a-f]{32}$/) }).strict(),
    schema: obj({ tracking_id: str('Tracking ID from get_send_status', { pattern: '^trk_[0-9a-f]{32}$' }) }, ['tracking_id']),
    annotations: { readOnlyHint: true, destructiveHint: false, idempotentHint: true },
    run: async (ctx, args) => {
      const store = ctx.deps.store.trackerStoreFor(ctx.userId);
      const email = await store.getEmail(args.tracking_id);
      if (!email) throw new ApiError('not_found', 'That tracked email does not exist.');
      const events = await store.listEvents(email.tracking_id);
      const derived = deriveSignals({ events: events.map(event => ({ ...event, classification: event.classification ?? null, destination: event.destination ?? null })), recipients: email.recipients, sentAt: email.sent_at, now: ctx.deps.now(), followUpPending: false });
      return { trackingId: email.tracking_id, status: email.status, subject: email.subject, recipients: email.recipients,
        gmailMessageId: email.gmail_message_id, gmailThreadId: email.gmail_thread_id, sentAt: email.sent_at,
        opens: email.open_count, clicks: email.click_count, firstOpenedAt: email.first_opened_at, lastOpenedAt: email.last_opened_at,
        events: derived.events.map(({ destination: _destination, ...event }) => event), attributionNote: derived.attributionNote,
        eventsLimit: 200, limitations: TRACKING_LIMITS };
    },
  },
  {
    name: 'search_calendar',
    scope: 'read',
    description: 'Upcoming calendar events PigeonBox has cached (next 36 hours are refreshed every 15 minutes).',
    input: z.object({ from: z.string().max(40).optional(), to: z.string().max(40).optional(), query: z.string().max(200).optional() }),
    schema: obj({ from: str('ISO start'), to: str('ISO end'), query: str('Words in the title') }, []),
    annotations: { readOnlyHint: true, destructiveHint: false, idempotentHint: true },
    run: (ctx, args) =>
      ctx.deps.db.asUser(ctx.userId, async (tx) => {
        const rows = await tx.query<{ event_id: string; title: string; start_at: unknown; end_at: unknown; attendees: string[] }>(
          `select event_id, title, start_at, end_at, attendees from public.calendar_event_cache where start_at between $1::timestamptz and $2::timestamptz and ($3::text is null or title ilike '%' || $3 || '%') order by start_at limit 50`,
          [args.from ? new Date(args.from) : ctx.deps.now(), args.to ? new Date(args.to) : new Date(ctx.deps.now().getTime() + 7 * 86_400_000), args.query ?? null],
        );
        return { events: rows.map((row) => ({ eventId: row.event_id, title: row.title, start: iso(row.start_at), end: iso(row.end_at), attendees: row.attendees })) };
      }),
  },
  {
    name: 'get_availability',
    scope: 'read',
    description: 'Open times from your real Google Calendar free/busy, respecting working hours, buffers and focus blocks.',
    input: z.object({ duration_minutes: z.number().int().min(5).max(480), from: z.string().max(40).optional(), to: z.string().max(40).optional(), count: z.number().int().min(1).max(8).default(4) }),
    schema: obj({ duration_minutes: { type: 'integer', minimum: 5, maximum: 480 }, from: str('ISO start'), to: str('ISO end'), count: { type: 'integer' } }, ['duration_minutes']),
    annotations: { readOnlyHint: true, destructiveHint: false, idempotentHint: true },
    run: async (ctx, args) => {
      const { account, prefs } = await ctx.deps.db.asUser(ctx.userId, async (tx) => ({
        account: await one<{ id: string; user_id: string; email: string; google_sub: string; status: string; features: string[]; display_name: string | null }>(tx, `select id, user_id, email, google_sub, status, features, display_name from public.mail_accounts where status = 'active' and 'calendar_read' = any (features) limit 1`),
        prefs: await loadPreferences(tx, ctx.userId),
      }));
      if (!account) throw new ApiError('conflict', 'Google Calendar is not connected.');
      const window = args.from && args.to ? { start: new Date(args.from), end: new Date(args.to) } : defaultWindow(ctx.deps.now(), prefs);
      return availability(ctx.deps, account, prefs, { durationMinutes: args.duration_minutes, window, count: args.count });
    },
  },

  // --- prepare -------------------------------------------------------------
  {
    name: 'draft_reply',
    scope: 'prepare',
    description: 'Prepare a grounded reply draft inside PigeonBox (not in Gmail, not sent). Unknown facts become placeholders.',
    input: z.object({ thread_id: threadId, instructions: z.string().max(1000).optional(), idempotency_key: key }),
    schema: obj({ thread_id: str('Gmail thread ID'), instructions: str('Optional guidance'), idempotency_key: IDEMPOTENCY }, ['thread_id', 'idempotency_key']),
    annotations: { readOnlyHint: false, destructiveHint: false, idempotentHint: true },
    run: async (ctx, args) =>
      withIdempotency(ctx.deps, ctx.userId, `mcp:${ctx.clientId}`, args.idempotency_key, async () => {
        const found = await findThread(ctx, args.thread_id);
        const draft = await prepareDraft(ctx.deps, ctx.userId, { threadRowId: found.threadRowId, kind: 'reply', origin: 'user', instructions: args.instructions ?? null, force: Boolean(args.instructions), requestId: ctx.requestId, interactive: true });
        await ctx.deps.db.asUser(ctx.userId, (tx) =>
          recordAudit(tx, { userId: ctx.userId, actor: { type: 'mcp', id: ctx.clientId, name: 'MCP client' }, action: 'draft_reply', tier: 0, target: { kind: 'thread', id: found.gmailThreadId, title: found.subject }, summary: 'Prepared a reply draft in PigeonBox', policy: { decision: 'allowed', reason: 'Internal to PigeonBox' }, threadId: found.gmailThreadId, accountId: found.account.id, idempotencyKey: `mcp:${ctx.clientId}:${args.idempotency_key}` }),
        );
        return { draftId: draft.id, status: draft.status, variants: draft.variants.map((variant) => ({ id: variant.id, label: variant.label, body: variant.body, placeholders: variant.placeholders.map((p) => p.token) })), sources: draft.sources };
      }),
  },
  {
    name: 'draft_followup',
    scope: 'prepare',
    description: 'Prepare a follow-up draft for a conversation that is waiting on someone. Not sent.',
    input: z.object({ thread_id: threadId, idempotency_key: key }),
    schema: obj({ thread_id: str('Gmail thread ID'), idempotency_key: IDEMPOTENCY }, ['thread_id', 'idempotency_key']),
    annotations: { readOnlyHint: false, destructiveHint: false, idempotentHint: true },
    run: async (ctx, args) =>
      withIdempotency(ctx.deps, ctx.userId, `mcp:${ctx.clientId}`, args.idempotency_key, async () => {
        const found = await findThread(ctx, args.thread_id);
        const draft = await prepareDraft(ctx.deps, ctx.userId, { threadRowId: found.threadRowId, kind: 'follow_up', origin: 'user', requestId: ctx.requestId, interactive: true });
        await ctx.deps.db.asUser(ctx.userId, (tx) =>
          recordAudit(tx, { userId: ctx.userId, actor: { type: 'mcp', id: ctx.clientId, name: 'MCP client' }, action: 'draft_follow_up', tier: 0, target: { kind: 'thread', id: found.gmailThreadId, title: found.subject }, summary: 'Prepared a follow-up draft in PigeonBox', policy: { decision: 'allowed', reason: 'Internal to PigeonBox' }, threadId: found.gmailThreadId, accountId: found.account.id, idempotencyKey: `mcp:${ctx.clientId}:${args.idempotency_key}` }),
        );
        return { draftId: draft.id, status: draft.status, body: draft.variants[0]?.body ?? null };
      }),
  },
  {
    name: 'prepare_event',
    scope: 'prepare',
    description: 'Prepare a calendar event inside PigeonBox. Nothing is added to the calendar until create_event (and invitations always need approval).',
    input: z.object({ title: z.string().min(1).max(300), start: z.string().max(40), end: z.string().max(40), attendees: z.array(EmailAddressSchema).max(50).default(() => []), thread_id: threadId.optional(), notify_attendees: z.boolean().default(false), idempotency_key: key }),
    schema: obj({ title: str('Event title'), start: str('ISO start'), end: str('ISO end'), attendees: { type: 'array', items: { type: 'string' } }, thread_id: str('Related Gmail thread'), notify_attendees: { type: 'boolean' }, idempotency_key: IDEMPOTENCY }, ['title', 'start', 'end', 'idempotency_key']),
    annotations: { readOnlyHint: false, destructiveHint: false, idempotentHint: true },
    run: async (ctx, args) =>
      withIdempotency(ctx.deps, ctx.userId, `mcp:${ctx.clientId}`, args.idempotency_key, async () => {
        const account = await ctx.deps.db.asUser(ctx.userId, (tx) => resolveAccount(tx, {}));
        if (!account) throw new ApiError('conflict', 'No connected account.');
        const found = args.thread_id ? await findThread(ctx, args.thread_id) : null;
        const event = await prepareEvent(ctx.deps, ctx.userId, { accountId: account.id, threadRowId: found?.threadRowId ?? null, gmailThreadId: found?.gmailThreadId ?? null, title: args.title, start: args.start, end: args.end, attendees: args.attendees, notifyAttendees: args.notify_attendees });
        return { event };
      }),
  },
  {
    name: 'create_reminder',
    scope: 'prepare',
    description: 'Remind the user about a thread at a time or after a number of business days.',
    input: z.object({ thread_id: threadId, at: z.string().max(40).optional(), business_days: z.number().int().min(0).max(60).optional(), reason: z.string().max(300).optional(), idempotency_key: key }),
    schema: obj({ thread_id: str('Gmail thread ID'), at: str('ISO time'), business_days: { type: 'integer' }, reason: str('Why'), idempotency_key: IDEMPOTENCY }, ['thread_id', 'idempotency_key']),
    annotations: { readOnlyHint: false, destructiveHint: false, idempotentHint: true },
    run: async (ctx, args) => {
      const found = await findThread(ctx, args.thread_id);
      const params: Record<string, string | number | boolean> = { reason: args.reason ?? 'Reminder from an MCP client' };
      if (args.at) params.at = args.at;
      if (args.business_days !== undefined) params.businessDays = args.business_days;
      return mcpAction(ctx, { kind: 'remind', params }, { accountId: found.account.id, threadRowId: found.threadRowId, gmailThreadId: found.gmailThreadId, title: found.subject }, args.idempotency_key);
    },
  },

  // --- write ---------------------------------------------------------------
  {
    name: 'update_thread_state',
    scope: 'write',
    description: 'Set a thread’s PigeonBox state (for example DONE or WAITING_ON_THEM). Audited and undoable.',
    input: z.object({ thread_id: threadId, state: ThreadStateSchema, idempotency_key: key }),
    schema: obj({ thread_id: str('Gmail thread ID'), state: { type: 'string', enum: [...ThreadStateSchema.options] }, idempotency_key: IDEMPOTENCY }, ['thread_id', 'state', 'idempotency_key']),
    annotations: { readOnlyHint: false, destructiveHint: false, idempotentHint: true },
    run: async (ctx, args) => {
      const found = await findThread(ctx, args.thread_id);
      return mcpAction(ctx, { kind: 'set_state', params: { state: args.state } }, { accountId: found.account.id, threadRowId: found.threadRowId, gmailThreadId: found.gmailThreadId, title: found.subject }, args.idempotency_key);
    },
  },
  {
    name: 'apply_label',
    scope: 'write',
    description: 'Apply a Gmail label to a thread. Needs the Organize permission. Audited and undoable.',
    input: z.object({ thread_id: threadId, label: z.string().min(1).max(100), idempotency_key: key }),
    schema: obj({ thread_id: str('Gmail thread ID'), label: str('Label name'), idempotency_key: IDEMPOTENCY }, ['thread_id', 'label', 'idempotency_key']),
    annotations: { readOnlyHint: false, destructiveHint: false, idempotentHint: true },
    run: async (ctx, args) => {
      const found = await findThread(ctx, args.thread_id);
      return mcpAction(ctx, { kind: 'label', params: { label: args.label } }, { accountId: found.account.id, threadRowId: found.threadRowId, gmailThreadId: found.gmailThreadId, title: found.subject }, args.idempotency_key);
    },
  },
  {
    name: 'archive_thread',
    scope: 'write',
    description: 'Archive a thread (remove it from the inbox). Audited and undoable.',
    input: z.object({ thread_id: threadId, idempotency_key: key }),
    schema: obj({ thread_id: str('Gmail thread ID'), idempotency_key: IDEMPOTENCY }, ['thread_id', 'idempotency_key']),
    annotations: { readOnlyHint: false, destructiveHint: false, idempotentHint: true },
    run: async (ctx, args) => {
      const found = await findThread(ctx, args.thread_id);
      return mcpAction(ctx, { kind: 'archive', params: {} }, { accountId: found.account.id, threadRowId: found.threadRowId, gmailThreadId: found.gmailThreadId, title: found.subject }, args.idempotency_key);
    },
  },
  {
    name: 'create_draft',
    scope: 'write',
    description: 'Place a prepared PigeonBox draft into Gmail as a draft reply. It is not sent.',
    input: z.object({ draft_id: z.string().uuid(), variant_id: z.string().uuid(), idempotency_key: key }),
    schema: obj({ draft_id: str('Draft ID from draft_reply'), variant_id: str('Variant ID'), idempotency_key: IDEMPOTENCY }, ['draft_id', 'variant_id', 'idempotency_key']),
    annotations: { readOnlyHint: false, destructiveHint: false, idempotentHint: true },
    run: async (ctx, args) => ({ draft: await placeDraft(ctx.deps, ctx.userId, { draftId: args.draft_id, variantId: args.variant_id, idempotencyKey: `mcp:${ctx.clientId}:${args.idempotency_key}` }, { type: 'mcp', name: 'MCP client' }) }),
  },
  {
    name: 'create_event',
    scope: 'write',
    description: 'Add a prepared event to Google Calendar. If it would email invitations, an approval card is created instead.',
    input: z.object({ prepared_event_id: z.string().uuid(), idempotency_key: key }),
    schema: obj({ prepared_event_id: str('From prepare_event'), idempotency_key: IDEMPOTENCY }, ['prepared_event_id', 'idempotency_key']),
    annotations: { readOnlyHint: false, destructiveHint: false, idempotentHint: true },
    run: async (ctx, args) => ({ event: await createPreparedEvent(ctx.deps, ctx.userId, { preparedEventId: args.prepared_event_id, idempotencyKey: `mcp:${ctx.clientId}:${args.idempotency_key}`, actor: 'mcp' }) }),
  },
  {
    name: 'request_send',
    scope: 'write',
    description: 'Request a tracked email through PigeonBox. Supply plain text; PigeonBox adds the open pixel and click links server-side after the person approves, then sends the complete MIME through Gmail. Never copy a pixel into another email tool or use another sender for this request. Opens and links default on; set both false for untracked mail. Nothing sends until approval. One request per recipient gives separate engagement signals.',
    input: z.object({ to: z.array(EmailAddressSchema).min(1).max(20), subject: z.string().min(1).max(500), body: z.string().min(1).max(20000), mailbox: EmailAddressSchema.optional(), thread_id: threadId.optional(), track_opens: z.boolean().default(true), track_links: z.boolean().default(true), idempotency_key: key }).strict(),
    schema: obj({ to: { type: 'array', items: { type: 'string' } }, subject: str('Subject'), body: str('Plain-text body. Include full https:// URLs for click tracking; do not supply HTML.'), mailbox: str('Connected sender email; required when more than one mailbox is connected'), thread_id: str('Reply in this thread'), track_opens: { type: 'boolean', default: true }, track_links: { type: 'boolean', default: true }, idempotency_key: IDEMPOTENCY }, ['to', 'subject', 'body', 'idempotency_key']),
    annotations: { readOnlyHint: false, destructiveHint: false, idempotentHint: true },
    run: async (ctx, args) => {
      const previous = await ctx.deps.db.asUser(ctx.userId, (tx) => one<{ id: string; kind: string }>(tx, `select id, kind from public.approvals where idempotency_key = $1`, [`mcp:${ctx.clientId}:${args.idempotency_key}`]));
      if (previous) {
        if (previous.kind !== 'send_email') throw new ApiError('conflict', 'That idempotency key belongs to another action.');
        return { decision: 'existing_request', approvalId: previous.id, reason: 'Existing request. Use get_send_status; do not send it through another tool.' };
      }
      if (!args.mailbox) {
        const accounts = await ctx.deps.db.asUser(ctx.userId, (tx) => tx.query(`select id from public.mail_accounts where status = 'active' limit 2`));
        if (accounts.length > 1) throw new ApiError('invalid_request', 'Choose the connected sender with mailbox.');
      }
      const found = args.thread_id ? await findThread(ctx, args.thread_id, args.mailbox) : null;
      const account = found?.account ?? (await ctx.deps.db.asUser(ctx.userId, (tx) => resolveAccount(tx, { mailbox: args.mailbox })));
      if (!account) throw new ApiError('conflict', 'No connected account.');
      if (account.status !== 'active' || !account.features.includes('send')) throw new ApiError('conflict', 'Enable Send for this Google connection before requesting an email.');
      await requireSendTracking(ctx.deps, ctx.userId, { opens: args.track_opens, links: args.track_links });
      const parent = found ? await ctx.deps.db.asUser(ctx.userId, (tx) => one<{ rfc822_message_id: string }>(tx, `select rfc822_message_id from public.message_metadata where thread_id = $1::uuid and rfc822_message_id is not null order by internal_date desc limit 1`, [found.threadRowId])) : null;
      const target = { accountId: account.id, threadRowId: found?.threadRowId ?? null, gmailThreadId: found?.gmailThreadId ?? null, title: args.subject };
      const approval = await ctx.deps.db.asUser(ctx.userId, (tx) =>
        createApproval(tx, ctx.deps.box, {
          userId: ctx.userId,
          kind: 'send_email',
          tier: 3,
          title: `Send "${args.subject.slice(0, 120)}"`,
          why: 'An MCP client asked to send this email through PigeonBox. It is sent only if you approve it, with your edits and the tracking shown below.',
          sources: found ? [{ id: `thread:${found.gmailThreadId}`, kind: 'thread', title: found.subject || '(no subject)', gmailThreadId: found.gmailThreadId, accountId: account.id }] : [],
          action: { kind: 'send_email', params: { trackOpens: args.track_opens, trackLinks: args.track_links, ...(parent ? { inReplyTo: parent.rfc822_message_id } : {}) } },
          target,
          preview: { to: args.to, subject: args.subject, body: args.body, change: `From ${account.email}. Open tracking: ${args.track_opens ? 'on' : 'off'}. Link tracking: ${args.track_links ? 'on' : 'off'}. Signals do not prove reading; group activity cannot identify a recipient.` },
          responsible: { type: 'mcp', id: ctx.clientId, name: 'MCP client' },
          idempotencyKey: `mcp:${ctx.clientId}:${args.idempotency_key}`,
        }),
      );
      return { decision: 'approval_required', approvalId: approval.id, tracking: { opens: args.track_opens, links: args.track_links }, reason: 'Approve in PigeonBox, then use get_send_status. PigeonBox sends with tracking; do not send through another email tool.', limitations: TRACKING_LIMITS };
    },
  },
];

const JsonRpcSchema = z.object({ jsonrpc: z.literal('2.0'), id: z.union([z.string().max(200), z.number()]).optional(), method: z.string().max(100), params: z.record(z.string(), z.unknown()).optional() });

function rpcError(id: unknown, code: number, message: string) {
  return { jsonrpc: '2.0', id: id ?? null, error: { code, message } };
}

/** Handle one JSON-RPC message. Returns null for notifications. */
export async function handleMcpMessage(ctx: ToolContext, raw: unknown, version: string): Promise<unknown | null> {
  const parsed = JsonRpcSchema.safeParse(raw);
  if (!parsed.success) return rpcError(null, -32600, 'Invalid request');
  const { id, method, params } = parsed.data;
  if (id === undefined) return null;
  switch (method) {
    case 'initialize':
      return {
        jsonrpc: '2.0',
        id,
        result: {
          protocolVersion: MCP_PROTOCOL_VERSION,
          capabilities: { tools: { listChanged: false } },
          serverInfo: { name: 'pigeonbox-cloud', title: 'PigeonBox', version },
          instructions: 'For tracked email, use request_send with plain text. PigeonBox adds tracking server-side and sends through Gmail after the person approves in PigeonBox. Never send that request through another Gmail/email tool: those sends bypass PigeonBox tracking. Use get_send_status for the receipt, then get_tracked_email for engagement. Never load tracking pixels or visit tracked URLs to check status. An unconfirmed send must be checked in Sent mail before any repeat. Sending always requires approval; opens and clicks are signals, not proof of reading.',
        },
      };
    case 'ping':
      return { jsonrpc: '2.0', id, result: {} };
    case 'tools/list':
      return {
        jsonrpc: '2.0',
        id,
        result: {
          tools: TOOLS.filter((tool) => ctx.scopes.includes(tool.scope)).map((tool) => ({ name: tool.name, description: tool.description, inputSchema: tool.schema, annotations: tool.annotations, ...(ctx.deps.config.auth.mcpOAuthEnabled ? { securitySchemes: [{ type: 'oauth2', scopes: ['openid'] }] } : {}) })),
        },
      };
    case 'tools/call': {
      const name = String(params?.name ?? '');
      const tool = TOOLS.find((candidate) => candidate.name === name);
      if (!tool) return rpcError(id, -32602, `Unknown tool: ${name.slice(0, 60)}`);
      if (!ctx.scopes.includes(tool.scope)) return { jsonrpc: '2.0', id, result: { isError: true, content: [{ type: 'text', text: `This token does not have the "${tool.scope}" scope.` }] } };
      const args = tool.input.safeParse(params?.arguments ?? {});
      if (!args.success) return rpcError(id, -32602, `Invalid arguments: ${args.error.issues.slice(0, 3).map((issue) => issue.path.join('.') || '(root)').join(', ')}`);
      try {
        const result = await tool.run(ctx, args.data);
        return { jsonrpc: '2.0', id, result: { content: [{ type: 'text', text: JSON.stringify(result) }], structuredContent: result, isError: false } };
      } catch (error) {
        const message = toApiError(error)?.message ?? 'The tool failed.';
        return { jsonrpc: '2.0', id, result: { isError: true, content: [{ type: 'text', text: message }] } };
      }
    }
    default:
      return rpcError(id, -32601, 'Method not found');
  }
}
