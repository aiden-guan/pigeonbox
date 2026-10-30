import { one, type SqlExecutor } from '../db/sql.js';
import { vectorLiteral } from '../db/vector.js';
export { vectorLiteral } from '../db/vector.js';
import type { JobRecord } from '../jobs/queue.js';
import { SkipJob } from '../jobs/runner.js';
import { BudgetExceededError, embedTexts } from './ai.js';
import { threadCommitments } from './commitments.js';
import type { IntelDeps } from './context.js';
import { gmailFor, jobErrorFrom, loadAccount } from './google-access.js';
import { loadPreferences } from './preferences.js';
import { readThread } from './thread-reader.js';
import { decryptSummary } from './threads.js';

/**
 * Retrieval index. By default each thread gets one embedding computed from
 * derived text only (subject, participants, summary, commitments); no body
 * text is stored. With Fast Recall (opt-in), PigeonBox also keeps encrypted
 * excerpts of message text with their own embeddings for the user's chosen
 * retention, so deep questions can be answered without re-reading Gmail.
 */

const CHUNK = 900;

function chunks(text: string): string[] {
  const clean = text.replace(/\s+/g, ' ').trim();
  const out: string[] = [];
  for (let i = 0; i < clean.length && out.length < 6; i += CHUNK) out.push(clean.slice(i, i + CHUNK));
  return out;
}

export async function derivedText(deps: IntelDeps, tx: SqlExecutor, userId: string, threadRowId: string): Promise<{ text: string; version: string; accountId: string; gmailThreadId: string } | null> {
  const row = await one<{ subject: string; participants: Array<{ email: string; name?: string }>; content_version: string; mail_account_id: string; gmail_thread_id: string; id: string; summary_key_id: string | null; summary_iv: string | null; summary_ciphertext: string | null }>(
    tx,
    `select t.id, t.subject, t.participants, t.content_version, t.mail_account_id, t.gmail_thread_id, s.summary_key_id, s.summary_iv, s.summary_ciphertext
       from public.threads t left join public.thread_states s on s.thread_id = t.id where t.id = $1::uuid`,
    [threadRowId],
  );
  if (!row) return null;
  const summary = await decryptSummary(deps.box, userId, row);
  const commitments = await threadCommitments(tx, deps.box, userId, threadRowId);
  const text = [
    row.subject,
    (row.participants ?? []).map((person) => `${person.name ?? ''} ${person.email}`).join(', '),
    summary?.oneLine ?? '',
    ...(summary?.keyPoints ?? []),
    ...commitments.map((commitment) => `${commitment.direction === 'mine' ? 'I promised' : 'They promised'}: ${commitment.text}`),
  ]
    .filter(Boolean)
    .join('\n')
    .slice(0, 4_000);
  return { text, version: row.content_version, accountId: row.mail_account_id, gmailThreadId: row.gmail_thread_id };
}

export async function runSearchIndex(deps: IntelDeps, job: JobRecord): Promise<void> {
  const threadRowId = String(job.payload.threadId ?? '');
  if (!job.userId || !threadRowId) throw new SkipJob('missing_ids');
  const userId = job.userId;
  const loaded = await deps.db.asUser(userId, async (tx) => ({
    derived: await derivedText(deps, tx, userId, threadRowId),
    prefs: await loadPreferences(tx, userId),
    indexed: await one<{ content_version: string }>(tx, `select content_version from public.search_documents where thread_id = $1::uuid`, [threadRowId]),
  }));
  if (!loaded.derived) throw new SkipJob('thread_gone');
  const { derived, prefs } = loaded;
  try {
    if (loaded.indexed?.content_version !== derived.version) {
      const [vector] = await embedTexts(deps, userId, [derived.text], `job_${job.id}`);
      await deps.db.asUser(userId, (tx) =>
        tx.query(
          `insert into public.search_documents (user_id, mail_account_id, thread_id, content_version, embedding, model, updated_at)
           values ($1::uuid, $2::uuid, $3::uuid, $4, $5::extensions.vector, $6, now())
           on conflict (thread_id) do update set content_version = excluded.content_version, embedding = excluded.embedding, model = excluded.model, updated_at = now()`,
          [userId, derived.accountId, threadRowId, derived.version, vectorLiteral(vector!), deps.config.ai.embedModel],
        ),
      );
    }
    if (!prefs.fastRecall.enabled) return;
    const account = await deps.db.asUser(userId, (tx) => loadAccount(tx, derived.accountId));
    if (!account || account.status !== 'active') return;
    const read = await readThread(gmailFor(deps, account), derived.gmailThreadId, [account.email]);
    const pieces = read.messages.slice(-6).flatMap((message) => chunks(message.text).map((text, index) => ({ message, index, text })));
    if (!pieces.length) return;
    const vectors = await embedTexts(deps, userId, pieces.map((piece) => piece.text), `job_${job.id}`);
    const expires = new Date(deps.now().getTime() + prefs.fastRecall.retentionDays * 86_400_000);
    await deps.db.asUser(userId, async (tx) => {
      await tx.query(`delete from public.recall_chunks where thread_id = $1::uuid`, [threadRowId]);
      for (const [i, piece] of pieces.entries()) {
        const id = crypto.randomUUID();
        const sealed = await deps.box.seal(piece.text, { purpose: 'fast_recall', userId, recordId: id });
        await tx.query(
          `insert into public.recall_chunks (id, user_id, mail_account_id, thread_id, gmail_message_id, chunk_index, text_key_id, text_iv, text_ciphertext, embedding, message_at, expires_at)
           values ($1::uuid, $2::uuid, $3::uuid, $4::uuid, $5, $6, $7, $8, $9, $10::extensions.vector, $11::timestamptz, $12::timestamptz)`,
          [id, userId, derived.accountId, threadRowId, piece.message.gmailMessageId, piece.index, sealed.keyId, sealed.iv, sealed.ciphertext, vectorLiteral(vectors[i]!), piece.message.date, expires],
        );
      }
    });
  } catch (error) {
    if (error instanceof BudgetExceededError) throw new SkipJob(error.message);
    throw jobErrorFrom(error);
  }
}

/** Turning Fast Recall off deletes every stored excerpt immediately. */
export async function purgeFastRecall(tx: SqlExecutor): Promise<number> {
  const rows = await tx.query<{ id: string }>(`delete from public.recall_chunks returning id`);
  return rows.length;
}
