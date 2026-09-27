import { beforeEach, describe, expect, it, vi } from 'vitest';
import { DEFAULT_SETTINGS } from '@pigeonbox/shared';

const session = vi.hoisted(() => ({ user: { id: 'user-a', email: 'ada@example.com' } as { id: string; email: string } | null }));

vi.mock('./cloud-session', () => ({
  CloudSessionManager: class {
    async currentUser() { return session.user; }
    client(base: string) {
      return {
        async capabilities() {
          return { plan: 'free', capabilities: base.includes('api-a') ? ['cloud_ai'] : [] };
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
  vi.stubGlobal('chrome', { runtime: { getManifest: () => ({ version: '0.2.0' }) }, storage: { local: storageArea(), session: storageArea() } });
  vi.resetModules();
});

describe('Cloud state cache', () => {
  it('drops a cached connected state when the session ends', async () => {
    const { readCloudState } = await import('./cloud');
    const settings = { ...DEFAULT_SETTINGS, cloudApiUrl: 'https://api-a.example' };
    expect((await readCloudState(settings)).status).toBe('ready');
    session.user = null;
    expect((await readCloudState(settings)).status).toBe('signed_out');
  });

  it('refreshes capabilities when the configured API changes', async () => {
    const { readCloudState } = await import('./cloud');
    const a = { ...DEFAULT_SETTINGS, cloudApiUrl: 'https://api-a.example' };
    const b = { ...DEFAULT_SETTINGS, cloudApiUrl: 'https://api-b.example' };
    expect((await readCloudState(a)).status).toBe('ready');
    expect((await readCloudState(b)).status).toBe('not_entitled');
  });
});
