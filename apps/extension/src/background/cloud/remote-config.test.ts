import { describe, expect, it, vi } from 'vitest';
import { DEFAULT_CLIENT_CONFIG } from '@pigeonbox/api-contract';
import { FAILURE_BACKOFF_MS, MAX_STALE_MS, REMOTE_CONFIG_KEY, RemoteClientConfig, compatibilityFor, featureDisabled } from './remote-config';

const API = 'https://api.example';

function memoryStorage(initial: Record<string, unknown> = {}) {
  const data: Record<string, unknown> = { ...initial };
  return {
    data,
    get: async (key: string) => (key in data ? { [key]: data[key] } : {}),
    set: async (items: Record<string, unknown>) => void Object.assign(data, items),
    remove: async (key: string) => void delete data[key],
  };
}

function setup(options: { api?: string | null; fetchConfig?: (api: string) => Promise<unknown>; storage?: ReturnType<typeof memoryStorage> } = {}) {
  let now = 1_000_000;
  const storage = options.storage ?? memoryStorage();
  const fetchConfig = vi.fn(options.fetchConfig ?? (async () => ({ schema: 1, revision: 'r1', ttlSeconds: 600, config: { compose: { idleMs: 600 } } })));
  const inner = new RemoteClientConfig({ storage, fetchConfig, now: () => now });
  const api = options.api === undefined ? API : options.api;
  const remote = { refresh: (o?: { force?: boolean }) => inner.refresh(api, o), current: () => inner.current(api), status: () => inner.status(api) };
  return { remote, storage, fetchConfig, advance: (ms: number) => { now += ms; } };
}

describe('remote client config (worker)', () => {
  it('uses the defaults and never fetches in Local mode', async () => {
    const { remote, fetchConfig } = setup({ api: null });
    expect(await remote.refresh({ force: true })).toBe(DEFAULT_CLIENT_CONFIG);
    expect(await remote.current()).toBe(DEFAULT_CLIENT_CONFIG);
    expect(fetchConfig).not.toHaveBeenCalled();
  });

  it('fetches once, then serves the cache until the TTL expires', async () => {
    const { remote, fetchConfig, advance } = setup();
    expect((await remote.refresh()).compose.idleMs).toBe(600);
    await remote.refresh();
    expect(fetchConfig).toHaveBeenCalledTimes(1);
    advance(600_000);
    await remote.refresh();
    expect(fetchConfig).toHaveBeenCalledTimes(2);
  });

  it('keeps the last known good config when the server is unavailable, then backs off', async () => {
    let fail = false;
    const { remote, fetchConfig, advance } = setup({ fetchConfig: async () => { if (fail) throw new Error('offline'); return { schema: 1, revision: 'good', ttlSeconds: 300, config: { compose: { cooldownMs: 5_000 } } }; } });
    await remote.refresh();
    fail = true;
    advance(301_000);
    expect((await remote.refresh()).revision).toBe('good');
    expect(await remote.status()).toMatchObject({ source: 'last_known_good', lastError: 'unavailable' });
    await remote.refresh();
    expect(fetchConfig).toHaveBeenCalledTimes(2);
    advance(FAILURE_BACKOFF_MS);
    await remote.refresh();
    expect(fetchConfig).toHaveBeenCalledTimes(3);
  });

  it('falls back to defaults once the last known good config is too old', async () => {
    let fail = false;
    const { remote, advance } = setup({ fetchConfig: async () => { if (fail) throw new Error('offline'); return { schema: 1, revision: 'old', config: { disabledFeatures: ['compose_checks'] } }; } });
    await remote.refresh();
    fail = true;
    advance(MAX_STALE_MS);
    expect(await remote.refresh()).toBe(DEFAULT_CLIENT_CONFIG);
    expect(await remote.current()).toBe(DEFAULT_CLIENT_CONFIG);
  });

  it('ignores a malformed or incompatible response and keeps what it had', async () => {
    const responses: unknown[] = [{ schema: 1, revision: 'good', config: {} }, { schema: 2, revision: 'next', config: {} }, '<html>'];
    const { remote, advance } = setup({ fetchConfig: async () => responses.shift() });
    await remote.refresh();
    advance(4_000_000);
    expect((await remote.refresh()).revision).toBe('good');
    expect((await remote.status()).lastError).toBe('malformed');
    advance(FAILURE_BACKOFF_MS);
    expect((await remote.refresh()).revision).toBe('good');
  });

  it('starts from defaults when the server has never answered', async () => {
    const { remote } = setup({ fetchConfig: async () => { throw new Error('offline'); } });
    expect(await remote.refresh()).toBe(DEFAULT_CLIENT_CONFIG);
    expect(await remote.status()).toMatchObject({ source: 'default', lastError: 'unavailable' });
  });

  it('re-validates stored config and does not apply it to another API origin', async () => {
    const storage = memoryStorage({ [REMOTE_CONFIG_KEY]: { apiBaseUrl: 'https://other.example', fetchedAt: 1_000_000, raw: { schema: 1, revision: 'x', config: { disabledFeatures: ['compose_checks'] } } } });
    const { remote } = setup({ storage, fetchConfig: async () => { throw new Error('offline'); } });
    expect(await remote.current()).toBe(DEFAULT_CLIENT_CONFIG);
    const tampered = memoryStorage({ [REMOTE_CONFIG_KEY]: { apiBaseUrl: API, fetchedAt: 1_000_000, raw: { schema: 1, revision: 'x', config: { compose: { idleMs: 1 } } } } });
    expect((await setup({ storage: tampered }).remote.current()).compose.idleMs).toBe(450);
  });

  it('exposes emergency disables and version state', async () => {
    const { remote } = setup({ fetchConfig: async () => ({ schema: 1, revision: 'r', config: { disabledFeatures: ['prepared_drafts'], compatibility: { minimumVersion: '0.6.0', recommendedVersion: '0.6.1' } } }) });
    const config = await remote.refresh();
    expect(featureDisabled(config, 'prepared_drafts')).toBe(true);
    expect(featureDisabled(config, 'compose_checks')).toBe(false);
    expect(compatibilityFor(config, '0.5.8')).toBe('update_required');
    expect(compatibilityFor(config, '0.6.0')).toBe('update_recommended');
    expect(compatibilityFor(config, '0.6.1')).toBe('compatible');
  });
});
