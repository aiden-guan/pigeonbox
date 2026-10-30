import { describe, expect, it } from 'vitest';
import { connectedUser, createIntelHarness, deliverAndSync } from '../testing/intel-harness.js';
import { deriveCalendarHealth, deriveIntelligenceHealth, deriveMailHealth, historyAhead, summarizeHealth, type CloudHealth, type MailHealthInput } from './health.js';

const NOW = new Date('2026-10-11T12:00:00.000Z');
const minutesAgo = (minutes: number) => new Date(NOW.getTime() - minutes * 60_000).toISOString();

const healthy = (patch: Partial<MailHealthInput> = {}): MailHealthInput => ({
  accountId: '00000000-0000-4000-8000-000000000001',
  email: 'ada@work.test',
  status: 'active',
  features: ['mail_read', 'calendar_read'],
  syncState: 'healthy',
  historyId: '3603330',
  lastPushHistoryId: '3603315',
  lastPushAt: minutesAgo(3),
  lastSyncCompletedAt: minutesAgo(2),
  watchExpiresAt: new Date(NOW.getTime() + 5 * 86_400_000).toISOString(),
  consecutiveFailures: 0,
  lastErrorCode: null,
  coverageSince: '2026-09-01T00:00:00.000Z',
  syncBacklog: 0,
  processingBacklog: 0,
  oldestProcessingAt: null,
  deadSyncJobs24h: 0,
  deadProcessingJobs24h: 0,
  calendarLastRefreshAt: minutesAgo(10),
  calendarErrorCode: null,
  calendarUpdatedAt: minutesAgo(10),
  ...patch,
});
const quiet = { memoryEnabled: true, memoryPending: 0, draftsPreparing: 0, deadBackgroundJobs24h: 0 };
const summary = (input: MailHealthInput, intel = quiet): CloudHealth =>
  summarizeHealth([deriveMailHealth(input, NOW)], [deriveCalendarHealth(input, NOW)].filter((item) => item !== null), deriveIntelligenceHealth([input], intel, NOW), NOW);

describe('health derivation', () => {
  it('is up to date only when pushed history is processed, sync is recent and nothing is queued', () => {
    const result = summary(healthy());
    expect(result).toMatchObject({ level: 'healthy', title: 'Everything is up to date', cause: null });
    expect(result.mail[0]).toMatchObject({ level: 'healthy', reasons: [], cursorBehind: false, backfill: 'complete' });
  });

  it('does not treat a nominally healthy connection as current when pushed history is unprocessed', () => {
    const behind = healthy({ lastPushHistoryId: '3603400', lastPushAt: minutesAgo(40), lastSyncCompletedAt: minutesAgo(45) });
    const result = summary(behind);
    expect(result.mail[0]).toMatchObject({ level: 'stale', cursorBehind: true });
    expect(result.mail[0]!.reasons).toContain('mail_push_unprocessed');
    expect(result).toMatchObject({ level: 'stale', title: 'Mail may be out of date', cause: 'mail' });
    // A push that just arrived is catching up, not stale.
    expect(deriveMailHealth(healthy({ lastPushHistoryId: '3603400', lastPushAt: minutesAgo(1) }), NOW)).toMatchObject({ level: 'syncing', reasons: ['mail_push_pending'] });
    // Queued sync work explains the gap.
    expect(deriveMailHealth(healthy({ lastPushHistoryId: '3603400', lastPushAt: minutesAgo(40), syncBacklog: 1 }), NOW).level).toBe('syncing');
  });

  it('compares 20-digit history IDs exactly', () => {
    expect(historyAhead('18446744073709551615', '18446744073709551614')).toBe(true);
    expect(historyAhead('18446744073709551614', '18446744073709551615')).toBe(false);
    expect(historyAhead(null, '1')).toBe(false);
    expect(historyAhead('1', null)).toBe(true);
    expect(historyAhead('not-a-number', '1')).toBe(false);
  });

  it('marks an overdue sync stale, and an expired watch degraded', () => {
    expect(deriveMailHealth(healthy({ lastSyncCompletedAt: minutesAgo(8 * 60), lastPushAt: minutesAgo(8 * 60) }), NOW)).toMatchObject({ level: 'stale', reasons: ['mail_sync_overdue'] });
    expect(deriveMailHealth(healthy({ watchExpiresAt: minutesAgo(5) }), NOW)).toMatchObject({ level: 'degraded', reasons: ['mail_watch_expired'] });
  });

  it('asks for a reconnect, and says paused, without noise from other reasons', () => {
    const reauth = summary(healthy({ status: 'needs_reauth', lastSyncCompletedAt: minutesAgo(900) }));
    expect(reauth).toMatchObject({ level: 'action_required', title: 'Reconnect Google' });
    expect(reauth.mail[0]!.reasons).toEqual(['mail_needs_reauth']);
    expect(summary(healthy({ status: 'paused', syncState: 'paused' }))).toMatchObject({ level: 'action_required', title: 'Sync is paused' });
  });

  it('separates retrying, failing and stalled sync', () => {
    expect(deriveMailHealth(healthy({ consecutiveFailures: 2, lastErrorCode: 'google_timeout' }), NOW).level).toBe('degraded');
    expect(deriveMailHealth(healthy({ consecutiveFailures: 5 }), NOW)).toMatchObject({ level: 'failed', reasons: ['mail_sync_failing'] });
    expect(summary(healthy({ syncState: 'stalled' }))).toMatchObject({ level: 'failed', title: 'Mail sync has stopped' });
    // A dead sync job followed by a fresh successful sync is history, not a current problem.
    expect(deriveMailHealth(healthy({ deadSyncJobs24h: 1 }), NOW).level).toBe('healthy');
    expect(deriveMailHealth(healthy({ deadSyncJobs24h: 1, lastSyncCompletedAt: minutesAgo(120), lastPushAt: minutesAgo(120) }), NOW).reasons).toContain('mail_dead_sync_jobs');
  });

  it('reports the first import as catching up, never as stale', () => {
    const importing = healthy({ syncState: 'initializing', coverageSince: null, lastSyncCompletedAt: null, historyId: null });
    const result = summary(importing);
    expect(result.mail[0]).toMatchObject({ level: 'syncing', backfill: 'running' });
    expect(result).toMatchObject({ level: 'syncing', title: 'PigeonBox is catching up', detail: 'Your first import is still running.' });
  });

  it('tracks calendar freshness and current errors only', () => {
    expect(deriveCalendarHealth(healthy({ calendarLastRefreshAt: minutesAgo(90) }), NOW)).toMatchObject({ level: 'stale', reasons: ['calendar_stale'] });
    expect(deriveCalendarHealth(healthy({ calendarErrorCode: 'google_timeout', calendarUpdatedAt: minutesAgo(1) }), NOW)).toMatchObject({ level: 'degraded', reasons: ['calendar_refresh_failed'] });
    // An error older than the last successful refresh is resolved.
    expect(deriveCalendarHealth(healthy({ calendarErrorCode: 'google_timeout', calendarUpdatedAt: minutesAgo(10), calendarLastRefreshAt: minutesAgo(5) }), NOW)!.level).toBe('healthy');
    expect(deriveCalendarHealth(healthy({ calendarLastRefreshAt: null, calendarUpdatedAt: null }), NOW)).toMatchObject({ level: 'syncing', reasons: ['calendar_first_refresh'] });
    expect(deriveCalendarHealth(healthy({ features: ['mail_read'] }), NOW)).toBeNull();
    const result = summary(healthy({ calendarLastRefreshAt: minutesAgo(90) }));
    expect(result).toMatchObject({ level: 'stale', cause: 'calendar', title: 'Calendar may be out of date' });
  });

  it('distinguishes analysis catching up from delayed background work while mail stays current', () => {
    const catching = summary(healthy({ processingBacklog: 4, oldestProcessingAt: minutesAgo(3) }));
    expect(catching.mail[0]!.level).toBe('healthy');
    expect(catching).toMatchObject({ level: 'syncing', cause: 'intelligence', title: 'PigeonBox is catching up' });
    expect(catching.intelligence).toMatchObject({ analysisBacklog: 4, oldestPendingMinutes: 3, reasons: ['analysis_catching_up'] });
    const delayed = summary(healthy({ processingBacklog: 4, oldestProcessingAt: minutesAgo(90) }));
    expect(delayed).toMatchObject({ level: 'degraded', title: 'Some background work is delayed' });
    expect(summary(healthy(), { ...quiet, deadBackgroundJobs24h: 2 }).intelligence).toMatchObject({ level: 'degraded', reasons: ['background_jobs_failed'], deadJobs24h: 2 });
    // Memory work only counts when Memory is on.
    expect(summary(healthy(), { ...quiet, memoryPending: 3, memoryEnabled: false }).level).toBe('healthy');
    expect(summary(healthy(), { ...quiet, memoryPending: 3 }).intelligence.reasons).toEqual(['memory_indexing']);
  });

  it('takes the worst account and asks to connect when there is none', () => {
    const ok = healthy();
    const bad = healthy({ accountId: '00000000-0000-4000-8000-000000000002', email: 'bob@work.test', status: 'needs_reauth' });
    const result = summarizeHealth([deriveMailHealth(ok, NOW), deriveMailHealth(bad, NOW)], [], deriveIntelligenceHealth([ok, bad], quiet, NOW), NOW);
    expect(result).toMatchObject({ level: 'action_required', title: 'Reconnect Google' });
    expect(summarizeHealth([], [], deriveIntelligenceHealth([], quiet, NOW), NOW)).toMatchObject({ level: 'action_required', cause: 'connection', title: 'Connect Google' });
  });
});

describe('health route', () => {
  it('derives health from real sync and job state, scoped to the signed-in person, without content', async () => {
    const h = await createIntelHarness();
    const ada = await connectedUser(h, 'ada@work.test', ['mail_read']);
    const bob = await connectedUser(h, 'bob@work.test', ['mail_read']);
    await deliverAndSync(h, 'ada@work.test', { from: 'maya@client.test', to: ['ada@work.test'], subject: 'Private quote', body: 'Secret pricing details' });
    const before = await h.sql('select id, status from public.jobs order by id');
    const result = await h.route<CloudHealth>('controlHealth', ada.token);
    expect(result.mail.map((item) => item.email)).toEqual(['ada@work.test']);
    expect(result.mail[0]!.backfill).toBe('complete');
    expect(['healthy', 'syncing']).toContain(result.level);
    expect(JSON.stringify(result)).not.toMatch(/Private quote|Secret pricing|maya@client/);
    expect(await h.sql('select id, status from public.jobs order by id')).toEqual(before);

    // Gmail pushed history that was never processed: the connection still says healthy, health does not.
    await h.sql(`update public.gmail_sync_state set last_push_history_id = coalesce(history_id, 0) + 500, last_push_at = now() - interval '1 hour' where mail_account_id = $1::uuid`, [ada.accountId]);
    const behind = await h.route<CloudHealth>('controlHealth', ada.token);
    expect(behind.mail[0]).toMatchObject({ level: 'stale', cursorBehind: true });
    expect(behind.title).toBe('Mail may be out of date');
    const other = await h.route<CloudHealth>('controlHealth', bob.token);
    expect(other.mail[0]!.cursorBehind).toBe(false);

    await h.sql(`update public.mail_accounts set status = 'needs_reauth' where id = $1::uuid`, [ada.accountId]);
    expect(await h.route<CloudHealth>('controlHealth', ada.token)).toMatchObject({ level: 'action_required', title: 'Reconnect Google' });
  });

  it('refuses an account taken off the access list', async () => {
    const h = await createIntelHarness();
    const removed = await h.signIn('removed@work.test');
    h.config.allowedEmails.splice(0, Infinity, 'kept@work.test');
    await expect(h.route('controlHealth', removed.accessToken)).rejects.toMatchObject({ status: 402 });
  });
});
