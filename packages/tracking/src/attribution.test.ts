import { describe, expect, it } from 'vitest';
import { SelfViewAttribution } from './attribution';
import { pageReloadProxyReclassifications, planPageReloadProxy, senderProxySuppressionMode, deriveTrackingStats, deriveTrackingTimeline, type TrackingEvent } from './index';
import { TrackingNotificationHistory, groupTrackingAlerts } from '../../../apps/extension/src/background/tracking/notifications';
import { planPageReloadProxy as workerPlan, pageReloadProxyReclassifications as workerIds, planJustSentProxy as workerRenderPlan } from '../../../workers/tracker/src/helpers';
import { planPageReloadProxy as convexPlan, pageReloadProxyReclassifications as convexIds, planJustSentProxy as convexRenderPlan } from '../../../convex/openRequest';
const now = Date.parse('2026-10-02T12:00:00Z');
const claim = { issuer: 'tracker-A', trackingId: 'sent-1', eventId: 'reload-1', tabId: 1, observedAt: now };
const event = (id: string, offset = 100, trackingId = 'sent-1', ua = 'GoogleImageProxy', classification = 'PROXY_LIKELY'): TrackingEvent => ({ id, tracking_id: trackingId, type: 'OPEN', timestamp: new Date(now + offset).toISOString(), user_agent: ua, classification: classification as TrackingEvent['classification'] });
describe('settled tracking attribution', () => {
  it('holds a proxy that beats the claim in counts, animation, activity and notifications', async () => {
    const state = new SelfViewAttribution();
    const storage: Record<string, unknown> = {};
    const history = new TrackingNotificationHistory({ get: async (key: string) => ({ [key]: storage[key] }), set: async (value: Record<string, unknown>) => { Object.assign(storage, value); } } as never);
    await history.claim('scope', []);
    const revision = state.revision(claim.issuer, claim.trackingId);
    state.begin({ ...claim, navigation: true });
    const events = [event('self-proxy')];
    expect(state.publishable(claim.issuer, claim.trackingId, revision)).toBe(false);
    expect(deriveTrackingStats(state.events(claim.issuer, events)).openCount).toBe(0);
    expect(deriveTrackingTimeline(state.events(claim.issuer, events))).toEqual([]);
    expect(groupTrackingAlerts(await history.claim('scope', state.events(claim.issuer, events)))).toEqual([]);
    state.begin(claim);
    state.reconciled(claim, ['self-proxy']);
    // Canonical zero is applied while the reservation still blocks concurrent old polls.
    expect(state.isPending(claim.issuer, claim.trackingId)).toBe(true);
    state.settled(claim);
    expect(state.publishable(claim.issuer, claim.trackingId, revision)).toBe(false);
    expect(state.events(claim.issuer, events)).toEqual([]);
    expect(groupTrackingAlerts(await history.claim('scope', state.events(claim.issuer, events)))).toEqual([]);
  });
  it('allows claim-first self fetches to settle without a recipient indication', () => {
    const state = new SelfViewAttribution(); state.begin(claim); state.reconciled(claim, []); state.settled(claim);
    const self = { ...event('self'), classification: 'SELF_LIKELY' as const, suspected_self_open: true };
    expect(deriveTrackingStats(state.events(claim.issuer, [self])).openCount).toBe(0);
    expect(groupTrackingAlerts(state.events(claim.issuer, [self]))).toEqual([]);
  });
  it('restores legitimate recipient counts immediately after canonical reconciliation', () => {
    const state = new SelfViewAttribution(); state.begin(claim); state.reconciled(claim, ['self']); state.settled(claim);
    const recipient = event('recipient', 2100);
    const selected = state.events(claim.issuer, [event('self'), recipient]);
    expect(deriveTrackingStats(selected).openCount).toBe(1);
    expect(deriveTrackingTimeline(selected)).toHaveLength(1);
    expect(groupTrackingAlerts(selected)).toHaveLength(1);
    expect(senderProxySuppressionMode({ expiresAt: new Date(now + 25000).toISOString(), proxyConsumedByEventId: 'self', proxyConsumedAt: new Date(now).toISOString() }, now + 2100)).toBe('none');
  });
  it('keys multiple reloads, messages, tabs and trackers without suppressing unrelated opens', () => {
    const state = new SelfViewAttribution(); state.begin(claim);
    const next = { ...claim, eventId: 'reload-2', tabId: 2 }; state.begin(next);
    state.reconciled(claim, ['self']); state.settled(claim);
    expect(state.isPending(claim.issuer, claim.trackingId)).toBe(true);
    expect(state.events(claim.issuer, [event('other', 100, 'sent-2')])).toHaveLength(1);
    expect(state.events('tracker-B', [event('other')])).toHaveLength(1);
    state.settled(next); expect(state.isPending(claim.issuer, claim.trackingId)).toBe(false);
  });
  it('retains an exact failed quoted-pixel reservation across a worker restart until retry settles', () => {
    const state = new SelfViewAttribution(); const quoted = { ...claim, trackingId: 'quoted-original' }; state.begin(quoted); state.retry(quoted, { source: 'PAGE_RELOAD', quotedRender: true });
    const restarted = new SelfViewAttribution(); restarted.restore(state.snapshot());
    expect(restarted.snapshot().pending[0]?.retry?.quotedRender).toBe(true);
    expect(restarted.events(claim.issuer, [event('quoted', 100, quoted.trackingId)])).toEqual([]);
    restarted.reconciled(quoted, ['quoted']); restarted.settled(quoted);
    expect(restarted.events(claim.issuer, [event('recipient', 2100, quoted.trackingId)])).toHaveLength(1);
  });
  it('keeps previous settled activity; releases non-expanded navigation reservations after inspection', () => {
    const state = new SelfViewAttribution(); state.begin({ ...claim, navigation: true });
    expect(state.events(claim.issuer, [event('old', -6000)])).toHaveLength(1);
    state.inspected(1); expect(state.isPending(claim.issuer, claim.trackingId)).toBe(false);
  });
  it('preserves browser recipients and excludes scanner and headless activity', () => {
    const state = new SelfViewAttribution(); state.begin(claim); state.settled(claim);
    const events = [event('browser', 2100, claim.trackingId, 'Mozilla/5.0 Chrome/120 Safari', 'RECIPIENT_LIKELY'), event('scanner', 3000, claim.trackingId, 'Barracuda Scanner', 'MACHINE_LIKELY'), event('headless', 4000, claim.trackingId, 'Mozilla/5.0 HeadlessChrome', 'MACHINE_LIKELY')];
    expect(deriveTrackingStats(state.events(claim.issuer, events)).openCount).toBe(1);
    expect(groupTrackingAlerts(state.events(claim.issuer, events))).toHaveLength(1);
  });
  it.each([[planPageReloadProxy, pageReloadProxyReclassifications], [workerPlan, workerIds], [convexPlan, convexIds]])('reclassifies the duplicate proxy burst with parity and preserves later recipients', (plan, ids) => {
    const events = [event('proxy-1'), event('duplicate', 300), event('recipient', 2300)].map((row) => ({ id: row.id, type: row.type, timestamp: row.timestamp, userAgent: row.user_agent, classification: row.classification, countsAsOpen: true }));
    const decision = plan(events, now);
    expect(ids(events, decision, now)).toEqual(['proxy-1', 'duplicate']);
    const stats = deriveTrackingStats(events.map((row) => ({ ...row, classification: ids(events, decision, now).includes(row.id) ? 'SELF_LIKELY' : row.classification })));
    expect(stats.openCount).toBe(1);
    expect(stats.firstOpenedAt).toBe(events[2]!.timestamp);
  });
});


it.each([workerRenderPlan, convexRenderPlan])('reconciles one observed old-message pixel render, without treating an idle cache refresh as a render', (plan) => {
  const events = [event('own', -500), event('burst', 500), event('recipient', 2200)].map((row) => ({ ...row, eventId: row.id, userAgent: row.user_agent }));
  const opts = { sentAtMs: now - 3_600_000, selfViewMs: now, proxySlotConsumed: false };
  expect(plan(events, opts)).toBeNull();
  expect(plan(events, { ...opts, pixelRender: true })?.reclassifyEventIds).toEqual(['own', 'burst']);
  expect(plan(events, { ...opts, pixelRender: true, proxySlotConsumed: true })).toBeNull();
});

it.each([workerRenderPlan, convexRenderPlan])('gives each later observed render its own slot, never an earlier spent one', (plan) => {
  const at = (offset: number) => new Date(now + offset).toISOString();
  const rows = (...list: Array<[string, number, string]>) => list.map(([id, offset, classification]) => ({ ...event(id, offset, 'sent-1', 'GoogleImageProxy', classification), eventId: id, userAgent: 'GoogleImageProxy' }));
  const opts = { sentAtMs: now - 3_600_000, selfViewMs: now, proxySlotConsumed: true, proxyConsumedAt: at(-12_000) };
  const earlier = rows(['spent', -12_000, 'SELF_LIKELY'], ['old-burst', -11_000, 'SELF_LIKELY']);
  // Fetch for this render beat its claim: reconcile it, plus its burst, but not the earlier render.
  expect(plan([...earlier, ...rows(['raced', -200, 'PROXY_LIKELY'], ['dup', 600, 'PROXY_LIKELY'], ['recipient', 3_000, 'PROXY_LIKELY'])], { ...opts, pixelRender: true })).toEqual({ reclassifyEventIds: ['raced', 'dup'], proxyConsumedByEventId: 'raced', proxyConsumedAt: at(-200) });
  // Fetch has not arrived yet: reopen the slot for the live classifier.
  expect(plan(earlier, { ...opts, quotedRender: true })).toEqual({ reclassifyEventIds: [], proxyConsumedByEventId: null, proxyConsumedAt: null });
  // An earlier recipient right before this render is outside the window.
  expect(plan([...earlier, ...rows(['recipient-before', -3_500, 'PROXY_LIKELY'])], { ...opts, pixelRender: true })?.reclassifyEventIds).toEqual([]);
  // No observed render, or a slot spent after this render was observed: nothing changes.
  expect(plan(earlier, opts)).toBeNull();
  expect(plan(earlier, { ...opts, pixelRender: true, proxyConsumedAt: at(150) })).toBeNull();
});
