import { normalizeBaseUrl } from '@pigeonbox/cloud-client';

/** Public build-time configuration. No secrets may be read here. */
export const BUILD_CLOUD_API_URL = normalizeBaseUrl(import.meta.env.VITE_PIGEONBOX_CLOUD_API_URL ?? '') ?? '';
export const BUILD_CLOUD_TRACKER_URL = normalizeBaseUrl(import.meta.env.VITE_PIGEONBOX_CLOUD_TRACKER_URL ?? '') ?? '';

/**
 * Experimental features (ChatGPT web sign-in) are on for source builds and off
 * for release builds, which set VITE_PIGEONBOX_EXPERIMENTAL=false.
 */
export const EXPERIMENTAL_FEATURES = import.meta.env.VITE_PIGEONBOX_EXPERIMENTAL !== 'false';

/**
 * Local `npm run dev:reload` helper that rebuilds dist/ before the popup's
 * "Reload extension" restarts the extension. Blank in release builds.
 */
export const DEV_REBUILD_URL = import.meta.env.VITE_PIGEONBOX_DEV_REBUILD_URL ?? '';

/** The Cloud API this install talks to: a developer override, else the build's URL. */
export function cloudApiUrl(settings: { cloudApiUrl: string }): string | null {
  return normalizeBaseUrl(settings.cloudApiUrl || '') ?? (BUILD_CLOUD_API_URL || null);
}

/**
 * The hosted tracker for Cloud mode. A developer API override on loopback
 * implies the matching local tracker port convention (API 8788, tracker 8789).
 */
export function cloudTrackerUrl(settings: { cloudApiUrl: string }): string | null {
  const override = normalizeBaseUrl(settings.cloudApiUrl || '');
  if (override) {
    const url = new URL(override);
    if (url.hostname === '127.0.0.1' || url.hostname === 'localhost') {
      url.port = '8789';
      return url.origin;
    }
  }
  return BUILD_CLOUD_TRACKER_URL || null;
}
