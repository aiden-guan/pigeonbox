import { afterEach, expect, it, vi } from 'vitest';
import { OpenAICompatibleEndpointProvider } from './index';

afterEach(() => vi.unstubAllGlobals());
it('does not follow redirects with mailbox content or expose provider response bodies in errors', async () => {
  const fetcher = vi.fn<typeof fetch>().mockResolvedValue(new Response('private email echoed by provider', { status: 502 }));
  vi.stubGlobal('fetch', fetcher);
  const provider = new OpenAICompatibleEndpointProvider({ endpoint: 'https://provider.test/v1', apiKey: 'private-key', model: 'test' });
  await expect(provider.answerMailboxQuery({ query: 'Hi', contextChunks: [], coverageNote: 'complete' })).rejects.toThrow(/^AI provider error 502$/);
  await expect(provider.embed(['private mail'])).rejects.toThrow(/^embed error 502$/);
  expect(fetcher).toHaveBeenCalledTimes(2);
  for (const [, init] of fetcher.mock.calls) expect(init).toMatchObject({ credentials: 'omit', redirect: 'error' });
});
