import { afterEach, describe, expect, it } from 'vitest';
import type { ComposeCheckResponse, RouteResponse } from '@pigeonbox/api-contract';
import type { ChatRequest, InferenceContext } from '../ai/backends.js';
import { createIntelHarness, connectedUser, type IntelHarness } from '../testing/intel-harness.js';
import { MemoryFixtureAI } from '../testing/memory-fixtures.js';
import { readDataBlock } from '../intel/prompts.js';

const fact = 'You ran a paid community that generated $35,000 in revenue.';
class CompletionAI extends MemoryFixtureAI {
  checks: ChatRequest[] = [];
  beforeAnswer?: () => Promise<void>;
  suffix = ' where I made 35k in revenue.';
  override async chat(request: ChatRequest, context: InferenceContext) {
    const data = readDataBlock(request.messages.at(-1)!.content) as { task?: string; evidence?: Array<{ id: string; text: string }> } | null;
    if (data?.task === 'memory_chat') return {
      text: JSON.stringify({ answer: 'Remembered.', intent: 'change', references: [], changes: [{ kind: 'save', ref: null, text: fact, evidence: fact, subject: { type: 'self', key: 'self', label: 'You' }, category: 'projects', memoryKind: 'semantic', entities: [{type:'topic',key:'community'}] }] }),
      model: 'fixture', provider: 'mock', serviceTier: request.serviceTier, usage: { inputTokens: 10, outputTokens: 10 },
    };
    if (context.operation !== 'compose_check') return super.chat(request, context);
    this.checks.push(request);
    await this.beforeAnswer?.();
    return {
      text: JSON.stringify({ advisory: null,
        completion: { text: this.suffix, confidence: 0.96, proofs: [{ sourceId: data?.evidence?.[0]?.id ?? 'E9', quote: fact }] } }),
      model: 'fixture', provider: 'mock', serviceTier: request.serviceTier, usage: { inputTokens: 50, outputTokens: 40 },
    };
  }
}
const worlds: IntelHarness[] = [];
afterEach(async () => { for (const h of worlds.splice(0)) await h.pg.close(); });
async function world() {
  const ai = new CompletionAI();
  const h = await createIntelHarness({ inference: ai }); worlds.push(h);
  const owner = 'owner@community.test';
  const user = await connectedUser(h, owner, ['mail_read'], { autoDrafts: { enabled: false }, memory: { realtimeComposeChecks: false, smartComposeCompletion: true } });
  const saved = await h.route<RouteResponse<'memoryChat'>>('memoryChat', user.token, { message: `Remember: ${fact}` });
  const check = (extra: Record<string, unknown> = {}, token = user.token) => h.route<ComposeCheckResponse>('composeCheck', token, {
    claim: 'I used to have a paid community', recipientEmails: [], subject: '', mailbox: owner, includeCompletion: true, ...extra,
  });
  return { h, ai, user, saved, check };
}

describe('smart autofill with real router, encrypted memories and RLS', () => {
  it('continues an everyday request with no saved fact while respecting the independent completion opt-in', async () => {
    const { h, check, ai, user } = await world();
    ai.suffix = ' the latest version when you have a chance?';
    const original = ai.chat.bind(ai);
    ai.chat = async (request, context) => context.operation === 'compose_check'
      ? { text: JSON.stringify({ advisory: null, completion: { text: ai.suffix, kind: 'writing', confidence: 0.98, proofs: [] } }), model: 'fixture', provider: 'mock', serviceTier: request.serviceTier, usage: { inputTokens: 50, outputTokens: 30 } }
      : original(request, context);
    expect(await check({ claim: 'Could you please send me', includeWriting: true })).toMatchObject({ status: 'none', completion: { text: ai.suffix, kind: 'writing', sources: [] } });
    expect(await check({ claim: 'Could you please send me', includeWriting: false })).toEqual({ status: 'none' });
    await h.route('preferencesUpdate', user.token, { preferences: { memory: { smartComposeCompletion: false } } });
    expect(await check({ claim: 'Could you please send me', includeWriting: true })).toEqual({ status: 'disabled' });
    expect(JSON.stringify(h.logs)).not.toContain(ai.suffix);
  });
  it('validates only cited source types after inference instead of issuing empty source queries', async () => {
    const { h, ai, check } = await world();
    const original = h.db.asUser.bind(h.db);
    const queries: string[] = [];
    const retrievalQueries: string[] = [];
    let validating = false;
    h.db.asUser = ((id, fn) => original(id, tx => fn({ query: (sql, params) => {
      if (validating) queries.push(sql);
      else retrievalQueries.push(sql);
      return tx.query(sql, params);
    } }))) as typeof h.db.asUser;
    ai.beforeAnswer = async () => { validating = true; };
    expect(await check()).toMatchObject({ completion: { text: ai.suffix } });
    expect(queries).toHaveLength(3); // Preference, connected account, cited memory.
    expect(queries.join('\n')).not.toMatch(/from public\.(threads|notes|contacts|calendar_event_cache|recall_chunks|commitments|relationship_events)\b/);
    expect(retrievalQueries.join('\n')).not.toMatch(/insert into public.personal_memory_state|from public.relationship_events|from public.commitments/);
    expect(retrievalQueries.join('\n')).not.toContain('select c.*,coalesce(co.name,co.domain)');
    const timing = h.logs.find(entry => entry.message === 'compose check')!.fields!;
    for (const field of ['loadMs', 'retrievalMs', 'preflightMs', 'inferenceMs', 'validationMs'] as const) {
      expect(timing[field]).toEqual(expect.any(Number));
      expect(timing[field]).toBeGreaterThanOrEqual(0);
    }
  });
  it('retrieves the user fact without recipients and returns one AI continuation while checks are off', async () => {
    const { h, ai, check, user, saved } = await world();
    const before = await h.sql<{ last_accessed_at: unknown }>('select last_accessed_at from public.personal_memories');
    expect(await check()).toMatchObject({ status: 'none', completion: { text: ai.suffix, sources: [{ id: `memory:${saved.memories[0]!.id}` }] } });
    expect(ai.checks).toHaveLength(1);
    expect(ai.checks[0]!.maxTokens).toBe(440);
    expect(ai.checks[0]!.messages[0]!.content).toContain('Factual checks are disabled');
    expect(h.logs.some(entry => entry.message === 'compose check' && entry.fields?.completionRequested === true && entry.fields?.completionCount === 1)).toBe(true);
    expect(JSON.stringify(h.logs)).not.toContain(fact);
    expect(await h.sql('select last_accessed_at from public.personal_memories')).toEqual(before);
    expect(await h.sql('select id from public.personal_memories')).toHaveLength(1);
    expect(await check({ includeCompletion: false })).toEqual({ status: 'disabled' });
    const other = await connectedUser(h, 'other@community.test', ['mail_read'], { memory: { smartComposeCompletion: true } });
    expect(await check({ mailbox: 'other@community.test' }, other.token)).toEqual({ status: 'none' });
    expect(await h.db.asUser(other.userId, tx => tx.query('select id from public.personal_memories'))).toEqual([]);
    expect(user.userId).not.toBe(other.userId);
  });
  it('rejects inventions and rechecks forgotten or corrected evidence after inference', async () => {
    const { h, ai, check, user, saved } = await world();
    ai.suffix = ' where I made 95k in revenue.';
    expect(await check()).toEqual({ status: 'none' });
    ai.suffix = ' where I made 35k in revenue.';
    ai.beforeAnswer = async () => { await h.route('memoryForget', user.token, { memoryId: saved.memories[0]!.id }); };
    expect(await check()).toEqual({ status: 'none' });
  });
  it('still completes when factual checks are enabled and the fact already supports informational recall', async () => {
    const { h, ai, check, user } = await world();
    await h.route('preferencesUpdate', user.token, { preferences: { memory: { realtimeComposeChecks: true } } });
    expect(await check()).toMatchObject({ completion: { text: ai.suffix } });
    expect(ai.checks).toHaveLength(1);
  });
  it('checks the completion preference again after inference and rejects sensitive live prose', async () => {
    const { h, ai, check, user } = await world();
    expect(await check({ claim: 'My password for the paid community is' })).toEqual({ status: 'none' });
    expect(ai.checks).toHaveLength(0);
    ai.beforeAnswer = async () => { await h.route('preferencesUpdate', user.token, { preferences: { memory: { smartComposeCompletion: false } } }); };
    expect(await check()).toEqual({ status: 'none' });
    expect(await check()).toEqual({ status: 'disabled' });
  });
  it('drops a continuation when its remembered fact is corrected during inference', async () => {
    const { h, ai, check, user, saved } = await world();
    ai.beforeAnswer = async () => {
      await h.advance(1_000);
      await h.route('memoryUpdate', user.token, { memoryId: saved.memories[0]!.id, text: 'You ran a paid community that generated $45,000 in revenue.' });
    };
    expect(await check()).toEqual({ status: 'none' });
  });
});
