/**
 * End to end with the real public extension client (@pigeonbox/cloud-client)
 * against this server: proves the client and server agree on the contract.
 */
import { describe, expect, it } from 'vitest';
import { CloudApiError, PigeonBoxCloudClient, cloudErrorMessage, createCloudAIProvider } from '@pigeonbox/cloud-client';
import { API, THREAD, VOICE, createHarness } from './testing.js';

function clientFor(h: ReturnType<typeof createHarness>, token: () => string | null) {
  return new PigeonBoxCloudClient({
    baseUrl: API,
    clientName: 'extension/test',
    fetch: ((input: RequestInfo | URL, init?: RequestInit) => h.api(new Request(String(input), init))) as typeof fetch,
    tokens: { get: async () => token(), refresh: async () => null },
  });
}

describe('extension client ↔ server API', () => {
  it('runs the extension’s AIProvider against the server', async () => {
    const h = createHarness();
    const session = await h.signIn('ada@example.com');
    const client = clientFor(h, () => session.accessToken);

    expect((await client.health()).ok).toBe(true);
    expect((await client.capabilities()).capabilities).toContain('cloud_ai');
    const ai = createCloudAIProvider(client);
    expect((await ai.summarizeThread(THREAD)).result.oneLine).toMatch(/Mock summary/);
    expect((await ai.draftReply({ ...THREAD, voice: VOICE, kind: 'reply' })).result.body).toContain('Ada');
    expect((await ai.draftFollowUp({ ...THREAD, voice: VOICE, kind: 'follow_up' })).result.body.length).toBeGreaterThan(10);
    expect((await ai.classifyEmail({ subject: 'x', snippet: 'y', bodyText: 'z', latestSender: 'a@example.com', direction: 'inbound' })).result.category).toBe('RESPOND');
    expect((await ai.rewriteText({ text: 'hello', mode: 'shorten' })).result).toBeTruthy();
    expect((await ai.answerMailboxQuery({ query: 'q', contextChunks: [], coverageNote: '' })).result.answer).toBeTruthy();
    expect((await ai.embed(['a', 'b'])).vectors).toHaveLength(2);
  });

  it('surfaces entitlement and signed-out states the way the extension expects', async () => {
    const h = createHarness();
    const session = await h.signIn('ada@example.com');
    // Taken off the access list after signing in; entitlements refuse an API token's requests the same way.
    h.config.allowedEmails.splice(0, Infinity, 'bob@example.com');
    const ai = createCloudAIProvider(clientFor(h, () => session.accessToken));
    const error = await ai.summarizeThread(THREAD).catch((e: unknown) => e);
    expect(error).toBeInstanceOf(CloudApiError);
    expect(cloudErrorMessage(error).action).toBe('switch_to_local');

    const signedOut = createCloudAIProvider(clientFor(h, () => null));
    expect(cloudErrorMessage(await signedOut.summarizeThread(THREAD).catch((e: unknown) => e)).action).toBe('sign_in');
  });

  it('a server outage is a clean client error, not a crash', async () => {
    const client = new PigeonBoxCloudClient({
      baseUrl: API,
      fetch: (async () => {
        throw new TypeError('connection refused');
      }) as unknown as typeof fetch,
      tokens: { get: async () => 't', refresh: async () => null },
    });
    const error = await createCloudAIProvider(client).summarizeThread(THREAD).catch((e: unknown) => e);
    expect(cloudErrorMessage(error)).toEqual({ message: 'Your PigeonBox server is unavailable. Nothing was sent to another provider.', action: 'switch_to_local' });
  });
});
