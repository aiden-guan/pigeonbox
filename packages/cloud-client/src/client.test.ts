import { describe, expect, it, vi } from 'vitest';
import { PROTOCOL_HEADER, PROTOCOL_VERSION } from '@pigeonbox/api-contract';
import { CloudApiError, InflightCache, PigeonBoxCloudClient, cloudErrorMessage, createCloudAIProvider, createPkcePair, normalizeBaseUrl, pkceChallenge } from './index';

function json(body: unknown, status = 200, headers: Record<string, string> = {}): Response {
  return new Response(JSON.stringify(body), { status, headers: { 'Content-Type': 'application/json', ...headers } });
}

const summary = {
  oneLine: 'Dana asks for the slides.',
  keyPoints: ['Slides from Tuesday'],
  decisions: [],
  unansweredQuestions: [],
  commitments: [],
  dates: [],
  actionItems: ['Send slides'],
};

describe('normalizeBaseUrl', () => {
  it('accepts https and loopback http only', () => {
    expect(normalizeBaseUrl('https://api.example.com/')).toBe('https://api.example.com');
    expect(normalizeBaseUrl('http://127.0.0.1:8788')).toBe('http://127.0.0.1:8788');
    expect(normalizeBaseUrl('http://api.example.com')).toBeNull();
    expect(normalizeBaseUrl('https://user:pass@api.example.com')).toBeNull();
    expect(normalizeBaseUrl('')).toBeNull();
    expect(normalizeBaseUrl('javascript:alert(1)')).toBeNull();
  });

  it('refuses to build a client without a URL', () => {
    expect(() => new PigeonBoxCloudClient({ baseUrl: '' })).toThrow(CloudApiError);
  });
});

describe('PigeonBoxCloudClient', () => {
  it('uses bounded, validated authenticated memory controls without exposing SQL internals', async () => {
    const paths: string[] = [];
    const id = '11111111-1111-4111-8111-111111111111';
    const memory = {id,kind: 'semantic',category: 'classes',text: 'Professor Smith teaches MATH 52.',confidence: 0.9,status: 'active',validFrom: '2026-10-01T10:00:00Z',validUntil: null,lastConfirmedAt: '2026-10-01T10:00:00Z',corrected: false,entities: [],sources: []};
    const request = vi.fn(async (url: RequestInfo | URL,init?: RequestInit) => {
      expect((init!.headers as Record<string,string>).Authorization).toBe('Bearer fixture');
      const path = new URL(String(url)).pathname; paths.push(path);
      const body = JSON.parse(String(init!.body)) as Record<string,unknown>;
      if (path.endsWith('/list')) { expect(body.limit).toBe(20); return json({memories: [memory],nextCursor: null}); }
      if (path.endsWith('/get') || path.endsWith('/update')) return json({memory});
      if (path.endsWith('/purge')) { expect(body.confirm).toBe('forget all memories'); return json({removed: 1}); }
      return json({ok: true});
    });
    const client = new PigeonBoxCloudClient({baseUrl: 'https://cloud.test',fetch: request,tokens: {get: async () => 'fixture',refresh: async () => null}});
    expect((await client.listMemories({query: 'Professor'})).memories[0]!.text).toContain('MATH 52');
    await client.getMemory({memoryId: id}); await client.correctMemory({memoryId: id,text: 'Professor Smith teaches MATH 53.'});
    await client.forgetMemory({memoryId: id}); await client.purgeMemories({confirm: 'forget all memories'});
    expect(paths).toEqual(['/v1/memory/list','/v1/memory/get','/v1/memory/update','/v1/memory/forget','/v1/memory/purge']);
    await expect(client.forgetMemory({memoryId: 'not-a-uuid'})).rejects.toMatchObject({code: 'invalid_request'});
    expect(request).toHaveBeenCalledTimes(5);
  });
  it('sends the protocol header and bearer token and validates the response', async () => {
    const fetchMock = vi.fn(async (_url: RequestInfo | URL, init?: RequestInit) => {
      const headers = init!.headers as Record<string, string>;
      expect(headers[PROTOCOL_HEADER]).toBe(String(PROTOCOL_VERSION));
      expect(headers.Authorization).toBe('Bearer tok_1');
      expect(init!.credentials).toBe('omit');
      return json({ result: summary, usage: { inputTokens: 10, outputTokens: 5 } });
    });
    const client = new PigeonBoxCloudClient({
      baseUrl: 'https://api.example.com',
      fetch: fetchMock as unknown as typeof fetch,
      tokens: { get: async () => 'tok_1', refresh: async () => null },
    });
    const response = await client.call('summarize', {
      input: { subject: 'Slides', messages: [{ sender: 'dana@example.com', bodyText: 'Send slides?', timestamp: '' }] },
    });
    expect(response.result.oneLine).toBe(summary.oneLine);
    expect(fetchMock).toHaveBeenCalledWith('https://api.example.com/v1/ai/summarize', expect.anything());
  });

  it('does not call the network when signed out', async () => {
    const fetchMock = vi.fn();
    const client = new PigeonBoxCloudClient({
      baseUrl: 'https://api.example.com',
      fetch: fetchMock as unknown as typeof fetch,
      tokens: { get: async () => null, refresh: async () => null },
    });
    await expect(client.me()).rejects.toMatchObject({ code: 'signed_out' });
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it('refreshes once after a 401 and retries with the new token', async () => {
    const seen: string[] = [];
    const fetchMock = vi.fn(async (_url: RequestInfo | URL, init?: RequestInit) => {
      const auth = (init!.headers as Record<string, string>).Authorization;
      seen.push(auth);
      if (auth === 'Bearer old') return json({ error: { code: 'invalid_token', message: 'expired', retryable: false } }, 401);
      return json({ user: { id: 'u1', email: 'a@example.com' }, plan: 'cloud', subscription: { status: 'active', currentPeriodEnd: null, cancelAtPeriodEnd: false } });
    });
    const refresh = vi.fn(async () => 'new');
    const client = new PigeonBoxCloudClient({
      baseUrl: 'https://api.example.com',
      fetch: fetchMock as unknown as typeof fetch,
      tokens: { get: async () => 'old', refresh },
    });
    const me = await client.me();
    expect(me.user.id).toBe('u1');
    expect(refresh).toHaveBeenCalledTimes(1);
    expect(seen).toEqual(['Bearer old', 'Bearer new']);
  });

  it('reports signed_out when the refresh fails', async () => {
    const client = new PigeonBoxCloudClient({
      baseUrl: 'https://api.example.com',
      fetch: (async () => json({ error: { code: 'invalid_token', message: 'x', retryable: false } }, 401)) as unknown as typeof fetch,
      tokens: { get: async () => 'old', refresh: async () => null },
    });
    await expect(client.capabilities()).rejects.toMatchObject({ code: 'signed_out' });
  });

  it('normalizes server errors with request ids', async () => {
    const client = new PigeonBoxCloudClient({
      baseUrl: 'https://api.example.com',
      fetch: (async () =>
        json({ error: { code: 'entitlement_required', message: 'Subscribe', retryable: false, requestId: 'req_9' } }, 402)) as unknown as typeof fetch,
      tokens: { get: async () => 't', refresh: async () => null },
    });
    const error = await client.entitlements().catch((e: unknown) => e);
    expect(error).toBeInstanceOf(CloudApiError);
    expect(error).toMatchObject({ code: 'entitlement_required', status: 402, requestId: 'req_9', retryable: false });
    expect(cloudErrorMessage(error).action).toBe('subscribe');
  });

  it('treats a non-JSON 5xx as a retryable internal error', async () => {
    const client = new PigeonBoxCloudClient({
      baseUrl: 'https://api.example.com',
      fetch: (async () => new Response('<html>bad gateway</html>', { status: 502, headers: { 'x-request-id': 'req_2' } })) as unknown as typeof fetch,
    });
    await expect(client.health()).rejects.toMatchObject({ code: 'internal', retryable: true, requestId: 'req_2' });
  });

  it('rejects a response that does not match the contract', async () => {
    const client = new PigeonBoxCloudClient({
      baseUrl: 'https://api.example.com',
      fetch: (async () => json({ ok: 'yes' })) as unknown as typeof fetch,
    });
    await expect(client.health()).rejects.toMatchObject({ code: 'invalid_response' });
  });

  it('maps network failures and timeouts', async () => {
    const offline = new PigeonBoxCloudClient({
      baseUrl: 'https://api.example.com',
      fetch: (async () => {
        throw new TypeError('Failed to fetch');
      }) as unknown as typeof fetch,
    });
    await expect(offline.health()).rejects.toMatchObject({ code: 'network', retryable: true });
    const slow = new PigeonBoxCloudClient({
      baseUrl: 'https://api.example.com',
      timeoutMs: 5,
      fetch: ((_u: RequestInfo | URL, init?: RequestInit) =>
        new Promise((_resolve, reject) => {
          init!.signal!.addEventListener('abort', () => reject(init!.signal!.reason));
        })) as unknown as typeof fetch,
    });
    await expect(slow.health()).rejects.toMatchObject({ code: 'timeout' });
  });

  it('validates requests before sending', async () => {
    const fetchMock = vi.fn();
    const client = new PigeonBoxCloudClient({
      baseUrl: 'https://api.example.com',
      fetch: fetchMock as unknown as typeof fetch,
      tokens: { get: async () => 't', refresh: async () => null },
    });
    await expect(client.call('ask', { input: { query: '', contextChunks: [], coverageNote: '' } })).rejects.toMatchObject({ code: 'invalid_request' });
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it('builds the authorize URL without contacting the server', () => {
    const client = new PigeonBoxCloudClient({ baseUrl: 'https://api.example.com' });
    const url = new URL(client.authorizeUrl({ redirectUri: 'https://abc.chromiumapp.org/cloud', codeChallenge: 'c'.repeat(43), state: 's'.repeat(20) }));
    expect(url.pathname).toBe('/v1/auth/authorize');
    expect(url.searchParams.get('code_challenge_method')).toBe('S256');
  });
});

describe('createCloudAIProvider', () => {
  it('maps AIProvider calls to contract routes and usage', async () => {
    const paths: string[] = [];
    const client = new PigeonBoxCloudClient({
      baseUrl: 'https://api.example.com',
      fetch: (async (url: RequestInfo | URL, init?: RequestInit) => {
        const path = new URL(String(url)).pathname;
        paths.push(path);
        const body = JSON.parse(String(init!.body));
        if (path === '/v1/ai/follow-up') expect(body.input.kind).toBe('follow_up');
        if (path.endsWith('draft') || path.endsWith('follow-up')) return json({ result: { mode: 'direct', body: 'Sure, sending now.', placeholders: [] } });
        return json({ result: 'Shorter text.', usage: { totalTokens: 7 } });
      }) as unknown as typeof fetch,
      tokens: { get: async () => 't', refresh: async () => null },
    });
    const ai = createCloudAIProvider(client);
    const voice = { name: 'Ada', about: '', greeting: 'Hi', signoff: 'Thanks', concision: 'short' as const, capitalization: 'normal' as const, formality: 'neutral' as const, emoji: false, schedulingPreference: '', personalInstructions: '' };
    const messages = [{ sender: 'dana@example.com', bodyText: 'Slides?', timestamp: '' }];
    expect((await ai.draftReply({ subject: 's', messages, voice, kind: 'reply' })).result.body).toBe('Sure, sending now.');
    await ai.draftFollowUp({ subject: 's', messages, voice, kind: 'reply' });
    const rewritten = await ai.rewriteText({ text: 'Long text', mode: 'shorten' });
    expect(rewritten).toEqual({ result: 'Shorter text.', usage: { promptTokens: undefined, completionTokens: undefined, totalTokens: 7 } });
    expect(paths).toEqual(['/v1/ai/draft', '/v1/ai/follow-up', '/v1/ai/rewrite']);
  });
});

describe('pkce', () => {
  it('matches the RFC 7636 appendix B example', async () => {
    expect(await pkceChallenge('dBjftJeZ4CVP-mB92K27uhbUJU1p1r_wW1gFWFOEjXk')).toBe('E9Melhoa2OwvFrEMTJguCHaoeK1t8URWbuGJSstw-cM');
  });

  it('creates verifiers within the allowed length', async () => {
    const pair = await createPkcePair();
    expect(pair.verifier.length).toBeGreaterThanOrEqual(43);
    expect(pair.verifier.length).toBeLessThanOrEqual(128);
    expect(pair.challenge).toBe(await pkceChallenge(pair.verifier));
  });
});

describe('cancellation and de-duplication', () => {
  it('reports an aborted call as aborted, not as an outage', async () => {
    const controller = new AbortController();
    const fetchImpl = ((_input: RequestInfo | URL, init?: RequestInit) =>
      new Promise<Response>((_resolve, reject) => {
        init?.signal?.addEventListener('abort', () => reject(Object.assign(new Error('aborted'), { name: 'AbortError' })));
      })) as typeof fetch;
    const client = new PigeonBoxCloudClient({ baseUrl: 'https://api.example.com', fetch: fetchImpl });
    const pending = client.call('health', undefined, { signal: controller.signal });
    controller.abort();
    await expect(pending).rejects.toMatchObject({ code: 'aborted' });
  });

  it('shares one request between concurrent readers and caches the result briefly', async () => {
    let now = 0;
    const cache = new InflightCache<number>(1_000, 10, () => now);
    let calls = 0;
    const load = () => new Promise<number>((resolve) => setTimeout(() => resolve(++calls), 5));
    const [a, b] = await Promise.all([cache.get('k', load), cache.get('k', load)]);
    expect([a, b, calls]).toEqual([1, 1, 1]);
    expect(await cache.get('k', load)).toBe(1);
    now = 2_000;
    expect(cache.peek('k')).toBeUndefined();
    expect(await cache.get('k', load)).toBe(2);
  });
});


describe('Authenticated document upload', () => {
  const id = '00000000-0000-4000-8000-000000000123';
  const bytes = new TextEncoder().encode('%PDF-1.4 fixture');
  const doc = { id, title: 'Proposal', filename: 'proposal.pdf', sizeBytes: bytes.length, pageCount: null, status: 'ready', createdAt: '2026-10-01T12:00:00.000Z', links: 0, views: 0, lastViewedAt: null };
  it('uses a generated path on the issuing origin, disallows redirects and validates responses', async () => {
    const upload = vi.fn(async (_url: RequestInfo | URL, _init?: RequestInit) => json({ document: doc }));
    const client = new PigeonBoxCloudClient({ baseUrl: 'https://cloud.test', fetch: upload, tokens: { get: async () => 'fixture-token', refresh: async () => null } });
    expect((await client.uploadDocument(id, bytes)).document.id).toBe(id);
    expect(upload).toHaveBeenCalledWith(`https://cloud.test/v1/documents/${id}/content`, expect.objectContaining({ method: 'PUT', credentials: 'omit', redirect: 'error', body: bytes }));
    await expect(client.uploadDocument('https://evil.test/upload', bytes)).rejects.toThrow();
    await expect(client.uploadDocument(id, new TextEncoder().encode('not a PDF'))).rejects.toMatchObject({ code: 'invalid_request' });
    expect(upload).toHaveBeenCalledTimes(1);
  });
  it('refreshes exactly once and sanitizes network failures', async () => {
    const upload = vi.fn(async (_url: RequestInfo | URL, init?: RequestInit) => (init!.headers as Record<string, string>).Authorization === 'Bearer old' ? json({}, 401) : json({ document: doc }));
    const refresh = vi.fn(async () => 'new'); const client = new PigeonBoxCloudClient({ baseUrl: 'https://cloud.test', fetch: upload, tokens: { get: async () => 'old', refresh } });
    await client.uploadDocument(id, bytes); expect(refresh).toHaveBeenCalledTimes(1); expect(upload).toHaveBeenCalledTimes(2);
    const failing = new PigeonBoxCloudClient({ baseUrl: 'https://cloud.test', fetch: async () => { throw new Error('body prompt oauth private'); }, tokens: { get: async () => 'old', refresh } });
    const error = await failing.uploadDocument(id, bytes).catch((value: unknown) => value); expect(String(error)).not.toContain('private');
  });
});
