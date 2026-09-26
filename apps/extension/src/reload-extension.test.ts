import { describe, expect, it, vi } from 'vitest';
import {
  GMAIL_RELOAD_AFTER_RESTART_KEY,
  RebuildFailedError,
  refreshGmailTabsAfterRestart,
  requestExtensionReload,
} from './reload-extension';

describe('extension reload', () => {
  it('stores a one-shot flag and then restarts the extension', async () => {
    const set = vi.fn(async () => undefined);
    const reload = vi.fn();
    await requestExtensionReload({
      storage: { local: { set } },
      runtime: { reload },
    });
    expect(set).toHaveBeenCalledWith({ [GMAIL_RELOAD_AFTER_RESTART_KEY]: true });
    expect(reload).toHaveBeenCalledOnce();
    expect(set.mock.invocationCallOrder[0]).toBeLessThan(reload.mock.invocationCallOrder[0]);
  });

  it('rebuilds through the dev helper before restarting', async () => {
    const set = vi.fn(async () => undefined);
    const reload = vi.fn();
    const fetchImpl = vi.fn(async () => new Response(JSON.stringify({ ok: true }))) as unknown as typeof fetch;
    await requestExtensionReload(
      { storage: { local: { set } }, runtime: { reload } },
      { devRebuildUrl: 'http://127.0.0.1:5199/', fetchImpl },
    );
    expect(fetchImpl).toHaveBeenCalledWith('http://127.0.0.1:5199/rebuild', { method: 'POST' });
    expect(reload).toHaveBeenCalledOnce();
  });

  it('keeps the running extension when the rebuild fails', async () => {
    const set = vi.fn(async () => undefined);
    const reload = vi.fn();
    const fetchImpl = vi.fn(
      async () => new Response(JSON.stringify({ ok: false, output: 'error TS2322' })),
    ) as unknown as typeof fetch;
    await expect(
      requestExtensionReload(
        { storage: { local: { set } }, runtime: { reload } },
        { devRebuildUrl: 'http://127.0.0.1:5199', fetchImpl },
      ),
    ).rejects.toBeInstanceOf(RebuildFailedError);
    expect(set).not.toHaveBeenCalled();
    expect(reload).not.toHaveBeenCalled();
  });

  it('falls back to a plain reload when the dev helper is not running', async () => {
    const set = vi.fn(async () => undefined);
    const reload = vi.fn();
    const fetchImpl = vi.fn(async () => {
      throw new TypeError('Failed to fetch');
    }) as unknown as typeof fetch;
    await requestExtensionReload(
      { storage: { local: { set } }, runtime: { reload } },
      { devRebuildUrl: 'http://127.0.0.1:5199', fetchImpl },
    );
    expect(reload).toHaveBeenCalledOnce();
  });

  it('refreshes open Gmail tabs once after restart and clears the flag first', async () => {
    const store = new Map<string, unknown>([[GMAIL_RELOAD_AFTER_RESTART_KEY, true]]);
    const reload = vi.fn(async () => undefined);
    const refreshed = await refreshGmailTabsAfterRestart({
      storage: {
        local: {
          get: async (key) => ({ [key]: store.get(key) }),
          remove: async (key) => {
            store.delete(key);
          },
        },
      },
      tabs: {
        query: async () => [{ id: 4 }, { id: 9 }, {}],
        reload,
      },
    });
    expect(refreshed).toBe(2);
    expect(reload).toHaveBeenCalledWith(4);
    expect(reload).toHaveBeenCalledWith(9);
    expect(store.has(GMAIL_RELOAD_AFTER_RESTART_KEY)).toBe(false);

    const again = await refreshGmailTabsAfterRestart({
      storage: {
        local: {
          get: async (key) => ({ [key]: store.get(key) }),
          remove: async (key) => {
            store.delete(key);
          },
        },
      },
      tabs: {
        query: async () => [{ id: 4 }],
        reload,
      },
    });
    expect(again).toBe(0);
    expect(reload).toHaveBeenCalledTimes(2);
  });
});
