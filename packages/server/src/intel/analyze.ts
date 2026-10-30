import { reconcileCommitments } from './commitment-reconciliation.js';
import { memoryState } from './memory/store.js';
import type { Preferences } from '@pigeonbox/api-contract';
import { ownerPerspectiveKey, summaryPerspectiveIssue, createOwnerMatcher, categoryForThreadState, deriveThreadState, type RelationshipImportance, type ThreadState } from '@pigeonbox/shared';
import { InferenceError, isTransientInferenceError } from '../ai/backends.js';
import { iso, one, type SqlExecutor } from '../db/sql.js';
import { enqueue, type JobRecord } from '../jobs/queue.js';
import { SkipJob } from '../jobs/runner.js';
import { BudgetExceededError, runStructured } from './ai.js';
import { openCommitmentCount, upsertCommitments } from './commitments.js';
import type { IntelDeps } from './context.js';
import { trackOutbound } from './followups.js';
import { gmailFor, jobErrorFrom, loadAccount } from './google-access.js';
import { analyzeHeuristically, detectInjection, type AnalysisThread, type ThreadAnalysis } from './heuristics.js';
import { loadPreferences } from './preferences.js';
import { analysisPrompt, AnalysisOutputSchema, type AnalysisInput } from './prompts.js';
import { boundThread, fingerprintInput, readThread, type ReadThread } from './thread-reader.js';
import { learnedStateFor, saveThreadState } from './threads.js';
import { learnFromSent } from './writing.js';
import { AUTO_DRAFT_WINDOW_MS, autoDraftDecision, type AutoDraftDecision } from './draft-policy.js';
import { featureEnabled } from '../rollout.js';
import { triggerAutomations } from './automations.js';

/**
 * Thread analysis job: turns a changed thread into ThreadState, commitments,
 * follow-up state and (when needed) a queued draft.
 *
 * - Bulk mail is classified from metadata alone; its body is never fetched.
 * - Otherwise the thread is read just in time, and the exact model input is
 *   fingerprinted: identical input is never classified twice.
 * - When the model is unavailable or the budget is spent, deterministic rules
 *   classify instead and the state says so (`source: heuristic`).
 */

export type AnalyzeCapabilities = { autoDrafts: boolean; automations: boolean; search: boolean; relationships: boolean };

type ThreadRow = {
  id: string;
  mail_account_id: string;
  gmail_thread_id: string;
  subject: string;
  label_ids: string[];
  content_version: string;
  is_bulk: boolean;
  last_message_from_owner: boolean;
  last_message_id: string | null;
  last_message_at: unknown;
  state_version: string | null;
  input_fingerprint: string | null;
  user_state: ThreadState | null;
};

export async function relationshipImportance(tx: SqlExecutor, email: string | null): Promise<RelationshipImportance> {
  if (!email) return 'unknown';
  const contact = await one<{ vip: boolean }>(tx, `select vip from public.contacts where email_normalized = lower($1)`, [email]);
  if (contact?.vip) return 'vip';
  const row = await one<{ sent: number; received: number }>(
    tx,
    `select count(*) filter (where direction = 'outbound' and lower($1) = any (to_emails || cc_emails))::int as sent,
            count(*) filter (where direction = 'inbound' and lower(from_email) = lower($1))::int as received
       from public.message_metadata where lower(from_email) = lower($1) or lower($1) = any (to_emails || cc_emails)`,
    [email],
  );
  const sent = row?.sent ?? 0;
  if (sent >= 5) return 'close';
  if (sent >= 1) return 'known';
  return (row?.received ?? 0) <= 1 ? 'new' : 'unknown';
}

function metadataThread(thread: ThreadRow, messages: Array<{ from_email: string | null; from_name: string | null; to_emails: string[]; cc_emails: string[]; internal_date: unknown; direction: 'inbound' | 'outbound'; is_auto: boolean; list_unsubscribe: boolean }>, owner: string, timeZone: string): AnalysisThread {
  return {
    subject: thread.subject,
    labels: thread.label_ids,
    ownerEmails: [owner],
    timeZone,
    messages: messages.map((message) => ({
      from: message.from_email ?? '',
      fromName: message.from_name,
      to: message.to_emails,
      cc: message.cc_emails,
      date: iso(message.internal_date),
      text: '',
      direction: message.direction,
      isAuto: message.is_auto,
      listUnsubscribe: message.list_unsubscribe,
    })),
  };
}

function toAnalysisInput(read: ReadThread, owner: string, prefs: Preferences, now: Date): AnalysisInput {
  const isOwner = createOwnerMatcher({ owner: { email: owner } });
  return {
    perspectiveVersion: 1,
    defaultMeetingMinutes: prefs.calendar.defaultDurationMinutes,
    now: now.toISOString(),
    timeZone: prefs.timeZone,
    ownerEmails: [...new Set([owner, ...read.messages.filter((message) => message.direction === 'outbound').map((message) => message.from)])],
    subject: read.subject,
    labels: read.labels,
    messages: boundThread(read.messages).map((message) => ({
      gmailMessageId: message.gmailMessageId,
      from: message.from,
      fromName: message.fromName,
      authorRole: message.direction === 'outbound' || isOwner(message.from) ? 'owner' : 'other',
      to: message.to,
      cc: message.cc,
      date: message.date,
      direction: message.direction,
      isAuto: message.isAuto,
      listUnsubscribe: message.listUnsubscribe,
      text: message.text,
      attachments: message.attachments,
    })),
  };
}

export async function runThreadAnalyze(deps: IntelDeps, job: JobRecord, caps: AnalyzeCapabilities): Promise<void> {
  const threadRowId = String(job.payload.threadId ?? '');
  if (!job.userId || !threadRowId) throw new SkipJob('missing_ids');
  const userId = job.userId;
  const force = Boolean(job.payload.force);

  const loaded = await deps.db.asUser(userId, async (tx) => {
    const thread = await one<ThreadRow>(
      tx,
      `select t.id, t.mail_account_id, t.gmail_thread_id, t.subject, t.label_ids, t.content_version, t.is_bulk, t.last_message_from_owner, t.last_message_id, t.last_message_at,
              s.analyzed_version as state_version, s.input_fingerprint, s.user_state
         from public.threads t left join public.thread_states s on s.thread_id = t.id where t.id = $1::uuid`,
      [threadRowId],
    );
    if (!thread) return null;
    const account = await loadAccount(tx, thread.mail_account_id);
    const prefs = await loadPreferences(tx, userId);
    const messages = await tx.query<{ from_email: string | null; from_name: string | null; to_emails: string[]; cc_emails: string[]; internal_date: unknown; direction: 'inbound' | 'outbound'; is_auto: boolean; list_unsubscribe: boolean; gmail_message_id: string }>(
      `select from_email, from_name, to_emails, cc_emails, internal_date, direction, is_auto, list_unsubscribe, gmail_message_id
         from public.message_metadata where thread_id = $1::uuid order by internal_date`,
      [threadRowId],
    );
    return { thread, account, prefs, messages };
  });
  if (!loaded) throw new SkipJob('thread_gone');
  const { thread, account, prefs, messages } = loaded;
  if (!account || account.status !== 'active' || !account.features.includes('mail_read')) throw new SkipJob('account_inactive');
  const perspective = `owner-v1:${await fingerprintInput(ownerPerspectiveKey({ email: account.email, name: account.display_name || undefined }))}:`;
  if (!force && thread.state_version === thread.content_version && thread.input_fingerprint?.startsWith(perspective)) {
    // A reconciliation retry must still run after classification was committed.
    if (job.attempts > 1 && !thread.is_bulk) {
      const read = await readThread(gmailFor(deps, account), thread.gmail_thread_id, [account.email]);
      if (!detectInjection(read.messages.map((message) => message.text).join('\n'))) await reconcileCommitments(deps, { userId, accountId: account.id, threadRowId, version: thread.content_version, read, requestId: `job_${job.id}`, search: caps.search, retry: job.attempts < job.maxAttempts });
    }
    throw new SkipJob('up_to_date');
  }

  const lastInbound = [...messages].reverse().find((message) => message.direction === 'inbound') ?? null;
  const lastOutbound = [...messages].reverse().find((message) => message.direction === 'outbound') ?? null;
  const bulkInbound = thread.is_bulk && !thread.last_message_from_owner;

  let analysis: ThreadAnalysis;
  let source: 'model' | 'heuristic' = 'heuristic';
  let model: string | null = null;
  let fingerprint: string | null = null;
  let read: ReadThread | null = null;

  try {
    if (bulkInbound) {
      analysis = analyzeHeuristically(metadataThread(thread, messages, account.email, prefs.timeZone), deps.now());
    } else {
      read = await readThread(gmailFor(deps, account), thread.gmail_thread_id, [account.email]);
      const input = toAnalysisInput(read, account.email, prefs, deps.now());
      fingerprint = perspective + await fingerprintInput({ ...input, now: null });
      if (!force && fingerprint === thread.input_fingerprint) {
        await deps.db.asUser(userId, async (tx) => {
          const current = await one<{ content_version: string; input_fingerprint: string | null }>(tx,
            `select t.content_version, s.input_fingerprint from public.threads t left join public.thread_states s on s.thread_id = t.id where t.id = $1::uuid for update of t`, [threadRowId]);
          if (!current || current.content_version !== thread.content_version || current.input_fingerprint !== thread.input_fingerprint) throw new SkipJob('stale_analysis');
          await tx.query(`update public.thread_states set analyzed_version = $2, updated_at = now() where thread_id = $1::uuid`, [threadRowId, thread.content_version]);
          await tx.query(`update public.threads set analyzed_version = $2 where id = $1::uuid`, [threadRowId, thread.content_version]);
        });
        return;
      }
      try {
        const prompt = analysisPrompt(input);
        const run = await runStructured(deps, { userId, operation: 'thread_analysis', system: prompt.system, user: prompt.user, schema: AnalysisOutputSchema, maxTokens: 900, requestId: `job_${job.id}` });
        analysis = run.value;
        const ownerInput = { owner: { email: account.email, name: account.display_name || undefined, aliases: input.ownerEmails }, messages: input.messages.map((message) => ({ sender: message.fromName ? `${message.fromName} <${message.from}>` : message.from, authorRole: message.authorRole, bodyText: message.text })) };
        if (summaryPerspectiveIssue(analysis.summary, ownerInput)) {
          const repair = await runStructured(deps, { userId, operation: 'thread_analysis', system: prompt.system + '\nUse the explicit authorRole. Owner-authored actions must say you; return the full corrected JSON.', user: prompt.user, schema: AnalysisOutputSchema, maxTokens: 900, requestId: `job_${job.id}_perspective` });
          analysis = repair.value;
          model = repair.model;
        } else model = run.model;
        if (summaryPerspectiveIssue(analysis.summary, ownerInput)) {
          analysis = analyzeHeuristically({ subject: input.subject, labels: input.labels, ownerEmails: input.ownerEmails, timeZone: input.timeZone, messages: input.messages }, deps.now());
          if (summaryPerspectiveIssue(analysis.summary, ownerInput)) analysis.summary = { oneLine: 'Your conversation is ready to review.', keyPoints: [] };
          model = null;
        } else source = 'model';
      } catch (error) {
        if (!(error instanceof BudgetExceededError || error instanceof InferenceError)) throw error;
        // A capacity problem (a Flex 429, a timeout) retries with backoff while attempts remain;
        // the last attempt falls back to the rules below, so no thread waits forever.
        if (isTransientInferenceError(error) && job.attempts < job.maxAttempts) throw error;
        analysis = analyzeHeuristically({ subject: input.subject, labels: input.labels, ownerEmails: input.ownerEmails, timeZone: input.timeZone, messages: input.messages }, deps.now());
      }
      // The deterministic detector always runs too: a model can miss an injection attempt.
      analysis.suspiciousInstructions = analysis.suspiciousInstructions || detectInjection(`${input.subject}\n${input.messages.map((message) => message.text).join('\n')}`);
    }
  } catch (error) {
    throw jobErrorFrom(error);
  }

  const perspectiveMessages = read?.messages.map((message) => ({ sender: message.fromName ? `${message.fromName} <${message.from}>` : message.from, authorRole: message.direction === 'outbound' ? 'owner' as const : 'other' as const, bodyText: message.text })) || messages.map((message) => ({ sender: message.from_name ? `${message.from_name} <${message.from_email}>` : message.from_email || '', authorRole: message.direction === 'outbound' ? 'owner' as const : 'other' as const }));
  if (summaryPerspectiveIssue(analysis.summary, { owner: { email: account.email, name: account.display_name || undefined, aliases: (read?.messages.filter((message) => message.direction === 'outbound').map((message) => message.from) || messages.filter((message) => message.direction === 'outbound').map((message) => message.from_email || '')).filter(Boolean) }, messages: perspectiveMessages })) analysis.summary = { oneLine: 'Your conversation is ready to review.', keyPoints: [] };

  await deps.db.asUser(userId, async (tx) => {
    const current = await one<{ content_version: string; input_fingerprint: string | null }>(tx,
      `select t.content_version, s.input_fingerprint from public.threads t left join public.thread_states s on s.thread_id = t.id where t.id = $1::uuid for update of t`, [threadRowId]);
    if (!current || current.content_version !== thread.content_version || current.input_fingerprint !== thread.input_fingerprint) throw new SkipJob('stale_analysis');
    const memory = await memoryState(deps,tx,userId,true);
    const learningPrefs = await loadPreferences(tx,userId);
    const sender = lastInbound?.from_email?.toLowerCase() ?? null;
    const learned = thread.last_message_from_owner ? null : await learnedStateFor(tx, sender);
    const relationship = await relationshipImportance(tx, thread.last_message_from_owner ? lastOutbound?.to_emails[0] ?? null : sender);

    const lastRead = read?.messages[read.messages.length - 1];
    await upsertCommitments(tx, deps.box, {
      userId,
      accountId: account.id,
      threadRowId,
      ownerEmail: account.email,
      commitments: analysis.suspiciousInstructions ? [] : analysis.commitments,
      messages: read?.messages,
      sourceMessageId: lastRead?.gmailMessageId ?? thread.last_message_id,
    });
    const openMine = await openCommitmentCount(tx, threadRowId, 'mine');

    // Follow-up engine: the user wrote last.
    let followUpDueAt: string | null = null;
    if (thread.last_message_from_owner && lastOutbound) {
      await trackOutbound(tx, {
        userId,
        accountId: account.id,
        threadRowId,
        prefs,
        replyExpected: analysis.replyExpectedFrom === 'them',
        expectedFrom: lastOutbound.to_emails.filter((email) => email !== account.email.toLowerCase()),
        reason: analysis.replyExpectedFrom === 'them' ? analysis.importanceReason || 'You asked something and are waiting for an answer' : 'No reply needed',
        lastOutboundAt: new Date(iso(lastOutbound.internal_date)),
        lastOutboundMessageId: lastOutbound.gmail_message_id,
        deadline: analysis.deadline && analysis.deadline.explicit ? new Date(analysis.deadline.at) : null,
      });
      const follow = await one<{ due_at: unknown; stage: string }>(tx, `select due_at, stage from public.follow_ups where thread_id = $1::uuid`, [threadRowId]);
      followUpDueAt = follow?.stage === 'follow_up_due' ? iso(follow.due_at ?? deps.now()) : follow?.due_at ? iso(follow.due_at) : null;
    }

    let derived = deriveThreadState({
      category: analysis.category,
      needsReply: analysis.needsReply,
      waitingOnReply: analysis.replyExpectedFrom === 'them',
      lastMessageFromOwner: thread.last_message_from_owner,
      openCommitmentsByOwner: openMine,
      followUpDueAt,
      now: deps.now(),
    });
    let stateSource: 'model' | 'heuristic' | 'rule' = source;
    let reason = analysis.importanceReason;
    if (learned && !thread.last_message_from_owner) {
      derived = learned.state;
      stateSource = 'rule';
      reason = learned.reason;
    }

    await saveThreadState(tx, deps.box, {
      threadRowId,
      userId,
      accountId: account.id,
      state: derived,
      category: learned ? categoryForThreadState(derived) : analysis.category,
      priority: relationship === 'vip' && analysis.priority === 'NORMAL' ? 'HIGH' : analysis.priority,
      urgency: analysis.urgency,
      confidence: learned ? 0.9 : analysis.confidence,
      needsReply: derived === 'NEEDS_REPLY',
      replyExpectedFrom: analysis.replyExpectedFrom,
      deadline: analysis.deadline,
      importanceReason: reason,
      relationshipImportance: relationship,
      nextAction: analysis.nextAction,
      source: stateSource,
      injectionSuspected: analysis.suspiciousInstructions,
      meeting: analysis.meeting,
      summary: analysis.summary.oneLine ? analysis.summary : null,
      analyzedVersion: thread.content_version,
      inputFingerprint: fingerprint,
      model,
    });

    // Learn the user's writing structure from what they just sent (read here, not stored).
    if (learningPrefs.memory.enabled && learningPrefs.memory.learnFromSentMail && job.payload.newOutbound && read && lastRead?.direction === 'outbound') {
      await learnFromSent(tx, userId, {
        text: lastRead.text,
        to: lastRead.to,
        emailType: read.messages.length === 1 ? 'new' : analysis.meeting.isScheduling ? 'scheduling' : 'reply',
      });
    }

    const kind = analysis.meeting.isScheduling ? 'scheduling' : 'reply';
    if (caps.autoDrafts && prefs.autoDrafts.enabled && derived === 'NEEDS_REPLY' && prefs.autoDrafts.kinds.includes(kind) && thread.user_state !== 'DONE') {
      // Whether a prepared draft is worth it at all; the person can still ask for one.
      const draftDecision = await autoDraftFor(tx, deps, userId, analysis, lastInbound, read, account.email);
      deps.log('info', 'auto draft decision', { requestId: `job_${job.id}`, userId, operation: 'auto_draft', decision: draftDecision.prepare ? 'prepare' : 'skip', code: draftDecision.reason });
      if (draftDecision.prepare) await enqueue(tx, {
        kind: 'draft.prepare',
        userId,
        accountId: account.id,
        key: `draft:${threadRowId}:${thread.content_version}`,
        payload: { threadId: threadRowId, kind, origin: 'auto' },
        maxAttempts: 4,
      });
    }
    if (caps.automations) {
      const previous = await one<{ state: string }>(tx, `select state from public.classifications where thread_id = $1::uuid and source <> 'user' order by created_at desc offset 1 limit 1`, [threadRowId]);
      const reply = !thread.last_message_from_owner && Boolean(lastOutbound) && Boolean(job.payload.newInbound);
      const kinds: Array<'email_received' | 'email_sent' | 'reply_received' | 'state_changed'> = [];
      if (thread.last_message_from_owner) kinds.push('email_sent');
      else kinds.push('email_received');
      if (reply) kinds.push('reply_received');
      if (previous && previous.state !== derived) kinds.push('state_changed');
      await triggerAutomations(tx, { userId, accountId: account.id, threadRowId, version: thread.content_version, kinds });
      await enqueue(tx, { kind: 'rules.evaluate', userId, accountId: account.id, key: `rules:${threadRowId}:${thread.content_version}`, payload: { threadId: threadRowId }, maxAttempts: 4 });
    }
    if (learningPrefs.memory.enabled && !bulkInbound && !analysis.suspiciousInstructions) {
      await enqueue(tx,{ kind: 'memory.extract',userId,accountId: account.id,
        key: `memory:${threadRowId}:${thread.content_version}:${memory.generation}`,
        payload: { threadId: threadRowId,version: thread.content_version,generation: memory.generation },maxAttempts: 4 });
    }
    if (caps.search) {
      await enqueue(tx, { kind: 'search.index', userId, accountId: account.id, key: `index:${threadRowId}:${thread.content_version}`, payload: { threadId: threadRowId }, maxAttempts: 4 });
    }
  });
  if (read && !analysis.suspiciousInstructions) await reconcileCommitments(deps, { userId, accountId: account.id, threadRowId, version: thread.content_version, read, requestId: `job_${job.id}`, search: caps.search, retry: job.attempts < job.maxAttempts });
  deps.log('info', 'thread analyzed', { userId, accountId: account.id, jobId: job.id, decision: source });
}

/** Rollout, then policy, then the window budget, in that order. Content is read here and never logged. */
async function autoDraftFor(
  tx: SqlExecutor,
  deps: IntelDeps,
  userId: string,
  analysis: ThreadAnalysis,
  lastInbound: { from_email: string | null; to_emails: string[]; cc_emails: string[] } | null,
  read: ReadThread | null,
  ownerEmail: string,
): Promise<AutoDraftDecision | { prepare: false; reason: 'rollout_off' }> {
  if (!featureEnabled(deps.config.rollout, 'auto_drafts', userId)) return { prepare: false, reason: 'rollout_off' };
  const owner = ownerEmail.toLowerCase();
  const people = new Set([lastInbound?.from_email ?? '', ...(lastInbound?.to_emails ?? []), ...(lastInbound?.cc_emails ?? [])].map((email) => email.toLowerCase()).filter((email) => email && email !== owner));
  const latest = read ? [...read.messages].reverse().find((message) => message.direction === 'inbound') ?? null : null;
  const recent = await one<{ n: number }>(tx, `select count(*)::int as n from public.drafts where origin = 'auto' and created_at > $1::timestamptz`, [new Date(deps.now().getTime() - AUTO_DRAFT_WINDOW_MS)]);
  return autoDraftDecision({
    scheduling: analysis.meeting.isScheduling,
    confidence: analysis.confidence,
    suspiciousInstructions: analysis.suspiciousInstructions,
    nextAction: analysis.nextAction.kind,
    participants: people.size,
    latestInbound: latest ? `${latest.subject}\n${latest.text}` : null,
    recentAutoDrafts: recent?.n ?? 0,
  });
}
