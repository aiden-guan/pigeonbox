import { iso, type SqlExecutor } from '../db/sql.js';

/**
 * Engagement analytics from hosted tracking, synced replies and follow-ups.
 *
 * Tracking numbers come from each email's counters, which the tracker derives
 * with protocol v3 classification: sender self-views, delivery prefetches,
 * scanners and unknown clients are excluded, and re-classified events drop
 * out. An "open detection" means the message was displayed (often through
 * Gmail's image proxy), not that a person read it, so no rate here is labeled
 * a human open rate. Replies come from synced mail, not from tracking.
 */

export type EngagementRow = {
  key: string;
  sent: number;
  /** Counted open detections (protocol v3). */
  opens: number;
  /** Tracked emails with at least one counted open detection. */
  emailsOpened: number;
  /** Counted link clicks (protocol v3). */
  clicks: number;
  /** Tracked emails with at least one counted click. */
  emailsClicked: number;
  /** Median minutes from send to the first counted open, over emails with one. */
  medianFirstOpenMinutes: number | null;
  replies: number;
  medianResponseHours: number | null;
  followUpsDue: number;
  followUpsAnswered: number;
};

type Tracked = {
  tracking_id: string;
  first_recipient: string | null;
  gmail_thread_id: string | null;
  sent_at: unknown;
  open_count: number;
  click_count: number;
  first_opened_at: unknown;
};

/** Tracked emails read per request. The note below says when a period has more. */
const TRACKED_LIMIT = 5000;

function median(values: number[]): number | null {
  if (!values.length) return null;
  const sorted = [...values].sort((a, b) => a - b);
  const mid = Math.floor(sorted.length / 2);
  return sorted.length % 2 ? sorted[mid]! : (sorted[mid - 1]! + sorted[mid]!) / 2;
}

const round1 = (value: number | null) => (value === null ? null : Math.round(value * 10) / 10);

export async function engagement(tx: SqlExecutor, input: { from: Date; to: Date; groupBy: 'day' | 'contact' | 'domain' }) {
  // Counters only: no event rows are loaded. RLS limits every row to the caller.
  const tracked = await tx.query<Tracked>(
    `select tracking_id, lower(recipients->>0) as first_recipient, gmail_thread_id, sent_at, open_count, click_count, first_opened_at
       from public.tracked_emails
      where status = 'SENT' and sent_at between $1::timestamptz and $2::timestamptz
      order by sent_at limit ${TRACKED_LIMIT}`,
    [input.from, input.to],
  );
  const replies = await tx.query<{ gmail_thread_id: string; first_reply: unknown }>(
    `select t.gmail_thread_id, min(m.internal_date) as first_reply from public.threads t join public.message_metadata m on m.thread_id = t.id and m.direction = 'inbound'
      where t.last_outbound_at is not null and m.internal_date between $1::timestamptz and $2::timestamptz + interval '30 days' group by t.gmail_thread_id`,
    [input.from, input.to],
  );
  const follows = await tx.query<{ gmail_thread_id: string; stage: string; notified: boolean }>(
    `select t.gmail_thread_id, f.stage, f.notified_at is not null as notified from public.follow_ups f join public.threads t on t.id = f.thread_id where f.last_outbound_at between $1::timestamptz and $2::timestamptz`,
    [input.from, input.to],
  );
  const replyAt = new Map(replies.map((row) => [row.gmail_thread_id, Date.parse(iso(row.first_reply))]));
  const followBy = new Map(follows.map((row) => [row.gmail_thread_id, row]));

  type Group = EngagementRow & { responseHours: number[]; firstOpenMinutes: number[] };
  const groups = new Map<string, Group>();
  const allFirstOpenMinutes: number[] = [];
  const keyFor = (row: Tracked) => {
    const first = row.first_recipient || 'unknown';
    if (input.groupBy === 'contact') return first;
    if (input.groupBy === 'domain') return first.split('@')[1] || 'unknown';
    return iso(row.sent_at).slice(0, 10);
  };
  for (const row of tracked) {
    const key = keyFor(row);
    const group: Group = groups.get(key) ?? {
      key, sent: 0, opens: 0, emailsOpened: 0, clicks: 0, emailsClicked: 0, medianFirstOpenMinutes: null,
      replies: 0, medianResponseHours: null, followUpsDue: 0, followUpsAnswered: 0, responseHours: [], firstOpenMinutes: [],
    };
    const opens = Number(row.open_count) || 0;
    const clicks = Number(row.click_count) || 0;
    group.sent += 1;
    group.opens += opens;
    group.clicks += clicks;
    if (opens > 0) group.emailsOpened += 1;
    if (clicks > 0) group.emailsClicked += 1;
    const sentMs = Date.parse(iso(row.sent_at));
    if (opens > 0 && row.first_opened_at) {
      const minutes = (Date.parse(iso(row.first_opened_at)) - sentMs) / 60_000;
      if (Number.isFinite(minutes) && minutes >= 0) {
        group.firstOpenMinutes.push(minutes);
        allFirstOpenMinutes.push(minutes);
      }
    }
    const thread = row.gmail_thread_id?.replace(/^(thread-f:|#)/, '');
    const reply = thread ? replyAt.get(thread) : undefined;
    if (reply && reply > sentMs) {
      group.replies += 1;
      group.responseHours.push((reply - sentMs) / 3_600_000);
    }
    const follow = thread ? followBy.get(thread) : undefined;
    if (follow?.notified) {
      group.followUpsDue += 1;
      if (follow.stage === 'reply') group.followUpsAnswered += 1;
    }
    groups.set(key, group);
  }
  const rows: EngagementRow[] = [...groups.values()].map(({ responseHours, firstOpenMinutes, ...row }) => ({
    ...row,
    medianFirstOpenMinutes: round1(median(firstOpenMinutes)),
    medianResponseHours: round1(median(responseHours)),
  }));
  rows.sort((a, b) => (input.groupBy === 'day' ? a.key.localeCompare(b.key) : b.sent - a.sent));
  const totals: Record<string, number> = rows.reduce(
    (sum, row) => ({
      sent: sum.sent + row.sent,
      opens: sum.opens + row.opens,
      emailsOpened: sum.emailsOpened + row.emailsOpened,
      clicks: sum.clicks + row.clicks,
      emailsClicked: sum.emailsClicked + row.emailsClicked,
      replies: sum.replies + row.replies,
      followUpsDue: sum.followUpsDue + row.followUpsDue,
      followUpsAnswered: sum.followUpsAnswered + row.followUpsAnswered,
    }),
    { sent: 0, opens: 0, emailsOpened: 0, clicks: 0, emailsClicked: 0, replies: 0, followUpsDue: 0, followUpsAnswered: 0 },
  );
  const overallMedian = round1(median(allFirstOpenMinutes));
  if (overallMedian !== null) totals.medianFirstOpenMinutes = overallMedian;
  const notes = [
    'Open detections count image loads the tracker attributes to recipients, including Gmail’s image proxy. They show a message was displayed, not that someone read it. Your own views, delivery prefetches, scanners and unknown clients are excluded.',
    'One tracking image is shared by everyone on an email, so activity on a message sent to several people is grouped by its first recipient and cannot be tied to one person.',
    'Replies come from synced mail and count the first reply in the thread after you sent.',
  ];
  if (tracked.length >= TRACKED_LIMIT) notes.push(`Only the first ${TRACKED_LIMIT.toLocaleString('en-US')} tracked emails in this period are included. Choose a shorter period for complete totals.`);
  return { rows: rows.slice(0, 1000), totals, notes };
}

function csvCell(value: unknown): string {
  const text = value === null || value === undefined ? '' : String(value);
  // Neutralize spreadsheet formulas and quote everything.
  const safe = /^[=+\-@\t\r]/.test(text) ? `'${text}` : text;
  return `"${safe.replace(/"/g, '""')}"`;
}

export function toCsv(rows: EngagementRow[], groupBy: string): string {
  const header = [groupBy, 'sent', 'open_detections', 'emails_with_open', 'link_clicks', 'emails_with_click', 'median_minutes_to_first_open', 'replies', 'median_response_hours', 'follow_ups_due', 'follow_ups_answered'];
  const lines = rows.map((row) => [row.key, row.sent, row.opens, row.emailsOpened, row.clicks, row.emailsClicked, row.medianFirstOpenMinutes, row.replies, row.medianResponseHours, row.followUpsDue, row.followUpsAnswered].map(csvCell).join(','));
  return [header.map(csvCell).join(','), ...lines].join('\r\n');
}

export async function recentActivity(tx: SqlExecutor, limit: number) {
  const rows = await tx.query<{ at: unknown; kind: string; label: string; gmail_thread_id: string | null }>(
    `select at, kind, label, gmail_thread_id from public.relationship_events order by at desc limit $1`,
    [limit],
  );
  return rows.map((row) => ({ at: iso(row.at), kind: row.kind, label: row.label, threadId: row.gmail_thread_id }));
}

