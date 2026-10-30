import type { TrackerStore } from '@pigeonbox/tracker';

/**
 * Everything the Cloud API persists. Implemented by Supabase (production) and
 * memory (development and tests). Every user-owned method takes the user ID
 * the server derived from a verified token; nothing here trusts a client ID.
 */

export type UsageRecord = {
  userId: string;
  operation: string;
  provider: string;
  model: string | null;
  status: 'ok' | 'error';
  errorCode: string | null;
  latencyMs: number;
  inputTokens: number;
  outputTokens: number;
  estimatedCostMicros: number;
  requestId: string;
  createdAt: string;
};

export type UsageSummary = { requestsToday: number; tokensThisMonth: number; costThisMonthMicros: number };

export interface CloudStore {
  readonly kind: 'memory' | 'supabase';
  ensureProfile(userId: string, email: string | null): Promise<void>;
  /** The address the profile was created with; null when there is no profile or no address. */
  profileEmail(userId: string): Promise<string | null>;
  /** Removes the profile and, by cascade, every user-owned row. */
  deleteUserData(userId: string): Promise<void>;

  recordUsage(record: UsageRecord): Promise<void>;
  usageSummary(userId: string, now: Date): Promise<UsageSummary>;
  globalTokensToday(now: Date): Promise<number>;

  /** Fixed-window counter. Returns the count after this hit. */
  hitRateLimit(key: string, windowStart: Date): Promise<number>;

  /** Tracker store limited to one account's records. */
  trackerStoreFor(userId: string): TrackerStore;
  /** Tracker store for the public pixel and click routes (lookups by random ID). */
  publicTrackerStore(): TrackerStore;
}

export function dayStart(now: Date): Date {
  return new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), now.getUTCDate()));
}

export function monthStart(now: Date): Date {
  return new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), 1));
}
