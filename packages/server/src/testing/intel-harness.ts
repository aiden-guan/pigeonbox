/**
 * End-to-end harness for the always-on layer: the real API router over PGlite
 * (all migrations, RLS roles), the fake Google, real encryption, mock
 * inference, a controllable clock, and helpers to sign in, connect Google,
 * push notifications and drain the job queue.
 */
import { PROTOCOL_HEADER, PROTOCOL_VERSION, type ConnectionFeature, type RouteDef, type RouteName, ROUTES } from '@pigeonbox/api-contract';
import { CONTROL_ROUTES, type ControlRouteName } from '../control/contract.js';
import { MockInferenceBackend, type CloudInferenceBackend } from '../ai/backends.js';
import { createApiHandler } from '../api.js';
import { createAuthProvider } from '../auth.js';
import { loadConfig, type RawEnv } from '../config.js';
import type { LogFields } from '../http.js';
import { clearAccessTokenCache } from '../intel/google-access.js';
import { MemoryDocumentStorage } from '../intel/documents.js';
import { createGoogleContext } from '../intel/context.js';
import { generateMasterKey, parseKeyring, WebCryptoSecretBox } from '../platform/crypto.js';
import { drainJobs } from '../routes/jobs.js';
import type { ApiDeps, IntelRuntime } from '../routes/types.js';
import { MemoryCloudStore } from '../store/memory.js';
import { API, testEnv } from '../testing.js';
import { createTestDatabase } from './database.js';
import { FakeGoogle } from './fake-google.js';

export const PUSH_AUDIENCE = `${API}/v1/google/push`;

export async function createIntelHarness(options: { env?: RawEnv; inference?: CloudInferenceBackend } = {}) {
  clearAccessTokenCache();
  const google = await FakeGoogle.create();
  const { pg, db } = await createTestDatabase();
  const keys = options.env?.DATA_ENCRYPTION_KEYS ?? `k1:${generateMasterKey()}`;
  const env = testEnv({
    API_BASE_URL: API,
    DATABASE_URL: 'postgres://pglite.test/pigeonbox',
    DATA_ENCRYPTION_KEYS: keys,
    GOOGLE_CLIENT_ID: google.clientId,
    GOOGLE_CLIENT_SECRET: google.clientSecret,
    GOOGLE_PUBSUB_TOPIC: 'projects/pigeonbox-test/topics/gmail-push',
    GOOGLE_PUBSUB_AUDIENCE: PUSH_AUDIENCE,
    GOOGLE_PUBSUB_SERVICE_ACCOUNT: google.serviceAccount,
    INTERNAL_JOB_SECRET: 'internal-secret-for-tests-0123456789',
    SEQUENCES_ENABLED: 'true',
    DOCUMENTS_BUCKET: 'documents',
    SUPABASE_URL: 'https://supabase.test',
    SUPABASE_SERVICE_ROLE_KEY: 'service-role-test',
    DATA_STORE: 'memory',
    ...options.env,
  });
  const config = loadConfig(env);
  let offsetMs = 0;
  const now = () => new Date(Date.now() + offsetMs);
  const store = new MemoryCloudStore();
  const auth = createAuthProvider(config);
  const inference = options.inference ?? new MockInferenceBackend('mock-small', config.intel.embedDimensions);
  const logs: Array<{ level: string; message: string; fields?: LogFields }> = [];
  const log = (level: 'info' | 'warn' | 'error', message: string, fields?: LogFields) => logs.push({ level, message, fields });
  const box = new WebCryptoSecretBox(parseKeyring(keys));
  const storage = new MemoryDocumentStorage();
  const intel: IntelRuntime = {
    database: db,
    box,
    google: createGoogleContext(config, google.fetch, { endpoints: google.endpoints, keys: google.jwks }),
    fetch: google.fetch,
    storage,
    pushKeys: google.jwks,
  };
  const deps: ApiDeps = { config, store, auth, inference, log, now, intel };
  const api = createApiHandler(deps);

  function call(path: string, init: { method?: string; body?: unknown; token?: string | null; headers?: Record<string, string> } = {}) {
    const headers: Record<string, string> = { [PROTOCOL_HEADER]: String(PROTOCOL_VERSION), ...(init.headers ?? {}) };
    if (init.token) headers.Authorization = `Bearer ${init.token}`;
    if (init.body !== undefined) headers['Content-Type'] = 'application/json';
    return api(new Request(`${API}${path}`, { method: init.method ?? (init.body === undefined ? 'GET' : 'POST'), headers, body: init.body === undefined ? undefined : JSON.stringify(init.body) }));
  }

  /** Call a contract route by name; throws with the error body on failure. */
  async function route<T = Record<string, unknown>>(name: RouteName | ControlRouteName, token: string, body?: unknown): Promise<T> {
    const def: RouteDef = name in ROUTES ? ROUTES[name as RouteName] : CONTROL_ROUTES[name as ControlRouteName];
    const response = await call(def.path, { method: def.method, body: def.method === 'GET' ? undefined : body ?? {}, token });
    const data = (await response.json()) as T & { error?: { code: string; message: string } };
    if (!response.ok) throw Object.assign(new Error(`${name} ${response.status} ${data.error?.code}: ${data.error?.message}`), { status: response.status, code: data.error?.code });
    return data;
  }

  async function signIn(email: string) {
    // Reuse the base harness's PKCE flow against this API (same dev auth secret).
    return signInWith(api, email);
  }

  /** Full consent flow: start → Google consent → callback. Returns the landing URL. */
  async function connect(token: string, email: string, features: ConnectionFeature[] = ['mail_read'], extra: { accountId?: string; grant?: (scopes: string[]) => string[] } = {}) {
    if (!google.accounts.has(`sub-${email}`)) google.addAccount(email);
    const { url } = await route<{ url: string }>('connectStart', token, { features, returnTo: 'web', ...(extra.accountId ? { accountId: extra.accountId } : {}) });
    const callback = await google.consent(url, email, { grant: extra.grant });
    const response = await api(new Request(callback));
    return { authorizationUrl: url, landing: response.headers.get('Location') ?? '', status: response.status };
  }

  async function push(email: string, historyId?: number, options: { audience?: string; signer?: string; tamper?: boolean } = {}) {
    const account = google.account(email);
    const request = await google.pushRequest(`${API}/v1/google/push`, email, historyId ?? account.historyId, { audience: options.audience ?? PUSH_AUDIENCE, signer: options.signer, tamper: options.tamper });
    return api(request);
  }

  /** Run due jobs until the queue is idle (or `rounds` passes). */
  async function drain(rounds = 10) {
    const totals = { claimed: 0, succeeded: 0, retried: 0, deferred: 0, dead: 0, skipped: 0 };
    for (let i = 0; i < rounds; i += 1) {
      await release();
      const result = await drainJobs(deps, { maxJobs: 200, budgetMs: 60_000, concurrency: 1 });
      for (const key of Object.keys(totals) as Array<keyof typeof totals>) totals[key] += result[key];
      if (!result.claimed) break;
    }
    return totals;
  }

  /** Move the app clock forward and make every queued job whose time has come visible now. */
  async function advance(ms: number) {
    offsetMs += ms;
    await release();
  }

  /** The database clock does not move with the app clock: release jobs that are due by the app clock. */
  async function release() {
    const target = now();
    await pg.query(
      `update pgmq.q_pigeonbox_jobs set vt = clock_timestamp()
        where (message ->> 'job_id')::uuid in (select id from public.jobs where run_at <= $1::timestamptz and status in ('queued', 'retrying'))`,
      [target.toISOString()],
    );
    await pg.query(`update public.jobs set run_at = least(run_at, now()) where run_at <= $1::timestamptz and status in ('queued', 'retrying')`, [target.toISOString()]);
  }

  async function sql<T = Record<string, unknown>>(text: string, params: unknown[] = []): Promise<T[]> {
    return (await pg.query<T>(text, params)).rows;
  }

  return { google, pg, db, config, store, api, call, route, signIn, connect, push, drain, advance, sql, logs, box, now, deps, storage };
}

async function signInWith(api: ReturnType<typeof createApiHandler>, email: string) {
  const { createPkcePair } = await import('@pigeonbox/cloud-client');
  const { REDIRECT_URI } = await import('../testing.js');
  const { verifier, challenge } = await createPkcePair();
  const state = 'state-0123456789abcdef';
  const query = new URLSearchParams({ redirect_uri: REDIRECT_URI, code_challenge: challenge, code_challenge_method: 'S256', state });
  await api(new Request(`${API}/v1/auth/authorize?${query}`));
  const approve = await api(new Request(`${API}/v1/auth/dev/approve?${query}&email=${encodeURIComponent(email)}`));
  const location = new URL(approve.headers.get('Location')!);
  const response = await api(
    new Request(`${API}/v1/auth/token`, {
      method: 'POST',
      headers: { [PROTOCOL_HEADER]: String(PROTOCOL_VERSION), 'Content-Type': 'application/json' },
      body: JSON.stringify({ code: location.searchParams.get('code'), codeVerifier: verifier, redirectUri: REDIRECT_URI }),
    }),
  );
  if (!response.ok) throw new Error(`token ${response.status}`);
  return (await response.json()) as { accessToken: string; refreshToken: string; user: { id: string; email: string | null } };
}

export type IntelHarness = Awaited<ReturnType<typeof createIntelHarness>>;

/** Sign in, set preferences, connect Google, and finish the initial sync. */
export async function connectedUser(
  h: IntelHarness,
  email: string,
  features: ConnectionFeature[] = ['mail_read', 'drafts', 'organize', 'calendar_read', 'calendar_write'],
  preferences: Record<string, unknown> = {},
) {
  const session = await h.signIn(email);
  if (!h.google.accounts.has(`sub-${email}`)) h.google.addAccount(email);
  await h.route('preferencesUpdate', session.accessToken, { preferences: { timeZone: 'America/New_York', ...preferences } });
  await h.connect(session.accessToken, email, features);
  await h.drain();
  const accounts = await h.route<{ accounts: Array<{ id: string }> }>('connections', session.accessToken);
  return { session, token: session.accessToken, userId: session.user.id, accountId: accounts.accounts.find(Boolean)!.id };
}

/** Deliver a message to `owner` (or send one from them), push, and process everything. */
export async function deliverAndSync(h: IntelHarness, owner: string, message: Parameters<FakeGoogle['deliver']>[1]) {
  const result = h.google.deliver(owner, message);
  await h.push(owner);
  await h.drain();
  return result;
}
