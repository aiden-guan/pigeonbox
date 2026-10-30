/**
 * Real-time Pidgy check evals: realistic scenarios through the real API,
 * calendar, sync, analysis, Brain and retrieval, graded on the advisory the
 * writer would see.
 *
 * Offline (`npm run eval`), memory extraction is the controlled fixture and the
 * compose-check model is deliberately credulous: it surfaces a conflict for
 * anything it is shown. Precision therefore has to come from the pipeline
 * (deterministic checks, evidence gating), which is what these evals grade.
 * `npm run eval:live` runs the same scenarios against the configured provider.
 */
import type { ComposeCheckResponse, PersonalMemory } from '@pigeonbox/api-contract';
import { addCalendarDays, zonedParts, zonedTimeToUtc } from '@pigeonbox/shared';
import { afterAll, describe, expect, it } from 'vitest';
import { createInferenceBackend, type ChatRequest, type CloudInferenceBackend, type InferenceContext } from '../ai/backends.js';
import { loadConfig } from '../config.js';
import { readDataBlock } from '../intel/prompts.js';
import type { MemoryCandidate } from '../intel/memory/types.js';
import { testEnv } from '../testing.js';
import { connectedUser, createIntelHarness, deliverAndSync } from '../testing/intel-harness.js';
import { MemoryFixtureAI } from '../testing/memory-fixtures.js';

const LIVE = process.env.PIGEONBOX_EVAL_LIVE === '1';
const OWNER = 'ada@work.test';
const ZONE = 'America/New_York';

function liveBackend(): CloudInferenceBackend {
  if (!process.env.CLOUD_AI_PROVIDER || process.env.CLOUD_AI_PROVIDER === 'mock' || !process.env.CLOUD_AI_API_KEY || !process.env.CLOUD_AI_BASE_URL || !process.env.CLOUD_AI_PRIMARY_MODEL)
    throw new Error('Live eval requires an explicit real CLOUD_AI_PROVIDER, BASE_URL, API_KEY and PRIMARY_MODEL.');
  const ai = Object.fromEntries(Object.entries(process.env).filter(([key]) => key.startsWith('CLOUD_AI_'))) as Record<string, string>;
  return createInferenceBackend(loadConfig(testEnv({ ...ai, CLOUD_AI_TIMEOUT_MS: ai.CLOUD_AI_TIMEOUT_MS ?? '60000' })));
}

/** Extraction for the meeting-room scenario plus a model that would flag anything it is shown. */
class CredulousAI extends MemoryFixtureAI {
  modelChecks = 0;
  override async chat(request: ChatRequest, context: InferenceContext) {
    if (context.operation === 'compose_check') {
      this.modelChecks += 1;
      const data = readDataBlock(request.messages.at(-1)!.content) as { evidence: Array<{ id: string }> };
      // A credulous model cannot smuggle a paraphrased assertion through the
      // sentence-selection protocol; an out-of-range selection is unusable.
      const text = JSON.stringify({ advisory: { kind: 'fact_conflict', advisoryIndex: 3, confidence: 0.97, sourceIds: [data.evidence[0]?.id ?? 'E1'], suggestedText: null, highlightText: null }, completion: null });
      return { text, model: 'fixture', provider: 'mock', serviceTier: request.serviceTier, usage: { inputTokens: 300, outputTokens: 40 } };
    }
    if (context.operation === 'memory_extract') {
      const input = JSON.parse(request.messages.find((part) => part.role === 'user')!.content) as { messages: Array<{ gmailMessageId: string; from: string; text: string }> };
      const room = input.messages.flatMap((source) => {
        const match = source.text.match(/The design review (?:is|has been moved to) (?:in )?(Soda Hall|Cory Hall)\./);
        if (!match) return [];
        const candidate: MemoryCandidate = {
          op: 'add',
          ref: null,
          subject: { type: 'person', key: source.from, label: source.from },
          kind: 'episodic',
          category: 'logistics',
          canonicalText: match[0],
          importance: 0.9,
          confidence: 0.9,
          usefulness: 0.9,
          entities: [{ type: 'email', key: source.from }],
          gmailMessageId: source.gmailMessageId,
          evidence: match[0],
          sensitivity: 'ordinary',
          validFrom: null,
          validUntil: null,
          temporary: true,
          concept: { topic: 'design review', attribute: 'location' },
          explicitUpdate: /moved/.test(match[0]),
        };
        return [candidate];
      });
      if (room.length) return { text: JSON.stringify({ memories: room }), model: 'fixture', provider: 'mock', serviceTier: request.serviceTier, usage: { inputTokens: 20, outputTokens: 30 } };
    }
    return super.chat(request, context);
  }
}

type Scenario = { id: string; expect: 'notice' | 'none'; kind?: string; result?: ComposeCheckResponse };
const results: Scenario[] = [];
let modelCalls = 0;
let checksRun = 0;

async function scenario(id: string, run: (env: Awaited<ReturnType<typeof world>>) => Promise<{ expect: 'notice' | 'none'; kind?: string; result: ComposeCheckResponse; extra?: () => Promise<void> }>) {
  const env = await world();
  try {
    const outcome = await run(env);
    results.push({ id, expect: outcome.expect, kind: outcome.kind, result: outcome.result });
    if (env.inference instanceof CredulousAI) modelCalls += env.inference.modelChecks;
    expect(outcome.result.status, id).toBe(outcome.expect);
    if (outcome.kind && outcome.result.status === 'notice') expect(outcome.result.kind, id).toBe(outcome.kind);
    await outcome.extra?.();
  } finally {
    await env.h.pg.close();
  }
}

async function world() {
  const inference = LIVE ? liveBackend() : new CredulousAI();
  const h = await createIntelHarness({ inference, env: LIVE ? Object.fromEntries(Object.entries(process.env).filter(([key]) => key.startsWith('CLOUD_AI_'))) as Record<string, string> : {} });
  const user = await connectedUser(h, OWNER, ['mail_read', 'drafts', 'calendar_read'], { autoDrafts: { enabled: false }, memory: { realtimeComposeChecks: true } });
  const p = zonedParts(h.now(), ZONE);
  const monday = addCalendarDays({ year: p.year, month: p.month, day: p.day }, (8 - p.weekday) % 7 || 7);
  await h.advance(zonedTimeToUtc({ ...monday, hour: 10, minute: 0 }, ZONE).getTime() - h.now().getTime());
  const at = (days: number, hour: number) => zonedTimeToUtc({ ...addCalendarDays(monday, days), hour, minute: 0 }, ZONE);
  const check = (claim: string, recipients: string[], extra: Record<string, unknown> = {}) => {
    checksRun += 1;
    return h.route<ComposeCheckResponse>('composeCheck', user.token, { claim, subject: 'Re: plans', recipientEmails: recipients, mailbox: OWNER, ...extra });
  };
  return { h, user, inference, at, check };
}

describe(`real-time Pidgy check evals (${LIVE ? 'live provider' : 'credulous offline model'})`, () => {
  const timeout = LIVE ? 180_000 : 30_000;

  it('professor scheduling: "Tuesday at 2 works for me" over a 1–3 class surfaces the calendar conflict', async () => {
    await scenario('professor scheduling', async ({ h, at, check }) => {
      h.google.addEvent(OWNER, { summary: 'MATH 52 lecture', start: at(1, 13), end: at(1, 15) });
      return { expect: 'notice', kind: 'calendar_conflict', result: await check('Tuesday at 2 works for me.', ['professor@berkeley.test']) };
    });
  }, timeout);

  it('recruiter scheduling: "I’m free Thursday morning" with a clear morning stays quiet', async () => {
    await scenario('recruiter scheduling', async ({ h, at, check }) => {
      h.google.addEvent(OWNER, { summary: 'Team sync', start: at(3, 15), end: at(3, 16) });
      return { expect: 'none', result: await check("I'm free Thursday morning.", ['sam@talentco.test']) };
    });
  }, timeout);

  it('commitment: promised the deck by Wednesday, now writing "I’ll send it Friday" in that thread', async () => {
    await scenario('commitment', async ({ h, check }) => {
      const sent = await deliverAndSync(h, OWNER, { from: OWNER, to: ['alex@client.test'], subject: 'Pitch deck', body: "Thanks Alex! I'll send the deck by Wednesday.", at: h.now() });
      const result = await check("I'll send it Friday.", ['alex@client.test'], { threadId: sent.threadId });
      return { expect: 'notice', kind: 'commitment_conflict', result };
    });
  }, timeout);

  it('stale memory: room changed from Soda Hall to Cory Hall, compose still says Soda Hall', async () => {
    await scenario('stale memory', async ({ h, check }) => {
      const lead = 'lead@studio.test';
      await deliverAndSync(h, OWNER, { from: lead, to: [OWNER], subject: 'Design review', body: 'The design review is in Soda Hall.', at: h.now() });
      await h.advance(60_000);
      await deliverAndSync(h, OWNER, { from: lead, to: [OWNER], subject: 'Design review room change', body: 'The design review has been moved to Cory Hall.', at: h.now() });
      const result = await check('The design review is in Soda Hall.', [lead]);
      return {
        expect: 'notice',
        kind: 'fact_conflict',
        result,
        extra: async () => {
          if (result.status === 'notice') expect(result.message).toContain('Cory Hall');
        },
      };
    });
  }, timeout);

  it('weak semantic match: an old thread vaguely mentions Friday; compose mentions Friday; no notice', async () => {
    await scenario('weak semantic match', async ({ h, check }) => {
      await deliverAndSync(h, OWNER, { from: 'alex@client.test', to: [OWNER], subject: 'Catching up', body: 'We should maybe get together on Friday sometime, no rush.', at: h.now() });
      return { expect: 'none', result: await check("I'll send the photos Friday.", ['alex@client.test']) };
    });
  }, timeout);

  it('sensitive text: private health and financial details are not compared, kept, logged or learned', async () => {
    await scenario('sensitive text', async ({ h, at, check, user }) => {
      h.google.addEvent(OWNER, { summary: 'Math 52', start: at(1, 14), end: at(1, 16) });
      const before = (await h.route<{ memories: PersonalMemory[] }>('memoryList', user.token, { limit: 50 })).memories.length;
      const result = await check("I'm free tomorrow at 3 right after my therapy appointment, my account number is 12345678.", ['alex@client.test']);
      return {
        expect: 'none',
        result,
        extra: async () => {
          await h.drain();
          expect((await h.route<{ memories: PersonalMemory[] }>('memoryList', user.token, { limit: 50 })).memories).toHaveLength(before);
          expect(JSON.stringify(h.logs)).not.toMatch(/therapy|12345678/);
        },
      };
    });
  }, timeout);

  afterAll(() => {
    if (!results.length) return;
    const rows = results.map((item) => ({ scenario: item.id, expected: item.expect, got: item.result?.status, message: item.result?.status === 'notice' ? item.result.message : '' }));
    console.log('\nReal-time Pidgy check evals');
    console.table(rows);
    console.log(`Precision on expected-none scenarios: ${results.filter((item) => item.expect === 'none' && item.result?.status === 'none').length}/${results.filter((item) => item.expect === 'none').length}`);
    if (!LIVE) console.log(`Model calls: ${modelCalls} for ${checksRun} checks (a credulous model surfaces everything it is shown).`);
  });
});
