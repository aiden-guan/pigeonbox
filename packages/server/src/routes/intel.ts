import { chatMemory } from '../intel/memory/chat.js';
import { listMemories, getMemory, listSubjects } from '../intel/memory/manage.js';
import { checkCompose } from '../intel/compose-check.js';
import { forgetMemory, correctMemory, purgeMemories } from '../intel/memory/store.js';
import type { PigeonBoxCapability, RouteName, RouteRequest } from '@pigeonbox/api-contract';
import type { SqlExecutor } from '../db/sql.js';
import { getEntitlements } from '../entitlements.js';
import { ApiError } from '../http.js';
import { cloudOverview } from '../intel/overview.js';
import { listAudit } from '../intel/audit.js';
import { disconnect, listAccounts, requestResync, setPaused, startConnection } from '../intel/connections.js';
import { listDrafts, loadLiveDraft, placeDraft, prepareDraft, recordDraftFeedback } from '../intel/drafts.js';
import { buildFocusQueue, focusCoverage } from '../intel/focus.js';
import { listFollowUps, updateFollowUp } from '../intel/followups.js';
import { normalizeGmailId, resolveAccount, threadRowId } from '../intel/ids.js';
import { ackNotifications, listNotifications } from '../intel/notifications.js';
import { loadPreferences, updatePreferences } from '../intel/preferences.js';
import { correctThreadState, loadThreadIntel } from '../intel/threads.js';
import type { Handler, RequestContext, User } from './types.js';

/**
 * Route handlers for the Cloud intelligence layer. Every database access runs
 * inside `asUser`, so RLS limits it to the signed-in user's rows.
 */

type Body<N extends RouteName> = NonNullable<RouteRequest<N>>;

function asUser<T>(ctx: RequestContext, user: User, fn: (tx: SqlExecutor) => Promise<T>): Promise<T> {
  return ctx.intel().db.asUser(user.userId, fn);
}

async function hasCapability(ctx: RequestContext, user: User, capability: PigeonBoxCapability): Promise<boolean> {
  const entitlements = await getEntitlements(user.userId, ctx.deps.store, ctx.deps.config);
  return entitlements.capabilities.includes(capability);
}

/** Resolve a Gmail thread in the user's connected mailbox. 404 when not synced. */
async function requireThread(ctx: RequestContext, user: User, selector: { mailbox?: string; accountId?: string; threadId: string }) {
  return asUser(ctx, user, async (tx) => {
    const account = await resolveAccount(tx, selector);
    if (!account) throw new ApiError('not_found', 'This mailbox is not connected to your PigeonBox server.');
    const id = await threadRowId(tx, account.id, selector.threadId);
    if (!id) throw new ApiError('not_found', 'Your PigeonBox server has not synced this thread yet.');
    return { account, threadRowId: id };
  });
}

export const INTEL_HANDLERS: Partial<Record<RouteName, Handler>> = {
  cloudOverview: async (ctx, body, user) => {
    const granted = await getEntitlements(user.userId, ctx.deps.store, ctx.deps.config);
    return cloudOverview(ctx.intel(), user.userId, granted.capabilities, (body as Body<'cloudOverview'>).since);
  },
  memoryList: async (ctx,body,user) => listMemories(ctx.intel(),user.userId,body as Body<'memoryList'>,ctx.requestId),
  memoryGet: async (ctx,body,user) => ({ memory: await getMemory(ctx.intel(),user.userId,(body as Body<'memoryGet'>).memoryId) }),
  memoryForget: async (ctx,body,user) => {
    await asUser(ctx,user,(tx) => forgetMemory(ctx.intel(),tx,user.userId,(body as Body<'memoryForget'>).memoryId));
    return { ok: true };
  },
  memoryUpdate: async (ctx,body,user) => ({ memory: await correctMemory(ctx.intel(),user.userId,body as Body<'memoryUpdate'>) }),
  memoryChat: async (ctx,body,user) => chatMemory(ctx.intel(),user.userId,body as Body<'memoryChat'>,ctx.requestId),
  memorySubjects: async (ctx,_body,user) => listSubjects(ctx.intel(),user.userId),
  memoryPurge: async (ctx,_body,user) => ({ removed: await asUser(ctx,user,(tx) => purgeMemories(ctx.intel(),tx,user.userId)) }),
  // Real-time Pidgy checks: one bounded clause, processed in memory and discarded (intel/compose-check.ts).
  composeCheck: async (ctx, body, user) => checkCompose(ctx.intel(), user.userId, body as Body<'composeCheck'>, ctx.requestId, ctx.waitUntil),
  // --- Connections -------------------------------------------------------------
  connections: async (ctx, _body, user) => {
    const accounts = await asUser(ctx, user, (tx) => listAccounts(tx));
    return { accounts, googleConfigured: Boolean(ctx.deps.intel?.google), maxAccounts: ctx.deps.config.intel.maxMailAccounts };
  },
  connectStart: async (ctx, body, user) => {
    const request = body as Body<'connectStart'>;
    const url = await startConnection(ctx.intel(), user.userId, {
      features: request.features,
      accountId: request.accountId,
      loginHint: request.loginHint,
      returnTo: request.returnTo ?? 'web',
    });
    return { url };
  },
  connectionUpdate: async (ctx, body, user) => {
    const request = body as Body<'connectionUpdate'>;
    return { account: await setPaused(ctx.intel(), user.userId, request.accountId, request.paused) };
  },
  connectionDisconnect: async (ctx, body, user) => {
    const request = body as Body<'connectionDisconnect'>;
    await disconnect(ctx.intel(), user.userId, request.accountId, request.deleteData);
    return { ok: true };
  },
  connectionResync: async (ctx, body, user) => {
    const request = body as Body<'connectionResync'>;
    return { account: await requestResync(ctx.intel(), user.userId, request.accountId) };
  },
  preferences: async (ctx, _body, user) => ({ preferences: await asUser(ctx, user, (tx) => loadPreferences(tx, user.userId)) }),
  preferencesUpdate: async (ctx, body, user) => {
    const request = body as Body<'preferencesUpdate'>;
    return { preferences: await asUser(ctx, user, (tx) => updatePreferences(tx, user.userId, request.preferences)) };
  },

  // --- Thread state and Focus Queue --------------------------------------------
  threadsIntel: async (ctx, body, user) => {
    const request = body as Body<'threadsIntel'>;
    const intel = ctx.intel();
    return asUser(ctx, user, async (tx) => {
      const account = await resolveAccount(tx, request);
      if (!account) return { threads: {}, synced: false, accountId: null };
      const requested = request.threadIds.map((id) => ({ raw: id, normalized: normalizeGmailId(id) }));
      const rows = await tx.query<{ id: string; gmail_thread_id: string }>(
        `select id, gmail_thread_id from public.threads where mail_account_id = $1::uuid and gmail_thread_id = any($2::text[])`,
        [account.id, [...new Set(requested.map((item) => item.normalized))]],
      );
      const byGmail = new Map(rows.map((row) => [row.gmail_thread_id, row.id]));
      const intelById = await loadThreadIntel(tx, intel.box, user.userId, rows.map((row) => row.id), requested.length <= 3);
      const threads: Record<string, unknown> = {};
      for (const item of requested) {
        const rowId = byGmail.get(item.normalized);
        const found = rowId ? intelById.get(rowId) : undefined;
        if (found) threads[item.raw] = found;
      }
      return { threads, synced: account.status === 'active', accountId: account.id };
    });
  },
  threadStateUpdate: async (ctx, body, user) => {
    const request = body as Body<'threadStateUpdate'>;
    const { account, threadRowId: id } = await requireThread(ctx, user, request);
    const intel = ctx.intel();
    return asUser(ctx, user, async (tx) => {
      await correctThreadState(tx, { userId: user.userId, accountId: account.id, threadRowId: id, state: request.state });
      const thread = (await loadThreadIntel(tx, intel.box, user.userId, [id], true)).get(id);
      return { thread };
    });
  },
  focusQueue: async (ctx, body, user) => {
    const request = body as Body<'focusQueue'>;
    return asUser(ctx, user, async (tx) => {
      const account = request.mailbox || request.accountId ? await resolveAccount(tx, request) : null;
      if ((request.mailbox || request.accountId) && !account) {
        return { sections: [], generatedAt: ctx.now.toISOString(), coverage: { syncedAccounts: 0, since: null, note: 'This mailbox is not connected to your PigeonBox server.' } };
      }
      const queue = await buildFocusQueue(tx, { accountId: account?.id ?? null, limit: request.limit ?? 40, now: ctx.now });
      return { ...queue, generatedAt: ctx.now.toISOString(), coverage: await focusCoverage(tx) };
    });
  },

  // --- Drafts --------------------------------------------------------------------
  draftList: async (ctx, body, user) => {
    const request = body as Body<'draftList'>;
    const intel = ctx.intel();
    return asUser(ctx, user, async (tx) => {
      const account = request.mailbox || request.accountId ? await resolveAccount(tx, request) : null;
      if ((request.mailbox || request.accountId) && !account) throw new ApiError('not_found', 'This mailbox is not connected to your PigeonBox server.');
      return listDrafts(tx, intel.box, user.userId, { accountId: account?.id ?? null, statuses: request.statuses, limit: request.limit ?? 20, cursor: request.cursor, now: ctx.now });
    });
  },
  draftGet: async (ctx, body, user) => {
    const request = body as Body<'draftGet'>;
    const { threadRowId: id } = await requireThread(ctx, user, request);
    const intel = ctx.intel();
    return { draft: await asUser(ctx, user, (tx) => loadLiveDraft(tx, intel.box, user.userId, id, undefined, ctx.now)) };
  },
  draftPrepare: async (ctx, body, user) => {
    const request = body as Body<'draftPrepare'>;
    const { threadRowId: id } = await requireThread(ctx, user, request);
    const draft = await prepareDraft(ctx.intel(), user.userId, {
      threadRowId: id,
      kind: request.kind,
      origin: 'user',
      instructions: request.instructions ?? null,
      force: Boolean(request.force || request.instructions),
      requestId: ctx.requestId,
      interactive: true,
    });
    return { draft };
  },
  draftPlace: async (ctx, body, user) => {
    const request = body as Body<'draftPlace'>;
    return { draft: await placeDraft(ctx.intel(), user.userId, request, user.via === 'api_token' ? { type: 'mcp', name: 'API client' } : { type: 'user', name: 'You' }) };
  },
  draftFeedback: async (ctx, body, user) => {
    const request = body as Body<'draftFeedback'>;
    await recordDraftFeedback(ctx.intel(), user.userId, request);
    return { ok: true };
  },

  // --- Follow-ups ----------------------------------------------------------------
  followUps: async (ctx, body, user) => {
    const request = body as Body<'followUps'>;
    return asUser(ctx, user, async (tx) => {
      const account = request.mailbox || request.accountId ? await resolveAccount(tx, request) : null;
      return { followUps: await listFollowUps(tx, { stages: request.stages, accountId: account?.id ?? null, limit: request.limit ?? 50 }) };
    });
  },
  followUpUpdate: async (ctx, body, user) => {
    const request = body as Body<'followUpUpdate'>;
    const canDraft = await hasCapability(ctx, user, 'cloud_auto_drafts');
    const intel = ctx.intel();
    return { followUp: await asUser(ctx, user, (tx) => updateFollowUp(intel, tx, user.userId, request, canDraft)) };
  },

  // --- Notifications and audit -----------------------------------------------------
  notifications: async (ctx, body, user) => {
    const request = body as Body<'notifications'>;
    return asUser(ctx, user, (tx) => listNotifications(tx, { since: request.since, unreadOnly: Boolean(request.unreadOnly), limit: request.limit ?? 30 }));
  },
  notificationsAck: async (ctx, body, user) => {
    const request = body as Body<'notificationsAck'>;
    await asUser(ctx, user, (tx) => ackNotifications(tx, request.ids));
    return { ok: true };
  },
  auditList: async (ctx, body, user) => {
    const request = body as Body<'auditList'>;
    return asUser(ctx, user, (tx) => listAudit(tx, { threadId: request.threadId ? normalizeGmailId(request.threadId) : undefined, limit: request.limit ?? 50, cursor: request.cursor }));
  },
};
