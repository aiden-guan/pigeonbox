import type { ActionSpec, FilterSpec, SmartView } from '@pigeonbox/api-contract';
import { businessDaysBetween, type ThreadState } from '@pigeonbox/shared';
import { InferenceError } from '../ai/backends.js';
import { iso, isoOrNull, num, one, type SqlExecutor } from '../db/sql.js';
import { ApiError } from '../http.js';
import type { JobRecord } from '../jobs/queue.js';
import { SkipJob } from '../jobs/runner.js';
import { performAction } from './actions.js';
import { BudgetExceededError, runStructured } from './ai.js';
import { createApproval } from './approvals.js';
import { recordAudit } from './audit.js';
import type { IntelDeps } from './context.js';
import { ACTION_LABELS } from './policy.js';
import { loadPreferences } from './preferences.js';
import { MATCH_BATCH_SIZE, matchBatchPrompt, MatchBatchOutputSchema, matchPrompt, MatchOutputSchema, viewCompilePrompt, ViewCompileOutputSchema } from './prompts.js';
import { compileView, explainFilter, viewFromAi, type CompiledView } from './rule-compiler.js';
import { decryptSummary } from './threads.js';

/**
 * Smart Views and Shadow Mode.
 *
 * A view is a filter. A view with mailbox-changing actions is a rule: it
 * starts in Shadow Mode, where PigeonBox records what it would do and changes
 * nothing. The user confirms or corrects examples; only after enough
 * confirmations (and no more than 10% corrections) can the rule be
 * activated. Active rules act through the policy engine: Tier 1 changes run
 * and are audited and undoable; anything higher becomes an approval card.
 * Every change to a rule is a new version.
 */

export const ACTIVATION_REQUIRED = 5;
const EVALUATION_WINDOW_DAYS = 60;

type ViewRow = {
  id: string;
  name: string;
  prompt: string;
  filter: FilterSpec;
  explanation: string[];
  uses_ai: boolean;
  actions: ActionSpec[];
  mode: 'view' | 'shadow' | 'active';
  enabled: boolean;
  priority: number;
  version: number;
  matched: number;
  shadow_decisions: number;
  confirmed: number;
  corrected: number;
  applied: number;
  undone: number;
  last_run_at: unknown;
  created_at: unknown;
  updated_at: unknown;
};

export function activationFor(view: Pick<ViewRow, 'confirmed' | 'corrected' | 'actions' | 'mode'>): SmartView['activation'] {
  const confirmed = num(view.confirmed);
  const corrected = num(view.corrected);
  if (!view.actions.length) return { eligible: false, reason: 'This view has no actions; it only lists matching threads.', required: 0, confirmed };
  if (view.mode === 'active') return { eligible: false, reason: 'Already active.', required: ACTIVATION_REQUIRED, confirmed };
  if (confirmed < ACTIVATION_REQUIRED) return { eligible: false, reason: `Confirm ${ACTIVATION_REQUIRED - confirmed} more example${ACTIVATION_REQUIRED - confirmed === 1 ? '' : 's'} in Shadow Mode first.`, required: ACTIVATION_REQUIRED, confirmed };
  if (corrected * 10 > confirmed + corrected) return { eligible: false, reason: 'Too many corrections: refine the view and review more examples.', required: ACTIVATION_REQUIRED, confirmed };
  return { eligible: true, reason: `${confirmed} examples confirmed with ${corrected} correction${corrected === 1 ? '' : 's'}.`, required: ACTIVATION_REQUIRED, confirmed };
}

export function toSmartView(row: ViewRow): SmartView {
  return {
    id: row.id,
    name: row.name.slice(0, 120),
    prompt: row.prompt.slice(0, 500),
    filter: row.filter,
    explanation: row.explanation.slice(0, 20),
    usesAi: row.uses_ai,
    actions: row.actions,
    mode: row.mode,
    enabled: row.enabled,
    priority: num(row.priority),
    version: num(row.version),
    stats: {
      matched: num(row.matched),
      shadowDecisions: num(row.shadow_decisions),
      confirmed: num(row.confirmed),
      corrected: num(row.corrected),
      applied: num(row.applied),
      undone: num(row.undone),
      lastRunAt: isoOrNull(row.last_run_at),
    },
    activation: activationFor(row),
    createdAt: iso(row.created_at),
    updatedAt: iso(row.updated_at),
  };
}

export async function listViews(tx: SqlExecutor): Promise<SmartView[]> {
  const rows = await tx.query<ViewRow>(`select * from public.smart_views order by priority desc, created_at`);
  return rows.map(toSmartView);
}

async function viewRow(tx: SqlExecutor, id: string): Promise<ViewRow> {
  const row = await one<ViewRow>(tx, `select * from public.smart_views where id = $1::uuid`, [id]);
  if (!row) throw new ApiError('not_found', 'That view does not exist.');
  return row;
}

export async function saveView(
  tx: SqlExecutor,
  userId: string,
  input: { id?: string; name: string; prompt: string; filter: FilterSpec; actions: ActionSpec[]; mode: 'view' | 'shadow' | 'active'; enabled: boolean; priority: number },
  changedBy = 'You',
): Promise<SmartView> {
  const explanation = explainFilter(input.filter);
  const usesAi = Boolean(input.filter.aiCriteria);
  let row: ViewRow;
  if (!input.id) {
    // New rules that would change the mailbox always start in Shadow Mode.
    const mode = input.actions.length ? 'shadow' : 'view';
    row = (await one<ViewRow>(
      tx,
      `insert into public.smart_views (user_id, name, prompt, filter, explanation, uses_ai, actions, mode, enabled, priority)
       values ($1::uuid, $2, $3, $4::jsonb, $5::text[], $6, $7::jsonb, $8, $9, $10) returning *`,
      [userId, input.name, input.prompt, input.filter, explanation, usesAi, JSON.stringify(input.actions), mode, input.enabled, input.priority],
    ))!;
  } else {
    const current = await viewRow(tx, input.id);
    const logicChanged = JSON.stringify(current.filter) !== JSON.stringify(input.filter) || JSON.stringify(current.actions) !== JSON.stringify(input.actions);
    // Changing what an active rule does sends it back to Shadow Mode, with fresh statistics.
    let mode: ViewRow['mode'] = input.actions.length ? (input.mode === 'view' ? 'shadow' : input.mode) : 'view';
    if (mode === 'active' && (current.mode !== 'active' || logicChanged)) mode = activationFor({ ...current, mode: 'shadow', actions: input.actions }).eligible && !logicChanged ? 'active' : 'shadow';
    row = (await one<ViewRow>(
      tx,
      `update public.smart_views set name = $2, prompt = $3, filter = $4::jsonb, explanation = $5::text[], uses_ai = $6, actions = $7::jsonb, mode = $8,
          enabled = $9, priority = $10, version = version + 1, updated_at = now(),
          confirmed = case when $11 then 0 else confirmed end, corrected = case when $11 then 0 else corrected end,
          shadow_decisions = case when $11 then 0 else shadow_decisions end
        where id = $1::uuid returning *`,
      [input.id, input.name, input.prompt, input.filter, explanation, usesAi, JSON.stringify(input.actions), mode, input.enabled, input.priority, logicChanged],
    ))!;
    if (logicChanged) await tx.query(`delete from public.rule_matches where view_id = $1::uuid`, [row.id]);
  }
  await tx.query(
    `insert into public.rule_versions (view_id, user_id, version, name, prompt, filter, actions, mode, enabled, changed_by)
     values ($1::uuid, $2::uuid, $3, $4, $5, $6::jsonb, $7::jsonb, $8, $9, $10)`,
    [row.id, userId, row.version, row.name, row.prompt, row.filter, JSON.stringify(row.actions), row.mode, row.enabled, changedBy],
  );
  await recordAudit(tx, {
    userId,
    actor: { type: 'user', id: userId, name: changedBy },
    action: input.id ? 'update_view' : 'create_view',
    tier: 0,
    target: { kind: 'smart_view', id: row.id, title: row.name },
    summary: `${input.id ? 'Updated' : 'Created'} "${row.name}" (version ${row.version}, ${row.mode})`,
    policy: { decision: 'allowed', reason: 'Configuration change' },
  });
  return toSmartView(row);
}

export async function deleteView(tx: SqlExecutor, userId: string, id: string): Promise<void> {
  const row = await viewRow(tx, id);
  await tx.query(`delete from public.smart_views where id = $1::uuid`, [id]);
  await recordAudit(tx, {
    userId,
    actor: { type: 'user', id: userId, name: 'You' },
    action: 'delete_view',
    tier: 0,
    target: { kind: 'smart_view', id, title: row.name },
    summary: `Deleted "${row.name}"`,
    policy: { decision: 'allowed', reason: 'Configuration change' },
  });
}

export async function viewHistory(tx: SqlExecutor, id: string) {
  await viewRow(tx, id);
  const rows = await tx.query<{ version: number; name: string; prompt: string; filter: FilterSpec; actions: ActionSpec[]; mode: 'view' | 'shadow' | 'active'; enabled: boolean; created_at: unknown; changed_by: string }>(
    `select version, name, prompt, filter, actions, mode, enabled, created_at, changed_by from public.rule_versions where view_id = $1::uuid order by version desc limit 200`,
    [id],
  );
  return rows.map((row) => ({ version: row.version, name: row.name, prompt: row.prompt, filter: row.filter, actions: row.actions, mode: row.mode, enabled: row.enabled, changedAt: iso(row.created_at), changedBy: row.changed_by.slice(0, 120) }));
}

// ---------------------------------------------------------------------------
// Evaluation
// ---------------------------------------------------------------------------

export type ThreadContext = {
  id: string;
  gmail_thread_id: string;
  mail_account_id: string;
  subject: string;
  label_ids: string[];
  last_message_at: unknown;
  last_message_from_owner: boolean;
  last_outbound_at: unknown;
  has_attachment: boolean;
  content_version: string;
  state: ThreadState | null;
  deadline_at: unknown;
  relationship_importance: string | null;
  sender: string | null;
  sender_name: string | null;
  recipients: string[] | null;
  engagement_opens: number | null;
  engagement_clicks: number | null;
  sender_read: boolean;
  summary_key_id: string | null;
  summary_iv: string | null;
  summary_ciphertext: string | null;
};

export const THREAD_CONTEXT = `
  select t.id, t.gmail_thread_id, t.mail_account_id, t.subject, t.label_ids, t.last_message_at, t.last_message_from_owner, t.last_outbound_at,
         t.has_attachment, t.content_version, coalesce(s.user_state, s.state) as state, s.deadline_at, s.relationship_importance,
         s.summary_key_id, s.summary_iv, s.summary_ciphertext, inbound.sender, inbound.sender_name, outbound.recipients,
         f.engagement_opens, f.engagement_clicks,
         coalesce(inbound.sender is not null and exists (select 1 from public.message_metadata r where lower(r.from_email) = inbound.sender and not ('UNREAD' = any (r.label_ids))), false) as sender_read
    from public.threads t
    left join public.thread_states s on s.thread_id = t.id
    left join public.follow_ups f on f.thread_id = t.id
    left join lateral (select lower(m.from_email) as sender, m.from_name as sender_name from public.message_metadata m where m.thread_id = t.id and m.direction = 'inbound' order by m.internal_date desc limit 1) inbound on true
    left join lateral (select m.to_emails || m.cc_emails as recipients from public.message_metadata m where m.thread_id = t.id and m.direction = 'outbound' order by m.internal_date desc limit 1) outbound on true`;

function addressMatches(pattern: string, email: string): boolean {
  const value = pattern.toLowerCase().trim();
  const address = email.toLowerCase();
  if (value.includes('@') && !value.startsWith('@')) return address === value;
  const domain = value.replace(/^@/, '').replace(/^\./, '');
  const emailDomain = address.split('@')[1] ?? '';
  if (value.startsWith('.')) return emailDomain.endsWith(value);
  return emailDomain === domain || emailDomain.endsWith(`.${domain}`);
}

/** Deterministic part of a filter. Returns the reasons it matched, or null. */
export function matchDeterministic(filter: FilterSpec, thread: ThreadContext, context: { summary: string; now: Date; timeZone: string; workdays: number[] }): string[] | null {
  const why: string[] = [];
  const counterparts = thread.last_message_from_owner ? thread.recipients ?? [] : thread.sender ? [thread.sender] : [];
  if (filter.from.include.length) {
    const hit = counterparts.find((email) => filter.from.include.some((pattern) => addressMatches(pattern, email)));
    if (!hit) return null;
    why.push(`${thread.last_message_from_owner ? 'To' : 'From'} ${hit}`);
  }
  if (filter.from.exclude.length && counterparts.some((email) => filter.from.exclude.some((pattern) => addressMatches(pattern, email)))) return null;
  if (filter.to.include.length) {
    const hit = (thread.recipients ?? []).find((email) => filter.to.include.some((pattern) => addressMatches(pattern, email)));
    if (!hit) return null;
    why.push(`To ${hit}`);
  }
  if (filter.states.length) {
    if (!thread.state || !filter.states.includes(thread.state)) return null;
    why.push(thread.state.toLowerCase().replace(/_/g, ' '));
  }
  if (filter.labels.include.length && !filter.labels.include.some((label) => thread.label_ids.includes(label))) return null;
  if (filter.labels.exclude.some((label) => thread.label_ids.includes(label))) return null;
  if (filter.direction === 'outbound' && !thread.last_message_from_owner) return null;
  if (filter.direction === 'inbound' && thread.last_message_from_owner) return null;
  const haystack = `${thread.subject}\n${context.summary}\n${thread.sender_name ?? ''}`.toLowerCase();
  if (filter.subjectAny.length) {
    const hit = filter.subjectAny.find((word) => thread.subject.toLowerCase().includes(word.toLowerCase()));
    if (!hit) return null;
    why.push(`Subject mentions “${hit}”`);
  }
  if (filter.keywordsAny.length) {
    const hit = filter.keywordsAny.find((word) => new RegExp(`\\b${word.toLowerCase().replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}`).test(haystack));
    if (!hit) return null;
    why.push(`Mentions “${hit}”`);
  }
  if (filter.deadlineWithinDays !== null) {
    const due = thread.deadline_at ? Date.parse(iso(thread.deadline_at)) : NaN;
    if (!Number.isFinite(due) || due - context.now.getTime() > filter.deadlineWithinDays * 86_400_000 || due < context.now.getTime() - 86_400_000) return null;
    why.push(`Deadline ${iso(thread.deadline_at).slice(0, 10)}`);
  }
  if (filter.noReplyForBusinessDays !== null) {
    if (!thread.last_message_from_owner || !thread.last_outbound_at) return null;
    const elapsed = businessDaysBetween(new Date(iso(thread.last_outbound_at)), context.now, context.timeZone, { workdays: context.workdays });
    if (elapsed < filter.noReplyForBusinessDays) return null;
    why.push(`No reply for ${elapsed} business days`);
  }
  if (filter.relationship.length) {
    if (!thread.relationship_importance || !filter.relationship.includes(thread.relationship_importance as never)) return null;
    why.push(`Relationship: ${thread.relationship_importance}`);
  }
  if (filter.engagement) {
    const opens = num(thread.engagement_opens);
    const clicks = num(thread.engagement_clicks);
    if (filter.engagement === 'opened' && opens === 0) return null;
    if (filter.engagement === 'clicked' && clicks === 0) return null;
    if (filter.engagement === 'no_engagement' && (opens > 0 || clicks > 0)) return null;
    why.push(filter.engagement === 'no_engagement' ? 'No likely recipient activity' : `Recipient likely ${filter.engagement}`);
  }
  if (filter.readByUser !== null) {
    if (filter.readByUser !== thread.sender_read) return null;
    if (filter.readByUser) why.push('You open mail from this sender');
  }
  if (filter.receivedWithinDays !== null && Date.parse(iso(thread.last_message_at ?? 0)) < context.now.getTime() - filter.receivedWithinDays * 86_400_000) return null;
  if (filter.hasAttachment !== null && filter.hasAttachment !== thread.has_attachment) return null;
  if (filter.hasAttachment) why.push('Has an attachment');
  return why;
}

export type Evaluation = { matched: boolean; why: string[]; confidence: number };

/** Full evaluation with the AI criterion when present; cached per rule and thread version. */
export async function evaluateThread(deps: IntelDeps, tx: SqlExecutor, userId: string, view: ViewRow, thread: ThreadContext, prefs: { timeZone: string; workdays: number[] }, requestId: string): Promise<Evaluation> {
  const cached = await one<{ matched: boolean; why: string[]; confidence: number; rule_version: number; thread_version: string }>(
    tx,
    `select matched, why, confidence, rule_version, thread_version from public.rule_matches where view_id = $1::uuid and thread_id = $2::uuid`,
    [view.id, thread.id],
  );
  if (cached && cached.rule_version === view.version && cached.thread_version === thread.content_version) return { matched: cached.matched, why: cached.why, confidence: cached.confidence };
  const summary = (await decryptSummary(deps.box, userId, thread))?.oneLine ?? '';
  const why = matchDeterministic(view.filter, thread, { summary, now: deps.now(), timeZone: prefs.timeZone, workdays: prefs.workdays });
  let result: Evaluation = { matched: Boolean(why), why: why ?? [], confidence: 1 };
  if (why && view.filter.aiCriteria) {
    try {
      const prompt = matchPrompt(view.filter.aiCriteria, { subject: thread.subject, summary, from: thread.sender ?? (thread.recipients ?? [])[0] ?? '' });
      // Standard, not Flex: this runs inside a database transaction, which must stay short, and a miss is not retried.
      const run = await runStructured(deps, { userId, operation: 'view_compile', system: prompt.system, user: prompt.user, schema: MatchOutputSchema, maxTokens: 120, tier: 'standard', requestId });
      result = run.value.matches
        ? { matched: true, why: [...why, `AI: ${run.value.reason || 'matches the description'} (${Math.round(run.value.confidence * 100)}%)`], confidence: run.value.confidence }
        : { matched: false, why: [], confidence: run.value.confidence };
    } catch (error) {
      if (!(error instanceof BudgetExceededError || error instanceof InferenceError)) throw error;
      return { matched: false, why: [], confidence: 0 };
    }
  }
  await tx.query(
    `insert into public.rule_matches (user_id, view_id, thread_id, rule_version, thread_version, matched, why, confidence)
     values ($1::uuid, $2::uuid, $3::uuid, $4, $5, $6, $7::text[], $8)
     on conflict (view_id, thread_id) do update set rule_version = excluded.rule_version, thread_version = excluded.thread_version, matched = excluded.matched,
       why = excluded.why, confidence = excluded.confidence, evaluated_at = now()`,
    [userId, view.id, thread.id, view.version, thread.content_version, result.matched, result.why.slice(0, 8).map((line) => line.slice(0, 200)), result.confidence],
  );
  await tx.query(`update public.smart_views set matched = (select count(*) from public.rule_matches where view_id = $1::uuid and matched), last_run_at = now() where id = $1::uuid`, [view.id]);
  return result;
}

/** Threads that get AI judgment per view run; the rest are judged on later runs. */
const AI_JUDGED_PER_RUN = 40;

type Verdict = { matches: boolean; confidence: number; reason: string };

/**
 * AI judgment for many threads against one criteria: batches of
 * MATCH_BATCH_SIZE run in parallel, so 40 threads cost two calls and one
 * call's wait instead of forty. A batch that fails (budget, provider) leaves
 * its threads without a verdict, so they are neither matched nor cached.
 */
export async function judgeThreads(
  deps: IntelDeps,
  userId: string,
  criteria: string,
  threads: Array<{ subject: string; summary: string; from: string }>,
  requestId: string,
): Promise<Array<Verdict | null>> {
  const verdicts: Array<Verdict | null> = new Array(threads.length).fill(null);
  const batches: number[][] = [];
  for (let start = 0; start < threads.length; start += MATCH_BATCH_SIZE) batches.push(threads.slice(start, start + MATCH_BATCH_SIZE).map((_, offset) => start + offset));
  await Promise.all(
    batches.map(async (indexes) => {
      const prompt = matchBatchPrompt(criteria, indexes.map((index, position) => ({ id: `T${position + 1}`, ...threads[index]! })));
      try {
        const run = await runStructured(deps, { userId, operation: 'view_compile', system: prompt.system, user: prompt.user, schema: MatchBatchOutputSchema, maxTokens: 60 * indexes.length, interactive: true, requestId });
        for (const result of run.value.results) {
          const index = indexes[Number(result.id.replace(/^T/i, '')) - 1];
          if (index !== undefined) verdicts[index] = { matches: result.matches, confidence: result.confidence, reason: result.reason };
        }
      } catch (error) {
        if (!(error instanceof BudgetExceededError || error instanceof InferenceError)) throw error;
      }
    }),
  );
  return verdicts;
}

/** A view request in plain words → a view draft: one model call, the deterministic compiler as fallback. */
export async function compileViewWithAi(deps: IntelDeps, userId: string, prompt: string, contacts: Array<{ email: string; name: string | null }>, requestId: string): Promise<CompiledView> {
  try {
    const { system, user } = viewCompilePrompt(prompt);
    const run = await runStructured(deps, { userId, operation: 'view_compile', system, user, schema: ViewCompileOutputSchema, maxTokens: 700, interactive: true, requestId });
    return viewFromAi(prompt, run.value, contacts);
  } catch (error) {
    if (error instanceof BudgetExceededError || error instanceof InferenceError) return compileView(prompt, contacts);
    throw error;
  }
}

/**
 * Matching threads for a view, newest first. Cached matches are read in one
 * query, exact criteria are evaluated locally, threads that need AI judgment
 * are judged in batches outside any transaction, and every new result is
 * written back in one statement.
 */
export async function viewResults(deps: IntelDeps, userId: string, id: string, limit: number) {
  const { view, prefs, threads, cached } = await deps.db.asUser(userId, async (tx) => {
    const view = await viewRow(tx, id);
    const prefs = await loadPreferences(tx, userId);
    const threads = await tx.query<ThreadContext>(`${THREAD_CONTEXT} where t.last_message_at > $1::timestamptz order by t.last_message_at desc limit 300`, [
      new Date(deps.now().getTime() - EVALUATION_WINDOW_DAYS * 86_400_000),
    ]);
    const cached = await tx.query<{ thread_id: string; matched: boolean; why: string[]; confidence: number; rule_version: number; thread_version: string }>(
      `select thread_id, matched, why, confidence, rule_version, thread_version from public.rule_matches where view_id = $1::uuid`,
      [id],
    );
    return { view, prefs, threads, cached };
  });
  const known = new Map(cached.filter((row) => row.rule_version === view.version).map((row) => [row.thread_id, row]));
  const results = new Map<string, Evaluation>();
  const fresh: Array<{ thread: ThreadContext; result: Evaluation }> = [];
  const pending: Array<{ thread: ThreadContext; why: string[]; summary: string }> = [];
  let matched = 0;
  let deferred = false;
  for (const thread of threads) {
    if (matched >= limit) break;
    const hit = known.get(thread.id);
    if (hit && hit.thread_version === thread.content_version) {
      results.set(thread.id, { matched: hit.matched, why: hit.why, confidence: num(hit.confidence) });
      if (hit.matched) matched += 1;
      continue;
    }
    const summary = (await decryptSummary(deps.box, userId, thread))?.oneLine ?? '';
    const why = matchDeterministic(view.filter, thread, { summary, now: deps.now(), timeZone: prefs.timeZone, workdays: prefs.workdays });
    if (why && view.filter.aiCriteria) {
      if (pending.length < AI_JUDGED_PER_RUN) pending.push({ thread, why, summary });
      else deferred = true;
      continue;
    }
    const result = { matched: Boolean(why), why: why ?? [], confidence: 1 };
    results.set(thread.id, result);
    fresh.push({ thread, result });
    if (result.matched) matched += 1;
  }

  if (pending.length && view.filter.aiCriteria) {
    const verdicts = await judgeThreads(
      deps,
      userId,
      view.filter.aiCriteria,
      pending.map(({ thread, summary }) => ({ subject: thread.subject, summary, from: thread.sender ?? (thread.recipients ?? [])[0] ?? '' })),
      `view_${view.id}`,
    );
    pending.forEach(({ thread, why }, index) => {
      const verdict = verdicts[index];
      if (!verdict) {
        deferred = true;
        return;
      }
      const result = verdict.matches
        ? { matched: true, why: [...why, `AI: ${verdict.reason || 'matches the description'} (${Math.round(verdict.confidence * 100)}%)`], confidence: verdict.confidence }
        : { matched: false, why: [], confidence: verdict.confidence };
      results.set(thread.id, result);
      fresh.push({ thread, result });
    });
  }

  const items = threads
    .filter((thread) => results.get(thread.id)?.matched)
    .slice(0, limit)
    .map((thread) => {
      const result = results.get(thread.id)!;
      return {
        threadId: thread.gmail_thread_id,
        accountId: thread.mail_account_id,
        subject: (thread.subject || '(no subject)').slice(0, 998),
        who: (thread.last_message_from_owner ? (thread.recipients ?? [])[0] : thread.sender_name || thread.sender) ?? '',
        lastMessageAt: iso(thread.last_message_at ?? deps.now()),
        why: result.why.slice(0, 8),
        confidence: result.confidence,
      };
    });
  await deps.db.asUser(userId, async (tx) => {
    if (fresh.length) {
      const rows = fresh.map(({ thread, result }) => ({
        thread_id: thread.id,
        thread_version: thread.content_version,
        matched: result.matched,
        why: result.why.slice(0, 8).map((line) => line.slice(0, 200)),
        confidence: result.confidence,
      }));
      await tx.query(
        `insert into public.rule_matches (user_id, view_id, thread_id, rule_version, thread_version, matched, why, confidence)
         select $1::uuid, $2::uuid, r.thread_id, $3, r.thread_version, r.matched, r.why, r.confidence
           from jsonb_to_recordset($4::jsonb) as r(thread_id uuid, thread_version text, matched boolean, why text[], confidence real)
         on conflict (view_id, thread_id) do update set rule_version = excluded.rule_version, thread_version = excluded.thread_version, matched = excluded.matched,
           why = excluded.why, confidence = excluded.confidence, evaluated_at = now()`,
        [userId, view.id, view.version, JSON.stringify(rows)],
      );
    }
    await tx.query(`update public.smart_views set matched = $2, last_run_at = now() where id = $1::uuid`, [view.id, items.length]);
  });
  return {
    items,
    evaluatedAt: deps.now().toISOString(),
    note: deferred ? 'Some threads were not checked yet because this view uses AI judgment; more appear as they are evaluated.' : `Checked mail from the last ${EVALUATION_WINDOW_DAYS} days.`,
  };
}

// ---------------------------------------------------------------------------
// Shadow Mode and activation
// ---------------------------------------------------------------------------

export async function shadowState(tx: SqlExecutor, id: string) {
  const view = await viewRow(tx, id);
  const rows = await tx.query<{ id: string; thread_id: string; gmail_thread_id: string; subject: string; who: string | null; actions: ActionSpec[]; why: string[]; confidence: number; verdict: 'pending' | 'correct' | 'incorrect'; created_at: unknown }>(
    `select d.id, d.thread_id, t.gmail_thread_id, t.subject, d.actions, d.why, d.confidence, d.verdict, d.created_at,
            (select coalesce(nullif(m.from_name, ''), m.from_email) from public.message_metadata m where m.thread_id = t.id order by m.internal_date desc limit 1) as who
       from public.shadow_decisions d join public.threads t on t.id = d.thread_id
      where d.view_id = $1::uuid order by d.verdict = 'pending' desc, d.created_at desc limit 100`,
    [id],
  );
  const smart = toSmartView(view);
  return {
    decisions: rows.map((row) => ({
      id: row.id,
      viewId: id,
      threadId: row.gmail_thread_id,
      subject: (row.subject || '(no subject)').slice(0, 998),
      who: (row.who ?? '').slice(0, 320),
      actions: row.actions,
      why: row.why.slice(0, 8),
      confidence: num(row.confidence),
      verdict: row.verdict,
      createdAt: iso(row.created_at),
    })),
    stats: smart.stats,
    activation: smart.activation,
  };
}

/**
 * Confirm or correct a shadow decision. A correction is also a personal rule
 * change: the sender is excluded from this view in a new version, so the same
 * mistake is not repeated.
 */
export async function reviewShadow(tx: SqlExecutor, userId: string, decisionId: string, verdict: 'correct' | 'incorrect') {
  const decision = await one<{ id: string; view_id: string; thread_id: string; verdict: string }>(tx, `select id, view_id, thread_id, verdict from public.shadow_decisions where id = $1::uuid`, [decisionId]);
  if (!decision) throw new ApiError('not_found', 'That example does not exist.');
  if (decision.verdict !== verdict) {
    await tx.query(`update public.shadow_decisions set verdict = $2, reviewed_at = now() where id = $1::uuid`, [decisionId, verdict]);
    const delta = (value: string) => (decision.verdict === value ? -1 : 0) + (verdict === value ? 1 : 0);
    await tx.query(`update public.smart_views set confirmed = greatest(0, confirmed + $2), corrected = greatest(0, corrected + $3) where id = $1::uuid`, [decision.view_id, delta('correct'), delta('incorrect')]);
    if (verdict === 'incorrect') {
      const sender = await one<{ email: string | null }>(
        tx,
        `select lower(from_email) as email from public.message_metadata where thread_id = $1::uuid and direction = 'inbound' order by internal_date desc limit 1`,
        [decision.thread_id],
      );
      const view = await viewRow(tx, decision.view_id);
      if (sender?.email && !view.filter.from.exclude.includes(sender.email)) {
        const filter = { ...view.filter, from: { ...view.filter.from, exclude: [...view.filter.from.exclude, sender.email].slice(0, 100) } };
        await tx.query(`update public.smart_views set filter = $2::jsonb, explanation = $3::text[], version = version + 1, updated_at = now() where id = $1::uuid`, [
          view.id,
          filter,
          explainFilter(filter),
        ]);
        const updated = await viewRow(tx, view.id);
        await tx.query(
          `insert into public.rule_versions (view_id, user_id, version, name, prompt, filter, actions, mode, enabled, changed_by) values ($1::uuid, $2::uuid, $3, $4, $5, $6::jsonb, $7::jsonb, $8, $9, 'Your correction')`,
          [updated.id, userId, updated.version, updated.name, updated.prompt, updated.filter, JSON.stringify(updated.actions), updated.mode, updated.enabled],
        );
      }
    }
  }
  return shadowState(tx, decision.view_id);
}

export async function activateView(tx: SqlExecutor, userId: string, id: string): Promise<SmartView> {
  const view = await viewRow(tx, id);
  const activation = activationFor(view);
  if (!activation.eligible) throw new ApiError('conflict', activation.reason);
  const row = (await one<ViewRow>(tx, `update public.smart_views set mode = 'active', version = version + 1, updated_at = now() where id = $1::uuid returning *`, [id]))!;
  await tx.query(
    `insert into public.rule_versions (view_id, user_id, version, name, prompt, filter, actions, mode, enabled, changed_by) values ($1::uuid, $2::uuid, $3, $4, $5, $6::jsonb, $7::jsonb, 'active', $8, 'You (activated)')`,
    [row.id, userId, row.version, row.name, row.prompt, row.filter, JSON.stringify(row.actions), row.enabled],
  );
  await recordAudit(tx, {
    userId,
    actor: { type: 'user', id: userId, name: 'You' },
    action: 'activate_view',
    tier: 0,
    target: { kind: 'smart_view', id, title: row.name },
    summary: `Activated "${row.name}": ${row.actions.map((action) => ACTION_LABELS[action.kind]).join(', ')}`,
    policy: { decision: 'allowed', reason: activation.reason },
  });
  return toSmartView(row);
}

/**
 * `rules.evaluate` job: after a thread is analyzed, run every enabled rule
 * with actions against it. Shadow rules record; active rules act through the
 * policy engine.
 */
export async function runRulesEvaluate(deps: IntelDeps, job: JobRecord): Promise<void> {
  const threadRowId = String(job.payload.threadId ?? '');
  if (!job.userId || !threadRowId) throw new SkipJob('missing_ids');
  const userId = job.userId;
  const { views, thread, prefs } = await deps.db.asUser(userId, async (tx) => ({
    views: await tx.query<ViewRow>(`select * from public.smart_views where enabled and jsonb_array_length(actions) > 0 order by priority desc`),
    thread: await one<ThreadContext>(tx, `${THREAD_CONTEXT} where t.id = $1::uuid`, [threadRowId]),
    prefs: await loadPreferences(tx, userId),
  }));
  if (!thread || !views.length) return;
  for (const view of views) {
    const evaluation = await deps.db.asUser(userId, (tx) => evaluateThread(deps, tx, userId, view, thread, prefs, `job_${job.id}`));
    if (!evaluation.matched) continue;
    if (view.mode === 'shadow') {
      await deps.db.asUser(userId, async (tx) => {
        const inserted = await one<{ id: string }>(
          tx,
          `insert into public.shadow_decisions (user_id, view_id, thread_id, rule_version, thread_version, actions, why, confidence)
           values ($1::uuid, $2::uuid, $3::uuid, $4, $5, $6::jsonb, $7::text[], $8) on conflict (view_id, thread_id, rule_version) do nothing returning id`,
          [userId, view.id, thread.id, view.version, thread.content_version, JSON.stringify(view.actions), evaluation.why.slice(0, 8), evaluation.confidence],
        );
        if (inserted) await tx.query(`update public.smart_views set shadow_decisions = shadow_decisions + 1, last_run_at = now() where id = $1::uuid`, [view.id]);
      });
      continue;
    }
    if (view.mode !== 'active') continue;
    for (const [index, spec] of view.actions.entries()) {
      const target = { accountId: thread.mail_account_id, threadRowId: thread.id, gmailThreadId: thread.gmail_thread_id, title: thread.subject };
      const key = `rule:${view.id}:v${view.version}:${thread.id}:${thread.content_version}:${index}`;
      const outcome = await performAction(deps, userId, { spec, target, actor: { type: 'rule', id: view.id, name: view.name, mode: 'active', autonomy: 'auto_reversible' }, userInitiated: false, idempotencyKey: key });
      await deps.db.asUser(userId, async (tx) => {
        if (outcome.decision === 'approval_required') {
          await createApproval(tx, deps.box, {
            userId,
            kind: spec.kind,
            tier: outcome.tier,
            title: `${ACTION_LABELS[spec.kind]}: ${thread.subject || '(no subject)'}`,
            why: `Rule "${view.name}" matched: ${evaluation.why.join('; ')}`.slice(0, 500),
            sources: [{ id: `thread:${thread.gmail_thread_id}`, kind: 'thread', title: thread.subject || '(no subject)', gmailThreadId: thread.gmail_thread_id, accountId: thread.mail_account_id }],
            action: spec,
            target,
            preview: { change: `${ACTION_LABELS[spec.kind]} on "${thread.subject || '(no subject)'}"` },
            responsible: { type: 'rule', id: view.id, name: view.name },
            idempotencyKey: key,
          });
        } else if (outcome.decision === 'allowed' && !outcome.errorCode) {
          await tx.query(`update public.smart_views set applied = applied + 1, last_run_at = now() where id = $1::uuid`, [view.id]);
        }
      });
    }
  }
}
