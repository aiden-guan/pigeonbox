/**
 * Adapter for Cloud-derived thread state: the `ThreadIntel` PigeonBox Cloud's
 * always-on service keeps for each synced thread (state, next action,
 * commitments, deadlines, follow-up stage, prepared drafts).
 *
 * This is an optional Cloud capability consumed by the PigeonBox extension,
 * not a separate PigeonBox application.
 *
 * Boundaries:
 * - Only in Cloud mode, signed in, with `cloud_mail_sync`. Local mode never
 *   contacts PigeonBox servers from here, not even with thread IDs.
 * - Gmail content scripts may only read thread state (`CLOUD_THREAD_INTEL`).
 *   Everything that changes something goes through extension pages; see
 *   `page-calls.ts`.
 * - Google credentials never reach the extension; the Cloud session token
 *   stays in the service worker.
 */
import type { ThreadIntel } from '@pigeonbox/api-contract';
import { InflightCache, type PigeonBoxCloudClient } from '@pigeonbox/cloud-client';
import type { CloudState } from '@pigeonbox/core';

export function cloudThreadStateAvailable(state: CloudState, runMode: string): boolean {
  return runMode === 'cloud' && (state.status === 'ready' || state.status === 'not_entitled') && state.capabilities.includes('cloud_mail_sync');
}

/** Gmail asks for the same threads from chips, the thread card and the side panel at once. */
const intelCache = new InflightCache<ThreadIntel | null>(20_000, 400);

export function forgetThreadIntel(threadId?: string): void {
  intelCache.invalidate(threadId);
}

const cacheKey = (mailbox: string | undefined, threadId: string) => `${mailbox ?? ''}|${threadId}`;

/**
 * Thread intelligence for up to 40 threads, fetched in one request and cached
 * briefly. Threads Cloud has not synced come back absent.
 */
export async function threadIntel(client: PigeonBoxCloudClient, threadIds: string[], mailbox?: string): Promise<Record<string, ThreadIntel>> {
  const ids = [...new Set(threadIds.filter((id) => typeof id === 'string' && /^[A-Za-z0-9_-]{1,64}$/.test(id)))].slice(0, 40);
  const result: Record<string, ThreadIntel> = {};
  const missing: string[] = [];
  for (const id of ids) {
    const cached = intelCache.peek(cacheKey(mailbox, id));
    if (cached === undefined) missing.push(id);
    else if (cached) result[id] = cached;
  }
  if (missing.length) {
    const response = await client.call('threadsIntel', { threadIds: missing, ...(mailbox ? { mailbox } : {}) }, { timeoutMs: 8_000 });
    for (const id of missing) {
      const intel = response.threads[id] ?? null;
      intelCache.set(cacheKey(mailbox, id), intel);
      if (intel) result[id] = intel;
    }
  }
  return result;
}
