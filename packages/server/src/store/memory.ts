import { createMemoryState, createMemoryStore, StoreError, type TrackerStore } from '@pigeonbox/tracker';
import {
  dayStart,
  monthStart,
  type CloudStore,
  type UsageRecord,
  type UsageSummary,
} from './types.js';

/**
 * In-memory CloudStore for development (`CLOUD_AI_PROVIDER=mock`, no Supabase)
 * and tests. Refused in production by config. State lives per Worker isolate.
 *
 * Tracking data is partitioned per account: each account gets its own
 * self-host memory store (the same code the public tracker runs), and the
 * public pixel/click store routes by random ID to the owning partition.
 */
export class MemoryCloudStore implements CloudStore {
  readonly kind = 'memory' as const;
  private profiles = new Map<string, { email: string | null }>();
  private usage: UsageRecord[] = [];
  private rate = new Map<string, number>();
  private partitions = new Map<string, TrackerStore>();
  private owners = {
    email: new Map<string, string>(),
    link: new Map<string, string>(),
    event: new Map<string, string>(),
    claim: new Map<string, string>(),
  };

  async ensureProfile(userId: string, email: string | null) {
    if (!this.profiles.has(userId)) this.profiles.set(userId, { email });
  }

  async profileEmail(userId: string) {
    return this.profiles.get(userId)?.email ?? null;
  }

  async deleteUserData(userId: string) {
    this.profiles.delete(userId);
    this.usage = this.usage.filter((row) => row.userId !== userId);
    this.partitions.delete(userId);
    for (const map of Object.values(this.owners)) for (const [id, owner] of map) if (owner === userId) map.delete(id);
  }

  async recordUsage(record: UsageRecord) {
    this.usage.push({ ...record });
  }

  async usageSummary(userId: string, now: Date): Promise<UsageSummary> {
    const day = dayStart(now).toISOString();
    const month = monthStart(now).toISOString();
    let requestsToday = 0;
    let tokensThisMonth = 0;
    let costThisMonthMicros = 0;
    for (const row of this.usage) {
      if (row.userId !== userId) continue;
      if (row.createdAt >= day) requestsToday += 1;
      if (row.createdAt >= month) {
        tokensThisMonth += row.inputTokens + row.outputTokens;
        costThisMonthMicros += row.estimatedCostMicros;
      }
    }
    return { requestsToday, tokensThisMonth, costThisMonthMicros };
  }

  async globalTokensToday(now: Date) {
    const day = dayStart(now).toISOString();
    return this.usage.filter((row) => row.createdAt >= day).reduce((sum, row) => sum + row.inputTokens + row.outputTokens, 0);
  }

  async hitRateLimit(key: string, windowStart: Date) {
    const slot = `${key}@${windowStart.toISOString()}`;
    const next = (this.rate.get(slot) ?? 0) + 1;
    this.rate.set(slot, next);
    return next;
  }

  /** Test helper: usage rows without any content fields. */
  usageRows(): UsageRecord[] {
    return this.usage.map((row) => ({ ...row }));
  }

  private partition(userId: string): TrackerStore {
    let store = this.partitions.get(userId);
    if (!store) {
      store = createMemoryStore(createMemoryState());
      this.partitions.set(userId, store);
    }
    return store;
  }

  private claimOwner(map: Map<string, string>, id: string, userId: string) {
    const owner = map.get(id);
    if (owner && owner !== userId) throw new StoreError('conflict');
    map.set(id, userId);
  }

  trackerStoreFor(userId: string): TrackerStore {
    const inner = this.partition(userId);
    const owners = this.owners;
    return {
      ...inner,
      kind: 'memory',
      insertEmail: async (row) => {
        this.claimOwner(owners.email, row.tracking_id, userId);
        await inner.insertEmail(row);
      },
      insertLink: async (row) => {
        if (owners.email.get(row.tracking_id) !== userId) throw new StoreError('not_found');
        this.claimOwner(owners.link, row.click_id, userId);
        await inner.insertLink(row);
      },
      insertEvent: async (row) => {
        if (owners.email.get(row.tracking_id) !== userId) throw new StoreError('not_found');
        this.claimOwner(owners.event, row.id, userId);
        await inner.insertEvent(row);
      },
      insertClaim: async (row) => {
        if (owners.email.get(row.tracking_id) !== userId) throw new StoreError('not_found');
        this.claimOwner(owners.claim, row.id, userId);
        await inner.insertClaim(row);
      },
    };
  }

  publicTrackerStore(): TrackerStore {
    const owners = this.owners;
    const byEmail = (id: string) => {
      const owner = owners.email.get(id);
      return owner ? this.trackerStoreFor(owner) : null;
    };
    const by = (map: Map<string, string>, id: string) => {
      const owner = map.get(id);
      return owner ? this.trackerStoreFor(owner) : null;
    };
    const refuse = async (): Promise<never> => {
      throw new StoreError('not_allowed');
    };
    return {
      kind: 'memory',
      insertEmail: refuse,
      insertLink: refuse,
      listEmails: async () => [],
      recentEvents: async () => [],
      eventPage: async (after) => ({ events: [], cursor: after ?? '0', hasMore: false }),
      getEvent: async id => (await by(owners.event, id)?.getEvent(id)) ?? null,
      recomputeStats: async id => { const store = byEmail(id); if (!store) return refuse(); return store.recomputeStats(id); },
      getEmail: async (id) => (await byEmail(id)?.getEmail(id)) ?? null,
      listEvents: async (trackingId) => (await byEmail(trackingId)?.listEvents(trackingId)) ?? [],
      listEventsForStats: async (trackingId) => (await byEmail(trackingId)?.listEventsForStats(trackingId)) ?? [],
      insertEvent: async (row) => {
        const store = byEmail(row.tracking_id);
        if (!store) throw new StoreError('not_found');
        await store.insertEvent(row);
      },
      updateEvent: async (id, patch) => {
        await by(owners.event, id)?.updateEvent(id, patch);
      },
      updateEmail: async (id, patch) => {
        await byEmail(id)?.updateEmail(id, patch);
      },
      getLink: async (clickId) => (await by(owners.link, clickId)?.getLink(clickId)) ?? null,
      insertClaim: async (row) => {
        const store = byEmail(row.tracking_id);
        if (!store) throw new StoreError('not_found');
        await store.insertClaim(row);
      },
      updateClaim: async (id, patch) => {
        await by(owners.claim, id)?.updateClaim(id, patch);
      },
      getClaim: async (id) => (await by(owners.claim, id)?.getClaim(id)) ?? null,
      getActiveClaim: async (trackingId, messageId, nowMs) => (await byEmail(trackingId)?.getActiveClaim(trackingId, messageId, nowMs)) ?? null,
      consumeClaim: async (claimId, eventId, at, ua, ip) => (await by(owners.claim, claimId)?.consumeClaim(claimId, eventId, at, ua, ip)) ?? false,
      consumeProxySuppression: async (claimId, eventId, at) => (await by(owners.claim, claimId)?.consumeProxySuppression(claimId, eventId, at)) ?? false,
      listClaims: async (trackingId) => (await byEmail(trackingId)?.listClaims(trackingId)) ?? [],
      getRecentConsumedClaim: async (trackingId, now, grace, ua, ip) =>
        (await byEmail(trackingId)?.getRecentConsumedClaim(trackingId, now, grace, ua, ip)) ?? null,
      hasClaims: async (trackingId) => (await byEmail(trackingId)?.hasClaims(trackingId)) ?? false,
    };
  }
}
