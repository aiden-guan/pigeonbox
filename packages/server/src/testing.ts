/**
 * Test harness: a complete server API over memory stores and mock inference,
 * plus helpers to sign in through the real PKCE flow. Not used in production.
 */
import { PROTOCOL_HEADER, PROTOCOL_VERSION, type CloudSession } from '@pigeonbox/api-contract';
import { createPkcePair } from '@pigeonbox/cloud-client';
import { createApiHandler } from './api.js';
import { MockInferenceBackend, type CloudInferenceBackend } from './ai/backends.js';
import { createAuthProvider } from './auth.js';
import { loadConfig, type RawEnv } from './config.js';
import type { LogFields } from './http.js';
import { MemoryCloudStore } from './store/memory.js';
import { createTrackerHandler } from './tracker.js';

export const EXTENSION_ID = 'abcdefghijklmnopabcdefghijklmnop';
export const REDIRECT_URI = `https://${EXTENSION_ID}.chromiumapp.org/cloud`;
export const API = 'https://api.test';
export const TRACKER = 'https://t.test';

export function testEnv(overrides: RawEnv = {}): RawEnv {
  return {
    ENVIRONMENT: 'test',
    AUTH_PROVIDER: 'dev',
    DEV_AUTH_SECRET: 'dev-secret-for-tests-only-0123456789',
    CLOUD_AI_PROVIDER: 'mock',
    CLOUD_AI_TIMEOUT_MS: '40',
    ALLOWED_EXTENSION_IDS: EXTENSION_ID,
    ALLOWED_WEB_ORIGINS: 'https://app.test',
    PUBLIC_APP_URL: 'https://app.test',
    IP_HASH_SALT: 'test-salt',
    ...overrides,
  };
}

export function createHarness(options: { env?: RawEnv; inference?: CloudInferenceBackend; now?: () => Date } = {}) {
  const config = loadConfig(testEnv(options.env));
  const store = new MemoryCloudStore();
  const auth = createAuthProvider(config);
  const inference = options.inference ?? new MockInferenceBackend();
  const logs: Array<{ level: string; message: string; fields?: LogFields }> = [];
  const log = (level: 'info' | 'warn' | 'error', message: string, fields?: LogFields) => logs.push({ level, message, fields });
  const api = createApiHandler({ config, store, auth, inference, log, now: options.now });
  const tracker = createTrackerHandler({ config, store, auth, log });

  function call(path: string, init: { method?: string; body?: unknown; token?: string | null; headers?: Record<string, string>; protocol?: string | null } = {}) {
    const headers: Record<string, string> = { ...(init.headers ?? {}) };
    if (init.protocol !== null) headers[PROTOCOL_HEADER] = init.protocol ?? String(PROTOCOL_VERSION);
    if (init.token) headers.Authorization = `Bearer ${init.token}`;
    if (init.body !== undefined) headers['Content-Type'] = 'application/json';
    return api(new Request(`${API}${path}`, { method: init.method ?? (init.body === undefined ? 'GET' : 'POST'), headers, body: init.body === undefined ? undefined : JSON.stringify(init.body) }));
  }

  /** Sign in through authorize → dev approve → token exchange, like the extension does. */
  async function signIn(email: string): Promise<CloudSession> {
    const { verifier, challenge } = await createPkcePair();
    const state = 'state-0123456789abcdef';
    const query = new URLSearchParams({ redirect_uri: REDIRECT_URI, code_challenge: challenge, code_challenge_method: 'S256', state });
    const page = await api(new Request(`${API}/v1/auth/authorize?${query}`));
    if (page.status !== 200) throw new Error(`authorize ${page.status}`);
    const approve = await api(new Request(`${API}/v1/auth/dev/approve?${query}&email=${encodeURIComponent(email)}`));
    const location = new URL(approve.headers.get('Location')!);
    if (location.searchParams.get('state') !== state) throw new Error('state mismatch');
    const response = await call('/v1/auth/token', { body: { code: location.searchParams.get('code'), codeVerifier: verifier, redirectUri: REDIRECT_URI } });
    if (!response.ok) throw new Error(`token ${response.status}`);
    return (await response.json()) as CloudSession;
  }

  function trackerCall(path: string, init: { method?: string; body?: unknown; token?: string; headers?: Record<string, string> } = {}) {
    const headers: Record<string, string> = { ...(init.headers ?? {}) };
    if (init.token) headers.Authorization = `Bearer ${init.token}`;
    if (init.body !== undefined) headers['Content-Type'] = 'application/json';
    return tracker(
      new Request(`${TRACKER}${path}`, { method: init.method ?? (init.body === undefined ? 'GET' : 'POST'), headers, body: init.body === undefined ? undefined : JSON.stringify(init.body) }),
    );
  }

  return { config, store, auth, api, tracker, call, trackerCall, signIn, logs };
}

export const VOICE = {
  name: 'Ada',
  about: '',
  greeting: 'Hi',
  signoff: 'Thanks',
  concision: 'medium',
  capitalization: 'normal',
  formality: 'neutral',
  emoji: false,
  schedulingPreference: '',
  personalInstructions: '',
} as const;

export const THREAD = {
  subject: 'Slides from Tuesday',
  messages: [{ sender: 'Dana Lee <dana@example.com>', bodyText: 'Could you send the slides from Tuesday before Friday?', timestamp: '2026-09-01T10:00:00Z' }],
};
