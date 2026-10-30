import { iso, one, type SqlExecutor } from '../db/sql.js';
import { ApiError } from '../http.js';
import type { JobRecord } from '../jobs/queue.js';
import { PermanentJobError, RetryLaterError, SkipJob } from '../jobs/runner.js';
import { hmacSha256Hex, randomToken } from '../platform/crypto.js';
import { assertSafeUrl, safeFetch, UnsafeUrlError } from '../platform/ssrf.js';
import type { IntelDeps } from './context.js';

/**
 * Outbound webhooks for developers: PigeonBox notifications (approval needed,
 * follow-up due, draft ready, briefing, …) POSTed to an HTTPS endpoint the
 * user registers, signed with HMAC-SHA256. URLs are SSRF-checked; delivery is
 * a durable job with retries; the signing secret is sealed at rest.
 */

export const WEBHOOK_EVENTS = ['approval', 'follow_up_due', 'briefing', 'draft_ready', 'sync_problem', 'mention', 'assignment', 'engagement'] as const;

export async function createWebhook(deps: IntelDeps, tx: SqlExecutor, userId: string, input: { url: string; events: string[] }) {
  try {
    assertSafeUrl(input.url);
  } catch (error) {
    throw new ApiError('invalid_request', `That URL cannot be used (${error instanceof UnsafeUrlError ? error.reason.replace(/_/g, ' ') : 'invalid'}).`);
  }
  const events = [...new Set(input.events.filter((event) => (WEBHOOK_EVENTS as readonly string[]).includes(event)))];
  if (!events.length) throw new ApiError('invalid_request', 'Choose at least one event.');
  const secret = `whk_${randomToken(24)}`;
  const id = crypto.randomUUID();
  const sealed = await deps.box.seal(secret, { purpose: 'note', userId, recordId: `webhook:${id}` });
  await tx.query(`insert into public.webhooks (id, user_id, url, events, secret_key_id, secret_iv, secret_ciphertext) values ($1::uuid, $2::uuid, $3, $4::text[], $5, $6, $7)`, [id, userId, input.url, events, sealed.keyId, sealed.iv, sealed.ciphertext]);
  return { id, url: input.url, events, secret };
}

export async function listWebhooks(tx: SqlExecutor) {
  const rows = await tx.query<{ id: string; url: string; events: string[]; enabled: boolean; failures: number; last_status: number | null; last_delivery_at: unknown; created_at: unknown }>(`select id, url, events, enabled, failures, last_status, last_delivery_at, created_at from public.webhooks order by created_at`);
  return rows.map((row) => ({ id: row.id, url: row.url, events: row.events, enabled: row.enabled, failures: row.failures, lastStatus: row.last_status, lastDeliveryAt: row.last_delivery_at ? iso(row.last_delivery_at) : null, createdAt: iso(row.created_at) }));
}

export async function deleteWebhook(tx: SqlExecutor, id: string) {
  const rows = await tx.query(`delete from public.webhooks where id = $1::uuid returning id`, [id]);
  if (!rows.length) throw new ApiError('not_found', 'That webhook does not exist.');
}

export async function runWebhookDelivery(deps: IntelDeps, job: JobRecord): Promise<void> {
  if (!job.userId) throw new SkipJob('missing_ids');
  const userId = job.userId;
  const loaded = await deps.db.asUser(userId, async (tx) => ({
    hook: await one<{ id: string; url: string; enabled: boolean; secret_key_id: string; secret_iv: string; secret_ciphertext: string }>(tx, `select id, url, enabled, secret_key_id, secret_iv, secret_ciphertext from public.webhooks where id = $1::uuid`, [job.payload.webhookId]),
    note: await one<{ id: string; kind: string; title: string; body: string; gmail_thread_id: string | null; ref_id: string | null; created_at: unknown }>(tx, `select id, kind, title, body, gmail_thread_id, ref_id, created_at from public.notifications where id = $1::uuid`, [job.payload.notificationId]),
  }));
  if (!loaded.hook?.enabled || !loaded.note) throw new SkipJob('gone');
  const secret = await deps.box.open({ keyId: loaded.hook.secret_key_id, iv: loaded.hook.secret_iv, ciphertext: loaded.hook.secret_ciphertext }, { purpose: 'note', userId, recordId: `webhook:${loaded.hook.id}` });
  const payload = JSON.stringify({ id: loaded.note.id, type: loaded.note.kind, title: loaded.note.title, body: loaded.note.body, threadId: loaded.note.gmail_thread_id, refId: loaded.note.ref_id, createdAt: iso(loaded.note.created_at) });
  const timestamp = Math.floor(deps.now().getTime() / 1000);
  const signature = await hmacSha256Hex(secret, `${timestamp}.${payload}`);
  let status = 0;
  try {
    const response = await safeFetch(deps.fetch, loaded.hook.url, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', 'User-Agent': 'PigeonBox-Webhooks/1', 'PigeonBox-Signature': `t=${timestamp},v1=${signature}`, 'PigeonBox-Event': loaded.note.kind },
      body: payload,
      maxBytes: 10_000,
      timeoutMs: 8_000,
    });
    status = response.status;
  } catch (error) {
    if (error instanceof UnsafeUrlError) throw new PermanentJobError(error.message);
    status = 0;
  }
  await deps.db.asUser(userId, (tx) =>
    tx.query(`update public.webhooks set last_status = $2, last_delivery_at = now(), failures = case when $2 between 200 and 299 then 0 else failures + 1 end, enabled = case when failures + 1 >= 20 and not ($2 between 200 and 299) then false else enabled end where id = $1::uuid`, [loaded.hook!.id, status]),
  );
  if (status < 200 || status >= 300) throw new RetryLaterError(`webhook_${status || 'network'}`, 120);
}
