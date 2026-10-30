import { iso, isoOrNull, num, type SqlExecutor } from '../db/sql.js';
import { MAIL_SYNC_JOB_KINDS, PROCESSING_JOB_KINDS } from './connections.js';

/**
 * One health model for the dashboard, derived only from state that already
 * exists (`mail_accounts`, `gmail_sync_state`, `calendar_sync_state`, `jobs`).
 * Nothing here writes, and nothing here is stored: health is recomputed on
 * read, so it can never drift from the sync and job state it describes.
 *
 * A healthy-looking connection is not proof that mail is current. Mail is
 * only "healthy" when Gmail's latest pushed cursor has been processed, a sync
 * completed recently, and no sync work is queued.
 */

export const HEALTH_LEVELS = ['healthy', 'syncing', 'degraded', 'stale', 'action_required', 'failed'] as const;
export type HealthLevel = (typeof HEALTH_LEVELS)[number];

/** Worst first wins. `action_required` outranks `stale` because only the person can fix it. */
const SEVERITY: Record<HealthLevel, number> = { healthy: 0, syncing: 1, degraded: 2, stale: 3, action_required: 4, failed: 5 };
export const worst = (levels: readonly HealthLevel[]): HealthLevel => levels.reduce<HealthLevel>((a, b) => (SEVERITY[b] > SEVERITY[a] ? b : a), 'healthy');

/** Thresholds, in minutes. Maintenance re-syncs any account idle for 6 hours; calendar refreshes every 15 minutes. */
export const HEALTH_THRESHOLDS = {
  /** Pushed history not processed within this long means sync is behind, whatever the state column says. */
  pushUnprocessedMinutes: 15,
  /** No completed sync for this long (the 6-hour safety resync plus slack). */
  syncOverdueMinutes: 7 * 60,
  /** Calendar refresh runs every 15 minutes. */
  calendarStaleMinutes: 60,
  /** An analysis job waiting longer than this is "delayed", not "catching up". */
  analysisDelayedMinutes: 30,
  /** Consecutive sync failures before a still-"healthy" connection counts as failed. */
  failedAfterConsecutiveFailures: 5,
} as const;

/** Google reports these when the stored grant no longer works; only reconnecting fixes them. */
const REAUTH_CODES = new Set(['needs_reauth', 'invalid_grant', 'auth_revoked', 'google_auth', 'insufficient_scope']);

export type MailHealthInput = {
  accountId: string;
  email: string;
  status: string;
  features: string[];
  syncState: string | null;
  historyId: string | null;
  lastPushHistoryId: string | null;
  lastPushAt: string | null;
  lastSyncCompletedAt: string | null;
  watchExpiresAt: string | null;
  consecutiveFailures: number;
  lastErrorCode: string | null;
  coverageSince: string | null;
  syncBacklog: number;
  processingBacklog: number;
  oldestProcessingAt: string | null;
  deadSyncJobs24h: number;
  deadProcessingJobs24h: number;
  calendarLastRefreshAt: string | null;
  calendarErrorCode: string | null;
  calendarUpdatedAt: string | null;
};

export type IntelligenceInput = {
  memoryEnabled: boolean;
  memoryPending: number;
  draftsPreparing: number;
  deadBackgroundJobs24h: number;
};

export type MailHealth = {
  accountId: string;
  email: string;
  level: HealthLevel;
  /** Fixed reason codes for tests and operators; never content. */
  reasons: string[];
  lastPushAt: string | null;
  lastSyncAt: string | null;
  /** Gmail has told us about newer history than has been processed. */
  cursorBehind: boolean;
  backfill: 'running' | 'complete';
  coverageSince: string | null;
  syncBacklog: number;
  processingBacklog: number;
  deadJobs24h: number;
};

export type CalendarHealth = { accountId: string; email: string; level: HealthLevel; reasons: string[]; lastRefreshAt: string | null };

export type IntelligenceHealth = {
  level: HealthLevel;
  reasons: string[];
  analysisBacklog: number;
  oldestPendingMinutes: number | null;
  memoryPending: number;
  draftsPreparing: number;
  deadJobs24h: number;
};

export type CloudHealth = {
  generatedAt: string;
  level: HealthLevel;
  title: string;
  detail: string;
  /** Which component decided the top-level status; null when everything is healthy. */
  cause: 'mail' | 'calendar' | 'intelligence' | 'connection' | null;
  mail: MailHealth[];
  calendar: CalendarHealth[];
  intelligence: IntelligenceHealth;
};

const minutesSince = (value: string | null, now: Date): number | null => (value ? (now.getTime() - Date.parse(value)) / 60_000 : null);

/** Gmail history IDs are decimal strings up to 20 digits; compare without losing precision. */
export function historyAhead(pushed: string | null, processed: string | null): boolean {
  if (!pushed) return false;
  if (!processed) return true;
  try {
    return BigInt(pushed) > BigInt(processed);
  } catch {
    return false;
  }
}

export function deriveMailHealth(input: MailHealthInput, now: Date): MailHealth {
  const t = HEALTH_THRESHOLDS;
  const reasons: string[] = [];
  const levels: HealthLevel[] = [];
  const add = (level: HealthLevel, reason: string) => {
    levels.push(level);
    reasons.push(reason);
  };
  const cursorBehind = historyAhead(input.lastPushHistoryId, input.historyId);
  const backfill = input.syncState === 'initializing' || (input.syncState === 'recovering' && !input.coverageSince) ? 'running' : 'complete';

  if (input.status === 'needs_reauth' || (input.lastErrorCode && REAUTH_CODES.has(input.lastErrorCode))) add('action_required', 'mail_needs_reauth');
  else if (input.status === 'paused' || input.syncState === 'paused') add('action_required', 'mail_paused');
  else if (input.status === 'error' || input.syncState === 'stalled') add('failed', 'mail_sync_stalled');
  else {
    if (input.consecutiveFailures >= t.failedAfterConsecutiveFailures) add('failed', 'mail_sync_failing');
    else if (input.consecutiveFailures > 0) add('degraded', 'mail_sync_retrying');
    if (input.syncState === 'degraded') add('degraded', 'mail_sync_degraded');
    if (backfill === 'running') add('syncing', 'mail_backfill_running');
    else if (input.syncState === 'recovering') add('syncing', 'mail_recovering');
    if (input.syncState === 'catching_up' || input.syncBacklog > 0) add('syncing', 'mail_catching_up');
    // Processing is current only when what Gmail pushed has been read.
    const pushAge = minutesSince(input.lastPushAt, now);
    if (cursorBehind && pushAge !== null && pushAge > t.pushUnprocessedMinutes && input.syncBacklog === 0) add('stale', 'mail_push_unprocessed');
    else if (cursorBehind) add('syncing', 'mail_push_pending');
    const syncAge = minutesSince(input.lastSyncCompletedAt, now);
    if (backfill === 'complete' && (syncAge === null || syncAge > t.syncOverdueMinutes)) add('stale', 'mail_sync_overdue');
    if (input.features.includes('mail_read') && (!input.watchExpiresAt || Date.parse(input.watchExpiresAt) < now.getTime())) add('degraded', 'mail_watch_expired');
    if (input.deadSyncJobs24h > 0 && (syncAge === null || input.lastSyncCompletedAt === null || syncAge > 60)) add('degraded', 'mail_dead_sync_jobs');
  }
  return {
    accountId: input.accountId,
    email: input.email,
    level: worst(levels),
    reasons,
    lastPushAt: input.lastPushAt,
    lastSyncAt: input.lastSyncCompletedAt,
    cursorBehind,
    backfill,
    coverageSince: input.coverageSince,
    syncBacklog: input.syncBacklog,
    processingBacklog: input.processingBacklog,
    deadJobs24h: input.deadSyncJobs24h + input.deadProcessingJobs24h,
  };
}

export function deriveCalendarHealth(input: MailHealthInput, now: Date): CalendarHealth | null {
  if (!input.features.includes('calendar_read')) return null;
  const reasons: string[] = [];
  const levels: HealthLevel[] = [];
  const add = (level: HealthLevel, reason: string) => {
    levels.push(level);
    reasons.push(reason);
  };
  if (input.status === 'needs_reauth') add('action_required', 'calendar_needs_reauth');
  else if (input.status === 'paused') add('action_required', 'calendar_paused');
  else {
    // An error recorded after the last successful refresh is current.
    const errorCurrent = Boolean(input.calendarErrorCode) && (!input.calendarLastRefreshAt || (input.calendarUpdatedAt !== null && Date.parse(input.calendarUpdatedAt) > Date.parse(input.calendarLastRefreshAt)));
    if (errorCurrent && REAUTH_CODES.has(input.calendarErrorCode!)) add('action_required', 'calendar_needs_reauth');
    else if (errorCurrent) add('degraded', 'calendar_refresh_failed');
    const age = minutesSince(input.calendarLastRefreshAt, now);
    if (age === null) {
      if (!errorCurrent) add('syncing', 'calendar_first_refresh');
    } else if (age > HEALTH_THRESHOLDS.calendarStaleMinutes) add('stale', 'calendar_stale');
  }
  return { accountId: input.accountId, email: input.email, level: worst(levels), reasons, lastRefreshAt: input.calendarLastRefreshAt };
}

export function deriveIntelligenceHealth(accounts: readonly MailHealthInput[], input: IntelligenceInput, now: Date): IntelligenceHealth {
  const reasons: string[] = [];
  const levels: HealthLevel[] = [];
  const analysisBacklog = accounts.reduce((sum, account) => sum + account.processingBacklog, 0);
  const oldest = accounts.map((account) => account.oldestProcessingAt).filter((value): value is string => Boolean(value)).sort()[0] ?? null;
  const oldestPendingMinutes = oldest ? Math.max(0, Math.round(minutesSince(oldest, now)!)) : null;
  if (analysisBacklog > 0) {
    if (oldestPendingMinutes !== null && oldestPendingMinutes > HEALTH_THRESHOLDS.analysisDelayedMinutes) {
      levels.push('degraded');
      reasons.push('analysis_delayed');
    } else {
      levels.push('syncing');
      reasons.push('analysis_catching_up');
    }
  }
  if (input.memoryEnabled && input.memoryPending > 0) {
    levels.push('syncing');
    reasons.push('memory_indexing');
  }
  if (input.draftsPreparing > 0) reasons.push('drafts_preparing');
  const deadProcessing = accounts.reduce((sum, account) => sum + account.deadProcessingJobs24h, 0) + input.deadBackgroundJobs24h;
  if (deadProcessing > 0) {
    levels.push('degraded');
    reasons.push('background_jobs_failed');
  }
  return { level: worst(levels), reasons, analysisBacklog, oldestPendingMinutes, memoryPending: input.memoryPending, draftsPreparing: input.draftsPreparing, deadJobs24h: deadProcessing };
}

/** Plain, short, and the same words in every surface. Internal codes stay in `reasons`. */
export function summarizeHealth(mail: readonly MailHealth[], calendar: readonly CalendarHealth[], intelligence: IntelligenceHealth, now: Date): CloudHealth {
  const base = { generatedAt: now.toISOString(), mail: [...mail], calendar: [...calendar], intelligence };
  if (mail.length === 0) return { ...base, level: 'action_required', cause: 'connection', title: 'Connect Google', detail: 'Connect a Gmail account so your PigeonBox server can keep up with your mail.' };
  const level = worst([...mail.map((item) => item.level), ...calendar.map((item) => item.level), intelligence.level]);
  const mailReasons = new Set(mail.flatMap((item) => item.reasons));
  const calendarReasons = new Set(calendar.flatMap((item) => item.reasons));
  const mailLevel = worst(mail.map((item) => item.level));
  const calendarLevel = worst(calendar.map((item) => item.level));
  const cause = level === 'healthy' ? null : mailLevel === level ? 'mail' : calendarLevel === level ? 'calendar' : 'intelligence';
  const pick = (title: string, detail: string): CloudHealth => ({ ...base, level, cause, title, detail });
  switch (level) {
    case 'healthy':
      return pick('Everything is up to date', 'Mail, calendar and background work are current.');
    case 'action_required':
      if (mailReasons.has('mail_needs_reauth') || calendarReasons.has('calendar_needs_reauth')) return pick('Reconnect Google', 'Google stopped accepting PigeonBox’s access. Reconnect to resume syncing.');
      return pick('Sync is paused', 'Resume syncing to keep PigeonBox current.');
    case 'failed':
      return pick('Mail sync has stopped', 'PigeonBox could not sync recently. It keeps retrying; Resync or reconnect if this continues.');
    case 'stale':
      if (cause === 'calendar') return pick('Calendar may be out of date', 'PigeonBox has not refreshed your calendar recently.');
      return pick('Mail may be out of date', 'New mail has not been processed recently. PigeonBox keeps retrying.');
    case 'degraded':
      return pick('Some background work is delayed', 'Your mail is safe; some analysis or refreshes are running late.');
    case 'syncing':
      if (mailReasons.has('mail_backfill_running')) return pick('PigeonBox is catching up', 'Your first import is still running.');
      return pick('PigeonBox is catching up', 'Recent mail is being synced or reviewed.');
  }
}

type HealthRow = {
  id: string;
  email: string;
  status: string;
  features: string[];
  sync_state: string | null;
  history_id: string | null;
  last_push_history_id: string | null;
  last_push_at: unknown;
  last_sync_completed_at: unknown;
  watch_expires_at: unknown;
  consecutive_failures: number | null;
  sync_error: string | null;
  account_error: string | null;
  coverage_since: unknown;
  sync_backlog: number;
  processing_backlog: number;
  oldest_processing: unknown;
  dead_sync: number;
  dead_processing: number;
  cal_refresh: unknown;
  cal_error: string | null;
  cal_updated: unknown;
};

/** Read-only; runs in the caller's RLS transaction so every count is the person's own. */
export async function loadHealth(tx: SqlExecutor, now: Date, memoryEnabled: boolean): Promise<CloudHealth> {
  const rows = await tx.query<HealthRow>(
    `select a.id, a.email, a.status, a.features, s.state as sync_state, s.history_id::text as history_id,
            s.last_push_history_id::text as last_push_history_id, s.last_push_at, s.last_sync_completed_at, s.watch_expires_at,
            s.consecutive_failures, s.last_error_code as sync_error, a.last_error_code as account_error, s.coverage_since,
            (select count(*)::int from public.jobs j where j.mail_account_id = a.id and j.status in ('queued','retrying','running') and j.kind = any($1::text[])) as sync_backlog,
            (select count(distinct coalesce(j.payload->>'threadId', j.id::text))::int from public.jobs j
              where j.mail_account_id = a.id and j.status in ('queued','retrying','running') and j.kind = any($2::text[])) as processing_backlog,
            (select min(j.created_at) from public.jobs j where j.mail_account_id = a.id and j.status in ('queued','retrying','running') and j.kind = any($2::text[])) as oldest_processing,
            (select count(*)::int from public.jobs j where j.mail_account_id = a.id and j.status = 'dead' and j.kind = any($1::text[]) and j.updated_at > $3::timestamptz) as dead_sync,
            (select count(*)::int from public.jobs j where j.mail_account_id = a.id and j.status = 'dead' and j.kind = any($2::text[]) and j.updated_at > $3::timestamptz) as dead_processing,
            c.last_refresh_at as cal_refresh, c.last_error_code as cal_error, c.updated_at as cal_updated
       from public.mail_accounts a
       left join public.gmail_sync_state s on s.mail_account_id = a.id
       left join public.calendar_sync_state c on c.mail_account_id = a.id
      where a.status <> 'disconnected'
      order by a.connected_at`,
    [MAIL_SYNC_JOB_KINDS, PROCESSING_JOB_KINDS, new Date(now.getTime() - 86_400_000)],
  );
  const background = await tx.query<{ memory_pending: number; drafts_preparing: number; dead_background: number }>(
    `select (select count(*)::int from public.jobs where status in ('queued','retrying','running') and kind in ('memory.extract','memory.reindex','memory.consolidate')) as memory_pending,
            (select count(*)::int from public.jobs where status in ('queued','retrying','running') and kind = 'draft.prepare') as drafts_preparing,
            (select count(*)::int from public.jobs where status = 'dead' and kind in ('memory.extract','memory.reindex','draft.prepare','search.index') and updated_at > $1::timestamptz) as dead_background`,
    [new Date(now.getTime() - 86_400_000)],
  );
  const inputs: MailHealthInput[] = rows.map((row) => ({
    accountId: row.id,
    email: row.email,
    status: row.status,
    features: row.features ?? [],
    syncState: row.sync_state,
    historyId: row.history_id,
    lastPushHistoryId: row.last_push_history_id,
    lastPushAt: isoOrNull(row.last_push_at),
    lastSyncCompletedAt: isoOrNull(row.last_sync_completed_at),
    watchExpiresAt: isoOrNull(row.watch_expires_at),
    consecutiveFailures: num(row.consecutive_failures),
    lastErrorCode: row.status === 'needs_reauth' ? 'needs_reauth' : row.sync_error ?? row.account_error,
    coverageSince: isoOrNull(row.coverage_since),
    syncBacklog: num(row.sync_backlog),
    processingBacklog: num(row.processing_backlog),
    oldestProcessingAt: row.oldest_processing ? iso(row.oldest_processing) : null,
    deadSyncJobs24h: num(row.dead_sync),
    deadProcessingJobs24h: num(row.dead_processing),
    calendarLastRefreshAt: isoOrNull(row.cal_refresh),
    calendarErrorCode: row.cal_error,
    calendarUpdatedAt: isoOrNull(row.cal_updated),
  }));
  const extra = background[0];
  const mail = inputs.map((input) => deriveMailHealth(input, now));
  const calendar = inputs.map((input) => deriveCalendarHealth(input, now)).filter((item): item is CalendarHealth => item !== null);
  const intelligence = deriveIntelligenceHealth(inputs, { memoryEnabled, memoryPending: num(extra?.memory_pending), draftsPreparing: num(extra?.drafts_preparing), deadBackgroundJobs24h: num(extra?.dead_background) }, now);
  return summarizeHealth(mail, calendar, intelligence, now);
}
