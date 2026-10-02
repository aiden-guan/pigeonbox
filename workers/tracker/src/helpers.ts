/** Pure helpers extracted for unit tests (no Cloudflare runtime required). */

export function safeRedirectUrl(url: string): string | null {
  try {
    const u = new URL(url);
    if (u.protocol !== 'http:' && u.protocol !== 'https:') return null;
    return u.toString();
  } catch {
    return null;
  }
}

export function normalizeGmailId(value: string | null | undefined): string | null {
  if (!value) return null;
  const next = value.trim().replace(/^#/, '').replace(/^(msg-a:|msg-f:|thread-a:|thread-f:)/i, '');
  return next || null;
}

export type OpenClassification =
  | 'RECIPIENT_LIKELY'
  | 'SELF_LIKELY'
  | 'PROXY_LIKELY'
  | 'MACHINE_LIKELY'
  | 'UNKNOWN';

export type OpenRequestSource =
  | 'browser_like'
  | 'google_image_proxy'
  | 'scanner'
  | 'headless'
  | 'unknown';

export const SELF_VIEW_PRE_WINDOW_MS = 3_000;
export const SELF_VIEW_POST_WINDOW_MS = 8_000;

export function isSelfViewCorrelated(openTs: number, selfViewTs: number): boolean {
  if (!Number.isFinite(openTs) || !Number.isFinite(selfViewTs)) return false;
  return openTs >= selfViewTs - SELF_VIEW_PRE_WINDOW_MS && openTs <= selfViewTs + SELF_VIEW_POST_WINDOW_MS;
}

export function detectOpenRequestSource(userAgent?: string | null): OpenRequestSource {
  if (!userAgent || typeof userAgent !== 'string') return 'unknown';
  const ua = userAgent.trim();
  if (!ua) return 'unknown';

  // 1. Google Image Proxy (ggpht / GoogleImageProxy)
  if (/(googleimageproxy|ggpht)/i.test(ua)) {
    return 'google_image_proxy';
  }

  // 2. Headless browsers & Lighthouse
  if (/(headless|lighthouse|chrome-lighthouse)/i.test(ua)) {
    return 'headless';
  }

  // 3. Security scanners, bots, crawlers, prefetch.
  // Gmail's delivery prefetch uses this frozen Chrome 42 + Edge 12 pair and hits the
  // pixel within seconds of send. It is not a person opening the message.
  if (
    /(scanner|security|barracuda|proofpoint|mimecast|sophos|symantec|trend\s?micro|avast|bitdefender|virustotal|fireeye|paloalto|zscaler)/i.test(
      ua,
    ) ||
    /\b(bot|crawler|spider|slurp|prefetch|preview)\b/i.test(ua) ||
    /(facebookexternalhit|whatsapp|telegrambot|twitterbot|discordbot|googlebot)/i.test(ua) ||
    /\b(mailproxy|imageproxy)\b/i.test(ua) ||
    (/chrome\/42\.0\.2311\.135/i.test(ua) && /edge\/12\.246/i.test(ua))
  ) {
    return 'scanner';
  }

  // 4. Standard web browsers / mail clients
  if (/mozilla\/\d/i.test(ua) && /(applewebkit|gecko|chrome|safari|firefox|trident|edg)/i.test(ua)) {
    return 'browser_like';
  }

  if (/(?:gmail\/|outlook[-/ ](?:ios|android)|applemail\/|iphone mail\/|android mail\/|samsung email\/|yahoo.?mail\/)/i.test(ua)) {
    return 'browser_like';
  }

  return 'unknown';
}

export function normalizeUserAgentFamily(userAgent?: string | null): string | null {
  if (!userAgent || typeof userAgent !== 'string') return null;
  const ua = userAgent.trim();
  if (!ua) return null;
  if (/(googleimageproxy|ggpht)/i.test(ua)) return 'google_image_proxy';
  if (/(headless|lighthouse|chrome-lighthouse)/i.test(ua)) return 'headless';
  if (/edg\/|edge\//i.test(ua)) return 'edge';
  if (/firefox|fxios/i.test(ua)) return 'firefox';
  if (/chrome|crios|chromium/i.test(ua)) return 'chrome';
  if (/safari/i.test(ua)) return 'safari';
  if (/mozilla\/\d/i.test(ua)) return 'mozilla';
  return 'other';
}

export function uaFamiliesCompatible(left?: string | null, right?: string | null): boolean {
  return Boolean(left && right && left === right);
}

export type SenderFingerprint = {
  senderIpHash?: string | null;
  senderUaFamily?: string | null;
};

export function senderFingerprintMatches(
  claim: SenderFingerprint | null | undefined,
  request: { ipHash?: string | null; userAgent?: string | null },
): boolean {
  if (!claim?.senderIpHash || !request.ipHash) return false;
  if (claim.senderIpHash !== request.ipHash) return false;
  return uaFamiliesCompatible(claim.senderUaFamily, normalizeUserAgentFamily(request.userAgent));
}

export function openEventMatchesSenderClaim(opts: {
  eventType: string;
  eventTs: number;
  claimStartMs: number;
  claimEndMs: number;
  userAgent?: string | null;
  ipHash?: string | null;
  senderIpHash?: string | null;
  senderUaFamily?: string | null;
}): boolean {
  if (opts.eventType !== 'OPEN' && opts.eventType !== 'CLICK') return false;
  if (!Number.isFinite(opts.eventTs) || opts.eventTs < opts.claimStartMs || opts.eventTs > opts.claimEndMs) return false;
  if (detectOpenRequestSource(opts.userAgent) !== 'browser_like') return false;
  return senderFingerprintMatches(
    { senderIpHash: opts.senderIpHash, senderUaFamily: opts.senderUaFamily },
    { ipHash: opts.ipHash, userAgent: opts.userAgent },
  );
}

/** Duplicate Google proxy renders of one sender view, not the 25s claim TTL. */
export const SENDER_PROXY_BURST_MS = 2_000;

/**
 * GoogleImageProxy fetches this soon after send are Gmail rendering the message in the sender's
 * own session as it sends, or prefetching it on delivery to a recipient with Gmail open. Neither
 * is someone reading it, and the sender's claim often arrives too late to cover them.
 */
export const DELIVERY_PROXY_WINDOW_MS = 20_000;

export type ProxySuppressionMode = 'consume' | 'burst' | 'none';

export type ProxyClaimCandidate = {
  id: string;
  gmailMessageId?: string | null;
  lastObservedAt: string;
  expiresAt: string;
  proxyConsumedByEventId?: string | null;
  proxyConsumedAt?: string | null;
};

export function senderProxySuppressionMode(
  claim: Pick<ProxyClaimCandidate, 'expiresAt' | 'proxyConsumedByEventId' | 'proxyConsumedAt'> | null | undefined,
  nowMs: number,
): ProxySuppressionMode {
  if (!claim) return 'none';
  const expiresMs = Date.parse(claim.expiresAt);
  const unexpired = Number.isFinite(expiresMs) && expiresMs > nowMs;
  if (!claim.proxyConsumedByEventId) return unexpired ? 'consume' : 'none';
  const consumedMs = claim.proxyConsumedAt ? Date.parse(claim.proxyConsumedAt) : Number.NaN;
  if (Number.isFinite(consumedMs) && Math.abs(nowMs - consumedMs) <= SENDER_PROXY_BURST_MS) return 'burst';
  return 'none';
}

/** One active claim can suppress a single sender proxy render, plus a short duplicate burst. */
export function selectSenderProxyClaim<T extends ProxyClaimCandidate>(
  claims: T[],
  nowMs: number,
  gmailMessageId?: string | null,
): { claim: T; mode: Exclude<ProxySuppressionMode, 'none'> } | null {
  const normQuery = normalizeGmailId(gmailMessageId);
  const relevant = claims.filter((claim) => {
    const expiresMs = Date.parse(claim.expiresAt);
    const unexpired = Number.isFinite(expiresMs) && expiresMs > nowMs;
    return unexpired || senderProxySuppressionMode(claim, nowMs) === 'burst';
  });
  if (relevant.length === 0) return null;
  relevant.sort((a, b) => {
    if (normQuery) {
      const aExact = normalizeGmailId(a.gmailMessageId) === normQuery ? 1 : 0;
      const bExact = normalizeGmailId(b.gmailMessageId) === normQuery ? 1 : 0;
      if (aExact !== bExact) return bExact - aExact;
    }
    return (Date.parse(b.lastObservedAt) || 0) - (Date.parse(a.lastObservedAt) || 0);
  });
  const claim = relevant[0]!;
  const mode = senderProxySuppressionMode(claim, nowMs);
  if (mode === 'none') return null;
  return { claim, mode };
}

type StoredClaim = {
  gmail_message_id: string | null;
  last_observed_at: string;
  expires_at: string;
  consumed_by_event_id: string | null;
  consumed_at?: string | null;
  consumed_ua?: string | null;
  consumed_ip_hash?: string | null;
};

/**
 * The unconsumed, unexpired claim a pixel request should be checked against:
 * an exact Gmail message match first, then the most recently observed claim.
 * Same rule as `TrackerStore.getActiveClaim`, applied to rows already loaded.
 */
export function pickActiveClaim<T extends StoredClaim>(claims: T[], gmailMessageId: string | null | undefined, nowMs: number): T | null {
  const wanted = normalizeGmailId(gmailMessageId);
  const active = claims
    .filter((claim) => {
      if (claim.consumed_by_event_id) return false;
      const expires = Date.parse(claim.expires_at);
      return !(Number.isFinite(expires) && expires <= nowMs);
    })
    .sort((a, b) => (Date.parse(b.last_observed_at) || 0) - (Date.parse(a.last_observed_at) || 0));
  if (active.length === 0) return null;
  if (wanted) {
    const exact = active.find((claim) => normalizeGmailId(claim.gmail_message_id) === wanted);
    if (exact) return exact;
  }
  return active[0]!;
}

/**
 * A claim consumed within `graceMs` of now by a request from the same client, if any.
 * Same rule as `TrackerStore.getRecentConsumedClaim`, applied to rows already loaded.
 */
export function pickRecentConsumedClaim<T extends StoredClaim>(
  claims: T[],
  nowMs: number,
  graceMs: number,
  ua: string | null,
  ipHash: string | null,
): T | null {
  const consumed = claims.filter((claim) => {
    if (!claim.consumed_by_event_id || !claim.consumed_at) return false;
    const consumedMs = Date.parse(claim.consumed_at);
    if (!Number.isFinite(consumedMs) || Math.abs(nowMs - consumedMs) > graceMs) return false;
    if (ua && claim.consumed_ua && claim.consumed_ua !== ua) return false;
    if (ipHash && claim.consumed_ip_hash && claim.consumed_ip_hash !== ipHash) return false;
    return true;
  });
  consumed.sort((a, b) => (Date.parse(b.consumed_at || '') || 0) - (Date.parse(a.consumed_at || '') || 0));
  return consumed[0] ?? null;
}

/** GoogleImageProxy renders in this window after a document reload can be the sender's own refresh. */
export const PAGE_RELOAD_PROXY_WINDOW_MS = 8_000;

export type PageReloadProxyEvent = {
  eventId?: string;
  id?: string;
  type: string;
  timestamp: string;
  classification?: string | null;
  userAgent?: string | null;
  user_agent?: string | null;
};

export type PageReloadProxyPlan = {
  /** PROXY_LIKELY GoogleImageProxy event to mark SELF_LIKELY. At most one. */
  reclassifyEventId: string | null;
  proxyConsumedByEventId: string | null;
  proxyConsumedAt: string | null;
  /**
   * False when this reload already consumed its slot and there is no PROXY_LIKELY
   * event left to attach. Callers must leave the claim's proxy fields unchanged.
   */
  updateProxySlot: boolean;
};

function pageReloadEventKey(evt: PageReloadProxyEvent): string {
  return evt.eventId || evt.id || '';
}

/**
 * Plan the one-shot proxy slot for a PAGE_RELOAD self-view.
 * Picks the earliest GoogleImageProxy open in [navigationStartedAt, navigationStartedAt + window].
 * Browser opens are ignored; sender-fingerprint matching stays on the existing claim path.
 * A consumed slot from before this reload is cleared when no GoogleImageProxy render has happened since navigationStartedAt.
 */
export function planPageReloadProxy(
  events: PageReloadProxyEvent[],
  navigationStartedAt: number,
  current?: { proxyConsumedByEventId?: string | null; proxyConsumedAt?: string | null } | null,
  windowMs = PAGE_RELOAD_PROXY_WINDOW_MS,
): PageReloadProxyPlan {
  const keep: PageReloadProxyPlan = {
    reclassifyEventId: null,
    proxyConsumedByEventId: current?.proxyConsumedByEventId ?? null,
    proxyConsumedAt: current?.proxyConsumedAt ?? null,
    updateProxySlot: false,
  };
  if (!Number.isFinite(navigationStartedAt)) return keep;
  const windowEnd = navigationStartedAt + windowMs;
  const candidates = events.filter((evt) => {
    if (evt.type !== 'OPEN') return false;
    const classification = evt.classification || '';
    if (classification !== 'PROXY_LIKELY' && classification !== 'SELF_LIKELY') return false;
    const ua = evt.userAgent ?? evt.user_agent ?? null;
    if (detectOpenRequestSource(ua) !== 'google_image_proxy') return false;
    const ts = Date.parse(evt.timestamp);
    if (!Number.isFinite(ts) || ts < navigationStartedAt) return false;
    return Boolean(pageReloadEventKey(evt));
  });
  candidates.sort((a, b) => {
    const delta = Date.parse(a.timestamp) - Date.parse(b.timestamp);
    if (delta !== 0) return delta;
    return pageReloadEventKey(a).localeCompare(pageReloadEventKey(b));
  });
  const chosen = candidates[0];
  if (chosen) {
    const id = pageReloadEventKey(chosen);
    const chosenMs = Date.parse(chosen.timestamp);
    const inWindow = chosenMs <= windowEnd;
    return {
      reclassifyEventId: inWindow && chosen.classification === 'PROXY_LIKELY' ? id : null,
      proxyConsumedByEventId: id,
      proxyConsumedAt: chosen.timestamp,
      updateProxySlot: true,
    };
  }
  const consumedMs = current?.proxyConsumedAt ? Date.parse(current.proxyConsumedAt) : Number.NaN;
  if (
    current?.proxyConsumedByEventId &&
    Number.isFinite(consumedMs) &&
    consumedMs >= navigationStartedAt &&
    consumedMs <= windowEnd
  ) {
    return keep;
  }
  return {
    reclassifyEventId: null,
    proxyConsumedByEventId: null,
    proxyConsumedAt: null,
    updateProxySlot: true,
  };
}

export const JUST_SENT_SELF_VIEW_MS = 30_000;
export type JustSentProxyPlan = { reclassifyEventIds: string[]; proxyConsumedByEventId: string; proxyConsumedAt: string };

export function planJustSentProxy(
  events: PageReloadProxyEvent[],
  opts: { sentAtMs: number | null; selfViewMs: number; proxySlotConsumed: boolean; quotedRender?: boolean },
): JustSentProxyPlan | null {
  const { sentAtMs, selfViewMs } = opts;
  if (opts.proxySlotConsumed) return null;
  if (sentAtMs == null || !Number.isFinite(sentAtMs) || !Number.isFinite(selfViewMs)) return null;
  const justSent = Math.abs(selfViewMs - sentAtMs) <= JUST_SENT_SELF_VIEW_MS;
  if (!justSent && !opts.quotedRender) return null;
  // Gmail renders a just-sent reply at send time, which can be well before the first self-view.
  const windowStart = justSent
    ? Math.min(selfViewMs - SELF_VIEW_PRE_WINDOW_MS, sentAtMs)
    : selfViewMs - SELF_VIEW_PRE_WINDOW_MS;
  const windowEnd = selfViewMs + PAGE_RELOAD_PROXY_WINDOW_MS;
  const proxies = events
    .filter((evt) => {
      if (evt.type !== "OPEN" || !pageReloadEventKey(evt)) return false;
      if (detectOpenRequestSource(evt.userAgent ?? evt.user_agent ?? null) !== "google_image_proxy") return false;
      const ts = Date.parse(evt.timestamp);
      return Number.isFinite(ts) && ts >= windowStart && ts <= windowEnd;
    })
    .sort((a, b) => Date.parse(a.timestamp) - Date.parse(b.timestamp));
  const first = proxies[0];
  if (!first) return null;
  // The send-time render was already left uncounted by the delivery window; it still spends the slot.
  if (first.classification === "MACHINE_LIKELY") {
    return { reclassifyEventIds: [], proxyConsumedByEventId: pageReloadEventKey(first), proxyConsumedAt: first.timestamp };
  }
  // A proxy already marked SELF_LIKELY means this render was handled; later ones are recipients.
  if (first.classification !== "PROXY_LIKELY") return null;
  const firstMs = Date.parse(first.timestamp);
  const reclassifyEventIds = proxies
    .filter((evt) => evt.classification === "PROXY_LIKELY" && Date.parse(evt.timestamp) - firstMs <= SENDER_PROXY_BURST_MS)
    .map(pageReloadEventKey);
  return {
    reclassifyEventIds,
    proxyConsumedByEventId: pageReloadEventKey(first),
    proxyConsumedAt: first.timestamp,
  };
}

/** Reconcile the same short duplicate burst handled by the live pixel classifier. */
export function pageReloadProxyReclassifications(events: PageReloadProxyEvent[], plan: PageReloadProxyPlan, navigationStartedAt: number): string[] {
  const consumedAt = plan.proxyConsumedAt ? Date.parse(plan.proxyConsumedAt) : Number.NaN;
  if (!Number.isFinite(consumedAt) || consumedAt < navigationStartedAt || consumedAt > navigationStartedAt + PAGE_RELOAD_PROXY_WINDOW_MS) return [];
  return events.filter((event) => event.type === 'OPEN' && event.classification === 'PROXY_LIKELY'
    && detectOpenRequestSource(event.userAgent ?? event.user_agent) === 'google_image_proxy'
    && Date.parse(event.timestamp) >= consumedAt && Date.parse(event.timestamp) <= consumedAt + SENDER_PROXY_BURST_MS)
    .map((event) => pageReloadEventKey(event)).filter(Boolean);
}

function machineOpenVerdict(source: OpenRequestSource): {
  classification: OpenClassification;
  suspected: boolean;
  confidence: number;
  countsAsOpen: boolean;
  source: OpenRequestSource;
} | null {
  if (source === 'headless' || source === 'scanner') {
    return { classification: 'MACHINE_LIKELY', suspected: true, confidence: 0.9, countsAsOpen: false, source };
  }
  return null;
}

export function classifyOpen(opts: {
  sentAt: string | null;
  now: number;
  ua: string | null;
  selfViewTs?: number | null;
  hasActiveSenderClaim?: boolean;
  hasActiveSenderProxySuppression?: boolean;
}): {
  classification: OpenClassification;
  suspected: boolean;
  confidence: number;
  countsAsOpen: boolean;
  source: OpenRequestSource;
} {
  const sentMs = opts.sentAt ? Date.parse(opts.sentAt) : Number.NaN;
  const source = detectOpenRequestSource(opts.ua);

  if (!opts.sentAt || !Number.isFinite(sentMs) || opts.now < sentMs) {
    return {
      classification: 'SELF_LIKELY',
      suspected: true,
      confidence: 1,
      countsAsOpen: false,
      source,
    };
  }

  const machine = machineOpenVerdict(source);
  if (machine) return machine;

  if (source === 'google_image_proxy') {
    if (opts.hasActiveSenderProxySuppression) {
      return {
        classification: 'SELF_LIKELY',
        suspected: true,
        confidence: 1,
        countsAsOpen: false,
        source,
      };
    }
    return {
      classification: 'PROXY_LIKELY',
      suspected: false,
      confidence: 0.8,
      countsAsOpen: true,
      source,
    };
  }

  if (source === 'unknown') {
    return {
      classification: 'UNKNOWN',
      suspected: true,
      confidence: 0.5,
      countsAsOpen: false,
      source,
    };
  }

  if (opts.hasActiveSenderClaim) {
    return {
      classification: 'SELF_LIKELY',
      suspected: true,
      confidence: 1,
      countsAsOpen: false,
      source,
    };
  }

  if (opts.selfViewTs != null && isSelfViewCorrelated(opts.now, opts.selfViewTs)) {
    return {
      classification: 'SELF_LIKELY',
      suspected: true,
      confidence: 1,
      countsAsOpen: false,
      source,
    };
  }

  return {
    classification: 'RECIPIENT_LIKELY',
    suspected: false,
    confidence: 0,
    countsAsOpen: true,
    source,
  };
}

export function decideTrackedOpen(opts: {
  sentAt: string | null;
  now: number;
  ua: string | null;
  ipHash?: string | null;
  selfViewTs?: number | null;
  activeClaim?: SenderFingerprint | null;
  recentConsumedMatches?: boolean;
  proxySuppression?: ProxySuppressionMode;
}): ReturnType<typeof classifyOpen> & { consumeClaim: boolean; consumeProxySuppression: boolean } {
  const sentMs = opts.sentAt ? Date.parse(opts.sentAt) : Number.NaN;
  const source = detectOpenRequestSource(opts.ua);
  const idle = { consumeClaim: false, consumeProxySuppression: false };

  if (!opts.sentAt || !Number.isFinite(sentMs) || opts.now < sentMs) {
    return {
      classification: 'SELF_LIKELY',
      suspected: true,
      confidence: 1,
      countsAsOpen: false,
      source,
      ...idle,
    };
  }

  if (source === 'headless' || source === 'scanner') {
    return {
      classification: 'MACHINE_LIKELY',
      suspected: true,
      confidence: 0.9,
      countsAsOpen: false,
      source,
      ...idle,
    };
  }

  if (source === 'google_image_proxy') {
    const mode = opts.proxySuppression ?? 'none';
    if (mode === 'consume' || mode === 'burst') {
      return {
        classification: 'SELF_LIKELY',
        suspected: true,
        confidence: 1,
        countsAsOpen: false,
        source,
        consumeClaim: false,
        consumeProxySuppression: mode === 'consume',
      };
    }
    if (opts.now - sentMs <= DELIVERY_PROXY_WINDOW_MS) {
      return {
        classification: 'MACHINE_LIKELY',
        suspected: true,
        confidence: 0.9,
        countsAsOpen: false,
        source,
        ...idle,
      };
    }
    return {
      classification: 'PROXY_LIKELY',
      suspected: false,
      confidence: 0.8,
      countsAsOpen: true,
      source,
      ...idle,
    };
  }

  if (source === 'unknown') {
    return {
      classification: 'UNKNOWN',
      suspected: true,
      confidence: 0.5,
      countsAsOpen: false,
      source,
      ...idle,
    };
  }

  if (senderFingerprintMatches(opts.activeClaim, { ipHash: opts.ipHash, userAgent: opts.ua })) {
    return {
      classification: 'SELF_LIKELY',
      suspected: true,
      confidence: 1,
      countsAsOpen: false,
      source: 'browser_like',
      consumeClaim: true,
      consumeProxySuppression: false,
    };
  }
  if (opts.recentConsumedMatches) {
    return {
      classification: 'SELF_LIKELY',
      suspected: true,
      confidence: 1,
      countsAsOpen: false,
      source: 'browser_like',
      consumeClaim: false,
      consumeProxySuppression: false,
    };
  }
  if (opts.selfViewTs != null && isSelfViewCorrelated(opts.now, opts.selfViewTs)) {
    return {
      classification: 'SELF_LIKELY',
      suspected: true,
      confidence: 1,
      countsAsOpen: false,
      source: 'browser_like',
      consumeClaim: false,
      consumeProxySuppression: false,
    };
  }
  return {
    classification: 'RECIPIENT_LIKELY',
    suspected: false,
    confidence: 0,
    countsAsOpen: true,
    source: 'browser_like',
    ...idle,
  };
}

export type ClickClassification =
  | 'RECIPIENT_LIKELY'
  | 'SELF_LIKELY'
  | 'MACHINE_LIKELY'
  | 'UNKNOWN';

export type ClickVerdict = {
  classification: ClickClassification;
  suspected: boolean;
  confidence: number;
  countsAsClick: boolean;
  source: OpenRequestSource;
};

export function classifyClick(opts: {
  sentAt: string | null;
  now: number;
  ua: string | null;
  selfViewTs?: number | null;
}): ClickVerdict {
  const sentMs = opts.sentAt ? Date.parse(opts.sentAt) : Number.NaN;
  const source = detectOpenRequestSource(opts.ua);

  // Pre-send clicks
  if (!opts.sentAt || !Number.isFinite(sentMs) || opts.now < sentMs) {
    return {
      classification: 'SELF_LIKELY',
      suspected: true,
      confidence: 1,
      countsAsClick: false,
      source,
    };
  }

  // Sender self-view correlation
  if (opts.selfViewTs != null && isSelfViewCorrelated(opts.now, opts.selfViewTs)) {
    return {
      classification: 'SELF_LIKELY',
      suspected: true,
      confidence: 1,
      countsAsClick: false,
      source,
    };
  }

  // Machine / scanner fetches
  if (source === 'headless' || source === 'scanner' || source === 'google_image_proxy') {
    return {
      classification: 'MACHINE_LIKELY',
      suspected: true,
      confidence: 0.9,
      countsAsClick: false,
      source,
    };
  }

  if (source === 'unknown') {
    return {
      classification: 'UNKNOWN',
      suspected: true,
      confidence: 0.5,
      countsAsClick: false,
      source,
    };
  }

  return {
    classification: 'RECIPIENT_LIKELY',
    suspected: false,
    confidence: 0,
    countsAsClick: true,
    source,
  };
}

export type TrackingEventLike = {
  type: string;
  timestamp: string;
  classification?: string | null;
  suspected_self_open?: boolean;
  suspectedSelfOpen?: boolean;
  user_agent?: string | null;
  userAgent?: string | null;
};

export type DerivedTrackingStats = {
  openCount: number;
  firstOpenedAt: string | null;
  lastOpenedAt: string | null;
  clickCount: number;
  firstClickedAt: string | null;
  lastClickedAt: string | null;
  pixelLoadCount: number;
  possibleOpenCount: number;
};

export function deriveTrackingStats(events: TrackingEventLike[]): DerivedTrackingStats {
  const sorted = [...events].sort((a, b) => (a.timestamp > b.timestamp ? 1 : a.timestamp < b.timestamp ? -1 : 0));
  let openCount = 0;
  let firstOpenedAt: string | null = null;
  let lastOpenedAt: string | null = null;
  let lastValidOpenMs = 0;

  let pixelLoadCount = 0;
  let possibleOpenCount = 0;
  let lastPossibleOpenMs = 0;

  let clickCount = 0;
  let firstClickedAt: string | null = null;
  let lastClickedAt: string | null = null;

  for (const evt of sorted) {
    if (evt.type === 'OPEN') {
      pixelLoadCount += 1;
      const isSelf = Boolean(evt.suspected_self_open || evt.suspectedSelfOpen || evt.classification === 'SELF_LIKELY');
      const ua = evt.user_agent || evt.userAgent;
      const detectedSource = ua ? detectOpenRequestSource(ua) : null;
      const isDetectedNonCount =
        detectedSource === 'google_image_proxy' ||
        detectedSource === 'headless' ||
        detectedSource === 'scanner' ||
        detectedSource === 'unknown';
      const isDetectedMachine = detectedSource === 'headless' || detectedSource === 'scanner';
      const isCountable =
        !isSelf &&
        !isDetectedMachine &&
        evt.classification !== 'MACHINE_LIKELY' &&
        evt.classification !== 'UNKNOWN' &&
        (evt.classification === 'RECIPIENT_LIKELY' ||
          evt.classification === 'PROXY_LIKELY' ||
          (!evt.classification && !isDetectedNonCount));

      const evtMs = Date.parse(evt.timestamp);

      if (isCountable) {
        if (!lastValidOpenMs || !Number.isFinite(evtMs) || evtMs < lastValidOpenMs || evtMs - lastValidOpenMs >= 800) {
          openCount += 1;
          lastValidOpenMs = evtMs;
          if (!firstOpenedAt) firstOpenedAt = evt.timestamp;
          lastOpenedAt = evt.timestamp;
        }
      }

      const isProxy = evt.classification === 'PROXY_LIKELY' || detectedSource === 'google_image_proxy';
      if (!isSelf && (isCountable || (isProxy && detectedSource !== 'headless' && detectedSource !== 'scanner'))) {
        if (!lastPossibleOpenMs || !Number.isFinite(evtMs) || evtMs < lastPossibleOpenMs || evtMs - lastPossibleOpenMs >= 800) {
          possibleOpenCount += 1;
          lastPossibleOpenMs = evtMs;
        }
      }
    } else if (evt.type === 'CLICK') {
      const isSelf = Boolean(evt.suspected_self_open || evt.suspectedSelfOpen || evt.classification === 'SELF_LIKELY');
      const ua = evt.user_agent || evt.userAgent;
      const detectedSource = ua ? detectOpenRequestSource(ua) : null;
      const isMachine = evt.classification === 'MACHINE_LIKELY' || detectedSource === 'headless' || detectedSource === 'scanner';
      const isExplicitNonRecipient = isSelf || isMachine || evt.classification === 'UNKNOWN';

      const isRecipientClick =
        evt.classification === 'RECIPIENT_LIKELY' ||
        (!evt.classification && !isExplicitNonRecipient);

      if (isRecipientClick) {
        clickCount += 1;
        if (!firstClickedAt) firstClickedAt = evt.timestamp;
        lastClickedAt = evt.timestamp;
      }
    }
  }

  return {
    openCount,
    firstOpenedAt,
    lastOpenedAt,
    clickCount,
    firstClickedAt,
    lastClickedAt,
    pixelLoadCount,
    possibleOpenCount,
  };
}

export function suspectSelfOpen(opts: {
  sentAt: string | null;
  now: number;
  ua: string | null;
}): { suspected: boolean; confidence: number } {
  let score = 0;
  if (opts.sentAt) {
    const delta = opts.now - Date.parse(opts.sentAt);
    if (delta >= 0 && delta < 5000) score += 0.5;
  }
  if (opts.ua && /Headless|Lighthouse/i.test(opts.ua)) score += 0.3;
  return { suspected: score >= 0.5, confidence: Math.min(1, score) };
}
