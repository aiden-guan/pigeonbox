export const RELEASE_CHECK_PERMISSION = 'https://api.github.com/*';
export const RELEASE_CHECK_ALARM = 'pigeonbox-release-check';
export const RELEASE_STATUS_KEY = 'pigeonboxReleaseUpdateStatus';

// The repository also publishes non-extension releases (the launch film), so
// /releases/latest is not reliably an extension build. List recent releases and
// pick the highest stable vX.Y.Z tag instead.
const RELEASE_API_URL = 'https://api.github.com/repos/aiden-guan/pigeonbox/releases?per_page=30';
const RELEASES_URL = 'https://github.com/aiden-guan/pigeonbox/releases';

export type ReleaseUpdateStatus = {
  state: 'current' | 'available' | 'error' | 'permission_required';
  currentVersion: string;
  latestVersion?: string;
  releaseUrl?: string;
  downloadUrl?: string;
  message?: string;
  checkedAt: string | null;
};

type GitHubRelease = {
  tag_name?: unknown;
  draft?: unknown;
  prerelease?: unknown;
  assets?: Array<{ name?: unknown; browser_download_url?: unknown }>;
};

function hasReleasePermission(): Promise<boolean> {
  return new Promise((resolve) => {
    chrome.permissions.contains({ origins: [RELEASE_CHECK_PERMISSION] }, resolve);
  });
}

export function compareVersions(left: string, right: string): number | null {
  const parse = (value: string) => {
    const match = value.match(/^v?(\d+)\.(\d+)\.(\d+)$/);
    return match ? match.slice(1).map(Number) : null;
  };
  const a = parse(left);
  const b = parse(right);
  if (!a || !b) return null;
  for (let index = 0; index < 3; index += 1) {
    if (a[index] !== b[index]) return a[index] - b[index];
  }
  return 0;
}

const STABLE_TAG = /^v(\d+\.\d+\.\d+)$/;

/** The highest non-draft, non-prerelease release tagged vX.Y.Z, or null when there is none. */
export function pickLatestStableRelease(releases: unknown): (GitHubRelease & { tag_name: string }) | null {
  if (!Array.isArray(releases)) return null;
  let best: (GitHubRelease & { tag_name: string }) | null = null;
  for (const release of releases as GitHubRelease[]) {
    if (!release || typeof release.tag_name !== 'string' || !STABLE_TAG.test(release.tag_name)) continue;
    if (release.draft === true || release.prerelease === true) continue;
    if (!best || (compareVersions(release.tag_name, best.tag_name) ?? 0) > 0) {
      best = release as GitHubRelease & { tag_name: string };
    }
  }
  return best;
}

async function saveStatus(status: ReleaseUpdateStatus): Promise<ReleaseUpdateStatus> {
  await chrome.storage.local.set({ [RELEASE_STATUS_KEY]: status });
  return status;
}

export async function readReleaseUpdateStatus(): Promise<ReleaseUpdateStatus | null> {
  const stored = await chrome.storage.local.get(RELEASE_STATUS_KEY);
  const status = stored[RELEASE_STATUS_KEY] as ReleaseUpdateStatus | undefined;
  return status && typeof status === 'object' ? status : null;
}

export async function checkLatestRelease(): Promise<ReleaseUpdateStatus> {
  const currentVersion = chrome.runtime.getManifest().version;
  const checkedAt = new Date().toISOString();

  if (!(await hasReleasePermission())) {
    return saveStatus({
      state: 'permission_required',
      currentVersion,
      message: 'Allow GitHub access in Settings before checking for updates.',
      checkedAt: null,
    });
  }

  try {
    const response = await fetch(RELEASE_API_URL, {
      headers: {
        Accept: 'application/vnd.github+json',
        'X-GitHub-Api-Version': '2022-11-28',
      },
      cache: 'no-store',
    });
    if (!response.ok) {
      const message = response.status === 403 || response.status === 429
        ? 'GitHub is rate limiting update checks. Try again later.'
        : response.status === 404
          ? 'No published GitHub release was found.'
          : 'GitHub could not check for updates right now. Try again later.';
      return saveStatus({ state: 'error', currentVersion, message, checkedAt });
    }

    const release = pickLatestStableRelease(await response.json());
    if (!release) {
      return saveStatus({
        state: 'error',
        currentVersion,
        message: 'No published PigeonBox release was found.',
        checkedAt,
      });
    }
    const tag = release.tag_name;
    const version = tag.slice(1);

    const comparison = compareVersions(version, currentVersion);
    if (comparison === null) {
      return saveStatus({
        state: 'error',
        currentVersion,
        message: 'This PigeonBox version could not be compared with the latest release.',
        checkedAt,
      });
    }

    const releaseUrl = `${RELEASES_URL}/tag/${encodeURIComponent(tag)}`;
    if (comparison <= 0) {
      return saveStatus({ state: 'current', currentVersion, latestVersion: version, releaseUrl, checkedAt });
    }

    const assetName = `PigeonBox-${tag}.zip`;
    const expectedDownloadUrl = `${RELEASES_URL}/download/${encodeURIComponent(tag)}/${encodeURIComponent(assetName)}`;
    const hasPackage = release.assets?.some(
      (asset) => asset.name === assetName && asset.browser_download_url === expectedDownloadUrl,
    );
    if (!hasPackage) {
      return saveStatus({
        state: 'error',
        currentVersion,
        latestVersion: version,
        releaseUrl,
        message: 'The latest release ZIP is not available yet. Try again later.',
        checkedAt,
      });
    }

    return saveStatus({
      state: 'available',
      currentVersion,
      latestVersion: version,
      releaseUrl,
      downloadUrl: expectedDownloadUrl,
      checkedAt,
    });
  } catch {
    return saveStatus({
      state: 'error',
      currentVersion,
      message: 'Could not reach GitHub. Check your connection and try again.',
      checkedAt,
    });
  }
}

export function configureReleaseCheckAlarm(enabled: boolean): void {
  if (enabled) {
    chrome.alarms.create(RELEASE_CHECK_ALARM, { delayInMinutes: 24 * 60, periodInMinutes: 24 * 60 });
  } else {
    void chrome.alarms.clear(RELEASE_CHECK_ALARM);
  }
}
