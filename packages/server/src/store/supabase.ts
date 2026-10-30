import { createClient, type SupabaseClient } from '@supabase/supabase-js';
import { StoreError, STATS_EVENT_LIMIT, type ClaimRow, type EmailRow, type EventRow, type EventPage, type LinkRow, type StatsEventRow, type TrackerStore } from '@pigeonbox/tracker';
import { normalizeGmailId } from '@pigeonbox/tracking';
import type { CloudStore, UsageRecord, UsageSummary } from './types.js';
import { dayStart, monthStart } from './types.js';

/**
 * Supabase Postgres store. Uses the service role, so row-level security does
 * not apply to these queries: every user-owned query filters by the user ID
 * the server derived from a verified token. RLS policies in the migrations are
 * defense in depth for any future direct client access.
 */
export class SupabaseCloudStore implements CloudStore {
  readonly kind = 'supabase' as const;
  private readonly db: SupabaseClient;

  constructor(url: string, serviceRoleKey: string, fetchImpl?: typeof fetch) {
    this.db = createClient(url, serviceRoleKey, {
      auth: { persistSession: false, autoRefreshToken: false },
      global: fetchImpl ? { fetch: fetchImpl } : undefined,
    });
  }

  private check<T>(result: { data: T; error: { message: string } | null }): T {
    if (result.error) throw new StoreError(result.error.message);
    return result.data;
  }

  async ensureProfile(userId: string, email: string | null) {
    this.check(await this.db.from('profiles').upsert({ id: userId, email }, { onConflict: 'id', ignoreDuplicates: true }));
  }

  async profileEmail(userId: string) {
    const row = this.check(await this.db.from('profiles').select('email').eq('id', userId).maybeSingle()) as { email: string | null } | null;
    return row?.email ?? null;
  }

  async deleteUserData(userId: string) {
    // Every user-owned table references profiles(id) on delete cascade.
    this.check(await this.db.from('profiles').delete().eq('id', userId));
  }

  async recordUsage(record: UsageRecord) {
    this.check(
      await this.db.rpc('record_usage', {
        p_user_id: record.userId,
        p_operation: record.operation,
        p_provider: record.provider,
        p_model: record.model,
        p_status: record.status,
        p_error_code: record.errorCode,
        p_latency_ms: record.latencyMs,
        p_input_tokens: record.inputTokens,
        p_output_tokens: record.outputTokens,
        p_cost_micros: record.estimatedCostMicros,
        p_request_id: record.requestId,
        p_created_at: record.createdAt,
      }),
    );
  }

  async usageSummary(userId: string, now: Date): Promise<UsageSummary> {
    const day = dayStart(now).toISOString().slice(0, 10);
    const month = monthStart(now).toISOString().slice(0, 10);
    const rows = this.check(await this.db.from('usage_daily').select('day, requests, tokens, cost_micros').eq('user_id', userId).gte('day', month)) as Array<{
      day: string;
      requests: number;
      tokens: number;
      cost_micros: number | null;
    }>;
    return {
      requestsToday: rows.filter((row) => row.day === day).reduce((sum, row) => sum + Number(row.requests), 0),
      tokensThisMonth: rows.reduce((sum, row) => sum + Number(row.tokens), 0),
      costThisMonthMicros: rows.reduce((sum, row) => sum + Number(row.cost_micros ?? 0), 0),
    };
  }

  async globalTokensToday(now: Date) {
    const row = this.check(await this.db.from('usage_global_daily').select('tokens').eq('day', dayStart(now).toISOString().slice(0, 10)).maybeSingle()) as
      | { tokens: number }
      | null;
    return Number(row?.tokens ?? 0);
  }

  async hitRateLimit(key: string, windowStart: Date) {
    return Number(this.check(await this.db.rpc('hit_rate_limit', { p_key: key, p_window_start: windowStart.toISOString() })));
  }

  trackerStoreFor(userId: string): TrackerStore {
    return supabaseTrackerStore(this.db, userId);
  }

  publicTrackerStore(): TrackerStore {
    return supabaseTrackerStore(this.db, null);
  }
}

/**
 * Tracker store over the multi-tenant tracking tables. With `userId`, every
 * query is limited to that account. Without it (public pixel/click routes),
 * lookups are by random tracking/click ID and a trigger copies `user_id` from
 * the parent email onto new events and claims.
 */
/** Typed as `string` so the client does not try to parse the column list into a row type. */
const STATS_COLUMNS: string = 'type,timestamp,user_agent,suspected_self_open,classification';

function supabaseTrackerStore(db: SupabaseClient, userId: string | null): TrackerStore {
  const scoped = <T extends { eq: (column: string, value: string) => T }>(query: T): T => (userId ? query.eq('user_id', userId) : query);
  const fail = (error: { message: string } | null) => {
    if (error) throw new StoreError(error.message);
  };
  const owned = <T extends object>(row: T) => (userId ? { ...row, user_id: userId } : row);
  const strip = <T>(row: T | null): T | null => {
    if (!row) return null;
    const { user_id: _owner, ...rest } = row as T & { user_id?: string };
    return rest as T;
  };

  return {
    kind: 'supabase',
    async insertEmail(row: EmailRow) {
      if (!userId) throw new StoreError('not_allowed');
      fail((await db.from('tracked_emails').insert(owned(row))).error);
    },
    async insertLink(row: LinkRow) {
      if (!userId) throw new StoreError('not_allowed');
      fail((await db.from('tracked_links').insert(owned(row))).error);
    },
    async getEmail(id) {
      const { data, error } = await scoped(db.from('tracked_emails').select('*').eq('tracking_id', id)).maybeSingle();
      fail(error);
      return strip(data as EmailRow | null);
    },
    async listEmails(limit) {
      if (!userId) return [];
      const { data, error } = await db
        .from('tracked_emails')
        .select('*')
        .eq('user_id', userId)
        .order('sent_at', { ascending: false, nullsFirst: false })
        .limit(limit);
      fail(error);
      return ((data as EmailRow[] | null) ?? []).map((row) => strip(row)!);
    },
    async listEvents(trackingId) {
      const { data, error } = await scoped(db.from('tracking_events').select('*').eq('tracking_id', trackingId))
        .order('timestamp', { ascending: false })
        .limit(200);
      fail(error);
      return ((data as EventRow[] | null) ?? []).map((row) => strip(row)!);
    },
    async listEventsForStats(trackingId) {
      const { data, error } = await scoped(
        db.from('tracking_events').select(STATS_COLUMNS).eq('tracking_id', trackingId),
      )
        .order('timestamp', { ascending: true })
        .limit(STATS_EVENT_LIMIT);
      fail(error);
      return (data as StatsEventRow[] | null) ?? [];
    },
    async recentEvents() {
      if (!userId) return [];
      const { data, error } = await db.from('tracking_events').select('*').eq('user_id', userId).order('timestamp', { ascending: false }).limit(50);
      fail(error);
      return ((data as EventRow[] | null) ?? []).map((row) => strip(row)!);
    },
    async eventPage(after, limit) {
      if (!userId) return { events: [], cursor: after ?? '0', hasMore: false };
      const { data, error } = await db.rpc('tracking_event_page', { p_after: after, p_limit: limit, p_user_id: userId });
      fail(error); return data as EventPage;
    },
    async getEvent(id) {
      const { data, error } = await scoped(db.from('tracking_events').select('*').eq('id', id)).maybeSingle();
      fail(error); return strip(data as EventRow | null);
    },
    async recomputeStats(trackingId) {
      const { data, error } = await db.rpc('recompute_tracking_stats', { p_tracking_id: trackingId, p_user_id: userId });
      fail(error); return data;
    },
    async insertEvent(row) {
      fail((await db.from('tracking_events').upsert(owned(row), { onConflict: 'id', ignoreDuplicates: true })).error);
      const { data, error } = await scoped(db.from('tracking_events').select('tracking_id' as string).eq('id', row.id)).maybeSingle();
      fail(error);
      if ((data as unknown as { tracking_id?: string } | null)?.tracking_id !== row.tracking_id) throw new StoreError('event_identity_conflict');
    },
    async updateEvent(id, patch) {
      fail((await scoped(db.from('tracking_events').update(patch).eq('id', id))).error);
    },
    async updateEmail(id, patch) {
      fail((await scoped(db.from('tracked_emails').update(patch).eq('tracking_id', id))).error);
    },
    async getLink(clickId) {
      const { data, error } = await scoped(db.from('tracked_links').select('*').eq('click_id', clickId)).maybeSingle();
      fail(error);
      return strip(data as LinkRow | null);
    },
    async insertClaim(row) {
      // A plain insert: claim IDs can derive from client idempotency keys, and an
      // upsert would let one account overwrite another account's claim row.
      // The handler looks the ID up first (scoped to this account) and updates its own.
      fail((await db.from('tracking_self_view_claims').insert(owned(row))).error);
    },
    async updateClaim(id, patch) {
      fail((await scoped(db.from('tracking_self_view_claims').update(patch).eq('id', id))).error);
    },
    async getClaim(id) {
      const { data, error } = await scoped(db.from('tracking_self_view_claims').select('*').eq('id', id)).maybeSingle();
      fail(error);
      return strip(data as ClaimRow | null);
    },
    async getActiveClaim(trackingId, gmailMessageId, nowMs = Date.now()) {
      const wanted = normalizeGmailId(gmailMessageId);
      const { data, error } = await scoped(db.from('tracking_self_view_claims').select('*').eq('tracking_id', trackingId))
        .is('consumed_by_event_id', null)
        .gt('expires_at', new Date(nowMs).toISOString())
        .order('last_observed_at', { ascending: false });
      fail(error);
      const rows = ((data as ClaimRow[] | null) ?? []).map((row) => strip(row)!);
      if (!rows.length) return null;
      if (wanted) {
        const exact = rows.find((row) => normalizeGmailId(row.gmail_message_id) === wanted);
        if (exact) return exact;
      }
      return rows[0] ?? null;
    },
    async consumeClaim(claimId, eventId, consumedAt, ua, ipHash) {
      const patch: Record<string, unknown> = { consumed_by_event_id: eventId, consumed_at: consumedAt || new Date().toISOString() };
      if (ua !== undefined) patch.consumed_ua = ua;
      if (ipHash !== undefined) patch.consumed_ip_hash = ipHash;
      const { data, error } = await scoped(db.from('tracking_self_view_claims').update(patch).eq('id', claimId))
        .is('consumed_by_event_id', null)
        .select('id');
      fail(error);
      return Boolean(data && data.length > 0);
    },
    async consumeProxySuppression(claimId, eventId, consumedAt) {
      const { data, error } = await scoped(
        db
          .from('tracking_self_view_claims')
          .update({ proxy_consumed_by_event_id: eventId, proxy_consumed_at: consumedAt || new Date().toISOString() })
          .eq('id', claimId),
      )
        .is('proxy_consumed_by_event_id', null)
        .select('id');
      fail(error);
      return Boolean(data && data.length > 0);
    },
    async listClaims(trackingId) {
      const { data, error } = await scoped(db.from('tracking_self_view_claims').select('*').eq('tracking_id', trackingId));
      fail(error);
      return ((data as ClaimRow[] | null) ?? []).map((row) => strip(row)!);
    },
    async getRecentConsumedClaim(trackingId, nowMs = Date.now(), graceMs = 1000, ua, ipHash) {
      const { data, error } = await scoped(db.from('tracking_self_view_claims').select('*').eq('tracking_id', trackingId))
        .not('consumed_by_event_id', 'is', null)
        .gte('consumed_at', new Date(nowMs - graceMs).toISOString())
        .lte('consumed_at', new Date(nowMs + graceMs).toISOString())
        .order('consumed_at', { ascending: false });
      fail(error);
      const rows = ((data as ClaimRow[] | null) ?? []).map((row) => strip(row)!);
      return (
        rows.find((claim) => {
          if (ua && claim.consumed_ua && claim.consumed_ua !== ua) return false;
          if (ipHash && claim.consumed_ip_hash && claim.consumed_ip_hash !== ipHash) return false;
          return true;
        }) ?? null
      );
    },
    async hasClaims(trackingId) {
      const { count, error } = await scoped(db.from('tracking_self_view_claims').select('*', { count: 'exact', head: true }).eq('tracking_id', trackingId));
      fail(error);
      return (count ?? 0) > 0;
    },
  };
}
