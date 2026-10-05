import { ensureWorkspace, showFloatingWorkspace, updateFloatingWorkspace } from './shell/workspace';
import { mailboxOwner, observeMailboxOwner } from './gmail-owner';
import { ownerPerspectiveKey } from '@pigeonbox/shared';
import type { PublicExtensionSettings } from '@pigeonbox/shared';
import { DEFAULT_SETTINGS, toPublicSettings, buildThreadSnapshot, localThreadSummary } from '@pigeonbox/shared';
import {
  CompositeGmailAdapter,
  findComposeBody,
  findComposeBodies,
  findNotice,
  isOpenThreadRoute,
  resolveThreadId,
  findThreadRows,
  normalizeOpenedThread,
  normalizeVisibleRow,
  routeFromLocation,
  type ActionQueueResult,
  type ComposeHandle,
  type NormalizedThread,
  selectorDiagnostics,
  verifyArchive,
  verifyDraftInserted,
  verifyNavigation,
  type InboxSdkLike,
  type InboxSdkHooks,
  type NewDraft,
  type QueuedGmailAction,
} from '@pigeonbox/gmail';
import {
  normalizeGmailId,
  type CreateTrackedEmailInput,
  type CreateTrackedEmailResult,
  type TrackedEmailPatch,
  type TrackedEmailSummary,
  type TrackingTimelineEntry,
} from '@pigeonbox/tracking';
import { applyCategoryChip, rowsForThread } from './thread/chips';
import { attachDocumentAction, insertDocumentLink } from './compose/documents';
import { isVisibleCommand, type CommandId } from './commands';
import { attachSdkComposeTracking, type ComposeTrackingSession } from './tracking/compose-tracking';
import { attachPlaceholderGuard } from './shell/placeholder-guard';
import {
  buildSelfViewEventId,
  createMessageSelfViewHandler,
  type MessageSelfViewController,
  type PageReloadContext,
  type SelfViewSource,
} from './tracking/message-self-view';
import { installSentStatus, type SentStatusController } from './tracking/sent-status';
import { observeDomSelfViews } from './tracking/dom-self-view';
import { ensureSurface } from './shell/surface';
import { type LocalThreadIntel } from './thread/ThreadPanel';
import { showBusyToast, showToast } from './shell/toasts';
import { SelfViewDeduplicator } from './tracking/self-view-dedupe';
import { installDictation } from './dictation';

export const adapter = new CompositeGmailAdapter();
let settings: PublicExtensionSettings = toPublicSettings(DEFAULT_SETTINGS);
let sdkReady = false;
let sdkOwnsCompose = false;
let sentStatus: SentStatusController | null = null;
let messageSelfView: MessageSelfViewController | null = null;
let domSelfView: ReturnType<typeof observeDomSelfViews> | null = null;
let booted = false;
let pageReload: PageReloadContext | null = null;
let paletteBound = false;
let currentThreadId: string | null = null;
let currentNormalizedThread: NormalizedThread | null = null;

const summaryNotes = new Map<string, { pending: boolean; reason: string | null; preview: string | null }>();
const draftJobs = new Set<string>();
const summaryRequestVersions = new Map<string, number>();
const summaryKeys = new Map<string, string>();
let cachedTrackedEmails: TrackedEmailSummary[] = [];
const selfViewDeduplicator = new SelfViewDeduplicator();

function reportTrackingSelfView(
  trackingId: string,
  gmailThreadId?: string | null,
  gmailMessageId?: string | null,
  observedAt = Date.now(),
  source: SelfViewSource = 'MESSAGE_EXPANDED',
  reconcileGmailIds = false,
  quotedRender = false,
): Promise<void> {
  const normMessageId = normalizeGmailId(gmailMessageId);
  const normThreadId = normalizeGmailId(gmailThreadId);

  if (!selfViewDeduplicator.shouldReport(trackingId, normMessageId, observedAt, source)) {
    return Promise.resolve();
  }

  const selfViewEventId = buildSelfViewEventId(trackingId, normMessageId, source, observedAt);

  return send({
    type: 'TRACKING_SELF_VIEW',
    trackingId,
    gmailThreadId: normThreadId,
    gmailMessageId: normMessageId,
    timestamp: new Date(observedAt).toISOString(),
    source,
    selfViewEventId,
    reconcileGmailIds,
    quotedRender,
  }).then(() => undefined);
}

function runtimeAlive(): boolean {
  try {
    return Boolean(chrome.runtime?.id);
  } catch {
    return false;
  }
}

function send<T>(message: unknown, timeoutMs = 12_000): Promise<T | undefined> {
  if (!runtimeAlive()) return Promise.resolve(undefined);
  return new Promise((resolve) => {
    let settled = false;
    const timer = setTimeout(() => {
      if (settled) return;
      settled = true;
      resolve(undefined);
    }, timeoutMs);

    try {
      const pending = chrome.runtime.sendMessage(message, (response) => {
        if (settled) return;
        settled = true;
        clearTimeout(timer);
        if (!runtimeAlive() || chrome.runtime.lastError) {
          resolve(undefined);
          return;
        }
        resolve(response as T);
      });
      void Promise.resolve(pending).catch(() => {
        if (settled) return;
        settled = true;
        clearTimeout(timer);
        resolve(undefined);
      });
    } catch {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      resolve(undefined);
    }
  });
}

async function refreshSettings(): Promise<void> {
  const res = await send<{ settings?: PublicExtensionSettings }>({ type: 'GET_PUBLIC_SETTINGS' });
  if (res?.settings) settings = res.settings;
}

async function tryLoadInboxSdk(): Promise<InboxSdkLike | null> {
  const appId = settings.inboxSdkAppId.trim();
  if (!appId) return null;
  try {
    const mod = await import('@inboxsdk/core');
    const loader = (mod as { load?: (version: number, appId: string, opts?: { appName?: string }) => Promise<unknown> }).load;
    if (!loader) return null;
    return (await loader(2, appId, { appName: 'PigeonBox' })) as InboxSdkLike;
  } catch (error) {
    console.warn('[gi] InboxSDK failed to load', error);
    return null;
  }
}

function reportRuntime(lastAction?: { success: boolean; action: string; reason?: string }): void {
  const diagnostics = selectorDiagnostics(document);
  const integration = adapter.getActiveIntegration();
  const rowsOk = diagnostics.find((item) => item.key === 'threadRow')?.found;
  const threadOk = diagnostics.find((item) => item.key === 'openThread')?.found;
  const onList = /#(inbox|search|sent|starred)/i.test(location.hash);
  void send({
    type: 'REPORT_RUNTIME',
    runtime: {
      connected: true,
      integration: integration || 'unavailable',
      inboxSdk: sdkReady ? 'loaded' : 'failed',
      domFallback: !onList || rowsOk || threadOk ? 'healthy' : 'selector issue',
      lastEvent: adapter.bus.getLastEvent()
        ? { type: adapter.bus.getLastEvent()!.type, at: adapter.bus.getLastEvent()!.at }
        : null,
      currentThreadId,
      lastAction: lastAction ? { ...lastAction, at: Date.now() } : undefined,
    },
    owner: mailboxOwner(),
  });
}

function updateCachedEmails(emails: TrackedEmailSummary[]): void {
  cachedTrackedEmails = emails;
  sentStatus?.setEmails(emails);
  if (domSelfView) domSelfView.refresh();
  else if (messageSelfView && (messageSelfView.getActiveCount() > 0 || !isOpenThreadRoute(location.hash))) void messageSelfView.reinspectActive().then(() => send({ type: 'TRACKING_INSPECTION_READY' }));
}

async function boot(): Promise<void> {
  if (booted) return;
  booted = true;
  installDictation();
  const nav = performance.getEntriesByType('navigation')[0] as PerformanceNavigationTiming;
  const isReload = nav?.type === 'reload';
  const navigationStartedAt = performance.timeOrigin;
  pageReload = isReload && Number.isFinite(navigationStartedAt) ? { navigationStartedAt } : null;
  ensureSurface();
  ensureWorkspace();
  setupCommandPalette();
  observeMailboxOwner(() => {
    reportRuntime();
    publishWorkspaceContext();
    summaryKeys.clear();
    if (currentNormalizedThread) void summarizeOpenThread(currentNormalizedThread);
  });
  await refreshSettings();

  sentStatus = installSentStatus({
    trackerBaseUrl: settings.trackerBaseUrl,
    onNotify: (trackingId, enabled) => {
      void send<{ emails?: TrackedEmailSummary[] }>({ type: 'SET_NO_REPLY_NOTIFY', trackingId, enabled }).then((res) => {
        if (Array.isArray(res?.emails)) updateCachedEmails(res.emails);
      });
    },
    onStatus: () => {
      if (!currentThreadId) return;
      publishWorkspaceContext();
    },
    onLink: (trackingId, gmailThreadId) => {
      linkTracked({ trackingId, gmailThreadId, gmailMessageId: null });
    },
    loadActivity: async (trackingId) => {
      const res = await send<{ timeline?: TrackingTimelineEntry[] }>({ type: 'GET_TRACKING_TIMELINE', trackingId });
      return Array.isArray(res?.timeline) ? res.timeline : null;
    },
    onSelfView: (trackingId, gmailThreadId, gmailMessageId, observedAt, source) => {
      reportTrackingSelfView(trackingId, gmailThreadId, gmailMessageId, observedAt, source || 'ROW_INTERACTION');
    },
  });

  const sdk = await tryLoadInboxSdk();
  if (sdk) {
    const bound = adapter.bindInboxSdk(sdk);
    sdkReady = bound;
    if (bound) mountSdkUi(sdk);
  }
  reportTracking(null);
  await adapter.start((event) => {
    if (event.type === 'VISIBLE_ROWS_CHANGED') {
      // Rows keep the folder they were seen in, so Ask can tell sent mail from received.
      const route = routeFromLocation();
      const threads = event.rows.map((row) => normalizeVisibleRow(row, adapter.getActiveIntegration() === 'inboxsdk' ? 'inboxsdk' : 'dom', route));
      if (threads.length) {
        void send({ type: 'INGEST_THREADS', owner: mailboxOwner(), direction: route === 'sent' ? 'outbound' : 'inbound', threads });
        void paintVisibleChips(threads.map((thread) => thread.threadId));
      }
    }
    if (event.type === 'THREAD_OPENED' || event.type === 'THREAD_DATA_UPDATED') {
      currentThreadId = event.thread.threadId;
      const thread = normalizeOpenedThread(event.thread, adapter.getActiveIntegration() === 'inboxsdk' ? 'inboxsdk' : 'dom');
      currentNormalizedThread = thread;
      void (async () => {
        const snapshot = await buildThreadSnapshot({
          threadId: thread.threadId,
          subject: thread.subject,
          pageMessages: thread.messages,
        });
        if (summaryKeys.get(thread.threadId) !== `${snapshot.fingerprint}:${ownerPerspectiveKey(mailboxOwner())}`) {
          summaryKeys.set(thread.threadId, `${snapshot.fingerprint}:${ownerPerspectiveKey(mailboxOwner())}`);
          void summarizeOpenThread(thread);
        }
      })();
      publishWorkspaceContext();
    }
    if (event.type === 'COMPOSE_OPENED' && !sdkOwnsCompose) {
      reportTracking(null);
    }
    if (event.type === 'ROUTE_CHANGED' && !isOpenThreadRoute(location.hash)) {
      currentThreadId = null;
      currentNormalizedThread = null;
      publishWorkspaceContext();
    }
    reportRuntime();
  });
  if (!sdkReady) domSelfView = observeDomSelfViews(initMessageSelfView(), () => { void send({ type: 'TRACKING_INSPECTION_READY' }); });
  if (typeof chrome !== 'undefined' && chrome.storage?.onChanged) {
    chrome.storage.onChanged.addListener((changes, area) => {
      if (area === 'local') {
        if (changes.publicSettings?.newValue && typeof changes.publicSettings.newValue === 'object') {
          settings = { ...settings, ...(changes.publicSettings.newValue as PublicExtensionSettings) };
          sentStatus?.setTrackerBaseUrl(settings.trackerBaseUrl || '');
        }
      }
      if (area === 'local' && Array.isArray(changes.trackedEmails?.newValue)) {
        updateCachedEmails(changes.trackedEmails.newValue as TrackedEmailSummary[]);
      }
      if (area === 'session' && changes.intelPulse?.newValue?.threadId) {
        const threadId = String(changes.intelPulse.newValue.threadId);
        void refreshThread(threadId);
      }
    });
  }
  void send<{ emails?: TrackedEmailSummary[] }>({ type: 'GET_TRACKED_EMAILS' }).then((res) => {
    if (Array.isArray(res?.emails)) updateCachedEmails(res.emails);
  });
  setupCommandPalette();
  const pullTracking = () => {
    if (document.visibilityState === 'hidden') return;
    void send({ type: 'TRACKING_POLL' });
  };
  pullTracking();
  window.setInterval(pullTracking, 12_000);
  document.addEventListener('visibilitychange', pullTracking);
  reportRuntime();
}

function trackingDeps() {
  return {
    getSettings: () => settings,
    refreshSettings,
    createTracked,
    markSent,
    cancelTracked,
    registerLinks,
    updateTracked,
    reportDiagnostics: reportTracking,
    onSent: ({ subject, recipients, bodyText }: { subject: string; recipients: string[]; bodyText: string }) => {
      void send({ type: 'OUTGOING_COMPOSE', subject, recipients, bodyText, threadId: currentThreadId || 'sent' });
    },
  };
}

function reportTracking(session: ComposeTrackingSession | null): void {
  const head = document.head;
  void send({
    type: 'REPORT_TRACKING',
    report: {
      inboxSdkLoaded: sdkReady,
      composeHookAttached: sdkOwnsCompose,
      pageWorldInjected: head?.getAttribute('data-inboxsdk-script-injected') === 'true',
      pageWorldReady: Boolean(head?.getAttribute('data-inboxsdk-user-email-address')),
      last: session
        ? {
            composeSessionId: session.composeSessionId,
            kind: session.kind,
            state: session.state,
            trackingId: session.trackingId,
            allocation: Boolean(session.trackingId),
            draftId: Boolean(session.gmailDraftId),
            modifierRegistered: session.modifierRegistered,
            modifierInvoked: session.modifierInvocationCount > 0,
            pixelPresent: session.modifierSawPixel,
            gmailSent: session.state === 'SENT',
            gmailIdsLinked: Boolean(session.gmailThreadId || session.gmailMessageId),
            lastError: session.lastError,
            logs: session.logs,
          }
        : null,
    },
  });
}

function initMessageSelfView(): MessageSelfViewController {
  if (!messageSelfView) {
    const pendingReconcile = new Set<string>();
    messageSelfView = createMessageSelfViewHandler({
      getEmails: () => cachedTrackedEmails,
      getTrackerBaseUrl: () => (settings.trackerUrls?.length ? settings.trackerUrls : settings.trackerBaseUrl),
      pageReload,
      onReconcile: (trackingId, threadId, messageId) => {
        pendingReconcile.add(trackingId);
        const row = cachedTrackedEmails.find((item) => item.trackingId === trackingId);
        if (row) {
          if (messageId) row.gmailMessageId = messageId;
          if (threadId) row.gmailThreadId = threadId;
        }
        linkTracked({ trackingId, gmailThreadId: threadId, gmailMessageId: messageId });
      },
      onSelfView: (trackingId, threadId, msgId, observedAt, source) => {
        const reconcileGmailIds = pendingReconcile.delete(trackingId);
        return reportTrackingSelfView(trackingId, threadId, msgId, observedAt, source, reconcileGmailIds);
      },
      onQuotedSelfView: (trackingId, observedAt, source) => {
        return reportTrackingSelfView(trackingId, null, null, observedAt, source, false, true);
      },
      onCollapsed: (trackingId, msgId) => {
        selfViewDeduplicator.clearRecord(trackingId, msgId);
      },
    });
  }
  return messageSelfView;
}

export function mountSdkUi(
  _sdk?: InboxSdkLike,
  targetAdapter: {
    setHooks?: (hooks: InboxSdkHooks) => void;
    inboxSdk?: { setHooks: (hooks: InboxSdkHooks) => void };
  } = adapter,
): void {
  initMessageSelfView();
  sdkOwnsCompose = true;

  const hooks: InboxSdkHooks = {
    onThreadRowView: async (rowView) => {
      const threadId = await resolveThreadId(rowView);
      const rowElement = typeof rowView.getElement === 'function' ? rowView.getElement() : null;
      const threadRow = rowElement?.closest?.('tr.zA, tr[data-legacy-thread-id], div[role="listitem"]') || rowElement;
      if (threadRow instanceof HTMLElement && typeof threadId === 'string') {
        threadRow.setAttribute('data-gi-thread-id', threadId);
        sentStatus?.paint();
      }
    },
    onThreadView: (threadView) => {
      const threadIdPromise = resolveThreadId(threadView);
      void threadIdPromise.then((threadId) => {
        if (threadId) {
          currentThreadId = threadId;
          publishWorkspaceContext();
        }
      });
      threadView.on?.('destroy', () => {
        void threadIdPromise.then((tid) => {
          if (tid && currentThreadId === tid) {
            currentThreadId = null;
            currentNormalizedThread = null;
            publishWorkspaceContext();
          }
        });
      });
    },
    onMessageView: (messageView) => {
      messageSelfView?.handleMessageView(messageView as any);
    },
    onComposeView: (composeView) => {
      attachSdkComposeTracking(composeView as any, trackingDeps());
      attachPlaceholderGuard(composeView as any);
      void cloudBoot.then(() => { if (cloudCapabilities.includes('cloud_documents')) attachDocumentAction(composeView as any, () => cloudAvailable && cloudCapabilities.includes('cloud_documents')); });
    },
  };

  if (typeof targetAdapter.setHooks === 'function') {
    targetAdapter.setHooks(hooks);
  } else if (targetAdapter.inboxSdk && typeof targetAdapter.inboxSdk.setHooks === 'function') {
    targetAdapter.inboxSdk.setHooks(hooks);
  }
}

function publishWorkspaceContext() {
  const thread = currentNormalizedThread;
  const note = thread ? summaryNotes.get(thread.threadId) : undefined;
  void send({ type: 'SET_WORKSPACE_CONTEXT', context: thread ? { threadId: thread.threadId, subject: thread.subject, sender: thread.messages[thread.messages.length - 1]?.sender?.name || thread.messages[thread.messages.length - 1]?.sender?.email || '', owner: mailboxOwner(), pending: note?.pending ? note.reason || 'Analyzing…' : note?.reason || null, drafting: draftJobs.has(thread.threadId) } : null });
}

async function refreshThread(threadId: string): Promise<void> {
  for (const row of rowsForThread(threadId)) {
    const intel = await getIntel(threadId);
    const category = intel?.classification?.category;
    if (category) applyCategoryChip(row, category, Boolean(intel?.manual));
  }
  if (currentThreadId === threadId) publishWorkspaceContext();
}

async function paintVisibleChips(threadIds: string[]): Promise<void> {
  const res = await send<{ intel?: Record<string, LocalThreadIntel> }>({ type: 'GET_THREAD_INTEL_MANY', threadIds });
  const intel = res?.intel || {};
  for (const threadId of threadIds) {
    const category = intel[threadId]?.classification?.category;
    if (!category) continue;
    for (const row of rowsForThread(threadId)) applyCategoryChip(row, category, Boolean(intel[threadId]?.manual));
  }
}

function previewLine(thread: NormalizedThread): string | null {
  if (!thread.messages.some((message) => message.bodyText.trim())) return null;
  const line = localThreadSummary({
    subject: thread.subject,
    messages: thread.messages.map((message) => ({ bodyText: message.bodyText })),
  }).oneLine.trim();
  return line && line !== 'Empty message' ? line : null;
}

async function summarizeOpenThread(thread: NormalizedThread, force = false): Promise<void> {
  if (!thread.messages.some((message) => message.bodyText.trim())) {
    const dom = await adapter.dom.getCurrentThread();
    if ('thread' in dom && dom.thread) {
      const visible = normalizeOpenedThread(dom.thread, 'dom');
      if (visible.messages.some((message) => message.bodyText.trim())) {
        thread = { ...thread, subject: thread.subject || visible.subject, messages: visible.messages };
      }
    }
  }
  const requestVersion = (summaryRequestVersions.get(thread.threadId) || 0) + 1;
  summaryRequestVersions.set(thread.threadId, requestVersion);
  const owner = mailboxOwner();
  const perspective = ownerPerspectiveKey(owner);
  const stillCurrent = () => summaryRequestVersions.get(thread.threadId) === requestVersion && ownerPerspectiveKey(mailboxOwner()) === perspective;
  if (!owner) {
    summaryNotes.set(thread.threadId, { pending: true, reason: 'Resolving Gmail account…', preview: null });
    await refreshThread(thread.threadId);
    return;
  }
  const hasBody = thread.messages.some((message) => message.bodyText.trim().length > 0);
  const preview = previewLine(thread);
  summaryNotes.set(thread.threadId, {
    pending: hasBody,
    reason: null,
    preview,
  });
  await refreshThread(thread.threadId);

  try {
    const direction = thread.route === 'sent' ? 'outbound' : 'inbound';
    const ingestPromise = send({ type: 'INGEST_THREAD', owner: mailboxOwner(), direction, thread });
    if (!hasBody) {
      summaryNotes.set(thread.threadId, {
        pending: false,
        reason: 'The message text is not on screen yet.',
        preview: null,
      });
      await refreshThread(thread.threadId);
      await ingestPromise;
      return;
    }
    const res = await send<{
      ok?: boolean;
      jobId?: string;
      status?: string;
      oneLine?: string;
      reason?: string;
      error?: string;
    }>({
      type: 'REQUEST_SUMMARY',
      owner,
      threadId: thread.threadId,
      subject: thread.subject,
      force,
      messages: thread.messages.map((message) => ({
        messageId: message.messageId,
        sender: message.sender?.email || 'unknown@local',
        senderName: message.sender?.name,
        recipients: message.recipients?.map((r) => r.email) || [],
        bodyText: message.bodyText,
        timestamp: message.timestamp || '',
        loaded: message.loaded ?? (message.bodyText.trim().length > 0),
      })),
    });
    if (!stillCurrent()) return;
    if (res?.status === 'waiting_owner') return;
    if (res?.status === 'succeeded' && res.oneLine) {
      summaryNotes.set(thread.threadId, {
        pending: false,
        reason: null,
        preview: res.oneLine,
      });
      await refreshThread(thread.threadId);
    } else if (res?.jobId && (res.status === 'queued' || res.status === 'running')) {
      void waitForSummaryJob(thread.threadId, res.jobId, preview, stillCurrent);
    } else if (res && !res.ok) {
      summaryNotes.set(thread.threadId, {
        pending: false,
        reason: res.reason || res.error || null,
        preview: preview || previewLine(thread),
      });
      await refreshThread(thread.threadId);
    } else if (!res) {
      summaryNotes.set(thread.threadId, {
        pending: false,
        reason: 'Could not start the summary. Retry to try again.',
        preview,
      });
      await refreshThread(thread.threadId);
    }
    await ingestPromise;
  } catch (error) {
    console.warn('[gi] summarizeOpenThread error', error);
    summaryNotes.set(thread.threadId, {
      pending: false,
      reason: error instanceof Error ? `AI summary failed: ${error.message}` : 'AI summary failed. Retry to try again.',
      preview: preview || previewLine(thread),
    });
    await refreshThread(thread.threadId);
  }
}

async function waitForSummaryJob(threadId: string, jobId: string, preview: string | null, stillCurrent: () => boolean): Promise<void> {
  const deadline = Date.now() + 310_000;
  while (Date.now() < deadline && stillCurrent()) {
    await wait(1_500);
    const res = await send<{ job?: { status?: string; error?: string }; oneLine?: string }>({ type: 'GET_AI_JOB_STATUS', jobId });
    if (!stillCurrent()) return;
    if (res?.job?.status !== 'succeeded' && res?.job?.status !== 'failed') continue;
    summaryNotes.set(threadId, {
      pending: false,
      reason: res.job.status === 'failed' ? res.job.error || 'AI summary failed.' : null,
      preview: res.job.status === 'succeeded' ? res.oneLine || preview : preview,
    });
    await refreshThread(threadId);
    return;
  }
  if (!stillCurrent()) return;
  summaryNotes.set(threadId, { pending: false, reason: 'AI summary took too long. Retry to try again.', preview });
  await refreshThread(threadId);
}

/** Whether PigeonBox Cloud's always-on features are on (Cloud mode, Google connected). Learned from the worker. */
let cloudAvailable = false;
let cloudCapabilities: string[] = [];
const cloudBoot = send<{ available?: boolean; capabilities?: string[] }>({ type: 'CLOUD_THREAD_INTEL', threadIds: [] }).then((res) => { cloudAvailable = Boolean(res?.available); cloudCapabilities = res?.capabilities ?? []; });

function getIntel(threadId: string): Promise<LocalThreadIntel | undefined> {
  return send<LocalThreadIntel>({ type: 'GET_THREAD_INTEL', threadId, owner: mailboxOwner() });
}

async function createTracked(input: CreateTrackedEmailInput): Promise<CreateTrackedEmailResult | null> {
  const res = await send<{ ok?: boolean; tracking_id?: string; pixel_url?: string; rewritten_links?: CreateTrackedEmailResult['rewritten_links'] }>({
    type: 'CREATE_TRACKED_EMAIL',
    input,
  });
  if (!res?.ok || !res.tracking_id || !res.pixel_url) return null;
  return {
    tracking_id: res.tracking_id,
    pixel_url: res.pixel_url,
    rewritten_links: res.rewritten_links || [],
  };
}

function markSent(patch: TrackedEmailPatch & { trackingId: string }): void {
  void send({ type: 'MARK_TRACKED_SENT', ...patch }).then(() => {
    void send({ type: 'TRACKING_POLL' });
  });
}

function cancelTracked(trackingId: string): void {
  void send({ type: 'CANCEL_TRACKED_EMAIL', trackingId });
}

/** How long a send may wait for the tracker to store its links before they go out untracked. */
const LINK_REGISTRATION_TIMEOUT_MS = 4_000;

async function registerLinks(update: { trackingId: string; links: Array<{ click_id: string; url: string }> }): Promise<boolean> {
  const res = await send<{ trackerSynced?: boolean }>({ type: 'SYNC_TRACKED_LINKS', ...update }, LINK_REGISTRATION_TIMEOUT_MS);
  return res?.trackerSynced === true;
}

/** Keep an unsent tracker's subject and recipients in step with the compose. */
async function updateTracked(update: { trackingId: string; subject: string; sender: string; recipients: string[] }): Promise<boolean> {
  const res = await send<{ trackerSynced?: boolean }>({ type: 'UPDATE_TRACKED_EMAIL', ...update });
  return res?.trackerSynced === true;
}

function linkTracked(link: { trackingId: string; gmailThreadId: string | null; gmailMessageId: string | null }): void {
  void send({ type: 'LINK_TRACKED_EMAIL', ...link }).then(() => {
    void send({ type: 'TRACKING_POLL' });
  });
}

if (typeof chrome !== 'undefined' && chrome.runtime?.onMessage) {
  chrome.runtime.onMessage.addListener((message, _sender, sendResponse) => {
    void (async () => {
      if (message?.type === 'TOGGLE_PIGEONBOX_WORKSPACE') {
        showFloatingWorkspace(message.open !== false, true); sendResponse({ ok: true }); return;
      }
      if (message?.type === 'WORKSPACE_PRESENTATION_CHANGED') {
        updateFloatingWorkspace(message.state); sendResponse({ ok: true }); return;
      }
      if (message?.type === 'PIGEONBOX_WORKSPACE_ACTION') {
        if (String(message.threadId) !== currentThreadId) { sendResponse({ ok: false, reason: 'This conversation is no longer open.' }); return; }
        if (message.id === 'draft') await draftReply(currentThreadId!);
        else if (message.id === 'remind') await remind(currentThreadId!);
        else if (message.id === 'use-draft' && typeof message.body === 'string') { sendResponse(await insertDraft(currentThreadId!, message.body)); return; }
        else if (message.id === 'summarize' && currentNormalizedThread) await summarizeOpenThread(currentNormalizedThread, true);
        else if (['archive', 'mark_respond', 'mark_waiting', 'mark_fyi'].includes(message.id)) await runCommand(message.id);
        else { sendResponse({ ok: false, reason: 'Choose an available action.' }); return; }
        sendResponse({ ok: true }); return;
      }
      if (message?.type === 'PUBLIC_SETTINGS_CHANGED' && message.settings && typeof message.settings === 'object') {
        settings = { ...settings, ...(message.settings as PublicExtensionSettings) };
        sentStatus?.setTrackerBaseUrl(settings.trackerBaseUrl || '');
        sendResponse({ ok: true });
        return;
      }
      if (message?.type === 'TRACKED_EMAILS_CHANGED' && Array.isArray(message.emails)) {
        updateCachedEmails(message.emails as TrackedEmailSummary[]);
        sendResponse({ ok: true });
        return;
      }
      if (message?.type === 'PIGEONBOX_INSERT_DOCUMENT') {
        sendResponse(insertDocumentLink(message));
        return;
      }
      if (message?.type === 'PIGEONBOX_COMMAND') {
        const id = message.id === 'summarize' || message.id === 'draft' ? message.id : null;
        if (!id) {
          sendResponse({ ok: false, reason: 'That command is not available here.' });
          return;
        }
        const thread = currentThreadId || (await adapter.getCurrentThread()).thread?.threadId;
        if (!thread) {
          sendResponse({ ok: false, reason: 'Open a Gmail thread first.' });
          return;
        }
        sendResponse({ ok: true });
        void runCommand(id);
        return;
      }
      if (message?.type === 'THREAD_INTELLIGENCE_UPDATED' || message?.type === 'THREAD_SUMMARY_READY' || message?.type === 'THREAD_DRAFT_READY') {
        const tid = String(message.threadId || '');
        const note = summaryNotes.get(tid);
        if (note?.pending && message.type === 'THREAD_SUMMARY_READY') {
          const intel = await getIntel(tid);
          if (intel?.summary?.aiStatus === 'success') summaryNotes.set(tid, { ...note, pending: false });
        }
        await refreshThread(tid);
        sendResponse({ ok: true });
        return;
      }
      if (message?.type === 'PERFORM_ACTION') {
        const action = message.action as QueuedGmailAction;
        const result = await runAction(action, message.insertText);
        reportRuntime({
          success: Boolean(result.success && result.verified !== false),
          action: action.kind,
          reason: result.reason || ('error' in result ? result.error : undefined),
        });
        sendResponse(result);
        return;
      }
      if (message?.type === 'INDEX_FETCH_BATCH') {
        sendResponse(await indexBatch(String(message.query || 'in:inbox'), String(message.cursor || '0')));
        return;
      }
      if (message?.type === 'HYDRATE_THREAD') {
        sendResponse(await hydrateThread(String(message.threadId || ''), message.restore !== false));
        return;
      }
      if (message?.type === 'OPEN_COMPOSE_DRAFT' && message.draft && typeof message.draft === 'object') {
        // A Gmail tab that just opened is still loading InboxSDK.
        for (let waited = 0; !adapter.getActiveIntegration() && waited < 15_000; waited += 250) await wait(250);
        const result = await adapter.openNewDraft(message.draft as NewDraft);
        reportRuntime({ success: result.success, action: 'OPEN_COMPOSE_DRAFT', reason: result.reason });
        sendResponse(result);
        return;
      }
      if (message?.type === 'GET_CAPABILITIES') {
        sendResponse(await adapter.detectCapabilities());
      }
    })();
    return true;
  });
}

async function runAction(action: QueuedGmailAction, insertText?: string) {
  if (action.kind === 'ARCHIVE_THREAD') return archiveThread(action.threadId);
  if (action.kind === 'CREATE_REPLY_DRAFT' && insertText) return insertDraft(action.threadId, insertText);
  if (action.kind === 'NAVIGATE_SEARCH') {
    const result = await adapter.actions.enqueueAndWait(action, {
      verify: async () => verifyNavigation(location.hash, action.query).verified,
    });
    return { ...result, reason: result.reason || result.error, verified: Boolean(result.verified) };
  }
  const result = await adapter.actions.enqueueAndWait(action);
  return { ...result, reason: result.reason || result.error, verified: Boolean(result.verified) };
}

async function archiveThread(threadId: string) {
  const before = await inspect(threadId);
  const result = await adapter.actions.enqueueAndWait(
    { kind: 'ARCHIVE_THREAD', threadId },
    {
      maxAttempts: 2,
      verify: async () => {
        await wait(500);
        const after = await inspect(threadId);
        return verifyArchive({
          toastText: after.toastText,
          beforeOpenThreadId: before.openThreadId,
          afterOpenThreadId: after.openThreadId,
          expectedThreadId: threadId,
          inboxContainsThread: after.inboxContainsThread,
        }).verified;
      },
    },
  );
  const verified = Boolean(result.verified);
  return {
    ...result,
    success: result.success && verified,
    verified,
    action: 'ARCHIVE_THREAD',
    threadId,
    reason: verified ? 'Archived' : result.reason || result.error || 'Could not archive',
  };
}

async function waitForNewComposeBody(existing: ReadonlySet<HTMLElement>, timeoutMs = 4000): Promise<HTMLElement | null> {
  const start = Date.now();
  while (Date.now() - start < timeoutMs) {
    const added = findComposeBodies(document).filter((body) => !existing.has(body));
    if (added.length === 1) return added[0];
    await wait(100);
  }
  return null;
}

async function insertDraft(threadId: string, text: string) {
  const existingBodies = new Set(findComposeBodies(document));
  const opened = (await adapter.actions.enqueueAndWait({ kind: 'CREATE_REPLY_DRAFT', threadId })) as ActionQueueResult & {
    composeHandle?: ComposeHandle;
  };
  if (!opened.success) {
    return { success: false, verified: false, action: 'CREATE_REPLY_DRAFT', threadId, reason: opened.reason || 'Could not open reply' };
  }
  const handle = opened.composeHandle;
  if (!handle || (handle.threadId && handle.threadId !== threadId)) {
    return {
      success: false,
      verified: false,
      action: 'CREATE_REPLY_DRAFT',
      threadId,
      reason: 'No matching compose handle for thread',
    };
  }

  let body: HTMLElement | null = null;
  if (handle.view) {
    const view = handle.view as {
      getBodyElement?: () => HTMLElement | null;
      getElement?: () => HTMLElement | null;
    };
    body = view.getBodyElement?.() || null;
    const viewElement = view.getElement?.() || handle.element;
    if (!body && viewElement) body = findComposeBody(viewElement);
  }
  if (!body && handle.element) body = findComposeBody(handle.element);
  if (!body && typeof document !== 'undefined') {
    const container = adapter.findThreadContainer(document, threadId);
    if (container) {
      body = findComposeBody(container);
    }
  }
  if (!body) body = await waitForNewComposeBody(existingBodies);
  if (!body) {
    return {
      success: false,
      verified: false,
      action: 'CREATE_REPLY_DRAFT',
      threadId,
      reason: 'Could not identify the reply editor for this thread',
    };
  }
  handle.element = body;

  await adapter.insertComposeBody(text, handle);
  await wait(300);

  let composeOpen = false;
  let currentBody = '';
  const targetThreadId = handle.threadId || threadId;

  if (handle.view) {
    composeOpen = true;
    const view = handle.view as {
      getTextContent?: () => string;
      getBodyElement?: () => HTMLElement | null;
      getElement?: () => HTMLElement | null;
    };
    if (typeof view.getTextContent === 'function') {
      currentBody = view.getTextContent() || '';
    } else if (typeof view.getBodyElement === 'function') {
      currentBody = view.getBodyElement()?.textContent || '';
    } else if (typeof view.getElement === 'function') {
      const el = view.getElement();
      currentBody = el ? (findComposeBody(el)?.textContent || el.textContent || '') : '';
    }
  } else if (handle.element) {
    composeOpen = true;
    currentBody = (findComposeBody(handle.element)?.textContent || handle.element.textContent || '').trim();
  } else if (typeof document !== 'undefined') {
    const container = adapter.findThreadContainer(document, threadId);
    const bodyEl = container ? findComposeBody(container) : null;
    if (bodyEl) {
      composeOpen = true;
      currentBody = (bodyEl.textContent || '').trim();
    }
  }

  const check = verifyDraftInserted({
    composeOpen,
    bodyText: currentBody,
    expectedText: text,
    activeThreadId: targetThreadId,
    expectedThreadId: threadId,
  });
  return {
    success: check.verified,
    verified: check.verified,
    action: 'CREATE_REPLY_DRAFT',
    threadId,
    reason: check.reason,
  };
}

async function inspect(threadId: string) {
  const current = await adapter.getCurrentThread();
  const openThreadId = current.thread?.threadId ?? null;
  const rows = findThreadRows(document);
  const onList = rows.length > 0 && !openThreadId;
  return {
    toastText: findNotice(document),
    openThreadId,
    inboxContainsThread: onList ? rows.some((row) => row.getAttribute('data-legacy-thread-id') === threadId || row.getAttribute('data-gi-thread-id') === threadId) : null,
  };
}

async function indexBatch(query: string, cursor: string) {
  const page = Number(cursor) || 0;
  if (page === 0) {
    await adapter.navigateToSearch(query);
    await wait(1200);
  }
  const rows = await adapter.getVisibleThreadMetadata();
  const route = /\bin:sent\b/i.test(query) ? 'sent' : 'search';
  const threads = (rows.rows || []).map((row) => normalizeVisibleRow(row, 'dom', route));
  return { threads, nextCursor: threads.length && page < 8 ? String(page + 1) : undefined };
}

async function hydrateThread(threadId: string, restore: boolean) {
  const previous = location.hash;
  location.hash = `#inbox/${threadId}`;
  await wait(1400);
  const current = await adapter.getCurrentThread();
  const thread = current.thread ? normalizeOpenedThread(current.thread, 'hydrated') : null;
  if (restore) location.hash = previous;
  return { thread };
}

function setupCommandPalette(): void {
  if (paletteBound) return;
  paletteBound = true;
  document.addEventListener('keydown', (event) => {
    if (!settings.commandPaletteEnabled) return;
    const mod = event.metaKey || event.ctrlKey;
    if (!mod || event.key.toLowerCase() !== 'k') return;
    const target = event.target as HTMLElement | null;
    if (!settings.commandPaletteOverrideGmail && target?.closest('input, textarea, [contenteditable="true"]')) return;
    event.preventDefault();
    event.stopPropagation();
    openCommandPalette();
  }, true);
}

function openCommandPalette(): void {
  ensureSurface();
  showFloatingWorkspace(true, true);
  void send({ type: 'OPEN_WORKSPACE_COMMANDS' });
}

async function runCommand(id: string): Promise<void> {
  if (!isVisibleCommand(id)) {
    showToast('That command is not available.');
    return;
  }
  const command = id as CommandId;
  if (command === 'ask') {
    const res = await send<{ ok?: boolean; reason?: string }>({ type: 'FOCUS_SIDEPANEL', mode: 'ask' });
    if (!res?.ok) showToast(res?.reason || 'Could not open Ask Pigeon.');
    return;
  }
  if (command === 'cloud' || command.startsWith('cloud_')) {
    const section = command === 'cloud' ? 'overview' : command.slice(6);
    const res = await send<{ ok?: boolean; reason?: string }>({ type: 'FOCUS_SIDEPANEL', mode: 'cloud', section });
    if (!res?.ok) showToast(res?.reason || 'Could not open PigeonBox Cloud.');
    return;
  }
  if (command === 'settings') {
    if (typeof chrome !== 'undefined' && chrome.runtime?.openOptionsPage) {
      chrome.runtime.openOptionsPage();
    }
    return;
  }
  const threadId = currentThreadId || (await adapter.getCurrentThread()).thread?.threadId;
  if (!threadId) {
    showToast('Open a thread first.');
    return;
  }
  if (command === 'summarize') {
    showBusyToast('Summarizing…');
    const current = await adapter.getCurrentThread();
    if (current.thread) {
      const normalized = normalizeOpenedThread(current.thread, adapter.getActiveIntegration() === 'inboxsdk' ? 'inboxsdk' : 'dom');
      await summarizeOpenThread(normalized, true);
    } else {
      showToast('Could not find active thread.');
    }
    return;
  }
  if (command === 'draft') {
    await draftReply(threadId);
    return;
  }
  if (command === 'remind') {
    await remind(threadId);
    return;
  }
  if (command === 'archive') {
    const result = await archiveThread(threadId);
    if (!result.success) showToast(result.reason || 'Could not archive.', () => void runCommand('archive'));
    else showToast('Archived.');
    return;
  }
  const category = command === 'mark_respond' ? 'RESPOND' : command === 'mark_waiting' ? 'WAITING' : 'FYI';
  const marked = await send<{ ok?: boolean; reason?: string }>({ type: 'SET_CATEGORY', threadId, category });
  showToast(marked?.ok ? `Marked ${category === 'RESPOND' ? 'Respond' : category === 'WAITING' ? 'Waiting' : 'FYI'}.` : marked?.reason || 'Could not update the category.');
  await refreshThread(threadId);
}

async function draftReply(threadId: string): Promise<void> {
  if (draftJobs.has(threadId)) return;
  draftJobs.add(threadId);
  try {
    await refreshThread(threadId);
    await generateDraftReply(threadId);
  } catch (error) {
    showToast(error instanceof Error ? `Could not draft a reply: ${error.message}` : 'Could not draft a reply.');
  } finally {
    draftJobs.delete(threadId);
    void refreshThread(threadId);
  }
}

async function generateDraftReply(threadId: string): Promise<void> {
  const modelName = settings.aiModel;
  showBusyToast(modelName ? `Drafting reply with ${modelName}…` : 'Drafting reply…');
  const current = await adapter.getCurrentThread();
  let thread = currentNormalizedThread?.threadId === threadId ? currentNormalizedThread : null;
  if (!thread && current.thread?.threadId === threadId) {
    thread = normalizeOpenedThread(current.thread, adapter.getActiveIntegration() === 'inboxsdk' ? 'inboxsdk' : 'dom');
  }
  if (!thread?.messages.some((message) => message.bodyText.trim())) {
    const dom = await adapter.dom.getCurrentThread();
    if ('thread' in dom && dom.thread?.threadId === threadId) {
      const visible = normalizeOpenedThread(dom.thread, 'dom');
      if (visible.messages.some((message) => message.bodyText.trim())) thread = visible;
    }
  }
  const messages = thread?.messages.map((m) => ({
    messageId: m.messageId,
    sender: m.sender.email,
    senderName: m.sender.name,
    recipients: m.recipients.map((r) => r.email),
    bodyText: m.bodyText,
    timestamp: m.timestamp || '',
    loaded: m.loaded ?? (m.bodyText.trim().length > 0),
  }));

  const res = await send<{
    ok?: boolean;
    jobId?: string;
    status?: string;
    body?: string;
    reason?: string;
    error?: string;
  }>({
    type: 'REQUEST_DRAFT',
    threadId,
    subject: thread?.subject,
    messages,
    owner: mailboxOwner(),
  });

  let draftBody: string | undefined = res?.body;

  if (!res) {
    showToast('Could not start a draft. Check the extension connection and try again.');
    return;
  }

  if (res?.ok && !draftBody && (res.status === 'queued' || res.status === 'running')) {
    const jobId = res.jobId;
    const deadline = Date.now() + 310_000;
    while (Date.now() < deadline) {
      await wait(1_500);
      const checkRes = await send<{
        ok?: boolean;
        job?: { status: string; error?: string };
        body?: string;
      }>({ type: 'GET_AI_JOB_STATUS', jobId });
      if (checkRes?.job?.status === 'succeeded') {
        if (checkRes.body) {
          draftBody = checkRes.body;
          break;
        }
        const intelRes = await send<{ draft?: { suggestion?: { body?: string } } }>({
          type: 'GET_THREAD_INTEL',
          threadId,
        });
        if (intelRes?.draft?.suggestion?.body) {
          draftBody = intelRes.draft.suggestion.body;
          break;
        }
      }
      if (checkRes?.job?.status === 'failed') {
        showToast(checkRes.job.error || 'Could not draft a reply.');
        return;
      }
    }
  } else if (!res?.ok) {
    showToast(res?.reason || res?.error || 'Could not start a draft. Try again.');
    return;
  }

  if (!draftBody) {
    showToast('Drafting timed out. Please try again.');
    return;
  }

  const inserted = await insertDraft(threadId, draftBody);
  if (!inserted.success) showToast(inserted.reason || 'Could not insert the draft.', () => void draftReply(threadId));
  else showToast('Draft inserted. It was not sent.');
}

async function remind(threadId: string): Promise<void> {
  const res = await send<{ ok?: boolean; dueAt?: number; reason?: string }>({ type: 'REMIND_THREAD', threadId });
  if (!res?.ok) {
    showToast(res?.reason || 'Could not set a reminder.');
    return;
  }
  const when = res.dueAt ? new Date(res.dueAt).toLocaleDateString() : 'later';
  showToast(`Reminder set for ${when}.`);
}

function wait(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

if (runtimeAlive()) {
  if (document.readyState === 'loading') document.addEventListener('DOMContentLoaded', () => void boot().catch(() => undefined), { once: true });
  else void boot().catch(() => undefined);
}
