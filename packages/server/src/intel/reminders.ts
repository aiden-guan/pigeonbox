import { one } from '../db/sql.js';
import type { JobRecord } from '../jobs/queue.js';
import { SkipJob } from '../jobs/runner.js';
import { recordAudit } from './audit.js';
import type { IntelDeps } from './context.js';
import { gmailFor, jobErrorFrom, loadAccount } from './google-access.js';
import { notify } from './notifications.js';

/** A reminder or snooze comes due: notify, and for a snooze put the thread back in the inbox. */
export async function runReminder(deps: IntelDeps, job: JobRecord): Promise<void> {
  const reminderId = String(job.payload.reminderId ?? '');
  if (!job.userId || !reminderId) throw new SkipJob('missing_ids');
  const userId = job.userId;
  const reminder = await deps.db.asUser(userId, (tx) =>
    one<{ id: string; status: string; reason: string; mail_account_id: string | null; subject: string | null; gmail_thread_id: string | null }>(
      tx,
      `select r.id, r.status, r.reason, r.mail_account_id, t.subject, t.gmail_thread_id from public.reminders r left join public.threads t on t.id = r.thread_id where r.id = $1::uuid`,
      [reminderId],
    ),
  );
  if (!reminder || reminder.status !== 'pending') throw new SkipJob('not_pending');
  if (job.payload.restoreInbox && reminder.mail_account_id && reminder.gmail_thread_id) {
    const account = await deps.db.asUser(userId, (tx) => loadAccount(tx, reminder.mail_account_id!));
    if (account?.status === 'active' && account.features.includes('organize')) {
      try {
        await gmailFor(deps, account).modifyThread(reminder.gmail_thread_id, { addLabelIds: ['INBOX'], removeLabelIds: [] });
      } catch (error) {
        throw jobErrorFrom(error);
      }
    }
  }
  await deps.db.asUser(userId, async (tx) => {
    await tx.query(`update public.reminders set status = 'fired', fired_at = now() where id = $1::uuid`, [reminderId]);
    await notify(tx, {
      userId,
      kind: 'follow_up_due',
      title: `Reminder: ${(reminder.subject || reminder.reason).slice(0, 150)}`,
      body: reminder.reason.slice(0, 500),
      accountId: reminder.mail_account_id,
      threadId: reminder.gmail_thread_id,
      refId: reminderId,
      dedupeKey: `reminder:${reminderId}`,
    });
    if (job.payload.restoreInbox) {
      await recordAudit(tx, {
        userId,
        actor: { type: 'system', id: null, name: 'Snooze' },
        action: 'unsnooze',
        tier: 1,
        target: { kind: 'thread', id: reminder.gmail_thread_id ?? reminderId, title: reminder.subject },
        summary: 'Moved a snoozed thread back to the inbox',
        policy: { decision: 'allowed', reason: 'Scheduled by a snooze you allowed' },
        accountId: reminder.mail_account_id,
        threadId: reminder.gmail_thread_id,
        idempotencyKey: `unsnooze:${reminderId}`,
      });
    }
  });
}

export async function runRetention(deps: IntelDeps): Promise<void> {
  await deps.db.system(tx => tx.query(`delete from public.document_viewer_sessions where expires_at <= $1::timestamptz`, [deps.now()]));
  const removed = await deps.db.system((tx) => one<{ n: number }>(tx, `select app.sweep_retention() as n`));
  deps.log('info', 'retention sweep', { count: Number(removed?.n ?? 0) });
}
