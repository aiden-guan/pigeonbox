import type { FocusItem } from '@pigeonbox/api-contract';
import { FOCUS_SECTIONS, FOCUS_SECTION_LABELS, focusScore, focusSectionFor, type FocusSection, type ThreadState } from '@pigeonbox/shared';
import { iso, isoOrNull, num, type SqlExecutor } from '../db/sql.js';

/**
 * The Focus Queue: every thread that needs something, in one of six sections,
 * ranked by actionable urgency (not unread status), each with the plain
 * reasons it is there.
 */

type Row = {
  id: string;
  mail_account_id: string;
  gmail_thread_id: string;
  subject: string;
  last_message_at: unknown;
  last_message_from_owner: boolean;
  content_version: string;
  state: ThreadState | null;
  user_state: ThreadState | null;
  priority: 'HIGH' | 'NORMAL' | 'LOW' | null;
  urgency: 'critical' | 'high' | 'normal' | 'low' | null;
  confidence: number | null;
  deadline_at: unknown;
  relationship_importance: 'vip' | 'close' | 'known' | 'new' | 'unknown' | null;
  who: string | null;
  follow_stage: string | null;
  follow_due: unknown;
  engaged: boolean;
  draft_id: string | null;
  draft_status: 'ready' | 'placed' | null;
  approval_id: string | null;
  assigned: boolean;
};

export async function buildFocusQueue(
  tx: SqlExecutor,
  input: { accountId: string | null; limit: number; now: Date },
): Promise<{ sections: Array<{ id: FocusSection; label: string; items: FocusItem[] }> }> {
  const params: unknown[] = [new Date(input.now.getTime() - 60 * 86_400_000)];
  let accountFilter = '';
  if (input.accountId) {
    params.push(input.accountId);
    accountFilter = `and t.mail_account_id = $${params.length}::uuid`;
  }
  const assigned = `exists (select 1 from public.shared_threads sh join public.assignments a on a.shared_thread_id = sh.id
                where sh.mail_account_id = t.mail_account_id and sh.gmail_thread_id = t.gmail_thread_id and a.assignee_id = app.current_user_id() and a.status = 'open')`;
  const rows = await tx.query<Row>(
    `select t.id, t.mail_account_id, t.gmail_thread_id, t.subject, t.last_message_at, t.last_message_from_owner, t.content_version,
            s.state, s.user_state, s.priority, s.urgency, s.confidence, s.deadline_at, s.relationship_importance,
            case when t.last_message_from_owner
                 then (select m.to_emails[1] from public.message_metadata m where m.thread_id = t.id and m.direction = 'outbound' order by m.internal_date desc limit 1)
                 else (select coalesce(nullif(m.from_name, ''), m.from_email) from public.message_metadata m where m.thread_id = t.id and m.direction = 'inbound' order by m.internal_date desc limit 1)
            end as who,
            f.stage as follow_stage, f.due_at as follow_due, coalesce(f.engagement_opens > 0 or f.engagement_clicks > 0, false) as engaged,
            dr.id as draft_id, dr.status as draft_status,
            (select ap.id from public.approvals ap where ap.thread_id = t.id and ap.status = 'pending'
                and (ap.expires_at is null or ap.expires_at > now()) order by ap.created_at desc limit 1) as approval_id,
            ${assigned} as assigned
       from public.threads t
       join public.thread_states s on s.thread_id = t.id
       left join public.follow_ups f on f.thread_id = t.id
       left join lateral (
         select d.id, d.status from public.drafts d
          where d.thread_id = t.id and d.status in ('ready', 'placed') and d.based_on_version = t.content_version
            and (d.refresh_after is null or d.refresh_after > $${params.length + 1}::timestamptz)
          order by d.updated_at desc limit 1) dr on true
      where t.last_message_at > $1::timestamptz ${accountFilter}
        and (coalesce(s.user_state, s.state) not in ('PROMOTION', 'NEWS', 'NOTIFICATION', 'DONE') or ${assigned})
      order by t.last_message_at desc
      limit 800`,
    [...params, input.now],
  );
  const buckets = new Map<FocusSection, FocusItem[]>(FOCUS_SECTIONS.map((section) => [section, []]));
  for (const row of rows) {
    const state = (row.user_state ?? row.state ?? 'FYI') as ThreadState;
    const candidate = {
      state,
      priority: row.priority ?? 'NORMAL',
      urgency: row.urgency ?? 'normal',
      deadlineAt: isoOrNull(row.deadline_at),
      lastMessageAt: iso(row.last_message_at),
      relationshipImportance: row.relationship_importance ?? 'unknown',
      assignedToMe: Boolean(row.assigned),
      confidence: row.user_state ? 1 : num(row.confidence ?? 0.5),
      draftReady: Boolean(row.draft_id),
      followUpDueAt: row.follow_stage === 'follow_up_due' ? isoOrNull(row.follow_due) : null,
      recentEngagement: Boolean(row.engaged),
    } as const;
    const section = focusSectionFor(candidate, input.now);
    if (!section) continue;
    const { score, reasons } = focusScore(candidate, input.now);
    buckets.get(section)!.push({
      threadId: row.gmail_thread_id,
      accountId: row.mail_account_id,
      subject: (row.subject || '(no subject)').slice(0, 998),
      who: (row.who ?? '').slice(0, 320),
      lastMessageAt: iso(row.last_message_at),
      section,
      state,
      score,
      reasons: reasons.slice(0, 6).map((reason) => reason.slice(0, 120)),
      deadlineAt: isoOrNull(row.deadline_at),
      draftReady: Boolean(row.draft_id),
      followUpDueAt: isoOrNull(row.follow_due),
      draftId: row.draft_id,
      draftStatus: row.draft_status,
      approvalId: row.approval_id,
      lastMessageFromOwner: Boolean(row.last_message_from_owner),
    });
  }
  return {
    sections: FOCUS_SECTIONS.map((id) => ({
      id,
      label: FOCUS_SECTION_LABELS[id],
      items: buckets
        .get(id)!
        .sort((a, b) => b.score - a.score || b.lastMessageAt.localeCompare(a.lastMessageAt))
        .slice(0, input.limit),
    })),
  };
}

export async function focusCoverage(tx: SqlExecutor): Promise<{ syncedAccounts: number; since: string | null; note: string }> {
  const rows = await tx.query<{ n: number; since: unknown; unhealthy: number }>(
    `select count(*)::int as n, min(s.coverage_since) as since, count(*) filter (where s.state in ('stalled', 'degraded', 'recovering'))::int as unhealthy
       from public.mail_accounts a join public.gmail_sync_state s on s.mail_account_id = a.id where a.status = 'active'`,
  );
  const row = rows[0];
  const n = num(row?.n);
  const since = isoOrNull(row?.since);
  const note = !n
    ? 'No Google account is connected, so this queue only reflects mail on this computer.'
    : num(row?.unhealthy) > 0
      ? 'Some mail may be out of date or is still being imported, so this list may be incomplete.'
      : since
        ? `Based on mail since ${since.slice(0, 10)}.`
        : 'Getting your inbox ready for the first time.';
  return { syncedAccounts: n, since, note };
}
