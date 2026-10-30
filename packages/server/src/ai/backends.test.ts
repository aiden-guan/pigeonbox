import { describe, expect, it } from 'vitest';
import { InferenceError, MockInferenceBackend, OpenAiCompatibleBackend, chatCompletionBody, createInferenceBackend, isTransientInferenceError, type ChatRequest } from './backends.js';
import { BACKGROUND_BANDS, backgroundAllowance, backgroundPriorityFor, processingTierFor, reasoningEffortFor, type ChatOperation, type ReasoningEffort } from './policy.js';
import { runAiOperation, type AiRequest } from './runner.js';
import { loadConfig } from '../config.js';
import { estimateCostMicros } from '../limits.js';
import { testEnv, THREAD, VOICE } from '../testing.js';

const context = () => ({ operation: 'summarize' as const, requestId: 'req_test', signal: new AbortController().signal });
const chat: ChatRequest = { messages: [{ role: 'user', content: 'Private email text' }], reasoningEffort: 'low', serviceTier: 'standard' };

function completion(text: string, model = 'm') {
  return new Response(JSON.stringify({ model, choices: [{ message: { content: text } }], usage: { prompt_tokens: 12, completion_tokens: 3 } }), { status: 200 });
}

type Seen = { url: string; model: string; headers: Record<string, string>; body: Record<string, unknown> };

function backend(responses: Array<Response | Error>, options: Partial<ConstructorParameters<typeof OpenAiCompatibleBackend>[0]> = {}) {
  const seen: Seen[] = [];
  const fetchImpl = (async (url: RequestInfo | URL, init?: RequestInit) => {
    const body = JSON.parse(String(init?.body)) as Record<string, unknown>;
    seen.push({ url: String(url), model: String(body.model), headers: init?.headers as Record<string, string>, body });
    const next = responses.shift()!;
    if (next instanceof Error) throw next;
    return next;
  }) as unknown as typeof fetch;
  const instance = new OpenAiCompatibleBackend({
    name: 'openai_compatible',
    baseUrl: 'https://ai.example/v1',
    apiKey: 'test-provider-key',
    models: ['primary', 'fallback'],
    embedModel: 'embed',
    timeoutMs: 50,
    gateway: false,
    fetch: fetchImpl,
    ...options,
  });
  return { instance, seen };
}

const SAMPLING = ['temperature', 'top_p', 'top_logprobs', 'logprobs'];

describe('OpenAiCompatibleBackend', () => {
  it('honors a longer Chat provider budget while cancellation still stops it', async () => {
    const slow = ((_url: RequestInfo | URL, init?: RequestInit) => new Promise<Response>((resolve, reject) => {
      const timer = setTimeout(() => resolve(completion('Done.')), 40);
      init!.signal!.addEventListener('abort', () => { clearTimeout(timer); reject(init!.signal!.reason); }, { once: true });
    })) as typeof fetch;
    const { instance } = backend([], { fetch: slow, timeoutMs: 10, models: ['primary'] });
    await expect(instance.chat(chat, context())).rejects.toMatchObject({ code: 'provider_timeout' });
    await expect(instance.chat(chat, { ...context(), timeoutMs: 1_000 })).resolves.toMatchObject({ text: 'Done.' });
    const cancel = new AbortController();
    const pending = instance.chat(chat, { ...context(), timeoutMs: 1_000, signal: cancel.signal });
    cancel.abort();
    await expect(pending).rejects.toMatchObject({ code: 'provider_timeout' });
  });
  it('makes exactly one provider attempt for compose_check, even with fallbacks configured', async () => {
    for (const response of [new Response('busy',{status:429}), new Response(JSON.stringify({error:{type:'invalid_request_error',code:'unsupported_parameter',param:'prompt_cache_key'}}),{status:400})]) {
      const {instance,seen}=backend([response,completion('never')]);
      await expect(instance.chat({...chat,reasoningEffort:'none'},{...context(),operation:'compose_check'})).rejects.toBeInstanceOf(InferenceError);
      expect(seen).toHaveLength(1);
    }
  });
  it('returns text, model and token usage', async () => {
    const { instance, seen } = backend([completion('{"ok":true}', 'primary-2026')]);
    const result = await instance.chat(chat, context());
    expect(result).toMatchObject({ text: '{"ok":true}', model: 'primary-2026', usage: { inputTokens: 12, outputTokens: 3 } });
    expect(seen[0]!.url).toBe('https://ai.example/v1/chat/completions');
    expect(seen[0]!.headers.Authorization).toBe('Bearer test-provider-key');
    expect(seen[0]!.headers['cf-aig-collect-log-payload']).toBeUndefined();
  });

  it('falls back to the next model on 429, 5xx and timeouts', async () => {
    const { instance, seen } = backend([new Response('busy', { status: 429 }), completion('fine', 'fallback')]);
    expect((await instance.chat(chat, context())).model).toBe('fallback');
    expect(seen.map((call) => call.model)).toEqual(['primary', 'fallback']);
    const five = backend([new Response('boom', { status: 503 }), completion('fine', 'fallback')]);
    expect((await five.instance.chat(chat, context())).model).toBe('fallback');
    const slow = backend([Object.assign(new Error('timed out'), { name: 'TimeoutError' }), completion('fine', 'fallback')]);
    expect((await slow.instance.chat(chat, context())).model).toBe('fallback');
    expect(slow.seen.map((call) => call.model)).toEqual(['primary', 'fallback']);
  });

  it('does not retry a request the provider rejected as invalid', async () => {
    const { instance, seen } = backend([new Response('bad', { status: 400 }), completion('never')]);
    await expect(instance.chat(chat, context())).rejects.toMatchObject({ code: 'provider_error', status: 400 });
    expect(seen).toHaveLength(1);
  });

  it('maps exhausted 429s, 500s and timeouts to contract codes without echoing provider bodies', async () => {
    const rate = backend([new Response('Private email text', { status: 429 }), new Response('x', { status: 429 })]);
    const error = await rate.instance.chat(chat, context()).catch((e: unknown) => e);
    expect(error).toBeInstanceOf(InferenceError);
    expect(error).toMatchObject({ code: 'provider_rate_limited' });
    expect((error as Error).message).not.toContain('Private');
    await expect(backend([new Response('x', { status: 500 }), new Response('x', { status: 500 })]).instance.chat(chat, context())).rejects.toMatchObject({ code: 'provider_error' });
    const timeout = Object.assign(new Error('timed out'), { name: 'TimeoutError' });
    await expect(backend([timeout, timeout]).instance.chat(chat, context())).rejects.toMatchObject({ code: 'provider_timeout' });
    await expect(backend([new TypeError('offline'), new TypeError('offline')]).instance.chat(chat, context())).rejects.toMatchObject({ code: 'provider_unavailable' });
  });

  it('turns a structured-output refusal into a generic error without the refusal text', async () => {
    const refusal = () => new Response(JSON.stringify({ choices: [{ message: { content: null, refusal: 'I cannot help with Private email text' } }] }), { status: 200 });
    const { instance } = backend([refusal(), refusal()]);
    const error = await instance.chat(chat, context()).catch((e: unknown) => e);
    expect(error).toBeInstanceOf(InferenceError);
    expect(error).toMatchObject({ code: 'provider_invalid_response' });
    expect((error as Error).message).not.toContain('Private');
  });

  it('sends AI Gateway privacy and billing headers when routed through Cloudflare', async () => {
    const { instance, seen } = backend([completion('ok')], { name: 'cloudflare', gateway: true, gatewayToken: 'gw-token' });
    await instance.chat(chat, context());
    const headers = seen[0]!.headers;
    expect(headers['cf-aig-collect-log-payload']).toBe('false');
    expect(headers['cf-aig-skip-cache']).toBe('true');
    expect(headers['cf-aig-no-wholesale']).toBe('true');
    expect(headers['cf-aig-authorization']).toBe('Bearer gw-token');
    expect(JSON.parse(headers['cf-aig-metadata']!)).toEqual({ operation: 'summarize', requestId: 'req_test', reasoningEffort: 'low', serviceTier: 'standard' });
    expect(Object.values(headers).join('\n')).not.toContain('Private');
  });

  it('sends no gateway headers on direct provider calls', async () => {
    const { instance, seen } = backend([completion('ok')]);
    await instance.chat(chat, context());
    expect(Object.keys(seen[0]!.headers).filter((name) => name.startsWith('cf-aig-'))).toEqual([]);
  });
});

describe('Chat Completions request body', () => {
  const request = (reasoningEffort: ReasoningEffort, extra: Partial<ChatRequest> = {}): ChatRequest => ({ messages: chat.messages, reasoningEffort, serviceTier: 'standard', ...extra });

  it('always states the reasoning effort', () => {
    for (const effort of ['none', 'low', 'medium', 'high', 'xhigh', 'max'] as const) {
      expect(chatCompletionBody('openai/gpt-6-luna', request(effort)).reasoning_effort).toBe(effort);
    }
  });

  it('keeps temperature only when reasoning is off', () => {
    expect(chatCompletionBody('m', request('none'))).toEqual({ model: 'm', messages: chat.messages, reasoning_effort: 'none', service_tier: 'default', temperature: 0.2 });
    for (const effort of ['low', 'medium', 'high', 'xhigh', 'max'] as const) {
      const body = chatCompletionBody('m', request(effort, { maxTokens: 300, repetitionPenalty: 1.1 }));
      for (const key of SAMPLING) expect(body, `${effort} ${key}`).not.toHaveProperty(key);
    }
  });

  it('caps completion tokens with room for reasoning, never with the legacy max_tokens', () => {
    expect(chatCompletionBody('m', request('none', { maxTokens: 120 }))).toMatchObject({ max_completion_tokens: 120 });
    const low = chatCompletionBody('m', request('low', { maxTokens: 300 }));
    expect(low.max_completion_tokens).toBeGreaterThan(300);
    expect(low).not.toHaveProperty('max_tokens');
    expect(chatCompletionBody('m', request('low'))).not.toHaveProperty('max_completion_tokens');
  });

  it('translates response formats', () => {
    expect(chatCompletionBody('m', request('none', { responseFormat: { type: 'json_object' } })).response_format).toEqual({ type: 'json_object' });
    const schema = { type: 'object', properties: {}, required: [], additionalProperties: false };
    expect(chatCompletionBody('m', request('low', { responseFormat: { type: 'json_schema', name: 'pigeonbox_snippet', schema } })).response_format).toEqual({
      type: 'json_schema',
      json_schema: { name: 'pigeonbox_snippet', strict: true, schema },
    });
    expect(chatCompletionBody('m', request('low'))).not.toHaveProperty('response_format');
  });
});

describe('public Cloud AI operations', () => {
  /** A gateway backend whose provider is the mock, so assertions see the real outgoing bodies. */
  function wired() {
    const mock = new MockInferenceBackend();
    const bodies: Array<Record<string, unknown>> = [];
    const fetchImpl = (async (_url: RequestInfo | URL, init?: RequestInit) => {
      const body = JSON.parse(String(init?.body)) as { messages: ChatRequest['messages'] } & Record<string, unknown>;
      bodies.push(body);
      const { operation } = JSON.parse((init?.headers as Record<string, string>)['cf-aig-metadata']!) as { operation: 'classify' };
      const reply = await mock.chat({ messages: body.messages, reasoningEffort: 'none', serviceTier: 'standard' }, { operation, requestId: 'r', signal: new AbortController().signal });
      return completion(reply.text, String(body.model));
    }) as unknown as typeof fetch;
    const instance = new OpenAiCompatibleBackend({
      name: 'cloudflare',
      baseUrl: 'https://gateway.ai.cloudflare.com/v1/a/g/compat',
      apiKey: 'k',
      models: ['openai/gpt-6-luna'],
      embedModel: 'embed',
      timeoutMs: 1_000,
      gateway: true,
      fetch: fetchImpl,
    });
    return { instance, bodies };
  }

  const REQUESTS: AiRequest[] = [
    { operation: 'classify', body: { input: { subject: 'Hi', snippet: 'x', bodyText: 'Can we meet?', latestSender: 'dana@example.com', direction: 'inbound' } } } as AiRequest,
    { operation: 'summarize', body: { input: THREAD } } as AiRequest,
    { operation: 'draft', body: { input: { ...THREAD, voice: VOICE, kind: 'reply' } } } as AiRequest,
    { operation: 'follow_up', body: { input: { ...THREAD, voice: VOICE, kind: 'follow_up' } } } as AiRequest,
    { operation: 'rewrite', body: { input: { text: 'make this better', mode: 'improve' } } } as AiRequest,
    { operation: 'ask', body: { input: { query: 'When is the review?', contextChunks: [{ threadId: 't1', subject: 'Review', text: 'Friday' }], coverageNote: 'All mail' } } } as AiRequest,
  ];

  it.each(REQUESTS.map((request) => [request.operation, request] as const))('%s sends its policy reasoning effort and JSON mode', async (operation, request) => {
    const { instance, bodies } = wired();
    const run = await runAiOperation(request, instance, { requestId: 'req_policy', signal: new AbortController().signal });
    expect(run.model).toBe('openai/gpt-6-luna');
    expect(bodies.length).toBeGreaterThan(0);
    for (const body of bodies) {
      expect(body.reasoning_effort).toBe(reasoningEffortFor(operation as Exclude<AiRequest['operation'], 'embed'>));
      expect(body.response_format).toEqual({ type: 'json_object' });
      if (body.reasoning_effort !== 'none') for (const key of SAMPLING) expect(body).not.toHaveProperty(key);
    }
  });

  it('uses the expected efforts for trivial and generative operations', () => {
    expect(reasoningEffortFor('classify')).toBe('none');
    expect(reasoningEffortFor('rewrite')).toBe('none');
    expect(reasoningEffortFor('summarize')).toBe('low');
    expect(reasoningEffortFor('draft')).toBe('low');
    expect(reasoningEffortFor('follow_up')).toBe('low');
    expect(reasoningEffortFor('ask')).toBe('low');
  });
});

describe('createInferenceBackend', () => {
  it('uses the mock without any credentials', () => {
    expect(createInferenceBackend(loadConfig(testEnv())).name).toBe('mock');
  });

  it('switches provider by configuration only', () => {
    const direct = createInferenceBackend(loadConfig(testEnv({ CLOUD_AI_PROVIDER: 'openai_compatible', CLOUD_AI_BASE_URL: 'https://api.openai.com/v1', CLOUD_AI_API_KEY: 'k', CLOUD_AI_PRIMARY_MODEL: 'gpt-x' })));
    expect(direct.name).toBe('openai_compatible');
    const gateway = createInferenceBackend(loadConfig(testEnv({ CLOUD_AI_PROVIDER: 'cloudflare', CLOUD_AI_BASE_URL: 'https://gateway.ai.cloudflare.com/v1/a/g/compat', CLOUD_AI_API_KEY: 'k' })));
    expect(gateway.name).toBe('cloudflare');
  });

  function production(env: Record<string, string>) {
    const seen: Array<{ url: string; headers: Record<string, string>; body: Record<string, unknown> }> = [];
    const fetchImpl = (async (url: RequestInfo | URL, init?: RequestInit) => {
      seen.push({ url: String(url), headers: init?.headers as Record<string, string>, body: JSON.parse(String(init?.body)) as Record<string, unknown> });
      return new Response('overloaded', { status: 503 });
    }) as unknown as typeof fetch;
    const config = loadConfig(testEnv({ CLOUD_AI_API_KEY: 'provider-key', CLOUD_AI_FALLBACK_MODELS: '', CLOUD_AI_INPUT_COST_PER_1K_MICROS: '100', CLOUD_AI_OUTPUT_COST_PER_1K_MICROS: '500', ...env }));
    return { config, seen, backend: createInferenceBackend(config, fetchImpl) };
  }

  it('runs GPT-6 Luna through Cloudflare AI Gateway with no fallback model', async () => {
    const { config, seen, backend: gateway } = production({
      CLOUD_AI_PROVIDER: 'cloudflare',
      CLOUD_AI_BASE_URL: 'https://gateway.ai.cloudflare.com/v1/acct/pigeonbox/compat',
      CLOUD_AI_GATEWAY_TOKEN: 'gw-token',
      CLOUD_AI_PRIMARY_MODEL: 'openai/gpt-6-luna',
    });
    expect(config.ai.fallbackModels).toEqual([]);
    expect(await gateway.health()).toMatchObject({ provider: 'cloudflare', models: ['openai/gpt-6-luna'] });
    // A capacity error with no fallback configured surfaces; nothing else is tried.
    await expect(gateway.chat(chat, context())).rejects.toMatchObject({ code: 'provider_error', status: 503 });
    expect(seen.map((call) => call.body.model)).toEqual(['openai/gpt-6-luna']);
    expect(seen[0]!.url).toBe('https://gateway.ai.cloudflare.com/v1/acct/pigeonbox/compat/chat/completions');
    expect(seen[0]!.headers['cf-aig-no-wholesale']).toBe('true');
    // Luna standard pricing: $0.10 / 1M input, $0.50 / 1M output.
    expect(estimateCostMicros(1_000_000, 1_000_000, config)).toBe(600_000);
  });

  it('accepts the raw OpenAI model id for direct calls', async () => {
    const { seen, backend: direct } = production({ CLOUD_AI_PROVIDER: 'openai_compatible', CLOUD_AI_BASE_URL: 'https://api.openai.com/v1', CLOUD_AI_PRIMARY_MODEL: 'gpt-6-luna' });
    await direct.chat(chat, context()).catch(() => undefined);
    expect(seen.map((call) => call.body.model)).toEqual(['gpt-6-luna']);
    expect(seen[0]!.url).toBe('https://api.openai.com/v1/chat/completions');
    expect(seen[0]!.headers['cf-aig-no-wholesale']).toBeUndefined();
  });
});

describe('tool calling', () => {
  const tools = [{ name: 'search_mail', description: 'Search Gmail', parameters: { type: 'object', properties: { query: { type: 'string' } }, required: ['query'], additionalProperties: false } }];

  it('sends tools and tool turns in the Chat Completions shape', () => {
    const body = chatCompletionBody('m', {
      reasoningEffort: 'low',
      serviceTier: 'standard',
      tools,
      messages: [
        { role: 'user', content: 'who is allen?' },
        { role: 'assistant', content: '', toolCalls: [{ id: 'call_1', name: 'search_mail', arguments: '{"query":"from:allen"}' }] },
        { role: 'tool', toolCallId: 'call_1', content: '{"results":[]}' },
      ],
    });
    expect(body.tools).toEqual([{ type: 'function', function: tools[0] }]);
    expect(body.tool_choice).toBe('auto');
    expect(body.parallel_tool_calls).toBe(true);
    expect(body.messages).toEqual([
      { role: 'user', content: 'who is allen?' },
      { role: 'assistant', content: null, tool_calls: [{ id: 'call_1', type: 'function', function: { name: 'search_mail', arguments: '{"query":"from:allen"}' } }] },
      { role: 'tool', tool_call_id: 'call_1', content: '{"results":[]}' },
    ]);
    expect(chatCompletionBody('m', { reasoningEffort: 'low', serviceTier: 'standard', tools, toolChoice: 'none', messages: [] })).toMatchObject({ tool_choice: 'none' });
    expect(chatCompletionBody('m', chat)).not.toHaveProperty('tools');
  });

  it('returns tool calls from a reply with no text', async () => {
    const reply = new Response(
      JSON.stringify({ model: 'm', choices: [{ message: { content: null, tool_calls: [{ id: 'call_9', type: 'function', function: { name: 'search_mail', arguments: '{"query":"from:allen"}' } }] } }], usage: { prompt_tokens: 5, completion_tokens: 2 } }),
      { status: 200 },
    );
    const { instance } = backend([reply]);
    const result = await instance.chat({ ...chat, tools }, context());
    expect(result.text).toBe('');
    expect(result.toolCalls).toEqual([{ id: 'call_9', name: 'search_mail', arguments: '{"query":"from:allen"}' }]);
  });
});

describe('streaming', () => {
  const sse = (chunks: unknown[]) =>
    new Response(chunks.map((chunk) => `data: ${typeof chunk === 'string' ? chunk : JSON.stringify(chunk)}\n\n`).join(''), { status: 200, headers: { 'Content-Type': 'text/event-stream' } });

  it('asks for a stream with usage and passes text through as it arrives', async () => {
    const pieces: string[] = [];
    const { instance, seen } = backend([
      sse([
        { model: 'm', choices: [{ delta: { content: 'Allen ' } }] },
        { model: 'm', choices: [{ delta: { content: 'wrote.' }, finish_reason: 'stop' }] },
        { model: 'm', choices: [], usage: { prompt_tokens: 40, completion_tokens: 4 } },
        '[DONE]',
      ]),
    ]);
    const result = await instance.chat({ ...chat, stream: (delta) => pieces.push(delta) }, context());
    expect(seen[0]!.body).toMatchObject({ stream: true, stream_options: { include_usage: true } });
    expect(pieces).toEqual(['Allen ', 'wrote.']);
    expect(result).toMatchObject({ text: 'Allen wrote.', usage: { inputTokens: 40, outputTokens: 4 } });
  });

  it('joins tool calls split across chunks and does not stream them as text', async () => {
    const pieces: string[] = [];
    const { instance } = backend([
      sse([
        { model: 'm', choices: [{ delta: { tool_calls: [{ index: 0, id: 'call_1', function: { name: 'search_mail', arguments: '{"que' } }] } }] },
        { model: 'm', choices: [{ delta: { tool_calls: [{ index: 0, function: { arguments: 'ry":"from:allen"}' } }, { index: 1, id: 'call_2', function: { name: 'find_contacts', arguments: '{"name":"allen"}' } }] } }] },
        { model: 'm', choices: [{ delta: {}, finish_reason: 'tool_calls' }] },
        '[DONE]',
      ]),
    ]);
    const result = await instance.chat({ ...chat, stream: (delta) => pieces.push(delta) }, context());
    expect(pieces).toEqual([]);
    expect(result.toolCalls).toEqual([
      { id: 'call_1', name: 'search_mail', arguments: '{"query":"from:allen"}' },
      { id: 'call_2', name: 'find_contacts', arguments: '{"name":"allen"}' },
    ]);
  });
});

describe('provider error details', () => {
  const rejected = (error: Record<string, unknown>) => new Response(JSON.stringify({ error }), { status: 400 });

  it('keeps only identifier fields, never the message', async () => {
    const { instance } = backend([rejected({ message: 'Private email text: wire $40k to Allen', type: 'invalid_request_error', code: 'unsupported_value', param: 'stream' })]);
    const error = (await instance.chat(chat, context()).catch((caught: unknown) => caught)) as InferenceError;
    expect(error.detail).toBe('invalid_request_error/unsupported_value/stream');
    expect(JSON.stringify({ ...error, message: error.message })).not.toMatch(/Private email|Allen|\$40k/);
  });

  it('drops fields that are not short identifiers', async () => {
    const { instance } = backend([rejected({ message: 'x', type: 'invalid_request_error', code: null, param: 'messages[1].content: Private email text' })]);
    const error = (await instance.chat(chat, context()).catch((caught: unknown) => caught)) as InferenceError;
    expect(error.detail).toBe('invalid_request_error/-/-');
  });

  it('answers whole when the provider refuses to stream, and stops asking to stream', async () => {
    const pieces: string[] = [];
    const { instance, seen } = backend([rejected({ type: 'invalid_request_error', code: 'unsupported_value', param: 'stream' }), completion('Allen wrote.'), completion('Again.')]);
    const first = await instance.chat({ ...chat, stream: (delta) => pieces.push(delta) }, context());
    expect(first).toMatchObject({ text: 'Allen wrote.', streamRefused: 'invalid_request_error/unsupported_value/stream' });
    expect(pieces).toEqual(['Allen wrote.']);
    expect(seen.map((request) => request.body.stream)).toEqual([true, undefined]);
    await instance.chat({ ...chat, stream: (delta) => pieces.push(delta) }, context());
    expect(seen[2]!.body.stream).toBeUndefined();
    expect(pieces).toEqual(['Allen wrote.', 'Again.']);
  });
});

describe('prompt caching', () => {
  const rejected = (error: Record<string, unknown>) => new Response(JSON.stringify({ error }), { status: 400 });

  it('names the operation as the cache key and reports cached input tokens', async () => {
    const reply = new Response(JSON.stringify({ model: 'm', choices: [{ message: { content: 'ok' } }], usage: { prompt_tokens: 2_000, completion_tokens: 5, prompt_tokens_details: { cached_tokens: 1_536 } } }), { status: 200 });
    const { instance, seen } = backend([reply]);
    const result = await instance.chat(chat, context());
    expect(seen[0]!.body.prompt_cache_key).toBe('pigeonbox-summarize');
    expect(result.usage).toEqual({ inputTokens: 2_000, outputTokens: 5, cachedInputTokens: 1_536 });
  });

  it('drops an optional field the provider rejects, and leaves it out from then on', async () => {
    const { instance, seen } = backend([rejected({ type: 'invalid_request_error', code: 'unknown_parameter', param: 'prompt_cache_key' }), completion('ok'), completion('again')]);
    expect((await instance.chat(chat, context())).text).toBe('ok');
    expect((await instance.chat(chat, context())).text).toBe('again');
    expect(seen.map((request) => 'prompt_cache_key' in request.body)).toEqual([true, false, false]);
  });

  it('still fails when the provider rejects a field the request needs', async () => {
    const { instance, seen } = backend([rejected({ type: 'invalid_request_error', code: 'invalid_value', param: 'messages' })]);
    await expect(instance.chat(chat, context())).rejects.toMatchObject({ code: 'provider_error', status: 400 });
    expect(seen).toHaveLength(1);
  });

  it('prices cached input at the cached rate (a tenth of input unless configured)', () => {
    const config = loadConfig(testEnv({ CLOUD_AI_INPUT_COST_PER_1K_MICROS: '100', CLOUD_AI_OUTPUT_COST_PER_1K_MICROS: '500' }));
    expect(estimateCostMicros(10_000, 1_000, config)).toBe(1_500);
    expect(estimateCostMicros(10_000, 1_000, config, 8_000)).toBe(200 + 80 + 500);
    const explicit = loadConfig(testEnv({ CLOUD_AI_INPUT_COST_PER_1K_MICROS: '100', CLOUD_AI_OUTPUT_COST_PER_1K_MICROS: '500', CLOUD_AI_CACHED_INPUT_COST_PER_1K_MICROS: '50' }));
    expect(estimateCostMicros(10_000, 1_000, explicit, 8_000)).toBe(200 + 400 + 500);
  });
});

describe('reasoning policy', () => {
  const MECHANICAL: ChatOperation[] = ['classify', 'rewrite', 'view_compile', 'automation_compile', 'research'];
  const SEMANTIC: ChatOperation[] = ['summarize', 'draft', 'follow_up', 'ask', 'memory_extract', 'thread_analysis', 'grounded_draft', 'snippet'];

  it('runs mechanical work with no reasoning and judgment work at low', () => {
    for (const operation of MECHANICAL) expect(reasoningEffortFor(operation), operation).toBe('none');
    for (const operation of SEMANTIC) expect(reasoningEffortFor(operation), operation).toBe('low');
  });

  it('never leaves an operation to the provider default (medium) or above', () => {
    for (const operation of [...MECHANICAL, ...SEMANTIC]) {
      const effort = reasoningEffortFor(operation);
      expect(['none', 'low'], operation).toContain(effort);
      expect(chatCompletionBody('openai/gpt-6-luna', { messages: [], reasoningEffort: effort, serviceTier: 'standard' }).reasoning_effort).toBe(effort);
    }
  });
});

describe('processing tier', () => {
  it('is Standard when someone is waiting and the background tier otherwise', () => {
    expect(processingTierFor({ interactive: true }, 'flex')).toBe('standard');
    expect(processingTierFor({ interactive: false }, 'flex')).toBe('flex');
    expect(processingTierFor({ interactive: false }, 'standard')).toBe('standard');
    expect(processingTierFor({ interactive: false, override: 'standard' }, 'flex')).toBe('standard');
  });

  it('always states service_tier: flex for Flex, default for Standard', () => {
    const base = { messages: chat.messages, reasoningEffort: 'low' as const };
    expect(chatCompletionBody('m', { ...base, serviceTier: 'flex' }).service_tier).toBe('flex');
    expect(chatCompletionBody('m', { ...base, serviceTier: 'standard' }).service_tier).toBe('default');
    // Same model and reasoning effort, different tier.
    const flex = chatCompletionBody('openai/gpt-6-luna', { ...base, serviceTier: 'flex' });
    const standard = chatCompletionBody('openai/gpt-6-luna', { ...base, serviceTier: 'standard' });
    expect({ ...flex, service_tier: null }).toEqual({ ...standard, service_tier: null });
  });

  it('sends the tier and effort, and labels the gateway metadata with them', async () => {
    const { instance, seen } = backend([completion('ok')], { name: 'cloudflare', gateway: true });
    await instance.chat({ ...chat, serviceTier: 'flex' }, context());
    expect(seen[0]!.body.service_tier).toBe('flex');
    expect(JSON.parse(seen[0]!.headers['cf-aig-metadata']!)).toMatchObject({ serviceTier: 'flex', reasoningEffort: 'low' });
    // Privacy headers are unchanged on Flex: no payload logging, no response caching.
    expect(seen[0]!.headers['cf-aig-collect-log-payload']).toBe('false');
    expect(seen[0]!.headers['cf-aig-skip-cache']).toBe('true');
  });

  it('reports the tier the provider used, and the tier sent when it does not say', async () => {
    const reply = (tier?: string) => new Response(JSON.stringify({ model: 'm', ...(tier ? { service_tier: tier } : {}), choices: [{ message: { content: 'ok' } }], usage: { prompt_tokens: 1, completion_tokens: 1 } }), { status: 200 });
    const { instance } = backend([reply('flex'), reply('default'), reply()]);
    expect((await instance.chat({ ...chat, serviceTier: 'flex' }, context())).serviceTier).toBe('flex');
    expect((await instance.chat({ ...chat, serviceTier: 'flex' }, context())).serviceTier).toBe('standard');
    expect((await instance.chat({ ...chat, serviceTier: 'flex' }, context())).serviceTier).toBe('flex');
  });

  it('reads the tier from a streamed reply', async () => {
    const sse = ['data: {"model":"m","service_tier":"default","choices":[{"delta":{"content":"hi"}}]}', 'data: {"choices":[{"delta":{},"finish_reason":"stop"}],"usage":{"prompt_tokens":2,"completion_tokens":1}}', 'data: [DONE]', ''].join('\n');
    const { instance } = backend([new Response(sse, { status: 200 })]);
    const result = await instance.chat({ ...chat, stream: () => undefined }, context());
    expect(result.serviceTier).toBe('standard');
  });

  it('drops service_tier only when the provider rejects the field, and then prices as Standard', async () => {
    const rejected = new Response(JSON.stringify({ error: { type: 'invalid_request_error', code: 'unknown_parameter', param: 'service_tier' } }), { status: 400 });
    const { instance, seen } = backend([rejected, completion('ok')]);
    const result = await instance.chat({ ...chat, serviceTier: 'flex' }, context());
    expect(seen[0]!.body.service_tier).toBe('flex');
    expect(seen[1]!.body).not.toHaveProperty('service_tier');
    expect(result.serviceTier).toBe('standard');
  });

  it('does not switch a Flex capacity failure to Standard', async () => {
    const capacity = () => new Response(JSON.stringify({ error: { type: 'invalid_request_error', code: 'resource_unavailable', param: null } }), { status: 429 });
    const { instance, seen } = backend([capacity()], { models: ['openai/gpt-6-luna'] });
    const error = await instance.chat({ ...chat, serviceTier: 'flex' }, context()).catch((e: unknown) => e);
    expect(error).toMatchObject({ code: 'provider_rate_limited', status: 429, detail: 'invalid_request_error/resource_unavailable/-' });
    expect(isTransientInferenceError(error)).toBe(true);
    expect(seen).toHaveLength(1);
    expect(seen.every((call) => call.body.service_tier === 'flex')).toBe(true);
  });

  it('gives Flex calls their own, longer timeout and keeps Standard short', async () => {
    const slow = (async (_url: RequestInfo | URL, init?: RequestInit) =>
      new Promise<Response>((resolve, reject) => {
        const timer = setTimeout(() => resolve(completion('late')), 80);
        init?.signal?.addEventListener('abort', () => {
          clearTimeout(timer);
          reject(Object.assign(new Error('aborted'), { name: 'TimeoutError' }));
        });
      })) as unknown as typeof fetch;
    const options = { name: 'openai_compatible' as const, baseUrl: 'https://ai.example/v1', apiKey: 'k', models: ['m'], embedModel: 'e', timeoutMs: 20, flexTimeoutMs: 1_000, gateway: false, fetch: slow };
    const instance = new OpenAiCompatibleBackend(options);
    await expect(instance.chat(chat, context())).rejects.toMatchObject({ code: 'provider_timeout' });
    expect((await instance.chat({ ...chat, serviceTier: 'flex' }, context())).text).toBe('late');
  });

  it('classifies capacity problems as transient and bad requests as not', () => {
    expect(isTransientInferenceError(new InferenceError('provider_rate_limited', 'x', 429))).toBe(true);
    expect(isTransientInferenceError(new InferenceError('provider_timeout', 'x'))).toBe(true);
    expect(isTransientInferenceError(new InferenceError('provider_unavailable', 'x'))).toBe(true);
    expect(isTransientInferenceError(new InferenceError('provider_error', 'x', 503))).toBe(true);
    expect(isTransientInferenceError(new InferenceError('provider_error', 'x', 400))).toBe(false);
    expect(isTransientInferenceError(new InferenceError('provider_invalid_response', 'x'))).toBe(false);
    expect(isTransientInferenceError(new Error('x'))).toBe(false);
  });
});

describe('tier-aware cost', () => {
  const production = loadConfig(testEnv({ CLOUD_AI_INPUT_COST_PER_1K_MICROS: '100', CLOUD_AI_OUTPUT_COST_PER_1K_MICROS: '500', CLOUD_AI_CACHED_INPUT_COST_PER_1K_MICROS: '10' }));

  it('uses GPT-6 Luna Standard and Flex rates', () => {
    expect(production.ai.pricing.standard).toEqual({ input: 100, cachedInput: 10, output: 500 });
    expect(production.ai.pricing.flex).toEqual({ input: 50, cachedInput: 5, output: 250 });
    // $ per 1M tokens: Standard 0.10 / 0.01 / 0.50, Flex 0.05 / 0.005 / 0.25.
    expect(estimateCostMicros(1_000_000, 0, production)).toBe(100_000);
    expect(estimateCostMicros(1_000_000, 0, production, 1_000_000)).toBe(10_000);
    expect(estimateCostMicros(0, 1_000_000, production)).toBe(500_000);
    expect(estimateCostMicros(1_000_000, 0, production, 0, 'flex')).toBe(50_000);
    expect(estimateCostMicros(1_000_000, 0, production, 1_000_000, 'flex')).toBe(5_000);
    expect(estimateCostMicros(0, 1_000_000, production, 0, 'flex')).toBe(250_000);
  });

  it('charges Flex about half of Standard for the same usage, cached input included', () => {
    for (const [input, cached, output] of [[12_000, 8_000, 900], [3_000, 0, 400], [250_000, 200_000, 2_000], [7, 3, 1]] as const) {
      const standard = estimateCostMicros(input, output, production, cached, 'standard');
      const flex = estimateCostMicros(input, output, production, cached, 'flex');
      expect(Math.abs(flex - standard / 2)).toBeLessThanOrEqual(1);
    }
  });

  it('accepts explicit Flex prices', () => {
    const explicit = loadConfig(testEnv({ CLOUD_AI_INPUT_COST_PER_1K_MICROS: '100', CLOUD_AI_OUTPUT_COST_PER_1K_MICROS: '500', CLOUD_AI_FLEX_INPUT_COST_PER_1K_MICROS: '40', CLOUD_AI_FLEX_CACHED_INPUT_COST_PER_1K_MICROS: '4', CLOUD_AI_FLEX_OUTPUT_COST_PER_1K_MICROS: '200' }));
    expect(explicit.ai.pricing.flex).toEqual({ input: 40, cachedInput: 4, output: 200 });
  });
});

describe('soft background cost control', () => {
  it('slows, then stops, background work before the hard budget; enrichment stops first', () => {
    expect(backgroundAllowance(0, 'core')).toBe(1);
    expect(backgroundAllowance(0.6, 'enrichment')).toBe(1);
    expect(backgroundAllowance(BACKGROUND_BANDS.soft, 'core')).toBe(0.5);
    expect(backgroundAllowance(BACKGROUND_BANDS.soft, 'enrichment')).toBe(0);
    expect(backgroundAllowance(BACKGROUND_BANDS.throttle, 'core')).toBe(0.25);
    expect(backgroundAllowance(BACKGROUND_BANDS.stop, 'core')).toBe(0);
    // With the $2 budget: $1.25, $1.40, $1.75.
    expect([BACKGROUND_BANDS.soft, BACKGROUND_BANDS.throttle, BACKGROUND_BANDS.stop].map((share) => share * 2)).toEqual([1.25, 1.4, 1.75]);
    expect(backgroundPriorityFor('memory_extract')).toBe('enrichment');
    expect(backgroundPriorityFor('thread_analysis')).toBe('core');
    expect(backgroundPriorityFor('grounded_draft')).toBe('core');
  });
});
