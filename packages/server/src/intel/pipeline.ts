import { iso, type SqlExecutor } from '../db/sql.js';
import { enqueue } from '../jobs/queue.js';
import type { IntelDeps } from './context.js';
import { markDraftsStale } from './drafts.js';
import { recordInboundActivity } from './followups.js';
import type { ThreadAggregate } from './mailstore.js';
import { loadPreferences } from './preferences.js';
import { recordSequenceActivity } from './sequences.js';
import { notify } from './notifications.js';

/**
 * What happens right after sync writes new mail, inside the same transaction:
 *
 * 1. Deterministic effects that must not wait for AI: a reply closes the
 *    pending follow-up; a new message makes drafts built on the old thread
 *    stale; a user reply retires the draft it replaced.
 * 2. Analysis is queued once per thread version (idempotency key), so a
 *    replayed history page or a duplicate push never analyzes twice.
 */

const INITIAL_WINDOW_MS = 14 * 86_400_000;
const INITIAL_CAP = 150;

export async function afterThreadsChanged(
  deps: IntelDeps,
  tx: SqlExecutor,
  input: { userId: string; accountId: string; threads: ThreadAggregate[]; newInbound: Set<string>; newOutbound: Set<string>; initial: boolean },
): Promise<void> {
  const { userId, accountId } = input;
  const inbound = [...input.newInbound];
  const outbound = [...input.newOutbound];

  if (inbound.length && !input.initial) {
    const { revived } = await recordInboundActivity(tx, inbound);
    await markDraftsStale(tx, inbound, 'A new message arrived in this thread');
    await recordSequenceActivity(tx, inbound);
    if (revived.length) {
      const prefs = await loadPreferences(tx, userId);
      if (prefs.followUp.remindWhenRevived) {
        for (const threadRowId of revived) {
          const thread = input.threads.find((item) => item.id === threadRowId);
          if (!thread) continue;
          const subject = await tx.query<{ subject: string; gmail_thread_id: string }>(`select subject, gmail_thread_id from public.threads where id = $1::uuid`, [threadRowId]);
          await notify(tx, {
            userId,
            kind: 'engagement',
            title: 'An old conversation is active again',
            body: subject[0]?.subject || '(no subject)',
            accountId,
            threadId: subject[0]?.gmail_thread_id ?? null,
            dedupeKey: `revived:${threadRowId}:${thread.content_version}`,
          });
        }
      }
    }
  }
  if (outbound.length && !input.initial) {
    // The user answered: drafts for the previous state of the thread are done. A
    // Gmail draft is never touched; only PigeonBox stops listing it as pending work.
    await tx.query(
      `update public.drafts d set status = 'discarded', stale_reason = 'You replied', updated_at = now()
         from public.threads t
        where t.id = d.thread_id and d.thread_id = any($1::uuid[]) and d.status in ('ready', 'stale', 'preparing', 'placed', 'user_edited')
          and d.based_on_version is distinct from t.content_version`,
      [outbound],
    );
  }

  const now = deps.now().getTime();
  let initialQueued = 0;
  for (const thread of input.threads) {
    if (thread.analyzed_version === thread.content_version) continue;
    const isNew = input.newInbound.has(thread.id) || input.newOutbound.has(thread.id);
    if (input.initial) {
      const last = thread.last_message_at ? Date.parse(iso(thread.last_message_at)) : 0;
      const relevant = thread.label_ids.includes('INBOX') || thread.label_ids.includes('SENT');
      if (!relevant || now - last > INITIAL_WINDOW_MS || initialQueued >= INITIAL_CAP) continue;
      initialQueued += 1;
    } else if (!isNew) {
      continue;
    }
    await enqueue(tx, {
      kind: 'thread.analyze',
      userId,
      accountId,
      key: `analyze:${thread.id}:${thread.content_version}`,
      payload: { threadId: thread.id, newOutbound: input.newOutbound.has(thread.id), newInbound: input.newInbound.has(thread.id) },
      // Spread the initial backfill so it does not arrive as one burst.
      runAt: input.initial ? new Date(now + initialQueued * 2_000) : undefined,
      maxAttempts: 5,
    });
  }
}
