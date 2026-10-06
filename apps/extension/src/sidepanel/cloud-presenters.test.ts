import type { CloudOverview, FocusItem, MailAccount } from '@pigeonbox/api-contract';
import { describe, expect, it } from 'vitest';
import { awaySummary, countLabel, draftFilterCount, draftStateLabel, mailKindCounts, mailStatus, mailTag, openPlaceholders, placementLine, preparedRows, readyItem, readyList } from './cloud-presenters';

const NOW = Date.parse('2026-10-01T12:00:00.000Z');
const twoMinutesAgo = new Date(NOW - 120_000).toISOString();

function account(sync: Partial<MailAccount['sync']> = {}, extra: Partial<MailAccount> = {}): MailAccount {
  return {
    id: 'a1', provider: 'google', email: 'ada@work.test', displayName: null, status: 'active', features: ['mail_read', 'drafts'], connectedAt: twoMinutesAgo,
    sync: { state: 'healthy', lastSyncAt: twoMinutesAgo, lastPushAt: null, watchExpiresAt: null, backlog: 0, syncBacklog: 0, processingBacklog: 0, lastErrorCode: null, coverageSince: twoMinutesAgo, threadsTracked: 40, ...sync },
    ...extra,
  };
}

function focus(overrides: Partial<FocusItem> = {}): FocusItem {
  return { threadId: 't1', accountId: 'a1', subject: 'Uniforms needed by September 30', who: 'Track Boosters', lastMessageAt: new Date(NOW - 4 * 86_400_000).toISOString(), section: 'respond', state: 'NEEDS_REPLY', score: 80, reasons: ['They are waiting on your reply', 'Deadline passed', 'A draft is ready to review'], deadlineAt: null, draftReady: false, followUpDueAt: null, ...overrides };
}

describe('mail status', () => {
  it('never says syncing when only analysis is queued', () => {
    const status = mailStatus({ accounts: [account({ backlog: 18, processingBacklog: 18 })] }, NOW);
    expect(status).toMatchObject({ tone: 'ok', title: 'Mail up to date', detail: 'Reviewing 18 new conversations' });
    expect(JSON.stringify(status)).not.toMatch(/sync/i);
  });
  it('is up to date when healthy and idle, with freshness', () => {
    expect(mailStatus({ accounts: [account()] }, NOW)).toMatchObject({ tone: 'ok', title: 'Up to date', detail: 'Mail updated 2m ago' });
  });
  it('shows real catch-up and first import as working, without inventing totals', () => {
    expect(mailStatus({ accounts: [account({ syncBacklog: 2 })] }, NOW)).toMatchObject({ tone: 'working', title: 'Catching up on new mail' });
    const importing = mailStatus({ accounts: [account({ state: 'initializing', coverageSince: null, threadsTracked: 124 })] }, NOW);
    expect(importing).toMatchObject({ tone: 'working', title: 'Getting your inbox ready', detail: '124 recent conversations imported so far' });
    expect(importing.detail).not.toMatch(/ of |%/);
  });
  it('asks for attention on degraded, stalled and reauthorization', () => {
    expect(mailStatus({ accounts: [account({ state: 'degraded' })] }, NOW)).toMatchObject({ tone: 'attention', title: 'Mail may be out of date' });
    expect(mailStatus({ accounts: [account({ state: 'stalled' })] }, NOW)).toMatchObject({ tone: 'attention', title: 'Connection needs attention', action: { label: 'Fix connection' } });
    expect(mailStatus({ accounts: [account({}, { status: 'needs_reauth' })] }, NOW)).toMatchObject({ title: 'Needs attention', detail: 'Reconnect your Google account', action: { label: 'Reconnect' } });
  });
  it('reports paused sync, and names the account when there are several', () => {
    expect(mailStatus({ accounts: [account({ state: 'paused' }, { status: 'paused' })] }, NOW)).toMatchObject({ tone: 'paused', title: 'Mail sync paused' });
    const mixed = mailStatus({ accounts: [account(), account({ state: 'stalled' }, { id: 'a2', email: 'bob@work.test' })] }, NOW);
    expect(mixed.detail).toBe('bob@work.test: Mail may be out of date');
  });
  it('does not present the last loaded data as current after a failed refresh', () => {
    expect(mailStatus({ accounts: [account()], refreshFailed: true, checkedAt: twoMinutesAgo }, NOW)).toMatchObject({ tone: 'attention', title: 'Could not refresh', detail: 'Last checked 2m ago' });
    expect(mailStatus({ accounts: undefined, loading: true }, NOW).title).toBe('Checking Cloud…');
    expect(mailStatus({ accounts: [] }, NOW)).toMatchObject({ title: 'Connect Google', action: { section: 'connections' } });
  });
});

describe('ready for you', () => {
  it('notes a drafted reply but opens the email to review it', () => {
    const view = readyItem(focus({ draftReady: true, draftId: 'd1', draftStatus: 'ready', deadlineAt: new Date(NOW - 86_400_000).toISOString() }), NOW);
    expect(view.flags.map((flag) => flag.text)).toEqual(['Reply drafted', 'Deadline passed']);
    expect(view.flags[1]!.urgent).toBe(true);
    expect(view.reason).toBe('They are waiting on your reply');
    expect(view.action).toEqual({ kind: 'thread', label: 'Open' });
  });
  it('opens the thread when there is no draft, and shows waiting time', () => {
    const view = readyItem(focus({ section: 'waiting', state: 'WAITING_ON_THEM', lastMessageFromOwner: true, reasons: ['Unanswered for 4 days'] }), NOW);
    expect(view.flags.map((flag) => flag.text)).toEqual(['Waiting 4 days for a reply']);
    expect(view.reason).toBeNull();
    expect(view.action.label).toBe('Open');
  });
  it('puts approvals first and in Gmail drafts are labeled as such', () => {
    const view = readyItem(focus({ approvalId: 'ap1', draftReady: true, draftStatus: 'placed' }), NOW);
    expect(view.action).toEqual({ kind: 'approval', label: 'Review approval', approvalId: 'ap1' });
    expect(view.flags.map((flag) => flag.text)).toContain('Draft in Gmail');
    const ranked = readyList({ focus: { generatedAt: '', coverage: { syncedAccounts: 1, since: null, note: '' }, sections: [{ id: 'respond', label: 'Respond', items: [focus({ threadId: 'plain', score: 99 }), focus({ threadId: 'draft', draftReady: true, score: 10 }), focus({ threadId: 'approval', approvalId: 'x', score: 1 })] }] } });
    expect(ranked.map((item) => item.threadId)).toEqual(['approval', 'plain', 'draft']);
  });
});

describe('prepared and while away', () => {
  const work = { threadsAnalyzed: 0, draftsPrepared: 0, followUpsDetected: 0, approvalsWaiting: 0 };
  it('renders nothing for zero activity instead of four zeros', () => {
    expect(awaySummary(work)).toEqual([]);
    expect(preparedRows({ work, prepared: { drafts: { ready: 0, inGmail: 0, needsUpdate: 0, preparing: 0 }, followUpsOpen: 0, approvalsWaiting: 0 } })).toEqual([]);
  });
  it('summarizes activity in plain words', () => {
    expect(awaySummary({ threadsAnalyzed: 18, draftsPrepared: 3, followUpsDetected: 1, approvalsWaiting: 0 })).toEqual(['Reviewed 18 conversations', 'Prepared 3 replies', 'Found 1 follow-up']);
  });
  it('lists only current prepared work with routes', () => {
    const rows = preparedRows({ work, prepared: { drafts: { ready: 3, inGmail: 1, needsUpdate: 0, preparing: 0 }, followUpsOpen: 2, approvalsWaiting: 1 } } as Pick<CloudOverview, 'work' | 'prepared'>);
    expect(rows.map((row) => `${row.count} ${row.label}`)).toEqual(['1 approval waiting', '3 drafts ready', '1 in Gmail', '2 follow-ups tracked']);
    expect(rows[1]!.target).toEqual({ view: 'drafts', filter: 'ready' });
  });
});

describe('recent mail', () => {
  it('tags each conversation by what it asks of you', () => {
    expect(mailTag({ state: 'NEEDS_REPLY' })).toEqual({ kind: 'reply', text: 'Reply' });
    expect(mailTag({ state: 'PROMOTION' })).toEqual({ kind: 'marketing', text: 'Marketing' });
    expect(mailTag({ state: 'NEWS' })).toEqual({ kind: 'marketing', text: 'Newsletter' });
    expect(mailTag({ state: 'NOTIFICATION' })).toEqual({ kind: 'updates', text: 'Updates' });
    expect(mailTag({ state: 'SCHEDULED' })).toEqual({ kind: 'fyi', text: 'FYI' });
    expect(mailKindCounts([{ state: 'NEEDS_REPLY' }, { state: 'NEWS' }, { state: 'PROMOTION' }])).toEqual({ reply: 1, fyi: 0, updates: 0, marketing: 2 });
  });
  it('caps counts so they never outgrow their line', () => {
    expect(countLabel(138)).toBe('138');
    expect(countLabel(12_000)).toBe('999+');
  });
});

describe('drafts', () => {
  const freshness = { createdAt: twoMinutesAgo, basedOnMessageId: null, staleReason: null, refreshAfter: null };
  it('uses friendly state names and distinguishes prepared, in Gmail and edited', () => {
    expect(draftStateLabel({ status: 'stale' })).toBe('Needs update');
    expect(draftStateLabel({ status: 'placed' })).toBe('In Gmail');
    expect(draftStateLabel({ status: 'user_edited' })).toBe('Edited in Gmail');
    expect(placementLine({ status: 'ready', gmailDraftId: null, freshness })).toBe('Prepared in PigeonBox. Not in Gmail yet.');
    expect(placementLine({ status: 'placed', gmailDraftId: 'g1', freshness })).toMatch(/Gmail Drafts folder. Nothing is sent/);
    expect(placementLine({ status: 'ready', gmailDraftId: 'g1', freshness })).toMatch(/earlier version/);
    expect(placementLine({ status: 'stale', gmailDraftId: null, freshness: { ...freshness, staleReason: 'A new message arrived in this thread' } })).toBe('Needs update: A new message arrived in this thread.');
  });
  it('counts filters and finds placeholders', () => {
    expect(draftFilterCount('update', { preparing: 0, ready: 1, stale: 2, user_edited: 1, placed: 3, failed: 1 })).toBe(3);
    expect(draftFilterCount('gmail', { preparing: 0, ready: 1, stale: 2, user_edited: 1, placed: 3, failed: 1 })).toBe(4);
    expect(openPlaceholders('Price is [CONFIRM PRICE] on [DATE NEEDED], [CONFIRM PRICE].')).toEqual(['[CONFIRM PRICE]', '[DATE NEEDED]']);
  });
});
