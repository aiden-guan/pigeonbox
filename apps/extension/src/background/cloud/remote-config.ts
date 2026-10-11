/**
 * Remote client configuration, worker side (schema: @pigeonbox/api-contract
 * client-config.ts).
 *
 * - Cloud mode only. Local mode never asks PigeonBox Cloud for anything, so it
 *   always runs with the built-in defaults.
 * - Cached with the server's TTL. When a refresh fails the last known good
 *   config stays in force for up to MAX_STALE_MS, then the defaults return.
 * - Bound to the API origin it came from, like the Cloud session.
 * - A failed fetch is not retried for FAILURE_BACKOFF_MS, so an outage never
 *   turns into a request per message.
 */
import { DEFAULT_CLIENT_CONFIG, clientCompatibility, resolveClientConfig, type ClientCompatibility, type ClientConfig, type ClientFeature } from '@pigeonbox/api-contract';

export const REMOTE_CONFIG_KEY = 'remoteClientConfig';
/** Last known good config is trusted at most this long without a successful refresh. */
export const MAX_STALE_MS = 7 * 24 * 60 * 60_000;
export const FAILURE_BACKOFF_MS = 5 * 60_000;

/** `raw` is the server's response as received; it is re-validated whenever it is read back. */
type Stored = { apiBaseUrl: string; fetchedAt: number; raw: unknown };
type Entry = { apiBaseUrl: string; fetchedAt: number; config: ClientConfig };
type StorageArea = { get(keys: string): Promise<Record<string, unknown>>; set(items: Record<string, unknown>): Promise<void>; remove(keys: string): Promise<void> };

export type RemoteConfigDeps = {
  storage: StorageArea;
  /** Raw `GET /v1/client/config` response. */
  fetchConfig: (apiBaseUrl: string) => Promise<unknown>;
  now?: () => number;
  /** Content-free outcome of each fetch, for diagnostics. */
  onFetch?: (outcome: 'success' | 'failure', code: 'ok' | 'unavailable' | 'malformed') => void;
};

export type RemoteConfigStatus = {
  source: 'default' | 'remote' | 'last_known_good';
  revision: string;
  /** Milliseconds since the config was fetched; null for defaults. */
  ageMs: number | null;
  lastError: 'unavailable' | 'malformed' | null;
};

export class RemoteClientConfig {
  private memory: Entry | null = null;
  private loaded = false;
  private failedAt = 0;
  private lastError: RemoteConfigStatus['lastError'] = null;
  private inflight: Promise<ClientConfig> | null = null;

  constructor(private readonly deps: RemoteConfigDeps) {}

  private now(): number {
    return this.deps.now?.() ?? Date.now();
  }

  private async stored(api: string): Promise<Entry | null> {
    if (!this.loaded) {
      this.loaded = true;
      const raw = (await this.deps.storage.get(REMOTE_CONFIG_KEY).catch((): Record<string, unknown> => ({})))[REMOTE_CONFIG_KEY] as Stored | undefined;
      // Re-validate what storage holds: an older build may have written it.
      const config = raw && typeof raw === 'object' ? resolveClientConfig(raw.raw) : null;
      if (config && typeof raw!.apiBaseUrl === 'string' && typeof raw!.fetchedAt === 'number') this.memory = { apiBaseUrl: raw!.apiBaseUrl, fetchedAt: raw!.fetchedAt, config };
    }
    const entry = this.memory;
    if (!entry || entry.apiBaseUrl !== api) return null;
    const age = this.now() - entry.fetchedAt;
    return age >= 0 && age < MAX_STALE_MS ? entry : null;
  }

  /** The config in force now, without a network request. */
  async current(api: string | null): Promise<ClientConfig> {
    if (!api) return DEFAULT_CLIENT_CONFIG;
    return (await this.stored(api))?.config ?? DEFAULT_CLIENT_CONFIG;
  }

  /**
   * Fetch when the cached copy has expired (or `force`); always resolves to a
   * usable config. `api` is the Cloud API origin in Cloud mode, else null.
   */
  async refresh(api: string | null, options: { force?: boolean } = {}): Promise<ClientConfig> {
    if (!api) return DEFAULT_CLIENT_CONFIG;
    const entry = await this.stored(api);
    const now = this.now();
    const fresh = entry && now - entry.fetchedAt < entry.config.ttlSeconds * 1000;
    if ((fresh && !options.force) || (!options.force && now - this.failedAt < FAILURE_BACKOFF_MS)) return entry?.config ?? DEFAULT_CLIENT_CONFIG;
    this.inflight ??= (async () => {
      try {
        const raw = await this.deps.fetchConfig(api);
        const config = resolveClientConfig(raw);
        if (!config) {
          this.failedAt = this.now();
          this.lastError = 'malformed';
          this.deps.onFetch?.('failure', 'malformed');
          return entry?.config ?? DEFAULT_CLIENT_CONFIG;
        }
        const fetchedAt = this.now();
        this.memory = { apiBaseUrl: api, fetchedAt, config };
        this.lastError = null;
        this.failedAt = 0;
        this.deps.onFetch?.('success', 'ok');
        await this.deps.storage.set({ [REMOTE_CONFIG_KEY]: { apiBaseUrl: api, fetchedAt, raw } satisfies Stored }).catch(() => undefined);
        return config;
      } catch {
        this.failedAt = this.now();
        this.lastError = 'unavailable';
        this.deps.onFetch?.('failure', 'unavailable');
        return entry?.config ?? DEFAULT_CLIENT_CONFIG;
      }
    })().finally(() => {
      this.inflight = null;
    });
    return this.inflight;
  }

  async status(api: string | null): Promise<RemoteConfigStatus> {
    const entry = api ? await this.stored(api) : null;
    if (!entry) return { source: 'default', revision: DEFAULT_CLIENT_CONFIG.revision, ageMs: null, lastError: api ? this.lastError : null };
    const ageMs = Math.max(0, this.now() - entry.fetchedAt);
    return { source: ageMs < entry.config.ttlSeconds * 1000 ? 'remote' : 'last_known_good', revision: entry.config.revision, ageMs, lastError: this.lastError };
  }

  async clear(): Promise<void> {
    this.memory = null;
    this.failedAt = 0;
    this.lastError = null;
    await this.deps.storage.remove(REMOTE_CONFIG_KEY).catch(() => undefined);
  }
}

export function featureDisabled(config: ClientConfig, feature: ClientFeature): boolean {
  return config.disabledFeatures.includes(feature);
}

export function compatibilityFor(config: ClientConfig, version: string): ClientCompatibility {
  return clientCompatibility(version, config.compatibility);
}
