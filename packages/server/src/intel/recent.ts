import type { RecentMail } from '@pigeonbox/api-contract';
import type { ThreadState } from '@pigeonbox/shared';
import { iso } from '../db/sql.js';
import type { IntelDeps } from './context.js';
import { decryptSummary } from './thread-summary.js';

type Row = {
  id: string;
  gmail_thread_id: string;
  mail_account_id: string;
  subject: string;
  last_message_at: unknown;
  state: ThreadState | null;
  who: string | null;
  summary_key_id: string | null;
  summary_iv: string | null;
  summary_ciphertext: string | null;
  draft_ready: boolean;
};

const PLACEHOLDER = 'Your conversation is ready to review.';

/**
 * The newest conversations where someone else wrote last, with the state and
 * one-line summary analysis already produced. Read-only: no inference.
 */
export async function recentMail(deps: IntelDeps, userId: string, input: { limit: number; now: Date; canDraft: boolean }): Promise<RecentMail[]> {
  return deps.db.asUser(userId, async (tx) => {
    const rows = await tx.query<Row>(
      `select t.id, t.gmail_thread_id, t.mail_account_id, t.subject, t.last_message_at, coalesce(s.user_state, s.state) as state,
              s.summary_key_id, s.summary_iv, s.summary_ciphertext,
              (select coalesce(nullif(m.from_name, ''), m.from_email) from public.message_metadata m
                where m.thread_id = t.id and m.direction = 'inbound' order by m.internal_date desc limit 1) as who,
              exists (select 1 from public.drafts d where d.thread_id = t.id and d.status in ('ready', 'placed')
                and d.based_on_version = t.content_version and (d.refresh_after is null or d.refresh_after > $2::timestamptz)) as draft_ready
         from public.threads t
         left join public.thread_states s on s.thread_id = t.id
        where not t.last_message_from_owner and t.last_message_at > $1::timestamptz
        order by t.last_message_at desc
        limit $3`,
      [new Date(input.now.getTime() - 14 * 86_400_000), input.now, input.limit],
    );
    const items: RecentMail[] = [];
    for (const row of rows) {
      const summary = await decryptSummary(deps.box, userId, row);
      items.push({
        threadId: row.gmail_thread_id,
        accountId: row.mail_account_id,
        subject: (row.subject || '(no subject)').slice(0, 998),
        who: (row.who ?? '').slice(0, 320),
        lastMessageAt: iso(row.last_message_at),
        state: row.state ?? 'FYI',
        // Analysis writes this placeholder when a summary failed its perspective check; it says nothing.
        summary: summary?.oneLine && summary.oneLine !== PLACEHOLDER ? summary.oneLine : null,
        draftReady: input.canDraft && Boolean(row.draft_ready),
      });
    }
    return items;
  });
}
