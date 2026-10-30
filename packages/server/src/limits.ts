import type { ProcessingTier } from './ai/policy.js';
import type { Config } from './config.js';
import type { Entitlements } from './entitlements.js';
import { ApiError } from './http.js';
import type { CloudStore, UsageRecord, UsageSummary } from './store/types.js';

/** Share of the monthly budget used, 0 to 1 (0 when there is no budget). */
export function monthlyUsed(usage: UsageSummary, entitlements: Pick<Entitlements, 'monthlyBudgetMicros' | 'limits'>): number {
  const budget = entitlements.monthlyBudgetMicros;
  const byCost = budget ? usage.costThisMonthMicros / budget : budget === 0 ? 1 : 0;
  const tokens = entitlements.limits.aiTokensPerMonth;
  const byTokens = tokens ? usage.tokensThisMonth / tokens : 0;
  return Math.min(1, Math.max(0, byCost, byTokens));
}

/**
 * Limits checked before inference, in order: per-user daily requests,
 * the per-user monthly budget (and optional token cap), the global daily token budget (a spend safety net
 * across all users), then the per-minute rate limit.
 */
export async function enforceLimits(userId: string, entitlements: Entitlements, deps: { store: CloudStore; config: Config; now: Date }): Promise<void> {
  const { store, config, now } = deps;
  const usage = await store.usageSummary(userId, now);
  const { aiRequestsPerDay, aiTokensPerMonth, aiRequestsPerMinute } = entitlements.limits;
  if (aiRequestsPerDay !== null && usage.requestsToday >= aiRequestsPerDay) {
    throw new ApiError('quota_exceeded', 'You reached today’s AI limit on this PigeonBox server.', { retryAfter: secondsUntilNextDay(now) });
  }
  if ((entitlements.monthlyBudgetMicros !== null && usage.costThisMonthMicros >= entitlements.monthlyBudgetMicros) || (aiTokensPerMonth !== null && usage.tokensThisMonth >= aiTokensPerMonth)) {
    throw new ApiError('quota_exceeded', 'You reached this month’s AI limit on this PigeonBox server.');
  }
  if (config.limits.globalDailyTokens > 0 && (await store.globalTokensToday(now)) >= config.limits.globalDailyTokens) {
    throw new ApiError('provider_unavailable', 'This PigeonBox server reached its daily AI capacity. Try again later.', { retryAfter: secondsUntilNextDay(now) });
  }
  if (aiRequestsPerMinute !== null) {
    const windowStart = new Date(Math.floor(now.getTime() / 60_000) * 60_000);
    const count = await store.hitRateLimit(`ai:${userId}`, windowStart);
    if (count > aiRequestsPerMinute) {
      throw new ApiError('rate_limited', 'Too many requests. Try again in a moment.', {
        retryAfter: Math.max(1, Math.ceil((windowStart.getTime() + 60_000 - now.getTime()) / 1000)),
      });
    }
  }
}

function secondsUntilNextDay(now: Date): number {
  const next = Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), now.getUTCDate() + 1);
  return Math.max(1, Math.ceil((next - now.getTime()) / 1000));
}

/**
 * Estimated cost of one call. `cachedInputTokens` is the part of `inputTokens` the
 * provider served from its prompt cache; `tier` is the processing tier the call
 * ran on (Flex is priced at its own, lower rates).
 */
export function estimateCostMicros(inputTokens: number, outputTokens: number, config: Config, cachedInputTokens = 0, tier: ProcessingTier = 'standard'): number {
  const cached = Math.min(Math.max(0, cachedInputTokens), inputTokens);
  const price = config.ai.pricing[tier];
  return Math.round(((inputTokens - cached) / 1000) * price.input + (cached / 1000) * price.cachedInput + (outputTokens / 1000) * price.output);
}

/** A usage row. Operational metadata only; there is no field that could hold email text. */
export function usageRecord(fields: Omit<UsageRecord, 'createdAt'>, now: Date): UsageRecord {
  return { ...fields, createdAt: now.toISOString() };
}
