/** Set before chrome.runtime.reload() so the restarted worker can refresh Gmail. */
export const GMAIL_RELOAD_AFTER_RESTART_KEY = 'giReloadGmailAfterRestart';

type StorageArea = {
  get: (key: string) => Promise<Record<string, unknown>>;
  set: (items: Record<string, unknown>) => Promise<void>;
  remove: (key: string) => Promise<void>;
};

type ReloadChrome = {
  storage: { local: Pick<StorageArea, 'set'> };
  runtime: { reload: () => void };
};

type RefreshChrome = {
  storage: { local: Pick<StorageArea, 'get' | 'remove'> };
  tabs: {
    query: (query: { url: string }) => Promise<Array<{ id?: number }>>;
    reload: (tabId: number) => Promise<void> | void;
  };
};

export type RebuildResult = { ok: boolean; output?: string };

/** Thrown when the local dev-reload helper ran the build and it failed. */
export class RebuildFailedError extends Error {
  constructor(readonly output: string) {
    super('Extension build failed');
  }
}

/**
 * Ask the local `npm run dev:reload` helper to rebuild dist/. Returns null
 * when the helper is not running, so the caller can still do a plain reload.
 */
export async function rebuildWithDevHelper(
  baseUrl: string,
  fetchImpl: typeof fetch = fetch,
): Promise<RebuildResult | null> {
  let res: Response;
  try {
    res = await fetchImpl(`${baseUrl.replace(/\/+$/, '')}/rebuild`, { method: 'POST' });
  } catch {
    return null;
  }
  if (!res.ok) return null;
  const body = (await res.json().catch(() => null)) as RebuildResult | null;
  return body && typeof body.ok === 'boolean' ? body : null;
}

/**
 * Persist a one-shot flag, then restart the extension.
 * chrome://extensions reload leaves the open Gmail page on a dead content script.
 * The flag tells the new worker to refresh those tabs after it starts.
 *
 * With `devRebuildUrl` (dev builds only), first rebuild through the local
 * helper so the reload runs current source. A failed build throws
 * RebuildFailedError and leaves the running extension alone.
 */
export async function requestExtensionReload(
  api: ReloadChrome,
  options: { devRebuildUrl?: string; fetchImpl?: typeof fetch } = {},
): Promise<void> {
  if (options.devRebuildUrl) {
    const result = await rebuildWithDevHelper(options.devRebuildUrl, options.fetchImpl);
    if (result && !result.ok) throw new RebuildFailedError(result.output || '');
  }
  await api.storage.local.set({ [GMAIL_RELOAD_AFTER_RESTART_KEY]: true });
  api.runtime.reload();
}

export async function refreshGmailTabsAfterRestart(api: RefreshChrome): Promise<number> {
  const stored = await api.storage.local.get(GMAIL_RELOAD_AFTER_RESTART_KEY);
  if (stored[GMAIL_RELOAD_AFTER_RESTART_KEY] !== true) return 0;
  await api.storage.local.remove(GMAIL_RELOAD_AFTER_RESTART_KEY);
  const tabs = await api.tabs.query({ url: 'https://mail.google.com/*' });
  const ids = tabs.map((tab) => tab.id).filter((id): id is number => id != null);
  await Promise.all(ids.map((id) => api.tabs.reload(id)));
  return ids.length;
}
