import { describe, expect, it } from 'vitest';
import { z } from 'zod';
import { MockInferenceBackend, OpenAiCompatibleBackend, type ChatRequest, type InferenceContext } from '../ai/backends.js';
import { strictJsonSchema, type JsonSchema } from '../ai/json-schema.js';
import { openIntel } from '../routes/jobs.js';
import { connectedUser, createIntelHarness, deliverAndSync } from '../testing/intel-harness.js';
import { checkBudget, runStructured, type StructuredCall } from './ai.js';
import { analysisPrompt, AnalysisOutputSchema, draftPrompt, DraftOutputSchema, MatchOutputSchema, readDataBlock, ResearchOutputSchema, SnippetOutputSchema } from './prompts.js';

const SCHEMAS = { AnalysisOutputSchema, DraftOutputSchema, ResearchOutputSchema, MatchOutputSchema, SnippetOutputSchema };

/** Keywords strict Structured Outputs accept. Anything else is a request the provider would reject. */
const ALLOWED = new Set(['type', 'properties', 'required', 'additionalProperties', 'items', 'enum', 'anyOf', 'minimum', 'maximum', 'exclusiveMinimum', 'exclusiveMaximum', 'minItems', 'maxItems']);

function assertStrict(schema: JsonSchema, path: string) {
  for (const key of Object.keys(schema)) expect(ALLOWED.has(key), `${path}: ${key}`).toBe(true);
  if (schema.type === 'object') {
    const properties = schema.properties as Record<string, JsonSchema>;
    expect(schema.additionalProperties, path).toBe(false);
    expect(schema.required, path).toEqual(Object.keys(properties));
    for (const [key, value] of Object.entries(properties)) assertStrict(value, `${path}.${key}`);
  }
  if (schema.items) assertStrict(schema.items as JsonSchema, `${path}[]`);
  for (const [index, branch] of ((schema.anyOf as JsonSchema[] | undefined) ?? []).entries()) assertStrict(branch, `${path}|${index}`);
}

describe('strict JSON Schema for structured outputs', () => {
  it.each(Object.entries(SCHEMAS))('%s converts to the strict subset', (name, schema) => {
    const json = strictJsonSchema(schema);
    expect(json, name).not.toBeNull();
    expect(json!.type).toBe('object');
    assertStrict(json!, name);
  });

  it('keeps the constraints strict mode supports and leaves the rest to Zod', () => {
    const analysis = strictJsonSchema(AnalysisOutputSchema)!.properties as Record<string, JsonSchema>;
    expect(analysis.category).toEqual({ type: 'string', enum: ['RESPOND', 'WAITING', 'FYI', 'NOTIFICATIONS', 'PROMOTIONS', 'NEWS'] });
    expect((analysis.deadline!.anyOf as JsonSchema[])[1]).toEqual({ type: 'null' });
    expect(analysis.confidence).toEqual({ type: 'number', minimum: 0, maximum: 1 });
    const meeting = analysis.meeting!.properties as Record<string, JsonSchema>;
    expect(meeting.durationMinutes).toEqual({ anyOf: [{ type: 'integer', minimum: 5, maximum: 480 }, { type: 'null' }] });
    const draft = strictJsonSchema(DraftOutputSchema)!.properties as Record<string, JsonSchema>;
    expect(draft.variants).toMatchObject({ type: 'array', minItems: 1, maxItems: 6 });
    // String lengths are not in the strict subset: Zod still enforces them.
    expect((strictJsonSchema(SnippetOutputSchema)!.properties as Record<string, JsonSchema>).text).toEqual({ type: 'string' });
    expect(SnippetOutputSchema.safeParse({ text: 'x'.repeat(2_001), unresolved: false }).success).toBe(false);
  });

  it('declines schemas it cannot map, so the call falls back to JSON mode', () => {
    expect(strictJsonSchema(z.object({ at: z.string().transform((value) => new Date(value)) }))).toBeNull();
    expect(strictJsonSchema(z.object({ any: z.unknown() }))).toBeNull();
    expect(strictJsonSchema(z.array(z.string()))).toBeNull();
  });
});

describe('runStructured', () => {
  const VALID_SNIPPET = '{"text":"Tuesday works","unresolved":false}';

  async function setup(replies: string[], options: { serviceTier?: string; env?: Record<string, string> } = {}) {
    const bodies: Array<Record<string, unknown>> = [];
    const headers: Array<Record<string, string>> = [];
    const fetchImpl = (async (_url: RequestInfo | URL, init?: RequestInit) => {
      bodies.push(JSON.parse(String(init?.body)) as Record<string, unknown>);
      headers.push(init?.headers as Record<string, string>);
      const text = replies.shift() ?? 'not json at all';
      const body = bodies[bodies.length - 1]!;
      return new Response(JSON.stringify({ model: 'openai/gpt-6-luna', service_tier: options.serviceTier ?? body.service_tier, choices: [{ message: { content: text } }], usage: { prompt_tokens: 40_000, completion_tokens: 10_000, prompt_tokens_details: { cached_tokens: 30_000 } } }), { status: 200 });
    }) as unknown as typeof fetch;
    const inference = new OpenAiCompatibleBackend({
      name: 'cloudflare',
      baseUrl: 'https://gateway.ai.cloudflare.com/v1/a/g/compat',
      apiKey: 'k',
      models: ['openai/gpt-6-luna'],
      embedModel: 'embed',
      timeoutMs: 1_000,
      gateway: true,
      fetch: fetchImpl,
    });
    const h = await createIntelHarness({ inference, env: { CLOUD_AI_INPUT_COST_PER_1K_MICROS: '100', CLOUD_AI_OUTPUT_COST_PER_1K_MICROS: '500', CLOUD_AI_MONTHLY_BUDGET_MICROS: '2000000', ...options.env } });
    const user = await connectedUser(h, 'ada@work.test', ['mail_read']);
    const deps = openIntel(h.deps)!;
    const call = <T>(overrides: Partial<StructuredCall<T>> & Pick<StructuredCall<T>, 'operation' | 'schema'>): StructuredCall<T> => ({
      userId: user.userId,
      system: 'Return JSON.',
      user: 'Private email text from dana@example.com',
      requestId: 'req_structured',
      interactive: true,
      ...overrides,
    });
    return { h, deps, call, bodies, headers };
  }

  it('asks for the strict schema with the operation policy, and parses a valid reply', async () => {
    const { deps, call, bodies, headers, h } = await setup([VALID_SNIPPET]);
    const run = await runStructured(deps, call({ operation: 'snippet', schema: SnippetOutputSchema, maxTokens: 300 }));
    expect(run.value).toEqual({ text: 'Tuesday works', unresolved: false });
    expect(bodies).toHaveLength(1);
    expect(bodies[0]).toMatchObject({
      model: 'openai/gpt-6-luna',
      reasoning_effort: 'low',
      response_format: { type: 'json_schema', json_schema: { name: 'pigeonbox_snippet', strict: true, schema: strictJsonSchema(SnippetOutputSchema) } },
    });
    expect(bodies[0]).not.toHaveProperty('temperature');
    expect(JSON.parse(headers[0]!['cf-aig-metadata']!)).toEqual({ operation: 'snippet', requestId: 'req_structured', reasoningEffort: 'low', serviceTier: 'standard' });
    expect(bodies[0]!.service_tier).toBe('default');
    expect(Object.values(headers[0]!).join('\n')).not.toMatch(/Private|dana@example\.com/);
    // Usage and estimated cost still recorded, without content.
    const usage = h.store.usageRows().find((row) => row.operation === 'intel.snippet')!;
    // Standard: 10K uncached × 100 + 30K cached × 10 + 10K output × 500, per 1K tokens.
    expect(usage).toMatchObject({ model: 'openai/gpt-6-luna', inputTokens: 40_000, outputTokens: 10_000, estimatedCostMicros: 1_000 + 300 + 5_000 });
  });

  it('settles metered usage through the request lifetime hook without delaying a validated answer', async () => {
    const { deps, call, h } = await setup([VALID_SNIPPET]);
    const record = deps.store.recordUsage.bind(deps.store);
    let release!: () => void;
    const blocked = new Promise<void>(resolve => { release = resolve; });
    deps.store.recordUsage = async row => { await blocked; await record(row); };
    const pending: Promise<void>[] = [];
    const result = await runStructured(deps, call({ operation: 'snippet', schema: SnippetOutputSchema, defer: work => { pending.push(work); } }));
    expect(result.value.text).toBe('Tuesday works');
    expect(pending).toHaveLength(1);
    expect(h.store.usageRows()).toHaveLength(0);
    release(); await Promise.all(pending);
    expect(h.store.usageRows()).toHaveLength(1);
  });

  it('checks all budget scopes with one RLS statement and still enforces the global cap', async () => {
    const { deps, h } = await setup([]);
    const user = await connectedUser(h, 'budget@work.test', ['mail_read']);
    const original = deps.db.asUser.bind(deps.db);
    let reads = 0;
    const db = { ...deps.db, asUser: ((id, fn) => original(id, tx => fn({
      query: (sql, params) => { reads += 1; return tx.query(sql, params); },
    }))) as typeof deps.db.asUser };
    await checkBudget({ ...deps, db }, user.userId, true);
    expect(reads).toBe(1);
    await deps.db.system(tx => tx.query('insert into public.usage_global_daily (day, tokens) values ($1::date, $2) on conflict (day) do update set tokens = excluded.tokens', [deps.now().toISOString().slice(0, 10), deps.config.limits.globalDailyTokens]));
    await expect(checkBudget({ ...deps, db }, user.userId, true)).rejects.toMatchObject({ scope: 'global' });
  });

  it.each([
    ['thread_analysis', 'low', AnalysisOutputSchema],
    ['grounded_draft', 'low', DraftOutputSchema],
    ['view_compile', 'none', MatchOutputSchema],
    ['automation_compile', 'none', MatchOutputSchema],
    ['research', 'none', ResearchOutputSchema],
  ] as const)('%s sends reasoning effort %s', async (operation, effort, schema) => {
    const { deps, call, bodies } = await setup([]);
    await runStructured(deps, call({ operation, schema: schema as z.ZodTypeAny })).catch(() => undefined);
    expect(bodies[0]!.reasoning_effort).toBe(effort);
    expect((bodies[0]!.response_format as { json_schema: { name: string } }).json_schema.name).toBe(`pigeonbox_${operation}`);
    if (effort === 'none') expect(bodies[0]!.temperature).toBe(0.2);
    else expect(bodies[0]).not.toHaveProperty('temperature');
  });

  it('repairs malformed output once, with the same settings', async () => {
    const { deps, call, bodies } = await setup(['Sure! Here you go: {"text": ', VALID_SNIPPET]);
    const run = await runStructured(deps, call({ operation: 'snippet', schema: SnippetOutputSchema }));
    expect(run.value.text).toBe('Tuesday works');
    expect(bodies).toHaveLength(2);
    expect(bodies[1]!.response_format).toEqual(bodies[0]!.response_format);
    expect(bodies[1]!.reasoning_effort).toBe('low');
  });

  it('repairs output that is JSON but fails Zod validation', async () => {
    const { deps, call, bodies } = await setup(['{"text": 42}', VALID_SNIPPET]);
    expect((await runStructured(deps, call({ operation: 'snippet', schema: SnippetOutputSchema }))).value.text).toBe('Tuesday works');
    expect(bodies).toHaveLength(2);
  });

  it('fails with provider_invalid_response when the repair is malformed too', async () => {
    const { deps, call, bodies, h } = await setup(['nope', 'still nope']);
    await expect(runStructured(deps, call({ operation: 'snippet', schema: SnippetOutputSchema }))).rejects.toMatchObject({ code: 'provider_invalid_response' });
    expect(bodies).toHaveLength(2);
    expect(h.store.usageRows().find((row) => row.operation === 'intel.snippet')).toMatchObject({ status: 'error', errorCode: 'provider_invalid_response' });
  });

  it('runs background work on Flex and records it at Flex prices', async () => {
    const { deps, call, bodies, headers } = await setup([VALID_SNIPPET]);
    await runStructured(deps, call({ operation: 'snippet', schema: SnippetOutputSchema, interactive: false, requestId: 'req_background' }));
    expect(bodies[0]).toMatchObject({ model: 'openai/gpt-6-luna', reasoning_effort: 'low', service_tier: 'flex' });
    expect(JSON.parse(headers[0]!['cf-aig-metadata']!)).toMatchObject({ serviceTier: 'flex' });
    const [row] = await deps.db.system((tx) => tx.query<{ cost: string }>(`select estimated_cost_micros::text as cost from public.usage_events where request_id = 'req_background'`));
    // Half of the Standard 6_300 for the same tokens; usage_daily (the monthly budget) gets the same figure.
    expect(Number(row!.cost)).toBe(3_150);
    const [daily] = await deps.db.system((tx) => tx.query<{ cost: string }>(`select sum(cost_micros)::text as cost from public.usage_daily`));
    expect(Number(daily!.cost)).toBe(3_150);
  });

  it('keeps interactive work on Standard, and honors an explicit Standard override for background work', async () => {
    const { deps, call, bodies } = await setup([VALID_SNIPPET, VALID_SNIPPET]);
    await runStructured(deps, call({ operation: 'snippet', schema: SnippetOutputSchema, interactive: true }));
    await runStructured(deps, call({ operation: 'snippet', schema: SnippetOutputSchema, interactive: false, tier: 'standard' }));
    expect(bodies.map((body) => body.service_tier)).toEqual(['default', 'default']);
  });

  it('prices by the tier the provider reports, not the one requested', async () => {
    const { deps, call } = await setup([VALID_SNIPPET], { serviceTier: 'default' });
    await runStructured(deps, call({ operation: 'snippet', schema: SnippetOutputSchema, interactive: false, requestId: 'req_reported' }));
    const [row] = await deps.db.system((tx) => tx.query<{ cost: string }>(`select estimated_cost_micros::text as cost from public.usage_events where request_id = 'req_reported'`));
    expect(Number(row!.cost)).toBe(6_300);
  });

  it('can turn Flex off for background work with configuration', async () => {
    const { deps, call, bodies } = await setup([VALID_SNIPPET], { env: { CLOUD_AI_BACKGROUND_TIER: 'standard' } });
    await runStructured(deps, call({ operation: 'snippet', schema: SnippetOutputSchema, interactive: false }));
    expect(bodies[0]!.service_tier).toBe('default');
  });

  it('throttles background work late in an expensive month, but never interactive work before the hard budget', async () => {
    const { deps, h } = await setup([]);
    const user = await connectedUser(h, 'grace@work.test', ['mail_read']);
    const spend = async (micros: number) => {
      const day = deps.now().toISOString().slice(0, 10);
      await deps.db.system((tx) => tx.query(`insert into public.usage_daily (user_id, day, requests, tokens, cost_micros) values ($1::uuid, $2::date, 0, 0, $3)
        on conflict (user_id, day) do update set cost_micros = excluded.cost_micros`, [user.userId, day, micros]));
    };
    const scope = (interactive: boolean, priority: 'core' | 'enrichment' = 'core') => checkBudget(deps, user.userId, interactive, priority).then(() => 'ok', (error: { scope?: string }) => error.scope);
    await spend(1_000_000); // $1.00
    expect([await scope(false, 'enrichment'), await scope(false), await scope(true)]).toEqual(['ok', 'ok', 'ok']);
    await spend(1_300_000); // $1.30: memory learning pauses
    expect([await scope(false, 'enrichment'), await scope(false), await scope(true)]).toEqual(['user_background_throttled', 'ok', 'ok']);
    await spend(1_800_000); // $1.80: no background inference
    expect([await scope(false, 'enrichment'), await scope(false), await scope(true)]).toEqual(['user_background_throttled', 'user_background_throttled', 'ok']);
    await spend(2_000_000); // $2.00: hard budget
    expect([await scope(false), await scope(true)]).toEqual(['user_monthly', 'user_monthly']);
  });
});

describe('Flex capacity in background jobs', () => {
  /** Mock model that records the tier of every chat request. */
  class RecordingMock extends MockInferenceBackend {
    readonly tiers: Array<{ operation: string; tier: string }> = [];
    override async chat(request: ChatRequest, context: InferenceContext) {
      this.tiers.push({ operation: context.operation, tier: request.serviceTier });
      return super.chat(request, context);
    }
  }

  it('retries thread analysis on Flex with backoff, and falls back to rules only on the last attempt', async () => {
    const inference = new RecordingMock();
    const h = await createIntelHarness({ inference });
    const user = await connectedUser(h, 'ada@work.test', ['mail_read']);
    const { threadId } = await deliverAndSync(h, 'ada@work.test', { from: 'lee@client.test', to: ['ada@work.test'], subject: 'Contract', body: 'Can you sign the contract by Friday? [[mock:flex-capacity]]' });
    const analyze = () => h.sql<{ status: string; attempts: number; last_error_code: string | null }>(`select status, attempts, last_error_code from public.jobs where kind = 'thread.analyze' order by created_at desc limit 1`);
    const state = () => h.sql<{ source: string }>(`select s.source from public.thread_states s join public.threads t on t.id = s.thread_id where t.gmail_thread_id = $1`, [threadId]);

    expect(await analyze()).toEqual([{ status: 'retrying', attempts: 1, last_error_code: 'provider_rate_limited' }]);
    expect(await state()).toEqual([]);
    const analyses = inference.tiers.filter((call) => call.operation === 'thread_analysis');
    expect(analyses.length).toBeGreaterThan(0);
    expect(analyses.every((call) => call.tier === 'flex')).toBe(true);

    for (let attempt = 2; attempt <= 5; attempt += 1) {
      await h.advance(3_600_000);
      await h.drain();
    }
    expect(await analyze()).toMatchObject([{ status: 'succeeded', attempts: 5 }]);
    expect(await state()).toEqual([{ source: 'heuristic' }]);
    // Never retried on Standard.
    expect(inference.tiers.filter((call) => call.operation === 'thread_analysis').every((call) => call.tier === 'flex')).toBe(true);
    void user;
  });
});

describe('prompt caching', () => {
  const message = (text: string) => ({ from: 'lee@client.test', fromName: 'Lee', to: ['x'], cc: [], date: '2026-10-01T10:00:00.000Z', direction: 'inbound' as const, isAuto: false, listUnsubscribe: false, text, attachments: [] });

  it('keeps the analysis system prompt identical across users, time zones and times', () => {
    const one = analysisPrompt({ now: '2026-10-01T10:00:00.000Z', timeZone: 'UTC', ownerEmails: ['ada@work.test'], subject: 'A', labels: [], messages: [message('Hello')] });
    const two = analysisPrompt({ now: '2026-10-05T23:59:59.000Z', timeZone: 'Asia/Tokyo', ownerEmails: ['grace@else.test'], subject: 'B', labels: [], messages: [message('Other')] });
    expect(one.system).toBe(two.system);
    expect(one.system).not.toMatch(/ada@work|2026-10-01|UTC/);
    // The clock is the last field of the data, after the thread.
    expect(Object.keys(readDataBlock(one.user) as object).at(-1)).toBe('now');
  });

  it('starts every draft system prompt with the same rules, and puts per-owner details after them', () => {
    const base = { now: '2026-10-01T10:00:00.000Z', timeZone: 'UTC', recipients: [], subject: 'S', thread: [], sources: [], instructions: null, allowVariants: true,
      style: { greeting: null, signoff: null, targetWords: null, formality: 'neutral' as const, bullets: false, emoji: false, notes: [] } };
    const one = draftPrompt({ ...base, kind: 'reply', owner: { email: 'ada@work.test', name: 'Ada' } }).system;
    const two = draftPrompt({ ...base, kind: 'follow_up', now: '2026-10-05T00:00:00.000Z', owner: { email: 'grace@else.test', name: 'Grace' }, instructions: 'be brief', allowVariants: false }).system;
    const shared = one.slice(0, [...one].findIndex((char, i) => char !== two[i]));
    expect(shared.length).toBeGreaterThan(2_000);
    expect(shared).toContain('Return JSON:');
    expect(shared).not.toMatch(/Ada|Grace|2026/);
  });
});
