import { ASK_REQUEST_TIMEOUT_MS, ASK_STREAM_TIMEOUT_MS, PROTOCOL_HEADER, PROTOCOL_VERSION, ROUTES, type AskPigeonResponse } from '@pigeonbox/api-contract';
import { describe, expect, it, vi } from 'vitest';
import { connectedUser, createIntelHarness, deliverAndSync } from '../testing/intel-harness.js';
import { API } from '../testing.js';
import { DEADLINE_MS, STREAM_DEADLINE_MS } from './ask-agent.js';

const ADA = 'ada@work.test';
const reply = { text: 'I can help with your mail.', model: 'scripted', provider: 'mock', serviceTier: 'standard' as const, usage: { inputTokens: 10, outputTokens: 10 } };

describe('Chat request performance', () => {
  it('gives server work headroom inside both client deadlines', () => {
    expect(DEADLINE_MS).toBeGreaterThan(46_000);
    expect(STREAM_DEADLINE_MS).toBeGreaterThan(75_000);
    expect(DEADLINE_MS + 8_000).toBeLessThan(ASK_REQUEST_TIMEOUT_MS);
    expect(STREAM_DEADLINE_MS + 8_000).toBeLessThan(ASK_STREAM_TIMEOUT_MS);
  });

  it.each(['askPigeon', 'askPigeonStream'] as const)('delivers %s before usage settles and keeps the database alive for it', async (route) => {
    const h = await createIntelHarness();
    const user = await connectedUser(h, ADA);
    let release!: () => void;
    const gate = new Promise<void>((resolve) => { release = resolve; });
    const record = h.store.recordUsage.bind(h.store);
    vi.spyOn(h.store, 'recordUsage').mockImplementation(async (usage) => { await gate; await record(usage); });
    const close = vi.spyOn(h.db, 'close');
    h.deps.inference.chat = async () => reply;
    const background: Promise<unknown>[] = [];
    try {
      const response = await h.api(new Request(`${API}${ROUTES[route].path}`, {
        method: 'POST', headers: { Authorization: `Bearer ${user.token}`, 'Content-Type': 'application/json', [PROTOCOL_HEADER]: String(PROTOCOL_VERSION) },
        body: JSON.stringify({ query: 'Find my emails' }),
      }), { waitUntil: (work) => { background.push(work); } });
      const text = await response.text();
      expect(text).toContain(reply.text);
      if (route === 'askPigeonStream') expect(text).toContain('"type":"done"');
      expect(close).not.toHaveBeenCalled();
      expect(h.store.recordUsage).toHaveBeenCalled();
    } finally {
      release();
      await Promise.all(background);
    }
    expect(close).toHaveBeenCalledOnce();
  });

  it('cancels an in-flight model call when the stream reader goes away', async () => {
    const h = await createIntelHarness();
    const user = await connectedUser(h, ADA);
    let entered!: () => void;
    const ready = new Promise<void>((resolve) => { entered = resolve; });
    let modelSignal: AbortSignal | undefined;
    let stopped!: () => void;
    const aborted = new Promise<void>((resolve) => { stopped = resolve; });
    h.deps.inference.chat = async (_request, context) => {
      modelSignal = context.signal;
      expect(context.timeoutMs).toBe(90_000);
      entered();
      return new Promise((_resolve, reject) => {
        context.signal.addEventListener('abort', () => { stopped(); reject(context.signal.reason); }, { once: true });
      });
    };
    const background: Promise<unknown>[] = [];
    const response = await h.api(new Request(`${API}${ROUTES.askPigeonStream.path}`, {
      method: 'POST', headers: { Authorization: `Bearer ${user.token}`, 'Content-Type': 'application/json', [PROTOCOL_HEADER]: String(PROTOCOL_VERSION) },
      body: JSON.stringify({ query: 'Find my emails' }),
    }), { waitUntil: (work) => { background.push(work); } });
    const reader = response.body!.getReader();
    await ready;
    await reader.cancel();
    await aborted;
    expect(modelSignal?.aborted).toBe(true);
    await Promise.all(background);
  });

  it('reads overlapping Gmail search hits once per account per request and refreshes next turn', async () => {
    const h = await createIntelHarness();
    const user = await connectedUser(h, ADA);
    await deliverAndSync(h, ADA, { from: 'maya@client.test', to: [ADA], subject: 'Shared proposal', body: 'Please review.' });
    let round = 0;
    h.deps.inference.chat = async () => round++ % 2 ? reply : {
      ...reply, text: '', toolCalls: [
        { id: 'a', name: 'search_mail', arguments: '{"query":"subject:Shared"}' },
        { id: 'b', name: 'search_mail', arguments: '{"query":"from:maya@client.test"}' },
      ],
    };
    const reads = () => h.google.calls.filter((call) => call.method === 'GET' && /\/messages\/[^/]+$/.test(call.path)).length;
    const before = reads();
    for (let turn = 1; turn <= 2; turn++) {
      const answer = await h.route<AskPigeonResponse>('askPigeon', user.token, { query: 'Find my emails' });
      expect(answer.answer).toBe(reply.text);
      expect(reads() - before).toBe(turn);
    }
    expect(h.logs.filter((entry) => entry.message === 'ask pigeon answered').at(-1)?.fields).toMatchObject({ rounds: 2, modelMs: expect.any(Number), toolsMs: expect.any(Number), loadMs: expect.any(Number), primeMs: expect.any(Number) });
  });

  it('shares an embedding across differently filtered searches without dropping either search', async () => {
    const h = await createIntelHarness();
    const user = await connectedUser(h, ADA);
    const embed = vi.spyOn(h.deps.inference, 'embed');
    let round = 0;
    h.deps.inference.chat = async (request) => {
      if (round++) {
        expect(request.messages.filter((message) => message.role === 'tool')).toHaveLength(2);
        return reply;
      }
      return { ...reply, text: '', toolCalls: [
        { id: 'a', name: 'search_index', arguments: '{"query":"proposal","max_results":5}' },
        { id: 'b', name: 'search_index', arguments: '{"query":"proposal","max_results":10,"after":"2026-01-01"}' },
      ] };
    };
    await h.route('askPigeon', user.token, { query: 'Find my emails' });
    expect(embed).toHaveBeenCalledOnce();
    expect(h.logs.filter((entry) => entry.message === 'ask tool finished' && entry.fields?.operation === 'search_index')).toHaveLength(2);
    expect(h.store.usageRows().filter((row) => row.operation === 'intel.index_embed')).toHaveLength(1);
  });

  it('keeps the database alive for usage registered by a prefetch after the answer was delivered', async () => {
    const h = await createIntelHarness();
    const user = await connectedUser(h, ADA);
    const embed = h.deps.inference.embed.bind(h.deps.inference);
    let releaseEmbedding!: () => void;
    const embeddingGate = new Promise<void>((resolve) => { releaseEmbedding = resolve; });
    h.deps.inference.embed = async (...args) => { await embeddingGate; return embed(...args); };
    const record = h.store.recordUsage.bind(h.store);
    let releaseUsage!: () => void;
    const usageGate = new Promise<void>((resolve) => { releaseUsage = resolve; });
    let startedUsage!: () => void;
    const usageStarted = new Promise<void>((resolve) => { startedUsage = resolve; });
    h.store.recordUsage = async (row) => {
      if (row.operation === 'intel.index_embed') { startedUsage(); await usageGate; }
      await record(row);
    };
    h.deps.inference.chat = async () => reply;
    const close = vi.spyOn(h.db, 'close');
    const background: Promise<unknown>[] = [];
    try {
      const response = await h.api(new Request(`${API}${ROUTES.askPigeonStream.path}`, {
        method: 'POST', headers: { Authorization: `Bearer ${user.token}`, 'Content-Type': 'application/json', [PROTOCOL_HEADER]: String(PROTOCOL_VERSION) },
        body: JSON.stringify({ query: 'Review the proposal' }),
      }), { waitUntil: (work) => { background.push(work); } });
      expect(await response.text()).toContain('"type":"done"');
      releaseEmbedding();
      await usageStarted;
      expect(close).not.toHaveBeenCalled();
    } finally {
      releaseEmbedding();
      releaseUsage();
      await Promise.all(background);
    }
    expect(close).toHaveBeenCalledOnce();
  });
});
