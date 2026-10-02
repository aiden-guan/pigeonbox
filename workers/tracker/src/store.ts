import { createClient, type SupabaseClient } from '@supabase/supabase-js';
import { normalizeGmailId } from './helpers';

/**
 * Tracking metadata store.
 * Supabase when both URL and service role key are real.
 * Otherwise an in-memory store for `wrangler dev` (cleared when the process stops).
 */

export class StoreError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'StoreError';
  }
}

export type EmailStatus = 'PENDING' | 'SENT' | 'CANCELLED' | 'FAILED';

export type EmailRow = {
  tracking_id: string;
  status: EmailStatus;
  subject: string;
  sender: string;
  recipients: string[];
  gmail_thread_id: string | null;
  gmail_message_id: string | null;
  created_at: string;
  sent_at: string | null;
  first_opened_at: string | null;
  last_opened_at: string | null;
  open_count: number;
  first_clicked_at: string | null;
  last_clicked_at: string | null;
  click_count: number;
};

export type LinkRow = {
  click_id: string;
  tracking_id: string;
  destination: string;
};

export type EventRow = {
  id: string;
  tracking_id: string;
  type: 'OPEN' | 'CLICK' | 'SELF_VIEW';
  timestamp: string;
  user_agent: string | null;
  ip_hash: string | null;
  suspected_self_open: boolean;
  confidence: number;
  classification?: 'RECIPIENT_LIKELY' | 'SELF_LIKELY' | 'PROXY_LIKELY' | 'MACHINE_LIKELY' | 'UNKNOWN' | null;
  click_id?: string | null;
  destination?: string | null;
};

/** The columns counter derivation reads. */
export type StatsEventRow = Pick<EventRow, 'type' | 'timestamp' | 'user_agent' | 'suspected_self_open' | 'classification'>;

/** Upper bound on events read to recompute one email's counters. */
export const STATS_EVENT_LIMIT = 5000;

export type ClaimRow = {
  id: string;
  tracking_id: string;
  gmail_message_id: string | null;
  gmail_thread_id: string | null;
  sender_ip_hash?: string | null;
  sender_ua_family?: string | null;
  first_observed_at: string;
  last_observed_at: string;
  expires_at: string;
  source: 'ROW_INTERACTION' | 'MESSAGE_EXPANDED' | 'MESSAGE_LOAD' | 'CACHE_REINSPECTION' | 'PAGE_RELOAD';
  consumed_by_event_id: string | null;
  consumed_at?: string | null;
  consumed_ua?: string | null;
  consumed_ip_hash?: string | null;
  proxy_consumed_by_event_id?: string | null;
  proxy_consumed_at?: string | null;
  created_at: string;
};

export interface TrackerStore {
  readonly kind: 'memory' | 'supabase';
  insertEmail(row: EmailRow): Promise<void>;
  insertLink(row: LinkRow): Promise<void>;
  getEmail(id: string): Promise<EmailRow | null>;
  listEmails(limit: number): Promise<EmailRow[]>;
  /** The 200 newest events for one email, newest first. */
  listEvents(trackingId: string): Promise<EventRow[]>;
  /**
   * Every event that feeds the email's counters, oldest first, up to
   * `STATS_EVENT_LIMIT`. Counters are derived from these, never from the
   * truncated `listEvents` page, so a busy email keeps accurate totals.
   */
  listEventsForStats(trackingId: string): Promise<StatsEventRow[]>;
  recentEvents(): Promise<EventRow[]>;
  insertEvent(row: EventRow): Promise<void>;
  updateEvent(id: string, patch: Partial<EventRow>): Promise<void>;
  updateEmail(id: string, patch: Partial<EmailRow>): Promise<void>;
  getLink(clickId: string): Promise<LinkRow | null>;
  insertClaim(row: ClaimRow): Promise<void>;
  updateClaim(id: string, patch: Partial<ClaimRow>): Promise<void>;
  getClaim(id: string): Promise<ClaimRow | null>;
  getActiveClaim(trackingId: string, gmailMessageId?: string | null, nowMs?: number): Promise<ClaimRow | null>;
  consumeClaim(
    claimId: string,
    eventId: string,
    consumedAt?: string,
    ua?: string | null,
    ipHash?: string | null,
  ): Promise<boolean>;
  consumeProxySuppression(claimId: string, eventId: string, consumedAt?: string): Promise<boolean>;
  listClaims(trackingId: string): Promise<ClaimRow[]>;
  getRecentConsumedClaim(
    trackingId: string,
    nowMs?: number,
    graceMs?: number,
    ua?: string | null,
    ipHash?: string | null,
  ): Promise<ClaimRow | null>;
  hasClaims(trackingId: string): Promise<boolean>;
}

export type MemoryState = {
  emails: Map<string, EmailRow>;
  links: Map<string, LinkRow>;
  events: EventRow[];
  claims: Map<string, ClaimRow>;
};

let memory: MemoryState | null = null;

export function resetMemoryStore(): void {
  memory = null;
}

export function readMemoryClaims(trackingId?: string): ClaimRow[] {
  const claims = [...(memory?.claims.values() ?? [])];
  const rows = trackingId ? claims.filter((claim) => claim.tracking_id === trackingId) : claims;
  return rows.map((claim) => ({ ...claim }));
}

export function createMemoryState(): MemoryState {
  return { emails: new Map(), links: new Map(), events: [], claims: new Map() };
}

function memoryState(): MemoryState {
  memory ??= createMemoryState();
  return memory;
}

function isPlaceholder(value: string | undefined): boolean {
  if (!value?.trim()) return true;
  return value.includes('YOUR_PROJECT') || value.includes('your-service-role-key');
}

export function getStore(env: {
  SUPABASE_URL?: string;
  SUPABASE_SERVICE_ROLE_KEY?: string;
}): TrackerStore {
  if (!isPlaceholder(env.SUPABASE_URL) && !isPlaceholder(env.SUPABASE_SERVICE_ROLE_KEY)) {
    return supabaseStore(env.SUPABASE_URL!.trim(), env.SUPABASE_SERVICE_ROLE_KEY!.trim());
  }
  return memoryStore();
}

function memoryStore(): TrackerStore {
  return createMemoryStore(memoryState());
}

/**
 * An in-memory store over its own state. `wrangler dev` uses one shared
 * instance; PigeonBox Cloud's development mode keeps one per account.
 */
export function createMemoryStore(state: MemoryState): TrackerStore {
  return {
    kind: 'memory',
    async insertEmail(row) {
      state.emails.set(row.tracking_id, { ...row });
    },
    async insertLink(row) {
      state.links.set(row.click_id, { ...row });
    },
    async getEmail(id) {
      const row = state.emails.get(id);
      return row ? { ...row, recipients: [...row.recipients] } : null;
    },
    async listEmails(limit) {
      return [...state.emails.values()]
        .sort((a, b) => ((a.sent_at || a.created_at) < (b.sent_at || b.created_at) ? 1 : -1))
        .slice(0, limit)
        .map((row) => ({ ...row, recipients: [...row.recipients] }));
    },
    async listEvents(trackingId) {
      return state.events
        .filter((event) => event.tracking_id === trackingId)
        .sort((a, b) => (a.timestamp < b.timestamp ? 1 : -1))
        .slice(0, 200)
        .map((event) => ({ ...event }));
    },
    async listEventsForStats(trackingId) {
      return state.events
        .filter((event) => event.tracking_id === trackingId)
        .sort((a, b) => (a.timestamp < b.timestamp ? -1 : a.timestamp > b.timestamp ? 1 : 0))
        .slice(0, STATS_EVENT_LIMIT)
        .map(({ type, timestamp, user_agent, suspected_self_open, classification }) => ({ type, timestamp, user_agent, suspected_self_open, classification }));
    },
    async recentEvents() {
      return [...state.events]
        .sort((a, b) => (a.timestamp < b.timestamp ? 1 : -1))
        .slice(0, 50)
        .map((event) => ({ ...event }));
    },
    async insertEvent(row) {
      state.events.push({ ...row });
    },
    async updateEvent(id, patch) {
      const idx = state.events.findIndex((e) => e.id === id);
      if (idx >= 0) {
        state.events[idx] = { ...state.events[idx]!, ...patch };
      }
    },
    async updateEmail(id, patch) {
      const current = state.emails.get(id);
      if (!current) return;
      state.emails.set(id, { ...current, ...patch });
    },
    async getLink(clickId) {
      const row = state.links.get(clickId);
      return row ? { ...row } : null;
    },
    async insertClaim(row) {
      state.claims.set(row.id, { ...row });
    },
    async updateClaim(id, patch) {
      const cur = state.claims.get(id);
      if (!cur) return;
      state.claims.set(id, { ...cur, ...patch });
    },
    async getClaim(id) {
      const row = state.claims.get(id);
      return row ? { ...row } : null;
    },
    async getActiveClaim(trackingId, gmailMessageId, nowMs = Date.now()) {
      const normQueryMsg = normalizeGmailId(gmailMessageId);
      const active = [...state.claims.values()].filter((c) => {
        if (c.tracking_id !== trackingId) return false;
        if (c.consumed_by_event_id !== null) return false;
        const exp = Date.parse(c.expires_at);
        if (Number.isFinite(exp) && exp <= nowMs) return false;
        return true;
      });
      if (active.length === 0) return null;
      active.sort((a, b) => {
        const normA = normalizeGmailId(a.gmail_message_id);
        const normB = normalizeGmailId(b.gmail_message_id);
        if (normQueryMsg) {
          const aExact = normA === normQueryMsg ? 1 : 0;
          const bExact = normB === normQueryMsg ? 1 : 0;
          if (aExact !== bExact) return bExact - aExact;
        }
        return (Date.parse(b.last_observed_at) || 0) - (Date.parse(a.last_observed_at) || 0);
      });
      return { ...active[0]! };
    },
    async consumeClaim(claimId, eventId, consumedAt, ua, ipHash) {
      const cur = state.claims.get(claimId);
      if (!cur || cur.consumed_by_event_id !== null) return false;
      state.claims.set(claimId, {
        ...cur,
        consumed_by_event_id: eventId,
        consumed_at: consumedAt || new Date().toISOString(),
        consumed_ua: ua ?? null,
        consumed_ip_hash: ipHash ?? null,
      });
      return true;
    },
    async consumeProxySuppression(claimId, eventId, consumedAt) {
      const cur = state.claims.get(claimId);
      if (!cur || cur.proxy_consumed_by_event_id) return false;
      state.claims.set(claimId, {
        ...cur,
        proxy_consumed_by_event_id: eventId,
        proxy_consumed_at: consumedAt || new Date().toISOString(),
      });
      return true;
    },
    async listClaims(trackingId) {
      return [...state.claims.values()]
        .filter((claim) => claim.tracking_id === trackingId)
        .map((claim) => ({ ...claim }));
    },
    async getRecentConsumedClaim(trackingId, nowMs = Date.now(), graceMs = 1000, ua, ipHash) {
      const consumed = [...state.claims.values()].filter((c) => {
        if (c.tracking_id !== trackingId) return false;
        if (!c.consumed_by_event_id || !c.consumed_at) return false;
        const consumedMs = Date.parse(c.consumed_at);
        if (!Number.isFinite(consumedMs) || Math.abs(nowMs - consumedMs) > graceMs) return false;
        if (ua && c.consumed_ua && c.consumed_ua !== ua) return false;
        if (ipHash && c.consumed_ip_hash && c.consumed_ip_hash !== ipHash) return false;
        return true;
      });
      if (consumed.length === 0) return null;
      consumed.sort((a, b) => (Date.parse(b.consumed_at || '') || 0) - (Date.parse(a.consumed_at || '') || 0));
      return { ...consumed[0]! };
    },
    async hasClaims(trackingId) {
      return [...state.claims.values()].some((c) => c.tracking_id === trackingId);
    },
  };
}

function supabaseStore(url: string, serviceRoleKey: string): TrackerStore {
  const supabase: SupabaseClient = createClient(url, serviceRoleKey, {
    auth: { persistSession: false, autoRefreshToken: false },
  });

  return {
    kind: 'supabase',
    async insertEmail(row) {
      const { error } = await supabase.from('tracked_emails').insert(row);
      if (error) throw new StoreError(error.message);
    },
    async insertLink(row) {
      const { error } = await supabase.from('tracked_links').insert(row);
      if (error) throw new StoreError(error.message);
    },
    async getEmail(id) {
      const { data, error } = await supabase
        .from('tracked_emails')
        .select('*')
        .eq('tracking_id', id)
        .maybeSingle();
      if (error) throw new StoreError(error.message);
      return (data as EmailRow | null) ?? null;
    },
    async listEmails(limit) {
      const { data, error } = await supabase
        .from('tracked_emails')
        .select('*')
        .order('sent_at', { ascending: false })
        .limit(limit);
      if (error) throw new StoreError(error.message);
      return (data as EmailRow[] | null) ?? [];
    },
    async listEvents(trackingId) {
      const { data, error } = await supabase
        .from('tracking_events')
        .select('*')
        .eq('tracking_id', trackingId)
        .order('timestamp', { ascending: false })
        .limit(200);
      if (error) throw new StoreError(error.message);
      return (data as EventRow[] | null) ?? [];
    },
    async listEventsForStats(trackingId) {
      const { data, error } = await supabase
        .from('tracking_events')
        .select('type,timestamp,user_agent,suspected_self_open,classification')
        .eq('tracking_id', trackingId)
        .order('timestamp', { ascending: true })
        .limit(STATS_EVENT_LIMIT);
      if (error) throw new StoreError(error.message);
      return (data as StatsEventRow[] | null) ?? [];
    },
    async recentEvents() {
      const { data, error } = await supabase
        .from('tracking_events')
        .select('*')
        .order('timestamp', { ascending: false })
        .limit(50);
      if (error) throw new StoreError(error.message);
      return (data as EventRow[] | null) ?? [];
    },
    async insertEvent(row) {
      const { error } = await supabase.from('tracking_events').insert(row);
      if (error) throw new StoreError(error.message);
    },
    async updateEvent(id, patch) {
      const { error } = await supabase.from('tracking_events').update(patch).eq('id', id);
      if (error) throw new StoreError(error.message);
    },
    async updateEmail(id, patch) {
      const { error } = await supabase.from('tracked_emails').update(patch).eq('tracking_id', id);
      if (error) throw new StoreError(error.message);
    },
    async getLink(clickId) {
      const { data, error } = await supabase
        .from('tracked_links')
        .select('*')
        .eq('click_id', clickId)
        .maybeSingle();
      if (error) throw new StoreError(error.message);
      return (data as LinkRow | null) ?? null;
    },
    async insertClaim(row) {
      const { error } = await supabase.from('tracking_self_view_claims').upsert(row, { onConflict: 'id' });
      if (error) throw new StoreError(error.message);
    },
    async updateClaim(id, patch) {
      const { error } = await supabase.from('tracking_self_view_claims').update(patch).eq('id', id);
      if (error) throw new StoreError(error.message);
    },
    async getClaim(id) {
      const { data, error } = await supabase
        .from('tracking_self_view_claims')
        .select('*')
        .eq('id', id)
        .maybeSingle();
      if (error) throw new StoreError(error.message);
      return (data as ClaimRow | null) ?? null;
    },
    async getActiveClaim(trackingId, gmailMessageId, nowMs = Date.now()) {
      const normQueryMsg = normalizeGmailId(gmailMessageId);
      const { data, error } = await supabase
        .from('tracking_self_view_claims')
        .select('*')
        .eq('tracking_id', trackingId)
        .is('consumed_by_event_id', null)
        .gt('expires_at', new Date(nowMs).toISOString())
        .order('last_observed_at', { ascending: false });
      if (error) throw new StoreError(error.message);
      const rows = (data as ClaimRow[] | null) ?? [];
      if (!rows.length) return null;
      if (normQueryMsg) {
        const exact = rows.find((r) => normalizeGmailId(r.gmail_message_id) === normQueryMsg);
        if (exact) return exact;
      }
      return rows[0] ?? null;
    },
    async consumeClaim(claimId, eventId, consumedAt, ua, ipHash) {
      const patch: Record<string, unknown> = {
        consumed_by_event_id: eventId,
        consumed_at: consumedAt || new Date().toISOString(),
      };
      if (ua !== undefined) patch.consumed_ua = ua;
      if (ipHash !== undefined) patch.consumed_ip_hash = ipHash;
      const { data, error } = await supabase
        .from('tracking_self_view_claims')
        .update(patch)
        .eq('id', claimId)
        .is('consumed_by_event_id', null)
        .select();
      if (error) throw new StoreError(error.message);
      return Boolean(data && data.length > 0);
    },
    async consumeProxySuppression(claimId, eventId, consumedAt) {
      const { data, error } = await supabase
        .from('tracking_self_view_claims')
        .update({
          proxy_consumed_by_event_id: eventId,
          proxy_consumed_at: consumedAt || new Date().toISOString(),
        })
        .eq('id', claimId)
        .is('proxy_consumed_by_event_id', null)
        .select();
      if (error) throw new StoreError(error.message);
      return Boolean(data && data.length > 0);
    },
    async listClaims(trackingId) {
      const { data, error } = await supabase
        .from('tracking_self_view_claims')
        .select('*')
        .eq('tracking_id', trackingId);
      if (error) throw new StoreError(error.message);
      return (data as ClaimRow[] | null) ?? [];
    },
    async getRecentConsumedClaim(trackingId, nowMs = Date.now(), graceMs = 1000, ua, ipHash) {
      const minConsumed = new Date(nowMs - graceMs).toISOString();
      const maxConsumed = new Date(nowMs + graceMs).toISOString();
      const { data, error } = await supabase
        .from('tracking_self_view_claims')
        .select('*')
        .eq('tracking_id', trackingId)
        .not('consumed_by_event_id', 'is', null)
        .gte('consumed_at', minConsumed)
        .lte('consumed_at', maxConsumed)
        .order('consumed_at', { ascending: false });
      if (error) throw new StoreError(error.message);
      const rows = (data as ClaimRow[] | null) ?? [];
      const match = rows.find((c) => {
        if (ua && c.consumed_ua && c.consumed_ua !== ua) return false;
        if (ipHash && c.consumed_ip_hash && c.consumed_ip_hash !== ipHash) return false;
        return true;
      });
      return match ?? null;
    },
    async hasClaims(trackingId) {
      const { count, error } = await supabase
        .from('tracking_self_view_claims')
        .select('*', { count: 'exact', head: true })
        .eq('tracking_id', trackingId);
      if (error) throw new StoreError(error.message);
      return (count ?? 0) > 0;
    },
  };
}
