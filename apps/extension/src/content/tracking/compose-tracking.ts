import type { ExtensionSettings, PublicExtensionSettings } from '@pigeonbox/shared';
import {
  clickIdFromTrackedUrl,
  decodeHtmlAttribute,
  normalizeGmailId,
  stableClickId,
  trackedClickUrl,
  transformOutgoingHtml,
  type CreateTrackedEmailInput,
  type CreateTrackedEmailResult,
  type TrackedEmailPatch,
} from '@pigeonbox/tracking';
import { findSendButton, SELECTORS } from '@pigeonbox/gmail';
import { ensureSurface } from '../shell/surface';
import { createOrb } from '../../ui/orb-markup';
import {
  composeTrackingLabel,
  createTrackingSession,
  decidePresending,
  DRAFT_READY_TIMEOUT_MS,
  logTracking,
  normalizeDraftId,
  wantsTracking,
  type ComposeKind,
  type ComposeTrackingSession,
} from './tracking-session';

export type { ComposeTrackingSession, TrackingSessionState } from './tracking-session';
export { DRAFT_READY_TIMEOUT_MS, decidePresending, composeTrackingLabel } from './tracking-session';

export type ComposeRecipient = { emailAddress?: string; email?: string };

export type SdkComposeView = {
  on?: (
    event: string,
    cb: (event?: {
      cancel?: () => void;
      getMessageID?: () => Promise<string>;
      getThreadID?: () => Promise<string>;
    }) => void,
  ) => void;
  send?: () => void;
  registerRequestModifier?: (
    modifier: (params: { body: string; isPlainText?: boolean }) => { body: string } | Promise<{ body: string }>,
  ) => void;
  getSubject?: () => string;
  getToRecipients?: () => ComposeRecipient[];
  getCcRecipients?: () => ComposeRecipient[];
  getBccRecipients?: () => ComposeRecipient[];
  getFromContact?: () => { emailAddress?: string } | null;
  getBodyElement?: () => HTMLElement | null;
  getTextContent?: () => string;
  getHTMLContent?: () => string;
  getElement?: () => HTMLElement | null;
  getThreadID?: () => string | null | undefined | Promise<string | null | undefined>;
  getDraftID?: () => Promise<string | null | undefined>;
  getCurrentDraftID?: () => Promise<string | null | undefined>;
  isReply?: () => boolean;
  isForward?: () => boolean;
  addButton?: (desc: unknown) => void;
};

export type ComposeTrackingDeps = {
  getSettings: () => PublicExtensionSettings | ExtensionSettings;
  refreshSettings: () => Promise<void>;
  createTracked: (input: CreateTrackedEmailInput) => Promise<CreateTrackedEmailResult | null>;
  markSent: (patch: TrackedEmailPatch & { trackingId: string }) => void;
  cancelTracked: (trackingId: string) => void;
  /**
   * Store click IDs on the tracker before the message goes out. Resolves true
   * only when the tracker confirmed them; a link whose ID is not stored would
   * send the recipient to an error page, so unconfirmed links are sent as-is.
   */
  registerLinks: (update: { trackingId: string; links: Array<{ click_id: string; url: string }> }) => Promise<boolean>;
  /** Update an unsent tracker's subject and recipients. Resolves true when the tracker confirmed them. */
  updateTracked?: (update: { trackingId: string; subject: string; sender: string; recipients: string[] }) => Promise<boolean>;
  reportDiagnostics?: (session: ComposeTrackingSession) => void;
  onSent?: (info: { subject: string; recipients: string[]; bodyText: string }) => void;
};

const sessions = new Map<string, ComposeTrackingSession>();
const refreshers = new Map<string, () => void>();
const allocationTasks = new Map<string, Promise<ComposeTrackingSession | null>>();
const modifierTasks = new Map<string, Promise<boolean>>();
const detailSyncTimers = new Map<string, number>();
const controlCleanups = new Map<string, () => void>();

/** How long recipient and subject edits settle before the tracker is updated. */
export const DETAILS_SYNC_DEBOUNCE_MS = 800;

export function getComposeSession(composeId: string): ComposeTrackingSession | undefined {
  return sessions.get(composeId);
}

export function listComposeSessions(): ComposeTrackingSession[] {
  return [...sessions.values()];
}

export function resetComposeSessionsForTests(): void {
  for (const cleanup of controlCleanups.values()) cleanup();
  controlCleanups.clear();
  sessions.clear();
  refreshers.clear();
  allocationTasks.clear();
  modifierTasks.clear();
  for (const timer of detailSyncTimers.values()) window.clearTimeout(timer);
  detailSyncTimers.clear();
}

/**
 * Bind tracking to one InboxSDK compose view.
 * The only injection point is `registerRequestModifier`. The live composer is never given a pixel.
 */
export function attachSdkComposeTracking(view: SdkComposeView, deps: ComposeTrackingDeps): string {
  const element = view.getElement?.() || null;
  const composeSessionId = element ? composeElementId(element) : `compose-${Math.random().toString(36).slice(2, 10)}`;
  const settings = deps.getSettings();
  const session = createTrackingSession({
    composeSessionId,
    kind: composeKind(view, element),
    trackOpens: settings.trackOpens,
    trackLinks: settings.trackLinks,
  });
  sessions.set(composeSessionId, session);
  log(session, 'session-created', { kind: session.kind }, deps);
  // Gmail removes recipient chips and the body before its async sent IDs resolve.
  // Keep the final send snapshot in this closure, outside diagnostic session state.
  let sendSnapshot: ReturnType<typeof composeSendSnapshot> | null = null;

  if (element) mountTrackingControl(element, composeSessionId, deps);

  const ensure = () => {
    void ensureTrackingAllocation(composeSessionId, view, deps).then(() => {
      scheduleDetailsSync(composeSessionId, view, deps);
      return ensureRequestModifierRegistered(composeSessionId, view, deps);
    });
  };
  ensure();
  void view.getDraftID?.().then(() => ensure()).catch((error: unknown) => {
    const current = sessions.get(composeSessionId);
    if (!current) return;
    current.lastError = errorMessage(error);
    log(current, 'draft-id-failed', { error: current.lastError }, deps);
  });
  view.on?.('recipientsChanged', ensure);
  view.on?.('draftSaved', () => {
    const current = sessions.get(composeSessionId);
    if (!current) return;
    const nextDraftId = draftIdFromElement(view.getElement?.() ?? null);
    log(current, 'draft-saved', { draftId: nextDraftId }, deps);
    if (current.modifierRegistered && nextDraftId && current.gmailDraftId && nextDraftId !== current.gmailDraftId) {
      current.lastError = 'Draft id changed after the request modifier was registered. The original binding is left in place so send cannot hang.';
      log(current, 'draft-id-changed', { draftId: nextDraftId }, deps);
      return;
    }
    ensure();
  });
  view.on?.('subjectChanged', ensure);
  view.on?.('scheduleSendMenuOpening', () => {
    const current = sessions.get(composeSessionId);
    if (!current) return;
    current.lastError = 'Scheduled send is not marked tracked until Gmail fires sent.';
    log(current, 'scheduled-send-unsupported', {}, deps);
  });

  view.on?.('presending', (event) => {
    const current = sessions.get(composeSessionId);
    if (!current || current.destroyed) return;
    sendSnapshot = composeSendSnapshot(view);
    log(current, 'presending', { state: current.state }, deps);
    const decision = decidePresending(current, trackingConfigured(deps.getSettings()));
    if (decision === 'allow') {
      if (current.state !== 'SENT') current.state = 'SENDING';
      return;
    }
    if (!event?.cancel || !view.send) {
      current.lastError = 'Could not delay send to register the request modifier. The message will send without a pixel.';
      log(current, 'presending-unrecoverable', {}, deps);
      return;
    }
    current.sendRecoveryAttempted = true;
    current.recovering = true;
    event.cancel();
    log(current, 'send-recovery-start', {}, deps);
    void recoverSend(composeSessionId, view, deps);
  });

  view.on?.('sending', () => {
    const current = sessions.get(composeSessionId);
    if (!current) return;
    sendSnapshot ??= composeSendSnapshot(view);
    current.state = 'SENDING';
    log(current, 'sending', {}, deps);
  });

  view.on?.('sendCanceled', () => {
    const current = sessions.get(composeSessionId);
    if (!current || current.recovering) return;
    sendSnapshot = null;
    if (current.state === 'SENDING') {
      current.state = current.modifierRegistered ? 'MODIFIER_REGISTERED' : current.trackingId ? 'ALLOCATED' : current.state;
      log(current, 'send-canceled', {}, deps);
    }
  });

  view.on?.('sent', (event) => {
    const current = sessions.get(composeSessionId);
    if (!current) return;
    current.state = 'SENT';
    clearDetailsSync(composeSessionId);
    void handleSent(current, view, event, deps, sendSnapshot ?? composeSendSnapshot(view));
  });

  view.on?.('destroy', () => {
    const current = sessions.get(composeSessionId);
    if (!current) return;
    current.destroyed = true;
    controlCleanups.get(composeSessionId)?.();
    controlCleanups.delete(composeSessionId);
    refreshers.delete(composeSessionId);
    clearDetailsSync(composeSessionId);
    if (current.state !== 'SENT' && current.state !== 'SENDING' && current.trackingId) {
      deps.cancelTracked(current.trackingId);
      log(current, 'compose-discarded', {}, deps);
    }
    sessions.delete(composeSessionId);
  });

  return composeSessionId;
}

export async function ensureTrackingAllocation(
  composeSessionId: string,
  view: SdkComposeView,
  deps: ComposeTrackingDeps,
): Promise<ComposeTrackingSession | null> {
  const session = sessions.get(composeSessionId);
  if (!session || session.destroyed) return session || null;
  if (session.trackingId && session.pixelUrl) return session;
  const inflight = allocationTasks.get(composeSessionId);
  if (inflight) return inflight;
  const task = allocateNow(composeSessionId, view, deps).finally(() => {
    if (allocationTasks.get(composeSessionId) === task) allocationTasks.delete(composeSessionId);
  });
  allocationTasks.set(composeSessionId, task);
  return task;
}

export async function ensureRequestModifierRegistered(
  composeSessionId: string,
  view: SdkComposeView,
  deps: ComposeTrackingDeps,
): Promise<boolean> {
  const session = sessions.get(composeSessionId);
  if (!session || session.destroyed) return false;
  if (session.modifierRegistered) return true;
  const inflight = modifierTasks.get(composeSessionId);
  if (inflight) return inflight;
  const task = registerNow(composeSessionId, view, deps).finally(() => {
    if (modifierTasks.get(composeSessionId) === task) modifierTasks.delete(composeSessionId);
  });
  modifierTasks.set(composeSessionId, task);
  return task;
}

async function allocateNow(
  composeSessionId: string,
  view: SdkComposeView,
  deps: ComposeTrackingDeps,
): Promise<ComposeTrackingSession | null> {
  const session = sessions.get(composeSessionId);
  if (!session || session.trackingId) return session || null;
  try {
    await deps.refreshSettings();
  } catch (error) {
    session.lastError = errorMessage(error);
    log(session, 'settings-refresh-failed', { error: session.lastError }, deps);
  }
  const settings = deps.getSettings();
  session.trackOpens = settings.trackOpens;
  session.trackLinks = settings.trackLinks;
  if (!trackingConfigured(settings) || !wantsTracking(session)) return session;
  const details = trackedDetails(view);
  if (details.recipients.length === 0) {
    session.state = 'WAITING_FOR_RECIPIENTS';
    log(session, 'waiting-for-recipients', {}, deps);
    return session;
  }
  log(session, 'recipients-ready', { count: details.recipients.length }, deps);
  session.state = 'ALLOCATING';
  log(session, 'allocation-start', {}, deps);
  try {
    const created = await deps.createTracked(details);
    const current = sessions.get(composeSessionId);
    if (!current) return null;
    if (!created?.tracking_id || !created.pixel_url) {
      current.state = 'FAILED';
      current.lastError = 'Tracker did not return a tracking id.';
      log(current, 'allocation-failed', { error: current.lastError }, deps);
      return current;
    }
    current.trackingId = created.tracking_id;
    current.pixelUrl = created.pixel_url;
    current.trackerCreatedAt = created.created_at || new Date().toISOString();
    current.syncedDetails = detailsKey(details);
    for (const link of created.rewritten_links || []) {
      if (!link.original || !link.tracked_url) continue;
      current.linkMap.set(link.original, link.tracked_url);
      // The tracker created these with the email, so they already exist.
      const clickId = clickIdFromTrackedUrl(link.tracked_url);
      if (clickId) current.confirmedClickIds.add(clickId);
    }
    current.state = current.modifierRegistered ? 'MODIFIER_REGISTERED' : 'ALLOCATED';
    let pixelHost = '';
    try {
      pixelHost = new URL(created.pixel_url).host;
    } catch {
      pixelHost = '';
    }
    log(current, 'allocation-success', { trackingId: current.trackingId, pixelHost }, deps);
    return current;
  } catch (error) {
    const current = sessions.get(composeSessionId);
    if (!current) return null;
    current.state = 'FAILED';
    current.lastError = errorMessage(error);
    log(current, 'allocation-failed', { error: current.lastError }, deps);
    return current;
  }
}

/**
 * Recipients and subject can change after the tracker is created. Send them
 * once edits settle so the tracker never holds a stale recipient list, even if
 * Gmail never fires `sent` (scheduled send) or the send-time update fails.
 */
function scheduleDetailsSync(composeSessionId: string, view: SdkComposeView, deps: ComposeTrackingDeps): void {
  const session = sessions.get(composeSessionId);
  if (!session?.trackingId || !deps.updateTracked || !isUnsent(session)) return;
  clearDetailsSync(composeSessionId);
  detailSyncTimers.set(composeSessionId, window.setTimeout(() => {
    detailSyncTimers.delete(composeSessionId);
    void syncDetailsNow(composeSessionId, view, deps);
  }, DETAILS_SYNC_DEBOUNCE_MS));
}

async function syncDetailsNow(composeSessionId: string, view: SdkComposeView, deps: ComposeTrackingDeps): Promise<void> {
  const session = sessions.get(composeSessionId);
  const trackingId = session?.trackingId;
  if (!session || !trackingId || !deps.updateTracked || !isUnsent(session)) return;
  const details = trackedDetails(view);
  // Gmail cannot send without a recipient, and the send-time update carries the final list.
  if (details.recipients.length === 0) return;
  const key = detailsKey(details);
  if (key === session.syncedDetails) return;
  const confirmed = await deps.updateTracked({ trackingId, ...details }).catch(() => false);
  const current = sessions.get(composeSessionId);
  if (!current || current.trackingId !== trackingId) return;
  if (confirmed) {
    current.syncedDetails = key;
    log(current, 'details-synced', { recipients: details.recipients.length }, deps);
  } else {
    log(current, 'details-sync-failed', {}, deps);
  }
}

function clearDetailsSync(composeSessionId: string): void {
  const timer = detailSyncTimers.get(composeSessionId);
  if (timer !== undefined) window.clearTimeout(timer);
  detailSyncTimers.delete(composeSessionId);
}

function isUnsent(session: ComposeTrackingSession): boolean {
  return !session.destroyed && session.state !== 'SENT' && session.state !== 'SENDING';
}

function trackedDetails(view: SdkComposeView): { subject: string; sender: string; recipients: string[] } {
  return {
    subject: (view.getSubject?.() || '').slice(0, 998),
    sender: view.getFromContact?.()?.emailAddress || 'me',
    recipients: collectRecipients(view),
  };
}

function composeSendSnapshot(view: SdkComposeView) {
  return { ...trackedDetails(view), bodyText: view.getTextContent?.() || '' };
}

function detailsKey(details: { subject: string; recipients: string[] }): string {
  return JSON.stringify([details.subject, [...details.recipients].sort()]);
}

async function registerNow(composeSessionId: string, view: SdkComposeView, deps: ComposeTrackingDeps): Promise<boolean> {
  const session = sessions.get(composeSessionId);
  if (!session || session.modifierRegistered) return Boolean(session?.modifierRegistered);
  if (!view.registerRequestModifier) {
    session.lastError = 'InboxSDK request modifier is unavailable.';
    log(session, 'modifier-register-failed', { error: session.lastError }, deps);
    return false;
  }
  const draftId = await readDraftId(view);
  if (!draftId) {
    if (session.trackingId && session.state !== 'FAILED' && session.state !== 'SENT') session.state = 'WAITING_FOR_DRAFT';
    log(session, 'draft-not-ready', {}, deps);
    return false;
  }
  log(session, 'draft-ready', { draftId }, deps);
  log(session, 'modifier-register-start', { draftId }, deps);
  try {
    view.registerRequestModifier((params) => modifyOutgoing(composeSessionId, params, deps));
    const current = sessions.get(composeSessionId);
    if (!current) return false;
    current.modifierRegistered = true;
    current.gmailDraftId = draftId;
    if (current.trackingId) current.state = 'MODIFIER_REGISTERED';
    log(current, 'modifier-register-success', { draftId }, deps);
    return true;
  } catch (error) {
    const current = sessions.get(composeSessionId);
    if (!current) return false;
    current.modifierRegistered = false;
    current.lastError = errorMessage(error);
    log(current, 'modifier-register-failed', { error: current.lastError }, deps);
    return false;
  }
}

async function modifyOutgoing(
  composeSessionId: string,
  params: { body: string; isPlainText?: boolean },
  deps: ComposeTrackingDeps,
): Promise<{ body: string }> {
  const session = sessions.get(composeSessionId);
  const body = params.body || '';
  if (!session) return { body };
  session.modifierInvocationCount += 1;
  const isPlainText = Boolean(params.isPlainText);
  log(session, 'modifier-invoked', {
    trackingId: session.trackingId,
    isPlainText,
    inputBytes: body.length,
  }, deps);
  if (isPlainText) {
    session.lastError = 'Plain-text send was left untracked. InboxSDK does not convert isPlainText into HTML.';
    log(session, 'modifier-plain-text', { outputBytes: body.length }, deps);
    return { body };
  }
  if (!session.trackingId || !session.pixelUrl || !wantsTracking(session)) {
    log(session, 'modifier-passthrough', { outputBytes: body.length }, deps);
    return { body };
  }
  const origin = pixelOrigin(session.pixelUrl);
  const trackingId = session.trackingId;
  let transformed = transformOutgoingHtml(body, {
    pixelUrl: session.pixelUrl,
    linkMap: session.linkMap,
    trackOpens: session.trackOpens,
    trackLinks: session.trackLinks,
    allocateTrackedUrl: (original) => {
      if (!origin) return null;
      const clickId = stableClickId(trackingId, original);
      return trackedClickUrl(origin, clickId);
    },
  });
  const pending = session.trackLinks
    ? linksFromSession(session, true).filter((link) => !session.confirmedClickIds.has(link.click_id))
    : [];
  if (pending.length) {
    const confirmed = await deps.registerLinks({ trackingId, links: pending }).catch(() => false);
    if (confirmed) {
      for (const link of pending) session.confirmedClickIds.add(link.click_id);
      log(session, 'modifier-links-confirmed', { count: pending.length }, deps);
    } else {
      // Send these links untracked: rewrite again with only links the tracker has.
      for (const [original, tracked] of [...session.linkMap]) {
        const clickId = clickIdFromTrackedUrl(tracked);
        if (!clickId || !session.confirmedClickIds.has(clickId)) session.linkMap.delete(original);
      }
      session.lastError = 'Links were sent without click tracking because the tracker did not confirm them.';
      log(session, 'modifier-links-unconfirmed', { count: pending.length }, deps);
      transformed = transformOutgoingHtml(body, {
        pixelUrl: session.pixelUrl,
        linkMap: session.linkMap,
        trackOpens: session.trackOpens,
        trackLinks: session.trackLinks,
      });
    }
  }
  session.modifierSawPixel = transformed.pixelPresent;
  log(session, 'modifier-transformed', {
    pixelPresent: transformed.pixelPresent,
    linksRewritten: transformed.linksRewritten,
    outputBytes: transformed.html.length,
  }, deps);
  if (!transformed.pixelPresent && session.trackOpens) {
    session.lastError = 'Request modifier ran but the tracking pixel was not in the returned HTML.';
    log(session, 'modifier-pixel-missing', {}, deps);
  }
  return { body: transformed.html };
}

async function recoverSend(composeSessionId: string, view: SdkComposeView, deps: ComposeTrackingDeps): Promise<void> {
  const session = sessions.get(composeSessionId);
  if (!session) return;
  try {
    await Promise.race([
      (async () => {
        await ensureTrackingAllocation(composeSessionId, view, deps);
        await waitForDraftId(view, DRAFT_READY_TIMEOUT_MS);
        await ensureRequestModifierRegistered(composeSessionId, view, deps);
      })(),
      wait(DRAFT_READY_TIMEOUT_MS),
    ]);
  } catch (error) {
    session.lastError = errorMessage(error);
    log(session, 'send-recovery-failed', { error: session.lastError }, deps);
  }
  const current = sessions.get(composeSessionId);
  if (!current || current.destroyed) return;
  current.recovering = false;
  if (!current.modifierRegistered || !current.trackingId) {
    current.state = 'FAILED';
    current.lastError = current.lastError || 'Tracking injection failed before send. The message was sent without a pixel.';
    log(current, 'send-recovery-fail-open', { error: current.lastError }, deps);
  } else {
    log(current, 'send-recovery-ready', { draftId: current.gmailDraftId }, deps);
  }
  view.send?.();
}

async function handleSent(
  session: ComposeTrackingSession,
  view: SdkComposeView,
  event: {
    getMessageID?: () => Promise<string>;
    getMessageIDAsync?: () => Promise<string>;
    getThreadID?: () => Promise<string>;
    getThreadIDAsync?: () => Promise<string>;
  } | undefined,
  deps: ComposeTrackingDeps,
  snapshot: ReturnType<typeof composeSendSnapshot>,
): Promise<void> {
  const trackingId = session.trackingId;
  let gmailThreadId: string | null = null;
  let gmailMessageId: string | null = null;
  try {
    const rawThread = typeof event?.getThreadIDAsync === 'function'
      ? await event.getThreadIDAsync()
      : await event?.getThreadID?.();
    gmailThreadId = normalizeGmailId(rawThread) || normalizeGmailId(await readThreadId(view));
  } catch (error) {
    session.lastError = errorMessage(error);
    gmailThreadId = normalizeGmailId(await readThreadId(view));
  }
  try {
    const rawMessage = typeof event?.getMessageIDAsync === 'function'
      ? await event.getMessageIDAsync()
      : await event?.getMessageID?.();
    gmailMessageId = normalizeGmailId(rawMessage);
  } catch (error) {
    session.lastError = errorMessage(error);
    gmailMessageId = null;
  }
  session.gmailThreadId = gmailThreadId;
  session.gmailMessageId = gmailMessageId;
  session.sentAt = new Date().toISOString();
  session.state = 'SENT';
  log(session, 'sent', {
    gmailMessageId,
    gmailThreadId,
  }, deps);
  deps.onSent?.({
    subject: snapshot.subject,
    recipients: snapshot.recipients,
    bodyText: snapshot.bodyText,
  });
  if (!trackingId) return;
  deps.markSent({
    trackingId,
    status: 'SENT',
    sent_at: session.sentAt,
    gmail_thread_id: gmailThreadId,
    gmail_message_id: gmailMessageId,
    subject: snapshot.subject,
    sender: snapshot.sender,
    recipients: snapshot.recipients,
    links: linksFromSession(session),
  });
  log(session, 'backend-linked', {
    gmailMessageId,
    gmailThreadId,
  }, deps);
}

/** Links in the session, by default only those the tracker confirmed. */
function linksFromSession(session: ComposeTrackingSession, includeUnconfirmed = false): Array<{ click_id: string; url: string }> {
  const seen = new Set<string>();
  const links: Array<{ click_id: string; url: string }> = [];
  for (const [original, tracked] of session.linkMap) {
    const clickId = clickIdFromTrackedUrl(tracked);
    if (!clickId || seen.has(clickId)) continue;
    if (!includeUnconfirmed && !session.confirmedClickIds.has(clickId)) continue;
    // linkMap holds both the raw attribute and its decoded URL; the tracker must redirect to the URL.
    const url = decodeHtmlAttribute(original);
    if (!/^https?:\/\//i.test(url)) continue;
    seen.add(clickId);
    links.push({ click_id: clickId, url });
  }
  return links;
}

async function readDraftId(view: SdkComposeView): Promise<string | null> {
  const fromForm = draftIdFromElement(view.getElement?.() ?? null);
  if (fromForm) return fromForm;
  try {
    const current = await view.getCurrentDraftID?.();
    const normalized = normalizeDraftId(typeof current === 'string' ? current : null);
    if (normalized) return normalized;
  } catch {
    /* The draft is not saved yet. */
  }
  return null;
}

function draftIdFromElement(root: ParentNode | null): string | null {
  if (!root) return null;
  const input = root.querySelector?.('input[name="draft"]');
  if (!(input instanceof HTMLInputElement)) return null;
  return normalizeDraftId(input.value);
}

function waitForDraftId(view: SdkComposeView, timeoutMs: number): Promise<string | null> {
  const immediate = draftIdFromElement(view.getElement?.() ?? null);
  if (immediate) return Promise.resolve(immediate);
  return new Promise((resolve) => {
    let settled = false;
    const finish = (id: string | null) => {
      if (settled) return;
      settled = true;
      window.clearTimeout(timer);
      window.clearInterval(pulse);
      resolve(id);
    };
    const look = () => {
      const id = draftIdFromElement(view.getElement?.() ?? null);
      if (id) finish(id);
    };
    view.on?.('draftSaved', look);
    const pulse = window.setInterval(look, 50);
    const timer = window.setTimeout(() => finish(draftIdFromElement(view.getElement?.() ?? null)), timeoutMs);
  });
}

function wait(ms: number): Promise<void> {
  return new Promise((resolve) => {
    window.setTimeout(resolve, ms);
  });
}

async function readThreadId(view: SdkComposeView): Promise<string | null> {
  try {
    const value = await view.getThreadID?.();
    return typeof value === 'string' && value ? value : null;
  } catch {
    return null;
  }
}

function trackingConfigured(settings: PublicExtensionSettings | ExtensionSettings): boolean {
  const hasToken = 'hasPersonalApiToken' in settings
    ? settings.hasPersonalApiToken
    : Boolean(settings.personalApiToken?.trim());
  return Boolean(
    settings.trackingEnabled &&
      settings.trackerBaseUrl.trim() &&
      hasToken &&
      (settings.trackOpens || settings.trackLinks),
  );
}

function collectRecipients(view: SdkComposeView): string[] {
  return [
    ...new Set(
      [...(view.getToRecipients?.() || []), ...(view.getCcRecipients?.() || []), ...(view.getBccRecipients?.() || [])]
        .map((recipient) => (recipient.emailAddress || recipient.email || '').trim().toLowerCase())
        .filter((email) => email.includes('@')),
    ),
  ];
}

function composeKind(view: SdkComposeView, el: HTMLElement | null): ComposeKind {
  if (view.isForward?.()) return 'forward';
  if (view.isReply?.()) return 'reply';
  const label = (el?.getAttribute('aria-label') || '').toLowerCase();
  if (label.includes('forward')) return 'forward';
  if (label.includes('reply')) return 'reply';
  return 'new';
}

function composeElementId(el: HTMLElement): string {
  const existing = el.getAttribute('data-gi-compose-id');
  if (existing) return existing;
  const id = el.id || `compose-${Math.random().toString(36).slice(2, 10)}`;
  el.setAttribute('data-gi-compose-id', id);
  return id;
}

function pixelOrigin(pixelUrl: string): string {
  try {
    return new URL(pixelUrl).origin;
  } catch {
    return '';
  }
}

function log(
  session: ComposeTrackingSession,
  event: string,
  fields: Record<string, string | number | boolean | null | undefined>,
  deps: ComposeTrackingDeps,
): void {
  logTracking(session, event, { composeSessionId: session.composeSessionId, ...fields });
  paint(session.composeSessionId);
  deps.reportDiagnostics?.(session);
}

function paint(composeSessionId: string): void {
  refreshers.get(composeSessionId)?.();
}

function errorMessage(error: unknown): string {
  if (error instanceof Error) return error.message;
  return String(error);
}

function mountTrackingControl(compose: HTMLElement, composeSessionId: string, deps: ComposeTrackingDeps): void {
  if (controlCleanups.has(composeSessionId)) return;
  ensureSurface();
  const button = document.createElement('button');
  button.type = 'button';
  button.className = 'gi-compose-track';
  button.setAttribute('data-gi-ui', 'track-toggle');
  const render = () => {
    const settings = deps.getSettings();
    const status = composeTrackingLabel({
      enabled: settings.trackingEnabled,
      configured: trackingConfigured(settings),
      session: sessions.get(composeSessionId),
    });
    button.dataset.on = status.tone === 'ready' ? '1' : '0';
    button.dataset.tone = status.tone;
    if (status.tone === 'preparing') {
      try {
        const orb = createOrb(26, 'bare', 'analyzing');
        orb.dataset.compact = 'false';
        orb.dataset.visible = 'true';
        const text = document.createElement('span');
        text.textContent = status.label;
        button.replaceChildren(orb, text);
      } catch {
        button.textContent = status.label;
      }
    } else {
      button.textContent = status.label;
    }
    button.title = status.label;
  };
  render();
  refreshers.set(composeSessionId, render);
  button.addEventListener('click', (event) => {
    event.preventDefault();
    event.stopPropagation();
    toggleMenu(button, composeSessionId, deps, render);
  });
  // The badge lives inline, immediately left of Send, inside Send's own
  // container (the same spot it has always had). Do not move it into an
  // InboxSDK status bar, a row below the toolbar, or a wrapper outside Send's
  // parent: each of those stacks it above or below Send. Gmail can render Send
  // late or replace the toolbar, so re-place it whenever the compose changes.
  const place = () => {
    const send = findSendButton(compose) || compose.querySelector<HTMLElement>(SELECTORS.sendButton.join(','));
    const parent = send?.parentElement;
    if (!send || !parent) {
      button.remove();
      return;
    }
    if (button.parentElement !== parent || send.previousElementSibling !== button) parent.insertBefore(button, send);
  };
  const observer = new MutationObserver(place);
  observer.observe(compose, { childList: true, subtree: true });
  place();
  controlCleanups.set(composeSessionId, () => {
    observer.disconnect();
    button.remove();
  });
}

function toggleMenu(
  anchor: HTMLButtonElement,
  composeSessionId: string,
  deps: ComposeTrackingDeps,
  paintButton: () => void,
): void {
  const existing = document.querySelector('[data-gi-ui="track-menu"]');
  if (existing) {
    existing.remove();
    return;
  }
  const session = sessions.get(composeSessionId);
  if (!session) return;
  ensureSurface();
  const menu = document.createElement('div');
  menu.className = 'gi-menu';
  menu.setAttribute('data-gi-ui', 'track-menu');
  menu.append(checkRow('Track opens', session.trackOpens, (on) => {
    session.trackOpens = on;
    paintButton();
  }));
  menu.append(checkRow('Track links', session.trackLinks, (on) => {
    session.trackLinks = on;
    paintButton();
  }));
  const rect = anchor.getBoundingClientRect();
  menu.style.left = `${Math.max(8, rect.left - 80)}px`;
  menu.style.top = `${rect.bottom + 6}px`;
  document.body.append(menu);
}

function checkRow(label: string, checked: boolean, onChange: (on: boolean) => void): HTMLLabelElement {
  const row = document.createElement('label');
  row.className = 'gi-menu-row';
  const input = document.createElement('input');
  input.type = 'checkbox';
  input.checked = checked;
  input.addEventListener('change', () => onChange(input.checked));
  row.append(input, document.createTextNode(label));
  return row;
}
