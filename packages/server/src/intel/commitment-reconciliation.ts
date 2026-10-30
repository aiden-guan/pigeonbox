import { z } from 'zod';
import { iso, one } from '../db/sql.js';
import { BudgetExceededError, runStructured } from './ai.js';
import { InferenceError, isTransientInferenceError } from '../ai/backends.js';
import type { IntelDeps } from './context.js';
import { COMMITMENT_COLUMNS, toCommitment, type CommitmentRow } from './commitments.js';
import { dataBlock, UNTRUSTED_DATA_RULES } from './prompts.js';
import { detectInjection } from './heuristics.js';
import { boundThread, type ReadMessage, type ReadThread } from './thread-reader.js';
import { relationshipEvent } from './relationships.js';
import { enqueue } from '../jobs/queue.js';

export const ReconciliationSchema = z.object({ resolutions: z.array(z.object({
  ref: z.string().max(12), message: z.string().max(12),
  status: z.enum(['done', 'cancelled']), confidence: z.number().min(0).max(1),
  evidence: z.string().min(3).max(400),
})).max(20) });
type Candidate = CommitmentRow & { source_message_id: string | null; promised_at: unknown };

export function eligibleResolution(candidate: Pick<Candidate, 'direction' | 'counterparty' | 'promised_at' | 'source_message_id'>, message: ReadMessage): boolean {
  const party = candidate.counterparty?.toLowerCase();
  if (!party || message.gmailMessageId === candidate.source_message_id || Date.parse(message.date) <= Date.parse(iso(candidate.promised_at)) || message.isAuto || message.listUnsubscribe || detectInjection(message.text)) return false;
  return candidate.direction === 'mine'
    ? message.direction === 'outbound' && [...message.to, ...message.cc].some((email) => email.toLowerCase() === party)
    : message.direction === 'inbound' && message.from.toLowerCase() === party;
}

/** Compare open promises with later real mail, including another thread with
 * the same correspondent. Bodies/filenames are ephemeral; only the state and
 * an account-scoped reference to the evidence email are persisted. */
export async function reconcileCommitments(deps: IntelDeps, input: { userId: string; accountId: string; threadRowId: string; version: string; read: ReadThread; requestId: string; search: boolean; retry: boolean }): Promise<void> {
  const messages = boundThread(input.read.messages);
  const parties = [...new Set(messages.flatMap((message) => message.direction === 'outbound' ? [...message.to, ...message.cc] : [message.from]).map((email) => email.toLowerCase()))];
  if (!parties.length) return;
  const rows = await deps.db.asUser(input.userId, (tx) => tx.query<Candidate>(
    `select ${COMMITMENT_COLUMNS}, c.source_message_id, coalesce(origin.internal_date, c.created_at) as promised_at
     from public.commitments c join public.threads t on t.id = c.thread_id
     left join public.message_metadata origin on origin.mail_account_id = c.mail_account_id and origin.gmail_message_id = c.source_message_id
     where c.status = 'open' and c.mail_account_id = $1::uuid and lower(c.counterparty) = any($2::text[])
     order by c.due_at nulls last, c.created_at desc limit 30`, [input.accountId, parties],
  ));
  const candidates = rows.filter((row) => messages.some((message) => eligibleResolution(row, message))).slice(0, 20);
  if (!candidates.length) return;
  const promises = await Promise.all(candidates.map(async (row, i) => ({ ref: `p${i + 1}`, ...(await toCommitment(deps.box, input.userId, row)), counterparty: row.counterparty, promisedAt: iso(row.promised_at) })));
  let resolutions: z.infer<typeof ReconciliationSchema>['resolutions'];
  try {
    const run = await runStructured(deps, {
      userId: input.userId, operation: 'thread_analysis', requestId: `${input.requestId}_commitments`, schema: ReconciliationSchema, maxTokens: 900,
      system: `You reconcile promises using later email evidence. Task: commitment_reconcile.
${UNTRUSTED_DATA_RULES}
Return {resolutions:[{ref,message,status,confidence,evidence}]} using only the p- and m-handles supplied. Leave uncertain promises out. A later reply alone does not complete a promise. Another promise, an intention, an unrelated PDF, an acknowledgement, or partial progress is not completion.
Use done only when the responsible person actually delivered the specific thing promised, to the correct person, after the promise. For documents, compare the request/topic, email wording and attachment filenames or real delivery links together. An attachment does not prove its contents; leave ambiguous matches open. Do not require the same Gmail thread. A promise to send a proposal PDF is fulfilled by a later sent message to that person with the matching proposal attached. Cancellation requires an explicit withdrawal, not silence.
evidence must be an exact short span from the later message text or one of its attachment filenames. confidence must be at least 0.9 to resolve. Never invent message IDs or recipients.`,
      user: dataBlock({ task: 'commitment_reconcile', promises, messages: messages.map((message, i) => ({ ref: `m${i + 1}`, from: message.from, to: message.to, cc: message.cc, date: message.date, direction: message.direction, subject: message.subject, text: message.text, attachments: message.attachments })) }),
    });
    resolutions = run.value.resolutions;
  } catch (error) {
    // Keep commitments open when inference cannot prove resolution. Transient
    // failures retry the analysis job; budget/final provider failures stay open.
    if (error instanceof BudgetExceededError) return;
    if (error instanceof InferenceError && (!isTransientInferenceError(error) || !input.retry)) return;
    throw error;
  }
  await deps.db.asUser(input.userId, async (tx) => {
    const current = await one(tx, `select 1 from public.threads t join public.mail_accounts a on a.id = t.mail_account_id where t.id = $1::uuid and t.content_version = $2 and a.status = 'active' and 'mail_read' = any(a.features) for update of t`, [input.threadRowId, input.version]);
    if (!current) return;
    const seen = new Set<string>();
    for (const result of resolutions) {
      const i = promises.findIndex((promise) => promise.ref === result.ref);
      const mi = /^m\d+$/.test(result.message) ? Number(result.message.slice(1)) - 1 : -1;
      const row = candidates[i]; const message = messages[mi];
      if (!row || !message || seen.has(row.id) || result.confidence < 0.9 || !eligibleResolution(row, message)) continue;
      if (!message.text.includes(result.evidence) && !message.attachments.some((name) => name.includes(result.evidence))) continue;
      // Sending a promised file requires observable delivery, never only "done".
      if (result.status === 'done' && /\b(?:pdf|file|document|slides|deck|resume|report|proposal)\b/i.test(promises[i]!.text) && !message.attachments.length && !/https:\/\/[^\s]+/i.test(message.text)) continue;
      const synced = await one(tx, `select 1 from public.message_metadata where thread_id = $1::uuid and gmail_message_id = $2 and direction = $3`, [input.threadRowId, message.gmailMessageId, message.direction]);
      if (!synced) continue;
      const changed = await tx.query<{ id: string }>(`update public.commitments set status = $2,resolved_at = $3::timestamptz,updated_at = now() where id = $1::uuid and status = 'open' returning id`, [row.id, result.status, message.date]);
      if (!changed.length) continue;
      seen.add(row.id);
      const contact = await one<{ id: string }>(tx, `select id from public.contacts where email_normalized = lower($1)`, [row.counterparty]);
      if (contact) await relationshipEvent(tx, input.userId, contact.id, 'commitment', new Date(message.date), input.threadRowId, input.read.gmailThreadId, `commitment:${row.id}`, result.status === 'done' ? 'Promise fulfilled · confirmed from later email' : 'Promise withdrawn · confirmed from later email');
      // Clearing a completed obligation immediately updates its original thread,
      // even when the delivery was sent as a new conversation.
      await tx.query(`update public.thread_states s set state = case when reply_expected_from = 'owner' then 'NEEDS_REPLY' when reply_expected_from = 'them' then 'WAITING_ON_THEM' else 'DONE' end,
        category = case when reply_expected_from = 'owner' then 'RESPOND' when reply_expected_from = 'them' then 'WAITING' else 'FYI' end,
        needs_reply = reply_expected_from = 'owner',next_action_kind = case when reply_expected_from = 'owner' then 'reply' when reply_expected_from = 'them' then 'wait' else 'none' end,
        next_action_label = case when reply_expected_from = 'owner' then 'Reply' when reply_expected_from = 'them' then 'Wait for their reply' else 'Promise completed' end,updated_at = now()
        where thread_id = $1::uuid and state = 'WAITING_ON_ME' and user_state is null
        and not exists(select 1 from public.commitments where thread_id = s.thread_id and direction = 'mine' and status = 'open')`, [row.thread_id]);
      if (input.search) {
        const origin = await one<{ content_version: string }>(tx, `select content_version from public.threads where id = $1::uuid`, [row.thread_id]);
        if (origin) await enqueue(tx, { kind: 'search.index', userId: input.userId, accountId: input.accountId, key: `resolved-index:${row.id}`, payload: { threadId: row.thread_id }, maxAttempts: 4 });
      }
    }
  });
}
