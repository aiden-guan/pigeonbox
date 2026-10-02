import { describe, expect, it } from 'vitest';
import { CloudOverviewResponseSchema, DraftListResponseSchema, MailAccountSchema, ROUTES, syncPhase, type MailAccount } from './index';

const at = '2026-10-01T12:00:00.000Z';
function account(sync: Partial<MailAccount['sync']> = {}, status: MailAccount['status'] = 'active'): MailAccount {
  return {
    id: 'a1', provider: 'google', email: 'ada@work.test', displayName: null, status, features: ['mail_read'], connectedAt: at,
    sync: { state: 'healthy', lastSyncAt: at, lastPushAt: at, watchExpiresAt: null, backlog: 0, lastErrorCode: null, coverageSince: at, threadsTracked: 10, ...sync },
  };
}

describe('sync phase', () => {
  it('keeps mail up to date while analysis jobs are queued', () => {
    expect(syncPhase(account({ backlog: 18, syncBacklog: 0, processingBacklog: 18 }))).toBe('analyzing');
    expect(syncPhase(account({ backlog: 0, syncBacklog: 0, processingBacklog: 0 }))).toBe('up_to_date');
  });
  it('does not read the legacy total backlog as mail sync (older servers)', () => {
    expect(syncPhase(account({ backlog: 40 }))).toBe('up_to_date');
  });
  it('reports real sync work as working states', () => {
    expect(syncPhase(account({ syncBacklog: 1, processingBacklog: 3 }))).toBe('catching_up');
    expect(syncPhase(account({ state: 'catching_up' }))).toBe('catching_up');
    expect(syncPhase(account({ state: 'initializing', coverageSince: null }))).toBe('importing');
    expect(syncPhase(account({ state: 'recovering', coverageSince: null }))).toBe('importing');
    expect(syncPhase(account({ state: 'recovering' }))).toBe('recovering');
  });
  it('reports attention, paused and reauthorization states first', () => {
    expect(syncPhase(account({ state: 'degraded', processingBacklog: 3 }))).toBe('degraded');
    expect(syncPhase(account({ state: 'stalled' }))).toBe('stalled');
    expect(syncPhase(account({}, 'error'))).toBe('stalled');
    expect(syncPhase(account({ state: 'paused' }, 'paused'))).toBe('paused');
    expect(syncPhase(account({ state: 'healthy' }, 'needs_reauth'))).toBe('needs_reauth');
  });
  it('trusts the server phase when present', () => {
    expect(syncPhase(account({ phase: 'analyzing' }))).toBe('analyzing');
  });
  it('parses responses from servers that predate the new fields', () => {
    expect(MailAccountSchema.safeParse(account()).success).toBe(true);
    const legacy = { generatedAt: at, since: at, accounts: [account()], work: null, focus: null, latestBriefing: null, automatic: null, unavailable: [] };
    expect(CloudOverviewResponseSchema.safeParse(legacy).success).toBe(true);
  });
});

describe('draft list contract', () => {
  it('is gated behind drafts and validates counts', () => {
    expect(ROUTES.draftList.capability).toBe('cloud_auto_drafts');
    const empty = { drafts: [], counts: { preparing: 0, ready: 0, stale: 0, user_edited: 0, placed: 0, failed: 0 }, nextCursor: null };
    expect(DraftListResponseSchema.safeParse(empty).success).toBe(true);
    expect(DraftListResponseSchema.safeParse({ ...empty, counts: { ready: 1 } }).success).toBe(false);
    expect(ROUTES.draftList.request.safeParse({ statuses: ['sent'] }).success).toBe(false);
    expect(ROUTES.draftList.request.parse({}).limit).toBe(20);
  });
});
