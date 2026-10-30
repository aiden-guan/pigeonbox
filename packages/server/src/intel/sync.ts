import { num, one, type SqlExecutor } from '../db/sql.js';
import { GoogleApiError } from '../google/errors.js';
import type { GmailClient, GmailMessage, GmailMessageRef } from '../google/gmail.js';
import type { GmailPushNotification } from '../google/pubsub.js';
import { enqueue, type JobRecord } from '../jobs/queue.js';
import { SkipJob } from '../jobs/runner.js';
import { mapLimit } from '../platform/concurrency.js';
import type { IntelDeps } from './context.js';
import { gmailFor, jobErrorFrom, loadAccount, type AccountRow } from './google-access.js';
import { applyLabelChange, deleteMessage, refreshThreads, toMessageMeta, upsertMessages, type MessageMeta } from './mailstore.js';
import { afterThreadsChanged } from './pipeline.js';
import { recordContacts } from './relationships.js';
import { silenceUnsubscribed } from './subscriptions.js';

/**
 * Gmail synchronization.
 *
 * - Push: Pub/Sub tells us a mailbox changed. We enqueue one `gmail.sync` per
 *   (account, historyId); duplicates collapse on the idempotency key.
 * - Incremental sync: `history.list` from the stored cursor, metadata-only
 *   message fetches, upserts, and a cursor that only moves forward, committed
 *   with the writes of each page.
 * - Recovery: when Google no longer has history for the cursor (404), or on
 *   first connection, list recent mail, rebuild metadata, and resume from the
 *   history ID captured *before* listing so nothing in between is lost.
 * - Watch renewal: `users.watch` again before expiry (Supabase Cron enqueues it).
 *
 * The full mailbox is never polled.
 */

const MAX_HISTORY_PAGES_PER_RUN = 20;
// Production metadata/contact writes exceeded the 120-second queue lease at
// 100 messages per page. Commit one small page, then continue durably.
const RECOVERY_PAGES_PER_RUN = 1;
const RECOVERY_MESSAGES_PER_PAGE = 20;
const FETCH_CONCURRENCY = 6;

function requireIds(job: JobRecord): { userId: string; accountId: string } {
  if (!job.userId || !job.accountId) throw new SkipJob('missing_ids');
  return { userId: job.userId, accountId: job.accountId };
}

async function activeAccount(deps: IntelDeps, userId: string, accountId: string): Promise<AccountRow> {
  const account = await deps.db.asUser(userId, (tx) => loadAccount(tx, accountId));
  if (!account || account.status !== 'active' || !account.features.includes('mail_read')) throw new SkipJob('account_inactive');
  return account;
}

async function fetchMetadata(gmail: GmailClient, ids: string[], owner: string): Promise<MessageMeta[]> {
  const fetched = await mapLimit(ids, FETCH_CONCURRENCY, async (id) => {
    try {
      return await gmail.getMessage(id, 'metadata');
    } catch (error) {
      // Deleted between the history record and the fetch: nothing to store.
      if (error instanceof GoogleApiError && error.code === 'not_found') return null;
      throw error;
    }
  });
  return fetched.filter((message): message is GmailMessage => Boolean(message)).map((message) => toMessageMeta(message, [owner])).filter((meta): meta is MessageMeta => Boolean(meta));
}

async function markSyncFailure(deps: IntelDeps, userId: string, accountId: string, code: string): Promise<void> {
  await deps.db
    .asUser(userId, (tx) =>
      tx.query(
        `update public.gmail_sync_state
            set consecutive_failures = consecutive_failures + 1, last_error_code = $2,
                state = case when $2 like 'connection_%' or $2 in ('google_auth_revoked', 'google_insufficient_permission') or consecutive_failures + 1 >= 5
                             then 'stalled' else 'degraded' end, updated_at = now()
          where mail_account_id = $1::uuid`,
        [accountId, code.slice(0, 64)],
      ),
    )
    .catch(() => undefined);
}

// ---------------------------------------------------------------------------
// Push notifications
// ---------------------------------------------------------------------------

/**
 * Route a verified push to the accounts it names. System scope: the mailbox
 * address is the only key, and it only selects accounts to sync with their
 * own credentials and cursor.
 */
export async function handlePushNotification(deps: IntelDeps, push: GmailPushNotification): Promise<number> {
  return deps.db.system(async (tx) => {
    const accounts = await tx.query<{ id: string; user_id: string; history_id: string | null }>(
      `select a.id, a.user_id, s.history_id::text as history_id
         from public.mail_accounts a
         join public.gmail_sync_state s on s.mail_account_id = a.id
        where a.email_normalized = $1 and a.status = 'active' and 'mail_read' = any (a.features)`,
      [push.emailAddress],
    );
    let queued = 0;
    for (const account of accounts) {
      await tx.query(
        `update public.gmail_sync_state
            set last_push_at = now(), last_push_history_id = greatest(coalesce(last_push_history_id, 0), $2::numeric), updated_at = now()
          where mail_account_id = $1::uuid`,
        [account.id, push.historyId],
      );
      if (account.history_id && BigInt(account.history_id) >= BigInt(push.historyId)) continue; // already synced past it
      const { created } = await enqueue(tx, {
        kind: 'gmail.sync',
        userId: account.user_id,
        accountId: account.id,
        key: `sync:${account.id}:${push.historyId}`,
        payload: { historyId: push.historyId },
        maxAttempts: 8,
      });
      if (created) queued += 1;
    }
    return queued;
  });
}

// ---------------------------------------------------------------------------
// Incremental sync
// ---------------------------------------------------------------------------

type PageChanges = { added: GmailMessageRef[]; deleted: string[]; labels: Array<{ id: string; add: string[]; remove: string[] }>; maxRecordId: string | null };

function collect(history: Awaited<ReturnType<GmailClient['listHistory']>>['history']): PageChanges {
  const added = new Map<string, GmailMessageRef>();
  const deleted = new Set<string>();
  const labels: PageChanges['labels'] = [];
  let maxRecordId: bigint | null = null;
  for (const record of history ?? []) {
    const id = BigInt(record.id);
    if (maxRecordId === null || id > maxRecordId) maxRecordId = id;
    for (const entry of record.messagesAdded ?? []) added.set(entry.message.id, entry.message);
    for (const entry of record.messagesDeleted ?? []) {
      deleted.add(entry.message.id);
      added.delete(entry.message.id);
    }
    for (const entry of record.labelsAdded ?? []) labels.push({ id: entry.message.id, add: entry.labelIds, remove: [] });
    for (const entry of record.labelsRemoved ?? []) labels.push({ id: entry.message.id, add: [], remove: entry.labelIds });
  }
  return { added: [...added.values()], deleted: [...deleted], labels, maxRecordId: maxRecordId === null ? null : maxRecordId.toString() };
}

export async function runGmailSync(deps: IntelDeps, job: JobRecord): Promise<void> {
  const { userId, accountId } = requireIds(job);
  const account = await activeAccount(deps, userId, accountId);
  const cursor = await deps.db.asUser(userId, async (tx) => {
    const state = await one<{ history_id: string | null }>(tx, `select history_id::text from public.gmail_sync_state where mail_account_id = $1::uuid`, [accountId]);
    await tx.query(`update public.gmail_sync_state set last_sync_started_at = now(), updated_at = now() where mail_account_id = $1::uuid`, [accountId]);
    if (!state?.history_id) {
      const pending = await one<{ exists: boolean }>(tx, `select exists(select 1 from public.jobs where mail_account_id=$1::uuid and kind='gmail.recover' and status in ('queued','running','retrying'))`, [accountId]);
      if (!pending?.exists) await enqueue(tx, { kind: 'gmail.recover', userId, accountId, key: `recover:${accountId}:nocursor:${deps.now().toISOString().slice(0, 13)}`, payload: { reason: 'no_cursor' }, maxAttempts: 8 });
    }
    return state?.history_id ?? null;
  });
  if (!cursor) throw new SkipJob('no_cursor');

  const gmail = gmailFor(deps, account);
  let pageToken: string | undefined;
  let pages = 0;
  try {
    do {
      const page = await gmail.listHistory(cursor, pageToken);
      const changes = collect(page.history);
      const metas = changes.added.length ? await fetchMetadata(gmail, changes.added.map((ref) => ref.id), account.email) : [];
      pageToken = page.nextPageToken;
      pages += 1;
      const last = !pageToken;
      await deps.db.asUser(userId, async (tx) => {
        await applyChanges(deps, tx, { userId, accountId, metas, changes, initial: false });
        const advanceTo = last ? page.historyId : changes.maxRecordId;
        if (advanceTo) {
          await tx.query(`update public.gmail_sync_state set history_id = greatest(coalesce(history_id, 0), $2::numeric), updated_at = now() where mail_account_id = $1::uuid`, [
            accountId,
            advanceTo,
          ]);
        }
      });
      // Lists the user left through PigeonBox stay out of the inbox, even ones that ignore the unsubscribe.
      if (metas.length) await silenceUnsubscribed(deps, account, metas);
    } while (pageToken && pages < MAX_HISTORY_PAGES_PER_RUN);

    await deps.db.asUser(userId, async (tx) => {
      if (pageToken) {
        // More history than one run should handle: continue in a new job from the advanced cursor.
        const state = await one<{ history_id: string }>(tx, `select history_id::text from public.gmail_sync_state where mail_account_id = $1::uuid`, [accountId]);
        await enqueue(tx, { kind: 'gmail.sync', userId, accountId, key: `sync:${accountId}:cont:${state?.history_id}`, maxAttempts: 8 });
      }
      await tx.query(
        `update public.gmail_sync_state set state = $2, last_sync_completed_at = now(), consecutive_failures = 0, last_error_code = null, updated_at = now()
          where mail_account_id = $1::uuid`,
        [accountId, pageToken ? 'catching_up' : 'healthy'],
      );
    });
  } catch (error) {
    if (error instanceof GoogleApiError && error.code === 'history_expired') {
      await deps.db.asUser(userId, async (tx) => {
        await tx.query(`update public.gmail_sync_state set state = 'recovering', last_error_code = 'history_expired', updated_at = now() where mail_account_id = $1::uuid`, [
          accountId,
        ]);
        await enqueue(tx, { kind: 'gmail.recover', userId, accountId, key: `recover:${accountId}:expired:${cursor}`, payload: { reason: 'history_expired' }, maxAttempts: 8 });
      });
      deps.log('warn', 'gmail history expired, recovering', { userId, accountId });
      return;
    }
    const mapped = jobErrorFrom(error);
    await markSyncFailure(deps, userId, accountId, (mapped as { code?: string }).code ?? 'error');
    throw mapped;
  }
}

async function applyChanges(
  deps: IntelDeps,
  tx: SqlExecutor,
  input: { userId: string; accountId: string; metas: MessageMeta[]; changes?: PageChanges; initial: boolean },
): Promise<void> {
  const { userId, accountId } = input;
  const upserted = await upsertMessages(tx, userId, accountId, input.metas);
  const touched = new Set<string>([...upserted.threads.values()].map((entry) => entry.id));
  for (const change of input.changes?.labels ?? []) {
    const threadId = await applyLabelChange(tx, accountId, change.id, change.add, change.remove);
    if (threadId) touched.add(threadId);
  }
  for (const id of input.changes?.deleted ?? []) {
    const threadId = await deleteMessage(tx, accountId, id);
    if (threadId) touched.add(threadId);
  }
  const threads = await refreshThreads(tx, [...touched]);
  await recordContacts(tx, userId, upserted.insertedMetas);
  const newInbound = new Set<string>();
  const newOutbound = new Set<string>();
  for (const entry of upserted.threads.values()) {
    if (entry.newInbound) newInbound.add(entry.id);
    if (entry.newOutbound) newOutbound.add(entry.id);
  }
  await afterThreadsChanged(deps, tx, { userId, accountId, threads, newInbound, newOutbound, initial: input.initial });
}

// ---------------------------------------------------------------------------
// Recovery and initial backfill
// ---------------------------------------------------------------------------

export async function runGmailRecover(deps: IntelDeps, job: JobRecord): Promise<void> {
  const { userId, accountId } = requireIds(job);
  const account = await activeAccount(deps, userId, accountId);
  const gmail = gmailFor(deps, account);
  const payload = job.payload as { pageToken?: string; historyId?: string; runId?: string; page?: number; reason?: string };
  try {
    deps.log('info', 'gmail recovery fetching profile', { userId, accountId, jobId: job.id, attempt: job.attempts });
    // The resume point is captured before listing, so changes made while we list are replayed by the next sync.
    const historyId = payload.historyId ?? (await gmail.getProfile()).historyId;
    deps.log('info', 'gmail recovery started', { userId, accountId, jobId: job.id, attempt: job.attempts });
    const runId = payload.runId ?? job.id;
    let pageToken = payload.pageToken;
    let pages = 0;
    const days = deps.config.intel.backfillDays;
    const query = `newer_than:${days}d -in:spam -in:trash -in:draft -in:chats`;
    do {
      const list = await gmail.listMessages({ q: query, pageToken, maxResults: RECOVERY_MESSAGES_PER_PAGE });
      deps.log('info', 'gmail recovery page listed', { userId, accountId, count: list.messages?.length ?? 0 });
      const metas = list.messages?.length ? await fetchMetadata(gmail, list.messages.map((ref) => ref.id), account.email) : [];
      await deps.db.asUser(userId, (tx) => applyChanges(deps, tx, { userId, accountId, metas, initial: true }));
      deps.log('info', 'gmail recovery page persisted', { userId, accountId, count: metas.length });
      pageToken = list.nextPageToken;
      pages += 1;
    } while (pageToken && pages < RECOVERY_PAGES_PER_RUN);

    await deps.db.asUser(userId, async (tx) => {
      if (pageToken) {
        const page = (payload.page ?? 0) + 1;
        await enqueue(tx, {
          kind: 'gmail.recover',
          userId,
          accountId,
          key: `recover:${accountId}:${runId}:p${page}`,
          payload: { pageToken, historyId, runId, page, reason: payload.reason ?? 'continue' },
          maxAttempts: 8,
        });
        await tx.query(`update public.gmail_sync_state set state = 'recovering', updated_at = now() where mail_account_id = $1::uuid`, [accountId]);
        return;
      }
      const since = new Date(deps.now().getTime() - days * 86_400_000);
      await tx.query(
        `update public.gmail_sync_state
            set history_id = greatest(coalesce(history_id, 0), $2::numeric), state = 'healthy', coverage_since = least(coalesce(coverage_since, $3::timestamptz), $3::timestamptz),
                last_sync_completed_at = now(), consecutive_failures = 0, last_error_code = null, backfill_page_token = null, updated_at = now()
          where mail_account_id = $1::uuid`,
        [accountId, historyId, since],
      );
      // Catch up on anything that changed while we were listing.
      await enqueue(tx, { kind: 'gmail.sync', userId, accountId, key: `sync:${accountId}:after-recover:${runId}`, maxAttempts: 8 });
    });
    deps.log('info', 'gmail recovery pass', { userId, accountId, count: pages });
  } catch (error) {
    if (error instanceof SkipJob) throw error;
    const mapped = jobErrorFrom(error);
    await markSyncFailure(deps, userId, accountId, (mapped as { code?: string }).code ?? 'error');
    throw mapped;
  }
}

// ---------------------------------------------------------------------------
// Watch renewal
// ---------------------------------------------------------------------------

export async function runGmailWatch(deps: IntelDeps, job: JobRecord): Promise<void> {
  const { userId, accountId } = requireIds(job);
  const account = await activeAccount(deps, userId, accountId);
  if (!deps.google) throw new SkipJob('google_not_configured');
  try {
    const watch = await gmailFor(deps, account).watch(deps.google.pubsub.topic);
    const expiration = new Date(num(watch.expiration));
    await deps.db.asUser(userId, (tx) =>
      tx.query(`update public.gmail_sync_state set watch_expires_at = $2::timestamptz, updated_at = now() where mail_account_id = $1::uuid`, [
        accountId,
        Number.isFinite(expiration.getTime()) && expiration.getTime() > 0 ? expiration : new Date(deps.now().getTime() + 6 * 86_400_000),
      ]),
    );
  } catch (error) {
    const mapped = jobErrorFrom(error);
    await markSyncFailure(deps, userId, accountId, (mapped as { code?: string }).code ?? 'error');
    throw mapped;
  }
}
