import type { Commitment } from '@pigeonbox/api-contract';
import { isoOrNull, type SqlExecutor } from '../db/sql.js';
import type { SecretBox } from '../platform/crypto.js';
import type { ReadMessage } from './thread-reader.js';
import type { SourceRef } from '@pigeonbox/api-contract';
import type { AnalyzedCommitment } from './heuristics.js';

/**
 * Promises found in threads. The promise text is encrypted; counterparty,
 * direction, due date and status stay queryable ("what do I owe Maya?").
 */

function normalize(text: string): string {
  return text.toLowerCase().replace(/[^a-z0-9 ]+/g, ' ').replace(/\s+/g, ' ').trim();
}

async function fingerprint(direction: string, text: string): Promise<string> {
  const digest = new Uint8Array(await crypto.subtle.digest('SHA-256', new TextEncoder().encode(`${direction}|${normalize(text)}`)));
  return [...digest.slice(0, 16)].map((byte) => byte.toString(16).padStart(2, '0')).join('');
}

export async function upsertCommitments(
  tx: SqlExecutor,
  box: SecretBox,
  input: { userId: string; accountId: string; threadRowId: string; ownerEmail: string; commitments: AnalyzedCommitment[]; sourceMessageId: string | null; messages?: ReadMessage[] },
): Promise<number> {
  let created = 0;
  for (const item of input.commitments.slice(0, 10)) {
    const text = item.text.trim().slice(0, 300);
    if (text.length < 4) continue;
    const fp = await fingerprint(item.direction, text);
    const due = item.due && Number.isFinite(Date.parse(item.due)) ? new Date(item.due) : null;
    const counterparty = item.who && /@/.test(item.who) ? item.who.toLowerCase().slice(0, 320) : null;
    const matching = (input.messages ?? []).filter((message) => item.direction === 'mine'
      ? message.direction === 'outbound' && [...message.to, ...message.cc].some((email) => email.toLowerCase() === counterparty)
      : message.direction === 'inbound' && message.from.toLowerCase() === counterparty);
    if (input.messages && !matching.length) continue;
    const origin = matching.find((message) => message.gmailMessageId === item.messageId)
      ?? matching.find((message) => normalize(message.text).includes(normalize(text)));
    const sourceMessageId = origin?.gmailMessageId ?? input.sourceMessageId;
    const existing = await tx.query<{ id: string; status: string; source_message_id: string | null }>(`select id,status,source_message_id from public.commitments where thread_id = $1::uuid and fingerprint = $2`, [input.threadRowId, fp]);
    if (existing.length) {
      // Older extraction associated every promise with the latest message.
      // Repair that reference only when the original statement is identified.
      if (origin && existing[0]!.status === 'open' && existing[0]!.source_message_id !== sourceMessageId)
        await tx.query(`update public.commitments set source_message_id = $2 where id = $1::uuid and status = 'open'`, [existing[0]!.id, sourceMessageId]);
      continue;
    }
    const id = crypto.randomUUID();
    const sealed = await box.seal(text, { purpose: 'commitment', userId: input.userId, recordId: id });
    await tx.query(
      `insert into public.commitments (id, user_id, mail_account_id, thread_id, direction, counterparty, owner_label, text_key_id, text_iv, text_ciphertext, due_at, source_message_id, fingerprint)
       values ($1::uuid, $2::uuid, $3::uuid, $4::uuid, $5, $6, $7, $8, $9, $10, $11::timestamptz, $12, $13)
       on conflict (thread_id, fingerprint) do nothing`,
      [id, input.userId, input.accountId, input.threadRowId, item.direction, counterparty, item.direction === 'mine' ? 'You' : counterparty ?? '', sealed.keyId, sealed.iv, sealed.ciphertext, due, sourceMessageId, fp],
    );
    created += 1;
  }
  return created;
}

export type CommitmentRow = {
  id: string;
  thread_id: string;
  gmail_thread_id: string;
  mail_account_id: string;
  subject: string;
  direction: 'mine' | 'theirs';
  counterparty: string | null;
  owner_label: string;
  text_key_id: string;
  text_iv: string;
  text_ciphertext: string;
  due_at: unknown;
  status: 'open' | 'done' | 'cancelled';
  created_at: unknown;
  resolved_at?: unknown;
  resolution_source?: SourceRef | null;
};

export const COMMITMENT_COLUMNS = `c.id, c.thread_id, t.gmail_thread_id, c.mail_account_id, t.subject, c.direction, c.counterparty, c.owner_label,
  c.text_key_id, c.text_iv, c.text_ciphertext, c.due_at, c.status, c.created_at, c.resolved_at,
  (select jsonb_build_object('id','thread:' || rt.gmail_thread_id,'kind','thread','title',left(rt.subject,300),'gmailThreadId',rt.gmail_thread_id,'accountId',rt.mail_account_id)
     from public.relationship_events re join public.threads rt on rt.id = re.thread_id
     where re.ref = 'commitment:' || c.id::text and re.kind = 'commitment' order by re.at desc limit 1) as resolution_source`;

export async function toCommitment(box: SecretBox, userId: string, row: CommitmentRow): Promise<Commitment> {
  let text = '';
  try {
    text = await box.open({ keyId: row.text_key_id, iv: row.text_iv, ciphertext: row.text_ciphertext }, { purpose: 'commitment', userId, recordId: row.id });
  } catch {
    text = '(unavailable)';
  }
  return {
    id: row.id,
    direction: row.direction,
    owner: row.direction === 'mine' ? 'You' : row.counterparty ?? row.owner_label ?? '',
    text: text.slice(0, 300),
    dueAt: isoOrNull(row.due_at),
    status: row.status,
    resolution: row.resolved_at && row.resolution_source ? { at: isoOrNull(row.resolved_at)!, source: row.resolution_source } : null,
    source: { id: `thread:${row.gmail_thread_id}`, kind: 'thread', title: row.subject.slice(0, 300) || '(no subject)', gmailThreadId: row.gmail_thread_id, accountId: row.mail_account_id },
  };
}

export async function threadCommitments(tx: SqlExecutor, box: SecretBox, userId: string, threadRowId: string): Promise<Commitment[]> {
  const rows = await tx.query<CommitmentRow>(
    `select ${COMMITMENT_COLUMNS} from public.commitments c join public.threads t on t.id = c.thread_id
      where c.thread_id = $1::uuid and c.status <> 'cancelled' order by c.created_at desc limit 20`,
    [threadRowId],
  );
  return Promise.all(rows.map((row) => toCommitment(box, userId, row)));
}

export async function openCommitmentCount(tx: SqlExecutor, threadRowId: string, direction: 'mine' | 'theirs'): Promise<number> {
  const rows = await tx.query<{ n: number }>(`select count(*)::int as n from public.commitments where thread_id = $1::uuid and direction = $2 and status = 'open'`, [threadRowId, direction]);
  return Number(rows[0]?.n ?? 0);
}
