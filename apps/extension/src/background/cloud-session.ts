import type { CloudSession } from '@pigeonbox/api-contract';
import {
  CloudApiError,
  PigeonBoxCloudClient,
  createPkcePair,
  randomUrlToken,
  type AccessTokenProvider,
} from '@pigeonbox/cloud-client';

/**
 * PigeonBox Cloud session, owned by the service worker.
 *
 * - The refresh token is the only long-lived secret. It sits in
 *   chrome.storage.local, which `hardenExtensionStorage` restricts to trusted
 *   extension contexts, so content scripts cannot read it.
 * - The access token lives in memory and chrome.storage.session (also trusted
 *   contexts only) so a restarted service worker does not refresh on every wake.
 * - A session is bound to the API origin that issued it. Tokens are never sent to
 *   a different origin, even if the configured URL changes.
 * - Content scripts never see any token. They send typed requests to the worker.
 */

const SESSION_KEY = 'cloudSession';
const ACCESS_KEY = 'cloudAccess';
/** Refresh this long before expiry. */
const EXPIRY_SKEW_SECONDS = 60;

export type StoredCloudSession = {
  apiBaseUrl: string;
  refreshToken: string;
  user: { id: string; email: string | null };
};

type StoredAccess = { apiBaseUrl: string; accessToken: string; expiresAt: number };

type StorageArea = {
  get(keys: string | string[]): Promise<Record<string, unknown>>;
  set(items: Record<string, unknown>): Promise<void>;
  remove(keys: string | string[]): Promise<void>;
};

export type CloudSessionDeps = {
  local: StorageArea;
  session: StorageArea;
  /** chrome.identity.getRedirectURL */
  redirectUrl: () => string;
  /** chrome.identity.launchWebAuthFlow({ url, interactive: true }) */
  launchAuthFlow: (url: string) => Promise<string | undefined>;
  fetch?: typeof fetch;
  clientName: string;
  now?: () => number;
};

export class CloudSessionManager {
  private access: StoredAccess | null = null;
  private refreshing: Promise<string | null> | null = null;

  constructor(private readonly deps: CloudSessionDeps) {}

  private nowSeconds(): number {
    return Math.floor((this.deps.now?.() ?? Date.now()) / 1000);
  }

  /** A client for `apiBaseUrl` that authenticates with this session. */
  client(apiBaseUrl: string): PigeonBoxCloudClient {
    return new PigeonBoxCloudClient({
      baseUrl: apiBaseUrl,
      fetch: this.deps.fetch,
      clientName: this.deps.clientName,
      tokens: this.tokenProvider(apiBaseUrl),
    });
  }

  private anonymousClient(apiBaseUrl: string): PigeonBoxCloudClient {
    return new PigeonBoxCloudClient({ baseUrl: apiBaseUrl, fetch: this.deps.fetch, clientName: this.deps.clientName });
  }

  tokenProvider(apiBaseUrl: string): AccessTokenProvider {
    return {
      get: () => this.getAccessToken(apiBaseUrl),
      refresh: () => this.refreshAccessToken(apiBaseUrl),
    };
  }

  async readSession(): Promise<StoredCloudSession | null> {
    const stored = (await this.deps.local.get(SESSION_KEY))[SESSION_KEY] as StoredCloudSession | undefined;
    if (!stored || typeof stored.refreshToken !== 'string' || typeof stored.apiBaseUrl !== 'string') return null;
    return stored;
  }

  /** Signed-in user for `apiBaseUrl`, or null. Does not touch the network. */
  async currentUser(apiBaseUrl: string): Promise<StoredCloudSession['user'] | null> {
    const session = await this.readSession();
    return session && session.apiBaseUrl === apiBaseUrl ? session.user : null;
  }

  async signIn(apiBaseUrl: string): Promise<StoredCloudSession['user']> {
    const { verifier, challenge } = await createPkcePair();
    const state = randomUrlToken(24);
    const redirectUri = this.deps.redirectUrl();
    const client = this.anonymousClient(apiBaseUrl);
    const responseUrl = await this.deps.launchAuthFlow(client.authorizeUrl({ redirectUri, codeChallenge: challenge, state }));
    if (!responseUrl) throw new CloudApiError({ code: 'signed_out', message: 'Sign-in was cancelled.' });
    const returned = new URL(responseUrl);
    const expected = new URL(redirectUri);
    if (returned.origin !== expected.origin || returned.pathname !== expected.pathname) {
      throw new CloudApiError({ code: 'invalid_response', message: 'Sign-in returned to an unexpected address.' });
    }
    if (returned.searchParams.get('state') !== state) throw new CloudApiError({ code: 'invalid_response', message: 'Sign-in could not be verified. Try again.' });
    const authError = returned.searchParams.get('error_description') || returned.searchParams.get('error');
    if (authError) throw new CloudApiError({ code: 'unauthenticated', message: `Sign-in failed: ${authError.slice(0, 200)}` });
    const code = returned.searchParams.get('code');
    if (!code) throw new CloudApiError({ code: 'invalid_response', message: 'Sign-in did not return a code.' });
    const session = await client.exchangeCode({ code, codeVerifier: verifier, redirectUri });
    await this.store(apiBaseUrl, session);
    return session.user;
  }

  async signOut(): Promise<void> {
    const session = await this.readSession();
    if (session) {
      try {
        const token = await this.getAccessToken(session.apiBaseUrl).catch(() => null);
        if (token) await this.client(session.apiBaseUrl).signOut({ refreshToken: session.refreshToken });
      } catch {
        /* Local sign-out still happens when the server is unreachable. */
      }
    }
    await this.clear();
  }

  async clear(): Promise<void> {
    this.access = null;
    await this.deps.local.remove(SESSION_KEY);
    await this.deps.session.remove(ACCESS_KEY);
  }

  private async store(apiBaseUrl: string, session: CloudSession): Promise<void> {
    const persistent: StoredCloudSession = { apiBaseUrl, refreshToken: session.refreshToken, user: session.user };
    this.access = { apiBaseUrl, accessToken: session.accessToken, expiresAt: session.expiresAt };
    await this.deps.local.set({ [SESSION_KEY]: persistent });
    await this.deps.session.set({ [ACCESS_KEY]: this.access });
  }

  private async getAccessToken(apiBaseUrl: string): Promise<string | null> {
    const session = await this.readSession();
    if (!session || session.apiBaseUrl !== apiBaseUrl) return null;
    if (!this.access) {
      const stored = (await this.deps.session.get(ACCESS_KEY))[ACCESS_KEY] as StoredAccess | undefined;
      if (stored?.accessToken && stored.apiBaseUrl === apiBaseUrl) this.access = stored;
    }
    if (this.access && this.access.apiBaseUrl === apiBaseUrl && this.access.expiresAt - EXPIRY_SKEW_SECONDS > this.nowSeconds()) {
      return this.access.accessToken;
    }
    return this.refreshAccessToken(apiBaseUrl);
  }

  /**
   * One refresh at a time. A rejected refresh token ends the session; a network
   * failure keeps it so the user is not signed out by a flaky connection.
   */
  private refreshAccessToken(apiBaseUrl: string): Promise<string | null> {
    this.refreshing ??= (async () => {
      const session = await this.readSession();
      if (!session || session.apiBaseUrl !== apiBaseUrl) return null;
      try {
        const next = await this.anonymousClient(apiBaseUrl).refreshSession({ refreshToken: session.refreshToken });
        await this.store(apiBaseUrl, next);
        return next.accessToken;
      } catch (error) {
        if (error instanceof CloudApiError && (error.code === 'invalid_token' || error.code === 'unauthenticated' || error.code === 'invalid_request')) {
          await this.clear();
          return null;
        }
        throw error;
      }
    })().finally(() => {
      this.refreshing = null;
    });
    return this.refreshing;
  }
}
