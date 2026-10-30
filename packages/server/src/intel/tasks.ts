import type { SavedTask } from '@pigeonbox/api-contract';
import { iso, isoOrNull, type SqlExecutor } from '../db/sql.js';
import type { SecretBox } from '../platform/crypto.js';

export async function listTasks(tx: SqlExecutor, box: SecretBox, userId: string): Promise<SavedTask[]> {
  const rows = await tx.query<{ id: string; title_key_id: string; title_iv: string; title_ciphertext: string; gmail_thread_id: string | null; mail_account_id: string | null; due_at: unknown; status: SavedTask['status']; created_at: unknown }>(
    `select k.id, k.title_key_id, k.title_iv, k.title_ciphertext, k.gmail_thread_id, t.mail_account_id, k.due_at, k.status, k.created_at from public.tasks k left join public.threads t on t.id = k.thread_id where k.user_id = $1::uuid and k.status <> 'cancelled' order by k.status = 'open' desc, k.created_at desc limit 200`,
    [userId],
  );
  return Promise.all(rows.map(async (row) => ({ id: row.id, title: (await box.open({ keyId: row.title_key_id, iv: row.title_iv, ciphertext: row.title_ciphertext }, { purpose: 'note', userId, recordId: row.id }).catch(() => '(unavailable)')).slice(0, 300), threadId: row.gmail_thread_id, accountId: row.mail_account_id, dueAt: isoOrNull(row.due_at), status: row.status, createdAt: iso(row.created_at) })));
}

/** Returns false when the task does not exist for this user. */
export async function updateTaskStatus(tx: SqlExecutor, userId: string, id: string, status: SavedTask['status']): Promise<boolean> {
  const rows = await tx.query(`update public.tasks set status = $3, completed_at = case when $3 = 'done' then now() else null end where id = $1::uuid and user_id = $2::uuid returning id`, [id, userId, status]);
  return rows.length > 0;
}
