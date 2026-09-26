import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { checkLatestRelease, compareVersions, pickLatestStableRelease, RELEASE_STATUS_KEY } from './release-updates';

const DOWNLOADS = 'https://github.com/aiden-guan/pigeonbox/releases/download';

function release(tag: string, extra: Record<string, unknown> = {}) {
  return {
    tag_name: tag,
    draft: false,
    prerelease: false,
    assets: [{ name: `PigeonBox-${tag}.zip`, browser_download_url: `${DOWNLOADS}/${tag}/PigeonBox-${tag}.zip` }],
    ...extra,
  };
}

let stored: Record<string, unknown>;
let permitted: boolean;

beforeEach(() => {
  stored = {};
  permitted = true;
  (globalThis as unknown as { chrome: unknown }).chrome = {
    runtime: { getManifest: () => ({ version: '0.2.0' }) },
    permissions: { contains: (_: unknown, resolve: (ok: boolean) => void) => resolve(permitted) },
    storage: {
      local: {
        set: async (items: Record<string, unknown>) => Object.assign(stored, items),
        get: async (key: string) => ({ [key]: stored[key] }),
      },
    },
  };
});

afterEach(() => vi.unstubAllGlobals());

function respondWith(body: unknown, status = 200) {
  const fetchMock = vi.fn(async () => new Response(JSON.stringify(body), { status }));
  vi.stubGlobal('fetch', fetchMock);
  return fetchMock;
}

describe('compareVersions', () => {
  it('compares numerically, not lexically', () => {
    expect(compareVersions('0.10.0', '0.9.0')).toBeGreaterThan(0);
    expect(compareVersions('v1.0.0', '1.0.0')).toBe(0);
    expect(compareVersions('launch-film-v1', '1.0.0')).toBeNull();
  });
});

describe('pickLatestStableRelease', () => {
  it('ignores non-version tags, drafts and prereleases', () => {
    const picked = pickLatestStableRelease([
      { tag_name: 'launch-film-v1', draft: false, prerelease: false, assets: [] },
      release('v0.4.0', { prerelease: true }),
      release('v0.5.0', { draft: true }),
      release('v0.2.0'),
      release('v0.3.0'),
    ]);
    expect(picked?.tag_name).toBe('v0.3.0');
  });

  it('returns null when nothing qualifies', () => {
    expect(pickLatestStableRelease([{ tag_name: 'launch-film-v1' }])).toBeNull();
    expect(pickLatestStableRelease({ message: 'Not Found' })).toBeNull();
  });
});

describe('checkLatestRelease', () => {
  it('does not contact GitHub without permission', async () => {
    permitted = false;
    const fetchMock = respondWith([]);
    const status = await checkLatestRelease();
    expect(status.state).toBe('permission_required');
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it('offers the release ZIP when a newer version is published', async () => {
    respondWith([{ tag_name: 'launch-film-v1', assets: [] }, release('v0.3.0'), release('v0.2.0')]);
    const status = await checkLatestRelease();
    expect(status).toMatchObject({
      state: 'available',
      currentVersion: '0.2.0',
      latestVersion: '0.3.0',
      downloadUrl: `${DOWNLOADS}/v0.3.0/PigeonBox-v0.3.0.zip`,
    });
    expect(stored[RELEASE_STATUS_KEY]).toEqual(status);
  });

  it('reports up to date when the installed version is the newest', async () => {
    respondWith([{ tag_name: 'launch-film-v1', assets: [] }, release('v0.2.0')]);
    expect((await checkLatestRelease()).state).toBe('current');
  });

  it('waits for the ZIP asset before offering a download', async () => {
    respondWith([release('v0.3.0', { assets: [] })]);
    const status = await checkLatestRelease();
    expect(status.state).toBe('error');
    expect(status.downloadUrl).toBeUndefined();
  });

  it('rejects an asset whose download URL points somewhere else', async () => {
    respondWith([release('v0.3.0', { assets: [{ name: 'PigeonBox-v0.3.0.zip', browser_download_url: 'https://evil.example/x.zip' }] })]);
    expect((await checkLatestRelease()).state).toBe('error');
  });

  it('explains rate limiting', async () => {
    respondWith({ message: 'rate limited' }, 403);
    expect((await checkLatestRelease()).message).toMatch(/rate limiting/);
  });

  it('reports an error when no extension release exists', async () => {
    respondWith([{ tag_name: 'launch-film-v1', assets: [] }]);
    expect(await checkLatestRelease()).toMatchObject({ state: 'error', message: 'No published PigeonBox release was found.' });
  });
});
