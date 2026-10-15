import { afterEach, expect, it, vi } from 'vitest';
import type { PigeonBoxCloudClient } from '@pigeonbox/cloud-client';
import { composeDocument } from './compose-documents';
const documentId = '00000000-0000-4000-8000-000000000001';
const linkId = '00000000-0000-4000-8000-000000000002';
const apiBase = 'https://cloud.test';
const token = 'a'.repeat(32);
afterEach(() => vi.restoreAllMocks());
it('uses the existing private upload and a downloadable link without sending mail or exposing credentials', async () => {
  const call = vi.fn(async (route: string) => route === 'documentCreate' ? { document: { id: documentId } } : { link: { id: linkId, url: 'https://cloud.test/d/token', token: 'never-return-this' } });
  const uploadDocument = vi.fn(async () => ({}));
  const client = { call, uploadDocument } as unknown as PigeonBoxCloudClient;
  expect(await composeDocument({ type: 'CLOUD_COMPOSE_DOCUMENT', filename: 'Proposal.pdf', bytes: btoa('%PDF-1.7\nfixture') }, client, apiBase)).toEqual({ ok: true, link: { id: linkId, url: 'https://cloud.test/d/token' } });
  expect(call.mock.calls).toEqual([
    ['documentCreate', { title: 'Proposal', filename: 'Proposal.pdf' }],
    ['documentLinkCreate', { documentId, allowDownload: true, watermark: false }],
  ]);
  expect(uploadDocument).toHaveBeenCalledWith(documentId, new TextEncoder().encode('%PDF-1.7\nfixture'));
  expect(await composeDocument({ type: 'CLOUD_COMPOSE_DOCUMENT_SENT', threadId: 'abc123', urls: [`${apiBase}/d/${token}`] }, client, apiBase)).toEqual({ ok: true });
  expect(call).toHaveBeenLastCalledWith('documentLinkAssociate', { token, threadId: 'abc123' });
});
it('rejects malformed files and receipt IDs before an API call', async () => {
  const call = vi.fn(); const uploadDocument = vi.fn();
  const client = { call, uploadDocument } as unknown as PigeonBoxCloudClient;
  for (const bytes of ['!invalid', btoa('not pdf'), '', btoa('%PDF-1.7') + '='])
    expect(await composeDocument({ type: 'CLOUD_COMPOSE_DOCUMENT', filename: 'File.pdf', bytes }, client, apiBase)).toMatchObject({ ok: false });
  for (const url of ['foreign', `https://evil.test/d/${token}`, `${apiBase}/d/${token}#preview=secret`, `${apiBase}/d/${token}?secret=foo`, `${apiBase}/d/invalid`])
    expect(await composeDocument({ type: 'CLOUD_COMPOSE_DOCUMENT_SENT', threadId: 'abc123', urls: [url] }, client, apiBase)).toMatchObject({ ok: false });
  expect(call).not.toHaveBeenCalled(); expect(uploadDocument).not.toHaveBeenCalled();
});
