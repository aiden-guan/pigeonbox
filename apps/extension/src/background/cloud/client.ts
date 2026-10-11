/**
 * The service worker's PigeonBox Cloud connection: one signed-in session, a
 * `PigeonBoxCloudClient` for the configured API, and the cached account state
 * (plan, capabilities). Account state never carries mailbox data; which
 * features may use Cloud is decided by the callers and `@pigeonbox/core`.
 */
import { clientCompatibility, type ClientConfig } from '@pigeonbox/api-contract';
import { CloudApiError, type PigeonBoxCloudClient } from '@pigeonbox/cloud-client';
import { SIGNED_OUT_CLOUD, type CloudState, type CloudUpdateNotice } from '@pigeonbox/core';
import type { ExtensionSettings } from '@pigeonbox/shared';
import type { TrackerCredential } from '@pigeonbox/tracking';
import { cloudApiUrl, cloudTrackerUrl } from '../../config';
import { CloudSessionManager } from './session';
import { RemoteClientConfig } from './remote-config';
import { diagnostics, durationBucket } from '../diagnostics';

const LAST_OK_KEY = 'cloudLastOkAt';

/** When the account state last came back from Cloud, for diagnostics; null when never in this browser session. */
export async function lastCloudOkAt(): Promise<number | null> {
  const value = (await chrome.storage.session.get(LAST_OK_KEY))[LAST_OK_KEY];
  return typeof value === 'number' ? value : null;
}

const STATE_KEY = 'cloudState';
type StoredCloudState = { apiBaseUrl: string; userId: string | null; state: CloudState };

export function extensionVersion(): string {
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

/** Remote client config for the Cloud API in use; Local mode always gets the defaults. */
export const remoteConfig = new RemoteClientConfig({
  storage: chrome.storage.local,
  fetchConfig: (api) => cloudSession.client(api).clientConfig({ timeoutMs: 8_000 }),
  onFetch: (outcome, code) => void diagnostics?.record({ component: 'remote_config', code, outcome }),
});

/** The Cloud API that remote config may come from: only in Cloud mode. */
export function remoteConfigApi(settings: ExtensionSettings): string | null {
  return settings.runMode === 'cloud' ? cloudApiUrl(settings) : null;
}

export function clientConfig(settings: ExtensionSettings): Promise<ClientConfig> {
  return remoteConfig.current(remoteConfigApi(settings));
}

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
export async function refreshCloudState(settings: ExtensionSettings, options: { forceConfig?: boolean } = {}): Promise<CloudState> {
  const base = cloudApiUrl(settings);
  if (!base) return { ...SIGNED_OUT_CLOUD, status: 'not_configured' };
  const user = await cloudSession.currentUser(base);
  let state: CloudState;
  if (!user) {
    state = SIGNED_OUT_CLOUD;
  } else {
    const config = await remoteConfig.refresh(remoteConfigApi(settings), { force: options.forceConfig });
    const update = updateNotice(extensionVersion(), config);
    if (update?.required) {
      // Known too old: no request that would only be refused, and no retry loop.
      state = { status: 'update_required', email: user.email, plan: null, capabilities: [], update };
    } else {
      try {
        const started = Date.now();
        const caps = await cloudSession.client(base).capabilities();
        await chrome.storage.session.set({ [LAST_OK_KEY]: Date.now() });
        void diagnostics?.record({ component: 'cloud_state', code: 'ok', outcome: 'success', duration: durationBucket(Date.now() - started) });
        state = {
          // `not_entitled` still carries any capabilities the server granted.
          status: caps.capabilities.includes('cloud_ai') ? 'ready' : 'not_entitled',
          email: user.email,
          plan: caps.plan,
          capabilities: caps.capabilities,
          ...(update ? { update } : {}),
          ...(config.notice ? { notice: config.notice.code } : {}),
        };
      } catch (error) {
        const code = error instanceof CloudApiError ? error.code : 'network';
        void diagnostics?.record({ component: 'cloud_state', code, outcome: 'failure', requestId: error instanceof CloudApiError ? error.requestId : undefined });
        state = code === 'unsupported_protocol'
          ? {
              status: 'update_required',
              email: user.email,
              plan: null,
              capabilities: [],
              update: { required: true, installed: extensionVersion(), minimum: (error as CloudApiError).minimumVersion ?? config.compatibility.minimumVersion, recommended: config.compatibility.recommendedVersion },
            }
          : {
              status: code === 'signed_out' ? 'expired' : code === 'entitlement_required' ? 'not_entitled' : 'unreachable',
              email: user.email,
              plan: null,
              capabilities: [],
              ...(config.notice ? { notice: config.notice.code } : {}),
            };
      }
    }
  }
  await chrome.storage.session.set({ [STATE_KEY]: { apiBaseUrl: base, userId: user?.id ?? null, state } satisfies StoredCloudState });
  return state;
}

/** Null when the installed version meets the server's minimums. */
export function updateNotice(installed: string, config: Pick<ClientConfig, 'compatibility'>): CloudUpdateNotice | null {
  const verdict = clientCompatibility(installed, config.compatibility);
  if (verdict === 'compatible') return null;
  return { required: verdict === 'update_required', installed, minimum: config.compatibility.minimumVersion, recommended: config.compatibility.recommendedVersion };
}

export async function clearCloudState(): Promise<void> {
  await chrome.storage.session.remove(STATE_KEY);
}

/**
 * The account state last fetched for this API, without a network request.
 * Null when it has not been fetched in this browser session.
 */
export async function cachedCloudState(settings: ExtensionSettings): Promise<CloudState | null> {
  const base = cloudApiUrl(settings);
  if (!base) return null;
  const stored = (await chrome.storage.session.get(STATE_KEY))[STATE_KEY] as StoredCloudState | undefined;
  return stored?.apiBaseUrl === base ? stored.state : null;
}

/**
 * The hosted tracker and the Cloud session's token provider, when Cloud mode
 * may track. Requests made with it refresh an expired access token through the
 * same session as every other Cloud call. Tokens stay in the service worker.
 */
export async function cloudTrackerTarget(settings: ExtensionSettings): Promise<{ baseUrl: string; credential: TrackerCredential } | null> {
  const api = cloudApiUrl(settings);
  const tracker = cloudTrackerUrl(settings);
  if (!api || !tracker) return null;
  const state = await readCloudState(settings);
  if (!state.capabilities.includes('cloud_tracking')) return null;
  if (!(await cloudSession.currentUser(api))) return null;
  return { baseUrl: tracker, credential: cloudSession.tokenProvider(api) };
}
