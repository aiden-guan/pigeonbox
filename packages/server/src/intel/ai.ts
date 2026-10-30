import { extractJsonObject } from '@pigeonbox/ai';
import type { z } from 'zod';
import { InferenceError, type ChatMessage, type ChatResult, type ServerOperation, type ToolSpec } from '../ai/backends.js';
import { structuredResponseFormat } from '../ai/json-schema.js';
import { backgroundAllowance, backgroundPriorityFor, processingTierFor, reasoningEffortFor, type BackgroundPriority, type ProcessingTier } from '../ai/policy.js';
import { num, one } from '../db/sql.js';
import { dayStart, monthStart } from '../store/types.js';
import { estimateCostMicros } from '../limits.js';
import type { IntelDeps } from './context.js';

/**
 * Structured model calls for the intelligence layer: budget check, one
 * completion, JSON extraction, schema validation, one repair round trip, and a
 * usage row with no content. Background work has its own daily limit so it
 * cannot starve interactive use, and it shares the monthly token limit and the
 * global budget.
 *
 * Background calls run on the Flex tier (half price) unless configured
 * otherwise; a Flex capacity failure surfaces as a transient InferenceError and
 * the job retries with backoff instead of paying for Standard.
 */

export class BudgetExceededError extends Error {
  /** `user_background_throttled`: soft cost control late in an expensive month (policy.ts backgroundAllowance). */
  constructor(readonly scope: 'user_background' | 'user_background_throttled' | 'user_monthly' | 'global') {
    super(`budget_${scope}`);
    this.name = 'BudgetExceededError';
  }
}

export type StructuredCall<T> = {
  userId: string;
  operation: Exclude<ServerOperation, 'index_embed'>;
  system: string;
  user: string;
  schema: z.ZodType<T>;
  maxTokens?: number;
  /** Counted as an interactive request (the user is waiting) rather than background work. */
  interactive?: boolean;
  /**
   * Forces a processing tier. Only for background calls whose failure cannot be
   * retried later (see policy.ts processingTierFor); otherwise the tier follows `interactive`.
   */
  tier?: ProcessingTier;
  requestId: string;
  timeoutMs?: number;
  signal?: AbortSignal;
  /** Live checks fail closed after one reply instead of spending on repair. */
  repair?: boolean;
  /** A request lifetime hook (Worker waitUntil), so accounting can finish while
   * the caller validates sources or returns its already validated answer. */
  defer?: (work: Promise<void>) => void;
};

export type StructuredResult<T> = { value: T; model: string | null; inputTokens: number; outputTokens: number; latencyMs: number };

/**
 * Throws BudgetExceededError when the user or the service is out of AI budget.
 * Background work also slows down, then stops, as the month's spend nears the
 * hard budget, so explicit user actions keep working the longest.
 */
export async function checkBudget(deps: IntelDeps, userId: string, interactive: boolean, priority: BackgroundPriority = 'core'): Promise<void> {
  const now = deps.now();
  const usage = await deps.db.asUser(userId, async (tx) => {
    // One user-scoped statement avoids three serialized network round trips.
    const row = await one<{ background: number; month_tokens: string; month_cost: string; global_tokens: string }>(
      tx,
      `select
        coalesce((select background_requests from public.usage_daily where user_id = $1::uuid and day = $2::date), 0)::int as background,
        (select coalesce(sum(tokens), 0)::text from public.usage_daily where user_id = $1::uuid and day >= $3::date) as month_tokens,
        (select coalesce(sum(cost_micros), 0)::text from public.usage_daily where user_id = $1::uuid and day >= $3::date) as month_cost,
        coalesce((select tokens from public.usage_global_daily where day = $2::date), 0)::text as global_tokens`,
      [userId, dayStart(now).toISOString().slice(0, 10), monthStart(now).toISOString().slice(0, 10)],
    );
    return { background: num(row?.background), monthTokens: num(row?.month_tokens), monthCost: num(row?.month_cost), globalTokens: num(row?.global_tokens) };
  });
  const budget = deps.config.limits.monthlyBudgetMicros;
  if (budget > 0 && usage.monthCost >= budget) throw new BudgetExceededError('user_monthly');
  if (!interactive) {
    const allowance = budget > 0 ? backgroundAllowance(usage.monthCost / budget, priority) : 1;
    if (usage.background >= Math.floor(deps.config.intel.backgroundDailyLimit * allowance)) throw new BudgetExceededError(allowance < 1 ? 'user_background_throttled' : 'user_background');
  }
  if (deps.config.limits.monthlyTokens > 0 && usage.monthTokens >= deps.config.limits.monthlyTokens) throw new BudgetExceededError('user_monthly');
  if (deps.config.limits.globalDailyTokens > 0 && usage.globalTokens >= deps.config.limits.globalDailyTokens) throw new BudgetExceededError('global');
}

async function recordUsage(
  deps: IntelDeps,
  call: { userId: string; operation: ServerOperation; requestId: string; interactive?: boolean },
  outcome: { status: 'ok' | 'error'; errorCode: string | null; model: string | null; inputTokens: number; outputTokens: number; cachedInputTokens?: number; serviceTier?: ProcessingTier; latencyMs: number },
): Promise<number> {
  const record = {
    userId: call.userId,
    operation: `intel.${call.operation}`,
    provider: deps.inference.name,
    model: outcome.model,
    status: outcome.status,
    errorCode: outcome.errorCode,
    latencyMs: outcome.latencyMs,
    inputTokens: outcome.inputTokens,
    outputTokens: outcome.outputTokens,
    estimatedCostMicros: estimateCostMicros(outcome.inputTokens, outcome.outputTokens, deps.config, outcome.cachedInputTokens, outcome.serviceTier),
    requestId: call.requestId,
    createdAt: deps.now().toISOString(),
  };
  if (call.interactive) {
    await deps.store.recordUsage(record);
    return record.estimatedCostMicros;
  }
  await deps.db.asUser(call.userId, (tx) =>
    tx.query(`select public.record_background_usage($1::uuid, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12::timestamptz)`, [
      record.userId,
      record.operation,
      record.provider,
      record.model,
      record.status,
      record.errorCode,
      record.latencyMs,
      record.inputTokens,
      record.outputTokens,
      record.estimatedCostMicros,
      record.requestId,
      record.createdAt,
    ]),
  );
  return record.estimatedCostMicros;
}

export async function runStructured<T>(deps: IntelDeps, call: StructuredCall<T>): Promise<StructuredResult<T>> {
  const interactive = Boolean(call.interactive);
  await checkBudget(deps, call.userId, interactive, interactive ? 'core' : backgroundPriorityFor(call.operation));
  const started = Date.now();
  const serviceTier = processingTierFor({ interactive, override: call.tier }, deps.config.ai.backgroundTier);
  // Flex can queue longer; it only runs where nobody is waiting. One JSON repair round trip fits either way.
  const perCallMs = serviceTier === 'flex' ? deps.config.ai.flexTimeoutMs : deps.config.ai.timeoutMs;
  const timeout = AbortSignal.timeout(call.timeoutMs ?? perCallMs * 2 + 1_000);
  const signal = call.signal ? AbortSignal.any([call.signal, timeout]) : timeout;
  const context = { operation: call.operation, requestId: call.requestId, signal };
  let inputTokens = 0;
  let outputTokens = 0;
  let cachedInputTokens = 0;
  let model: string | null = null;
  let actualTier: ProcessingTier = serviceTier;
  // Native structured output makes malformed replies rare; parse, Zod and the repair below still decide.
  const settings = { reasoningEffort: reasoningEffortFor(call.operation), serviceTier, responseFormat: structuredResponseFormat(call.operation, call.schema) };
  const complete = async (messages: ChatMessage[]) => {
    const reply = await deps.inference.chat({ messages, maxTokens: call.maxTokens, ...settings }, context);
    inputTokens += reply.usage.inputTokens;
    outputTokens += reply.usage.outputTokens;
    cachedInputTokens += reply.usage.cachedInputTokens ?? 0;
    model = reply.model;
    actualTier = reply.serviceTier;
    return reply.text;
  };
  const meta = { requestId: call.requestId, userId: call.userId, operation: call.operation, reasoningEffort: settings.reasoningEffort, serviceTier };
  const parse = (text: string): T | null => {
    let raw: unknown;
    try {
      raw = extractJsonObject(text);
    } catch {
      return null;
    }
    const parsed = call.schema.safeParse(raw);
    return parsed.success ? parsed.data : null;
  };

  try {
    const first = await complete([
      { role: 'system', content: call.system },
      { role: 'user', content: call.user },
    ]);
    let value = parse(first);
    if (value === null && call.repair !== false) {
      const repaired = await complete([
        { role: 'system', content: call.system },
        { role: 'user', content: call.user },
        { role: 'assistant', content: first.slice(0, 8_000) },
        { role: 'user', content: 'That was not valid JSON for the requested schema. Reply with only the corrected JSON object.' },
      ]);
      value = parse(repaired);
    }
    if (value === null) throw new InferenceError('provider_invalid_response', 'The AI provider returned a response PigeonBox could not use.');
    const latencyMs = Date.now() - started;
    const usage = recordUsage(deps, call, { status: 'ok', errorCode: null, model, inputTokens, outputTokens, cachedInputTokens, serviceTier: actualTier, latencyMs });
    let costMicros: number;
    if (call.defer) {
      costMicros = estimateCostMicros(inputTokens, outputTokens, deps.config, cachedInputTokens, actualTier);
      call.defer(usage.then(() => undefined).catch(() => {
        deps.log('warn', 'intel usage recording failed', { requestId: call.requestId, userId: call.userId, operation: call.operation, code: 'usage_recording_failed' });
      }));
    } else costMicros = await usage;
    deps.log('info', 'intel ai operation', { ...meta, actualServiceTier: actualTier, model: model ?? undefined, inputTokens, outputTokens, cachedTokens: cachedInputTokens, costMicros, latencyMs });
    return { value, model, inputTokens, outputTokens, latencyMs };
  } catch (error) {
    const code = error instanceof InferenceError ? error.code : 'provider_error';
    // Tokens of a call that succeeded before a later one failed are still billed, at the tier that ran.
    await recordUsage(deps, call, { status: 'error', errorCode: code, model, inputTokens, outputTokens, cachedInputTokens, serviceTier: actualTier, latencyMs: Date.now() - started }).catch(() => undefined);
    const provider = error instanceof InferenceError ? error : null;
    deps.log('warn', 'intel ai operation failed', { ...meta, code, latencyMs: Date.now() - started, ...(provider?.status ? { status: provider.status } : {}), ...(call.operation !== 'compose_check' && provider?.detail ? { detail: provider.detail } : {}) });
    throw error instanceof InferenceError ? error : new InferenceError('provider_error', 'The AI provider failed.');
  }
}

/**
 * One metered turn of a tool-using conversation (Ask Pigeon's agent loop).
 * Interactive: the user is waiting. Usage is recorded per turn, content never.
 *
 * A loop that already checked the budget for this request passes
 * `budgetChecked`, and one that can settle usage later passes `defer`, so
 * neither database round trip sits between model rounds.
 */
export async function runChatTurn(
  deps: IntelDeps,
  call: {
    userId: string;
    operation: Exclude<ServerOperation, 'index_embed'>;
    requestId: string;
    messages: ChatMessage[];
    tools: ToolSpec[];
    toolChoice?: 'auto' | 'none';
    maxTokens?: number;
    signal: AbortSignal;
    timeoutMs?: number;
    /** Stream answer text as it is written. */
    stream?: (delta: string) => void;
    budgetChecked?: boolean;
    /** Receives the usage write instead of awaiting it; the caller must await it before the request ends. */
    defer?: (work: Promise<void>) => void;
  },
): Promise<ChatResult> {
  if (!call.budgetChecked) await checkBudget(deps, call.userId, true);
  const started = Date.now();
  const meta = { userId: call.userId, operation: call.operation, requestId: call.requestId, interactive: true };
  const settle = (work: Promise<unknown>) => (call.defer ? call.defer(work.then(() => undefined)) : work);
  try {
    // The user is waiting on every agent round: Standard tier.
    const reply = await deps.inference.chat(
      { messages: call.messages, maxTokens: call.maxTokens, reasoningEffort: reasoningEffortFor(call.operation), serviceTier: 'standard', tools: call.tools, toolChoice: call.toolChoice, stream: call.stream },
      { operation: call.operation, requestId: call.requestId, signal: call.signal, timeoutMs: call.timeoutMs },
    );
    await settle(recordUsage(deps, meta, { status: 'ok', errorCode: null, model: reply.model, inputTokens: reply.usage.inputTokens, outputTokens: reply.usage.outputTokens, cachedInputTokens: reply.usage.cachedInputTokens, serviceTier: reply.serviceTier, latencyMs: Date.now() - started }));
    if (reply.streamRefused) deps.log('warn', 'ai streaming refused, answered whole', { requestId: call.requestId, operation: call.operation, detail: reply.streamRefused });
    return reply;
  } catch (error) {
    const code = error instanceof InferenceError ? error.code : 'provider_error';
    await settle(recordUsage(deps, meta, { status: 'error', errorCode: code, model: null, inputTokens: 0, outputTokens: 0, latencyMs: Date.now() - started }).catch(() => undefined));
    const provider = error instanceof InferenceError ? error : null;
    deps.log('warn', 'intel ai operation failed', { requestId: call.requestId, userId: call.userId, operation: call.operation, code, ...(provider?.status ? { status: provider.status } : {}), ...(provider?.detail ? { detail: provider.detail } : {}) });
    throw error instanceof InferenceError ? error : new InferenceError('provider_error', 'The AI provider failed.');
  }
}

/** Embeddings for retrieval, metered as background work unless interactive. */
export async function embedTexts(deps: IntelDeps, userId: string, texts: string[], requestId: string, interactive = false, timeoutMs?: number, options: { budgetChecked?: boolean; defer?: (work: Promise<void>) => void } = {}): Promise<number[][]> {
  if (!texts.length) return [];
  if (!options.budgetChecked) await checkBudget(deps, userId, interactive);
  const started = Date.now();
  const result = await deps.inference.embed(texts, { operation: 'index_embed', requestId, signal: AbortSignal.timeout(timeoutMs ?? deps.config.ai.timeoutMs * 2) });
  const usage = recordUsage(deps, { userId, operation: 'index_embed', requestId, interactive }, {
    status: 'ok',
    errorCode: null,
    model: result.model,
    inputTokens: result.usage.inputTokens,
    outputTokens: 0,
    latencyMs: Date.now() - started,
  });
  if (options.defer) options.defer(usage.then(() => undefined).catch(() => {
    deps.log('warn', 'intel usage recording failed', { requestId, userId, operation: 'index_embed', code: 'usage_recording_failed' });
  }));
  else await usage;
  const dims = deps.config.intel.embedDimensions;
  return result.vectors.map((vector) => (vector.length === dims ? vector : resize(vector, dims)));
}

/** Pad or truncate (and re-normalize) a vector to the column's dimension. */
function resize(vector: number[], dims: number): number[] {
  const out = vector.slice(0, dims);
  while (out.length < dims) out.push(0);
  const norm = Math.sqrt(out.reduce((sum, value) => sum + value * value, 0)) || 1;
  return out.map((value) => value / norm);
}
