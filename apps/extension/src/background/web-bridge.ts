/**
 * The PigeonBox dashboard (usepigeonbox.com/dashboard) is where people change
 * settings. It reaches this worker through `externally_connectable`, so only
 * the origins listed in the manifest can send these messages at all, and the
 * worker checks the sender's origin again here.
 *
 * What the page can and cannot do:
 * - It reads settings without secrets: API keys and tracker tokens come back
 *   as "set / not set" only. It may replace or clear them.
 * - It cannot change the Cloud API, the settings version or consent records
 *   directly; Cloud mode needs an explicit `consent: true` from a click.
 * - It never sees Cloud tokens. Linking this browser to Cloud uses PKCE: the
 *   worker keeps the verifier and the page only carries the code.
 * - Host permissions are never granted from here. The worker opens its own
 *   small page where the person clicks Allow.
 */
import { createPkcePair, randomUrlToken } from '@pigeonbox/cloud-client';
import { getProviderRequiredOrigin, toPublicSettings, type ExtensionSettings } from '@pigeonbox/shared';
import { trackerPermissionOrigin } from '@pigeonbox/tracking';

/** Origins the published dashboard runs on. Development builds also accept loopback (see the manifest transform). */
export const DASHBOARD_ORIGINS: readonly string[] = ['https://usepigeonbox.com', 'https://www.usepigeonbox.com'];

/** Settings the dashboard may change. Run mode, consent, the Cloud API and the version have their own paths or none. */
const EDITABLE: ReadonlySet<keyof ExtensionSettings> = new Set<keyof ExtensionSettings>([
  'trackingEnabled',
  'trackOpens',
  'trackLinks',
  'desktopNotifications',
  'hideSuspectedSelfOpens',
  'trackerBaseUrl',
  'personalApiToken',
  'aiMode',
  'aiProvider',
  'aiModel',
  'aiEndpoint',
  'aiApiKey',
  'autoClassify',
  'autoSummarize',
  'autoDraft',
  'autoInsertDraft',
  'autoReminders',
  'autoArchive',
  'archiveCategories',
  'archiveConfidenceThreshold',
  'alwaysArchiveSenders',
  'neverArchiveSenders',
  'reminderMode',
  'reminderBusinessDays',
  'commandPaletteEnabled',
  'commandPaletteOverrideGmail',
  'voiceProfile',
  'learnFromSent',
]);

const ACTIONS = new Set(['clear_index', 'index_inbox', 'pause_index', 'reset_workspace', 'diagnostics', 'open_ai_setup', 'open_gmail', 'clear_ai_cache']);
const LINK_KEY = 'cloudLink';
const LINK_TTL_MS = 15 * 60_000;

type PendingLink = { state: string; verifier: string; redirectUri: string; apiBaseUrl: string; createdAt: number };

export type WebBridgeDeps = {
  extensionId: string;
  version: string;
  /** True when Chrome updates this install from the Web Store. */
  storeInstall: () => Promise<boolean>;
  allowLoopback: boolean;
  settings: () => ExtensionSettings;
  saveSettings: (partial: Partial<ExtensionSettings>) => Promise<ExtensionSettings>;
  productState: () => Promise<Record<string, unknown> & { runMode: string }>;
  /** The product message handler shared with extension pages (SET_RUN_MODE, CLOUD_REFRESH, CLOUD_SIGN_OUT). */
  productMessage: (message: Record<string, unknown>) => Promise<unknown>;
  apiBaseUrl: () => string | null;
  exchangeLinkedCode: (apiBaseUrl: string, input: { code: string; codeVerifier: string; redirectUri: string }) => Promise<{ id: string; email: string | null }>;
  afterSignIn: () => Promise<void>;
  agentRules: () => Promise<string[]>;
  saveAgentRules: (lines: string[]) => Promise<void>;
  action: (name: string) => Promise<unknown>;
  /** Content-free product counters kept on this computer (off by default). */
  analytics: { get: () => Promise<boolean>; set: (enabled: boolean) => Promise<void> };
  hasOrigins: (origins: string[]) => Promise<boolean>;
  /** The tab showing the dashboard, so Settings reuses it; null when the page goes away. */
  noteDashboardTab: (tabId: number | null) => Promise<void>;
  openGrant: (origins: string[]) => Promise<void>;
  session: { get(key: string): Promise<Record<string, unknown>>; set(items: Record<string, unknown>): Promise<void>; remove(key: string): Promise<void> };
  now?: () => number;
};

type Sender = { origin?: string; url?: string; tab?: { id?: number } };

function senderOrigin(sender: Sender): string | null {
  try {
    return sender.origin ?? (sender.url ? new URL(sender.url).origin : null);
  } catch {
    return null;
  }
}

function isLoopback(origin: string): boolean {
  try {
    const url = new URL(origin);
    return url.protocol === 'http:' && ['127.0.0.1', 'localhost'].includes(url.hostname);
  } catch {
    return false;
  }
}

/** Whether `sender` is the PigeonBox dashboard. The Cloud API's own copy of the dashboard counts too. */
export function isDashboardSender(sender: Sender, deps: Pick<WebBridgeDeps, 'allowLoopback' | 'apiBaseUrl'>): boolean {
  const origin = senderOrigin(sender);
  if (!origin) return false;
  if (DASHBOARD_ORIGINS.includes(origin)) return true;
  if (deps.allowLoopback && isLoopback(origin)) return true;
  const api = deps.apiBaseUrl();
  return Boolean(api && new URL(api).origin === origin);
}

/** Host permissions the given settings need in Local mode (the tracker and the AI provider). */
export function originsFor(settings: ExtensionSettings): string[] {
  const tracker = settings.trackingEnabled ? trackerPermissionOrigin(settings.trackerBaseUrl) : null;
  const ai = settings.aiMode !== 'disabled' ? getProviderRequiredOrigin(settings.aiProvider, settings.aiEndpoint) : null;
  return [...new Set([tracker, ai].filter((origin): origin is string => Boolean(origin)))];
}

const ORIGIN_PATTERN = /^(https:\/\/[a-z0-9.-]+(:\d+)?|http:\/\/(127\.0\.0\.1|localhost)(:\d+)?)\/\*$/i;

/** Only keys the dashboard may edit, with basic type checks. Secrets are taken only when sent as strings. */
export function editablePatch(input: unknown): Partial<ExtensionSettings> {
  if (!input || typeof input !== 'object') return {};
  const patch: Record<string, unknown> = {};
  for (const [key, value] of Object.entries(input as Record<string, unknown>)) {
    if (!EDITABLE.has(key as keyof ExtensionSettings) || value === undefined) continue;
    if ((key === 'aiApiKey' || key === 'personalApiToken' || key === 'trackerBaseUrl' || key === 'aiEndpoint' || key === 'aiModel') && typeof value !== 'string') continue;
    if (typeof value === 'string' && value.length > 4000) continue;
    patch[key] = value;
  }
  return patch as Partial<ExtensionSettings>;
}

/** The settings view for the dashboard: no secrets, no developer override. */
function dashboardSettings(settings: ExtensionSettings) {
  return Object.fromEntries(Object.entries(toPublicSettings(settings)).filter(([key]) => key !== 'cloudApiUrl' && key !== 'settingsVersion'));
}

/** Handle one message from the dashboard. Always resolves to a JSON-safe reply. */
export async function handleWebMessage(message: unknown, sender: Sender, deps: WebBridgeDeps): Promise<unknown> {
  if (!isDashboardSender(sender, deps)) return { ok: false, code: 'forbidden', reason: 'This page cannot talk to PigeonBox.' };
  const msg = (message && typeof message === 'object' ? message : {}) as Record<string, unknown>;
  const now = deps.now?.() ?? Date.now();

  switch (msg.type) {
    case 'HELLO': {
      if (typeof sender.tab?.id === 'number') await deps.noteDashboardTab(sender.tab.id);
      return {
        ok: true,
        extensionId: deps.extensionId,
        version: deps.version,
        storeInstall: await deps.storeInstall(),
        apiBaseUrl: deps.apiBaseUrl(),
        product: await deps.productState(),
      };
    }
    case 'BYE':
      if (typeof sender.tab?.id === 'number') await deps.noteDashboardTab(null);
      return { ok: true };
    case 'GET_SETTINGS': {
      const settings = deps.settings();
      const origins = settings.runMode === 'local' ? originsFor(settings) : [];
      return {
        ok: true,
        settings: dashboardSettings(settings),
        rules: await deps.agentRules().catch(() => []),
        analytics: await deps.analytics.get().catch(() => false),
        missingOrigins: origins.length && !(await deps.hasOrigins(origins)) ? origins : [],
        product: await deps.productState(),
      };
    }
    case 'SAVE_SETTINGS': {
      const patch = editablePatch(msg.settings);
      if (!Object.keys(patch).length) return { ok: false, reason: 'Nothing to save.' };
      const saved = await deps.saveSettings(patch);
      const origins = deps.settings().runMode === 'local' ? originsFor(saved) : [];
      return {
        ok: true,
        settings: dashboardSettings(saved),
        missingOrigins: origins.length && !(await deps.hasOrigins(origins)) ? origins : [],
      };
    }
    case 'SAVE_RULES': {
      const lines = Array.isArray(msg.lines) ? msg.lines.filter((line): line is string => typeof line === 'string').map((line) => line.trim().slice(0, 500)).filter(Boolean).slice(0, 100) : [];
      await deps.saveAgentRules(lines);
      return { ok: true, rules: await deps.agentRules().catch(() => lines) };
    }
    case 'SET_ANALYTICS':
      await deps.analytics.set(msg.enabled === true);
      return { ok: true, analytics: msg.enabled === true };
    case 'GRANT': {
      const origins = Array.isArray(msg.origins) ? msg.origins.filter((origin): origin is string => typeof origin === 'string' && ORIGIN_PATTERN.test(origin)).slice(0, 4) : [];
      if (!origins.length) return { ok: false, reason: 'Nothing to allow.' };
      if (await deps.hasOrigins(origins)) return { ok: true, granted: true };
      await deps.openGrant(origins);
      return { ok: true, granted: false };
    }
    case 'CHECK_ORIGINS': {
      const origins = Array.isArray(msg.origins) ? msg.origins.filter((origin): origin is string => typeof origin === 'string' && ORIGIN_PATTERN.test(origin)).slice(0, 4) : [];
      return { ok: true, granted: origins.length ? await deps.hasOrigins(origins) : true };
    }
    case 'SET_RUN_MODE': {
      if (msg.mode === 'cloud') return deps.productMessage({ type: 'SET_RUN_MODE', mode: 'cloud', consent: msg.consent === true });
      if (msg.mode === 'local') return deps.productMessage({ type: 'SET_RUN_MODE', mode: 'local' });
      return { ok: false, reason: 'Unknown mode.' };
    }
    case 'REFRESH':
      return deps.productMessage({ type: 'CLOUD_REFRESH' });
    case 'SIGN_OUT':
      return deps.productMessage({ type: 'CLOUD_SIGN_OUT' });
    case 'LINK_BEGIN': {
      const apiBaseUrl = deps.apiBaseUrl();
      if (!apiBaseUrl) return { ok: false, code: 'not_configured', reason: 'This version of PigeonBox does not include Cloud. Update PigeonBox to use Cloud.' };
      const origin = senderOrigin(sender);
      let redirectUri: URL;
      try {
        redirectUri = new URL(String(msg.redirectUri));
      } catch {
        return { ok: false, reason: 'The sign-in return address is invalid.' };
      }
      // The code must come back to the page that asked, and nowhere else.
      if (redirectUri.origin !== origin || redirectUri.pathname !== '/dashboard' || redirectUri.search || redirectUri.hash) {
        return { ok: false, reason: 'The sign-in return address is invalid.' };
      }
      const { verifier, challenge } = await createPkcePair();
      const state = randomUrlToken(24);
      const pending: PendingLink = { state, verifier, redirectUri: redirectUri.href, apiBaseUrl, createdAt: now };
      await deps.session.set({ [LINK_KEY]: pending });
      return { ok: true, codeChallenge: challenge, state, apiBaseUrl };
    }
    case 'LINK_COMPLETE': {
      const pending = (await deps.session.get(LINK_KEY))[LINK_KEY] as PendingLink | undefined;
      const fresh = pending && now - pending.createdAt < LINK_TTL_MS;
      if (!pending || !fresh || typeof msg.state !== 'string' || msg.state !== pending.state || typeof msg.code !== 'string' || !msg.code) {
        return { ok: false, reason: 'Connecting PigeonBox could not be verified. Start again.' };
      }
      await deps.session.remove(LINK_KEY);
      if (deps.apiBaseUrl() !== pending.apiBaseUrl) return { ok: false, reason: 'PigeonBox changed Cloud servers while connecting. Start again.' };
      try {
        const user = await deps.exchangeLinkedCode(pending.apiBaseUrl, { code: msg.code.slice(0, 2000), codeVerifier: pending.verifier, redirectUri: pending.redirectUri });
        await deps.afterSignIn();
        return { ok: true, user, product: await deps.productState() };
      } catch (error) {
        return { ok: false, reason: error instanceof Error ? error.message : 'Connecting PigeonBox failed. Try again.' };
      }
    }
    case 'ACTION': {
      const name = String(msg.action);
      if (!ACTIONS.has(name)) return { ok: false, reason: 'Unknown action.' };
      return { ok: true, result: await deps.action(name) };
    }
    default:
      return { ok: false, reason: 'Unknown request.' };
  }
}
