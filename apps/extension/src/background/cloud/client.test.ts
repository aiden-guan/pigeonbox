import { beforeEach, describe, expect, it, vi } from 'vitest';
import { DEFAULT_SETTINGS } from '@pigeonbox/shared';

const session = vi.hoisted(() => ({
  user: { id: 'user-a', email: 'ada@example.com' } as { id: string; email: string } | null,
  config: null as unknown,
  capabilitiesError: null as unknown,
  capabilityCalls: 0,
}));

vi.mock('./session', () => ({
  CloudSessionManager: class {
    async currentUser() { return session.user; }
    client(base: string) {
      return {
        async capabilities() {
          session.capabilityCalls += 1;
          if (session.capabilitiesError) throw session.capabilitiesError;
          return { capabilities: base.includes('api-a') ? ['cloud_ai'] : [] };
        },
        async clientConfig() {
          if (!session.config) throw new Error('offline');
          return session.config;
        },
      };
    }
  },
}));

function storageArea() {
  const data = new Map<string, unknown>();
  return {
    async get(key: string) { return { [key]: data.get(key) }; },
    async set(items: Record<string, unknown>) {
      for (const [key, value] of Object.entries(items)) data.set(key, value);
    },
    async remove(key: string) { data.delete(key); },
  };
}

beforeEach(() => {
  session.user = { id: 'user-a', email: 'ada@example.com' };
  session.config = null;
  session.capabilitiesError = null;
  session.capabilityCalls = 0;
  vi.stubGlobal('chrome', { runtime: { getManifest: () => ({ version: '0.2.0' }) }, storage: { local: storageArea(), session: storageArea() } });
  vi.resetModules();
});

describe('Cloud state cache', () => {
  it('drops a cached connected state when the session ends', async () => {
    const { readCloudState } = await import('./client');
    const settings = { ...DEFAULT_SETTINGS, cloudApiUrl: 'https://api-a.example' };
    expect((await readCloudState(settings)).status).toBe('ready');
    session.user = null;
    expect((await readCloudState(settings)).status).toBe('signed_out');
  });

  it('refreshes capabilities when the configured API changes', async () => {
    const { readCloudState } = await import('./client');
    const a = { ...DEFAULT_SETTINGS, cloudApiUrl: 'https://api-a.example' };
    const b = { ...DEFAULT_SETTINGS, cloudApiUrl: 'https://api-b.example' };
    expect((await readCloudState(a)).status).toBe('ready');
    expect((await readCloudState(b)).status).toBe('not_entitled');
  });
});

describe('extension version compatibility', () => {
  const cloudMode = { ...DEFAULT_SETTINGS, runMode: 'cloud' as const, cloudApiUrl: 'https://api-a.example' };

  it('reports a required update, not an outage, and makes no request that would be refused', async () => {
    session.config = { schema: 1, revision: 'r', config: { compatibility: { minimumVersion: '0.3.0' } } };
    const { refreshCloudState } = await import('./client');
    const state = await refreshCloudState(cloudMode);
    expect(state).toMatchObject({ status: 'update_required', capabilities: [], update: { required: true, installed: '0.2.0', minimum: '0.3.0' } });
    expect(session.capabilityCalls).toBe(0);
  });

  it('turns a 426 from the server into a required update with the server minimum', async () => {
    const { CloudApiError } = await import('@pigeonbox/cloud-client');
    session.capabilitiesError = new CloudApiError({ code: 'unsupported_protocol', status: 426, message: 'Update', minimumVersion: '0.4.0' });
    const { refreshCloudState } = await import('./client');
    expect(await refreshCloudState(cloudMode)).toMatchObject({ status: 'update_required', update: { required: true, minimum: '0.4.0' } });
  });

  it('keeps Cloud working with a recommended update', async () => {
    session.config = { schema: 1, revision: 'r', config: { compatibility: { recommendedVersion: '0.2.1' } } };
    const { refreshCloudState } = await import('./client');
    expect(await refreshCloudState(cloudMode)).toMatchObject({ status: 'ready', update: { required: false, recommended: '0.2.1' } });
  });

  it('still says unreachable for a real outage, and works with no remote config at all', async () => {
    const { CloudApiError } = await import('@pigeonbox/cloud-client');
    const { refreshCloudState } = await import('./client');
    expect((await refreshCloudState(cloudMode)).status).toBe('ready');
    session.capabilitiesError = new CloudApiError({ code: 'network', message: 'down', retryable: true });
    const state = await refreshCloudState(cloudMode);
    expect(state.status).toBe('unreachable');
    expect(state.update).toBeUndefined();
  });

  it('never asks Cloud for config in Local mode', async () => {
    session.config = { schema: 1, revision: 'r', config: { compatibility: { minimumVersion: '9.0.0' } } };
    const { refreshCloudState } = await import('./client');
    expect((await refreshCloudState({ ...cloudMode, runMode: 'local' })).status).toBe('ready');
  });
});
