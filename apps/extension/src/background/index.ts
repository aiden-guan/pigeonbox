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
  applyRecentOpens,
  deriveTrackingTimeline,
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
  type TrackingDiagnosticsReport,
  type TrackingPixelEventDiagnostic,
  type TrackingSelfViewDiagnostic,
  type TrackingSendReport,
} from '@pigeonbox/tracking';
import { refreshGmailTabsAfterRestart } from '../reload-extension';
import { patchTrackedEmail, readTrackedEmails, upsertTrackedEmail, writeTrackedEmails } from './tracked-mail';
import { answerAskInbox, type AskDraft } from './ask-inbox';
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
} from './chatgpt-login';
import { completeOnDevice, downloadOnDevice, warmOnDevice } from './on-device';
import { effectiveSettings, resolveIntelligence } from './intelligence';
import { clearCloudState, cloudSession, cloudTrackerTarget, getCloudClient, readCloudState, refreshCloudState } from './cloud';
import { cloudIntelAvailable, forgetThreadIntel, NOTIFICATION_ALARM, pageCall, pollNotifications, threadIntel } from './cloud-intel';
import { broadcastToGmailTabs, hardenExtensionStorage, isExtensionPageSender, senderMaySend } from './messaging';
import { checkLatestRelease, chromeManagesUpdates, configureReleaseCheckAlarm, readReleaseUpdateStatus, RELEASE_CHECK_ALARM } from './release-updates';
import { EXPERIMENTAL_FEATURES, cloudApiUrl, cloudTrackerUrl } from '../config';
import { TrackingNotificationHistory } from './tracking-notifications';

const db = getMailboxDb();
const queue = new AIJobQueue();
const ingestor = new MailboxIngestor(db);
const lexical = new LexicalSearchIndex();
let settings: ExtensionSettings = { ...DEFAULT_SETTINGS };
let agent: AgentLoop | null = null;
let indexRunner: IndexJobRunner | null = null;
const notificationHistory = new TrackingNotificationHistory(chrome.storage.local);
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
  return { ...view, trackerBaseUrl: tracker ?? '', hasPersonalApiToken: Boolean(tracker && user) };
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
  const client = await cloudIntelClient().catch(() => null);
  if (!client) return;
  await client.call('preferencesUpdate', { preferences: { voice: settings.voiceProfile } }).catch(() => undefined);
}

function getAI() {
  return resolveIntelligence(settings, {
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
        const res = (await workerTabs.runExclusive((tabId) =>
          sendToTab(tabId, {
            type: 'PERFORM_ACTION',
            context: 'background',
            action: { kind: 'ARCHIVE_THREAD', threadId },
          }),
        )) as { success?: boolean; verified?: boolean; error?: string; reason?: string };
        const verified = Boolean(res?.success && res.verified);
        return { success: verified, error: verified ? undefined : res?.reason || res?.error || 'Archive was not confirmed' };
      } catch (error) {
        return { success: false, error: String(error) };
      }
    },
    insertDraftViaGmail: async (threadId, body) => {
      try {
        const res = (await workerTabs.runExclusive((tabId) =>
          sendToTab(tabId, {
            type: 'PERFORM_ACTION',
            context: 'background',
            action: { kind: 'CREATE_REPLY_DRAFT', threadId },
            insertText: body,
          }),
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

async function handleAskInbox(query: string) {
  const [coverage, threads, messages, searchDocuments, tracked, owner, ownerAliases] = await Promise.all([
    ingestor.getCoverage(),
    db.threads.toArray(),
    db.messages.toArray(),
    db.search_documents.toArray(),
    readTrackedEmails(),
    readMailboxOwner(),
    readOwnerAddresses(),
  ]);
  await rebuildSearchIndex(searchDocuments);
  const ai = effectiveSettings(settings).aiMode === 'disabled' ? null : getAI();
  try {
    return await answerAskInbox({
      query,
      threads,
      messages,
      searchDocuments,
      lexical,
      owner,
      ownerAliases,
      tracked,
      coverage,
      answerWithModel: ai ? async (input) => (await ai.answerMailboxQuery(input)).result : null,
    });
  } catch (error) {
    return { error: error instanceof Error ? error.message : String(error), coverageNote: formatCoverageWarning(coverage) };
  }
}

/**
 * Opens an Ask Inbox draft in the user's Gmail tab (not the pinned worker tab).
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
  await chrome.tabs.create({ url: `https://mail.google.com/mail/?${params.toString()}`, active: true, windowId: tab.windowId });
  return { opened: true, reason: res?.reason };
}

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
    : { baseUrl: settings.trackerBaseUrl, token: settings.personalApiToken };
  if (!settings.trackingEnabled) tracking = 'disabled';
  else if (probeTarget && (probeTarget.baseUrl || probeTarget.token)) {
    trackingProbe = await probeTrackerWithPermission(probeTarget.baseUrl, probeTarget.token);
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

async function openSidePanel(mode: 'inbox' | 'ask' | 'cloud', splitCategory?: string): Promise<void> {
  const stored = await chrome.storage.session.get('panelState');
  const current = (stored.panelState || {}) as { mode?: string; splitCategory?: string };
  await chrome.storage.session.set({
    panelState: {
      mode,
      splitCategory: splitCategory || current.splitCategory || 'RESPOND',
    },
  });
  const [tab] = await chrome.tabs.query({ active: true, currentWindow: true });
  if (tab?.windowId != null) await chrome.sidePanel.open({ windowId: tab.windowId });
}

async function classifyIngested(thread: IngestThread, fingerprint: string, quality: IngestThread['quality'], direction: string): Promise<void> {
  if (!agent) return;
  const latest = thread.messages?.[thread.messages.length - 1];
  // The folder a thread was opened from says nothing about who wrote last. The newest message does.
  const [owner, aliases] = await Promise.all([readMailboxOwner(), readOwnerAddresses()]);
  const isOwner = createOwnerMatcher({ owner, aliases, contacts: (thread.messages || []).map((message) => message.sender) });
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
    messages: (thread.messages || []).map((message) => ({
      sender: message.sender.email,
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

async function trackerTarget(): Promise<{ baseUrl: string; token: string } | null> {
  if (settings.runMode === 'cloud') return cloudTrackerTarget(settings);
  if (!settings.trackerBaseUrl || !settings.personalApiToken) return null;
  return { baseUrl: settings.trackerBaseUrl, token: settings.personalApiToken };
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

async function pollTracking(): Promise<void> {
  if (!trackingPollInFlight) {
    trackingPollInFlight = pollTrackingNow().finally(() => {
      trackingPollInFlight = null;
    });
  }
  return trackingPollInFlight;
}

async function pollTrackingNow(): Promise<void> {
  if (!settings.trackingEnabled) return;
  const target = await trackerTarget();
  if (!target) return;
  const client = new TrackingClient(target.baseUrl, target.token);
  const local = await readTrackedEmails();
  const byId = new Map(local.map((email) => [email.trackingId, email]));
  let sawRemote = false;
  try {
    const remote = await client.listEmails(200);
    for (const row of remote) {
      byId.set(row.tracking_id, summaryFromRemote(row, byId.get(row.tracking_id) || null));
    }
    sawRemote = true;
  } catch (e) {
    console.warn('[gi] tracking list failed', e);
    await Promise.all(
      local.slice(0, 40).map(async (email) => {
        try {
          const row = await client.getEmail(email.trackingId);
          byId.set(row.tracking_id, summaryFromRemote(row, email));
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
    newEvents = await notificationHistory.claim(await notificationScope(target.baseUrl), events);
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
    console.warn('[gi] tracking poll failed', e);
  }
  // The list endpoint only returns the 200 newest sent emails. An older email
  // can still have a new open, so look up its details before composing the alert.
  const missingIds = [...new Set(newEvents.filter(isNotifiableTrackingEvent).map((event) => event.tracking_id))]
    .filter((id) => !byId.has(id));
  await Promise.all(missingIds.map(async (id) => {
    try {
      const row = await client.getEmail(id);
      byId.set(id, summaryFromRemote(row));
    } catch {
      /* The event can still be shown with a generic subject. */
    }
  }));
  if (sawRemote || local.length || missingIds.length) await writeTrackedEmails([...byId.values()]);
  try {
    const fresh = [...byId.values()];
    for (const ev of newEvents) {
      if (!isNotifiableTrackingEvent(ev)) continue;
      if (settings.hideSuspectedSelfOpens && ev.suspected_self_open) continue;
      if (!settings.desktopNotifications) continue;
      const email = fresh.find((item) => item.trackingId === ev.tracking_id);
      const who = email?.recipients.length === 1 ? email.recipients[0] : 'Someone';
      const subject = email?.subject || 'your email';
      void Promise.resolve(chrome.notifications.create(ev.id, {
        type: 'basic',
        iconUrl: chrome.runtime.getURL('icons/icon128.png'),
        title: ev.type === 'OPEN' ? 'Open detected' : 'Link click detected',
        message:
          ev.type === 'OPEN'
            ? `${who} opened “${subject}”`
            : `${who} clicked a link in “${subject}”`,
      })).catch(() => undefined);
    }
  } catch (e) {
    console.warn('[gi] tracking poll failed', e);
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

chrome.runtime.onMessage.addListener((message, sender, sendResponse) => {
  if (
    message?.type === 'LOCAL_MODEL_PROGRESS' ||
    message?.type === 'LOCAL_MODEL_RELEASE' ||
    message?.type === 'ON_DEVICE_PING' ||
    message?.type === 'ON_DEVICE_PROMPT' ||
    message?.type === 'ON_DEVICE_WARM' ||
    message?.type === 'ON_DEVICE_DOWNLOAD'
  ) return false;
  if (!senderMaySend(sender, message?.type)) {
    sendResponse({ ok: false, error: 'forbidden', reason: 'This request is only accepted from PigeonBox pages.' });
    return false;
  }
  void (async () => {
    try {
    await loadSettings();
    if (!agent) rebuildAgent();

    const cloudResponse = await handleCloudIntelMessage(message, sender);
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
        const results = [];
        for (const thread of threads || []) {
          if (!thread?.threadId) continue;
          const result = await ingestor.ingestThread(thread);
          results.push(result);
          if (result.changed) await classifyIngested(thread, result.fingerprint, result.quality, direction);
        }
        sendResponse({ ok: true, results });
        return;
      }
      if (message?.type === 'REPORT_RUNTIME') {
        await chrome.storage.session.set({ gmailRuntime: message.runtime });
        const owner = mailboxOwnerFrom(message.owner);
        if (owner) await rememberMailboxOwner(owner);
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
          const summary = await db.thread_summaries.get(thread.threadId);
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
        const input = {
          threadId,
          fingerprint: snapshot.fingerprint || thread?.contentFingerprint || `page:${threadId}`,
          subject: snapshot.subject,
          messages: snapshot.messages.map((m) => ({
            sender: message.type === 'REQUEST_DRAFT' ? withSenderName(m.sender, senderNames) : m.sender,
            bodyText: m.bodyText,
            timestamp: m.timestamp,
          })),
          owner: mailboxOwnerFrom(message.owner),
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
            oneLine = summary?.summary?.oneLine;
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
        const input = {
          threadId,
          fingerprint: snapshot.fingerprint || thread?.contentFingerprint || `page:${threadId}`,
          subject: snapshot.subject,
          messages: snapshot.messages.map((m) => ({
            sender: message.type === 'DRAFT_REPLY' ? withSenderName(m.sender, senderNames) : m.sender,
            bodyText: m.bodyText,
            timestamp: m.timestamp,
          })),
          owner: mailboxOwnerFrom(message.owner),
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
          const client = new TrackingClient(target.baseUrl, target.token);
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
            ),
          );
          sendResponse({ ok: true, ...created });
        } catch (e) {
          sendResponse({ error: String(e) });
        }
        return;
      }
      if (message?.type === 'MARK_TRACKED_SENT' || message?.type === 'SYNC_TRACKED_LINKS' || message?.type === 'CANCEL_TRACKED_EMAIL') {
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
        const target = await trackerTarget();
        if (target) {
          try {
            const client = new TrackingClient(target.baseUrl, target.token);
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
          } catch (e) {
            console.warn('[gi] tracking update failed', e);
          }
        }
        sendResponse({ ok: true, emails: await readTrackedEmails() });
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
          sendResponse(target ? await probeTrackerWithPermission(target.baseUrl, target.token) : { status: 'missing', label: trackerHealthLabel('missing') });
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
        const target = gmailThreadId || gmailMessageId ? await trackerTarget() : null;
        if (target) {
          try {
            const client = new TrackingClient(target.baseUrl, target.token);
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
      if (message?.type === 'GET_TRACKED_EMAILS') {
        sendResponse({ emails: await readTrackedEmails() });
        return;
      }
      if (message?.type === 'GET_TRACKING_TIMELINE') {
        // Every counted open and click for one email, for the side panel's Waiting view.
        const trackingId = String(message.trackingId || '');
        const target = trackingId && settings.trackingEnabled ? await trackerTarget() : null;
        if (!target) {
          sendResponse({ error: trackingId ? 'Tracking is not set up.' : 'missing_tracking_id' });
          return;
        }
        try {
          const events = await new TrackingClient(target.baseUrl, target.token).getEvents(trackingId);
          sendResponse({ timeline: deriveTrackingTimeline(events) });
        } catch (error) {
          sendResponse({ error: error instanceof Error ? error.message : String(error) });
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
          await openSidePanel(message.mode === 'inbox' ? 'inbox' : message.mode === 'cloud' ? 'cloud' : 'ask', message.category);
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
          const currentFingerprint = summary?.fingerprint?.replace(/:sum\d+$/, '') || threadRow?.contentFingerprint;
          const matchingDraft = currentFingerprint
            ? drafts.find((d) => d.fingerprint === currentFingerprint) || null
            : drafts.sort((a, b) => b.createdAt - a.createdAt)[0] || null;
          intel[threadId] = { classification, summary, draft: matchingDraft, manual: Boolean(override) };
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
        const { parseNaturalLanguageRule } = await import('@pigeonbox/agent');
        const lines = (message.lines || []) as string[];
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
        sendResponse(await handleAskInbox(msg.query));
        break;
      case 'OPEN_COMPOSE_DRAFT':
        sendResponse(await openComposeDraft(msg.draft));
        break;
      case 'INDEX_INBOX': {
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
        const cp = await indexRunner.run({
          mode: msg.mode,
          customQuery: msg.customQuery,
        });
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
        sendResponse({ checkpoint: cp });
        break;
      }
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
        const target = msg.trackingId ? await trackerTarget() : null;
        if (!target) {
          sendResponse({
            ok: false,
            recorded: false,
            error: 'Tracking is not configured or tracking ID is missing',
          });
          break;
        }

        const client = new TrackingClient(target.baseUrl, target.token);
        const normMessageId = normalizeGmailId(msg.gmailMessageId);
        const normThreadId = normalizeGmailId(msg.gmailThreadId);
        const source = msg.source || 'MESSAGE_EXPANDED';
        const timestamp = msg.timestamp || new Date().toISOString();
        const selfViewEventId =
          msg.selfViewEventId ||
          `sv_${msg.trackingId}_${normMessageId || 'nomessage'}_${source}_${Date.parse(timestamp) || Date.now()}`;

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
            });
            lastErr = null;
            break;
          } catch (err) {
            lastErr = err;
            const errStr = err instanceof Error ? err.message : String(err ?? '');
            if (errStr.includes('401') || errStr.includes('404')) {
              break;
            }
          }
        }

        if (result && result.ok) {
          await pollTracking();
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

/** The Cloud web app (served by the Cloud API's origin), for a section such as "approvals". */
function cloudWebUrl(section = 'overview'): string | null {
  const base = cloudApiUrl(settings);
  return base ? `${new URL(base).origin}/app#${/^[a-z]{2,20}$/.test(section) ? section : 'overview'}` : null;
}

async function cloudIntelClient() {
  const client = getCloudClient(settings);
  if (!client) return null;
  const state = await readCloudState(settings);
  return cloudIntelAvailable(state, settings.runMode) ? client : null;
}

/**
 * PigeonBox Cloud intelligence messages. Content scripts may only send
 * CLOUD_THREAD_INTEL (read-only); the rest need an extension page (enforced by
 * `senderMaySend`). Returns undefined for any other message.
 */
async function handleCloudIntelMessage(message: { type?: unknown; [key: string]: unknown }, sender: chrome.runtime.MessageSender): Promise<unknown> {
  switch (message?.type) {
    case 'CLOUD_THREAD_INTEL': {
      const client = await cloudIntelClient();
      if (!client) return { ok: true, available: false, threads: {} };
      const ids = Array.isArray(message.threadIds) ? message.threadIds.filter((id): id is string => typeof id === 'string') : [];
      const mailbox = typeof message.mailbox === 'string' && EMAIL_PATTERN.test(message.mailbox) ? message.mailbox : undefined;
      try {
        return { ok: true, available: true, threads: await threadIntel(client, ids, mailbox) };
      } catch (error) {
        return { ok: false, available: true, threads: {}, reason: cloudErrorMessage(error).message };
      }
    }
    case 'CLOUD_INTEL_STATE': {
      const state = await readCloudState(settings);
      return { ok: true, available: cloudIntelAvailable(state, settings.runMode), capabilities: state.capabilities, webUrl: cloudWebUrl() };
    }
    case 'CLOUD_CALL': {
      if (!isExtensionPageSender(sender)) return { ok: false, code: 'forbidden', reason: 'This request is only accepted from PigeonBox pages.' };
      const client = await cloudIntelClient();
      if (!client) return { ok: false, code: 'not_configured', reason: 'Turn on PigeonBox Cloud and connect Google to use this.' };
      return pageCall(client, message.route, message.body);
    }
    case 'CLOUD_OPEN': {
      if (!isExtensionPageSender(sender)) return { ok: false, code: 'forbidden' };
      const url = cloudWebUrl(typeof message.section === 'string' ? message.section : 'overview');
      if (!url) return { ok: false, reason: 'PigeonBox Cloud is not available in this build.' };
      await chrome.tabs.create({ url });
      return { ok: true };
    }
    default:
      return undefined;
  }
}

async function pollCloudNotifications(): Promise<void> {
  const client = await cloudIntelClient().catch(() => null);
  if (!client) return;
  await pollNotifications(client, chrome.storage.local, (id, _kind, title, body) => {
    void Promise.resolve(chrome.notifications.create(id, { type: 'basic', iconUrl: chrome.runtime.getURL('icons/icon128.png'), title, message: body })).catch(() => undefined);
  }).catch(() => undefined);
}

chrome.notifications.onClicked.addListener((id) => {
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
      await publishContentSettings();
      rebuildAgent();
      return { ok: true, state: await productState() };
    }
    case 'CLOUD_SIGN_IN': {
      const base = cloudApiUrl(settings);
      if (!base) return { ok: false, reason: 'PigeonBox Cloud is not available in this build.' };
      try {
        const user = await cloudSession.signIn(base);
        await refreshCloudState(settings);
        void syncVoiceToCloud();
        await publishContentSettings();
        rebuildAgent();
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

const EMAIL_PATTERN = /^[^\s@<>]+@[^\s@<>]+\.[^\s@<>]+$/;

/** The Gmail account the content script read from the page, if any. */
function mailboxOwnerFrom(value: unknown): { email: string; name?: string } | undefined {
  if (!value || typeof value !== 'object') return undefined;
  const { email, name } = value as { email?: unknown; name?: unknown };
  if (typeof email !== 'string' || !EMAIL_PATTERN.test(email)) return undefined;
  const cleanName = typeof name === 'string' ? name.trim().slice(0, 80) : '';
  return { email: email.trim().toLowerCase(), name: cleanName || undefined };
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
