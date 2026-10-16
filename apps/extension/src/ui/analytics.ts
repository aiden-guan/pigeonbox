/**
 * Content-free adoption events. On by default with disclosure (onboarding and Settings → Privacy & data);
 * turning it off stops sending and clears the counters and install ID. Telemetry cannot affect core behavior.
 * Keep in step with EXTENSION_EVENTS in pigeonbox-cloud packages/server/src/product-analytics.ts.
 */
export const PRODUCT_EVENTS = [
  'extension_installed',
  'extension_active',
  'onboarding_started',
  'onboarding_completed',
  'local_selected',
  'cloud_preview_opened',
  'cloud_selected',
  'cloud_signin_started',
  'cloud_signin_completed',
  'google_connection_started',
  'google_connection_completed',
  'first_cloud_sync_completed',
  'first_cloud_overview_viewed',
  'first_prepared_draft_seen',
  'prepared_draft_used',
  'first_briefing_viewed',
  'first_approval_decided',
  'first_tracked_email_created',
  'first_open_received',
  'smart_view_created',
  'automation_created',
  'automation_activated',
  'command_palette_opened',
  'ask_pigeon_used',
  'tracked_document_created',
  'settings_opened',
  'footer_added',
  'footer_removed',
  'footer_sent',
  'snippet_used',
  'send_later_opened',
  'remind_on_send',
  'keyboard_shortcut_used',
  'hosted_tracking_signin',
  'upgrade_clicked',
] as const;
export type ProductEvent = (typeof PRODUCT_EVENTS)[number];
type SafeMetadata = {
  surface?: 'workspace' | 'sidepanel' | 'gmail' | 'onboarding' | 'settings';
  mode?: 'local' | 'cloud';
  outcome?: 'success' | 'failure' | 'denied';
  latency?: 'fast' | 'normal' | 'slow';
  capabilityPresent?: boolean;
  source?: 'workspace_header' | 'command_palette';
};
export type Payload = { event: ProductEvent; metadata: SafeMetadata; version: string };
type Provider = (payload: Payload) => void | Promise<void>;
let provider: Provider | undefined;
let recording = Promise.resolve();
export function configureAnalytics(next?: Provider) {
  provider = next;
}
const VALUES = {
  surface: ['workspace', 'sidepanel', 'gmail', 'onboarding', 'settings'],
  mode: ['local', 'cloud'],
  outcome: ['success', 'failure', 'denied'],
  latency: ['fast', 'normal', 'slow'],
  source: ['workspace_header', 'command_palette'],
} as const;
export function analyticsPayload(event: string, metadata: Record<string, unknown> = {}, version = ''): Payload | null {
  if (!(PRODUCT_EVENTS as readonly string[]).includes(event)) return null;
  const safe: Record<string, string | boolean> = {};
  for (const [key, values] of Object.entries(VALUES))
    if (typeof metadata[key] === 'string' && (values as readonly string[]).includes(metadata[key] as string))
      safe[key] = metadata[key] as string;
  if (typeof metadata.capabilityPresent === 'boolean') safe.capabilityPresent = metadata.capabilityPresent;
  return { event: event as ProductEvent, metadata: safe, version: /^\d+\.\d+\.\d+$/.test(version) ? version : '' };
}
export function trackProductEvent(event: ProductEvent, metadata: SafeMetadata = {}) {
  const payload = analyticsPayload(
    event,
    metadata,
    typeof chrome !== 'undefined' ? chrome.runtime?.getManifest?.().version : '',
  );
  if (!payload) return;
  try {
    if (typeof chrome !== 'undefined' && chrome.runtime?.sendMessage)
      void Promise.resolve(
        chrome.runtime.sendMessage({ type: 'PRODUCT_EVENT', event: payload.event, metadata: payload.metadata }),
      ).catch(() => undefined);
    else if (provider) void Promise.resolve(provider(payload)).catch(() => undefined);
  } catch {
    /* Optional measurement must never block a user action. */
  }
}
/** Collection is on unless the person turned it off (`productAnalyticsEnabled: false`). */
export function analyticsEnabled(stored: Record<string, unknown>): boolean {
  return stored.productAnalyticsEnabled !== false;
}
const INSTALL_ID_KEY = 'productAnalyticsInstallId';
const ACTIVE_DAY_KEY = 'productAnalyticsActiveDay';
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/;
/** Storage keys that turning collection off removes. */
export const ANALYTICS_STORAGE_KEYS = ['productEventCounts', INSTALL_ID_KEY, ACTIVE_DAY_KEY];

/** A random per-install ID, unrelated to the Google or PigeonBox account. Regenerated after collection is turned off. */
let installId: Promise<string> | null = null;
export function analyticsInstallId(): Promise<string> {
  installId ??= (async () => {
    const stored = await chrome.storage.local.get(INSTALL_ID_KEY);
    const current = stored[INSTALL_ID_KEY];
    if (typeof current === 'string' && UUID.test(current)) return current;
    const id = crypto.randomUUID();
    await chrome.storage.local.set({ [INSTALL_ID_KEY]: id });
    return id;
  })();
  installId.catch(() => { installId = null; });
  return installId;
}

/** Turn collection on or off. Off stops sending and removes the counters, the install ID and the active-day marker. */
export async function setAnalyticsEnabled(enabled: boolean): Promise<void> {
  await chrome.storage.local.set({ productAnalyticsEnabled: enabled });
  if (!enabled) {
    installId = null;
    await chrome.storage.local.remove(ANALYTICS_STORAGE_KEYS);
  }
}

/**
 * The network provider: POSTs the already-sanitized payload plus the install ID to
 * PigeonBox Cloud's `/v1/events`, which forwards it to PostHog. The body is rebuilt
 * from fixed fields here, so nothing a caller adds can ride along.
 */
export function cloudEventsProvider(options: { baseUrl: () => string | null; installId?: () => Promise<string>; fetch?: typeof fetch }): Provider {
  return async (payload) => {
    const base = options.baseUrl();
    if (!base) return;
    const safe = analyticsPayload(payload.event, payload.metadata as Record<string, unknown>, payload.version);
    if (!safe) return;
    const installId = await (options.installId ?? analyticsInstallId)();
    if (!UUID.test(installId)) return;
    await (options.fetch ?? fetch)(`${base}/v1/events`, {
      method: 'POST',
      credentials: 'omit',
      cache: 'no-store',
      redirect: 'error',
      keepalive: true,
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ installId, event: safe.event, metadata: safe.metadata, version: safe.version }),
    });
  };
}

/** `extension_active` at most once per local day, for weekly actives and retention. */
export async function noteActiveDay(now = new Date()): Promise<void> {
  const day = `${now.getFullYear()}-${String(now.getMonth() + 1).padStart(2, '0')}-${String(now.getDate()).padStart(2, '0')}`;
  try {
    const stored = await chrome.storage.local.get(['productAnalyticsEnabled', ACTIVE_DAY_KEY]);
    if (!analyticsEnabled(stored) || stored[ACTIVE_DAY_KEY] === day) return;
    await chrome.storage.local.set({ [ACTIVE_DAY_KEY]: day });
    await recordProductEvent('extension_active', {});
  } catch {
    /* Optional. */
  }
}

/** Local counters and the configured provider. This worker-owned entry revalidates every caller and serializes updates. */
export function recordProductEvent(event: unknown, metadata: unknown): Promise<void> {
  const payload =
    typeof event === 'string'
      ? analyticsPayload(
          event,
          metadata && typeof metadata === 'object' ? (metadata as Record<string, unknown>) : {},
          chrome.runtime.getManifest().version,
        )
      : null;
  if (!payload) return Promise.resolve();
  recording = recording
    .then(async () => {
      const stored = await chrome.storage.local.get(['productAnalyticsEnabled', 'productEventCounts']);
      if (!analyticsEnabled(stored)) return;
      const counts = stored.productEventCounts as Partial<Record<ProductEvent, number>> | undefined;
      const clean: Partial<Record<ProductEvent, number>> = {};
      for (const key of PRODUCT_EVENTS)
        if (typeof counts?.[key] === 'number' && Number.isFinite(counts[key]))
          clean[key] = Math.max(0, Math.min(counts[key]!, 1e6));
      if (payload.event.startsWith('first_') && clean[payload.event]) return;
      clean[payload.event] = Math.min(1e6, (clean[payload.event] ?? 0) + 1);
      await chrome.storage.local.set({ productEventCounts: clean });
      // Sending never holds up the counter queue.
      if (provider) void Promise.resolve().then(() => provider?.(payload)).catch(() => undefined);
    })
    .catch(() => undefined);
  return recording;
}
