export const CLOUD_WAITLIST_URL = 'https://usepigeonbox.com/waitlist?source=extension';
/** The Cloud dashboard on the website; loopback API overrides use their own copy. */
export const CLOUD_DASHBOARD_URL = 'https://usepigeonbox.com/dashboard';
export function openCloudWaitlist() { void chrome.tabs.create({ url: CLOUD_WAITLIST_URL }); }

import { normalizeBaseUrl } from '@pigeonbox/cloud-client';

/** Public build-time configuration. No secrets may be read here. */
export const BUILD_CLOUD_API_URL = normalizeBaseUrl(import.meta.env.VITE_PIGEONBOX_CLOUD_API_URL ?? '') ?? '';
export const BUILD_CLOUD_TRACKER_URL = normalizeBaseUrl(import.meta.env.VITE_PIGEONBOX_CLOUD_TRACKER_URL ?? '') ?? '';
export const BUILD_CLOUD_TRACKER_PREVIOUS_URLS = parseBaseUrls(import.meta.env.VITE_PIGEONBOX_CLOUD_TRACKER_PREVIOUS_URLS ?? '');

function parseBaseUrls(value: string): string[] {
  return value
    .split(',')
    .map((part) => normalizeBaseUrl(part.trim()))
    .filter((url): url is string => Boolean(url));
}

/**
 * Experimental features (ChatGPT web sign-in) are on for source builds and off
 * for release builds, which set VITE_PIGEONBOX_EXPERIMENTAL=false.
 */
export const EXPERIMENTAL_FEATURES = import.meta.env.VITE_PIGEONBOX_EXPERIMENTAL !== 'false';

/**
 * Local `npm run dev:reload` helper that rebuilds dist/ before Settings →
 * Developer → "Reload extension" restarts the extension. Blank in release builds.
 */
export const DEV_REBUILD_URL = import.meta.env.VITE_PIGEONBOX_DEV_REBUILD_URL ?? '';

/** Source (non-release) build: the dashboard bridge also accepts loopback dashboards. */
export const DEV_BUILD = import.meta.env.VITE_PIGEONBOX_RELEASE !== '1';

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

/**
 * Every hosted-tracker URL whose pixels belong to this Cloud install: the
 * current tracker, then its earlier hostnames. Sent mail keeps its original
 * pixel URL forever, so a hostname change must not stop self-view suppression.
 */
export function cloudTrackerUrls(settings: { cloudApiUrl: string }): string[] {
  const current = cloudTrackerUrl(settings);
  if (!current) return [];
  return [current, ...BUILD_CLOUD_TRACKER_PREVIOUS_URLS.filter((url) => url !== current)];
}

/**
 * Identifies the tracker that issued a tracking ID. Cloud is keyed by its API,
 * so moving the hosted tracker to a new hostname keeps existing IDs routable.
 */
export function trackerIssuer(settings: { runMode: string; cloudApiUrl: string; trackerBaseUrl: string }): string | null {
  if (settings.runMode === 'cloud') {
    const api = cloudApiUrl(settings);
    return api ? `cloud:${new URL(api).origin}` : null;
  }
  try {
    const url = new URL(settings.trackerBaseUrl);
    return url.protocol === 'http:' || url.protocol === 'https:' ? `local:${url.origin}` : null;
  } catch {
    return null;
  }
}
