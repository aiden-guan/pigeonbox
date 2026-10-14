/**
 * "Update PigeonBox" when PigeonBox Cloud needs a newer extension.
 *
 * Chrome Web Store copies ask Chrome for the update and restart into it when
 * one is ready; otherwise (review still pending, or an unpacked copy) the
 * person is sent to where the newer version is published. Nothing here
 * downloads or installs code itself.
 */
import { chromeManagesUpdates } from './release-updates';

export const WEB_STORE_URL = 'https://chromewebstore.google.com/detail/hmoiiokfmacghpddabpgaajolbeljhcp';
export const GITHUB_RELEASES_URL = 'https://github.com/aiden-guan/pigeonbox/releases';

export type ExtensionUpdateResult = { ok: true; outcome: 'restarting' | 'opened_store' | 'opened_releases' | 'throttled' };

type Deps = {
  managedByStore: () => Promise<boolean>;
  requestUpdateCheck: () => Promise<{ status: string }>;
  reload: () => void;
  openTab: (url: string) => Promise<unknown>;
};

const defaults: Deps = {
  managedByStore: chromeManagesUpdates,
  requestUpdateCheck: async () => {
    const result = (await chrome.runtime.requestUpdateCheck()) as unknown;
    // Chrome resolves either an object or, in older versions, a [status] tuple.
    return Array.isArray(result) ? { status: String(result[0]) } : (result as { status: string });
  },
  reload: () => chrome.runtime.reload(),
  openTab: (url) => chrome.tabs.create({ url }),
};

export async function requestExtensionUpdate(deps: Deps = defaults): Promise<ExtensionUpdateResult> {
  if (!(await deps.managedByStore().catch(() => false))) {
    await deps.openTab(GITHUB_RELEASES_URL);
    return { ok: true, outcome: 'opened_releases' };
  }
  const { status } = await deps.requestUpdateCheck().catch(() => ({ status: 'error' }));
  if (status === 'update_available') {
    // Chrome installs the downloaded update when the extension restarts.
    setTimeout(() => deps.reload(), 250);
    return { ok: true, outcome: 'restarting' };
  }
  if (status === 'throttled') return { ok: true, outcome: 'throttled' };
  await deps.openTab(WEB_STORE_URL);
  return { ok: true, outcome: 'opened_store' };
}
