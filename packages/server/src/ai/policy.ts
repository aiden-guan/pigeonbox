import type { AiOperation } from '@pigeonbox/api-contract';
import type { ServerOperation } from './backends.js';

/**
 * Inference settings per PigeonBox operation, in one place. Product code names
 * the operation; the backend turns these settings into provider parameters.
 *
 * Every chat operation runs on CLOUD_AI_PRIMARY_MODEL (then any configured
 * fallbacks). If operations ever need different models, the choice belongs
 * here too.
 *
 * Two independent controls decide what a call costs:
 * - reasoning effort, fixed per operation (below);
 * - processing tier, chosen per call from where it runs: Standard when a person
 *   is waiting, Flex (half price, slower, sometimes out of capacity) for
 *   background work. The same operation can run on either tier.
 */

/** How much the model reasons before answering. Reasoning tokens are billed as output. */
export type ReasoningEffort = 'none' | 'low' | 'medium' | 'high' | 'xhigh' | 'max';

/** OpenAI processing tier. 'standard' is sent as service_tier "default", 'flex' as "flex". */
export type ProcessingTier = 'standard' | 'flex';

/** Operations that call the chat model. Embeddings do not reason. */
export type ChatOperation = Exclude<AiOperation | ServerOperation, 'embed' | 'index_embed'>;

/**
 * Explicit for every operation: an unset effort means the provider default
 * (medium for GPT-6 Luna), which wastes tokens on trivial email work.
 * 'none' for mechanical work, 'low' where judgment shapes quality.
 */
const REASONING: Record<ChatOperation, ReasoningEffort> = {
  // Public Cloud AI operations (the extension's prompts from @pigeonbox/ai).
  classify: 'none',
  summarize: 'low',
  draft: 'low',
  follow_up: 'low',
  rewrite: 'none',
  ask: 'low',
  // Always-on intelligence.
  memory_extract: 'low',
  // Filing, merging and summarizing pages: careful but mechanical.
  memory_consolidate: 'low',
  thread_analysis: 'low',
  grounded_draft: 'low',
  view_compile: 'none',
  automation_compile: 'none',
  // Ask Pigeon's agent rounds. 'none' because the provider refuses reasoning together with
  // function tools on Chat Completions (400 on reasoning_effort); it is also the fastest and cheapest.
  research: 'none',
  snippet: 'low',
  // Real-time Pidgy checks: a short mechanical comparison of one clause with supplied evidence, while the user waits.
  compose_check: 'none',
};

export function reasoningEffortFor(operation: ChatOperation): ReasoningEffort {
  return REASONING[operation];
}

/** Live annotations get one completion attempt, including provider fallbacks/repairs. */
export function allowsInferenceRetry(operation: AiOperation | ServerOperation): boolean {
  return operation !== 'compose_check';
}

/**
 * The tier for one call. Interactive calls (someone is waiting) are always
 * Standard. Background calls use the configured background tier (Flex in
 * production); a caller passes `override` only when a background call cannot be
 * retried later, because a Flex capacity miss would otherwise be lost.
 */
export function processingTierFor(call: { interactive: boolean; override?: ProcessingTier }, backgroundTier: ProcessingTier): ProcessingTier {
  if (call.override) return call.override;
  return call.interactive ? 'standard' : backgroundTier;
}

/**
 * Background work that only enriches (learned memories) stops first when a
 * user's month gets expensive; core background work (triage, auto drafts,
 * search indexing) keeps going longer.
 */
export type BackgroundPriority = 'core' | 'enrichment';

export function backgroundPriorityFor(operation: ServerOperation): BackgroundPriority {
  return operation === 'memory_extract' || operation === 'memory_consolidate' ? 'enrichment' : 'core';
}

/**
 * Soft cost control before the hard monthly budget. Returns the share of the
 * daily background allowance still available at `monthShare` of the monthly
 * budget spent. Interactive use is never throttled here; it stops only at the
 * hard budget. With the $2 budget the bands are $1.25, $1.40 and $1.75.
 */
export const BACKGROUND_BANDS = { soft: 0.625, throttle: 0.7, stop: 0.875 } as const;

export function backgroundAllowance(monthShare: number, priority: BackgroundPriority): number {
  if (monthShare >= BACKGROUND_BANDS.stop) return 0;
  if (monthShare >= BACKGROUND_BANDS.soft && priority === 'enrichment') return 0;
  if (monthShare >= BACKGROUND_BANDS.throttle) return 0.25;
  if (monthShare >= BACKGROUND_BANDS.soft) return 0.5;
  return 1;
}
