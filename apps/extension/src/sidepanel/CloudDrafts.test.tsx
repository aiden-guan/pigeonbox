/**
 * @vitest-environment jsdom
 */
import type { CloudDraft, CloudOverview, DraftListItem, DraftListResponse, FocusItem } from '@pigeonbox/api-contract';
import { act } from 'react';
import { createRoot } from 'react-dom/client';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

const calls: Array<{ route: string; body: Record<string, unknown> }> = [];
const responses: Record<string, (body: Record<string, unknown>) => unknown> = {};
vi.mock('./cloud-api', () => ({
  callCloud: async (route: string, body: Record<string, unknown> = {}) => {
    calls.push({ route, body });
    const respond = responses[route];
    return respond ? { ok: true, data: respond(body) } : { ok: false, code: 'not_found', reason: 'Not configured.' };
  },
  cloudCall: async () => ({ ok: false, code: 'not_found', reason: 'Not configured.' }),
}));
vi.mock('../ui/analytics', () => ({ trackProductEvent: () => undefined }));

const { DraftReview } = await import('./DraftReview');
const { DraftsView } = await import('./DraftsView');
const { CloudHome } = await import('./CloudHome');

(globalThis as unknown as { IS_REACT_ACT_ENVIRONMENT: boolean }).IS_REACT_ACT_ENVIRONMENT = true;
const ACCOUNT = '00000000-0000-4000-8000-000000000001';
const at = new Date(Date.now() - 8 * 60_000).toISOString();

function draft(overrides: Partial<CloudDraft> = {}): CloudDraft {
  return {
    id: '00000000-0000-4000-8000-000000000010', threadId: 't1', accountId: ACCOUNT, kind: 'reply', status: 'ready',
    variants: [
      { id: '00000000-0000-4000-8000-000000000011', label: 'recommended', strategy: 'Confirms the order', body: 'Hi team, the total is [CONFIRM PRICE].', placeholders: [] },
      { id: '00000000-0000-4000-8000-000000000012', label: 'shorter', strategy: 'Brief', body: 'Hi team, confirming now.', placeholders: [] },
    ],
    sources: [{ id: 'thread:t1', kind: 'thread', title: 'Uniforms', gmailThreadId: 't1', accountId: ACCOUNT }],
    freshness: { createdAt: at, basedOnMessageId: null, staleReason: null, refreshAfter: null },
    voice: 'default', gmailDraftId: null, placedVariantId: null, errorCode: null,
    ...overrides,
  };
}
const item = (overrides: Partial<CloudDraft> = {}): DraftListItem => ({ draft: draft(overrides), subject: 'Uniforms needed by September 30', person: { email: 'boosters@school.test', name: 'Track Boosters' }, lastMessageAt: at });

let host: HTMLDivElement;
let root: ReturnType<typeof createRoot>;
async function render(node: React.ReactNode) {
  host = document.createElement('div');
  document.body.append(host);
  root = createRoot(host);
  await act(async () => { root.render(node); });
  await act(async () => { await new Promise((resolve) => setTimeout(resolve, 0)); });
}
const labeled = (label: string) => host.querySelector<HTMLButtonElement>(`button[aria-label="${label}"]`) ?? undefined;
const button = (name: string | RegExp) => [...host.querySelectorAll('button')].find((node) => (typeof name === 'string' ? node.textContent?.trim() === name : name.test(node.textContent ?? ''))) as HTMLButtonElement | undefined;
async function click(node: HTMLElement | undefined) {
  if (!node) throw new Error('button not found');
  await act(async () => { node.click(); });
  await act(async () => { await new Promise((resolve) => setTimeout(resolve, 0)); });
}
async function type(area: HTMLTextAreaElement, value: string) {
  const setter = Object.getOwnPropertyDescriptor(HTMLTextAreaElement.prototype, 'value')!.set!;
  await act(async () => { setter.call(area, value); area.dispatchEvent(new Event('input', { bubbles: true })); });
}

beforeEach(() => {
  const values: Record<string, unknown> = {};
  vi.stubGlobal('chrome', { storage: { session: { get: vi.fn(async (key: string) => ({ [key]: values[key] })), set: vi.fn(async (items: Record<string, unknown>) => { Object.assign(values, items); }) } } });
  calls.length = 0;
  for (const key of Object.keys(responses)) delete responses[key];
  Object.defineProperty(globalThis, 'crypto', { value: { randomUUID: () => `key-${Math.random().toString(36).slice(2, 12)}` }, configurable: true });
  responses.threadsIntel = () => ({ threads: {}, synced: true, accountId: ACCOUNT });
});
afterEach(() => { act(() => root.unmount()); host.remove(); vi.unstubAllGlobals(); });

describe('draft review', () => {
  const target = (overrides: Partial<CloudDraft> = {}) => ({ threadId: 't1', accountId: ACCOUNT, draft: draft(overrides), subject: 'Uniforms needed by September 30', person: { email: 'boosters@school.test', name: 'Track Boosters' }, from: 'drafts' as const });

  it('blocks Add to Gmail until placeholders are filled, then places through draftPlace', async () => {
    responses.draftPlace = (body) => ({ draft: draft({ status: 'placed', gmailDraftId: 'g1', placedVariantId: body.variantId as string }) });
    await render(<DraftReview target={target()} onBack={() => undefined} onOpenThread={() => undefined} onChanged={() => undefined} />);
    expect(host.textContent).toContain('Prepared in PigeonBox. Not in Gmail yet.');
    expect(host.textContent).toContain('Fill in before adding to Gmail:');
    expect(button('Add to Gmail')!.disabled).toBe(true);
    await type(host.querySelector('textarea')!, 'Hi team, the total is $420.');
    expect(button('Add to Gmail')!.disabled).toBe(false);
    await click(button('Add to Gmail'));
    const place = calls.find((call) => call.route === 'draftPlace')!;
    expect(place.body).toMatchObject({ draftId: draft().id, variantId: draft().variants[0]!.id, body: 'Hi team, the total is $420.' });
    expect(String(place.body.idempotencyKey)).toMatch(/^key-/);
    expect(host.textContent).toContain('Added to your Gmail Drafts. Nothing was sent.');
    expect(button('Open in Gmail')).toBeTruthy();
    expect(button('Dismiss')).toBeUndefined();
  });

  it('switches variants and updates a stale draft through draftPrepare', async () => {
    responses.draftPrepare = () => ({ draft: draft({ variants: [{ id: '00000000-0000-4000-8000-000000000013', label: 'recommended', strategy: 'Updated', body: 'Fresh reply.', placeholders: [] }] }) });
    await render(<DraftReview target={target({ status: 'stale', freshness: { createdAt: at, basedOnMessageId: null, staleReason: 'A new message arrived in this thread', refreshAfter: null } })} onBack={() => undefined} onOpenThread={() => undefined} onChanged={() => undefined} />);
    expect(host.textContent).toContain('Needs update: A new message arrived in this thread.');
    await click(button(/^Shorter/));
    expect(host.querySelector('textarea')!.value).toBe('Hi team, confirming now.');
    await click(button('Update draft'));
    expect(calls.find((call) => call.route === 'draftPrepare')!.body).toEqual({ accountId: ACCOUNT, threadId: 't1', kind: 'reply' });
    expect(host.querySelector('textarea')!.value).toBe('Fresh reply.');
    expect(host.textContent).toContain('Draft updated from the latest messages.');
    expect(calls.some((call) => call.route === 'draftPlace')).toBe(false);
  });

  it('never offers to overwrite a draft edited in Gmail', async () => {
    const opened: string[] = [];
    await render(<DraftReview target={target({ status: 'user_edited', gmailDraftId: 'g1' })} onBack={() => undefined} onOpenThread={(id) => opened.push(id)} onChanged={() => undefined} />);
    expect(host.textContent).toContain('You edited this draft in Gmail, so PigeonBox will not change it.');
    expect(button(/Add to Gmail|Update Gmail draft|Regenerate|Dismiss/)).toBeUndefined();
    expect(host.querySelector('textarea')!.readOnly).toBe(true);
    await click(button('Open in Gmail'));
    expect(opened).toEqual(['t1']);
  });

  it('loads the live draft and conversation when opened from Home', async () => {
    responses.threadsIntel = () => ({ synced: true, accountId: ACCOUNT, threads: { t1: { threadId: 't1', accountId: ACCOUNT, subject: 'Uniforms', participants: [], lastMessageAt: at, lastMessageFromOwner: false, state: { state: 'NEEDS_REPLY', priority: 'HIGH', urgency: 'high', confidence: 0.9, deadline: null, importanceReason: null, relationshipImportance: 'known', nextAction: { kind: 'reply', label: 'Reply' }, source: 'model', updatedAt: at }, summary: { oneLine: 'The boosters need uniform sizes.', keyPoints: ['Due September 30'] }, commitments: [], followUp: null, draft: draft({ status: 'placed', gmailDraftId: 'g1', placedVariantId: draft().variants[0]!.id }), injectionSuspected: false, analyzedAt: at, sources: [] } } });
    await render(<DraftReview target={{ threadId: 't1', accountId: ACCOUNT, who: 'Track Boosters', from: 'home' }} onBack={() => undefined} onOpenThread={() => undefined} onChanged={() => undefined} />);
    expect(host.textContent).toContain('The boosters need uniform sizes.');
    expect(host.textContent).toContain('In your Gmail Drafts folder. Nothing is sent automatically.');
    expect(button('Open in Gmail')).toBeTruthy();
    expect(button('← Home')).toBeTruthy();
  });
});

describe('drafts list', () => {
  it('shows friendly states and opens the matching draft for review', async () => {
    const list: DraftListResponse = { drafts: [item(), item({ id: '00000000-0000-4000-8000-000000000020', status: 'placed', gmailDraftId: 'g1' })], counts: { preparing: 0, ready: 1, stale: 2, user_edited: 0, placed: 1, failed: 0 }, nextCursor: null };
    responses.draftList = () => list;
    const reviewed: string[] = [];
    await render(<DraftsView revision={0} onReview={(entry) => reviewed.push(entry.draft.id)} onOpenThread={() => undefined} />);
    expect(calls[0]).toMatchObject({ route: 'draftList', body: { statuses: ['ready', 'preparing'], limit: 20 } });
    expect(host.textContent).toContain('Track Boosters');
    expect(host.textContent).toContain('Prepared 8m ago');
    expect(host.textContent).toContain('1 detail to fill in');
    expect([...host.querySelectorAll('.pb-state')].map((node) => node.textContent)).toEqual(['Ready', 'In Gmail']);
    expect(host.querySelector('[role="tab"][aria-selected="true"]')!.textContent).toBe('Ready1');
    await click(button(/^Review$/));
    expect(reviewed).toEqual([draft().id]);
    await click([...host.querySelectorAll<HTMLButtonElement>('[role="tab"]')].find((tab) => tab.textContent?.startsWith('Needs update')));
    expect(calls.at(-1)).toMatchObject({ route: 'draftList', body: { statuses: ['stale', 'failed'] } });
  });

  it('has a deliberate empty state', async () => {
    responses.draftList = () => ({ drafts: [], counts: { preparing: 0, ready: 0, stale: 0, user_edited: 0, placed: 0, failed: 0 }, nextCursor: null });
    await render(<DraftsView revision={0} onReview={() => undefined} onOpenThread={() => undefined} />);
    expect(host.textContent).toContain('No drafts waiting for you.');
  });
});

describe('cloud home', () => {
  const focusItem: FocusItem = { threadId: 't1', accountId: ACCOUNT, subject: 'Uniforms', who: 'Track Boosters', lastMessageAt: at, section: 'respond', state: 'NEEDS_REPLY', score: 90, reasons: ['They are waiting on your reply'], deadlineAt: null, draftReady: true, followUpDueAt: null, draftId: draft().id, draftStatus: 'ready', approvalId: null };
  const overview = (work: CloudOverview['work'], items: FocusItem[] = [focusItem]): CloudOverview => ({
    generatedAt: at, since: at, accounts: [], work, focus: { generatedAt: at, coverage: { syncedAccounts: 1, since: at, note: '' }, sections: [{ id: 'respond', label: 'Respond', items }] },
    prepared: { drafts: { ready: 1, inGmail: 0, needsUpdate: 0, preparing: 0 }, followUpsOpen: 0, approvalsWaiting: 0 }, latestBriefing: null, automatic: null, unavailable: [],
  });
  const zero = { threadsAnalyzed: 0, draftsPrepared: 0, followUpsDetected: 0, approvalsWaiting: 0 };

  it('puts current work first and collapses zero activity', async () => {
    const data = { ...overview(zero), accounts: [{ id: ACCOUNT } as never] };
    await render(<CloudHome data={data as CloudOverview} loading={false} capabilities={['cloud_mail_sync', 'cloud_auto_drafts']} visitSince={at} onOpenThread={() => undefined} onGo={() => undefined} onNavigate={() => undefined} />);
    const text = host.textContent!;
    expect(text.indexOf('Needs you')).toBeLessThan(text.indexOf('In the background'));
    expect(text).not.toContain('While you were away');
    expect(text).not.toContain('Nothing new since your last visit.');
    expect(text).not.toMatch(/Threads analyzed|analyzed/i);
    expect(host.querySelectorAll('.pb-away-list li')).toHaveLength(0);
  });

  it('opens the email for drafted replies, routes approvals and background counts', async () => {
    const opened: string[] = []; const went: unknown[] = [];
    const data = { ...overview({ ...zero, threadsAnalyzed: 18 }, [focusItem, { ...focusItem, threadId: 't2', subject: 'Contract', draftReady: false, approvalId: 'ap1' }, { ...focusItem, threadId: 't3', subject: 'Partnership', draftReady: false, draftId: null, section: 'waiting', state: 'WAITING_ON_THEM', lastMessageFromOwner: true }]), accounts: [{ id: ACCOUNT } as never] };
    await render(<CloudHome data={data as CloudOverview} loading={false} capabilities={['cloud_mail_sync', 'cloud_auto_drafts']} visitSince={null} onOpenThread={(id) => opened.push(id)} onGo={(target) => went.push(target)} onNavigate={() => undefined} />);
    expect(host.textContent).toContain('Reviewed 18 conversations');
    expect(host.textContent).toContain('Reply drafted');
    expect(host.textContent).not.toContain('Review draft');
    await click(labeled('Open: Uniforms'));
    await click(labeled('Review approval: Contract'));
    await click(labeled('Open: Partnership'));
    await click(labeled('1 draft ready'));
    expect(opened).toEqual(['t1', 't3']);
    expect(went).toEqual([{ view: 'approvals', approvalId: 'ap1' }, { view: 'drafts', filter: 'ready' }]);
  });

  it('says you are caught up when nothing needs attention', async () => {
    const data = { ...overview(zero, []), accounts: [{ id: ACCOUNT } as never] };
    await render(<CloudHome data={data as CloudOverview} loading={false} capabilities={['cloud_mail_sync']} visitSince={null} onOpenThread={() => undefined} onGo={() => undefined} onNavigate={() => undefined} />);
    expect(host.textContent).toContain('You’re caught up.');
  });
});
