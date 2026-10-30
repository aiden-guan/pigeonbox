import { AskStreamEventSchema, type AskStreamEvent, type RouteName, type RouteRequest } from '@pigeonbox/api-contract';
import type { z } from 'zod';
import { CONTROL_ROUTES, type ControlRouteName } from '../control/contract.js';
import { iso, num, one, type SqlExecutor } from '../db/sql.js';
import { ApiError, ndjsonResponse } from '../http.js';
import { undoAction } from '../intel/actions.js';
import { engagement, recentActivity, toCsv } from '../intel/analytics.js';
import { createToken, listTokens, revokeToken } from '../intel/api-tokens.js';
import { oauthDetails, oauthDecide, revokeOAuthProviderGrant } from '../intel/mcp-oauth.js';
import { decideApproval, listApprovals } from '../intel/approvals.js';
import { compileAutomationWithAi, deleteAutomation, executeAutomation, listAutomations, listRuns, runManually, saveAutomation } from '../intel/automations.js';
import { buildDailyBrief, buildMeetingBrief, listBriefings, loadBriefing, saveBriefing } from '../intel/briefings.js';
import { calendarAccount, createPreparedEvent, ensureEventCached, prepareEvent, proposeForThread } from '../intel/calendar.js';
import { associateDocumentLink, createDocument, createLink, deleteDocument, documentAnalytics, listDocuments, revokeLink } from '../intel/documents.js';
import { createDocumentPreview, previewDocumentByToken } from '../intel/document-sessions.js';
import { normalizeGmailId, resolveAccount, threadRowId } from '../intel/ids.js';
import { loadHealth } from '../intel/health.js';
import { loadPreferences } from '../intel/preferences.js';
import { inventory, purgeMailData } from '../intel/privacy.js';
import { listContacts, radar, relationshipBrief, updateContact } from '../intel/relationships.js';
import { askPigeon, STREAM_DEADLINE_MS } from '../intel/ask-agent.js';
import { toApiError } from './errors.js';
import { activateView, compileViewWithAi, deleteView, listViews, reviewShadow, saveView, shadowState, viewHistory, viewResults } from '../intel/rules.js';
import { availability } from '../intel/scheduling.js';
import { purgeFastRecall } from '../intel/search-index.js';
import { addSuppression, enroll, listSequences, listSuppressions, removeSuppression, saveSequence, setSequenceStatus } from '../intel/sequences.js';
import { threadSignals } from '../intel/signals.js';
import { listSubscriptions, setSilence, unsubscribe } from '../intel/subscriptions.js';
import { deleteSnippet, listSnippets, renderSnippet, saveSnippet } from '../intel/snippets.js';
import { acceptInvitation, addComment, assignThread, createWorkspace, inviteMember, listWorkspaces, myAssignments, shareById, sharesForThread, updateAssignment, updateMember } from '../intel/team.js';
import { createWebhook, deleteWebhook, listWebhooks } from '../intel/webhooks.js';
import { listTasks, updateTaskStatus } from '../intel/tasks.js';
import { loadExtensionSettings, saveExtensionSettings } from '../intel/extension-settings.js';
import type { Handler, RequestContext, User } from './types.js';

type Body<N extends RouteName> = NonNullable<RouteRequest<N>>;
type ControlBody<N extends ControlRouteName> = (typeof CONTROL_ROUTES)[N] extends { request: infer S extends z.ZodTypeAny } ? z.infer<S> : never;

const asUser = <T>(ctx: RequestContext, user: User, fn: (tx: SqlExecutor) => Promise<T>) => ctx.intel().db.asUser(user.userId, fn);

async function thread(ctx: RequestContext, user: User, selector: { mailbox?: string; accountId?: string; threadId: string }) {
  return asUser(ctx, user, async (tx) => {
    const account = await resolveAccount(tx, selector);
    if (!account) throw new ApiError('not_found', 'This mailbox is not connected to your PigeonBox server.');
    const id = await threadRowId(tx, account.id, selector.threadId);
    if (!id) throw new ApiError('not_found', 'Your PigeonBox server has not synced this thread yet.');
    return { account, threadRowId: id, gmailThreadId: normalizeGmailId(selector.threadId) };
  });
}

async function contactsFor(tx: SqlExecutor) {
  return tx.query<{ email: string; name: string | null }>(`select email, name from public.contacts where not is_bulk order by greatest(last_inbound_at, last_outbound_at) desc nulls last limit 500`);
}

/** A date range from the web app. Date-only `to` includes that whole day. */
function analyticsRange(fromText: string, toText: string): { from: Date; to: Date } {
  const from = new Date(fromText);
  const to = new Date(/^\d{4}-\d{2}-\d{2}$/.test(toText) ? Date.parse(toText) + 86_400_000 - 1 : toText);
  if (Number.isNaN(from.getTime()) || Number.isNaN(to.getTime()) || from > to) throw new ApiError('invalid_request', 'Choose a valid date range.');
  if (to.getTime() - from.getTime() > 366 * 86_400_000) throw new ApiError('invalid_request', 'Choose a range of a year or less.');
  return { from, to };
}

/** Client feature flags describe UI, never the caller's authority. */
function askAccess(user: User, request: Body<'askPigeon'>) {
  if (user.via === 'session') return { features: request.features, readOnly: false };
  if (request.decision) throw new ApiError('forbidden', 'Only your signed-in session can allow or deny Chat changes.');
  const canPrepare = Boolean(user.scopes?.includes('prepare'));
  return { features: canPrepare ? request.features?.filter((feature) => feature === 'compose') : [], readOnly: !canPrepare };
}

export const FEATURE_HANDLERS: Partial<Record<RouteName, Handler>> = {
  // --- Chat (Ask Pigeon on the wire) ---------------------------------------------
  askPigeon: async (ctx, body, user) => {
    const request = body as Body<'askPigeon'>;
    const access = askAccess(user, request);
    const current = request.threadId ? await thread(ctx, user, { ...request, threadId: request.threadId }) : null;
    return askPigeon(ctx.intel(), user.userId, { query: request.query, history: request.history, includeWeb: request.includeWeb, ...access, mailbox: request.mailbox, timeZone: request.timeZone, decision: request.decision, requestId: ctx.requestId, currentThread: current ? { id: current.threadRowId, accountId: current.account.id } : undefined, signal: ctx.request.signal, defer: ctx.waitUntil });
  },

  /** The same agent, streamed: progress, answer text as it is written, then the cited response. */
  askPigeonStream: async (ctx, body, user) => {
    const request = body as Body<'askPigeonStream'>;
    const access = askAccess(user, request);
    const current = request.threadId ? await thread(ctx, user, { ...request, threadId: request.threadId }) : null;
    const encoder = new TextEncoder();
    const cancelled = new AbortController();
    const background: Promise<void>[] = [];
    let output!: ReadableStreamDefaultController<Uint8Array>;
    const stream = new ReadableStream<Uint8Array>({
      start: (controller) => {
        output = controller;
      },
      // The reader went away (panel closed): stop searching and spending.
      cancel: () => cancelled.abort(),
    });
    const send = (event: AskStreamEvent): boolean => {
      const checked = AskStreamEventSchema.safeParse(event);
      if (!checked.success) {
        ctx.deps.log('error', 'stream event failed contract validation', { requestId: ctx.requestId, event: event.type });
        return false;
      }
      try {
        output.enqueue(encoder.encode(`${JSON.stringify(checked.data)}\n`));
      } catch {
        cancelled.abort();
      }
      return true;
    };
    const run = askPigeon(ctx.intel(), user.userId, {
      query: request.query,
      history: request.history,
      includeWeb: request.includeWeb,
      ...access,
      mailbox: request.mailbox,
      timeZone: request.timeZone,
      decision: request.decision,
      requestId: ctx.requestId,
      currentThread: current ? { id: current.threadRowId, accountId: current.account.id } : undefined,
      onEvent: send,
      signal: cancelled.signal,
      deadlineMs: STREAM_DEADLINE_MS,
      defer: (work) => { background.push(work); },
    })
      .then((response) => {
        if (!send({ type: 'done', response })) send({ type: 'error', code: 'provider_invalid_response', message: 'The server produced an invalid response.' });
      })
      .catch((error: unknown) => {
        if (cancelled.signal.aborted) return;
        const mapped = toApiError(error);
        if (!mapped) ctx.deps.log('error', 'unhandled error', { requestId: ctx.requestId, route: '/v1/ask/stream', code: 'unhandled_error' });
        const apiError = mapped ?? new ApiError('internal', 'Something went wrong. Try again.');
        send({ type: 'error', code: apiError.code, message: apiError.message.slice(0, 500) });
      })
      .finally(() => {
        try {
          output.close();
        } catch {
          // Already closed by the reader.
        }
      });
    // Deliver and close the stream before settling usage/unused lookups, but
    // keep the request's database open until they finish.
    ctx.waitUntil(run.then(() => Promise.allSettled(background)));
    return ndjsonResponse(stream, ctx.requestId);
  },

  /** Thumbs up or down on an answer; a second rating of the same answer replaces the first. */
  askFeedback: async (ctx, body, user) => {
    const request = body as Body<'askFeedback'>;
    const box = ctx.intel().box;
    const id = crypto.randomUUID();
    const seal = async (text: string | undefined, field: string) => {
      const value = text?.trim();
      return value ? box.seal(value, { purpose: 'ask_feedback', userId: user.userId, recordId: `${id}:${field}` }) : null;
    };
    const [question, note] = await Promise.all([seal(request.question, 'question'), seal(request.note, 'note')]);
    await asUser(ctx, user, (tx) =>
      tx.query(
        `insert into public.ask_feedback (id, user_id, request_id, rating, question_key_id, question_iv, question_ciphertext, note_key_id, note_iv, note_ciphertext)
         values ($1::uuid, $2::uuid, $3, $4, $5, $6, $7, $8, $9, $10)
         on conflict (user_id, request_id) do update set id = excluded.id, rating = excluded.rating,
           question_key_id = excluded.question_key_id, question_iv = excluded.question_iv, question_ciphertext = excluded.question_ciphertext,
           note_key_id = excluded.note_key_id, note_iv = excluded.note_iv, note_ciphertext = excluded.note_ciphertext, created_at = now()`,
        [id, user.userId, request.requestId, request.rating, question?.keyId ?? null, question?.iv ?? null, question?.ciphertext ?? null, note?.keyId ?? null, note?.iv ?? null, note?.ciphertext ?? null],
      ),
    );
    ctx.deps.log('info', 'ask feedback', { requestId: ctx.requestId, operation: request.rating === 'up' ? 'ask_feedback_up' : 'ask_feedback_down', count: note ? 1 : 0 });
    return { ok: true as const };
  },

  tasks: async (ctx, _body, user) => ({ tasks: await asUser(ctx, user, (tx) => listTasks(tx, ctx.intel().box, user.userId)) }),
  taskCreate: async (ctx, body, user) => {
    const request = body as Body<'taskCreate'>;
    const found = request.threadId ? await thread(ctx, user, { ...request, threadId: request.threadId }) : null;
    return asUser(ctx, user, async (tx) => {
      const sealed = await ctx.intel().box.seal(request.title, { purpose: 'note', userId: user.userId, recordId: request.id });
      await tx.query(`insert into public.tasks (id, user_id, thread_id, gmail_thread_id, title_key_id, title_iv, title_ciphertext, source, due_at) values ($1::uuid, $2::uuid, $3::uuid, $4, $5, $6, $7, 'user', $8::timestamptz) on conflict (id) do nothing`, [request.id, user.userId, found?.threadRowId || null, found?.gmailThreadId || null, sealed.keyId, sealed.iv, sealed.ciphertext, request.dueAt || null]);
      return { tasks: await listTasks(tx, ctx.intel().box, user.userId) };
    });
  },
  taskUpdate: async (ctx, body, user) => {
    const request = body as Body<'taskUpdate'>;
    return asUser(ctx, user, async (tx) => {
      if (!(await updateTaskStatus(tx, user.userId, request.id, request.status))) throw new ApiError('not_found', 'That task does not exist.');
      return { tasks: await listTasks(tx, ctx.intel().box, user.userId) };
    });
  },

  // --- Calendar Copilot and briefings ---------------------------------------------
  calendarAvailability: async (ctx, body, user) => {
    const request = body as Body<'calendarAvailability'>;
    const intel = ctx.intel();
    const { account, prefs } = await asUser(ctx, user, async (tx) => ({ account: await calendarAccount(tx, request.accountId), prefs: await loadPreferences(tx, user.userId) }));
    const found = await availability(intel, account, prefs, {
      durationMinutes: request.durationMinutes,
      window: { start: new Date(request.window.start), end: new Date(request.window.end) },
      count: request.count ?? 4,
      preferMornings: request.preferMornings,
      timeZone: request.timeZone,
    });
    return { slots: found.slots, timeZone: found.timeZone, calendarsChecked: found.calendarsChecked, note: found.note };
  },
  schedulePropose: async (ctx, body, user) => {
    const request = body as Body<'schedulePropose'>;
    const found = await thread(ctx, user, request);
    return proposeForThread(ctx.intel(), user.userId, { accountId: found.account.id, threadRowId: found.threadRowId, requestId: ctx.requestId });
  },
  eventPrepare: async (ctx, body, user) => {
    const request = body as Body<'eventPrepare'>;
    const found = request.threadId ? await thread(ctx, user, { ...request, threadId: request.threadId }) : null;
    const account = found?.account ?? (await asUser(ctx, user, (tx) => calendarAccount(tx, request.accountId)));
    return {
      event: await prepareEvent(ctx.intel(), user.userId, {
        accountId: account.id,
        threadRowId: found?.threadRowId ?? null,
        gmailThreadId: found?.gmailThreadId ?? null,
        title: request.title,
        start: request.start,
        end: request.end,
        timeZone: request.timeZone,
        attendees: request.attendees ?? [],
        location: request.location,
        description: request.description,
        notifyAttendees: Boolean(request.notifyAttendees),
      }),
    };
  },
  eventCreate: async (ctx, body, user) => {
    const request = body as Body<'eventCreate'>;
    return { event: await createPreparedEvent(ctx.intel(), user.userId, { ...request, actor: user.via === 'api_token' ? 'mcp' : 'user' }) };
  },
  meetingBrief: async (ctx, body, user) => {
    const request = body as Body<'meetingBrief'>;
    const intel = ctx.intel();
    await ensureEventCached(intel, user.userId, request.eventId, request.accountId);
    return { briefing: await asUser(ctx, user, async (tx) => saveBriefing(intel, tx, user.userId, await buildMeetingBrief(intel, tx, user.userId, request.eventId), `brief:meeting:${request.eventId}:manual`)) };
  },
  briefings: async (ctx, body, user) => {
    const request = body as Body<'briefings'>;
    return { briefings: await asUser(ctx, user, (tx) => listBriefings(tx, request.kind, request.limit ?? 10)) };
  },
  briefingGet: async (ctx, body, user) => {
    const request = body as Body<'briefingGet'>;
    const intel = ctx.intel();
    const briefing = await asUser(ctx, user, (tx) => loadBriefing(intel, tx, user.userId, request.id));
    if (!briefing) throw new ApiError('not_found', 'That briefing does not exist.');
    return { briefing };
  },
  briefingGenerate: async (ctx, body, user) => {
    const request = body as Body<'briefingGenerate'>;
    const intel = ctx.intel();
    return { briefing: await asUser(ctx, user, async (tx) => saveBriefing(intel, tx, user.userId, await buildDailyBrief(intel, tx, user.userId, request.kind), `brief:${request.kind}:manual:${ctx.now.toISOString().slice(0, 16)}`)) };
  },

  // --- Relationships and signals ----------------------------------------------------
  contacts: async (ctx, body, user) => {
    const request = body as Body<'contacts'>;
    return asUser(ctx, user, (tx) => listContacts(tx, { query: request.query, cursor: request.cursor, limit: request.limit ?? 50, vipOnly: request.vipOnly }));
  },
  contactBrief: async (ctx, body, user) => {
    const request = body as Body<'contactBrief'>;
    const intel = ctx.intel();
    return { brief: await asUser(ctx, user, (tx) => relationshipBrief(tx, intel.box, user.userId, request, ctx.now)) };
  },
  contactUpdate: async (ctx, body, user) => {
    const request = body as Body<'contactUpdate'>;
    const intel = ctx.intel();
    return { contact: await asUser(ctx, user, (tx) => updateContact(tx, intel.box, user.userId, request)) };
  },
  radar: async (ctx, _body, user) => asUser(ctx, user, (tx) => radar(tx, ctx.now, ctx.intel().box, user.userId)),
  threadSignals: async (ctx, body, user) => {
    const request = body as Body<'threadSignals'>;
    return asUser(ctx, user, (tx) => threadSignals(tx, normalizeGmailId(request.threadId), ctx.now));
  },

  // --- Smart Views --------------------------------------------------------------------
  views: async (ctx, _body, user) => ({ views: await asUser(ctx, user, (tx) => listViews(tx)) }),
  viewCompile: async (ctx, body, user) => {
    const request = body as Body<'viewCompile'>;
    const contacts = await asUser(ctx, user, (tx) => contactsFor(tx));
    return { draft: await compileViewWithAi(ctx.intel(), user.userId, request.prompt, contacts, ctx.requestId) };
  },
  viewSave: async (ctx, body, user) => {
    const request = body as Body<'viewSave'>;
    return {
      view: await asUser(ctx, user, (tx) =>
        saveView(tx, user.userId, { id: request.id, name: request.name, prompt: request.prompt, filter: request.filter as never, actions: (request.actions ?? []) as never, mode: request.mode ?? 'view', enabled: request.enabled ?? true, priority: request.priority ?? 50 }),
      ),
    };
  },
  viewDelete: async (ctx, body, user) => {
    await asUser(ctx, user, (tx) => deleteView(tx, user.userId, (body as Body<'viewDelete'>).id));
    return { ok: true };
  },
  viewResults: async (ctx, body, user) => {
    const request = body as Body<'viewResults'>;
    return viewResults(ctx.intel(), user.userId, request.id, request.limit ?? 40);
  },
  viewShadow: async (ctx, body, user) => asUser(ctx, user, (tx) => shadowState(tx, (body as Body<'viewShadow'>).id)),
  viewReview: async (ctx, body, user) => {
    const request = body as Body<'viewReview'>;
    return asUser(ctx, user, (tx) => reviewShadow(tx, user.userId, request.decisionId, request.verdict));
  },
  viewActivate: async (ctx, body, user) => ({ view: await asUser(ctx, user, (tx) => activateView(tx, user.userId, (body as Body<'viewActivate'>).id)) }),
  viewHistory: async (ctx, body, user) => ({ versions: await asUser(ctx, user, (tx) => viewHistory(tx, (body as Body<'viewHistory'>).id)) }),

  // --- Automations ----------------------------------------------------------------------
  automations: async (ctx, _body, user) => ({ automations: await asUser(ctx, user, (tx) => listAutomations(tx)) }),
  automationCompile: async (ctx, body, user) => {
    const request = body as Body<'automationCompile'>;
    const { prefs, contacts } = await asUser(ctx, user, async (tx) => ({ prefs: await loadPreferences(tx, user.userId), contacts: await contactsFor(tx) }));
    return { draft: await compileAutomationWithAi(ctx.intel(), user.userId, request.prompt, prefs.timeZone, contacts, ctx.requestId) };
  },
  automationSave: async (ctx, body, user) => {
    const request = body as Body<'automationSave'>;
    const intel = ctx.intel();
    return {
      automation: await asUser(ctx, user, (tx) =>
        saveAutomation(intel, tx, user.userId, {
          id: request.id,
          name: request.name,
          prompt: request.prompt,
          trigger: { kind: request.trigger.kind, params: request.trigger.params ?? {} },
          conditions: request.conditions as never,
          context: request.context ?? ['thread'],
          actions: request.actions as never,
          autonomy: request.autonomy ?? 'suggest',
          schedule: request.schedule ?? null,
          mode: request.mode ?? 'shadow',
          enabled: request.enabled ?? true,
        }),
      ),
    };
  },
  automationDelete: async (ctx, body, user) => {
    await asUser(ctx, user, (tx) => deleteAutomation(tx, user.userId, (body as Body<'automationDelete'>).id));
    return { ok: true };
  },
  automationRun: async (ctx, body, user) => {
    const request = body as Body<'automationRun'>;
    const found = request.threadId ? await thread(ctx, user, { threadId: request.threadId, accountId: request.accountId }) : null;
    const runId = found?.threadRowId
      ? await executeAutomation(ctx.intel(), user.userId, { automationId: request.id, trigger: 'manual', threadRowId: found.threadRowId, key: `manual:${request.idempotencyKey}`, manual: true })
      : await runManually(ctx.intel(), user.userId, { automationId: request.id, key: `manual:${request.idempotencyKey}` });
    const runs = await asUser(ctx, user, (tx) => listRuns(tx, request.id, 50));
    const run = runs.find((item) => item.id === runId);
    if (!run) throw new ApiError('internal', 'The run was not recorded.');
    return { run };
  },
  automationRuns: async (ctx, body, user) => {
    const request = body as Body<'automationRuns'>;
    return { runs: await asUser(ctx, user, (tx) => listRuns(tx, request.id, request.limit ?? 30)) };
  },

  // --- Approvals and undo ---------------------------------------------------------------
  approvals: async (ctx, body, user) => {
    const request = body as Body<'approvals'>;
    const intel = ctx.intel();
    return asUser(ctx, user, (tx) => listApprovals(tx, intel.box, user.userId, request.status ?? 'pending', request.limit ?? 30));
  },
  approvalDecide: async (ctx, body, user) => {
    if (user.via === 'api_token') throw new ApiError('forbidden', 'Approvals can only be decided by the person in PigeonBox, not by an API token.');
    return { approval: await decideApproval(ctx.intel(), user.userId, body as Body<'approvalDecide'>) };
  },
  actionUndo: async (ctx, body, user) => {
    const request = body as Body<'actionUndo'>;
    const intel = ctx.intel();
    const undoId = await undoAction(intel, user.userId, request.auditId, request.idempotencyKey);
    const { toAuditEvent, getAuditRow } = await import('../intel/audit.js');
    const row = await asUser(ctx, user, (tx) => getAuditRow(tx, undoId));
    return { event: toAuditEvent(row!) };
  },

  // --- Team and snippets -----------------------------------------------------------------
  workspaces: async (ctx, _body, user) => ({ workspaces: await asUser(ctx, user, (tx) => listWorkspaces(tx)) }),
  threadTeam: async (ctx, body, user) => {
    const request = body as Body<'threadTeam'>;
    const intel = ctx.intel();
    return { shares: await asUser(ctx, user, (tx) => sharesForThread(tx, intel.box, normalizeGmailId(request.threadId))) };
  },
  assign: async (ctx, body, user) => {
    const request = body as Body<'assign'>;
    const found = await thread(ctx, user, request);
    return { share: await assignThread(ctx.intel(), user.userId, { workspaceId: request.workspaceId, accountId: found.account.id, threadRowId: found.threadRowId, assigneeUserId: request.assigneeUserId, fields: request.fields, note: request.note }) };
  },
  assignmentUpdate: async (ctx, body, user) => {
    const request = body as Body<'assignmentUpdate'>;
    return { share: await updateAssignment(ctx.intel(), user.userId, request.assignmentId, request.status) };
  },
  commentAdd: async (ctx, body, user) => {
    const request = body as Body<'commentAdd'>;
    return { share: await addComment(ctx.intel(), user.userId, { shareId: request.shareId, body: request.body, mentions: request.mentions ?? [] }) };
  },
  snippets: async (ctx, _body, user) => ({ snippets: await asUser(ctx, user, (tx) => listSnippets(tx)) }),
  snippetSave: async (ctx, body, user) => {
    const request = body as Body<'snippetSave'>;
    return { snippet: await asUser(ctx, user, (tx) => saveSnippet(tx, user.userId, { id: request.id, name: request.name, body: request.body, workspaceId: request.workspaceId ?? null, allowedSources: request.allowedSources ?? ['thread', 'profile'] })) };
  },
  snippetDelete: async (ctx, body, user) => {
    await asUser(ctx, user, (tx) => deleteSnippet(tx, (body as Body<'snippetDelete'>).id));
    return { ok: true };
  },
  snippetRender: async (ctx, body, user) => {
    const request = body as Body<'snippetRender'>;
    const found = request.threadId ? await thread(ctx, user, { ...request, threadId: request.threadId }).catch(() => null) : null;
    const accountId = found?.account.id ?? (await asUser(ctx, user, (tx) => resolveAccount(tx, request)))?.id ?? null;
    return renderSnippet(ctx.intel(), user.userId, { snippetId: request.snippetId, accountId, threadRowId: found?.threadRowId ?? null, values: request.values ?? {}, timeZone: request.timeZone, requestId: ctx.requestId });
  },

  // --- Documents ---------------------------------------------------------------------------
  documentPreview: async (ctx, body, user) => ({ url: await previewDocumentByToken(ctx.intel(), user.userId, (body as Body<'documentPreview'>).token) }),
  documentCreate: async (ctx, body, user) => {
    const { uploadPath: _uploadPath, ...document } = await asUser(ctx, user, (tx) => createDocument(tx, user.userId, body as Body<'documentCreate'>));
    return { document };
  },
  documents: async (ctx, _body, user) => ({ documents: await asUser(ctx, user, (tx) => listDocuments(tx)) }),
  documentLinkCreate: async (ctx, body, user) => {
    const request = body as Body<'documentLinkCreate'>;
    return { link: await createLink(ctx.intel(), user.userId, { ...request, threadId: request.threadId ? normalizeGmailId(request.threadId) : undefined, allowDownload: Boolean(request.allowDownload), watermark: request.watermark ?? true }) };
  },
  documentLinkRevoke: async (ctx, body, user) => ({ link: await revokeLink(ctx.intel(), user.userId, (body as Body<'documentLinkRevoke'>).linkId) }),
  documentLinkAssociate: async (ctx, body, user) => {
    const request = body as Body<'documentLinkAssociate'>;
    await asUser(ctx, user, tx => associateDocumentLink(tx, request.token, normalizeGmailId(request.threadId)));
    return { ok: true };
  },
  documentAnalytics: async (ctx, body, user) => documentAnalytics(ctx.intel(), user.userId, (body as Body<'documentAnalytics'>).documentId),
};

export const CONTROL_HANDLERS: Record<ControlRouteName, Handler> = {
  controlAuthLink: async (ctx, body, user) => {
    const query = body as import('@pigeonbox/api-contract').AuthorizeQuery;
    const origin = ctx.request.headers.get('Origin');
    const redirect = new URL(query.redirect_uri);
    const extension = origin?.match(/^chrome-extension:\/\/([a-p]{32})$/);
    const fromExtension = Boolean(extension && ctx.deps.config.allowedExtensionIds.includes(extension[1]!));
    const fromDashboard = Boolean(origin && ctx.deps.config.allowedWebOrigins.includes(origin) && redirect.origin === origin);
    if (!fromExtension && !fromDashboard) throw new ApiError('forbidden', 'Account connection must start from PigeonBox or your dashboard.');
    if (!ctx.deps.config.allowedWebOrigins.includes(redirect.origin) || redirect.pathname !== '/dashboard' || redirect.search || redirect.hash || redirect.username || redirect.password) throw new ApiError('forbidden', 'That redirect address is not allowed.');
    return { code: await ctx.deps.auth.linkCode(user, query), state: query.state };
  },
  controlOverview: async (ctx, _body, user) =>
    asUser(ctx, user, async (tx) => {
      const counts = await one<{ connections: number; unhealthy: number; approvals: number; due: number; drafts: number; background: number; tokens: string }>(
        tx,
        `select (select count(*)::int from public.mail_accounts where status = 'active') as connections,
                (select count(*)::int from public.gmail_sync_state where state in ('stalled', 'degraded')) as unhealthy,
                (select count(*)::int from public.approvals where status = 'pending') as approvals,
                (select count(*)::int from public.follow_ups where stage = 'follow_up_due') as due,
                (select count(*)::int from public.drafts d join public.threads t on t.id = d.thread_id where d.status in ('ready', 'placed') and d.based_on_version = t.content_version) as drafts,
                coalesce((select background_requests from public.usage_daily where user_id = $1::uuid and day = current_date), 0)::int as background,
                coalesce((select sum(tokens) from public.usage_daily where user_id = $1::uuid and day >= date_trunc('month', current_date)), 0)::text as tokens`,
        [user.userId],
      );
      const states = await tx.query<{ state: string; n: number }>(`select coalesce(user_state, state) as state, count(*)::int as n from public.thread_states group by 1`);
      const latest = await one<{ id: string; title: string; generated_at: unknown }>(tx, `select id, title, generated_at from public.briefings order by generated_at desc limit 1`);
      return {
        connections: num(counts?.connections),
        syncHealthy: num(counts?.unhealthy) === 0,
        focus: Object.fromEntries(states.map((row) => [row.state, num(row.n)])),
        pendingApprovals: num(counts?.approvals),
        followUpsDue: num(counts?.due),
        draftsReady: num(counts?.drafts),
        latestBriefing: latest ? { id: latest.id, title: latest.title, generatedAt: iso(latest.generated_at) } : null,
        usage: { backgroundToday: num(counts?.background), tokensThisMonth: num(counts?.tokens) },
      };
    }),
  controlHealth: async (ctx, _body, user) => asUser(ctx, user, async (tx) => loadHealth(tx, ctx.intel().now(), (await loadPreferences(tx, user.userId)).memory.enabled)),
  controlWorkspaceCreate: async (ctx, body, user) => {
    const request = body as ControlBody<'controlWorkspaceCreate'>;
    return { id: await asUser(ctx, user, (tx) => createWorkspace(tx, user.userId, request.name, user.email?.split('@')[0] ?? '')) };
  },
  controlWorkspaceInvite: async (ctx, body, user) => {
    const request = body as ControlBody<'controlWorkspaceInvite'>;
    return asUser(ctx, user, (tx) => inviteMember(tx, user.userId, request, ctx.deps.config.apiBaseUrl ?? ctx.url.origin));
  },
  controlWorkspaceAccept: async (ctx, body, user) => ({ workspaceId: await asUser(ctx, user, (tx) => acceptInvitation(tx, (body as ControlBody<'controlWorkspaceAccept'>).token)) }),
  controlMemberUpdate: async (ctx, body, user) => {
    await asUser(ctx, user, (tx) => updateMember(tx, body as ControlBody<'controlMemberUpdate'>));
    return { ok: true };
  },
  controlAssigned: async (ctx, _body, user) => {
    const intel = ctx.intel();
    return { shares: await asUser(ctx, user, (tx) => myAssignments(tx, intel.box)) };
  },
  controlShare: async (ctx, body, user) => {
    const intel = ctx.intel();
    return { share: await asUser(ctx, user, (tx) => shareById(tx, intel.box, (body as ControlBody<'controlShare'>).shareId)) };
  },
  controlMcpConfig: async (ctx) => ({ oauthEnabled: ctx.deps.config.auth.mcpOAuthEnabled, trackingConfigured: Boolean(ctx.deps.config.intel.trackerBaseUrl) }),
  controlMcpOAuthDetails: async (ctx, body, user) => oauthDetails(ctx, user, (body as ControlBody<'controlMcpOAuthDetails'>).authorizationId),
  controlMcpOAuthDecide: async (ctx, body, user) => oauthDecide(ctx, user, body as ControlBody<'controlMcpOAuthDecide'>),
  controlTokens: async (ctx, _body, user) => ({ tokens: await asUser(ctx, user, (tx) => listTokens(tx)) }),
  controlTokenCreate: async (ctx, body, user) => {
    if (user.via === 'api_token') throw new ApiError('forbidden', 'API tokens cannot create tokens.');
    const request = body as ControlBody<'controlTokenCreate'>;
    return asUser(ctx, user, (tx) => createToken(tx, user.userId, { name: request.name, scopes: request.scopes, expiresInDays: request.expiresInDays ?? null }));
  },
  controlTokenRevoke: async (ctx, body, user) => {
    if (user.via !== 'session') throw new ApiError('forbidden', 'Only the person can revoke connections.');
    const id = (body as ControlBody<'controlTokenRevoke'>).id;
    await asUser(ctx, user, (tx) => revokeToken(tx, user.userId, id));
    await revokeOAuthProviderGrant(ctx, user, id);
    return { ok: true };
  },
  controlWebhooks: async (ctx, _body, user) => ({ webhooks: await asUser(ctx, user, (tx) => listWebhooks(tx)) }),
  controlWebhookCreate: async (ctx, body, user) => {
    const intel = ctx.intel();
    return asUser(ctx, user, (tx) => createWebhook(intel, tx, user.userId, body as ControlBody<'controlWebhookCreate'>));
  },
  controlWebhookDelete: async (ctx, body, user) => {
    await asUser(ctx, user, (tx) => deleteWebhook(tx, (body as ControlBody<'controlWebhookDelete'>).id));
    return { ok: true };
  },
  controlAnalytics: async (ctx, body, user) => {
    const request = body as ControlBody<'controlAnalytics'>;
    return asUser(ctx, user, (tx) => engagement(tx, { ...analyticsRange(request.from, request.to), groupBy: request.groupBy ?? 'day' }));
  },
  controlAnalyticsExport: async (ctx, body, user) => {
    const request = body as ControlBody<'controlAnalyticsExport'>;
    const result = await asUser(ctx, user, (tx) => engagement(tx, { ...analyticsRange(request.from, request.to), groupBy: request.groupBy ?? 'day' }));
    return { filename: `pigeonbox-engagement-${request.groupBy ?? 'day'}-${request.from.slice(0, 10)}-${request.to.slice(0, 10)}.csv`, csv: toCsv(result.rows, request.groupBy ?? 'day') };
  },
  controlActivity: async (ctx, body, user) => ({ items: await asUser(ctx, user, (tx) => recentActivity(tx, (body as ControlBody<'controlActivity'>).limit ?? 50)) }),
  controlPrivacy: async (ctx, _body, user) =>
    asUser(ctx, user, async (tx) => {
      const prefs = await loadPreferences(tx, user.userId);
      return { inventory: await inventory(tx), fastRecall: prefs.fastRecall };
    }),
  controlPurgeMail: async (ctx, _body, user) => {
    const intel = ctx.intel();
    await asUser(ctx, user, (tx) => purgeFastRecall(tx));
    return { removed: await purgeMailData(intel, user.userId) };
  },
  controlDocumentCreate: async (ctx, body, user) => {
    const request = body as ControlBody<'controlDocumentCreate'>;
    const { uploadPath, ...document } = await asUser(ctx, user, (tx) => createDocument(tx, user.userId, request));
    return { document, uploadPath };
  },
  controlDocumentDelete: async (ctx, body, user) => {
    await deleteDocument(ctx.intel(), user.userId, (body as ControlBody<'controlDocumentDelete'>).id);
    return { ok: true };
  },
  controlDocumentPreview: async (ctx, body, user) => ({ url: await createDocumentPreview(ctx.intel(), user.userId, (body as ControlBody<'controlDocumentPreview'>).linkId) }),
  controlSequences: async (ctx, _body, user) => ({ sequences: (await asUser(ctx, user, (tx) => listSequences(tx))) as never, dailyLimit: ctx.deps.config.intel.sequenceDailyLimit }),
  controlSequenceSave: async (ctx, body, user) => {
    const request = body as ControlBody<'controlSequenceSave'>;
    const intel = ctx.intel();
    return { id: await asUser(ctx, user, (tx) => saveSequence(intel, tx, user.userId, { ...request, window: request.window ?? { start: '09:00', end: '17:00' }, dailyLimit: request.dailyLimit ?? 25, stopOnReply: request.stopOnReply ?? true, trackOpens: request.trackOpens ?? false, steps: request.steps.map((step) => ({ ...step, aiPersonalize: step.aiPersonalize ?? false })) })) };
  },
  controlSequenceEnroll: async (ctx, body, user) => {
    const request = body as ControlBody<'controlSequenceEnroll'>;
    const intel = ctx.intel();
    return asUser(ctx, user, (tx) => enroll(intel, tx, user.userId, request.sequenceId, request.recipients.map((recipient) => ({ email: recipient.email, fields: recipient.fields ?? {} }))));
  },
  controlSequenceStatus: async (ctx, body, user) => {
    const request = body as ControlBody<'controlSequenceStatus'>;
    return setSequenceStatus(ctx.intel(), user.userId, request.sequenceId, request.status);
  },
  controlSubscriptions: async (ctx, body, user) => {
    const request = body as ControlBody<'controlSubscriptions'>;
    return asUser(ctx, user, async (tx) => {
      const subscriptions = await listSubscriptions(tx, { query: request.query, limit: request.limit });
      const organize = await one<{ any: boolean }>(tx, `select coalesce(bool_or('organize' = any (features)), false) as any from public.mail_accounts where status = 'active'`);
      return { subscriptions, canArchive: Boolean(organize?.any) };
    });
  },
  controlUnsubscribe: async (ctx, body, user) => {
    const request = body as ControlBody<'controlUnsubscribe'>;
    const results = [];
    // A few at a time: each is one Gmail read and one POST to the sender.
    for (let index = 0; index < request.senders.length; index += 4) {
      const chunk = request.senders.slice(index, index + 4);
      results.push(...(await Promise.all(chunk.map((sender) => unsubscribe(ctx.intel(), user.userId, { accountId: sender.accountId, sender: sender.email, archive: request.archive, requestId: ctx.requestId })))));
    }
    return { results };
  },
  controlSubscriptionUpdate: async (ctx, body, user) => {
    const request = body as ControlBody<'controlSubscriptionUpdate'>;
    await asUser(ctx, user, (tx) => setSilence(tx, request.accountId, request.email, request.silence));
    return { ok: true };
  },
  controlSuppressions: async (ctx, _body, user) => ({ suppressions: await asUser(ctx, user, (tx) => listSuppressions(tx)) }),
  controlSuppressionUpdate: async (ctx, body, user) => {
    const request = body as ControlBody<'controlSuppressionUpdate'>;
    await asUser(ctx, user, (tx) => (request.action === 'add' ? addSuppression(tx, user.userId, request.email) : removeSuppression(tx, request.email)));
    return { ok: true };
  },
  controlExtensionSettings: async (ctx, _body, user) => ({ backup: await asUser(ctx, user, (tx) => loadExtensionSettings(tx, user.userId)) }),
  controlExtensionSettingsSave: async (ctx, body, user) => {
    const request = body as ControlBody<'controlExtensionSettingsSave'>;
    return { backup: await asUser(ctx, user, (tx) => saveExtensionSettings(tx, user.userId, request)) };
  },
  controlTasks: async (ctx, _body, user) => ({ tasks: await asUser(ctx, user, (tx) => listTasks(tx, ctx.intel().box, user.userId)) }),
  controlTaskUpdate: async (ctx, body, user) => {
    const request = body as ControlBody<'controlTaskUpdate'>;
    if (!(await asUser(ctx, user, (tx) => updateTaskStatus(tx, user.userId, request.id, request.status)))) throw new ApiError('not_found', 'That task does not exist.');
    return { ok: true };
  },
};
