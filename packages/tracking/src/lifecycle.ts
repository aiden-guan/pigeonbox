/** Open classification and tracker health. No Gmail or network side effects. */

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

export type OpenVerdict = {
  classification: OpenClassification;
  suspected: boolean;
  confidence: number;
  /** Verified countable recipient open. */
  countsAsOpen: boolean;
  source: OpenRequestSource;
};

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

  // Native mobile mail clients may fetch the image without a browser UA.
  if (/(?:gmail\/|outlook[-/ ](?:ios|android)|applemail\/|iphone mail\/|android mail\/|samsung email\/|yahoo.?mail\/)/i.test(ua)) {
    return 'browser_like';
  }

  return 'unknown';
}

/** Coarse browser family used to compare a sender claim with a later pixel request. */
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

/** A claim matches only when both the sender IP hash and UA family agree. */
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

function machineOpenVerdict(source: OpenRequestSource): OpenVerdict | null {
  if (source === 'headless' || source === 'scanner') {
    return {
      classification: 'MACHINE_LIKELY',
      suspected: true,
      confidence: 0.9,
      countsAsOpen: false,
      source,
    };
  }
  return null;
}

/**
 * Classify a pixel fetch.
 * Order: pre-send, scanner/headless, GoogleImageProxy, unknown, then browser-like.
 * A Google proxy counts unless the caller has an active sender proxy suppression.
 * `hasActiveSenderClaim` applies only to browser-like requests.
 */
export function classifyOpenEvent(opts: {
  eventTs: number;
  sentAt: number | null;
  userAgent?: string | null;
  selfViewTs?: number | null;
  hasActiveSenderClaim?: boolean;
  hasActiveSenderProxySuppression?: boolean;
}): OpenVerdict {
  const sentAt = opts.sentAt;
  const source = detectOpenRequestSource(opts.userAgent);

  if (sentAt == null || !Number.isFinite(sentAt) || opts.eventTs < sentAt) {
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

  if (opts.selfViewTs != null && isSelfViewCorrelated(opts.eventTs, opts.selfViewTs)) {
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
  eventTs: number;
  sentAt: number | null;
  userAgent?: string | null;
  ipHash?: string | null;
  selfViewTs?: number | null;
  activeClaim?: SenderFingerprint | null;
  recentConsumedMatches?: boolean;
  proxySuppression?: ProxySuppressionMode;
}): OpenVerdict & { consumeClaim: boolean; consumeProxySuppression: boolean } {
  const source = detectOpenRequestSource(opts.userAgent);
  const sentAt = opts.sentAt;
  const idle = { consumeClaim: false, consumeProxySuppression: false };

  if (sentAt == null || !Number.isFinite(sentAt) || opts.eventTs < sentAt) {
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
    if (opts.eventTs - sentAt <= DELIVERY_PROXY_WINDOW_MS) {
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

  if (senderFingerprintMatches(opts.activeClaim, { ipHash: opts.ipHash, userAgent: opts.userAgent })) {
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
  if (opts.selfViewTs != null && isSelfViewCorrelated(opts.eventTs, opts.selfViewTs)) {
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
  /** Verified countable recipient click. */
  countsAsClick: boolean;
  source: OpenRequestSource;
};

export function classifyClickEvent(opts: {
  eventTs: number;
  sentAt: number | null;
  userAgent?: string | null;
  selfViewTs?: number | null;
}): ClickVerdict {
  const sentAt = opts.sentAt;
  const source = detectOpenRequestSource(opts.userAgent);

  // Pre-send clicks (composer / draft preview)
  if (sentAt == null || !Number.isFinite(sentAt) || opts.eventTs < sentAt) {
    return {
      classification: 'SELF_LIKELY',
      suspected: true,
      confidence: 1,
      countsAsClick: false,
      source,
    };
  }

  // Correlated sender self-view takes precedence
  if (opts.selfViewTs != null && isSelfViewCorrelated(opts.eventTs, opts.selfViewTs)) {
    return {
      classification: 'SELF_LIKELY',
      suspected: true,
      confidence: 1,
      countsAsClick: false,
      source,
    };
  }

  // Machine / scanner fetches (e.g. security scanners inspecting links)
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
  userAgent?: string | null;
  user_agent?: string | null;
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

/** An OPEN event that counts toward `openCount`, before the 800 ms duplicate window. */
function countsAsRecipientOpen(evt: TrackingEventLike): boolean {
  const isSelf = Boolean(evt.suspected_self_open || evt.suspectedSelfOpen || evt.classification === 'SELF_LIKELY');
  const ua = evt.userAgent || evt.user_agent;
  const detectedSource = ua ? detectOpenRequestSource(ua) : null;
  const isDetectedNonCount =
    detectedSource === 'google_image_proxy' ||
    detectedSource === 'headless' ||
    detectedSource === 'scanner' ||
    detectedSource === 'unknown';
  const isDetectedMachine = detectedSource === 'headless' || detectedSource === 'scanner';
  return (
    !isSelf &&
    !isDetectedMachine &&
    evt.classification !== 'MACHINE_LIKELY' &&
    evt.classification !== 'UNKNOWN' &&
    (evt.classification === 'RECIPIENT_LIKELY' ||
      evt.classification === 'PROXY_LIKELY' ||
      (!evt.classification && !isDetectedNonCount))
  );
}

/** A CLICK event that counts toward `clickCount`. */
function countsAsRecipientClick(evt: TrackingEventLike): boolean {
  const isSelf = Boolean(evt.suspected_self_open || evt.suspectedSelfOpen || evt.classification === 'SELF_LIKELY');
  const ua = evt.userAgent || evt.user_agent;
  const detectedSource = ua ? detectOpenRequestSource(ua) : null;
  const isMachine = evt.classification === 'MACHINE_LIKELY' || detectedSource === 'headless' || detectedSource === 'scanner';
  const isExplicitNonRecipient = isSelf || isMachine || evt.classification === 'UNKNOWN';
  return evt.classification === 'RECIPIENT_LIKELY' || (!evt.classification && !isExplicitNonRecipient);
}

export type TrackingTimelineEntry = {
  type: 'OPEN' | 'CLICK';
  timestamp: string;
  /** Link destination, for clicks. */
  destination?: string;
  /** Opens through Gmail's image proxy cannot say which device opened the message. */
  viaProxy?: boolean;
};

/**
 * Every open and click that counts, oldest first. Uses the same rules as
 * deriveTrackingStats, so the timeline length matches the email's counters.
 */
export function deriveTrackingTimeline(events: Array<TrackingEventLike & { destination?: string | null }>): TrackingTimelineEntry[] {
  const sorted = [...events].sort((a, b) => (a.timestamp > b.timestamp ? 1 : a.timestamp < b.timestamp ? -1 : 0));
  const timeline: TrackingTimelineEntry[] = [];
  let lastValidOpenMs = 0;
  for (const evt of sorted) {
    if (evt.type === 'OPEN' && countsAsRecipientOpen(evt)) {
      const evtMs = Date.parse(evt.timestamp);
      if (lastValidOpenMs && Number.isFinite(evtMs) && evtMs >= lastValidOpenMs && evtMs - lastValidOpenMs < 800) continue;
      lastValidOpenMs = evtMs;
      const ua = evt.userAgent || evt.user_agent;
      const viaProxy = evt.classification === 'PROXY_LIKELY' || (ua ? detectOpenRequestSource(ua) === 'google_image_proxy' : false);
      timeline.push({ type: 'OPEN', timestamp: evt.timestamp, ...(viaProxy ? { viaProxy } : {}) });
    } else if (evt.type === 'CLICK' && countsAsRecipientClick(evt)) {
      timeline.push({ type: 'CLICK', timestamp: evt.timestamp, ...(evt.destination ? { destination: evt.destination } : {}) });
    }
  }
  return timeline;
}

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
      const ua = evt.userAgent || evt.user_agent;
      const detectedSource = ua ? detectOpenRequestSource(ua) : null;
      const isCountable = countsAsRecipientOpen(evt);

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
      if (countsAsRecipientClick(evt)) {
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

/** Client-side filter for opens the backend already counted. */
export function isCountableOpenEvent(event: {
  classification?: string | null;
  suspected_self_open?: boolean;
  suspectedSelfOpen?: boolean;
  user_agent?: string | null;
  userAgent?: string | null;
}): boolean {
  if (event.suspected_self_open || event.suspectedSelfOpen) return false;
  const classification = event.classification || '';
  if (classification === 'SELF_LIKELY' || classification === 'MACHINE_LIKELY' || classification === 'UNKNOWN') {
    return false;
  }
  const ua = event.user_agent ?? event.userAgent ?? null;
  const source = ua ? detectOpenRequestSource(ua) : null;
  if (classification === 'PROXY_LIKELY') {
    return source === 'google_image_proxy' || (!ua && source == null);
  }
  if (classification === 'RECIPIENT_LIKELY' || !classification) {
    return !source || source === 'browser_like';
  }
  return false;
}

/** InboxSDK and Gmail use several id spellings for the same thread or message. */
export function normalizeGmailId(value: string | null | undefined): string | null {
  if (!value) return null;
  const next = value.trim().replace(/^#/, '').replace(/^(msg-a:|msg-f:|thread-a:|thread-f:)/i, '');
  return next || null;
}

export const TRACKER_PROTOCOL_VERSION = 3;
export const TRACKER_REQUIRED_FEATURES = ['self_view_claims'] as const;
export const TRACKER_SUPPORTED_FEATURES = [
  'self_view_claims',
  'event_reclassification',
  'classified_clicks',
  'sender_fingerprint_claims',
] as const;

export const CLAIM_TTL_MS = 25_000;

export type SelfViewSource =
  | 'ROW_INTERACTION'
  | 'MESSAGE_EXPANDED'
  | 'MESSAGE_LOAD'
  | 'CACHE_REINSPECTION'
  | 'PAGE_RELOAD';

export type SelfViewClaim = {
  id: string;
  trackingId: string;
  gmailMessageId: string | null;
  gmailThreadId: string | null;
  senderIpHash?: string | null;
  senderUaFamily?: string | null;
  firstObservedAt: string;
  lastObservedAt: string;
  expiresAt: string;
  source: SelfViewSource;
  consumedByEventId: string | null;
  proxyConsumedByEventId?: string | null;
  proxyConsumedAt?: string | null;
  createdAt: string;
};

export type TrackerHealthStatus =
  | 'disabled'
  | 'missing'
  | 'invalid_url'
  | 'unauthorized'
  | 'unreachable'
  | 'outdated'
  | 'no_permission'
  | 'healthy';

export type TrackerProbe = {
  status: TrackerHealthStatus;
  label: string;
  protocolVersion?: number;
  features?: string[];
};

export function trackerHealthLabel(status: TrackerHealthStatus): string {
  switch (status) {
    case 'disabled':
      return 'Disabled';
    case 'missing':
      return 'Missing configuration';
    case 'invalid_url':
      return 'Invalid URL';
    case 'unauthorized':
      return 'Unauthorized token';
    case 'unreachable':
      return 'Tracker unreachable';
    case 'outdated':
      return 'Tracker deployment is outdated. Redeploy tracker to enable sender self-open suppression.';
    case 'no_permission':
      return 'Chrome has not allowed PigeonBox to reach this tracker. Click Save to allow it.';
    case 'healthy':
      return 'Tracker healthy';
  }
}

export async function probeTracker(
  baseUrl: string,
  token: string,
  fetcher: typeof fetch = fetch,
): Promise<TrackerProbe> {
  const trimmedUrl = baseUrl.trim();
  const trimmedToken = token.trim();
  if (!trimmedUrl || !trimmedToken) return { status: 'missing', label: trackerHealthLabel('missing') };
  let origin = '';
  try {
    const url = new URL(trimmedUrl);
    if (url.protocol !== 'http:' && url.protocol !== 'https:') {
      return { status: 'invalid_url', label: trackerHealthLabel('invalid_url') };
    }
    origin = url.origin;
  } catch {
    return { status: 'invalid_url', label: trackerHealthLabel('invalid_url') };
  }
  const health = await requestHealth(fetcher, `${origin}/health`);
  if (health.status === 'outdated') {
    return {
      status: 'outdated',
      label: trackerHealthLabel('outdated'),
      protocolVersion: 0,
      features: [],
    };
  }
  if (health.status === 'unreachable') return { status: 'unreachable', label: trackerHealthLabel('unreachable') };

  const protocolVersion = typeof health.data?.protocolVersion === 'number' ? health.data.protocolVersion : 0;
  const features = Array.isArray(health.data?.features) ? health.data.features : [];
  if (protocolVersion < TRACKER_PROTOCOL_VERSION || !features.includes('self_view_claims')) {
    return {
      status: 'outdated',
      label: trackerHealthLabel('outdated'),
      protocolVersion,
      features,
    };
  }

  const authed = await requestOk(fetcher, `${origin}/api/emails?limit=1`, {
    Authorization: `Bearer ${trimmedToken}`,
  });
  if (authed === 'unauthorized') return { status: 'unauthorized', label: trackerHealthLabel('unauthorized') };
  if (authed === 'unreachable') return { status: 'unreachable', label: trackerHealthLabel('unreachable') };
  return {
    status: 'healthy',
    label: trackerHealthLabel('healthy'),
    protocolVersion,
    features,
  };
}

async function requestHealth(
  fetcher: typeof fetch,
  url: string,
): Promise<{ status: 'ok' | 'outdated' | 'unreachable'; data?: { ok?: boolean; protocolVersion?: number; features?: string[] } }> {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), 2500);
  try {
    const response = await fetcher(url, { signal: controller.signal });
    if (response.status === 404) return { status: 'outdated' };
    if (!response.ok) return { status: 'unreachable' };
    const data = await response.json().catch(() => null);
    return { status: 'ok', data: data && typeof data === 'object' ? data : undefined };
  } catch {
    return { status: 'unreachable' };
  } finally {
    clearTimeout(timer);
  }
}

async function requestOk(
  fetcher: typeof fetch,
  url: string,
  headers?: HeadersInit,
): Promise<'ok' | 'unauthorized' | 'unreachable'> {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), 2500);
  try {
    const response = await fetcher(url, { headers, signal: controller.signal });
    if (response.status === 401 || response.status === 403) return 'unauthorized';
    return response.ok ? 'ok' : 'unreachable';
  } catch {
    return 'unreachable';
  } finally {
    clearTimeout(timer);
  }
}

export type TrackingSendReport = {
  composeSessionId: string;
  kind: string;
  state: string;
  trackingId: string | null;
  allocation: boolean;
  draftId: boolean;
  modifierRegistered: boolean;
  modifierInvoked: boolean;
  pixelPresent: boolean;
  gmailSent: boolean;
  gmailIdsLinked: boolean;
  lastError: string | null;
  logs: Array<{ event: string; detail: string }>;
};

export type TrackingPixelEventDiagnostic = {
  trackingId: string;
  eventType: string;
  classification: OpenClassification;
  requestSource: OpenRequestSource;
  userAgentCategory: string;
  timestamp: string;
  sentAt: string | null;
  selfViewCorrelated: boolean;
  countsAsOpen: boolean;
};

export type TrackingSelfViewDiagnostic = {
  observedAt: string;
  source: string;
  trackingId: string;
  normalizedMessageId: string | null;
  deliveryStatus: 'delivered' | 'failed' | 'pending';
  claimId: string | null;
  claimExpiresAt: string | null;
  retryCount: number;
  lastError: string | null;
  latestOpenClassification?: string | null;
  claimConsumed: boolean;
  openCount?: number;
};

export type TrackingDiagnosticsReport = {
  health: TrackerHealthStatus;
  endpoint: string;
  auth: string;
  inboxSdk: string;
  pageWorld: string;
  composeHook: string;
  last: TrackingSendReport | null;
  lastPixelEvent?: TrackingPixelEventDiagnostic | null;
  lastSelfView?: TrackingSelfViewDiagnostic | null;
};

export function formatTrackingReport(report: TrackingDiagnosticsReport): string {
  const last = report.last;
  const yes = (value: boolean | undefined) => (value ? 'yes' : 'no');
  const lines = [
    `Tracking: ${trackerHealthLabel(report.health)}`,
    '',
    `Tracker endpoint: ${report.endpoint}`,
    `Tracker auth: ${report.auth}`,
    `InboxSDK: ${report.inboxSdk}`,
    `Page world: ${report.pageWorld}`,
    `Compose hook: ${report.composeHook}`,
    '',
    'Last tracked send:',
    `  allocation: ${yes(last?.allocation)}`,
    `  draft ID: ${yes(last?.draftId)}`,
    `  modifier registered: ${yes(last?.modifierRegistered)}`,
    `  modifier invoked: ${yes(last?.modifierInvoked)}`,
    `  pixel returned in outbound HTML: ${yes(last?.pixelPresent)}`,
    `  Gmail sent event: ${yes(last?.gmailSent)}`,
    `  Gmail IDs linked: ${yes(last?.gmailIdsLinked)}`,
    '',
    `Last tracking ID:`,
    `  ${last?.trackingId || 'none'}`,
    '',
    `Last failure:`,
    `  ${last?.lastError || 'none'}`,
  ];
  if (last?.modifierRegistered && !last.modifierInvoked && last.gmailSent) {
    lines.push(
      '',
      'Tracking injection failed:',
      'InboxSDK request modifier was registered but was never invoked for Gmail send.',
    );
  }
  if (report.lastPixelEvent) {
    lines.push(
      '',
      'Last pixel request:',
      `  tracking ID: ${report.lastPixelEvent.trackingId}`,
      `  source: ${report.lastPixelEvent.requestSource}`,
      `  classification: ${report.lastPixelEvent.classification}`,
      `  counted as recipient open: ${report.lastPixelEvent.countsAsOpen ? 'yes' : 'no'}`,
      `  self-view correlated: ${report.lastPixelEvent.selfViewCorrelated ? 'yes' : 'no'}`,
      `  timestamp: ${report.lastPixelEvent.timestamp}`,
    );
  }
  if (report.lastSelfView) {
    lines.push(
      '',
      'Last self-view claim:',
      `  tracking ID: ${report.lastSelfView.trackingId}`,
      `  message ID: ${report.lastSelfView.normalizedMessageId || 'none'}`,
      `  source: ${report.lastSelfView.source}`,
      `  observed at: ${report.lastSelfView.observedAt}`,
      `  delivery: ${report.lastSelfView.deliveryStatus}`,
      `  claim ID: ${report.lastSelfView.claimId || 'none'}`,
      `  claim expires at: ${report.lastSelfView.claimExpiresAt || 'none'}`,
      `  claim consumed: ${report.lastSelfView.claimConsumed ? 'yes' : 'no'}`,
      `  retry count: ${report.lastSelfView.retryCount}`,
      `  last error: ${report.lastSelfView.lastError || 'none'}`,
      `  open count: ${report.lastSelfView.openCount ?? 'unknown'}`,
    );
  }
  if (last?.logs.length) {
    lines.push('', 'Recent log:');
    for (const entry of last.logs.slice(-8)) {
      lines.push(`  ${entry.event}${entry.detail ? ` ${entry.detail}` : ''}`);
    }
  }
  return lines.join('\n');
}

export type MimeTrackingInspection = {
  pixelFound: boolean;
  trackingIds: string[];
  pixelCount: number;
  trackedLinks: number;
};

/** Inspect raw MIME or an exported .eml. Does not call Gmail. */
export function inspectTrackedMime(raw: string): MimeTrackingInspection {
  const ids = new Set<string>();
  let pixelCount = 0;
  for (const match of raw.matchAll(/<img\b[^>]*\bsrc\s*=\s*["'][^"']*\/open\/(trk_[A-Za-z0-9_-]+)/gi)) {
    pixelCount += 1;
    if (match[1]) ids.add(match[1].replace(/\.(gif|png|jpe?g|webp)$/i, ''));
  }
  if (pixelCount === 0) {
    for (const match of raw.matchAll(/\/open\/(trk_[A-Za-z0-9_-]+)/gi)) {
      if (match[1]) ids.add(match[1].replace(/\.(gif|png|jpe?g|webp)$/i, ''));
    }
  }
  const trackedLinks = raw.match(/\/c\/clk_[A-Za-z0-9_-]+/gi)?.length || 0;
  return {
    pixelFound: pixelCount > 0 || ids.size > 0,
    trackingIds: [...ids],
    pixelCount: pixelCount || (ids.size > 0 ? ids.size : 0),
    trackedLinks,
  };
}
