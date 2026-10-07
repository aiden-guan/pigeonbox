import { readWorkspace, updateWorkspace, showWorkspace, installWorkspaceToolbar } from './workspace';
import type { WorkspaceContext } from '../workspace/context';
import { MailboxIdentities, visibleSummaryForOwner, withSelfAliases } from './mailbox-identity';
import { tagAuthors, type MailboxIdentity } from '@pigeonbox/shared';
import { recordProductEvent } from '../ui/analytics';
function isWorkerEvictionError(err: unknown): boolean {
  const msg = err instanceof Error ? err.message : String(err ?? '');
  return msg.includes('No SW') || msg.includes('No RPH') || msg.includes('Extension context invalidated');
}

// Suppress benign MV3 service worker collection/eviction errors reported by Chromium
self.addEventListener('unhandledrejection', (event) => {
  if (isWorkerEvictionError(event.reason)) {
    event.preventDefault();
  }
});

import { AgentLoop } from '@pigeonbox/agent';
import {
  AIJobQueue,
  CHATGPT_DEFAULT_MODEL,
  ChatGptHttpError,
  isChatGptModel,
  type PromptOptions,
} from '@pigeonbox/ai';
import { selectGmailTab, WorkerTabController } from '@pigeonbox/gmail';
import { filterSplitThreads, getMailboxDb, IndexJobRunner, MailboxIngestor, type IngestThread, type SearchDocumentRow, type SplitView } from '@pigeonbox/mailbox';
import { formatCoverageWarning, LexicalSearchIndex } from '@pigeonbox/search';
import {
  DEFAULT_SETTINGS,
  RuntimeMessageSchema,
  addBusinessDays,
  buildThreadSnapshot,
  getProviderRequiredOrigin,
  migrateSettings,
  toPublicSettings,
  type ExtensionSettings,
  type PublicExtensionSettings,
  type RawSnapshotMessage,
} from '@pigeonbox/shared';
import { aiDataDestination, resolveCapabilities, type CloudState } from '@pigeonbox/core';
import { cloudErrorMessage } from '@pigeonbox/cloud-client';
import {
  TrackingClient,
  SelfViewAttribution,
  type PendingSelfView,
  applyRecentOpens,
  deriveTrackingTimeline,
  describeTrackingNotification,
  detectOpenRequestSource,
  formatSentTrackingBadge,
  formatTrackingReport,
  isCountableOpenEvent,
  isNotifiableTrackingEvent,
  normalizeGmailId,
  probeTracker,
  summaryFromRemote,
  trackerHealthLabel,
  trackerPermissionOrigin,
  type TrackedEmailSummary,
  type TrackerCredential,
  type TrackingDiagnosticsReport,
  type TrackingPixelEventDiagnostic,
  type TrackingSelfViewDiagnostic,
  type TrackingSendReport,
} from '@pigeonbox/tracking';
import { refreshGmailTabsAfterRestart } from '../reload-extension';
import { patchTrackedEmail, readTrackedEmails, upsertTrackedEmail, updateTrackedEmails } from './tracking/tracked-mail';
import { answerAskPigeon, type AskDraft } from './search/ask-pigeon';
import { createOwnerMatcher, isPlaceholderAddress } from './owner';
import {
  forceRefreshChatGpt,
  getChatGptPublicStatus,
  sendChatGptConversation,
  installChatGptLoginListeners,
  logoutChatGpt,
  rememberChatGptError,
  setChatGptSignedInHandler,
  startChatGptLogin,
} from './ai/chatgpt-login';
import { completeOnDevice, downloadOnDevice, warmOnDevice } from './ai/on-device';
import { effectiveSettings, resolveAIProvider } from './ai/provider-router';
import { cachedCloudState, clearCloudState, cloudSession, cloudTrackerTarget, getCloudClient, readCloudState, refreshCloudState } from './cloud/client';
import { cloudThreadStateAvailable, forgetThreadIntel } from './cloud/thread-state';
import { handleCloudRequest } from './cloud/handlers';
import { serveAskStream } from './cloud/ask-stream';
import { cloudSection, dashboardSection, panelSection } from '../ui/cloud-features';
import { handleWebMessage, type WebBridgeDeps } from './web-bridge';
import { NOTIFICATION_ALARM, pollNotifications } from './cloud/notifications';
import { broadcastToGmailTabs, hardenExtensionStorage, isExtensionPageSender, isGmailContentScript, senderMaySend } from './messaging';
import { checkLatestRelease, chromeManagesUpdates, configureReleaseCheckAlarm, readReleaseUpdateStatus, RELEASE_CHECK_ALARM } from './release-updates';
import { CLOUD_DASHBOARD_URL, DEV_BUILD, EXPERIMENTAL_FEATURES, cloudApiUrl, cloudTrackerUrl, cloudTrackerUrls, trackerIssuer } from '../config';
import { gmailThreadUrl, groupTrackingAlerts, trackingIdFromNotification, trackingNotificationId, TrackingNotificationHistory } from './tracking/notifications';

const db = getMailboxDb();
const queue = new AIJobQueue();
const ingestor = new MailboxIngestor(db);
const lexical = new LexicalSearchIndex();
let settings: ExtensionSettings = { ...DEFAULT_SETTINGS };
let agent: AgentLoop | null = null;
let indexRunner: IndexJobRunner | null = null;
const notificationHistory = new TrackingNotificationHistory(chrome.storage.local);
/** Newest tracked emails fetched from the tracker per poll; older ones stay in the local cache. */
const TRACKED_LIST_LIMIT = 200;
let trackingPollInFlight: Promise<void> | null = null;

const workerTabs = new WorkerTabController({
  query: (q) => chrome.tabs.query(q) as Promise<Array<{ id?: number; url?: string; pinned?: boolean }>>,
  create: (p) => chrome.tabs.create(p) as Promise<{ id?: number }>,
  update: (id, p) => chrome.tabs.update(id, p),
  get: (id) => chrome.tabs.get(id) as Promise<{ id?: number; url?: string }>,
});

async function loadSettings(): Promise<ExtensionSettings> {
  const stored = await chrome.storage.local.get('settings');
  settings = migrateSettings(stored.settings);
  if ((stored.settings as { settingsVersion?: number } | undefined)?.settingsVersion !== settings.settingsVersion) {
    // Persist the migrated shape once so later reads are cheap. Every saved field is kept.
    await chrome.storage.local.set({ settings });
  }
  await applyBundledTracker();
  await chrome.storage.local.set({ publicSettings: await contentSettings() });
  return settings;
}

/**
 * Settings a Gmail content script may see: no secrets, and in Cloud mode the
 * hosted tracker in place of the self-hosted one. `hasPersonalApiToken` only says
 * whether the service worker can authenticate to that tracker.
 */
async function contentSettings(): Promise<PublicExtensionSettings> {
  const view = toPublicSettings(effectiveSettings(settings));
  if (settings.runMode !== 'cloud') return view;
  const tracker = cloudTrackerUrl(settings);
  const user = cloudApiUrl(settings) ? await cloudSession.currentUser(cloudApiUrl(settings)!) : null;
  // Compose asks for tracking only when the account may use hosted tracking, so
  // an account without it sends at once instead of waiting on a refused allocation.
  const capabilities = (await cachedCloudState(settings).catch(() => null))?.capabilities;
  const entitled = capabilities ? capabilities.includes('cloud_tracking') : true;
  return { ...view, trackerBaseUrl: tracker ?? '', trackerUrls: cloudTrackerUrls(settings), hasPersonalApiToken: Boolean(tracker && user && entitled) };
}

async function publishContentSettings(): Promise<void> {
  const view = await contentSettings();
  await chrome.storage.local.set({ publicSettings: view });
  await broadcastToGmailTabs({ type: 'PUBLIC_SETTINGS_CHANGED', settings: view });
}

async function applyBundledTracker(): Promise<void> {
  if (settings.trackerBaseUrl?.trim() && settings.personalApiToken?.trim()) return;
  try {
    if (typeof chrome === 'undefined' || typeof chrome.runtime?.getURL !== 'function') return;
    const response = await fetch(chrome.runtime.getURL('tracker-config.json'));
    if (!response.ok) return;
    const config = (await response.json()) as { trackerBaseUrl?: string; personalApiToken?: string };
    if (!config.trackerBaseUrl?.trim() || !config.personalApiToken?.trim()) return;
    await saveSettings({
      trackerBaseUrl: config.trackerBaseUrl.replace(/\/$/, ''),
      personalApiToken: config.personalApiToken,
    });
  } catch {
    /* No machine-local tracker config is bundled. */
  }
}

async function saveSettings(partial: Partial<ExtensionSettings>): Promise<ExtensionSettings> {
  // Run mode changes only through SET_RUN_MODE, which records consent.
  const rest = { ...partial };
  delete rest.runMode;
  delete rest.cloudConsentAt;
  delete rest.settingsVersion;
  const previousAutomaticUpdateChecks = settings.automaticUpdateChecks;
  if (rest.cloudApiUrl !== undefined && rest.cloudApiUrl !== settings.cloudApiUrl) forgetThreadIntel();
  settings = migrateSettings({ ...settings, ...rest });
  await chrome.storage.local.set({ settings });
  if (settings.automaticUpdateChecks !== previousAutomaticUpdateChecks) {
    configureReleaseCheckAlarm(await releaseChecksWanted());
  }
  await publishContentSettings();
  rebuildAgent();
  if ('voiceProfile' in rest) void syncVoiceToCloud();
  return settings;
}

/**
 * Background drafts in PigeonBox Cloud should sound like the drafts here, so
 * the voice profile follows the extension's. Only in Cloud mode with sync on;
 * failures are ignored and retried on the next save.
 */
async function syncVoiceToCloud(): Promise<void> {
  const client = await cloudSyncClient().catch(() => null);
  if (!client) return;
  // Sign-in often comes before Gmail sync is live, so this also runs on each
  // Cloud poll until the current profile has reached Cloud once.
  const voice = JSON.stringify(settings.voiceProfile);
  const stored = await chrome.storage.local.get(VOICE_SYNCED_KEY).catch(() => ({} as Record<string, unknown>));
  if (stored[VOICE_SYNCED_KEY] === voice) return;
  await client.call('preferencesUpdate', { preferences: { voice: settings.voiceProfile } })
    .then(() => chrome.storage.local.set({ [VOICE_SYNCED_KEY]: voice }))
    .catch(() => undefined);
}

const VOICE_SYNCED_KEY = 'cloudVoiceSynced';

function getAI() {
  return resolveAIProvider(settings, {
    completeChatGpt,
    completeOnDevice: (modelId: string, system: string, user: string, options?: PromptOptions) =>
      completeOnDevice(modelId, system, user, options),
    cloudClient: () => getCloudClient(settings),
    experimental: EXPERIMENTAL_FEATURES,
  });
}

async function completeChatGpt(model: string, system: string, user: string) {
  const attempt = () =>
    sendChatGptConversation({
      model,
      instructions: system,
      input: user,
    });
  try {
    const result = await attempt();
    await rememberChatGptError(null);
    return result;
  } catch (error) {
    if (error instanceof ChatGptHttpError && (error.status === 401 || error.status === 403)) {
      try {
        await forceRefreshChatGpt();
        const result = await attempt();
        await rememberChatGptError(null);
        return result;
      } catch (retryError) {
        const message = retryError instanceof Error ? retryError.message : 'ChatGPT request failed';
        await rememberChatGptError(message);
        throw retryError;
      }
    }
    const message = error instanceof Error ? error.message : 'ChatGPT request failed';
    await rememberChatGptError(message);
    throw error;
  }
}

function rebuildAgent(): void {
  agent = new AgentLoop({
    db,
    ai: getAI(),
    queue,
    settings: () => effectiveSettings(settings),
    archiveViaGmail: async (threadId) => {
      try {
        const res = (await workerTabs.runExclusive(
          (tabId) =>
            sendToTab(tabId, {
              type: 'PERFORM_ACTION',
              context: 'background',
              action: { kind: 'ARCHIVE_THREAD', threadId },
            }),
          { create: false },
        )) as { success?: boolean; verified?: boolean; error?: string; reason?: string };
        const verified = Boolean(res?.success && res.verified);
        return { success: verified, error: verified ? undefined : res?.reason || res?.error || 'Archive was not confirmed' };
      } catch (error) {
        return { success: false, error: String(error) };
      }
    },
    insertDraftViaGmail: async (threadId, body) => {
      try {
        const res = (await workerTabs.runExclusive(
          (tabId) =>
            sendToTab(tabId, {
              type: 'PERFORM_ACTION',
              context: 'background',
              action: { kind: 'CREATE_REPLY_DRAFT', threadId },
              insertText: body,
            }),
          { create: false },
        )) as { success?: boolean; verified?: boolean; error?: string; reason?: string };
        if (!res?.success || res.verified === false) {
          return { success: false, localOnly: true, error: res?.reason || res?.error || 'Draft was not confirmed' };
        }
        return { success: true };
      } catch (error) {
        return { success: false, localOnly: true, error: String(error) };
      }
    },
    log: async (entry) => {
      const id = `act_${Date.now()}_${Math.random().toString(36).slice(2, 7)}`;
      await db.agent_actions.put({
        id,
        type: entry.type,
        threadId: entry.threadId,
        detail: entry.detail,
        undoable: entry.undoable ?? false,
        undone: false,
        tier: entry.tier,
        createdAt: Date.now(),
        expiresAt: entry.expiresAt,
      });
      return id;
    },
    onIntel: (threadId, kind) => {
      void publishIntel(threadId, kind).catch(() => undefined);
    },
  });
}

async function rebuildSearchIndex(docs?: SearchDocumentRow[]): Promise<void> {
  lexical.clear();
  docs ??= await db.search_documents.toArray();
  for (const d of docs) {
    lexical.upsert({
      id: d.id,
      threadId: d.threadId,
      subject: d.subject,
      text: d.text,
      senders: d.senders,
      recipients: d.recipients,
      labels: d.labels,
      timestamp: d.timestamp,
      fingerprint: d.fingerprint,
      quality: d.quality,
    });
  }
}

async function handleAskPigeon(query: string, currentThreadId?: string, currentOwner?: MailboxIdentity) {
  const [coverage, threads, messages, searchDocuments, tracked, owner, ownerAliases] = await Promise.all([
    ingestor.getCoverage(),
    db.threads.toArray(),
    db.messages.toArray(),
    db.search_documents.toArray(),
    readTrackedEmails(),
    readMailboxOwner(),
    readOwnerAddresses(),
  ]);
  const useCurrent = currentThreadId && /\b(?:this (?:thread|email|conversation)|summarize this|draft (?:a )?reply|did they open this|what do i need to do)\b/i.test(query);
  if (currentOwner) {
    for (let i = threads.length - 1; i >= 0; i--) if (threads[i]?.mailboxEmail && threads[i]?.mailboxEmail !== currentOwner.email) threads.splice(i, 1);
    const allowed = new Set(threads.map((thread) => thread.threadId));
    for (let i = messages.length - 1; i >= 0; i--) if (!allowed.has(messages[i]!.threadId)) messages.splice(i, 1);
    for (let i = searchDocuments.length - 1; i >= 0; i--) if (!allowed.has(searchDocuments[i]!.threadId)) searchDocuments.splice(i, 1);
  }
  if (useCurrent) {
    for (let i = threads.length - 1; i >= 0; i--) if (threads[i]?.threadId !== currentThreadId) threads.splice(i, 1);
    for (let i = messages.length - 1; i >= 0; i--) if (messages[i]?.threadId !== currentThreadId) messages.splice(i, 1);
    for (let i = searchDocuments.length - 1; i >= 0; i--) if (searchDocuments[i]?.threadId !== currentThreadId) searchDocuments.splice(i, 1);
    for (let i = tracked.length - 1; i >= 0; i--) if (normalizeGmailId(tracked[i]?.gmailThreadId) !== normalizeGmailId(currentThreadId)) tracked.splice(i, 1);
  }
  await rebuildSearchIndex(searchDocuments);
  const ai = effectiveSettings(settings).aiMode === 'disabled' ? null : getAI();
  try {
    return await answerAskPigeon({
      query,
      threads,
      messages,
      searchDocuments,
      lexical,
      owner: currentOwner || owner,
      ownerAliases: currentOwner ? currentOwner.aliases || [] : ownerAliases,
      tracked,
      coverage,
      answerWithModel: ai ? async (input) => (await ai.answerMailboxQuery(input)).result : null,
    });
  } catch (error) {
    return { error: error instanceof Error ? error.message : String(error), coverageNote: formatCoverageWarning(coverage) };
  }
}

/**
 * Opens an Ask Pigeon draft in the user's Gmail tab (not the pinned worker tab).
 * Falls back to Gmail's own compose page when the tab cannot open it.
 */
async function openComposeDraft(draft: AskDraft): Promise<{ opened: boolean; reason?: string }> {
  const [focused] = await chrome.tabs.query({ active: true, lastFocusedWindow: true });
  const gmail = await chrome.tabs.query({ url: 'https://mail.google.com/*' });
  let tab =
    (focused?.url?.startsWith('https://mail.google.com/') ? focused : undefined) ||
    gmail.find((item) => item.active && !item.pinned) ||
    gmail.find((item) => !item.pinned);
  let fresh = false;
  if (!tab?.id) {
    tab = await chrome.tabs.create({ url: 'https://mail.google.com/mail/u/0/#inbox', active: true });
    fresh = true;
  }
  if (tab.id == null) return { opened: false, reason: 'Could not open Gmail' };
  await chrome.tabs.update(tab.id, { active: true });
  if (tab.windowId != null) await chrome.windows.update(tab.windowId, { focused: true }).catch(() => undefined);
  const res = (await sendToTab(tab.id, { type: 'OPEN_COMPOSE_DRAFT', draft }, fresh ? 40 : 8)) as { success?: boolean; reason?: string };
  if (res?.success) return { opened: true };
  const params = new URLSearchParams({ view: 'cm', fs: '1', tf: '1', to: draft.to.map((contact) => contact.email).join(','), su: draft.subject, body: draft.body });
  if (draft.cc?.length) params.set('cc', draft.cc.map((contact) => contact.email).join(','));
  await chrome.tabs.create({ url: `https://mail.google.com/mail/?${params.toString()}`, active: true, windowId: tab.windowId });
  return { opened: true, reason: res?.reason };
}

const mailboxIdentities = new MailboxIdentities(chrome.storage.local);

/** The signed-in Gmail address, reported by the Gmail tab. */
async function readMailboxOwner(): Promise<{ email: string; name?: string } | null> {
  const stored = await chrome.storage.local.get('mailboxOwner');
  return mailboxOwnerFrom(stored.mailboxOwner) ?? null;
}

/** Every Gmail account PigeonBox has seen signed in. The index is shared, so all of them are "you". */
async function readOwnerAddresses(): Promise<string[]> {
  const stored = await chrome.storage.local.get('mailboxOwnerAddresses');
  return Array.isArray(stored.mailboxOwnerAddresses) ? stored.mailboxOwnerAddresses.filter((value): value is string => typeof value === 'string') : [];
}

async function rememberMailboxOwner(owner: { email: string; name?: string }): Promise<void> {
  const known = await readOwnerAddresses();
  const addresses = known.includes(owner.email) ? known : [owner.email, ...known].slice(0, 10);
  await chrome.storage.local.set({ mailboxOwner: owner, mailboxOwnerAddresses: addresses });
}

type GmailRuntimeReport = {
  connected?: boolean;
  integration?: string;
  inboxSdk?: string;
  domFallback?: string;
  lastEvent?: { type: string; at: number } | null;
  currentThreadId?: string | null;
  lastAction?: { success: boolean; action: string; reason?: string; at: number } | null;
};

async function runDiagnostics() {
  const coverage = await ingestor.getCoverage();
  const stored = await chrome.storage.session.get('gmailRuntime');
  const runtime = (stored.gmailRuntime || null) as GmailRuntimeReport | null;
  let indexedThreads = 0;
  let mailboxDb: 'healthy' | 'error' = 'healthy';
  try {
    indexedThreads = await db.threads.count();
  } catch {
    mailboxDb = 'error';
  }
  let tracking: 'not_configured' | 'healthy' | 'unreachable' | 'unauthorized' | 'invalid_url' | 'outdated' | 'disabled' = 'not_configured';
  let trackingProbe: Awaited<ReturnType<typeof probeTracker>> | null = null;
  const probeTarget = settings.runMode === 'cloud'
    ? await trackerTarget()
    : { baseUrl: settings.trackerBaseUrl, credential: settings.personalApiToken };
  if (!settings.trackingEnabled) tracking = 'disabled';
  else if (probeTarget && (probeTarget.baseUrl || probeTarget.credential)) {
    trackingProbe = await probeTrackerWithPermission(probeTarget.baseUrl, await credentialToken(probeTarget.credential));
    tracking = trackingProbe.status === 'healthy'
      ? 'healthy'
      : trackingProbe.status === 'unauthorized'
        ? 'unauthorized'
        : trackingProbe.status === 'invalid_url'
          ? 'invalid_url'
          : trackingProbe.status === 'missing'
            ? 'not_configured'
            : trackingProbe.status === 'outdated'
              ? 'outdated'
              : 'unreachable';
  }
  const storedTracking = await chrome.storage.session.get('trackingReport');
  const trackingSnapshot = (storedTracking.trackingReport || null) as {
    inboxSdkLoaded?: boolean;
    composeHookAttached?: boolean;
    pageWorldInjected?: boolean;
    pageWorldReady?: boolean;
    last?: TrackingSendReport | null;
  } | null;
  const storedPixel = (await chrome.storage.session.get('lastPixelEvent'))?.lastPixelEvent as TrackingPixelEventDiagnostic | undefined;
  const storedSelfView = (await chrome.storage.session.get('lastSelfViewDiagnostic'))?.lastSelfViewDiagnostic as TrackingSelfViewDiagnostic | undefined;
  if (tracking === 'healthy' && storedSelfView?.deliveryStatus === 'failed') {
    if (storedSelfView.lastError?.includes('404')) {
      tracking = 'outdated';
      if (trackingProbe) {
        trackingProbe.status = 'outdated';
        trackingProbe.label = trackerHealthLabel('outdated');
      }
    } else if (storedSelfView.lastError?.includes('401')) {
      tracking = 'unauthorized';
      if (trackingProbe) {
        trackingProbe.status = 'unauthorized';
        trackingProbe.label = trackerHealthLabel('unauthorized');
      }
    }
  }
  const trackingDiagnostics: TrackingDiagnosticsReport = {
    health: tracking === 'disabled' ? 'disabled' : trackingProbe?.status || (tracking === 'not_configured' ? 'missing' : 'unreachable'),
    endpoint: trackingProbe?.status === 'healthy' || trackingProbe?.status === 'unauthorized' ? 'reachable' : trackingProbe?.status === 'invalid_url' ? 'invalid URL' : trackingProbe ? 'unreachable' : 'not configured',
    auth: trackingProbe?.status === 'healthy' ? 'valid' : trackingProbe?.status === 'unauthorized' ? 'invalid' : 'unchecked',
    inboxSdk: runtime?.inboxSdk === 'loaded' || trackingSnapshot?.inboxSdkLoaded ? 'loaded' : 'not loaded',
    pageWorld: trackingSnapshot?.pageWorldReady ? 'ready' : trackingSnapshot?.pageWorldInjected ? 'injected' : 'not confirmed',
    composeHook: trackingSnapshot?.composeHookAttached ? 'attached' : 'not attached',
    last: trackingSnapshot?.last || null,
    lastPixelEvent: storedPixel || null,
    lastSelfView: storedSelfView || null,
  };
  let aiStatus: 'ready' | 'disabled' | 'not_signed_in' | 'missing_permissions' | 'missing_key' | 'error' = 'ready';
  let configStatus: string = 'provider selected';
  let aiDetail: string | null = null;
  if (settings.runMode === 'cloud') {
    const cloud = await readCloudState(settings);
    aiStatus = cloud.status === 'ready' ? 'ready' : cloud.status === 'signed_out' || cloud.status === 'expired' ? 'not_signed_in' : 'error';
    configStatus = `PigeonBox Cloud: ${cloud.status.replace(/_/g, ' ')}`;
    aiDetail = cloud.status === 'ready' ? null : 'Cloud mode never falls back to another AI provider.';
  } else if (settings.aiMode === 'disabled') {
    aiStatus = 'disabled';
    configStatus = 'AI disabled';
  } else if (settings.aiProvider === 'chatgpt') {
    const status = await getChatGptPublicStatus();
    if (!status.signedIn) {
      aiStatus = 'not_signed_in';
      configStatus = 'ChatGPT session expired';
      aiDetail = status.lastError || 'Sign in to ChatGPT required';
    } else {
      aiStatus = 'ready';
      configStatus = 'provider reachable';
    }
  } else if (settings.aiProvider === 'openai' || settings.aiProvider === 'openai-compatible' || settings.aiProvider === 'ollama') {
    if (!settings.aiApiKey && settings.aiProvider !== 'ollama') {
      aiStatus = 'missing_key';
      configStatus = 'credentials missing';
      aiDetail = 'API key required';
    } else {
      const requiredOrigin = getProviderRequiredOrigin(settings.aiProvider, settings.aiEndpoint);
      if (requiredOrigin && chrome.permissions?.contains) {
        try {
          const hasPerm = await chrome.permissions.contains({ origins: [requiredOrigin] });
          if (!hasPerm) {
            aiStatus = 'missing_permissions';
            configStatus = 'host permission missing';
            aiDetail = `Missing host permission for ${requiredOrigin}`;
          } else if (settings.aiProvider === 'ollama') {
            try {
              const controller = new AbortController();
              const timer = setTimeout(() => controller.abort(), 1200);
              const ep = settings.aiEndpoint || 'http://127.0.0.1:11434/v1';
              const probeUrl = ep.replace(/\/v1\/?$/, '') + '/api/tags';
              const probeRes = await fetch(probeUrl, { signal: controller.signal }).catch(() => null);
              clearTimeout(timer);
              if (probeRes?.ok) {
                aiStatus = 'ready';
                configStatus = 'provider reachable';
              } else {
                aiStatus = 'ready';
                configStatus = 'provider selected';
              }
            } catch {
              aiStatus = 'ready';
              configStatus = 'provider selected';
            }
          } else {
            aiStatus = 'ready';
            configStatus = 'provider selected';
          }
        } catch {
          aiStatus = 'ready';
          configStatus = 'provider selected';
        }
      } else {
        aiStatus = 'ready';
        configStatus = 'provider selected';
      }
    }
  } else if (settings.aiProvider === 'anthropic' || settings.aiProvider === 'gemini') {
    aiStatus = 'error';
    configStatus = 'unsupported';
    aiDetail = `${settings.aiProvider === 'anthropic' ? 'Anthropic' : 'Gemini'} is currently unavailable. Use an OpenAI-compatible endpoint.`;
  } else if (!getAI()) {
    aiStatus = 'error';
    configStatus = 'credentials missing';
    aiDetail = 'Model configuration error';
  }

  let lastOperation: string | null = null;
  let lastError: string | null = null;
  let lastSuccessTimestamp: number | null = null;
  try {
    const recentJobs = await db.ai_jobs?.orderBy('createdAt').reverse().limit(20).toArray();
    if (recentJobs && recentJobs.length > 0) {
      lastOperation = recentJobs[0].kind;
      const lastJob = recentJobs[0];
      if (lastJob.status === 'succeeded') {
        configStatus = 'last inference succeeded';
      }
      const lastFailed = recentJobs.find((j) => j.status === 'failed' && j.error);
      if (lastFailed) {
        lastError = lastFailed.error || null;
        if (lastJob.status === 'failed' && lastFailed.error) {
          const err = lastFailed.error.toLowerCase();
          if (/timeout|timed out/.test(err)) {
            configStatus = 'inference timed out';
          } else if (/parse|json/.test(err)) {
            configStatus = 'response parse failure';
          } else if (/auth|401|403|unauthorized|api key/.test(err)) {
            configStatus = 'provider authentication failed';
          } else if (/model|rejected|not found/.test(err)) {
            configStatus = 'model rejected';
          }
        }
      }
      const lastSuccess = recentJobs.find((j) => j.status === 'succeeded' && j.completedAt);
      if (lastSuccess) lastSuccessTimestamp = lastSuccess.completedAt || null;
    }
  } catch {
    /* ignore */
  }

  let permissionStatus: 'granted' | 'missing' | 'not_required' | 'unknown' = 'not_required';
  const requiredOrigin = getProviderRequiredOrigin(settings.aiProvider, settings.aiEndpoint);
  if (requiredOrigin && chrome.permissions?.contains) {
    try {
      const hasPerm = await chrome.permissions.contains({ origins: [requiredOrigin] });
      permissionStatus = hasPerm ? 'granted' : 'missing';
    } catch {
      permissionStatus = 'unknown';
    }
  }

  let workerTab: 'ready' | 'inactive' | 'unavailable' = 'inactive';
  const workerId = workerTabs.getTabId();
  if (workerId != null) {
    try {
      const tab = await chrome.tabs.get(workerId);
      workerTab = tab.url?.includes('mail.google.com') ? 'ready' : 'unavailable';
    } catch {
      workerTab = 'unavailable';
    }
  }
  return {
    gmailTab: runtime?.connected ? 'connected' : 'unavailable',
    integration: runtime?.integration || 'unavailable',
    inboxSdk: runtime?.inboxSdk || 'failed',
    domFallback: runtime?.domFallback || 'unknown',
    lastGmailEvent: runtime?.lastEvent || null,
    mailboxDb,
    indexedThreads,
    currentThreadId: runtime?.currentThreadId || null,
    runMode: settings.runMode,
    aiDestination: aiDataDestination(settings),
    ai: {
      provider: settings.runMode === 'cloud' ? 'pigeonbox-cloud' : settings.aiProvider,
      model: settings.runMode === 'cloud' ? 'PigeonBox Cloud' : settings.aiModel,
      mode: settings.runMode === 'cloud' ? 'cloud' : settings.aiMode,
      status: aiStatus,
      configurationStatus: configStatus,
      'configuration status': configStatus,
      permissionStatus,
      'permission status': permissionStatus,
      lastOperation,
      'last AI operation': lastOperation,
      lastError,
      'last AI error': lastError,
      lastSuccessTimestamp,
      'last success timestamp': lastSuccessTimestamp,
      detail: aiDetail,
    },
    tracking,
    trackingReport: formatTrackingReport(trackingDiagnostics),
    trackingDetail: trackingDiagnostics,
    workerTab,
    lastAction: runtime?.lastAction || null,
    lastClassifierRun: agent?.getLastClassifierRun() ?? null,
    coverage: formatCoverageWarning(coverage),
    usageToday: queue.usageToday,
  };
}

async function publishIntel(threadId: string, kind: string): Promise<void> {
  try {
    await chrome.storage.session.set({ intelPulse: { threadId, kind, at: Date.now() } });
    const tabs = await chrome.tabs.query({ url: 'https://mail.google.com/*' });
    await Promise.all(
      tabs.map((tab) =>
        tab.id == null
          ? undefined
          : chrome.tabs.sendMessage(tab.id, { type: 'THREAD_INTELLIGENCE_UPDATED', threadId, kind }).catch(() => undefined),
      ),
    );
  } catch (error) {
    if (isWorkerEvictionError(error)) return;
    throw error;
  }
}

async function sendToTab(tabId: number, message: unknown, attempts = 8): Promise<unknown> {
  let last = 'Gmail tab did not respond';
  for (let attempt = 0; attempt < attempts; attempt += 1) {
    try {
      return await chrome.tabs.sendMessage(tabId, message);
    } catch (error) {
      last = error instanceof Error ? error.message : String(error);
      await new Promise((resolve) => setTimeout(resolve, 400));
    }
  }
  return { success: false, verified: false, reason: last };
}

async function openSidePanel(
  mode: 'inbox' | 'ask' | 'cloud',
  splitCategory?: string,
  askQuery?: string,
  askRequestId?: string,
  section?: string,
): Promise<void> {
  const stored = await chrome.storage.session.get('panelState');
  const current = (stored.panelState || {}) as { mode?: string; splitCategory?: string };
  const panelState: { mode: 'inbox' | 'ask' | 'cloud'; splitCategory: string; askQuery?: string; askRequestId?: string } = {
    mode,
    splitCategory: splitCategory || current.splitCategory || 'RESPOND',
  };
  if (mode === 'ask' && askQuery?.trim() && askRequestId) {
    panelState.askQuery = askQuery.trim();
    panelState.askRequestId = askRequestId;
  }
  await chrome.storage.session.set({
    panelState: { ...panelState, cloudSection: panelSection(section) },
  });
  await updateWorkspace({ mode: mode === 'cloud' ? 'home' : mode, splitCategory: panelState.splitCategory, cloudSection: panelSection(section), open: true, display: 'float' });
  await showWorkspace();
}

async function classifyIngested(thread: IngestThread, fingerprint: string, quality: IngestThread['quality'], direction: string, accountOwner?: MailboxIdentity): Promise<void> {
  if (!agent) return;
  const latest = thread.messages?.[thread.messages.length - 1];
  // The folder a thread was opened from says nothing about who wrote last. The newest message does.
  const owner = accountOwner ?? (thread.mailboxEmail ? { email: thread.mailboxEmail } : null);
  const isOwner = createOwnerMatcher({ owner, contacts: (thread.messages || []).map((message) => message.sender) });
  const latestKnown = latest && !isPlaceholderAddress(latest.sender?.email) ? latest.sender : undefined;
  const userWroteLast = latestKnown ? isOwner(latestKnown) : direction === 'outbound' || /^\s*me\s*$/i.test(thread.latestSender?.name || '');
  if (latestKnown) direction = userWroteLast ? 'outbound' : 'inbound';
  if (direction === 'inbound') await agent.resolveReminderOnInbound(thread.threadId);
  await agent.onNewMessage({
    threadId: thread.threadId,
    fingerprint,
    subject: thread.subject,
    snippet: thread.snippet || '',
    bodyText: latest?.bodyText || '',
    latestSenderEmail: latest?.sender?.email || thread.latestSender?.email || 'unknown',
    direction: direction === 'outbound' ? 'outbound' : 'inbound',
    userIsLatestMeaningfulSender: userWroteLast,
    quality: quality || 'ROW_STUB',
    owner: owner ?? undefined,
    requireOwner: true,
    messages: (thread.messages || []).map((message) => ({
      sender: message.sender.name && !message.sender.name.includes('@')
        ? `${message.sender.name} <${message.sender.email}>`
        : message.sender.email,
      bodyText: message.bodyText,
      timestamp: message.timestamp || '',
    })),
  });
}

/**
 * The tracker this install reports to, with the credential for its management
 * API. Local: the self-hosted tracker and personal token from Settings. Cloud:
 * the hosted tracker and the Cloud access token. Either way the credential stays
 * in the service worker.
 */
/**
 * Probe a tracker, first checking that Chrome lets PigeonBox reach it. Tracker
 * hosts are optional permissions, so a missing grant is reported as such rather
 * than as an unreachable server.
 */
async function probeTrackerWithPermission(baseUrl: string, token: string) {
  const origin = trackerPermissionOrigin(baseUrl);
  if (origin && baseUrl.trim() && token.trim() && chrome.permissions?.contains) {
    const granted = await chrome.permissions.contains({ origins: [origin] }).catch(() => true);
    if (!granted) return { status: 'no_permission' as const, label: trackerHealthLabel('no_permission') };
  }
  return probeTracker(baseUrl, token);
}

type TrackerTarget = { baseUrl: string; credential: TrackerCredential };

async function trackerTarget(): Promise<TrackerTarget | null> {
  if (settings.runMode === 'cloud') return cloudTrackerTarget(settings);
  if (!settings.trackerBaseUrl || !settings.personalApiToken) return null;
  return { baseUrl: settings.trackerBaseUrl, credential: settings.personalApiToken };
}

/**
 * The tracker for calls about one tracked email: the current tracker, but only
 * when it issued the ID (see `trackerIssuer`). After a switch between Local and
 * Cloud, an email keeps its last known state instead of reaching the wrong tracker.
 */
async function trackerTargetFor(trackingId: string): Promise<TrackerTarget | null> {
  const target = await trackerTarget();
  if (!target) return null;
  const issuer = (await readTrackedEmails()).find((email) => email.trackingId === trackingId)?.issuer;
  if (issuer && issuer !== trackerIssuer(settings)) return null;
  return target;
}

async function credentialToken(credential: TrackerCredential): Promise<string> {
  if (typeof credential === 'string') return credential;
  return (await credential.get().catch(() => null)) ?? '';
}

async function notificationScope(baseUrl: string): Promise<string> {
  // A different account on the same tracker must get its own baseline. Hash the
  // local credential so it is never stored in notification history as plaintext.
  const identity = settings.runMode === 'cloud'
    ? (await cloudSession.readSession())?.user.id || 'cloud'
    : settings.personalApiToken;
  const digest = await crypto.subtle.digest('SHA-256', new TextEncoder().encode(`${settings.runMode}:${baseUrl}:${identity}`));
  return [...new Uint8Array(digest)].map((byte) => byte.toString(16).padStart(2, '0')).join('');
}

const attribution = new SelfViewAttribution();
const attributionReady = chrome.storage.session.get('trackingAttribution')
  .then((stored) => attribution.restore(stored.trackingAttribution)).catch(() => undefined);
let attributionWrites: Promise<unknown> = attributionReady;
function persistAttribution(): Promise<void> {
  const snapshot = attribution.snapshot();
  const write = attributionWrites.then(() => chrome.storage.session.set({ trackingAttribution: snapshot }));
  attributionWrites = write.catch(() => undefined);
  return write;
}
let navigationAttribution: Promise<unknown> = attributionReady;
chrome.tabs.onUpdated?.addListener((tabId, change, tab) => {
  if (change.status !== 'loading' || !tab.url?.startsWith('https://mail.google.com/')) return;
  // Reserve before any network poll can publish the reload's pixel. Only exact saved thread/message IDs qualify.
  navigationAttribution = navigationAttribution.then(async () => {
    await loadSettings();
    const hash = new URL(tab.url!).hash.split('/').pop() || '';
    const routeId = normalizeGmailId(decodeURIComponent(hash));
    if (!routeId) return;
    const observedAt = Date.now();
    for (const email of await readTrackedEmails()) {
      if (normalizeGmailId(email.gmailThreadId) !== routeId && normalizeGmailId(email.gmailMessageId) !== routeId) continue;
      const issuer = email.issuer || trackerIssuer(settings) || 'unconfigured';
      attribution.begin({ issuer, trackingId: email.trackingId, tabId, observedAt, eventId: `navigation_${tabId}_${observedAt}`, navigation: true });
    }
    await persistAttribution();
  }).catch(() => undefined);
});

async function reconcileSelfView(claim: PendingSelfView, result: Awaited<ReturnType<TrackingClient['recordSelfView']>>, client: TrackingClient) {
  attribution.reconciled(claim, result.reclassifiedEventIds || []);
  const canonical = result.first_opened_at !== undefined ? result : await client.getEmail(claim.trackingId);
  await patchTrackedEmail(claim.trackingId, {
    openCount: result.open_count ?? result.openCount ?? canonical.open_count ?? 0,
    firstOpenedAt: canonical.first_opened_at ?? null,
    lastOpenedAt: canonical.last_opened_at ?? null,
    ...(canonical.click_count !== undefined ? { clickCount: canonical.click_count } : {}),
    firstClickedAt: canonical.first_clicked_at ?? null,
    lastClickedAt: canonical.last_clicked_at ?? null,
  });
  attribution.settled(claim);
  await persistAttribution();
}
let claimAttribution: Promise<unknown> = attributionReady;
const deliveringClaims = new Set<string>();
async function reserveClaim(message: Record<string, any>, tabId?: number) {
  await navigationAttribution;
  await loadSettings();
  const trackingId = String(message.trackingId || '');
  const email = (await readTrackedEmails()).find((row) => row.trackingId === trackingId);
  const issuer = trackerIssuer(settings);
  if (!trackingId || !issuer || (email?.issuer && email.issuer !== issuer)) return;
  const observedAt = Date.parse(message.timestamp || '') || Date.now();
  const eventId = message.selfViewEventId || `sv_${trackingId}_${normalizeGmailId(message.gmailMessageId) || 'nomessage'}_${message.source || 'MESSAGE_EXPANDED'}_${observedAt}`;
  attribution.begin({ issuer, trackingId, eventId, observedAt, tabId });
  await persistAttribution();
}

async function pollTracking(): Promise<void> {
  if (!trackingPollInFlight) {
    trackingPollInFlight = pollTrackingNow().finally(() => {
      trackingPollInFlight = null;
    });
  }
  return trackingPollInFlight;
}

async function pollTrackingNow(): Promise<void> {
  await navigationAttribution;
  await claimAttribution;
  if (!settings.trackingEnabled) return;
  const target = await trackerTarget();
  if (!target) return;
  const issuer = trackerIssuer(settings) || 'unconfigured';
  const client = new TrackingClient(target.baseUrl, target.credential);
  // Retain the exact failed event identity across worker restarts; ordinary polls retry it.
  for (const claim of attribution.snapshot().pending.filter((row) => row.issuer === issuer && row.retry)) {
    if (deliveringClaims.has(`${claim.trackingId}\n${claim.eventId}`)) continue;
    try {
      const result = await client.recordSelfView(claim.trackingId, { ...claim.retry, timestamp: new Date(claim.observedAt).toISOString(), selfViewEventId: claim.eventId });
      if (result.ok) await reconcileSelfView(claim, result, client);
    } catch { /* Keep last settled state until this claim can be delivered. */ }
  }
  const local = await readTrackedEmails();
  const byId = new Map(local.map((email) => [email.trackingId, email]));
  const revisions = new Map(local.map((email) => [email.trackingId, attribution.revision(issuer, email.trackingId)]));
  // Emails issued by another tracker keep their cached state; only this tracker's rows are refreshed.
  const fromHere = (email: TrackedEmailSummary) => !email.issuer || email.issuer === issuer;
  let sawRemote = false;
  try {
    const remote = await client.listEmails(TRACKED_LIST_LIMIT);
    for (const row of remote) {
      byId.set(row.tracking_id, summaryFromRemote(row, byId.get(row.tracking_id) || null, issuer));
    }
    // The tracker is the record. When it returned its whole list, a cached row it
    // no longer has (deleted with the account, or from an earlier sign-in) is dropped.
    if (remote.length < TRACKED_LIST_LIMIT) {
      const present = new Set(remote.map((row) => row.tracking_id));
      for (const email of local) {
        if (email.issuer === issuer && !present.has(email.trackingId)) byId.delete(email.trackingId);
      }
    }
    sawRemote = true;
  } catch (e) {
    console.warn('[gi] tracking list failed', e instanceof Error ? e.message : 'error');
    await Promise.all(
      local.filter(fromHere).slice(0, 40).map(async (email) => {
        try {
          const row = await client.getEmail(email.trackingId);
          byId.set(row.tracking_id, summaryFromRemote(row, email, issuer));
          sawRemote = true;
        } catch {
          /* keep the last status we already have */
        }
      }),
    );
  }
  let events: Awaited<ReturnType<TrackingClient['getRecentEvents']>> = [];
  let newEvents: typeof events = [];
  try {
    events = await client.getRecentEvents();
    await navigationAttribution;
    await claimAttribution;
    events = attribution.events(issuer, events);
    if (!sawRemote && events.length) {
      for (const email of applyRecentOpens([...byId.values()], events)) byId.set(email.trackingId, email);
    }
    const latestOpen = events.find((ev) => ev.type === 'OPEN');
    if (latestOpen) {
      const source = detectOpenRequestSource(latestOpen.user_agent);
      const isCounted = isCountableOpenEvent(latestOpen);

      const email = byId.get(latestOpen.tracking_id);
      const diagnostic: TrackingPixelEventDiagnostic = {
        trackingId: latestOpen.tracking_id,
        eventType: latestOpen.type,
        classification: (latestOpen.classification || (source === 'browser_like' ? 'RECIPIENT_LIKELY' : 'UNKNOWN')) as any,
        requestSource: source,
        userAgentCategory: source,
        timestamp: latestOpen.timestamp,
        sentAt: email?.sentAt || null,
        selfViewCorrelated: Boolean(latestOpen.suspected_self_open || latestOpen.classification === 'SELF_LIKELY'),
        countsAsOpen: isCounted,
      };
      await chrome.storage.session.set({ lastPixelEvent: diagnostic });
    }
  } catch (e) {
    console.warn('[gi] tracking poll failed', e instanceof Error ? e.message : 'error');
  }
  // The list endpoint only returns the 200 newest sent emails. An older email
  // can still have a new open, so look up its details before composing the alert.
  const missingIds = [...new Set(events.filter(isNotifiableTrackingEvent).map((event) => event.tracking_id))]
    .filter((id) => !byId.has(id));
  await Promise.all(missingIds.map(async (id) => {
    try {
      const row = await client.getEmail(id);
      byId.set(id, summaryFromRemote(row, null, issuer));
    } catch {
      /* The event can still be shown with a generic subject. */
    }
  }));
  await navigationAttribution;
  await claimAttribution;
  if (sawRemote || local.length || missingIds.length) {
    await updateTrackedEmails((current) => {
      const latest = new Map(current.map((email) => [email.trackingId, email]));
      for (const [id, remote] of byId) {
        if (attribution.publishable(issuer, id, revisions.get(id) || 0)) latest.set(id, { ...latest.get(id), ...remote });
        // Pending unknown rows remain neutral until their canonical claim response arrives.
        else if (!latest.has(id)) latest.set(id, { ...remote, openCount: 0, clickCount: 0, firstOpenedAt: null, lastOpenedAt: null });
      }
      for (const email of current) {
        if (!byId.has(email.trackingId) && email.issuer === issuer && attribution.publishable(issuer, email.trackingId, revisions.get(email.trackingId) || 0)) latest.delete(email.trackingId);
      }
      return [...latest.values()];
    });
  }
  const settledEvents = attribution.events(issuer, events).filter((event) => attribution.publishable(issuer, event.tracking_id, revisions.get(event.tracking_id) || 0));
  const scope = await notificationScope(target.baseUrl);
  newEvents = await notificationHistory.claim(scope, settledEvents);
  await navigationAttribution;
  await claimAttribution;
  const held = newEvents.filter((event) => !attribution.publishable(issuer, event.tracking_id, revisions.get(event.tracking_id) || 0));
  if (held.length) await notificationHistory.release(scope, held.map((event) => event.id));
  if (!settings.desktopNotifications) return;
  try {
    const fresh = [...byId.values()];
    for (const alert of groupTrackingAlerts(newEvents)) {
      if (!attribution.publishable(issuer, alert.event.tracking_id, revisions.get(alert.event.tracking_id) || 0)) continue;
      const email = fresh.find((item) => item.trackingId === alert.event.tracking_id);
      const { title, message } = describeTrackingNotification(alert.event, email, alert.count);
      void Promise.resolve(chrome.notifications.create(trackingNotificationId(alert.event), {
        type: 'basic',
        iconUrl: chrome.runtime.getURL('icons/icon128.png'),
        title,
        message,
      })).catch(() => undefined);
    }
  } catch (e) {
    console.warn('[gi] tracking poll failed', e instanceof Error ? e.message : 'error');
  }
}

async function ensureNoReplyReminder(email: TrackedEmailSummary): Promise<void> {
  const due = addBusinessDays(new Date(), settings.reminderBusinessDays).getTime();
  await db.reminders.put({
    id: `trk_${email.trackingId}`,
    threadId: email.gmailThreadId || `pending:${email.trackingId}`,
    recipients: email.recipients,
    lastOutgoingAt: email.sentAt ? Date.parse(email.sentAt) || Date.now() : Date.now(),
    dueAt: due,
    status: 'pending',
    reason: `No reply yet from ${email.recipients[0] || 'recipient'}`,
  });
}

/** Daily GitHub checks, for copies Chrome does not update itself. */
async function releaseChecksWanted(): Promise<boolean> {
  return settings.automaticUpdateChecks && !(await chromeManagesUpdates());
}

chrome.runtime.onInstalled.addListener(async (details) => {
  await loadSettings();
  rebuildAgent();
  const checkReleases = await releaseChecksWanted();
  configureReleaseCheckAlarm(checkReleases);
  if (details.reason !== 'install' && checkReleases) {
    void checkLatestRelease().catch(() => undefined);
  }
  if (details.reason === 'install') {
    const stored = await chrome.storage.local.get('onboardingComplete');
    if (!stored.onboardingComplete) {
      await chrome.tabs.create({ url: chrome.runtime.getURL('onboarding.html') });
    }
  }
  chrome.sidePanel.setPanelBehavior({ openPanelOnActionClick: false }).catch(() => undefined);
  chrome.alarms.create('tracking_poll', { periodInMinutes: 1 });
  chrome.alarms.create('reminder_tick', { periodInMinutes: 15 });
  chrome.alarms.create(NOTIFICATION_ALARM, { periodInMinutes: 2 });
});

chrome.runtime.onStartup.addListener(async () => {
  await loadSettings();
  void pollTracking().catch(() => undefined);
  const checkReleases = await releaseChecksWanted();
  configureReleaseCheckAlarm(checkReleases);
  if (checkReleases) {
    const status = await readReleaseUpdateStatus();
    const lastCheckedAt = status?.checkedAt ? Date.parse(status.checkedAt) : 0;
    const releaseIsStale =
      !status ||
      status.currentVersion !== chrome.runtime.getManifest().version ||
      !Number.isFinite(lastCheckedAt) ||
      Date.now() - lastCheckedAt >= 24 * 60 * 60 * 1000;
    if (releaseIsStale) void checkLatestRelease().catch(() => undefined);
  }
});

chrome.alarms.onAlarm.addListener(async (alarm) => {
  await loadSettings();
  if (alarm.name === 'tracking_poll') await pollTracking();
  if (alarm.name === NOTIFICATION_ALARM) await pollCloudNotifications();
  if (alarm.name === RELEASE_CHECK_ALARM && (await releaseChecksWanted())) {
    await checkLatestRelease().catch(() => undefined);
  }
  if (alarm.name === 'reminder_tick') {
    const due = await db.reminders.where('status').equals('pending').toArray();
    const now = Date.now();
    for (const r of due) {
      if (r.dueAt <= now) {
        await db.reminders.update(r.id, { status: 'fired' });
        void Promise.resolve(chrome.notifications.create(`rem_${r.id}`, {
          type: 'basic',
          iconUrl: chrome.runtime.getURL('icons/icon128.png'),
          title: 'Follow-up reminder',
          message: r.reason,
        })).catch(() => undefined);
      }
    }
  }
});

installWorkspaceToolbar();
chrome.tabs.onActivated?.addListener(({ tabId }) => { void chrome.storage.session.set({ workspaceContextActive: tabId }); });
chrome.tabs.onRemoved?.addListener((tabId) => {
  mailboxIdentities.forgetTab(tabId);
  void navigationAttribution.then(() => claimAttribution).then(async () => { attribution.inspected(tabId); await persistAttribution(); });
  void chrome.storage.session.get(['workspaceContexts', 'workspaceMailboxes']).then((stored) => {
    const contexts = { ...stored.workspaceContexts };
    const mailboxes = { ...stored.workspaceMailboxes };
    delete contexts[tabId];
    delete mailboxes[tabId];
    return chrome.storage.session.set({ workspaceContexts: contexts, workspaceMailboxes: mailboxes });
  });
});
let contextWrites: Promise<unknown> = Promise.resolve();
let commandWrites: Promise<unknown> = Promise.resolve();
/** The open thread (if any) and the signed-in Gmail account of the panel's Gmail tab. */
async function workspaceContext(senderTab?: chrome.tabs.Tab): Promise<{ context: WorkspaceContext | null; mailbox?: { email: string; name?: string } | null; tabId?: number; windowId?: number }> {
  const tab = senderTab?.url?.startsWith('https://mail.google.com/') ? senderTab : (await chrome.tabs.query({ active: true, currentWindow: true })).find((item) => item.url?.startsWith('https://mail.google.com/'));
  if (tab?.id == null) return { context: null };
  const stored = await chrome.storage.session.get(['workspaceContexts', 'workspaceMailboxes']);
  const context = stored.workspaceContexts?.[tab.id] || null;
  return { context, mailbox: stored.workspaceMailboxes?.[tab.id] ?? context?.owner ?? null, tabId: tab.id, windowId: tab.windowId };
}

// Streamed Ask Pigeon from extension pages (the side panel).
chrome.runtime.onConnect.addListener((port) => serveAskStream(port, async () => (settings.runMode === 'cloud' ? getCloudClient(settings) : null)));

chrome.runtime.onMessage.addListener((message, sender, sendResponse) => {
  if (
    message?.type === 'LOCAL_MODEL_PROGRESS' ||
    message?.type === 'LOCAL_MODEL_RELEASE' ||
    message?.type === 'ON_DEVICE_PING' ||
    message?.type === 'ON_DEVICE_STATUS' ||
    message?.type === 'ON_DEVICE_PROMPT' ||
    message?.type === 'ON_DEVICE_WARM' ||
    message?.type === 'ON_DEVICE_DOWNLOAD' ||
    message?.type === 'PB_DICTATION_EVENT'
  ) return false;
  if (!senderMaySend(sender, message?.type)) {
    sendResponse({ ok: false, error: 'forbidden', reason: 'This request is only accepted from PigeonBox pages.' });
    return false;
  }
  if (message?.type === 'TRACKING_SELF_VIEW') claimAttribution = claimAttribution.then(() => reserveClaim(message, sender.tab?.id)).catch(() => undefined);
  void (async () => {
    try {
    await loadSettings();
    if (!agent) rebuildAgent();
    if (message?.type === 'GET_WORKSPACE_PRESENTATION') {
      const intention = await chrome.storage.session.get('workspaceReopen');
      if (sender.tab?.id != null && intention.workspaceReopen?.tabId === sender.tab.id) {
        await updateWorkspace({ open: true, display: 'float' });
        await chrome.storage.session.remove('workspaceReopen');
      }
      const appearanceValue = (await chrome.storage.local.get('pigeonboxAppearance')).pigeonboxAppearance;
      sendResponse({ state: await readWorkspace(), appearance: appearanceValue === 'dark' || appearanceValue === 'system' ? appearanceValue : 'light' }); return;
    }
    if (message?.type === 'WORKSPACE_PRESENTATION') {
      const row = message.patch || {};
      const patch = { ...(typeof row.open === 'boolean' ? { open: row.open } : {}), ...(row.position ? { position: row.position } : {}), ...(row.size ? { size: row.size } : {}) };
      sendResponse({ state: await updateWorkspace(patch) }); return;
    }
    if (message?.type === 'WORKSPACE_NAVIGATE' || message?.type === 'WORKSPACE_DISPLAY') {
      const current = await readWorkspace();
      const state = await updateWorkspace(message.type === 'WORKSPACE_DISPLAY' ? { display: message.display, open: message.open ?? true } : { mode: message.mode, splitCategory: message.splitCategory || current.splitCategory, inboxSection: message.inboxSection || current.inboxSection, cloudSection: message.cloudSection || 'overview' });
      sendResponse({ state }); return;
    }
    if (message?.type === 'OPEN_WORKSPACE_COMMANDS') {
      await updateWorkspace({ display: 'float', open: true });
      await chrome.storage.session.set({ workspaceCommandsRequest: { id: crypto.randomUUID(), tabId: sender.tab?.id } });
      sendResponse({ ok: true }); return;
    }
    if (message?.type === 'CONSUME_WORKSPACE_COMMANDS') {
      commandWrites = commandWrites.catch(() => undefined).then(async () => {
        const request = (await chrome.storage.session.get('workspaceCommandsRequest')).workspaceCommandsRequest;
        const context = await workspaceContext(sender.tab);
        const open = Boolean(request && (request.tabId == null || request.tabId === context.tabId));
        if (open) await chrome.storage.session.remove('workspaceCommandsRequest');
        sendResponse({ open });
      });
      await commandWrites; return;
    }
    if (message?.type === 'RESET_WORKSPACE_LAYOUT') { sendResponse({ state: await updateWorkspace({ position: undefined, size: undefined }) }); return; }
    if (message?.type === 'OPEN_PIGEONBOX_WORKSPACE') { await showWorkspace(); sendResponse({ ok: true }); return; }
    if (message?.type === 'SET_WORKSPACE_CONTEXT') {
      if (sender.tab?.id == null) { sendResponse({ ok: false }); return; }
      const tabId = sender.tab.id;
      const row = message.context;
      const context = row?.threadId ? { tabId, threadId: String(row.threadId).slice(0, 128), subject: String(row.subject || '').slice(0, 998), sender: String(row.sender || '').slice(0, 320), owner: mailboxOwnerFrom(row.owner), pending: row.pending ? String(row.pending).slice(0, 200) : null, drafting: Boolean(row.drafting) } : null;
      const mailbox = mailboxOwnerFrom(message.mailbox) ?? context?.owner ?? null;
      contextWrites = contextWrites.then(async () => {
        const current = await chrome.storage.session.get(['workspaceContexts', 'workspaceMailboxes']);
        if (JSON.stringify(current.workspaceContexts?.[tabId]) !== JSON.stringify(context)) await chrome.storage.session.set({ workspaceContexts: { ...current.workspaceContexts, [tabId]: context } });
        if (mailbox && JSON.stringify(current.workspaceMailboxes?.[tabId]) !== JSON.stringify(mailbox)) await chrome.storage.session.set({ workspaceMailboxes: { ...current.workspaceMailboxes, [tabId]: mailbox } });
      });
      await contextWrites;
      sendResponse({ ok: true }); return;
    }
    if (message?.type === 'PB_DICTATION' && isExtensionPageSender(sender)) {
      // Voice input runs in the Gmail page the panel belongs to (the side panel: the active Gmail tab).
      const { tabId } = await workspaceContext(sender.tab);
      if (tabId == null) { sendResponse({ ok: false, reason: 'no_gmail' }); return; }
      const forward = message.action === 'stop' ? { type: 'PB_DICTATION_STOP', session: message.session } : { type: 'PB_DICTATION_START', session: message.session, lang: message.lang };
      try {
        sendResponse((await chrome.tabs.sendMessage(tabId, forward, { frameId: 0 })) ?? { ok: false, reason: 'no_gmail' });
      } catch {
        sendResponse({ ok: false, reason: 'no_gmail' });
      }
      return;
    }
    if (message?.type === 'GET_WORKSPACE_CONTEXT') {
      const context = await workspaceContext(sender.tab);
      if (context.tabId != null && sender.url?.includes('workspace.html')) await chrome.sidePanel.setOptions({ tabId: context.tabId, path: 'sidepanel.html', enabled: true });
      sendResponse(context); return;
    }
    if (message?.type === 'WORKSPACE_THREAD_ACTION') {
      const context = await workspaceContext(sender.tab);
      if (!context.context || context.context.threadId !== message.threadId || context.tabId == null) { sendResponse({ ok: false, reason: 'Reopen this conversation first.' }); return; }
      sendResponse(await chrome.tabs.sendMessage(context.tabId, { type: 'PIGEONBOX_WORKSPACE_ACTION', id: message.id, threadId: message.threadId, body: typeof message.body === 'string' ? message.body.slice(0, 40000) : undefined })); return;
    }


    if (message?.type === 'PRODUCT_EVENT') { void recordProductEvent(message.event, message.metadata); sendResponse({ ok: true }); return; }
    const cloudResponse = await handleCloudMessage(message, sender);
    if (cloudResponse !== undefined) {
      sendResponse(cloudResponse);
      return;
    }

    const productResponse = await handleProductMessage(message);
    if (productResponse !== undefined) {
      sendResponse(productResponse);
      return;
    }

    const parsed = RuntimeMessageSchema.safeParse(message);
    const contentBridgeMessage = message?.type === 'REQUEST_SUMMARY' || message?.type === 'REQUEST_DRAFT' || message?.type === 'GET_AI_JOB_STATUS';
    if (!parsed.success || contentBridgeMessage) {
      // Allow internal content-script messages
      if (message?.type === 'INGEST_THREAD' || message?.type === 'INGEST_THREADS') {
        const threads = (message.type === 'INGEST_THREADS' ? message.threads : [message.thread]) as IngestThread[];
        const direction = message.direction || 'inbound';
        const explicit = mailboxOwnerFrom(message.owner);
        const identity = explicit ? withSelfAliases(explicit, (threads || []).flatMap((thread) => (thread?.messages || []).flatMap((row) => [row.sender, ...(row.recipients || [])]))) : undefined;
        const owner = isGmailContentScript(sender) && !identity ? undefined : await mailboxIdentities.resolve(sender.tab?.id, sender.tab?.url || sender.url, identity);
        const results = [];
        for (const thread of threads || []) {
          if (!thread?.threadId) continue;
          if (owner) thread.mailboxEmail = owner.email;
          const result = await ingestor.ingestThread(thread);
          results.push(result);
          if (result.changed) await classifyIngested(thread, result.fingerprint, result.quality, direction, owner);
        }
        sendResponse({ ok: true, results });
        return;
      }
      if (message?.type === 'REPORT_RUNTIME') {
        await chrome.storage.session.set({ gmailRuntime: message.runtime });
        const owner = mailboxOwnerFrom(message.owner);
        if (owner) {
          await rememberMailboxOwner(owner);
          if (sender.tab?.id != null) await mailboxIdentities.remember(sender.tab.id, sender.tab.url || sender.url || '', owner);
        }
        sendResponse({ ok: true });
        return;
      }
      if (message?.type === 'LIST_SPLIT') {
        const category = String(message.category || 'RESPOND') as SplitView;
        const threads = await db.threads.toArray();
        const followUps =
          category === 'FOLLOW_UPS'
            ? (await db.reminders.where('status').equals('pending').toArray()).map((row) => row.threadId)
            : [];
        const matched = filterSplitThreads(threads, category, followUps);
        const rows = [];
        for (const thread of matched) {
          const owner = thread.mailboxEmail ? await mailboxIdentities.forEmail(thread.mailboxEmail) : undefined;
          const summary = visibleSummaryForOwner(await db.thread_summaries.get(thread.threadId), owner);
          rows.push({
            threadId: thread.threadId,
            subject: thread.subject,
            sender: thread.latestSender?.name || thread.latestSender?.email || 'Unknown',
            snippet: summary?.summary.oneLine || thread.snippet,
            timestamp: thread.latestTimestamp,
            priority: thread.priority,
            manual: Boolean(thread.manualCategory),
            category: thread.classification,
          });
        }
        rows.sort((a, b) => (a.timestamp < b.timestamp ? 1 : -1));
        sendResponse({ threads: rows, count: rows.length });
        return;
      }
      if (message?.type === 'SET_CATEGORY') {
        const threadId = String(message.threadId || '');
        const category = String(message.category || '');
        if (!threadId || !['RESPOND', 'WAITING', 'FYI'].includes(category)) {
          sendResponse({ ok: false, reason: 'Choose Respond, Waiting, or FYI.' });
          return;
        }
        await db.thread_overrides.put({
          threadId,
          category: category as 'RESPOND' | 'WAITING' | 'FYI',
          createdAt: Date.now(),
        });
        const thread = await db.threads.get(threadId);
        await db.thread_classifications.put({
          threadId,
          category: category as 'RESPOND' | 'WAITING' | 'FYI',
          confidence: 1,
          priority: thread?.priority || 'NORMAL',
          needsReply: category === 'RESPOND',
          waitingOnReply: category === 'WAITING',
          archiveRecommendation: false,
          reason: 'You set this category',
          source: 'override',
          fingerprint: thread?.contentFingerprint || 'manual',
          createdAt: Date.now(),
        });
        if (thread) {
          await db.threads.update(threadId, {
            classification: category as 'RESPOND' | 'WAITING' | 'FYI',
            manualCategory: category as 'RESPOND' | 'WAITING' | 'FYI',
            requiresResponse: category === 'RESPOND',
            awaitingResponse: category === 'WAITING',
            virtualLabels: [category],
          });
        }
        await publishIntel(threadId, 'THREAD_CLASSIFIED');
        sendResponse({ ok: true, category });
        return;
      }
      if (message?.type === 'REQUEST_SUMMARY' || message?.type === 'REQUEST_DRAFT') {
        const threadId = String(message.threadId || '');
        const thread = threadId ? await db.threads.get(threadId) : null;
        const stored = threadId ? await db.messages.where('threadId').equals(threadId).toArray() : [];
        const pageMessages = pageMessagesFrom(message.messages);
        const senderNames = senderNamesFrom(message.messages, stored);
        const storedMessages: RawSnapshotMessage[] = stored.map((row) => ({
          messageId: row.messageId,
          sender: row.sender.email,
          recipients: row.recipients?.map((r) => r.email) || [],
          bodyText: row.bodyText,
          timestamp: row.timestamp,
          loaded: (row.bodyText || '').trim().length > 0,
        }));
        const snapshot = await buildThreadSnapshot({
          threadId,
          subject: thread?.subject || String(message.subject || ''),
          pageMessages,
          storedMessages,
        });
        if ((!thread && !snapshot.messages.length) || !agent) {
          sendResponse({ ok: false, reason: 'Open the thread first.' });
          return;
        }
        const owner = isGmailContentScript(sender) && !mailboxOwnerFrom(message.owner) ? undefined : await mailboxIdentities.resolve(sender.tab?.id, sender.tab?.url || sender.url, mailboxOwnerFrom(message.owner));
        if (!owner && (message.type === 'REQUEST_SUMMARY' || message.type === 'SUMMARIZE_THREAD')) {
          sendResponse({ ok: false, status: 'waiting_owner', reason: 'Resolving Gmail account…' });
          return;
        }
        const input = {
          threadId,
          requireOwner: true,
          fingerprint: snapshot.fingerprint || thread?.contentFingerprint || `page:${threadId}`,
          subject: snapshot.subject,
          messages: tagAuthors(snapshot.messages.map((m) => ({
            sender: withSenderName(m.sender, senderNames),
            bodyText: m.bodyText,
            timestamp: m.timestamp,
          })), owner),
          owner,
          force: Boolean(message.force),
        };
        const result = message.type === 'REQUEST_SUMMARY'
          ? await agent.startSummaryJob(input)
          : await agent.startDraftJob(input);
        sendResponse(result);
        return;
      }
      if (message?.type === 'GET_AI_JOB_STATUS') {
        const jobId = String(message.jobId || '');
        const job = await db.ai_jobs?.get(jobId);
        let body: string | undefined;
        let oneLine: string | undefined;
        if (job?.status === 'succeeded') {
          if (job.kind === 'draft') {
            let matching = job.resultId ? await db.draft_suggestions.get(job.resultId) : undefined;
            if (!matching) {
              const drafts = await db.draft_suggestions.where('threadId').equals(job.threadId).toArray();
              matching = drafts.find((d) => d.fingerprint === job.fingerprint);
            }
            body = matching?.suggestion?.body;
          } else if (job.kind === 'summary') {
            const summary = await db.thread_summaries.get(job.threadId);
            oneLine = summary?.fingerprint === job.fingerprint ? summary.summary.oneLine : undefined;
          }
        }
        sendResponse({ ok: Boolean(job), job: job || null, body, oneLine });
        return;
      }
      if (message?.type === 'SUMMARIZE_THREAD' || message?.type === 'DRAFT_REPLY') {
        const threadId = String(message.threadId || '');
        const thread = threadId ? await db.threads.get(threadId) : null;
        const stored = threadId ? await db.messages.where('threadId').equals(threadId).toArray() : [];
        const pageMessages = pageMessagesFrom(message.messages);
        const senderNames = senderNamesFrom(message.messages, stored);
        const storedMessages: RawSnapshotMessage[] = stored.map((row) => ({
          messageId: row.messageId,
          sender: row.sender.email,
          recipients: row.recipients?.map((r) => r.email) || [],
          bodyText: row.bodyText,
          timestamp: row.timestamp,
          loaded: (row.bodyText || '').trim().length > 0,
        }));
        const snapshot = await buildThreadSnapshot({
          threadId,
          subject: thread?.subject || String(message.subject || ''),
          pageMessages,
          storedMessages,
        });
        if ((!thread && !snapshot.messages.length) || !agent) {
          sendResponse({ ok: false, reason: 'Open the thread first.' });
          return;
        }
        const owner = isGmailContentScript(sender) && !mailboxOwnerFrom(message.owner) ? undefined : await mailboxIdentities.resolve(sender.tab?.id, sender.tab?.url || sender.url, mailboxOwnerFrom(message.owner));
        if (!owner && (message.type === 'REQUEST_SUMMARY' || message.type === 'SUMMARIZE_THREAD')) {
          sendResponse({ ok: false, status: 'waiting_owner', reason: 'Resolving Gmail account…' });
          return;
        }
        const input = {
          threadId,
          requireOwner: true,
          fingerprint: snapshot.fingerprint || thread?.contentFingerprint || `page:${threadId}`,
          subject: snapshot.subject,
          messages: tagAuthors(snapshot.messages.map((m) => ({
            sender: withSenderName(m.sender, senderNames),
            bodyText: m.bodyText,
            timestamp: m.timestamp,
          })), owner),
          owner,
          force: Boolean(message.force),
        };
        const result = message.type === 'SUMMARIZE_THREAD' ? await agent.requestSummary(input) : await agent.requestDraft(input);
        sendResponse(result);
        return;
      }
      if (message?.type === 'OUTGOING_COMPOSE') {
        await agent?.onOutgoing({
          threadId: message.threadId || 'unknown',
          recipients: message.recipients || [],
          subject: message.subject || '',
          bodyText: message.bodyText || '',
          fingerprint: message.fingerprint || '',
        });
        sendResponse({ ok: true });
        return;
      }
      if (message?.type === 'CREATE_TRACKED_EMAIL') {
        // Token stays in service worker — never sent to content/MAIN world
        const target = settings.trackingEnabled ? await trackerTarget() : null;
        if (!target) {
          sendResponse({ error: 'tracking_not_configured' });
          return;
        }
        try {
          const client = new TrackingClient(target.baseUrl, target.credential);
          const created = await client.createEmail(message.input);
          const input = message.input as {
            subject?: string;
            sender?: string;
            recipients?: string[];
            gmail_thread_id?: string;
            gmail_message_id?: string;
          };
          await upsertTrackedEmail(
            summaryFromRemote(
              {
                tracking_id: created.tracking_id,
                subject: input.subject || '',
                sender: input.sender || '',
                recipients: input.recipients || [],
                status: created.status || 'PENDING',
                created_at: created.created_at || new Date().toISOString(),
                gmail_thread_id: input.gmail_thread_id ?? null,
                gmail_message_id: input.gmail_message_id ?? null,
                sent_at: created.sent_at ?? null,
                open_count: 0,
                click_count: 0,
              },
              null,
              trackerIssuer(settings),
            ),
          );
          sendResponse({ ok: true, ...created });
        } catch (e) {
          // Sending continues without tracking; the compose control shows it as unavailable.
          sendResponse({ error: e instanceof Error ? e.message : 'tracking_create_failed' });
        }
        return;
      }
      if (message?.type === 'MARK_TRACKED_SENT' || message?.type === 'SYNC_TRACKED_LINKS' || message?.type === 'UPDATE_TRACKED_EMAIL' || message?.type === 'CANCEL_TRACKED_EMAIL') {
        const trackingId = String(message.trackingId || '');
        if (!trackingId) {
          sendResponse({ error: 'missing_tracking_id' });
          return;
        }
        const patch = trackingPatchFromMessage(message);
        if (message.type === 'CANCEL_TRACKED_EMAIL') patch.status = 'CANCELLED';
        if (message.type === 'MARK_TRACKED_SENT') {
          patch.status = 'SENT';
          if (!patch.sentAt) patch.sentAt = new Date().toISOString();
        }
        const updated = await patchTrackedEmail(trackingId, patch);
        if (updated?.notifyIfNoReply && updated.status === 'SENT') await ensureNoReplyReminder(updated);
        const target = await trackerTargetFor(trackingId);
        let trackerSynced = false;
        if (target) {
          try {
            const client = new TrackingClient(target.baseUrl, target.credential);
            await client.linkEmail(trackingId, {
              ...(patch.gmailThreadId !== undefined ? { gmail_thread_id: patch.gmailThreadId } : {}),
              ...(patch.gmailMessageId !== undefined ? { gmail_message_id: patch.gmailMessageId } : {}),
              ...(patch.status ? { status: patch.status } : {}),
              ...(patch.sentAt !== undefined ? { sent_at: patch.sentAt } : {}),
              ...(patch.subject ? { subject: patch.subject } : {}),
              ...(patch.sender ? { sender: patch.sender } : {}),
              ...(patch.recipients ? { recipients: patch.recipients } : {}),
              ...(Array.isArray(message.links) ? { links: message.links } : {}),
            });
            trackerSynced = true;
          } catch (e) {
            console.warn('[gi] tracking update failed', e instanceof Error ? e.message : 'error');
          }
        }
        // `trackerSynced` tells compose whether click IDs exist on the tracker before it rewrites links to them.
        sendResponse({ ok: true, trackerSynced, emails: await readTrackedEmails() });
        return;
      }
      if (message?.type === 'REPORT_TRACKING') {
        await chrome.storage.session.set({ trackingReport: message.report });
        sendResponse({ ok: true });
        return;
      }
      if (message?.type === 'CHECK_TRACKER') {
        const enabled = typeof message.trackingEnabled === 'boolean' ? message.trackingEnabled : settings.trackingEnabled;
        if (!enabled) {
          sendResponse({ status: 'disabled', label: 'Disabled' });
          return;
        }
        if (settings.runMode === 'cloud') {
          const target = await trackerTarget();
          sendResponse(target ? await probeTrackerWithPermission(target.baseUrl, await credentialToken(target.credential)) : { status: 'missing', label: trackerHealthLabel('missing') });
          return;
        }
        let base = typeof message.trackerBaseUrl === 'string' ? message.trackerBaseUrl : settings.trackerBaseUrl;
        let token = typeof message.personalApiToken === 'string' ? message.personalApiToken : settings.personalApiToken;
        if (!base.trim() || !token.trim()) {
          await applyBundledTracker();
          if (settings.trackerBaseUrl.trim() && settings.personalApiToken.trim()) {
            base = settings.trackerBaseUrl;
            token = settings.personalApiToken;
          }
        }
        sendResponse(await probeTrackerWithPermission(base, token));
        return;
      }
      if (message?.type === 'LINK_TRACKED_EMAIL') {
        const trackingId = String(message.trackingId || '');
        const gmailThreadId = message.gmailThreadId ? String(message.gmailThreadId) : null;
        const gmailMessageId = message.gmailMessageId ? String(message.gmailMessageId) : null;
        if (!trackingId) {
          sendResponse({ error: 'missing_tracking_id' });
          return;
        }
        const patch: Partial<TrackedEmailSummary> = {};
        if (gmailThreadId) patch.gmailThreadId = gmailThreadId;
        if (gmailMessageId) patch.gmailMessageId = gmailMessageId;
        const updated = Object.keys(patch).length ? await patchTrackedEmail(trackingId, patch) : null;
        if (updated?.notifyIfNoReply) await ensureNoReplyReminder(updated);
        const target = gmailThreadId || gmailMessageId ? await trackerTargetFor(trackingId) : null;
        if (target) {
          try {
            const client = new TrackingClient(target.baseUrl, target.credential);
            await client.linkEmail(trackingId, {
              ...(gmailThreadId ? { gmail_thread_id: gmailThreadId } : {}),
              ...(gmailMessageId ? { gmail_message_id: gmailMessageId } : {}),
            });
          } catch (e) {
            console.warn('[gi] tracking link failed', e);
          }
        }
        sendResponse({ ok: true, emails: await readTrackedEmails() });
        return;
      }
      if (message?.type === 'TRACKING_INSPECTION_READY') {
        await navigationAttribution;
        const released = sender.tab?.id != null && attribution.inspected(sender.tab.id);
        await persistAttribution();
        if (released) void pollTracking();
        sendResponse({ ok: true });
        return;
      }
      if (message?.type === 'GET_TRACKED_EMAILS') {
        sendResponse({ emails: await readTrackedEmails() });
        return;
      }
      if (message?.type === 'RESOLVE_SENDER_TRACKING_LINK') {
        const clickId = String(message.clickId || '');
        const origin = String(message.origin || '');
        const allowed = [settings.trackerBaseUrl, ...cloudTrackerUrls(settings)].some((base) => {
          try { return new URL(base).origin === origin; } catch { return false; }
        });
        const target = allowed && /^clk_[\w-]{1,80}$/.test(clickId) && settings.trackingEnabled ? await trackerTarget() : null;
        if (!target) { sendResponse({}); return; }
        try {
          sendResponse(await new TrackingClient(target.baseUrl, target.credential).getLinkDestination(clickId));
        } catch { sendResponse({}); }
        return;
      }
      if (message?.type === 'GET_TRACKING_TIMELINE') {
        // Every counted open and click for one email, for the side panel's Waiting view.
        const trackingId = String(message.trackingId || '');
        const target = /^[\w-]{1,80}$/.test(trackingId) && settings.trackingEnabled ? await trackerTargetFor(trackingId) : null;
        if (!target) {
          sendResponse({ error: trackingId ? 'Activity is not available for this email.' : 'missing_tracking_id' });
          return;
        }
        try {
          const events = await new TrackingClient(target.baseUrl, target.credential).getEvents(trackingId);
          await navigationAttribution;
          await claimAttribution;
          sendResponse({ timeline: deriveTrackingTimeline(attribution.events(trackerIssuer(settings) || 'unconfigured', events)) });
        } catch (error) {
          sendResponse({ error: error instanceof Error ? error.message : 'Activity could not be loaded.' });
        }
        return;
      }
      if (message?.type === 'SET_NO_REPLY_NOTIFY') {
        const trackingId = String(message.trackingId || '');
        const enabled = Boolean(message.enabled);
        const updated = await patchTrackedEmail(trackingId, { notifyIfNoReply: enabled });
        if (!updated) {
          sendResponse({ ok: false, emails: await readTrackedEmails() });
          return;
        }
        if (enabled) await ensureNoReplyReminder(updated);
        else await db.reminders.delete(`trk_${trackingId}`);
        sendResponse({ ok: true, emails: await readTrackedEmails() });
        return;
      }
      if (message?.type === 'REMIND_THREAD') {
        const threadId = String(message.threadId || '');
        if (!threadId) {
          sendResponse({ error: 'missing_thread' });
          return;
        }
        const due = addBusinessDays(new Date(), settings.reminderBusinessDays).getTime();
        await db.reminders.put({
          id: `rem_${threadId}`,
          threadId,
          recipients: [],
          lastOutgoingAt: Date.now(),
          dueAt: due,
          status: 'pending',
          reason: 'Manual remind',
        });
        sendResponse({ ok: true, dueAt: due });
        return;
      }
      if (message?.type === 'FOCUS_SIDEPANEL') {
        try {
          if (typeof message.composeId === 'string' && /^[A-Za-z0-9-]{8,64}$/.test(message.composeId) && sender.tab?.id && isGmailContentScript(sender)) {
            await chrome.storage.session.set({ documentComposeTarget: { tabId: sender.tab.id, composeId: message.composeId } });
          }
          await openSidePanel(
            message.mode === 'inbox' ? 'inbox' : message.mode === 'cloud' ? 'cloud' : 'ask',
            message.category,
            typeof message.askQuery === 'string' ? message.askQuery : undefined,
            typeof message.askRequestId === 'string' ? message.askRequestId : undefined,
            typeof message.section === 'string' ? message.section : undefined,
          );
          sendResponse({ ok: true });
        } catch (error) {
          sendResponse({ ok: false, reason: String(error) });
        }
        return;
      }
      if (message?.type === 'OPEN_SPLIT') {
        try {
          await openSidePanel('inbox', String(message.category || 'RESPOND'));
          sendResponse({ ok: true, category: message.category });
        } catch (error) {
          sendResponse({ ok: false, reason: String(error) });
        }
        return;
      }
      if (message?.type === 'COMMAND') {
        const id = String(message.id || '');
        const known = ['ask', 'summarize', 'draft', 'remind', 'archive', 'settings', 'mark_respond', 'mark_waiting', 'mark_fyi'];
        if (!known.includes(id)) {
          sendResponse({ ok: false, reason: 'That command is not available.' });
          return;
        }
        sendResponse({ ok: false, reason: 'Run this command from Gmail.' });
        return;
      }
      if (message?.type === 'GET_THREAD_INTEL' || message?.type === 'GET_THREAD_INTEL_MANY') {
        const ids = (message.type === 'GET_THREAD_INTEL_MANY' ? message.threadIds : [message.threadId]) as string[];
        const intel: Record<string, unknown> = {};
        for (const threadId of (ids || []).filter((id) => typeof id === 'string').slice(0, 40)) {
          const [threadRow, classification, summary, drafts, override] = await Promise.all([
            db.threads.get(threadId),
            db.thread_classifications.get(threadId),
            db.thread_summaries.get(threadId),
            db.draft_suggestions.where('threadId').equals(threadId).toArray(),
            db.thread_overrides.get(threadId),
          ]);
          const resolvedOwner = isGmailContentScript(sender) && !mailboxOwnerFrom(message.owner) ? undefined : await mailboxIdentities.resolve(sender.tab?.id, sender.tab?.url || sender.url, mailboxOwnerFrom(message.owner));
          const owner = resolvedOwner || (isExtensionPageSender(sender) && threadRow?.mailboxEmail ? await mailboxIdentities.forEmail(threadRow.mailboxEmail) : undefined);
          const visibleSummary = visibleSummaryForOwner(summary, owner);
          const currentFingerprint = summary?.sourceFingerprint || threadRow?.contentFingerprint;
          const matchingDraft = currentFingerprint
            ? drafts.find((d) => d.fingerprint === currentFingerprint) || null
            : drafts.sort((a, b) => b.createdAt - a.createdAt)[0] || null;
          intel[threadId] = { classification, summary: visibleSummary, draft: matchingDraft, manual: Boolean(override) };
        }
        sendResponse(message.type === 'GET_THREAD_INTEL_MANY' ? { intel } : intel[ids[0]] || {});
        return;
      }
      if (message?.type === 'ENSURE_WORKER_TAB') {
        const id = await workerTabs.ensureTab({ pinned: Boolean(message.pinned), active: false });
        sendResponse({ tabId: id });
        return;
      }
      if (message?.type === 'inboxsdk__injectPageWorld' && sender?.tab?.id != null) {
        try {
          const documentIds = sender.documentId ? [sender.documentId] : undefined;
          const frameIds = !documentIds && sender.frameId != null ? [sender.frameId] : undefined;
          await chrome.scripting.executeScript({
            target: { tabId: sender.tab.id, documentIds, frameIds },
            world: 'MAIN',
            files: ['inboxsdk/pageWorld.js'],
          });
          sendResponse(true);
        } catch (e) {
          console.warn('[gi] InboxSDK pageWorld injection failed', e);
          try {
            const documentIds = sender.documentId ? [sender.documentId] : undefined;
            const frameIds = !documentIds && sender.frameId != null ? [sender.frameId] : undefined;
            await chrome.scripting.executeScript({
              target: { tabId: sender.tab.id, documentIds, frameIds },
              world: 'MAIN',
              func: () => document.head.removeAttribute('data-inboxsdk-script-injected'),
            });
          } catch {
            /* The page can retry injection after a reload. */
          }
          sendResponse(false);
        }
        return;
      }
      if (message?.type === 'SAVE_AGENT_RULES') {
        await saveAgentRules((message.lines || []) as string[]);
        sendResponse({ ok: true });
        return;
      }
      sendResponse({ error: 'invalid_message' });
      return;
    }

    const msg = parsed.data;
    switch (msg.type) {
      case 'PING':
        sendResponse({ ok: true });
        break;
      case 'GET_PUBLIC_SETTINGS':
        sendResponse({ settings: await contentSettings() });
        // A Gmail tab just opened: load the local model now rather than on the first summary.
        if (sender.tab?.url?.startsWith('https://mail.google.com/') && settings.runMode === 'local' && settings.aiMode !== 'disabled' && settings.aiProvider === 'local') {
          void warmOnDevice(settings.aiModel).catch(() => undefined);
        }
        break;
      case 'GET_SETTINGS':
        // Extension pages are trusted and edit secrets; anything else gets the public view.
        // (The options page opens in a tab, so `sender.tab` alone cannot tell them apart.)
        sendResponse({ settings: isExtensionPageSender(sender) ? settings : await contentSettings() });
        break;
      case 'SAVE_SETTINGS':
        sendResponse({ settings: await saveSettings(msg.settings as Partial<ExtensionSettings>) });
        break;
      case 'RUN_DIAGNOSTICS':
        sendResponse(await runDiagnostics());
        break;
      case 'ASK_INBOX':
        sendResponse(await handleAskPigeon(msg.query, typeof message.threadId === 'string' ? message.threadId : undefined, await mailboxIdentities.resolve(sender.tab?.id, sender.tab?.url || sender.url, mailboxOwnerFrom(message.owner))));
        break;
      case 'OPEN_COMPOSE_DRAFT':
        sendResponse(await openComposeDraft(msg.draft));
        break;
      case 'INDEX_INBOX':
        sendResponse({ checkpoint: await runInboxIndex(msg.mode, msg.customQuery) });
        break;
      case 'PAUSE_INDEX':
        indexRunner?.pause();
        sendResponse({ ok: true });
        break;
      case 'RESUME_INDEX':
        indexRunner?.resume();
        sendResponse({ ok: true });
        break;
      case 'CLEAR_INDEX':
        await ingestor.clearIndex();
        lexical.clear();
        sendResponse({ ok: true });
        break;
      case 'CLEAR_AI_CACHE':
        queue.clearCache();
        await db.model_cache.clear();
        sendResponse({ ok: true });
        break;
      case 'GET_ACTIVITY_LOG': {
        const actions = await db.agent_actions.orderBy('createdAt').reverse().limit(100).toArray();
        sendResponse({ actions });
        break;
      }
      case 'UNDO_ACTION': {
        const action = await db.agent_actions.get(msg.actionId);
        if (!action || !action.undoable || action.undone) {
          sendResponse({ ok: false });
          break;
        }
        if (action.type === 'archive' && action.threadId) {
          const threadId = action.threadId;
          await workerTabs.runExclusive((tabId) =>
            sendToTab(tabId, {
              type: 'PERFORM_ACTION',
              context: 'background',
              action: { kind: 'NAVIGATE_SEARCH', query: 'in:anywhere' },
              thenOpenThreadId: threadId,
            }),
          );
          await db.threads.update(threadId, { archivedLocally: false });
        }
        await db.agent_actions.update(msg.actionId, { undone: true });
        sendResponse({ ok: true });
        break;
      }
      case 'TRACKING_POLL':
        await pollTracking();
        sendResponse({ ok: true });
        break;
      case 'TRACKING_SELF_VIEW': {
        await claimAttribution;
        const target = msg.trackingId ? await trackerTargetFor(String(msg.trackingId)) : null;
        if (!target) {
          sendResponse({
            ok: false,
            recorded: false,
            error: 'Tracking is not configured or tracking ID is missing',
          });
          break;
        }

        const client = new TrackingClient(target.baseUrl, target.credential);
        const normMessageId = normalizeGmailId(msg.gmailMessageId);
        const normThreadId = normalizeGmailId(msg.gmailThreadId);
        const source = msg.source || 'MESSAGE_EXPANDED';
        const timestamp = msg.timestamp || new Date().toISOString();
        const selfViewEventId =
          msg.selfViewEventId ||
          `sv_${msg.trackingId}_${normMessageId || 'nomessage'}_${source}_${Date.parse(timestamp) || Date.now()}`;

        const pendingClaim: PendingSelfView = { issuer: trackerIssuer(settings) || 'unconfigured', trackingId: msg.trackingId, eventId: selfViewEventId, observedAt: Date.parse(timestamp), tabId: sender.tab?.id };
        attribution.begin(pendingClaim);
        const deliveryKey = `${pendingClaim.trackingId}\n${pendingClaim.eventId}`;
        deliveringClaims.add(deliveryKey);
        try {
        await persistAttribution();

        const retryPayload = { source, gmailThreadId: normThreadId, gmailMessageId: normMessageId, quotedRender: msg.quotedRender === true, pixelRender: msg.pixelRender === true, reconcileGmailIds: msg.reconcileGmailIds === true };
        // Also retry a successful legacy claim whose canonical detail lookup fails.
        attribution.retry(pendingClaim, retryPayload);
        await persistAttribution();
        let lastErr: unknown = null;
        let result: Awaited<ReturnType<typeof client.recordSelfView>> | null = null;
        const delays = [0, 500, 2000];
        let attempt = 0;

        for (attempt = 0; attempt < delays.length; attempt++) {
          if (delays[attempt] > 0) {
            await new Promise((resolve) => setTimeout(resolve, delays[attempt]));
          }
          try {
            result = await client.recordSelfView(msg.trackingId, {
              timestamp,
              gmailThreadId: normThreadId,
              gmailMessageId: normMessageId,
              source,
              selfViewEventId,
              reconcileGmailIds: msg.reconcileGmailIds === true,
              quotedRender: msg.quotedRender === true,
              pixelRender: msg.pixelRender === true,
            });
            lastErr = null;
            break;
          } catch (err) {
            lastErr = err;
            const errStr = err instanceof Error ? err.message : String(err ?? '');
            // Retrying cannot fix a rejected token (already refreshed once), a lapsed plan or an unknown email.
            if (errStr.includes('401') || errStr.includes('402') || errStr.includes('404')) {
              break;
            }
          }
        }

        if (!result?.ok) {
          // Store retry metadata on the same precise reservation, never an extra suppression window.
          const pending = attribution.snapshot().pending.find((row) => row.eventId === selfViewEventId && row.trackingId === msg.trackingId);
          if (pending) pending.retry = retryPayload;
          await persistAttribution();
        }
        if (result && result.ok) {
          await reconcileSelfView(pendingClaim, result, client);
          void pollTracking();
          try {
            await chrome.storage.session?.set?.({
              lastSelfViewDiagnostic: {
                observedAt: timestamp,
                source,
                trackingId: msg.trackingId,
                normalizedMessageId: normMessageId,
                deliveryStatus: 'delivered',
                claimId: result.claimId ?? null,
                claimExpiresAt: result.claimExpiresAt ?? null,
                retryCount: attempt,
                lastError: null,
                claimConsumed: Boolean(result.reclassifiedEventIds && result.reclassifiedEventIds.length > 0),
                openCount: result.open_count ?? result.openCount,
              },
            });
          } catch (err) {
            console.warn('[gi][tracking] Failed to save session diagnostic', err);
          }

          sendResponse({
            recorded: true,
            ...result,
          });
        } else {
          const errMessage = lastErr instanceof Error ? lastErr.message : String(lastErr ?? 'Self-view failed');
          try {
            await chrome.storage.session?.set?.({
              lastSelfViewDiagnostic: {
                observedAt: timestamp,
                source,
                trackingId: msg.trackingId,
                normalizedMessageId: normMessageId,
                deliveryStatus: 'failed',
                claimId: null,
                claimExpiresAt: null,
                retryCount: attempt,
                lastError: errMessage,
                claimConsumed: false,
              },
            });
          } catch (err) {
            console.warn('[gi][tracking] Failed to save session diagnostic', err);
          }

          sendResponse({
            ok: false,
            recorded: false,
            error: errMessage,
          });
        }
        } finally { deliveringClaims.delete(deliveryKey); }
        break;
      }
      case 'CHATGPT_LOGIN':
        if (!EXPERIMENTAL_FEATURES) {
          sendResponse({ ok: false, error: 'ChatGPT sign-in is an experimental feature and is not part of this build.' });
          break;
        }
        sendResponse(await startChatGptLogin());
        break;
      case 'CHATGPT_LOGOUT':
        await logoutChatGpt();
        if (settings.aiProvider === 'chatgpt') await saveSettings({ aiMode: 'disabled' });
        sendResponse({ ok: true });
        break;
      case 'CHATGPT_STATUS':
        sendResponse(await getChatGptPublicStatus());
        break;
      case 'LOCAL_MODEL_DOWNLOAD':
        try {
          await downloadOnDevice(msg.modelId);
          sendResponse({ ok: true });
        } catch (error) {
          sendResponse({
            ok: false,
            error: error instanceof Error ? error.message : 'Could not download the model.',
          });
        }
        break;
      case 'WRITE_WITH_AI': {
        const ai = getAI();
        if (!ai) {
          sendResponse({ error: 'AI disabled' });
          break;
        }
        const { result } = await ai.rewriteText({
          text: msg.text,
          mode: msg.mode as import('@pigeonbox/ai').RewriteInput['mode'],
          voice: settings.voiceProfile,
          context: msg.context,
        });
        sendResponse({ text: result });
        break;
      }
      case 'GMAIL_EVENT':
        sendResponse({ ok: true });
        break;
      case 'ENQUEUE_ACTION': {
        const background = Boolean((msg.args as { background?: boolean } | undefined)?.background);
        const [active] = await chrome.tabs.query({ active: true, currentWindow: true });
        const gmailTabs = await chrome.tabs.query({ url: 'https://mail.google.com/*' });
        const workerTabId = background ? await workerTabs.ensureTab({ active: false, pinned: true }) : workerTabs.getTabId();
        const selected = selectGmailTab({
          mode: background ? 'background' : 'foreground',
          activeTab: active,
          workerTabId,
          gmailTabs,
        });
        if (selected.tabId == null) {
          sendResponse({ success: false, verified: false, reason: selected.reason || 'No Gmail tab' });
          break;
        }
        const res = await sendToTab(selected.tabId, {
          type: 'PERFORM_ACTION',
          context: background ? 'background' : 'foreground',
          action: { kind: msg.action, ...(msg.args || {}) },
        });
        sendResponse(res);
        break;
      }
      default:
        sendResponse({ error: 'unhandled' });
    }
    } catch (error) {
      const reason = error instanceof Error ? error.message : 'The extension hit an error.';
      try {
        sendResponse({ ok: false, reason });
      } catch {
        /* The response was already sent. */
      }
    }
  })();
  return true;
});

/** Replace the local agent rules with the parseable lines. */
async function saveAgentRules(lines: string[]): Promise<void> {
  const { parseNaturalLanguageRule } = await import('@pigeonbox/agent');
  await db.agent_rules.clear();
  for (const line of lines) {
    const structured = parseNaturalLanguageRule(line);
    if (!structured) continue;
    await db.agent_rules.put({
      id: `rule_${Date.now()}_${Math.random().toString(36).slice(2, 6)}`,
      naturalLanguage: line,
      structured,
      enabled: true,
      createdAt: Date.now(),
    });
  }
}

/** Index older Gmail threads through a background Gmail tab, then fill in a few incomplete ones. */
async function runInboxIndex(mode: Parameters<IndexJobRunner['run']>[0]['mode'], customQuery?: string) {
  const workerId = await workerTabs.ensureTab({ active: false, pinned: true });
  indexRunner = new IndexJobRunner(ingestor, async (query, cursor) => {
    const res = (await sendToTab(workerId, {
      type: 'INDEX_FETCH_BATCH',
      query,
      cursor,
    })) as {
      threads?: IngestThread[];
      nextCursor?: string;
      error?: string;
      captchaOrBlock?: boolean;
    };
    return {
      threads: res.threads || [],
      nextCursor: res.nextCursor,
      error: res.error,
      captchaOrBlock: res.captchaOrBlock,
    };
  });
  const cp = await indexRunner.run({ mode, customQuery });
  for (const threadId of (cp.processedThreadIds || []).slice(0, 8)) {
    const row = await db.threads.get(threadId);
    if (row?.quality === 'THREAD_COMPLETE') continue;
    const hydrated = (await sendToTab(workerId, {
      type: 'HYDRATE_THREAD',
      threadId,
      restore: true,
    })) as { thread?: IngestThread };
    if (!hydrated.thread) continue;
    const result = await ingestor.ingestThread(hydrated.thread);
    if (result.changed) await classifyIngested(hydrated.thread, result.fingerprint, result.quality, 'inbound');
  }
  await rebuildSearchIndex();
  return cp;
}

/** Everything a PigeonBox page needs to render mode, capabilities and Cloud status. */
async function productState() {
  const cloud: CloudState = await readCloudState(settings);
  const capabilities = resolveCapabilities({ mode: settings.runMode, settings, cloud });
  return {
    runMode: settings.runMode,
    cloudAvailable: Boolean(cloudApiUrl(settings)),
    cloudConsentAt: settings.cloudConsentAt,
    cloud,
    capabilities: capabilities.list(),
    aiDestination: aiDataDestination(settings),
    experimental: EXPERIMENTAL_FEATURES,
    // Host permissions Cloud mode needs; the page requests them with a user gesture before sign-in.
    cloudOrigins: [cloudApiUrl(settings), cloudTrackerUrl(settings)]
      .filter((url): url is string => Boolean(url))
      .map((url) => `${new URL(url).origin}/*`),
  };
}

/**
 * The PigeonBox dashboard, where Settings live, opened at a section such as
 * "approvals". It names this install's ID so the page can reach the worker
 * (unpacked builds have their own IDs). A loopback API serves its own copy.
 */
function dashboardUrl(section = 'overview', extra: Record<string, string> = {}): string {
  const base = cloudApiUrl(settings);
  const api = base ? new URL(base) : null;
  const dashboard = api && ['localhost', '127.0.0.1', '[::1]'].includes(api.hostname) ? `${api.origin}/dashboard` : CLOUD_DASHBOARD_URL;
  const query = new URLSearchParams({ ext: chrome.runtime.id, ...extra });
  return `${dashboard}?${query}#${dashboardSection(section)}`;
}

function cloudWebUrl(section = 'overview'): string | null {
  return dashboardUrl(cloudSection(section));
}

const DASHBOARD_TAB_KEY = 'dashboardTab';

/**
 * Open the dashboard, reusing the tab that shows it. Without the "tabs"
 * permission the worker cannot read a website tab's address, so the dashboard
 * reports its own tab when it loads and when it goes away (see web-bridge.ts).
 */
async function openDashboard(section = 'overview', extra: Record<string, string> = {}): Promise<void> {
  const url = dashboardUrl(section, extra);
  const tabId = (await chrome.storage.session.get(DASHBOARD_TAB_KEY))[DASHBOARD_TAB_KEY];
  if (typeof tabId === 'number') {
    try {
      const tab = await chrome.tabs.update(tabId, { url, active: true });
      if (tab?.windowId != null) await chrome.windows.update(tab.windowId, { focused: true }).catch(() => undefined);
      return;
    } catch {
      await chrome.storage.session.remove(DASHBOARD_TAB_KEY);
    }
  }
  await chrome.tabs.create({ url });
}

chrome.tabs.onRemoved.addListener((tabId) => {
  void chrome.storage.session.get(DASHBOARD_TAB_KEY).then((stored) => {
    if (stored[DASHBOARD_TAB_KEY] === tabId) return chrome.storage.session.remove(DASHBOARD_TAB_KEY);
  }).catch(() => undefined);
});

/** After any Cloud sign-in: account state, voice, content settings, the agent and tracking history. */
async function afterCloudSignIn(): Promise<void> {
  await refreshCloudState(settings);
  await chrome.storage.local.remove(VOICE_SYNCED_KEY).catch(() => undefined);
  void syncVoiceToCloud();
  await publishContentSettings();
  rebuildAgent();
  // Cloud is the record for hosted tracking: load its history right after sign-in.
  void pollTracking().catch(() => undefined);
}

/** A Cloud client only when Cloud's always-on features (`cloud_mail_sync`) are available; null in Local mode. */
async function cloudSyncClient() {
  const client = getCloudClient(settings);
  if (!client) return null;
  const state = await readCloudState(settings);
  return cloudThreadStateAvailable(state, settings.runMode) ? client : null;
}

/**
 * PigeonBox Cloud messages (thread state, page calls, opening the web app).
 * Content scripts may only send CLOUD_THREAD_INTEL (read-only); the rest need
 * an extension page (enforced by `senderMaySend`). Returns undefined for any other message.
 */
async function handleCloudMessage(message: { type?: unknown; [key: string]: unknown }, sender: chrome.runtime.MessageSender): Promise<unknown> {
  return handleCloudRequest(message, sender, { settings: () => settings, readState: () => readCloudState(settings), client: async () => settings.runMode === 'cloud' ? getCloudClient(settings) : null, webUrl: cloudWebUrl });
}

async function pollCloudNotifications(): Promise<void> {
  const client = await cloudSyncClient().catch(() => null);
  if (!client) return;
  void syncVoiceToCloud();
  await pollNotifications(client, chrome.storage.local, (id, _kind, title, body) => {
    void Promise.resolve(chrome.notifications.create(id, { type: 'basic', iconUrl: chrome.runtime.getURL('icons/icon128.png'), title, message: body })).catch(() => undefined);
  }).catch(() => undefined);
}

chrome.notifications.onClicked.addListener((id) => {
  const trackingId = trackingIdFromNotification(id);
  if (trackingId) {
    void readTrackedEmails().then((emails) => {
      const email = emails.find((item) => item.trackingId === trackingId);
      void chrome.tabs.create({ url: gmailThreadUrl({ gmailThreadId: email?.gmailThreadId ?? null, sender: email?.sender ?? null }) });
      chrome.notifications.clear(id);
    });
    return;
  }
  const match = id.match(/^cloud_([a-z_]+)_/);
  if (!match) return;
  const section = match[1] === 'approval' ? 'approvals' : match[1] === 'mention' || match[1] === 'assignment' ? 'team' : match[1] === 'sync_problem' ? 'connections' : 'overview';
  void loadSettings().then(() => {
    const url = cloudWebUrl(section);
    if (url) void chrome.tabs.create({ url });
    chrome.notifications.clear(id);
  });
});

/**
 * Run mode, Cloud account and billing messages. Returns undefined for any other
 * message. Only extension pages reach here (see `senderMaySend`).
 */
async function handleProductMessage(message: { type?: unknown; [key: string]: unknown }): Promise<unknown> {
  switch (message?.type) {
    case 'GET_PRODUCT_STATE':
      return productState();
    case 'OPEN_DASHBOARD': {
      const setup: Record<string, string> = message.setup === 'cloud' ? { setup: 'cloud' } : {};
      await openDashboard(typeof message.section === 'string' ? message.section : 'overview', setup);
      return { ok: true };
    }
    case 'GET_DASHBOARD_URL':
      return { ok: true, url: dashboardUrl(typeof message.section === 'string' ? message.section : 'overview') };
    case 'SET_RUN_MODE': {
      const mode = message.mode;
      if (mode === 'local') {
        settings = migrateSettings({ ...settings, runMode: 'local' });
      } else if (mode === 'cloud') {
        if (!cloudApiUrl(settings)) return { ok: false, reason: 'PigeonBox Cloud is not available in this build.' };
        if (message.consent !== true) return { ok: false, reason: 'Cloud mode needs your agreement to send email content to PigeonBox Cloud.' };
        settings = migrateSettings({ ...settings, runMode: 'cloud', cloudConsentAt: new Date().toISOString() });
      } else {
        return { ok: false, reason: 'Unknown mode.' };
      }
      await chrome.storage.local.set({ settings });
      // A subscription may have started since the account state was cached. Only after saving:
      // other messages reload settings from storage while this waits on the network.
      if (mode === 'cloud') await refreshCloudState(settings).catch(() => undefined);
      await publishContentSettings();
      rebuildAgent();
      // Each mode has its own tracker; load its history now rather than on the next alarm.
      void pollTracking().catch(() => undefined);
      return { ok: true, state: await productState() };
    }
    case 'CLOUD_SIGN_IN': {
      forgetThreadIntel();
      const base = cloudApiUrl(settings);
      if (!base) return { ok: false, reason: 'PigeonBox Cloud is not available in this build.' };
      try {
        const user = await cloudSession.signIn(base);
        await afterCloudSignIn();
        return { ok: true, user, state: await productState() };
      } catch (error) {
        return { ok: false, reason: cloudErrorMessage(error).message, detail: error instanceof Error ? error.message : undefined };
      }
    }
    case 'CLOUD_SIGN_OUT':
      // Signing out never changes the run mode or any local data.
      await cloudSession.signOut();
      await clearCloudState();
      forgetThreadIntel();
      await publishContentSettings();
      rebuildAgent();
      return { ok: true, state: await productState() };
    case 'CLOUD_REFRESH':
      await refreshCloudState(settings);
      await publishContentSettings();
      return { ok: true, state: await productState() };
    case 'CLOUD_BILLING': {
      const client = getCloudClient(settings);
      if (!client) return { ok: false, reason: 'PigeonBox Cloud is not available in this build.' };
      try {
        const { url } = message.kind === 'portal' ? await client.billingPortal() : await client.billingCheckout();
        await chrome.tabs.create({ url });
        return { ok: true };
      } catch (error) {
        return { ok: false, reason: cloudErrorMessage(error).message };
      }
    }
    default:
      return undefined;
  }
}

// The dashboard on usepigeonbox.com edits settings and connects Cloud through here (see web-bridge.ts).
const webBridge: WebBridgeDeps = {
  extensionId: chrome.runtime.id,
  version: chrome.runtime.getManifest().version,
  storeInstall: () => chromeManagesUpdates(),
  allowLoopback: DEV_BUILD,
  settings: () => settings,
  saveSettings: (partial) => saveSettings(partial),
  productState: () => productState(),
  productMessage: async (message) => {
    const reply = await handleProductMessage(message);
    return reply && typeof reply === 'object' && 'state' in reply ? { ...reply, product: (reply as { state: unknown }).state } : reply;
  },
  apiBaseUrl: () => cloudApiUrl(settings),
  exchangeLinkedCode: async (apiBaseUrl, input) => {
    forgetThreadIntel();
    return cloudSession.exchangeLinkedCode(apiBaseUrl, input);
  },
  afterSignIn: () => afterCloudSignIn(),
  currentAccount: async () => {
    const api = cloudApiUrl(settings);
    return api ? cloudSession.currentUser(api) : null;
  },
  dashboardCode: async (input) => {
    const api = cloudApiUrl(settings);
    if (!api) throw new Error('Cloud is not available in this build.');
    return cloudSession.dashboardCode(api, input);
  },
  agentRules: async () => (await db.agent_rules.toArray()).map((rule) => rule.naturalLanguage),
  saveAgentRules: (lines) => saveAgentRules(lines),
  action: async (name) => {
    switch (name) {
      case 'clear_index':
        await ingestor.clearIndex();
        lexical.clear();
        return null;
      case 'clear_ai_cache':
        queue.clearCache();
        await db.model_cache.clear();
        return null;
      case 'index_inbox':
        void runInboxIndex('30d').catch(() => undefined);
        return null;
      case 'pause_index':
        indexRunner?.pause();
        return null;
      case 'reset_workspace':
        await updateWorkspace({ position: undefined, size: undefined });
        return null;
      case 'diagnostics':
        return runDiagnostics();
      case 'open_ai_setup':
        await chrome.tabs.create({ url: chrome.runtime.getURL('settings.html?here=ai') });
        return null;
      case 'open_gmail':
        await chrome.tabs.create({ url: 'https://mail.google.com/' });
        return null;
      default:
        return null;
    }
  },
  analytics: {
    get: async () => (await chrome.storage.local.get('productAnalyticsEnabled')).productAnalyticsEnabled === true,
    set: async (enabled) => {
      await chrome.storage.local.set({ productAnalyticsEnabled: enabled });
      if (!enabled) await chrome.storage.local.remove('productEventCounts');
    },
  },
  hasOrigins: (origins) => chrome.permissions.contains({ origins }).catch(() => false),
  noteDashboardTab: async (tabId) => {
    if (tabId === null) await chrome.storage.session.remove(DASHBOARD_TAB_KEY);
    else await chrome.storage.session.set({ [DASHBOARD_TAB_KEY]: tabId });
  },
  openGrant: async (origins) => {
    await chrome.windows.create({ url: chrome.runtime.getURL(`grant.html?${new URLSearchParams({ origins: origins.join(',') })}`), type: 'popup', width: 440, height: 420, focused: true });
  },
  session: chrome.storage.session,
};

chrome.runtime.onMessageExternal.addListener((message, sender, sendResponse) => {
  void (async () => {
    try {
      await loadSettings();
      if (!agent) rebuildAgent();
      sendResponse(await handleWebMessage(message, sender, webBridge));
    } catch (error) {
      sendResponse({ ok: false, reason: error instanceof Error ? error.message : 'PigeonBox hit an error.' });
    }
  })();
  return true;
});

const EMAIL_PATTERN = /^[^\s@<>]+@[^\s@<>]+\.[^\s@<>]+$/;

/** The Gmail account the content script read from the page, if any. */
function mailboxOwnerFrom(value: unknown): MailboxIdentity | undefined {
  if (!value || typeof value !== 'object') return undefined;
  const { email, name, aliases } = value as { email?: unknown; name?: unknown; aliases?: unknown };
  if (typeof email !== 'string' || !EMAIL_PATTERN.test(email)) return undefined;
  const cleanName = typeof name === 'string' ? name.trim().slice(0, 80) : '';
  return { email: email.trim().toLowerCase(), name: cleanName || undefined, aliases: Array.isArray(aliases) ? aliases.filter((alias): alias is string => typeof alias === 'string' && EMAIL_PATTERN.test(alias)).slice(0, 20).map((alias) => alias.trim().toLowerCase()) : undefined };
}

/** Display names by lowercased address, from the page first and then stored rows. */
function senderNamesFrom(pageValue: unknown, stored: Array<{ sender: { email: string; name?: string } }>): Map<string, string> {
  const names = new Map<string, string>();
  const add = (email: unknown, name: unknown) => {
    if (typeof email !== 'string' || typeof name !== 'string') return;
    const key = email.trim().toLowerCase();
    const value = name.trim().slice(0, 80);
    if (key && value && !value.includes('@') && !names.has(key)) names.set(key, value);
  };
  if (Array.isArray(pageValue)) {
    for (const item of pageValue.slice(0, 50)) {
      if (item && typeof item === 'object') add((item as { sender?: unknown }).sender, (item as { senderName?: unknown }).senderName);
    }
  }
  for (const row of stored) add(row.sender?.email, row.sender?.name);
  return names;
}

function withSenderName(sender: string, names: Map<string, string>): string {
  const name = names.get(sender.trim().toLowerCase());
  return name ? `${name} <${sender}>` : sender;
}

function pageMessagesFrom(value: unknown): RawSnapshotMessage[] {
  if (!Array.isArray(value)) return [];
  return value.slice(0, 50).flatMap((item) => {
    if (!item || typeof item !== 'object') return [];
    const row = item as {
      messageId?: unknown;
      sender?: unknown;
      recipients?: unknown;
      bodyText?: unknown;
      timestamp?: unknown;
      loaded?: unknown;
    };
    const bodyText = typeof row.bodyText === 'string' ? row.bodyText.slice(0, 20_000) : '';
    const messageId = typeof row.messageId === 'string' ? row.messageId : undefined;
    const sender = typeof row.sender === 'string' ? row.sender.slice(0, 200) : 'unknown@local';
    const recipients = Array.isArray(row.recipients)
      ? row.recipients.filter((r): r is string => typeof r === 'string').map((r) => r.slice(0, 200))
      : [];
    const timestamp = typeof row.timestamp === 'string' ? row.timestamp.slice(0, 80) : '';
    const loaded = typeof row.loaded === 'boolean' ? row.loaded : bodyText.trim().length > 0;
    return [{
      messageId,
      sender,
      recipients,
      bodyText,
      timestamp,
      loaded,
    }];
  });
}

setChatGptSignedInHandler(async () => {
  const model = isChatGptModel(settings.aiModel) ? settings.aiModel : CHATGPT_DEFAULT_MODEL;
  await saveSettings({
    aiMode: 'remote',
    aiProvider: 'chatgpt',
    aiModel: model,
  });
});

// Experimental ChatGPT web sign-in is inert in release builds.
if (EXPERIMENTAL_FEATURES) installChatGptLoginListeners();

void hardenExtensionStorage()
  .then(() => loadSettings())
  .then(async () => {
    rebuildAgent();
    chrome.alarms.create('tracking_poll', { periodInMinutes: 1 });
    chrome.alarms.create(NOTIFICATION_ALARM, { periodInMinutes: 2 });
    await refreshGmailTabsAfterRestart({
      storage: chrome.storage,
      tabs: {
        query: (query) => chrome.tabs.query(query),
        reload: (tabId) => chrome.tabs.reload(tabId),
      },
    });
    await pollTracking();
  })
  .catch((err) => {
    if (isWorkerEvictionError(err)) return;
    console.warn('[gi] background initialization failed', err);
  });

function trackingPatchFromMessage(message: {
  gmailThreadId?: unknown;
  gmailMessageId?: unknown;
  gmail_thread_id?: unknown;
  gmail_message_id?: unknown;
  sentAt?: unknown;
  sent_at?: unknown;
  subject?: unknown;
  sender?: unknown;
  recipients?: unknown;
  status?: unknown;
}): Partial<TrackedEmailSummary> {
  const patch: Partial<TrackedEmailSummary> = {};
  const thread = message.gmailThreadId ?? message.gmail_thread_id;
  const gmailMessage = message.gmailMessageId ?? message.gmail_message_id;
  const sent = message.sentAt ?? message.sent_at;
  if (typeof thread === 'string' || thread === null) patch.gmailThreadId = thread;
  if (typeof gmailMessage === 'string' || gmailMessage === null) patch.gmailMessageId = gmailMessage;
  if (typeof sent === 'string' || sent === null) patch.sentAt = sent;
  if (typeof message.subject === 'string') patch.subject = message.subject;
  if (typeof message.sender === 'string') patch.sender = message.sender;
  if (Array.isArray(message.recipients)) {
    patch.recipients = message.recipients.filter((item): item is string => typeof item === 'string');
  }
  if (message.status === 'PENDING' || message.status === 'SENT' || message.status === 'CANCELLED' || message.status === 'FAILED') {
    patch.status = message.status;
  }
  return patch;
}

export { formatSentTrackingBadge };
