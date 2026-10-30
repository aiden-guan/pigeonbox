import type { ThreadIntel } from '@pigeonbox/api-contract';
import { decryptSummary } from './thread-summary.js';
export { decryptSummary } from './thread-summary.js';
import {
  categoryForThreadState,
  type RelationshipImportance,
  type ThreadCategory,
  type ThreadState,
  type ThreadStateDetail,
} from '@pigeonbox/shared';
import { iso, isoOrNull, num, one, type SqlExecutor } from '../db/sql.js';
import type { SecretBox } from '../platform/crypto.js';
import { threadCommitments } from './commitments.js';
import { loadLiveDraft } from './drafts.js';
import type { MeetingContext } from './prompts.js';
import { FOLLOW_UP_COLUMNS, toFollowUp, type FollowUpRow } from './followups.js';

/**
 * Thread state persistence and the ThreadIntel view the extension renders.
 */

export type StateWrite = {
  threadRowId: string;
  userId: string;
  accountId: string;
  state: ThreadState;
  category: ThreadCategory;
  priority: 'HIGH' | 'NORMAL' | 'LOW';
  urgency: ThreadStateDetail['urgency'];
  confidence: number;
  needsReply: boolean;
  replyExpectedFrom: 'owner' | 'them' | 'nobody';
  deadline: { at: string; explicit: boolean; label: string } | null;
  importanceReason: string;
  relationshipImportance: RelationshipImportance;
  nextAction: ThreadStateDetail['nextAction'];
  source: ThreadStateDetail['source'];
  injectionSuspected: boolean;
  meeting: MeetingContext | null;
  summary: { oneLine: string; keyPoints: string[] } | null;
  analyzedVersion: string;
  inputFingerprint: string | null;
  model: string | null;
};

export async function saveThreadState(tx: SqlExecutor, box: SecretBox, write: StateWrite): Promise<void> {
  const sealed = write.summary
    ? await box.seal(JSON.stringify({ perspectiveVersion: 1, oneLine: write.summary.oneLine.slice(0, 400), keyPoints: write.summary.keyPoints.slice(0, 8) }), {
        purpose: 'thread_summary',
        userId: write.userId,
        recordId: write.threadRowId,
      })
    : null;
  const deadlineAt = write.deadline && Number.isFinite(Date.parse(write.deadline.at)) ? new Date(write.deadline.at) : null;
  await tx.query(
    `insert into public.thread_states (thread_id, user_id, mail_account_id, state, category, priority, urgency, confidence, needs_reply, reply_expected_from,
        deadline_at, deadline_explicit, deadline_label, importance_reason, relationship_importance, next_action_kind, next_action_label, source,
        injection_suspected, meeting_request, summary_key_id, summary_iv, summary_ciphertext, analyzed_version, input_fingerprint, model, analyzed_at, updated_at)
     values ($1::uuid, $2::uuid, $3::uuid, $4, $5, $6, $7, $8, $9, $10, $11::timestamptz, $12, $13, $14, $15, $16, $17, $18, $19, $20::jsonb, $21, $22, $23, $24, $25, $26, now(), now())
     on conflict (thread_id) do update set
       state = excluded.state, category = excluded.category, priority = excluded.priority, urgency = excluded.urgency, confidence = excluded.confidence,
       needs_reply = excluded.needs_reply, reply_expected_from = excluded.reply_expected_from, deadline_at = excluded.deadline_at,
       deadline_explicit = excluded.deadline_explicit, deadline_label = excluded.deadline_label, importance_reason = excluded.importance_reason,
       relationship_importance = excluded.relationship_importance, next_action_kind = excluded.next_action_kind, next_action_label = excluded.next_action_label,
       source = excluded.source, injection_suspected = excluded.injection_suspected, meeting_request = excluded.meeting_request,
       summary_key_id = coalesce(excluded.summary_key_id, public.thread_states.summary_key_id),
       summary_iv = coalesce(excluded.summary_iv, public.thread_states.summary_iv),
       summary_ciphertext = coalesce(excluded.summary_ciphertext, public.thread_states.summary_ciphertext),
       analyzed_version = excluded.analyzed_version, input_fingerprint = coalesce(excluded.input_fingerprint, public.thread_states.input_fingerprint),
       model = excluded.model, analyzed_at = now(), updated_at = now(),
       -- A correction applies to the version the user saw; new activity clears it.
       user_state = case when public.thread_states.user_state_version = excluded.analyzed_version then public.thread_states.user_state else null end`,
    [
      write.threadRowId,
      write.userId,
      write.accountId,
      write.state,
      write.category,
      write.priority,
      write.urgency,
      Math.max(0, Math.min(1, write.confidence)),
      write.needsReply,
      write.replyExpectedFrom,
      deadlineAt,
      Boolean(write.deadline?.explicit),
      write.deadline?.label?.slice(0, 200) ?? null,
      write.importanceReason.slice(0, 300),
      write.relationshipImportance,
      write.nextAction.kind,
      write.nextAction.label.slice(0, 200),
      write.source,
      write.injectionSuspected,
      write.meeting,
      sealed?.keyId ?? null,
      sealed?.iv ?? null,
      sealed?.ciphertext ?? null,
      write.analyzedVersion,
      write.inputFingerprint,
      write.model,
    ],
  );
  await tx.query(
    `insert into public.classifications (user_id, thread_id, source, state, category, confidence, model, input_fingerprint, thread_version)
     values ($1::uuid, $2::uuid, $3, $4, $5, $6, $7, $8, $9)`,
    [write.userId, write.threadRowId, write.source, write.state, write.category, write.confidence, write.model, write.inputFingerprint, write.analyzedVersion],
  );
  await tx.query(`update public.threads set analyzed_version = $2 where id = $1::uuid`, [write.threadRowId, write.analyzedVersion]);
}

type IntelRow = {
  id: string;
  mail_account_id: string;
  gmail_thread_id: string;
  subject: string;
  participants: Array<{ email: string; name?: string }>;
  last_message_at: unknown;
  last_message_from_owner: boolean;
  state: ThreadState | null;
  user_state: ThreadState | null;
  priority: 'HIGH' | 'NORMAL' | 'LOW' | null;
  urgency: ThreadStateDetail['urgency'] | null;
  confidence: number | null;
  deadline_at: unknown;
  deadline_explicit: boolean | null;
  deadline_label: string | null;
  importance_reason: string | null;
  relationship_importance: RelationshipImportance | null;
  next_action_kind: ThreadStateDetail['nextAction']['kind'] | null;
  next_action_label: string | null;
  source: ThreadStateDetail['source'] | null;
  injection_suspected: boolean | null;
  summary_key_id: string | null;
  summary_iv: string | null;
  summary_ciphertext: string | null;
  analyzed_at: unknown;
  updated_at: unknown;
  content_version: string;
};

export function stateDetail(row: Pick<IntelRow, 'state' | 'user_state' | 'priority' | 'urgency' | 'confidence' | 'deadline_at' | 'deadline_explicit' | 'deadline_label' | 'importance_reason' | 'relationship_importance' | 'next_action_kind' | 'next_action_label' | 'source' | 'updated_at' | 'last_message_from_owner'>): ThreadStateDetail {
  const state: ThreadState = row.user_state ?? row.state ?? (row.last_message_from_owner ? 'WAITING_ON_THEM' : 'FYI');
  return {
    state,
    priority: row.priority ?? 'NORMAL',
    urgency: row.urgency ?? 'normal',
    confidence: row.user_state ? 1 : Math.max(0, Math.min(1, num(row.confidence ?? 0.3))),
    deadline: row.deadline_at ? { at: iso(row.deadline_at), explicit: Boolean(row.deadline_explicit), label: (row.deadline_label ?? '').slice(0, 200) } : null,
    importanceReason: (row.user_state ? 'You set this' : row.importance_reason ?? '').slice(0, 300),
    relationshipImportance: row.relationship_importance ?? 'unknown',
    nextAction: { kind: row.next_action_kind ?? 'none', label: (row.next_action_label ?? '').slice(0, 200) },
    source: row.user_state ? 'user' : row.source ?? 'system',
    updatedAt: iso(row.updated_at ?? new Date()),
  };
}

const INTEL_COLUMNS = `t.id, t.mail_account_id, t.gmail_thread_id, t.subject, t.participants, t.last_message_at, t.last_message_from_owner, t.content_version,
  s.state, s.user_state, s.priority, s.urgency, s.confidence, s.deadline_at, s.deadline_explicit, s.deadline_label, s.importance_reason,
  s.relationship_importance, s.next_action_kind, s.next_action_label, s.source, s.injection_suspected, s.summary_key_id, s.summary_iv,
  s.summary_ciphertext, s.analyzed_at, coalesce(s.updated_at, t.updated_at) as updated_at`;

/** ThreadIntel for thread rows. Drafts are included only when `withDrafts` (the open-thread card), to keep list calls cheap. */
export async function loadThreadIntel(tx: SqlExecutor, box: SecretBox, userId: string, threadRowIds: string[], withDrafts: boolean): Promise<Map<string, ThreadIntel>> {
  const out = new Map<string, ThreadIntel>();
  if (!threadRowIds.length) return out;
  const rows = await tx.query<IntelRow>(`select ${INTEL_COLUMNS} from public.threads t left join public.thread_states s on s.thread_id = t.id where t.id = any($1::uuid[])`, [threadRowIds]);
  const followRows = await tx.query<FollowUpRow>(`select ${FOLLOW_UP_COLUMNS} from public.follow_ups f join public.threads t on t.id = f.thread_id where f.thread_id = any($1::uuid[])`, [
    threadRowIds,
  ]);
  const follows = new Map(followRows.map((row) => [row.thread_id, toFollowUp(row)]));
  for (const row of rows) {
    const detail = stateDetail(row);
    const draft = withDrafts ? await loadLiveDraft(tx, box, userId, row.id) : null;
    out.set(row.id, {
      threadId: row.gmail_thread_id,
      accountId: row.mail_account_id,
      subject: row.subject.slice(0, 998),
      participants: (row.participants ?? []).slice(0, 50).map((person) => ({ email: String(person.email).slice(0, 320), ...(person.name ? { name: String(person.name).slice(0, 200) } : {}) })),
      lastMessageAt: row.last_message_at ? iso(row.last_message_at) : iso(row.updated_at),
      lastMessageFromOwner: row.last_message_from_owner,
      state: detail,
      summary: await decryptSummary(box, userId, row),
      commitments: withDrafts ? await threadCommitments(tx, box, userId, row.id) : [],
      followUp: follows.get(row.id) ?? null,
      draft,
      injectionSuspected: Boolean(row.injection_suspected),
      analyzedAt: isoOrNull(row.analyzed_at),
      sources: [{ id: `thread:${row.gmail_thread_id}`, kind: 'thread', title: row.subject.slice(0, 300) || '(no subject)', gmailThreadId: row.gmail_thread_id, accountId: row.mail_account_id, version: row.content_version }],
    });
  }
  return out;
}

/**
 * A user correction: pin the state for the current version, and learn a
 * personal preference for the sender after repeated corrections.
 */
export async function correctThreadState(tx: SqlExecutor, input: { userId: string; accountId: string; threadRowId: string; state: ThreadState }): Promise<void> {
  const thread = await one<{ content_version: string; sender: string | null }>(
    tx,
    `select t.content_version, (select lower(m.from_email) from public.message_metadata m where m.thread_id = t.id and m.direction = 'inbound' order by m.internal_date desc limit 1) as sender
       from public.threads t where t.id = $1::uuid`,
    [input.threadRowId],
  );
  if (!thread) return;
  await tx.query(
    `insert into public.thread_states (thread_id, user_id, mail_account_id, state, category, source, user_state, user_state_version, confidence, analyzed_version)
     values ($1::uuid, $2::uuid, $3::uuid, $4, $5, 'user', $4, $6, 1, $6)
     on conflict (thread_id) do update set user_state = $4, user_state_version = $6, updated_at = now()`,
    [input.threadRowId, input.userId, input.accountId, input.state, categoryForThreadState(input.state), thread.content_version],
  );
  await tx.query(
    `insert into public.classifications (user_id, thread_id, source, state, category, confidence, thread_version) values ($1::uuid, $2::uuid, 'user', $3, $4, 1, $5)`,
    [input.userId, input.threadRowId, input.state, categoryForThreadState(input.state), thread.content_version],
  );
  if (thread.sender) {
    const domain = thread.sender.split('@')[1] ?? '';
    await tx.query(
      `insert into public.learned_preferences (user_id, scope, key, preferred_state) values ($1::uuid, 'sender', $2, $3)
       on conflict (user_id, scope, key, preferred_state) do update set corrections = public.learned_preferences.corrections + 1, last_corrected_at = now()`,
      [input.userId, thread.sender, input.state],
    );
    if (domain) {
      await tx.query(
        `insert into public.learned_preferences (user_id, scope, key, preferred_state) values ($1::uuid, 'domain', $2, $3)
         on conflict (user_id, scope, key, preferred_state) do update set corrections = public.learned_preferences.corrections + 1, last_corrected_at = now()`,
        [input.userId, domain, input.state],
      );
    }
  }
}

/** A learned preference that is clear enough to apply: at least two corrections and no competing preference. */
export async function learnedStateFor(tx: SqlExecutor, sender: string | null): Promise<{ state: ThreadState; reason: string } | null> {
  if (!sender) return null;
  const domain = sender.split('@')[1] ?? '';
  const rows = await tx.query<{ scope: 'sender' | 'domain'; key: string; preferred_state: ThreadState; corrections: number }>(
    `select scope, key, preferred_state, corrections from public.learned_preferences
      where (scope = 'sender' and key = $1) or (scope = 'domain' and key = $2) order by scope = 'sender' desc, corrections desc`,
    [sender, domain],
  );
  for (const scope of ['sender', 'domain'] as const) {
    const candidates = rows.filter((row) => row.scope === scope);
    const best = candidates[0];
    if (!best || best.corrections < (scope === 'sender' ? 2 : 4)) continue;
    const runnerUp = candidates[1];
    if (runnerUp && runnerUp.corrections * 2 > best.corrections) continue;
    return { state: best.preferred_state, reason: `You marked mail from ${scope === 'sender' ? best.key : `@${best.key}`} this way ${best.corrections} times` };
  }
  return null;
}
