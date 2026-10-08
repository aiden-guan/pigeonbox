import { expect, it, vi } from 'vitest';
import type { PigeonBoxCloudClient } from '@pigeonbox/cloud-client';
import { resolveSenderDocumentLink } from './document-preview';
const token = 'x'.repeat(32);
const url = `https://cloud.test/d/${token}`;
const settings = { cloudApiUrl: 'https://cloud.test' };
it('resolves only the configured Cloud owner link and exposes no account credentials', async () => {
  const call = vi.fn(async () => ({ url: `${url}#preview=sealed_proof` }));
  const client = () => ({ call }) as unknown as PigeonBoxCloudClient;
  expect(await resolveSenderDocumentLink(settings, url, client)).toBe(`${url}#preview=sealed_proof`);
  expect(call).toHaveBeenCalledWith('documentPreview', { token });
  call.mockClear();
  for (const invalid of [`https://evil.test/d/${token}`, url + '?q=1', url + '#preview=x', 'https://cloud.test/d/short', `https://user@cloud.test/d/${token}`]) expect(await resolveSenderDocumentLink(settings, invalid, client)).toBeNull();
  expect(call).not.toHaveBeenCalled();
});
it('fails safely for recipients, invalid previews and an unavailable account', async () => {
  for (const result of [null, 'https://evil.test/d/' + token + '#preview=proof', url + '?x=1#preview=proof', url + '#unknown=proof']) {
    const client = () => ({ call: async () => ({ url: result }) }) as unknown as PigeonBoxCloudClient;
    expect(await resolveSenderDocumentLink(settings, url, client)).toBeNull();
  }
  expect(await resolveSenderDocumentLink(settings, url, () => null)).toBeNull();
});
