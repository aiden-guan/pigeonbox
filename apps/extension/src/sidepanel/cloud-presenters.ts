/**
 * Plain-language presentation of Cloud state. Pure functions, so the words a
 * person reads are tested apart from React. Backend vocabulary (jobs,
 * backlogs, analysis, sync states) stops here.
 */
import { syncPhase, type CloudDraft, type CloudOverview, type DraftKind, type FocusItem, type MailAccount, type SyncPhase } from '@pigeonbox/api-contract';
import { findPlaceholders } from '@pigeonbox/shared';

const DAY = 86_400_000;

export type StatusTone = 'ok' | 'working' | 'attention' | 'paused' | 'unknown';
export type MailStatus = {
  tone: StatusTone;
  title: string;
  detail: string;
  /** Where to fix it, when the person has to act. */
  action: { label: string; section: 'connections' } | null;
};

/** "2m ago", "just now", "3h ago", "Oct 2" for anything older than a week. */
export function ago(value: string | null | undefined, now = Date.now()): string {
  const time = value ? Date.parse(value) : NaN;
  if (!Number.isFinite(time)) return '';
  const minutes = Math.round((now - time) / 60_000);
  if (minutes < 1) return 'just now';
  if (minutes < 60) return `${minutes}m ago`;
  const hours = Math.round(minutes / 60);
  if (hours < 24) return `${hours}h ago`;
  const days = Math.round(hours / 24);
  if (days < 7) return `${days}d ago`;
  return new Intl.DateTimeFormat(undefined, { month: 'short', day: 'numeric' }).format(new Date(time));
}

/** "Since 9:12 PM", "Since yesterday, 9:12 PM", "Since Sep 28". */
export function sinceLabel(value: string, now = Date.now()): string {
  const time = Date.parse(value);
  if (!Number.isFinite(time)) return '';
  const at = new Date(time);
  const clock = new Intl.DateTimeFormat(undefined, { hour: 'numeric', minute: '2-digit' }).format(at);
  const today = new Date(now);
  const sameDay = (a: Date, b: Date) => a.toDateString() === b.toDateString();
  if (sameDay(at, today)) return `Since ${clock}`;
  if (sameDay(at, new Date(now - DAY))) return `Since yesterday, ${clock}`;
  return `Since ${new Intl.DateTimeFormat(undefined, { month: 'short', day: 'numeric' }).format(at)}`;
}

const plural = (count: number, one: string, many = `${one}s`) => `${count} ${count === 1 ? one : many}`;

/** Most urgent first: one account that needs the person outranks everything that is fine. */
const PHASE_ORDER: SyncPhase[] = ['needs_reauth', 'stalled', 'degraded', 'importing', 'recovering', 'catching_up', 'analyzing', 'paused', 'up_to_date'];

function lastUpdated(accounts: MailAccount[]): string | null {
  // The oldest account decides how current "your mail" is.
  let oldest: number | null = null;
  for (const account of accounts) {
    const times = [account.sync.lastSyncAt, account.sync.lastPushAt].map((value) => (value ? Date.parse(value) : NaN)).filter(Number.isFinite);
    if (!times.length) continue;
    const latest = Math.max(...times);
    oldest = oldest === null ? latest : Math.min(oldest, latest);
  }
  return oldest === null ? null : new Date(oldest).toISOString();
}

/**
 * The compact status line. `accounts` null means the server could not say;
 * `refreshFailed` means what is shown is the last loaded data, never presented as current.
 */
export function mailStatus(input: { accounts: MailAccount[] | null | undefined; loading?: boolean; refreshFailed?: boolean; checkedAt?: string | null }, now = Date.now()): MailStatus {
  if (input.accounts === undefined) {
    return input.loading
      ? { tone: 'unknown', title: 'Checking Cloud…', detail: '', action: null }
      : { tone: 'attention', title: 'Cloud unavailable', detail: 'Cloud could not be reached.', action: null };
  }
  if (input.refreshFailed) {
    return { tone: 'attention', title: 'Could not refresh', detail: input.checkedAt ? `Last checked ${ago(input.checkedAt, now)}` : 'Showing the last loaded data', action: null };
  }
  if (input.accounts === null) return { tone: 'unknown', title: 'Mail status unavailable', detail: 'Refresh to try again.', action: null };
  const accounts = input.accounts.filter((account) => account.status !== 'disconnected');
  if (!accounts.length) return { tone: 'attention', title: 'Connect Google', detail: 'Mail is not syncing yet.', action: { label: 'Connect', section: 'connections' } };

  const phased = accounts.map((account) => ({ account, phase: syncPhase(account) }));
  const phase = PHASE_ORDER.find((candidate) => phased.some((item) => item.phase === candidate)) ?? 'up_to_date';
  const affected = phased.filter((item) => item.phase === phase).map((item) => item.account);
  const who = accounts.length > 1 ? `${affected[0]!.email}: ` : '';
  const active = accounts.filter((account) => account.status === 'active');
  const updated = lastUpdated(active.length ? active : accounts);
  const updatedLine = updated ? `Mail updated ${ago(updated, now)}` : 'Mail is current';

  switch (phase) {
    case 'needs_reauth':
      return { tone: 'attention', title: 'Needs attention', detail: `${who}Reconnect your Google account`, action: { label: 'Reconnect', section: 'connections' } };
    case 'stalled':
      return { tone: 'attention', title: 'Connection needs attention', detail: `${who}Mail may be out of date`, action: { label: 'Fix connection', section: 'connections' } };
    case 'degraded':
      return { tone: 'attention', title: 'Mail may be out of date', detail: `${who}PigeonBox is retrying the connection`, action: { label: 'Details', section: 'connections' } };
    case 'importing': {
      const imported = affected.reduce((total, account) => total + account.sync.threadsTracked, 0);
      // Gmail does not report a reliable total, so this never claims "of N".
      return { tone: 'working', title: 'Getting your inbox ready', detail: imported ? `${plural(imported, 'recent conversation')} imported so far` : 'Importing recent conversations', action: null };
    }
    case 'recovering':
      return { tone: 'working', title: 'Refreshing your mail', detail: updatedLine, action: null };
    case 'catching_up':
      return { tone: 'working', title: 'Catching up on new mail', detail: updatedLine, action: null };
    case 'analyzing': {
      const reviewing = phased.reduce((total, item) => total + (item.account.sync.processingBacklog ?? 0), 0);
      return { tone: 'ok', title: 'Mail up to date', detail: reviewing ? `Reviewing ${plural(reviewing, 'new conversation')}` : updatedLine, action: null };
    }
    case 'paused':
      return active.length
        ? { tone: 'ok', title: 'Up to date', detail: `${updatedLine} · ${plural(affected.length, 'account')} paused`, action: null }
        : { tone: 'paused', title: 'Mail sync paused', detail: 'Resume it in connection settings', action: { label: 'Manage', section: 'connections' } };
    default:
      return { tone: 'ok', title: 'Up to date', detail: updatedLine, action: null };
  }
}

// ---------------------------------------------------------------------------
// Ready for you
// ---------------------------------------------------------------------------

export type ReadyAction = { kind: 'approval'; label: 'Review approval'; approvalId: string } | { kind: 'draft'; label: 'Review draft' } | { kind: 'thread'; label: 'Open thread' };
export type ReadyItem = { flags: Array<{ text: string; urgent: boolean }>; reason: string | null; action: ReadyAction };

function dueLabel(deadline: string, now: number): { text: string; urgent: boolean } | null {
  const at = Date.parse(deadline);
  if (!Number.isFinite(at)) return null;
  if (at < now) return { text: 'Deadline passed', urgent: true };
  const today = new Date(now);
  const day = new Date(at);
  const startOfToday = new Date(today.getFullYear(), today.getMonth(), today.getDate()).getTime();
  const days = Math.floor((new Date(day.getFullYear(), day.getMonth(), day.getDate()).getTime() - startOfToday) / DAY);
  if (days <= 0) return { text: 'Due today', urgent: true };
  if (days === 1) return { text: 'Due tomorrow', urgent: true };
  return { text: `Due ${new Intl.DateTimeFormat(undefined, { weekday: 'short', month: 'short', day: 'numeric' }).format(day)}`, urgent: false };
}

/** Reasons already said by a flag; the remaining top reason explains why it matters. */
const COVERED = [/deadline|^due /i, /draft is ready/i, /follow-up is due/i, /^unanswered for/i];

/** Who, what, why, whether a reply is prepared, and the one action that fits. */
export function readyItem(item: FocusItem, now = Date.now()): ReadyItem {
  const flags: ReadyItem['flags'] = [];
  if (item.approvalId) flags.push({ text: 'Approval needed', urgent: true });
  if (item.draftReady) flags.push({ text: item.draftStatus === 'placed' ? 'Reply in Gmail' : 'Reply prepared', urgent: false });
  if (item.deadlineAt) {
    const due = dueLabel(item.deadlineAt, now);
    if (due) flags.push(due);
  }
  const waitingOnThem = item.section === 'waiting' || (item.lastMessageFromOwner === true && item.state === 'WAITING_ON_THEM');
  if (item.followUpDueAt && item.section === 'follow_up') flags.push({ text: 'Follow-up due', urgent: Date.parse(item.followUpDueAt) <= now });
  else if (waitingOnThem) {
    const days = Math.floor((now - Date.parse(item.lastMessageAt)) / DAY);
    flags.push({ text: days >= 1 ? `Waiting ${plural(days, 'day')} for a reply` : 'Waiting for a reply', urgent: false });
  } else if (item.state === 'NEEDS_REPLY' && !item.draftReady) flags.push({ text: 'Needs your reply', urgent: false });

  const reason = item.reasons.find((text) => !COVERED.some((pattern) => pattern.test(text))) ?? null;
  const action: ReadyAction = item.approvalId
    ? { kind: 'approval', label: 'Review approval', approvalId: item.approvalId }
    : item.draftReady
      ? { kind: 'draft', label: 'Review draft' }
      : { kind: 'thread', label: 'Open thread' };
  return { flags, reason, action };
}

/** Focus Queue items in one ranked list: approvals and prepared replies lead, then urgency. */
export function readyList(overview: Pick<CloudOverview, 'focus'>, limit = 6): FocusItem[] {
  const weight = (item: FocusItem) => (item.approvalId ? 2 : 0) + (item.draftReady ? 1 : 0);
  return (overview.focus?.sections ?? [])
    .flatMap((section) => section.items)
    .sort((a, b) => weight(b) - weight(a) || b.score - a.score)
    .slice(0, limit);
}

// ---------------------------------------------------------------------------
// Prepared for you, and while you were away
// ---------------------------------------------------------------------------

export type PreparedRow = { id: 'drafts_ready' | 'drafts_gmail' | 'drafts_update' | 'drafts_preparing' | 'followups' | 'approvals'; count: number; label: string; target: { view: 'drafts'; filter: DraftFilter } | { view: 'activity' } | { view: 'approvals' } };

export function preparedRows(overview: Pick<CloudOverview, 'prepared' | 'work'>): PreparedRow[] {
  const prepared = overview.prepared;
  const drafts = prepared?.drafts;
  const approvals = prepared?.approvalsWaiting ?? overview.work?.approvalsWaiting ?? 0;
  const rows: PreparedRow[] = [
    { id: 'approvals', count: approvals, label: approvals === 1 ? 'approval waiting' : 'approvals waiting', target: { view: 'approvals' } },
    { id: 'drafts_ready', count: drafts?.ready ?? 0, label: (drafts?.ready ?? 0) === 1 ? 'reply ready to review' : 'replies ready to review', target: { view: 'drafts', filter: 'ready' } },
    { id: 'drafts_update', count: drafts?.needsUpdate ?? 0, label: (drafts?.needsUpdate ?? 0) === 1 ? 'draft needs an update' : 'drafts need an update', target: { view: 'drafts', filter: 'update' } },
    { id: 'drafts_gmail', count: drafts?.inGmail ?? 0, label: (drafts?.inGmail ?? 0) === 1 ? 'draft in Gmail' : 'drafts in Gmail', target: { view: 'drafts', filter: 'gmail' } },
    { id: 'followups', count: prepared?.followUpsOpen ?? 0, label: (prepared?.followUpsOpen ?? 0) === 1 ? 'follow-up tracked' : 'follow-ups tracked', target: { view: 'activity' } },
  ];
  return rows.filter((row) => row.count > 0);
}

/** "Reviewed 18 conversations", ... Empty when nothing happened, so zeros never render. */
export function awaySummary(work: CloudOverview['work']): string[] {
  if (!work) return [];
  return [
    work.threadsAnalyzed ? `Reviewed ${plural(work.threadsAnalyzed, 'conversation')}` : '',
    work.draftsPrepared ? `Prepared ${plural(work.draftsPrepared, 'reply', 'replies')}` : '',
    work.followUpsDetected ? `Found ${plural(work.followUpsDetected, 'follow-up')}` : '',
  ].filter(Boolean);
}

// ---------------------------------------------------------------------------
// Drafts
// ---------------------------------------------------------------------------

export type DraftFilter = 'ready' | 'gmail' | 'update';
export const DRAFT_FILTERS: Array<{ id: DraftFilter; label: string; statuses: Array<'preparing' | 'ready' | 'stale' | 'user_edited' | 'placed' | 'failed'> }> = [
  { id: 'ready', label: 'Ready', statuses: ['ready', 'preparing'] },
  { id: 'gmail', label: 'In Gmail', statuses: ['placed', 'user_edited'] },
  { id: 'update', label: 'Needs update', statuses: ['stale', 'failed'] },
];

export function draftFilterCount(filter: DraftFilter, counts: Record<string, number>): number {
  return DRAFT_FILTERS.find((item) => item.id === filter)!.statuses.reduce((total, status) => total + (counts[status] ?? 0), 0);
}

const STATE_LABEL: Record<CloudDraft['status'], string> = {
  preparing: 'Preparing',
  ready: 'Ready',
  stale: 'Needs update',
  user_edited: 'Edited in Gmail',
  placed: 'In Gmail',
  sent: 'Sent',
  discarded: 'Dismissed',
  failed: 'Could not prepare',
};
export function draftStateLabel(draft: Pick<CloudDraft, 'status'>): string {
  return STATE_LABEL[draft.status];
}

const KIND_LABEL: Record<DraftKind, string> = { reply: 'Reply', follow_up: 'Follow-up', scheduling: 'Scheduling reply', acknowledgment: 'Acknowledgment', info_request: 'Request for details' };
/** Only when it adds something: a plain reply needs no label. */
export function draftKindLabel(kind: DraftKind): string | null {
  return kind === 'reply' ? null : KIND_LABEL[kind];
}

/** Where the draft lives. Prepared, In Gmail and Sent are never conflated. */
export function placementLine(draft: Pick<CloudDraft, 'status' | 'gmailDraftId' | 'freshness'>): string {
  if (draft.status === 'user_edited') return 'You edited this draft in Gmail, so PigeonBox will not change it.';
  if (draft.status === 'sent') return 'Sent.';
  if (draft.status === 'placed') return 'In your Gmail Drafts folder. Nothing is sent automatically.';
  if (draft.status === 'stale') return draft.freshness.staleReason ? `Needs update: ${draft.freshness.staleReason.replace(/\.$/, '')}.` : 'Needs update: the conversation changed.';
  if (draft.status === 'failed') return 'This reply could not be prepared.';
  if (draft.status === 'preparing') return 'Preparing this reply…';
  if (draft.gmailDraftId) return 'Gmail has an earlier version of this draft.';
  return 'Prepared in PigeonBox. Not in Gmail yet.';
}

export function preview(body: string | undefined, max = 160): string {
  const text = (body ?? '').replace(/\s+/g, ' ').trim();
  return text.length > max ? `${text.slice(0, max - 1).trimEnd()}…` : text;
}

/** Unique placeholder tokens still in the text, in order. */
export function openPlaceholders(text: string): string[] {
  return [...new Set(findPlaceholders(text).map((item) => item.token))];
}

export function personLabel(person: { email: string; name?: string } | null | undefined, fallback: string): string {
  return person?.name || person?.email || fallback;
}
