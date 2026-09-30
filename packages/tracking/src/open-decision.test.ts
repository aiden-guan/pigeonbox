import { describe, expect, it } from 'vitest';
import {
  decideTrackedOpen as convexDecide,
  deriveTrackingStats as convexStats,
  planPageReloadProxy as convexPlan,
  selectSenderProxyClaim as convexSelect,
} from '../../../convex/openRequest';
import {
  decideTrackedOpen as workerDecide,
  deriveTrackingStats as workerStats,
  planPageReloadProxy as workerPlan,
  selectSenderProxyClaim as workerSelect,
} from '../../../workers/tracker/src/helpers';
import {
  decideTrackedOpen,
  deriveTrackingStats,
  deriveTrackingTimeline,
  PAGE_RELOAD_PROXY_WINDOW_MS,
  planPageReloadProxy,
  selectSenderProxyClaim,
  type PageReloadProxyEvent,
  type PageReloadProxyPlan,
  type ProxyClaimCandidate,
  type ProxySuppressionMode,
} from './lifecycle';

const sent = Date.parse('2026-09-24T12:00:00.000Z');
const browserUa = 'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36';
const proxyUa = 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 GoogleImageProxy';
const scannerUa = 'Proofpoint-URL-Scanner/2.0';
const senderClaim = { senderIpHash: 'ip_sender', senderUaFamily: 'chrome' };

type Decision = {
  classification: string;
  countsAsOpen: boolean;
  consumeClaim: boolean;
  consumeProxySuppression: boolean;
};

function sameDecision(input: {
  eventTs: number;
  sentAt: number | null;
  userAgent: string | null;
  ipHash?: string | null;
  selfViewTs?: number | null;
  activeClaim?: { senderIpHash?: string | null; senderUaFamily?: string | null } | null;
  recentConsumedMatches?: boolean;
  proxySuppression?: ProxySuppressionMode;
}): Decision {
  const tracking = decideTrackedOpen(input);
  const convex = convexDecide(input);
  const worker = workerDecide({
    sentAt: input.sentAt == null ? null : new Date(input.sentAt).toISOString(),
    now: input.eventTs,
    ua: input.userAgent,
    ipHash: input.ipHash,
    selfViewTs: input.selfViewTs,
    activeClaim: input.activeClaim,
    recentConsumedMatches: input.recentConsumedMatches,
    proxySuppression: input.proxySuppression,
  });
  const pick = (verdict: Decision): Decision => ({
    classification: verdict.classification,
    countsAsOpen: verdict.countsAsOpen,
    consumeClaim: verdict.consumeClaim,
    consumeProxySuppression: verdict.consumeProxySuppression,
  });
  expect(pick(convex)).toEqual(pick(tracking));
  expect(pick(worker)).toEqual(pick(tracking));
  return pick(tracking);
}

describe('open decision order', () => {
  it('counts native mobile mail clients after send across all tracker implementations', () => {
    for (const userAgent of ['Gmail/2026.09.24 (iPhone; iOS 18)', 'Outlook-iOS/4.26', 'AppleMail/1.0']) {
      expect(sameDecision({ eventTs: sent + 30_000, sentAt: sent, userAgent })).toEqual({
        classification: 'RECIPIENT_LIKELY',
        countsAsOpen: true,
        consumeClaim: false,
        consumeProxySuppression: false,
      });
    }
  });

  it('A. counts a GoogleImageProxy request when no sender proxy suppression exists', () => {
    expect(
      sameDecision({
        eventTs: sent + 30_000,
        sentAt: sent,
        userAgent: proxyUa,
        ipHash: 'ip_google',
        activeClaim: senderClaim,
        proxySuppression: 'none',
      }),
    ).toEqual({
      classification: 'PROXY_LIKELY',
      countsAsOpen: true,
      consumeClaim: false,
      consumeProxySuppression: false,
    });
  });

  it('B. suppresses one sender GoogleImageProxy render and consumes only the proxy slot', () => {
    expect(
      sameDecision({
        eventTs: sent + 30_000,
        sentAt: sent,
        userAgent: proxyUa,
        proxySuppression: 'consume',
        activeClaim: senderClaim,
      }),
    ).toEqual({
      classification: 'SELF_LIKELY',
      countsAsOpen: false,
      consumeClaim: false,
      consumeProxySuppression: true,
    });
  });

  it('C. a consumed sender proxy does not suppress a later recipient proxy', () => {
    expect(
      sameDecision({
        eventTs: sent + 31_000,
        sentAt: sent,
        userAgent: proxyUa,
        proxySuppression: 'burst',
      }),
    ).toMatchObject({ classification: 'SELF_LIKELY', countsAsOpen: false, consumeClaim: false, consumeProxySuppression: false });
    expect(
      sameDecision({
        eventTs: sent + 40_000,
        sentAt: sent,
        userAgent: proxyUa,
        proxySuppression: 'none',
      }),
    ).toMatchObject({ classification: 'PROXY_LIKELY', countsAsOpen: true, consumeProxySuppression: false });
  });

  it('D. a proxy render does not consume the browser sender claim', () => {
    const proxy = sameDecision({
      eventTs: sent + 30_000,
      sentAt: sent,
      userAgent: proxyUa,
      ipHash: 'ip_google',
      activeClaim: senderClaim,
      proxySuppression: 'consume',
    });
    expect(proxy.consumeProxySuppression).toBe(true);
    expect(proxy.consumeClaim).toBe(false);
    expect(
      sameDecision({
        eventTs: sent + 31_000,
        sentAt: sent,
        userAgent: browserUa,
        ipHash: 'ip_sender',
        activeClaim: senderClaim,
        proxySuppression: 'none',
      }),
    ).toEqual({
      classification: 'SELF_LIKELY',
      countsAsOpen: false,
      consumeClaim: true,
      consumeProxySuppression: false,
    });
  });

  it('does not count Gmail delivery prefetch that impersonates an old browser', () => {
    const gmailPrefetch =
      'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/42.0.2311.135 Safari/537.36 Edge/12.246 Mozilla/5.0';
    expect(
      sameDecision({
        eventTs: sent + 13_000,
        sentAt: sent,
        userAgent: gmailPrefetch,
      }),
    ).toMatchObject({ classification: 'MACHINE_LIKELY', countsAsOpen: false, consumeClaim: false });
    const mislabeled = [
      {
        type: 'OPEN',
        timestamp: new Date(sent + 13_000).toISOString(),
        classification: 'RECIPIENT_LIKELY',
        userAgent: gmailPrefetch,
        user_agent: gmailPrefetch,
      },
    ];
    expect(deriveTrackingStats(mislabeled).openCount).toBe(0);
    expect(convexStats(mislabeled).openCount).toBe(0);
    expect(workerStats(mislabeled).openCount).toBe(0);
    expect(
      sameDecision({
        eventTs: sent + 13_000,
        sentAt: sent,
        userAgent: browserUa.replace('Chrome/120.0.0.0', 'Chrome/120.0.0.0 Edg/120.0.0.0'),
      }).classification,
    ).toBe('RECIPIENT_LIKELY');
  });

  it('E. scanners and headless clients stay uncounted and do not consume claims', () => {
    expect(
      sameDecision({
        eventTs: sent + 30_000,
        sentAt: sent,
        userAgent: scannerUa,
        activeClaim: senderClaim,
        proxySuppression: 'consume',
      }),
    ).toMatchObject({ classification: 'MACHINE_LIKELY', countsAsOpen: false, consumeClaim: false, consumeProxySuppression: false });
    expect(
      sameDecision({
        eventTs: sent + 30_000,
        sentAt: sent,
        userAgent: 'Mozilla/5.0 HeadlessChrome/120.0.0.0',
      }),
    ).toMatchObject({ classification: 'MACHINE_LIKELY', countsAsOpen: false });
  });

  it('F. a browser-like recipient with no matching sender claim counts', () => {
    expect(
      sameDecision({
        eventTs: sent + 60_000,
        sentAt: sent,
        userAgent: browserUa,
        ipHash: 'ip_recipient',
        activeClaim: senderClaim,
      }),
    ).toEqual({
      classification: 'RECIPIENT_LIKELY',
      countsAsOpen: true,
      consumeClaim: false,
      consumeProxySuppression: false,
    });
  });

  it('G. aggregation counts proxy and recipient opens and skips self and machine', () => {
    const events = [
      {
        type: 'OPEN',
        timestamp: '2026-09-24T12:01:00.000Z',
        classification: 'SELF_LIKELY',
        suspectedSelfOpen: true,
        userAgent: proxyUa,
        user_agent: proxyUa,
      },
      {
        type: 'OPEN',
        timestamp: '2026-09-24T12:02:00.000Z',
        classification: 'PROXY_LIKELY',
        userAgent: proxyUa,
        user_agent: proxyUa,
      },
      {
        type: 'OPEN',
        timestamp: '2026-09-24T12:03:00.000Z',
        classification: 'MACHINE_LIKELY',
        userAgent: scannerUa,
        user_agent: scannerUa,
      },
      {
        type: 'OPEN',
        timestamp: '2026-09-24T12:04:00.000Z',
        classification: 'RECIPIENT_LIKELY',
        userAgent: browserUa,
        user_agent: browserUa,
      },
    ];
    expect(deriveTrackingStats(events).openCount).toBe(2);
    expect(convexStats(events).openCount).toBe(2);
    expect(workerStats(events).openCount).toBe(2);
  });

  it('lists the time of every counted open and click, matching the counters', () => {
    const events = [
      { type: 'OPEN', timestamp: '2026-09-24T12:01:00.000Z', classification: 'SELF_LIKELY', suspected_self_open: true, user_agent: proxyUa },
      { type: 'OPEN', timestamp: '2026-09-24T12:02:00.000Z', classification: 'PROXY_LIKELY', user_agent: proxyUa },
      // A duplicate render inside the 800 ms window is the same open.
      { type: 'OPEN', timestamp: '2026-09-24T12:02:00.400Z', classification: 'PROXY_LIKELY', user_agent: proxyUa },
      { type: 'OPEN', timestamp: '2026-09-24T12:03:00.000Z', classification: 'MACHINE_LIKELY', user_agent: scannerUa },
      { type: 'CLICK', timestamp: '2026-09-24T12:05:00.000Z', classification: 'RECIPIENT_LIKELY', user_agent: browserUa, destination: 'https://example.com/doc' },
      { type: 'CLICK', timestamp: '2026-09-24T12:05:30.000Z', classification: 'SELF_LIKELY', user_agent: browserUa },
      { type: 'OPEN', timestamp: '2026-09-25T08:04:00.000Z', classification: 'RECIPIENT_LIKELY', user_agent: browserUa },
    ];
    const timeline = deriveTrackingTimeline(events);
    expect(timeline).toEqual([
      { type: 'OPEN', timestamp: '2026-09-24T12:02:00.000Z', viaProxy: true },
      { type: 'CLICK', timestamp: '2026-09-24T12:05:00.000Z', destination: 'https://example.com/doc' },
      { type: 'OPEN', timestamp: '2026-09-25T08:04:00.000Z' },
    ]);
    const stats = workerStats(events);
    expect(timeline.filter((entry) => entry.type === 'OPEN')).toHaveLength(stats.openCount);
    expect(timeline.filter((entry) => entry.type === 'CLICK')).toHaveLength(stats.clickCount);
  });

  it('does not use the claim TTL to suppress every later Google proxy', () => {
    const observed = '2026-09-24T12:00:30.000Z';
    const claim: ProxyClaimCandidate = {
      id: 'clm_1',
      gmailMessageId: 'msg_1',
      lastObservedAt: observed,
      expiresAt: new Date(Date.parse(observed) + 25_000).toISOString(),
      proxyConsumedByEventId: 'evt_proxy',
      proxyConsumedAt: observed,
    };
    const stillInsideTtl = Date.parse(observed) + 10_000;
    expect(selectSenderProxyClaim([claim], stillInsideTtl, 'msg_1')).toBeNull();
    expect(convexSelect([claim], stillInsideTtl, 'msg_1')).toBeNull();
    expect(workerSelect([claim], stillInsideTtl, 'msg_1')).toBeNull();

    const fresh = { ...claim, proxyConsumedByEventId: null, proxyConsumedAt: null };
    expect(selectSenderProxyClaim([fresh], stillInsideTtl, 'msg_1')?.mode).toBe('consume');
    expect(convexSelect([fresh], stillInsideTtl, 'msg_1')?.mode).toBe('consume');
    expect(workerSelect([fresh], stillInsideTtl, 'msg_1')?.mode).toBe('consume');

    const burstAt = Date.parse(observed) + 1_500;
    expect(selectSenderProxyClaim([claim], burstAt, 'msg_1')?.mode).toBe('burst');
    expect(convexSelect([claim], burstAt, 'msg_1')?.mode).toBe('burst');
    expect(workerSelect([claim], burstAt, 'msg_1')?.mode).toBe('burst');
  });

  it('does not count GoogleImageProxy renders in the delivery window right after send', () => {
    // trk_7ecb…: Gmail fetched the pixel 0.8 s and 16.8 s after send, before any sender claim existed.
    for (const offset of [800, 16_800, 20_000]) {
      expect(sameDecision({ eventTs: sent + offset, sentAt: sent, userAgent: proxyUa, proxySuppression: 'none' })).toEqual({
        classification: 'MACHINE_LIKELY',
        countsAsOpen: false,
        consumeClaim: false,
        consumeProxySuppression: false,
      });
    }
    expect(
      sameDecision({ eventTs: sent + 20_001, sentAt: sent, userAgent: proxyUa, proxySuppression: 'none' }),
    ).toMatchObject({ classification: 'PROXY_LIKELY', countsAsOpen: true });
    expect(
      sameDecision({ eventTs: sent + 5_000, sentAt: sent, userAgent: proxyUa, proxySuppression: 'consume' }),
    ).toMatchObject({ classification: 'SELF_LIKELY', consumeProxySuppression: true });
    expect(
      sameDecision({ eventTs: sent + 5_000, sentAt: sent, userAgent: browserUa, ipHash: 'ip_recipient' }).classification,
    ).toBe('RECIPIENT_LIKELY');
  });

  it('classifies pre-send proxy fetches as self and does not consume suppression', () => {
    expect(
      sameDecision({
        eventTs: sent - 1,
        sentAt: sent,
        userAgent: proxyUa,
        proxySuppression: 'consume',
      }),
    ).toMatchObject({ classification: 'SELF_LIKELY', countsAsOpen: false, consumeClaim: false, consumeProxySuppression: false });
  });
});

const priorConsumption = {
  proxyConsumedByEventId: 'evt_prior',
  proxyConsumedAt: '2026-09-24T12:09:50.000Z',
};

function proxyEvent(
  id: string,
  at: number,
  classification: string,
  userAgent = proxyUa,
): PageReloadProxyEvent {
  const timestamp = new Date(at).toISOString();
  return {
    eventId: id,
    id,
    type: 'OPEN',
    timestamp,
    classification,
    userAgent,
    user_agent: userAgent,
  };
}

function samePlan(
  events: PageReloadProxyEvent[],
  navigationStartedAt: number,
  current?: { proxyConsumedByEventId?: string | null; proxyConsumedAt?: string | null } | null,
): PageReloadProxyPlan {
  const tracking = planPageReloadProxy(events, navigationStartedAt, current);
  expect(convexPlan(events, navigationStartedAt, current)).toEqual(tracking);
  expect(workerPlan(events, navigationStartedAt, current)).toEqual(tracking);
  return tracking;
}

describe('PAGE_RELOAD proxy re-arm', () => {
  const nav = Date.parse('2026-09-24T12:10:00.000Z');

  it('re-arms a consumed sender slot when this reload has no proxy render yet', () => {
    expect(samePlan([proxyEvent('evt_prior', nav - 10_000, 'SELF_LIKELY')], nav, priorConsumption)).toEqual({
      reclassifyEventId: null,
      proxyConsumedByEventId: null,
      proxyConsumedAt: null,
      updateProxySlot: true,
    });
  });

  it('reclassifies the first in-window PROXY_LIKELY reload render and leaves a later one counted', () => {
    const firstAt = nav + 500;
    const laterAt = nav + 3_000;
    const plan = samePlan(
      [
        proxyEvent('evt_reload', firstAt, 'PROXY_LIKELY'),
        proxyEvent('evt_recipient', laterAt, 'PROXY_LIKELY'),
        proxyEvent('evt_browser', nav + 1_000, 'RECIPIENT_LIKELY', browserUa),
      ],
      nav,
      priorConsumption,
    );
    expect(plan).toEqual({
      reclassifyEventId: 'evt_reload',
      proxyConsumedByEventId: 'evt_reload',
      proxyConsumedAt: new Date(firstAt).toISOString(),
      updateProxySlot: true,
    });
    const before = [
      proxyEvent('evt_reload', firstAt, 'PROXY_LIKELY'),
      proxyEvent('evt_recipient', laterAt, 'PROXY_LIKELY'),
    ];
    expect(deriveTrackingStats(before).openCount).toBe(2);
    expect(convexStats(before).openCount).toBe(2);
    expect(workerStats(before).openCount).toBe(2);
    const after = [
      proxyEvent('evt_reload', firstAt, 'SELF_LIKELY'),
      proxyEvent('evt_recipient', laterAt, 'PROXY_LIKELY'),
    ];
    expect(deriveTrackingStats(after).openCount).toBe(1);
    expect(convexStats(after).openCount).toBe(1);
    expect(workerStats(after).openCount).toBe(1);
  });

  it('does not reclassify a proxy outside the reload startup window, and does not re-arm over it', () => {
    const lateAt = nav + PAGE_RELOAD_PROXY_WINDOW_MS + 1;
    expect(samePlan([proxyEvent('evt_late', lateAt, 'PROXY_LIKELY')], nav, priorConsumption)).toEqual({
      reclassifyEventId: null,
      proxyConsumedByEventId: 'evt_late',
      proxyConsumedAt: new Date(lateAt).toISOString(),
      updateProxySlot: true,
    });
  });

  it('keeps an already suppressed in-window sender proxy and does not reclassify the next one', () => {
    const senderAt = nav + 400;
    expect(
      samePlan(
        [
          proxyEvent('evt_sender_reload', senderAt, 'SELF_LIKELY'),
          proxyEvent('evt_recipient', nav + 4_000, 'PROXY_LIKELY'),
        ],
        nav,
        {
          proxyConsumedByEventId: 'evt_sender_reload',
          proxyConsumedAt: new Date(senderAt).toISOString(),
        },
      ),
    ).toEqual({
      reclassifyEventId: null,
      proxyConsumedByEventId: 'evt_sender_reload',
      proxyConsumedAt: new Date(senderAt).toISOString(),
      updateProxySlot: true,
    });
  });

  it('does not clear a slot this reload already consumed when the open event is absent from the snapshot', () => {
    const consumedAt = new Date(nav + 500).toISOString();
    expect(
      samePlan([], nav, { proxyConsumedByEventId: 'evt_live', proxyConsumedAt: consumedAt }),
    ).toEqual({
      reclassifyEventId: null,
      proxyConsumedByEventId: 'evt_live',
      proxyConsumedAt: consumedAt,
      updateProxySlot: false,
    });
  });
});
