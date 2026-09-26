import { CloudApiError, type PigeonBoxCloudClient } from '@pigeonbox/cloud-client';
import { SIGNED_OUT_CLOUD, type CloudState } from '@pigeonbox/core';
import type { ExtensionSettings } from '@pigeonbox/shared';
import { cloudApiUrl, cloudTrackerUrl } from '../config';
import { CloudSessionManager } from './cloud-session';

const STATE_KEY = 'cloudState';
type StoredCloudState = { apiBaseUrl: string; userId: string | null; state: CloudState };

function extensionVersion(): string {
  try {
    return chrome.runtime.getManifest().version;
  } catch {
    return 'dev';
  }
}

export const cloudSession = new CloudSessionManager({
  local: chrome.storage.local,
  session: chrome.storage.session,
  redirectUrl: () => chrome.identity.getRedirectURL('cloud'),
  launchAuthFlow: (url) => chrome.identity.launchWebAuthFlow({ url, interactive: true }),
  clientName: `extension/${extensionVersion()}`,
});

/** A Cloud client for the configured API, or null when this build has no Cloud URL. */
export function getCloudClient(settings: ExtensionSettings): PigeonBoxCloudClient | null {
  const base = cloudApiUrl(settings);
  return base ? cloudSession.client(base) : null;
}

export async function readCloudState(settings: ExtensionSettings): Promise<CloudState> {
  const base = cloudApiUrl(settings);
  if (!base) return { ...SIGNED_OUT_CLOUD, status: 'not_configured' };
  const user = await cloudSession.currentUser(base);
  const stored = (await chrome.storage.session.get(STATE_KEY))[STATE_KEY] as StoredCloudState | undefined;
  if (
    stored?.apiBaseUrl === base &&
    stored.userId === (user?.id ?? null) &&
    (user || stored.state?.status === 'signed_out')
  ) return stored.state;
  return refreshCloudState(settings);
}

/**
 * Ask the server what this account may use. Failures map to a status; they
 * never change settings or local data.
 */
export async function refreshCloudState(settings: ExtensionSettings): Promise<CloudState> {
  const base = cloudApiUrl(settings);
  if (!base) return { ...SIGNED_OUT_CLOUD, status: 'not_configured' };
  const user = await cloudSession.currentUser(base);
  let state: CloudState;
  if (!user) {
    state = SIGNED_OUT_CLOUD;
  } else {
    try {
      const caps = await cloudSession.client(base).capabilities();
      state = {
        // `not_entitled` still carries any capabilities the server granted.
        status: caps.capabilities.includes('cloud_ai') ? 'ready' : 'not_entitled',
        email: user.email,
        plan: caps.plan,
        capabilities: caps.capabilities,
      };
    } catch (error) {
      const code = error instanceof CloudApiError ? error.code : 'network';
      state = {
        status: code === 'signed_out' ? 'expired' : code === 'entitlement_required' ? 'not_entitled' : 'unreachable',
        email: user.email,
        plan: null,
        capabilities: [],
      };
    }
  }
  await chrome.storage.session.set({ [STATE_KEY]: { apiBaseUrl: base, userId: user?.id ?? null, state } satisfies StoredCloudState });
  return state;
}

export async function clearCloudState(): Promise<void> {
  await chrome.storage.session.remove(STATE_KEY);
}

/**
 * The hosted tracker and a Cloud access token, when Cloud mode may track.
 * The token goes to the tracker from the service worker only.
 */
export async function cloudTrackerTarget(settings: ExtensionSettings): Promise<{ baseUrl: string; token: string } | null> {
  const api = cloudApiUrl(settings);
  const tracker = cloudTrackerUrl(settings);
  if (!api || !tracker) return null;
  const state = await readCloudState(settings);
  if (!state.capabilities.includes('cloud_tracking')) return null;
  const token = await cloudSession.tokenProvider(api).get().catch(() => null);
  return token ? { baseUrl: tracker, token } : null;
}
