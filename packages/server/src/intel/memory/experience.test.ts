import { expect, it } from 'vitest';
import type { RouteResponse } from '@pigeonbox/api-contract';
import { MemoryFixtureAI } from '../../testing/memory-fixtures.js';
import { connectedUser, createIntelHarness, deliverAndSync } from '../../testing/intel-harness.js';
import type { ChatRequest, InferenceContext } from '../../ai/backends.js';
import { readDataBlock } from '../prompts.js';

class NoEmbeddingsAI extends MemoryFixtureAI {
  override async embed(): Promise<never> { throw new Error('Embedding provider unavailable'); }
}

class CapturingAI extends MemoryFixtureAI {
  memoryInput: { page?: { summary: string | null } } | null = null;
  override async chat(request: ChatRequest, context: InferenceContext) {
    const data = readDataBlock(request.messages.at(-1)!.content) as { task?: string; page?: { summary: string | null } } | null;
    if (data?.task === 'memory_chat') this.memoryInput = data;
    return super.chat(request, context);
  }
}

it('searches encrypted text before indexing or during an embedding outage, paginates matches and isolates accounts', async () => {
  const h = await createIntelHarness({ inference: new NoEmbeddingsAI() });
  try {
    const user = await connectedUser(h, 'search@memory.test', ['mail_read']);
    for (const text of ['I prefer tea over coffee.', 'I prefer short replies.', 'I prefer tea after lunch.']) {
      await h.route('memoryChat', user.token, { message: `Remember: ${text}` });
      await h.advance(1_000);
    }
    const first = await h.route<RouteResponse<'memoryList'>>('memoryList', user.token, { query: 'tea', limit: 1 });
    expect(first.memories).toHaveLength(1);
    expect(first.memories[0]!.text).toContain('tea');
    expect(first.nextCursor).not.toBeNull();
    const next = await h.route<RouteResponse<'memoryList'>>('memoryList', user.token, { query: 'tea', limit: 1, cursor: first.nextCursor! });
    expect(next.memories).toHaveLength(1);
    expect(next.memories[0]!.id).not.toBe(first.memories[0]!.id);
    expect(next.memories[0]!.text).toContain('tea');
    expect((await h.route<RouteResponse<'memoryList'>>('memoryList', user.token, { query: 'nonexistent detail' })).memories).toEqual([]);
    const other = await connectedUser(h, 'other@memory.test', ['mail_read']);
    expect((await h.route<RouteResponse<'memoryList'>>('memoryList', other.token, { query: 'tea' })).memories).toEqual([]);
  } finally { await h.pg.close(); }
}, 60_000);

class BulkAI extends MemoryFixtureAI {
  override async chat(request: ChatRequest, context: InferenceContext) {
    if ((readDataBlock(request.messages.at(-1)!.content) as { task?: string } | null)?.task === 'memory_chat') {
      const details = Array.from({ length: 20 }, (_, i) => `The owner enjoys learning about topic ${i + 1} through thoughtful examples and practical exercises. `.repeat(3).trim());
      return { text: JSON.stringify({ answer: 'Ready.', intent: 'change', references: [], changes: details.map(text => ({ kind: 'save', ref: null, text, evidence: text, subject: { type: 'self', key: 'self', label: 'You' }, category: 'preferences', memoryKind: 'preference', entities: [] })) }), model: 'fixture', provider: 'mock', serviceTier: request.serviceTier, usage: { inputTokens: 10, outputTokens: 10 } };
    }
    return super.chat(request, context);
  }
}

it('confirms all twenty long saves within the response contract after an atomic commit', async () => {
  const h = await createIntelHarness({ inference: new BulkAI() });
  try {
    const user = await connectedUser(h, 'bulk@memory.test', ['mail_read']);
    const details = Array.from({ length: 20 }, (_, i) => `The owner enjoys learning about topic ${i + 1} through thoughtful examples and practical exercises. `.repeat(3).trim());
    const result = await h.route<RouteResponse<'memoryChat'>>('memoryChat', user.token, { message: `Remember:\n${details.join('\n')}` });
    expect(result.changes).toHaveLength(20);
    expect(result.memories).toHaveLength(20);
    expect(result.answer.length).toBeLessThanOrEqual(2_000);
    expect(result.answer).toContain('20 memory changes saved');
    expect(await h.sql('select id from public.personal_memories')).toHaveLength(20);
  } finally { await h.pg.close(); }
}, 60_000);

it('withholds overviews containing expired facts and records the actual correction time', async () => {
  const ai = new CapturingAI();
  const h = await createIntelHarness({ inference: ai });
  try {
    const email = 'freshness@memory.test';
    const user = await connectedUser(h, email, ['mail_read']);
    for (const body of ["I'm a freshman at UC Berkeley studying business and data science.", 'I built PigeonBox, an AI email copilot.', 'I want to work at Multifactor this summer.']) {
      await deliverAndSync(h, email, { from: email, to: ['friend@memory.test'], subject: body, body });
    }
    await h.route('memorySubjects', user.token, {}); await h.drain();
    const before = await h.route<RouteResponse<'memorySubjects'>>('memorySubjects', user.token, {});
    expect(before.subjects[0]!.summary).toContain('Berkeley');
    const list = await h.route<RouteResponse<'memoryList'>>('memoryList', user.token, {});
    await h.sql('update public.personal_memories set valid_until = $1::timestamptz where id = $2::uuid', [new Date(h.now().getTime() + 1_000), list.memories[0]!.id]);
    await h.advance(2_000);
    expect((await h.route<RouteResponse<'memorySubjects'>>('memorySubjects', user.token, {})).subjects[0]!.summary).toBeNull();
    await h.route('memoryChat', user.token, { message: 'What do you remember?', subject: before.subjects[0]!.id });
    expect(ai.memoryInput?.page?.summary).toBeNull();
    const started = h.now().getTime();
    const corrected = await h.route<RouteResponse<'memoryUpdate'>>('memoryUpdate', user.token, { memoryId: list.memories[1]!.id, text: 'I built PigeonBox to make my email routine easier.' });
    expect(Date.parse(corrected.memory.lastConfirmedAt)).toBeGreaterThanOrEqual(started);
    expect(Date.parse(corrected.memory.lastConfirmedAt)).toBeLessThanOrEqual(h.now().getTime());
  } finally { await h.pg.close(); }
}, 60_000);

it('reindexes a correction restored to earlier wording instead of reusing a completed job', async () => {
  const h = await createIntelHarness({ inference: new MemoryFixtureAI() });
  try {
    const user = await connectedUser(h, 'reindex@memory.test', ['mail_read']);
    const original = 'I prefer concise replies.';
    const saved = await h.route<RouteResponse<'memoryChat'>>('memoryChat', user.token, { message: `Remember: ${original}` });
    const memoryId = saved.memories[0]!.id;
    await h.drain();
    for (const text of ['I prefer detailed replies.', original]) {
      await h.route('memoryUpdate', user.token, { memoryId, text }); await h.drain();
      const rows = await h.sql<{ indexed: boolean }>('select embedding is not null as indexed from public.personal_memories where id = $1::uuid', [memoryId]);
      expect(rows[0]!.indexed).toBe(true);
    }
  } finally { await h.pg.close(); }
}, 60_000);
