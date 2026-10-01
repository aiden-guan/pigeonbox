/** Content-free adoption events. No default network provider; telemetry cannot affect core behavior. */
export const PRODUCT_EVENTS = [
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
  'smart_view_created',
  'automation_created',
  'automation_activated',
  'command_palette_opened',
  'ask_pigeon_used',
  'tracked_document_created',
] as const;
export type ProductEvent = (typeof PRODUCT_EVENTS)[number];
type SafeMetadata = {
  surface?: 'popup' | 'sidepanel' | 'gmail' | 'onboarding' | 'settings';
  mode?: 'local' | 'cloud';
  outcome?: 'success' | 'failure' | 'denied';
  latency?: 'fast' | 'normal' | 'slow';
  capabilityPresent?: boolean;
};
type Payload = { event: ProductEvent; metadata: SafeMetadata; version: string };
type Provider = (payload: Payload) => void | Promise<void>;
let provider: Provider | undefined;
let recording = Promise.resolve();
export function configureAnalytics(next?: Provider) {
  provider = next;
}
const VALUES = {
  surface: ['popup', 'sidepanel', 'gmail', 'onboarding', 'settings'],
  mode: ['local', 'cloud'],
  outcome: ['success', 'failure', 'denied'],
  latency: ['fast', 'normal', 'slow'],
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
/** Opt-in local counters only. This worker-owned entry revalidates every caller and serializes updates. */
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
      if (stored.productAnalyticsEnabled !== true) return;
      const counts = stored.productEventCounts as Partial<Record<ProductEvent, number>> | undefined;
      const clean: Partial<Record<ProductEvent, number>> = {};
      for (const key of PRODUCT_EVENTS)
        if (typeof counts?.[key] === 'number' && Number.isFinite(counts[key]))
          clean[key] = Math.max(0, Math.min(counts[key]!, 1e6));
      if (payload.event.startsWith('first_') && clean[payload.event]) return;
      clean[payload.event] = Math.min(1e6, (clean[payload.event] ?? 0) + 1);
      await chrome.storage.local.set({ productEventCounts: clean });
      if (provider) await Promise.resolve(provider(payload)).catch(() => undefined);
    })
    .catch(() => undefined);
  return recording;
}
