import type { PigeonBoxCloudClient } from '@pigeonbox/cloud-client';
import { cloudApiUrl } from '../../config';

/** The content script gets a short-lived preview, never the account credential. */
export async function resolveSenderDocumentLink(settings: { cloudApiUrl: string }, raw: string, getClient: () => PigeonBoxCloudClient | null): Promise<string | null> {
  try {
    const base = cloudApiUrl(settings);
    if (!base) return null;
    const url = new URL(raw);
    const token = url.pathname.match(/^\/d\/([A-Za-z0-9_-]{32})$/)?.[1];
    if (!token || url.origin !== new URL(base).origin || url.username || url.password || url.search || url.hash) return null;
    const preview = await getClient()?.call('documentPreview', { token });
    if (!preview?.url) return null;
    const destination = new URL(preview.url);
    if (destination.origin !== url.origin || destination.pathname !== url.pathname || destination.search || destination.username || destination.password || !/^#preview=[A-Za-z0-9_-]+$/.test(destination.hash)) return null;
    return destination.href;
  } catch { return null; }
}
