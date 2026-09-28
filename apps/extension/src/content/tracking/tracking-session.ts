/**
 * Per-compose tracking session. Pure state: no DOM and no network.
 * One session belongs to one InboxSDK compose view.
 */

export type TrackingSessionState =
  | 'INITIAL'
  | 'WAITING_FOR_RECIPIENTS'
  | 'ALLOCATING'
  | 'ALLOCATED'
  | 'WAITING_FOR_DRAFT'
  | 'MODIFIER_REGISTERED'
  | 'SENDING'
  | 'SENT'
  | 'FAILED';

export type ComposeKind = 'new' | 'reply' | 'forward';

export type TrackingLogEntry = { event: string; detail: string };

export type ComposeTrackingSession = {
  composeSessionId: string;
  state: TrackingSessionState;
  kind: ComposeKind;
  trackingId: string | null;
  pixelUrl: string | null;
  linkMap: Map<string, string>;
  trackOpens: boolean;
  trackLinks: boolean;
  trackerCreatedAt: string | null;
  gmailDraftId: string | null;
  gmailThreadId: string | null;
  gmailMessageId: string | null;
  modifierRegistered: boolean;
  modifierInvocationCount: number;
  modifierSawPixel: boolean;
  sendRecoveryAttempted: boolean;
  recovering: boolean;
  destroyed: boolean;
  lastError: string | null;
  sentAt: string | null;
  logs: TrackingLogEntry[];
};

/** How long send recovery may wait for a draft id before the mail goes out untracked. */
export const DRAFT_READY_TIMEOUT_MS = 2500;

export function createTrackingSession(input: {
  composeSessionId: string;
  kind: ComposeKind;
  trackOpens: boolean;
  trackLinks: boolean;
}): ComposeTrackingSession {
  return {
    composeSessionId: input.composeSessionId,
    state: 'INITIAL',
    kind: input.kind,
    trackingId: null,
    pixelUrl: null,
    linkMap: new Map(),
    trackOpens: input.trackOpens,
    trackLinks: input.trackLinks,
    trackerCreatedAt: null,
    gmailDraftId: null,
    gmailThreadId: null,
    gmailMessageId: null,
    modifierRegistered: false,
    modifierInvocationCount: 0,
    modifierSawPixel: false,
    sendRecoveryAttempted: false,
    recovering: false,
    destroyed: false,
    lastError: null,
    sentAt: null,
    logs: [],
  };
}

export function logTracking(
  session: ComposeTrackingSession,
  event: string,
  fields: Record<string, string | number | boolean | null | undefined> = {},
): void {
  const detail = Object.entries(fields)
    .filter((entry) => entry[1] !== undefined)
    .map(([key, value]) => `${key}=${value}`)
    .join(' ');
  session.logs.push({ event, detail });
  if (session.logs.length > 40) session.logs.splice(0, session.logs.length - 40);
  const line = detail ? `[tracking] ${event} ${detail}` : `[tracking] ${event}`;
  console.info(line);
}

/** Draft id InboxSDK binds to `registerRequestModifier` (`input[name=draft]`, without `msg-a:`). */
export function normalizeDraftId(value: string | null | undefined): string | null {
  if (!value) return null;
  const next = value.trim().replace(/^#/, '').replace(/^msg-a:/i, '');
  if (!next || next === 'undefined' || next === 'null') return null;
  return next;
}

export function wantsTracking(session: ComposeTrackingSession): boolean {
  return session.trackOpens || session.trackLinks;
}

export type PresendDecision = 'allow' | 'recover';

/**
 * Allow the send when the modifier is already bound to a tracker.
 * Otherwise cancel once so registration can catch the draft id.
 * A second presending pass must allow, or Send loops forever.
 */
export function decidePresending(session: ComposeTrackingSession, trackingConfigured: boolean): PresendDecision {
  if (!trackingConfigured || !wantsTracking(session)) return 'allow';
  if (session.sendRecoveryAttempted || session.recovering) return 'allow';
  if (session.modifierRegistered && session.trackingId && session.pixelUrl) return 'allow';
  return 'recover';
}

export function composeTrackingLabel(opts: {
  enabled: boolean;
  configured: boolean;
  session: ComposeTrackingSession | undefined;
}): { label: string; tone: 'disabled' | 'unavailable' | 'preparing' | 'ready' } {
  if (!opts.enabled) return { label: 'Tracking disabled', tone: 'disabled' };
  if (!opts.configured) return { label: 'Tracking unavailable', tone: 'unavailable' };
  const session = opts.session;
  if (session?.modifierRegistered && session.trackingId && session.pixelUrl && wantsTracking(session)) {
    return { label: 'Tracking ready', tone: 'ready' };
  }
  if (session?.state === 'FAILED' && !session.modifierRegistered) {
    return { label: 'Tracking unavailable', tone: 'unavailable' };
  }
  return { label: 'Preparing tracking…', tone: 'preparing' };
}
