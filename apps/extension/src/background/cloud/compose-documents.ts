import { DocumentLinkAssociateRequestSchema } from '@pigeonbox/api-contract';
import { cloudErrorMessage, type PigeonBoxCloudClient } from '@pigeonbox/cloud-client';
import { TrackingReceipts } from '../tracking/receipts';

type DocumentReceipt = { token: string; threadId: string };
export const documentReceipts = new TrackingReceipts<DocumentReceipt>('documentTrackingReceipts');
export async function flushDocumentReceipts(client: PigeonBoxCloudClient, scope: string): Promise<boolean> {
  return documentReceipts.flush(scope, async (_key, receipt) => { await client.call('documentLinkAssociate', receipt); });
}

/** Only fixed document operations; Gmail never receives the Cloud credential or an arbitrary upload URL. */
export async function composeDocument(message: Record<string, unknown>, client: PigeonBoxCloudClient, apiBase: string, scope?: string) {
  try {
    if (message.type === 'CLOUD_COMPOSE_DOCUMENT_SENT') {
      if (!Array.isArray(message.urls) || message.urls.length > 20 || !message.urls.length)
        return { ok: false, reason: 'Invalid document links.' };
      const requests = message.urls.map(raw => {
        const url = new URL(String(raw));
        if (url.origin !== new URL(apiBase).origin || url.username || url.password || url.search || url.hash) throw new Error('Invalid document origin');
        return DocumentLinkAssociateRequestSchema.safeParse({ token: url.pathname.match(/^\/d\/([A-Za-z0-9_-]{32})$/)?.[1], threadId: message.threadId });
      });
      if (requests.some(result => !result.success)) return { ok: false, reason: 'Invalid document receipt.' };
      if (scope) {
        for (const result of requests) if (result.success) await documentReceipts.save(scope, `${result.data.token}:${result.data.threadId}`, result.data);
        const synced = await flushDocumentReceipts(client, scope);
        return { ok: true, pending: !synced };
      }
      for (const result of requests) if (result.success) await client.call('documentLinkAssociate', result.data);
      return { ok: true };
    }
    if (typeof message.filename !== 'string' || !message.filename.trim() || message.filename.length > 255 ||
      typeof message.bytes !== 'string' || message.bytes.length > 26_666_668 || !/^(?:[A-Za-z0-9+/]{4})*(?:[A-Za-z0-9+/]{2}==|[A-Za-z0-9+/]{3}=)?$/.test(message.bytes))
      return { ok: false, reason: 'Choose a PDF up to 20 MB.' };
    const raw = atob(message.bytes);
    if (!raw.startsWith('%PDF-') || raw.length > 20_000_000) return { ok: false, reason: 'Choose a PDF up to 20 MB.' };
    const bytes = Uint8Array.from(raw, character => character.charCodeAt(0));
    const title = message.filename.replace(/\.pdf$/i, '') || message.filename;
    const created = await client.call('documentCreate', { title, filename: message.filename });
    await client.uploadDocument(created.document.id, bytes);
    const { link } = await client.call('documentLinkCreate', { documentId: created.document.id, allowDownload: true, watermark: false });
    return { ok: true, link: { id: link.id, url: link.url } };
  } catch (error) { return { ok: false, reason: cloudErrorMessage(error).message }; }
}
