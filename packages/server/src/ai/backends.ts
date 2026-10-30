import type { AiOperation, CloudErrorCode } from '@pigeonbox/api-contract';
import type { Config } from '../config.js';
import type { JsonSchema } from './json-schema.js';
import { mockAgentStep, mockServerAnswer } from './mock-server.js';
import { allowsInferenceRetry, type ProcessingTier, type ReasoningEffort } from './policy.js';

/** A function call the model asked for. `arguments` is the model's raw JSON text. */
export type ToolCall = { id: string; name: string; arguments: string };

/** A function the model may call. `parameters` is JSON Schema. */
export type ToolSpec = { name: string; description: string; parameters: JsonSchema };

export type ChatMessage =
  | { role: 'system' | 'user'; content: string }
  | { role: 'assistant'; content: string; toolCalls?: ToolCall[] }
  | { role: 'tool'; toolCallId: string; content: string };

/** Ask for JSON: any object, or one matching a strict schema (see json-schema.ts). */
export type ChatResponseFormat = { type: 'json_object' } | { type: 'json_schema'; name: string; schema: JsonSchema };

export type ChatRequest = {
  messages: ChatMessage[];
  /** Cap on visible output tokens. */
  maxTokens?: number;
  /** Stream the reply: called with each piece of answer text as it arrives. */
  stream?: (delta: string) => void;
  repetitionPenalty?: number;
  /** Always set from the operation policy (policy.ts), so no call relies on a provider default. */
  reasoningEffort: ReasoningEffort;
  /** Always explicit (policy.ts processingTierFor): Standard when someone is waiting, Flex for background work. */
  serviceTier: ProcessingTier;
  responseFormat?: ChatResponseFormat;
  /** Functions the model may call instead of answering. */
  tools?: ToolSpec[];
  /** 'none' forces a final answer even when tools are listed. */
  toolChoice?: 'auto' | 'none';
};

/**
 * Server-side operations run by the intelligence layer (background jobs and
 * Cloud-only routes). Metered like the extension's operations.
 */
export type ServerOperation = 'memory_extract' | 'memory_consolidate' | 'thread_analysis' | 'grounded_draft' | 'view_compile' | 'automation_compile' | 'research' | 'snippet' | 'compose_check' | 'index_embed';

export type InferenceContext = {
  operation: AiOperation | ServerOperation;
  requestId: string;
  signal: AbortSignal;
  /** Operation-specific provider budget, still bounded by signal. */
  timeoutMs?: number;
};

export type InferenceUsage = {
  inputTokens: number;
  outputTokens: number;
  /** Part of inputTokens served from the provider's prompt cache (billed at a discount). */
  cachedInputTokens?: number;
};

export type ChatResult = {
  text: string;
  model: string;
  provider: string;
  usage: InferenceUsage;
  toolCalls?: ToolCall[];
  /** Set when a streamed request was refused and answered whole instead: the provider's error identifiers. */
  streamRefused?: string;
  /** The tier the provider says it used (or, when it does not say, the tier sent). Prices the call. */
  serviceTier: ProcessingTier;
};
export type EmbedResult = { vectors: number[][]; model: string; provider: string; usage: InferenceUsage };

/**
 * Hosted inference, independent of any one vendor. Swapping providers or models
 * is configuration (CLOUD_AI_*), never an extension release.
 */
export interface CloudInferenceBackend {
  readonly name: string;
  chat(request: ChatRequest, context: InferenceContext): Promise<ChatResult>;
  embed(texts: string[], context: InferenceContext): Promise<EmbedResult>;
  health(): Promise<{ ok: boolean; provider: string; models: string[] }>;
}

/** A provider failure with a contract error code. Carries no prompt or response content. */
export class InferenceError extends Error {
  constructor(
    readonly code: Extract<CloudErrorCode, 'provider_error' | 'provider_rate_limited' | 'provider_timeout' | 'provider_unavailable' | 'provider_invalid_response'>,
    message: string,
    readonly status?: number,
    /** Provider error identifiers, e.g. "invalid_request_error/unsupported_value/stream". Never message text. */
    readonly detail?: string,
  ) {
    super(message);
    this.name = 'InferenceError';
  }
}

/**
 * Capacity and availability failures that a later attempt can fix: rate limits
 * (including Flex "resource unavailable" 429s), timeouts, unreachable or failing
 * providers. Background jobs retry these with backoff instead of degrading.
 */
export function isTransientInferenceError(error: unknown): error is InferenceError {
  if (!(error instanceof InferenceError)) return false;
  if (error.code === 'provider_rate_limited' || error.code === 'provider_timeout' || error.code === 'provider_unavailable') return true;
  return error.code === 'provider_error' && (error.status ?? 0) >= 500;
}

const PROVIDER_ID = /^[A-Za-z0-9_.[\]-]{1,64}$/;

/**
 * The identifiers from an OpenAI-style error body ({error: {type, code, param}})
 * for operators. The message is dropped because it can quote the prompt, and
 * any field that is not a short identifier is dropped too.
 */
export async function providerErrorDetail(response: Response): Promise<string | undefined> {
  const text = await response.text().catch(() => '');
  let body: unknown;
  try {
    body = JSON.parse(text.slice(0, 8_000));
  } catch {
    return undefined;
  }
  const error = (body as { error?: Record<string, unknown> } | null)?.error;
  if (!error || typeof error !== 'object') return undefined;
  const parts = ['type', 'code', 'param'].map((key) => {
    const value = error[key];
    return typeof value === 'string' && PROVIDER_ID.test(value) ? value : '-';
  });
  return parts.every((part) => part === '-') ? undefined : parts.join('/');
}

const estimateTokens = (text: string) => Math.ceil(text.length / 4);

// ---------------------------------------------------------------------------
// Mock: deterministic, offline, no credentials. Development and tests only.
// Fault injection: put [[mock:429]], [[mock:500]], [[mock:timeout]],
// [[mock:flex-capacity]] or [[mock:garbage]] anywhere in the request text.
// ---------------------------------------------------------------------------

export class MockInferenceBackend implements CloudInferenceBackend {
  readonly name = 'mock';

  constructor(
    private readonly model = 'mock-small',
    private readonly dimensions = 768,
  ) {}

  async chat(request: ChatRequest, context: InferenceContext): Promise<ChatResult> {
    const prompt = request.messages.map((message) => message.content).join('\n');
    await this.faults(prompt, context.signal);
    // Garbage persists through the JSON repair round trip, whose prompt quotes the previous output.
    const garbage = prompt.includes('[[mock:garbage]]') || prompt.includes('not json at all');
    if (request.tools?.length && !garbage) {
      const step = mockAgentStep(request);
      const text = step.text;
      if (request.stream && !step.toolCalls.length) for (const piece of text.match(/\S+\s*/g) ?? []) request.stream(piece);
      return {
        text,
        ...(step.toolCalls.length ? { toolCalls: step.toolCalls } : {}),
        model: this.model,
        provider: this.name,
        usage: { inputTokens: estimateTokens(prompt), outputTokens: estimateTokens(text + JSON.stringify(step.toolCalls)) },
        serviceTier: request.serviceTier,
      };
    }
    const text = garbage ? 'not json at all' : this.answer(context.operation, prompt);
    return {
      text,
      model: this.model,
      provider: this.name,
      usage: { inputTokens: estimateTokens(prompt), outputTokens: estimateTokens(text) },
      serviceTier: request.serviceTier,
    };
  }

  /**
   * Deterministic bag-of-words embeddings: texts that share words point in
   * similar directions, so retrieval tests behave like a real model would.
   */
  async embed(texts: string[], context: InferenceContext): Promise<EmbedResult> {
    await this.faults(texts.join('\n'), context.signal);
    const vectors = texts.map((text) => mockEmbedding(text, this.dimensions));
    return { vectors, model: 'mock-embed', provider: this.name, usage: { inputTokens: estimateTokens(texts.join(' ')), outputTokens: 0 } };
  }

  async health() {
    return { ok: true, provider: this.name, models: [this.model] };
  }

  private async faults(prompt: string, signal: AbortSignal) {
    if (prompt.includes('[[mock:flex-capacity]]')) throw new InferenceError('provider_rate_limited', 'Mock Flex capacity unavailable.', 429, 'invalid_request_error/resource_unavailable/-');
    if (prompt.includes('[[mock:429]]')) throw new InferenceError('provider_rate_limited', 'Mock provider rate limited.', 429);
    if (prompt.includes('[[mock:500]]')) throw new InferenceError('provider_error', 'Mock provider failed.', 500);
    if (prompt.includes('[[mock:timeout]]')) {
      await new Promise<never>((_, reject) => {
        signal.addEventListener('abort', () => reject(new InferenceError('provider_timeout', 'Mock provider timed out.')), { once: true });
      });
    }
  }

  private answer(operation: InferenceContext["operation"], prompt: string): string {
    switch (operation) {
      case 'classify': {
        const promo = /unsubscribe|% off|sale ends/i.test(prompt);
        return JSON.stringify({
          category: promo ? 'PROMOTIONS' : 'RESPOND',
          confidence: 0.9,
          priority: 'NORMAL',
          needsReply: !promo,
          waitingOnReply: false,
          archiveRecommendation: promo,
          reason: 'Mock classification',
          deadline: null,
        });
      }
      case 'summarize':
        return JSON.stringify({
          oneLine: `Mock summary of a ${prompt.length}-character thread.`,
          keyPoints: ['Mock key point'],
          decisions: [],
          unansweredQuestions: [],
          commitments: [],
          dates: [],
          actionItems: ['Reply when ready'],
        });
      case 'draft':
      case 'follow_up':
        return JSON.stringify({
          mode: 'direct',
          body: 'Thanks for the note. I will look into this and get back to you tomorrow with a proper answer.',
          placeholders: [],
        });
      case 'rewrite':
        return JSON.stringify({ text: 'This is the rewritten text from the mock provider.' });
      case 'ask':
        return JSON.stringify({ answer: 'The mock provider answered from the supplied context.', citations: [], incompleteIndex: false });
      default:
        return mockServerAnswer(operation, prompt);
    }
  }
}

// ---------------------------------------------------------------------------
// OpenAI-compatible chat completions: OpenAI, OpenRouter, Workers AI, vLLM,
// or Cloudflare AI Gateway's compat endpoint. `gateway` adds AI Gateway
// privacy headers; direct provider calls skip the gateway entirely.
// ---------------------------------------------------------------------------

export type OpenAiCompatibleOptions = {
  name: 'openai_compatible' | 'cloudflare';
  baseUrl: string;
  apiKey: string;
  models: string[];
  embedModel: string;
  embedDimensions?: number;
  timeoutMs: number;
  /** Per-request timeout for Flex calls, which can queue longer. Background only, so latency is not felt. */
  flexTimeoutMs?: number;
  gateway: boolean;
  gatewayToken?: string;
  fetch?: typeof fetch;
};

export class OpenAiCompatibleBackend implements CloudInferenceBackend {
  readonly name: string;
  private readonly fetchImpl: typeof fetch;

  constructor(private readonly options: OpenAiCompatibleOptions) {
    this.name = options.name;
    this.fetchImpl = options.fetch ?? ((input, init) => fetch(input, init));
  }

  private headers(context: InferenceContext, settings?: Pick<ChatRequest, 'reasoningEffort' | 'serviceTier'>): Record<string, string> {
    const headers: Record<string, string> = {
      'Content-Type': 'application/json',
      Authorization: `Bearer ${this.options.apiKey}`,
    };
    if (this.options.gateway) {
      // Email content: keep request/response bodies out of gateway logs and never cache them.
      headers['cf-aig-collect-log-payload'] = 'false';
      headers['cf-aig-skip-cache'] = 'true';
      // Fail instead of silently billing through Cloudflare Unified Billing if the provider key is missing.
      headers['cf-aig-no-wholesale'] = 'true';
      // Operational metadata only. No user identifiers or content.
      headers['cf-aig-metadata'] = JSON.stringify({
        operation: context.operation,
        requestId: context.requestId,
        ...(settings ? { reasoningEffort: settings.reasoningEffort, serviceTier: settings.serviceTier } : {}),
      });
      if (this.options.gatewayToken) headers['cf-aig-authorization'] = `Bearer ${this.options.gatewayToken}`;
    }
    return headers;
  }

  private async post(path: string, body: unknown, context: InferenceContext, settings?: Pick<ChatRequest, 'reasoningEffort' | 'serviceTier'>): Promise<Response> {
    const timeout = AbortSignal.timeout(context.timeoutMs ?? (settings?.serviceTier === 'flex' ? (this.options.flexTimeoutMs ?? this.options.timeoutMs) : this.options.timeoutMs));
    const signal = AbortSignal.any([timeout, context.signal]);
    try {
      signal.throwIfAborted();
      return await this.fetchImpl(`${this.options.baseUrl.replace(/\/+$/, '')}${path}`, {
        method: 'POST',
        headers: this.headers(context, settings),
        body: JSON.stringify(body),
        signal,
      });
    } catch (error) {
      if (timeout.aborted || context.signal.aborted || (error as { name?: string })?.name === 'TimeoutError') {
        throw new InferenceError('provider_timeout', 'The AI provider did not respond in time.');
      }
      throw new InferenceError('provider_unavailable', 'The AI provider is unreachable.');
    }
  }

  /** Status → error. The provider's error body is discarded: it can echo the prompt. */
  private async failure(response: Response): Promise<InferenceError> {
    const detail = await providerErrorDetail(response);
    if (response.status === 429) return new InferenceError('provider_rate_limited', 'The AI provider is rate limiting requests.', 429, detail);
    if (response.status === 408 || response.status === 504) return new InferenceError('provider_timeout', 'The AI provider timed out.', response.status, detail);
    if (response.status >= 500) return new InferenceError('provider_error', 'The AI provider failed.', response.status, detail);
    return new InferenceError('provider_error', `The AI provider rejected the request (${response.status}).`, response.status, detail);
  }

  /** Set once the provider refuses a streamed request, so later calls in this isolate skip straight to whole replies. */
  private streamRefused = false;
  /** Optional body fields the provider has rejected in this isolate; they are left out from then on. */
  private readonly unsupported = new Set<string>();

  async chat(request: ChatRequest, context: InferenceContext): Promise<ChatResult> {
    const stream = request.stream;
    if (!stream || this.streamRefused) return this.chatOnce({ ...request, stream: undefined }, context, stream);
    try {
      return await this.chatOnce(request, context);
    } catch (error) {
      // Some accounts cannot stream some models (OpenAI asks for organization verification first). Ask again, whole.
      if (!(error instanceof InferenceError) || error.code !== 'provider_error' || error.status !== 400) throw error;
      const reply = await this.chatOnce({ ...request, stream: undefined }, context, stream);
      // Only now is it clear that streaming, not something else in the request, was the problem.
      this.streamRefused = true;
      return { ...reply, streamRefused: error.detail ?? 'unknown' };
    }
  }

  /** One request through the model list. `whole` receives the full text when streaming was skipped. */
  private async chatOnce(request: ChatRequest, context: InferenceContext, whole?: (text: string) => void): Promise<ChatResult> {
    let last: InferenceError | null = null;
    for (const model of allowsInferenceRetry(context.operation) ? this.options.models : this.options.models.slice(0,1)) {
      const send = () =>
        this.post('/chat/completions', chatCompletionBody(model, request, { cacheKey: `pigeonbox-${context.operation}`, omit: this.unsupported }), context, request).catch((error: unknown) => {
          if (error instanceof InferenceError) return error;
          throw error;
        });
      let response = await send();
      // A provider that rejects an optional field (prompt caching hints and the like) gets the request again without it.
      if (!(response instanceof InferenceError) && response.status === 400) {
        const rejected = await this.failure(response);
        const param = rejected.detail?.split('/')[2];
        if (!allowsInferenceRetry(context.operation) || !param || !OPTIONAL_PARAMS.has(param) || this.unsupported.has(param)) {
          last = rejected;
          break;
        }
        this.unsupported.add(param);
        response = await send();
      }
      if (response instanceof InferenceError) {
        last = response;
        if (context.signal.aborted) break;
        continue;
      }
      if (!response.ok) {
        last = await this.failure(response);
        // Fall back to the next model only for capacity problems, not for bad requests.
        if (last.code === 'provider_error' && (last.status ?? 0) < 500) break;
        continue;
      }
      const read = request.stream ? await readCompletionStream(response, request.stream, context.signal) : await readCompletion(response);
      if (read === null) {
        last = new InferenceError(context.signal.aborted ? 'provider_timeout' : 'provider_unavailable', 'The AI provider stream ended early.');
        if (context.signal.aborted) break;
        continue;
      }
      const { data, message } = read;
      const text = message?.content;
      if (message?.refusal) {
        // The refusal text is discarded like an error body: it can quote the prompt.
        last = new InferenceError('provider_invalid_response', 'The AI provider declined the request.');
        continue;
      }
      const toolCalls = (message?.tool_calls ?? [])
        .filter((call) => call.function?.name)
        .map((call, index) => ({ id: call.id || `call_${index}`, name: call.function!.name!, arguments: call.function!.arguments ?? '{}' }));
      if (!toolCalls.length && (typeof text !== 'string' || !text.trim())) {
        last = new InferenceError('provider_invalid_response', 'The AI provider returned an empty response.');
        continue;
      }
      if (whole && !toolCalls.length && text) whole(text);
      // Price by what the provider reports; when it is silent, by what was sent (Standard if service_tier had to be dropped).
      const sentTier: ProcessingTier = this.unsupported.has('service_tier') ? 'standard' : request.serviceTier;
      const serviceTier: ProcessingTier = typeof data?.service_tier === 'string' ? (data.service_tier === 'flex' ? 'flex' : 'standard') : sentTier;
      return {
        text: text ?? '',
        ...(toolCalls.length ? { toolCalls } : {}),
        model: data?.model || model,
        provider: this.name,
        usage: {
          inputTokens: data?.usage?.prompt_tokens ?? estimateTokens(request.messages.map((m) => m.content).join('\n')),
          outputTokens: data?.usage?.completion_tokens ?? estimateTokens(text ?? ''),
          ...(data?.usage?.prompt_tokens_details?.cached_tokens ? { cachedInputTokens: data.usage.prompt_tokens_details.cached_tokens } : {}),
        },
        serviceTier,
      };
    }
    throw last ?? new InferenceError('provider_unavailable', 'No AI model is configured.');
  }

  async embed(texts: string[], context: InferenceContext): Promise<EmbedResult> {
    const dimensions = /^text-embedding-3/.test(this.options.embedModel) && this.options.embedDimensions ? { dimensions: this.options.embedDimensions } : {};
    const response = await this.post('/embeddings', { model: this.options.embedModel, input: texts, ...dimensions }, context);
    if (!response.ok) throw await this.failure(response);
    const data = (await response.json().catch(() => null)) as { data?: Array<{ embedding?: number[] }>; usage?: { prompt_tokens?: number } } | null;
    const vectors = data?.data?.map((row) => row.embedding ?? []) ?? [];
    if (vectors.length !== texts.length) throw new InferenceError('provider_invalid_response', 'The AI provider returned the wrong number of embeddings.');
    return {
      vectors,
      model: this.options.embedModel,
      provider: this.name,
      usage: { inputTokens: data?.usage?.prompt_tokens ?? estimateTokens(texts.join(' ')), outputTokens: 0 },
    };
  }

  async health() {
    // No network call: a health probe must not spend inference budget.
    return { ok: Boolean(this.options.baseUrl && this.options.apiKey), provider: this.name, models: this.options.models };
  }
}

/**
 * Reasoning tokens count against the completion cap, so reasoning calls get
 * room to think on top of the visible-output budget. Only used tokens are billed.
 */
const REASONING_HEADROOM: Record<ReasoningEffort, number> = { none: 0, low: 1_024, medium: 4_096, high: 8_192, xhigh: 16_384, max: 32_768 };

/** Body fields a request works without. If the provider rejects one, it is dropped rather than failing the call. */
const OPTIONAL_PARAMS: ReadonlySet<string> = new Set(['prompt_cache_key', 'parallel_tool_calls', 'stream_options', 'service_tier']);

/**
 * ChatRequest → Chat Completions body. Reasoning models reject sampling parameters unless reasoning is off.
 *
 * `service_tier` is always sent: "flex" for background work (half price), "default"
 * otherwise, so no request falls into an account-level default tier by accident.
 *
 * `cacheKey` is a routing hint for the provider's prompt cache: requests with the
 * same key and the same leading tokens (tools, system prompt) reuse cached
 * input, which is cheaper and faster. It names the operation only, never a user.
 */
export function chatCompletionBody(model: string, request: ChatRequest, options: { cacheKey?: string; omit?: ReadonlySet<string> } = {}): Record<string, unknown> {
  const body: Record<string, unknown> = {
    model,
    messages: request.messages.map(wireMessage),
    reasoning_effort: request.reasoningEffort,
    service_tier: request.serviceTier === 'flex' ? 'flex' : 'default',
  };
  if (options.cacheKey) body.prompt_cache_key = options.cacheKey;
  if (request.reasoningEffort === 'none') body.temperature = 0.2;
  if (request.stream) {
    body.stream = true;
    // Usage arrives in a final chunk, so metering stays exact.
    body.stream_options = { include_usage: true };
  }
  if (request.maxTokens) body.max_completion_tokens = request.maxTokens + REASONING_HEADROOM[request.reasoningEffort];
  if (request.responseFormat?.type === 'json_object') body.response_format = { type: 'json_object' };
  if (request.responseFormat?.type === 'json_schema') {
    body.response_format = { type: 'json_schema', json_schema: { name: request.responseFormat.name, strict: true, schema: request.responseFormat.schema } };
  }
  if (request.tools?.length) {
    body.tools = request.tools.map((tool) => ({ type: 'function', function: { name: tool.name, description: tool.description, parameters: tool.parameters } }));
    body.tool_choice = request.toolChoice ?? 'auto';
    if ((request.toolChoice ?? 'auto') === 'auto') body.parallel_tool_calls = true;
  }
  for (const key of options.omit ?? []) delete body[key];
  return body;
}

type CompletionMessage = { content?: string | null; refusal?: string | null; tool_calls?: Array<{ id?: string; type?: string; function?: { name?: string; arguments?: string } }> };
type CompletionUsage = { prompt_tokens?: number; completion_tokens?: number; prompt_tokens_details?: { cached_tokens?: number } };
type CompletionData = { model?: string; service_tier?: string | null; choices?: Array<{ message?: CompletionMessage }>; usage?: CompletionUsage } | null;
type StreamChunk = {
  model?: string;
  service_tier?: string | null;
  usage?: CompletionUsage;
  choices?: Array<{ delta?: Omit<CompletionMessage, 'tool_calls'> & { tool_calls?: Array<{ index?: number; id?: string; function?: { name?: string; arguments?: string } }> }; finish_reason?: string | null }>;
};

async function readCompletion(response: Response): Promise<{ data: CompletionData; message: CompletionMessage | undefined }> {
  const data = (await response.json().catch(() => null)) as CompletionData;
  return { data, message: data?.choices?.[0]?.message };
}

/**
 * Server-sent events from a streamed completion, assembled into the same
 * shape as a whole response. Text deltas are passed on as they arrive; tool
 * call fragments are joined by index. Null when the stream breaks off.
 */
async function readCompletionStream(response: Response, onText: (delta: string) => void, signal: AbortSignal): Promise<{ data: CompletionData; message: CompletionMessage } | null> {
  if (!response.body) return null;
  const reader = response.body.pipeThrough(new TextDecoderStream()).getReader();
  const message: CompletionMessage = { content: '' };
  const calls = new Map<number, { id: string; name: string; arguments: string }>();
  let model: string | undefined;
  let serviceTier: string | undefined;
  let usage: StreamChunk['usage'];
  let buffer = '';
  let finished = false;
  const line = (raw: string) => {
    const trimmed = raw.trim();
    if (!trimmed.startsWith('data:')) return;
    const payload = trimmed.slice(5).trim();
    if (payload === '[DONE]') {
      finished = true;
      return;
    }
    let chunk: StreamChunk;
    try {
      chunk = JSON.parse(payload) as StreamChunk;
    } catch {
      return;
    }
    model ||= chunk.model;
    if (typeof chunk.service_tier === 'string') serviceTier = chunk.service_tier;
    if (chunk.usage) usage = chunk.usage;
    for (const choice of chunk.choices ?? []) {
      const delta = choice.delta;
      if (choice.finish_reason) finished = true;
      if (!delta) continue;
      if (delta.refusal) message.refusal = (message.refusal ?? '') + delta.refusal;
      if (delta.content) {
        message.content += delta.content;
        if (!calls.size) onText(delta.content);
      }
      for (const fragment of delta.tool_calls ?? []) {
        const index = fragment.index ?? 0;
        const entry = calls.get(index) ?? { id: '', name: '', arguments: '' };
        if (fragment.id) entry.id = fragment.id;
        if (fragment.function?.name) entry.name += fragment.function.name;
        if (fragment.function?.arguments) entry.arguments += fragment.function.arguments;
        calls.set(index, entry);
      }
    }
  };
  try {
    for (;;) {
      const { value, done } = await reader.read();
      if (done) break;
      buffer += value;
      let newline = buffer.indexOf('\n');
      while (newline >= 0) {
        line(buffer.slice(0, newline));
        buffer = buffer.slice(newline + 1);
        newline = buffer.indexOf('\n');
      }
    }
    line(buffer);
  } catch {
    await reader.cancel().catch(() => undefined);
    return null;
  }
  if (!finished && !message.content && !calls.size) return null;
  if (signal.aborted && !finished) return null;
  message.tool_calls = [...calls.entries()].sort(([a], [b]) => a - b).map(([, call]) => ({ id: call.id, type: 'function', function: { name: call.name, arguments: call.arguments || '{}' } }));
  return { data: { model, service_tier: serviceTier, usage, choices: [{ message }] }, message };
}

/** ChatMessage → the Chat Completions wire shape. */
function wireMessage(message: ChatMessage): Record<string, unknown> {
  if (message.role === 'tool') return { role: 'tool', tool_call_id: message.toolCallId, content: message.content };
  if (message.role === 'assistant' && message.toolCalls?.length) {
    return {
      role: 'assistant',
      content: message.content || null,
      tool_calls: message.toolCalls.map((call) => ({ id: call.id, type: 'function', function: { name: call.name, arguments: call.arguments } })),
    };
  }
  return { role: message.role, content: message.content };
}

function mockEmbedding(text: string, dimensions: number): number[] {
  const vector = new Array<number>(dimensions).fill(0);
  const words = text.toLowerCase().match(/[a-z0-9]{3,}/g) ?? [];
  for (const word of words) {
    let hash = 2166136261;
    for (let i = 0; i < word.length; i += 1) hash = Math.imul(hash ^ word.charCodeAt(i), 16777619) >>> 0;
    vector[hash % dimensions] += 1;
  }
  const norm = Math.sqrt(vector.reduce((sum, value) => sum + value * value, 0)) || 1;
  return vector.map((value) => value / norm);
}

export function createInferenceBackend(config: Config, fetchImpl?: typeof fetch): CloudInferenceBackend {
  const ai = config.ai;
  if (ai.provider === 'mock') return new MockInferenceBackend(ai.primaryModel, config.intel.embedDimensions);
  return new OpenAiCompatibleBackend({
    name: ai.provider,
    baseUrl: ai.baseUrl!,
    apiKey: ai.apiKey!,
    models: [ai.primaryModel, ...ai.fallbackModels],
    embedModel: ai.embedModel,
    embedDimensions: config.intel.embedDimensions,
    timeoutMs: ai.timeoutMs,
    flexTimeoutMs: ai.flexTimeoutMs,
    gateway: ai.provider === 'cloudflare',
    gatewayToken: ai.gatewayToken,
    fetch: fetchImpl,
  });
}
