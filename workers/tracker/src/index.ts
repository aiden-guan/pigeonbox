import { z } from 'zod';
import { safeRedirectUrl, classifyClick, deriveTrackingStats, isSelfViewCorrelated, normalizeGmailId, decideTrackedOpen, normalizeUserAgentFamily, senderFingerprintMatches, openEventMatchesSenderClaim, pickActiveClaim, pickRecentConsumedClaim, planPageReloadProxy, selectSenderProxyClaim, type DerivedTrackingStats } from './helpers.js';
import { getStore, StoreError, type ClaimRow, type EmailRow, type TrackerStore } from './store.js';
export { createMemoryState, createMemoryStore, StoreError, STATS_EVENT_LIMIT } from './store.js';
export type { ClaimRow, EmailRow, EventRow, LinkRow, MemoryState, StatsEventRow, TrackerStore } from './store.js';

export { safeRedirectUrl, classifyOpen, classifyClick, suspectSelfOpen, deriveTrackingStats, isSelfViewCorrelated, normalizeGmailId, detectOpenRequestSource, decideTrackedOpen, normalizeUserAgentFamily, senderFingerprintMatches, pickActiveClaim, pickRecentConsumedClaim } from './helpers.js';

export interface Env {
  SUPABASE_URL?: string;
  SUPABASE_SERVICE_ROLE_KEY?: string;
  PERSONAL_API_TOKEN?: string;
}

const TRANSPARENT_GIF = Uint8Array.from(
  atob('R0lGODlhAQABAIAAAAAAAP///yH5BAEAAAAALAAAAAABAAEAAAIBRAA7'),
  (c) => c.charCodeAt(0),
);

/** Management bodies carry metadata only (subject, addresses, IDs, link URLs). */
export const MAX_BODY_BYTES = 64 * 1024;

/** Tracking, click, claim and event IDs: letters, digits, `_` and `-`. */
const ID_PATTERN = /^[\w-]{1,80}$/;
const SELF_VIEW_EVENT_ID_PATTERN = /^[\w-]{1,160}$/;

const SELF_VIEW_SOURCES = ['ROW_INTERACTION', 'MESSAGE_EXPANDED', 'MESSAGE_LOAD', 'CACHE_REINSPECTION', 'PAGE_RELOAD'] as const;

const PatchEmailSchema = z
  .object({
    gmail_thread_id: z.string().max(128).nullable().optional(),
    gmail_message_id: z.string().max(128).nullable().optional(),
    status: z.enum(['PENDING', 'SENT', 'CANCELLED', 'FAILED']).optional(),
    sent_at: z.string().max(40).nullable().optional(),
    subject: z.string().max(998).optional(),
    sender: z.string().max(320).optional(),
    recipients: z.array(z.string().max(320)).max(100).optional(),
    links: z
      .array(z.object({ click_id: z.string().regex(/^[\w-]+$/).max(80), url: z.string().max(2048).url() }))
      .max(50)
      .optional(),
  })
  .strict();

const CreateEmailSchema = z.object({
  subject: z.string().max(998),
  sender: z.string().max(320),
  recipients: z.array(z.string().max(320)).min(1).max(100),
  gmail_thread_id: z.string().max(128).optional(),
  gmail_message_id: z.string().max(128).optional(),
  links: z.array(z.object({ url: z.string().max(2048).url() })).max(50).optional(),
});

const SelfViewSchema = z.object({
  timestamp: z.string().max(40).optional(),
  gmailThreadId: z.string().max(128).nullable().optional(),
  gmail_thread_id: z.string().max(128).nullable().optional(),
  gmailMessageId: z.string().max(128).nullable().optional(),
  gmail_message_id: z.string().max(128).nullable().optional(),
  source: z.enum(SELF_VIEW_SOURCES).optional(),
  selfViewEventId: z.string().max(400).optional(),
  reconcileGmailIds: z.boolean().optional(),
  reconcile_gmail_ids: z.boolean().optional(),
  quotedRender: z.boolean().optional(),
});

/** Compare secrets without leaking their length or matching prefix through timing. */
export function timingSafeEqual(a: string, b: string): boolean {
  const left = new TextEncoder().encode(a);
  const right = new TextEncoder().encode(b);
  let diff = left.length ^ right.length;
  const length = Math.max(left.length, right.length);
  for (let i = 0; i < length; i += 1) diff |= (left[i] ?? 0) ^ (right[i] ?? 0);
  return diff === 0;
}

function requireAuth(req: Request, env: Env): Response | null {
  const auth = req.headers.get('Authorization') || '';
  const token = auth.startsWith('Bearer ') ? auth.slice(7) : '';
  if (!env.PERSONAL_API_TOKEN || !timingSafeEqual(token, env.PERSONAL_API_TOKEN)) {
    return json({ error: 'unauthorized' }, 401);
  }
  return null;
}

const SECURITY_HEADERS = {
  'X-Content-Type-Options': 'nosniff',
  'Referrer-Policy': 'no-referrer',
} as const;

function json(data: unknown, status = 200): Response {
  return new Response(JSON.stringify(data), {
    status,
    headers: { 'Content-Type': 'application/json', 'Cache-Control': 'no-store', ...SECURITY_HEADERS },
  });
}

function gifResponse(): Response {
  return new Response(TRANSPARENT_GIF, {
    status: 200,
    headers: {
      'Content-Type': 'image/gif',
      'Cache-Control': 'no-store, no-cache, must-revalidate, proxy-revalidate',
      'CDN-Cache-Control': 'no-store',
      'Cloudflare-CDN-Cache-Control': 'no-store',
      Pragma: 'no-cache',
      Expires: '0',
      ETag: `"${crypto.randomUUID()}"`,
      ...SECURITY_HEADERS,
    },
  });
}

/** What a recipient sees for a link that is malformed, unknown or unsafe. Never JSON, never details. */
function linkUnavailable(status: number): Response {
  return new Response('This link is not available.', {
    status,
    headers: { 'Content-Type': 'text/plain; charset=utf-8', 'Cache-Control': 'no-store', ...SECURITY_HEADERS },
  });
}

function redirect(destination: string): Response {
  return new Response(null, {
    status: 302,
    headers: { Location: destination, 'Cache-Control': 'no-store', ...SECURITY_HEADERS },
  });
}

async function hashIp(ip: string, salt: string): Promise<string> {
  const data = new TextEncoder().encode(`${salt}:${ip}`);
  const hash = await crypto.subtle.digest('SHA-256', data);
  return [...new Uint8Array(hash)].map((b) => b.toString(16).padStart(2, '0')).join('');
}

function newId(prefix: string): string {
  return `${prefix}_${crypto.randomUUID().replace(/-/g, '')}`;
}

function clientIp(request: Request): string {
  return (
    request.headers.get('CF-Connecting-IP') ||
    request.headers.get('X-Forwarded-For')?.split(',')[0]?.trim() ||
    ''
  );
}

/** Error class only. Messages can quote request values (JSON parse errors, driver errors). */
function errorName(err: unknown): string {
  return err instanceof Error ? err.name : typeof err;
}

type BodyResult = { ok: true; value: unknown } | { ok: false; response: Response };

/** Read a bounded JSON body. Empty bodies read as `null`. */
async function readJson(request: Request): Promise<BodyResult> {
  const declared = Number(request.headers.get('Content-Length') || '0');
  if (Number.isFinite(declared) && declared > MAX_BODY_BYTES) {
    return { ok: false, response: json({ error: 'payload_too_large' }, 413) };
  }
  let text: string;
  try {
    text = await request.text();
  } catch {
    return { ok: false, response: json({ error: 'bad_request' }, 400) };
  }
  if (new TextEncoder().encode(text).length > MAX_BODY_BYTES) {
    return { ok: false, response: json({ error: 'payload_too_large' }, 413) };
  }
  if (!text.trim()) return { ok: true, value: null };
  try {
    return { ok: true, value: JSON.parse(text) };
  } catch {
    return { ok: false, response: json({ error: 'bad_request' }, 400) };
  }
}

/**
 * What the tracker needs from its host. The self-hosted worker below uses one
 * store and a personal token. PigeonBox Cloud reuses the same handlers with a
 * tenant-scoped store per authenticated user, so protocol v3 behavior (self-view
 * claims, proxy suppression, click classification) is identical in both.
 */
export type TrackerDeps = {
  /** Store for the public pixel and click routes. Lookups are by unguessable ID. */
  publicStore: TrackerStore;
  /** Authenticate a management request and return the store it may use, or an error response. */
  authorize(request: Request): Promise<{ store: TrackerStore } | Response>;
  /** Salt for hashing client IPs. Changing it breaks matching of in-flight self-view claims. */
  ipSalt: string;
  /**
   * Run pixel and click bookkeeping after the response is returned (a Worker's
   * `ctx.waitUntil`), so mail clients and recipients never wait on the store.
   * Without it, the handler records before it responds.
   */
  defer?: (task: Promise<unknown>) => void;
};

export async function handleTrackerRequest(request: Request, deps: TrackerDeps): Promise<Response> {
  const url = new URL(request.url);
  const path = url.pathname;
  let store = deps.publicStore;
  const salt = deps.ipSalt;

  try {
    // Public pixel
    if (request.method === 'GET' && path.startsWith('/open/')) {
      return await handleOpen(path.slice('/open/'.length), request, salt, store, deps.defer);
    }
    // Public click
    if (request.method === 'GET' && path.startsWith('/c/')) {
      return await handleClick(path.slice('/c/'.length), request, salt, store, deps.defer);
    }

    // Private management
    if (path.startsWith('/api/')) {
      const authorized = await deps.authorize(request);
      if (authorized instanceof Response) return authorized;
      store = authorized.store;

      if (request.method === 'POST' && path === '/api/emails') {
        return await handleCreateEmail(request, url.origin, store);
      }
      if (request.method === 'GET' && path === '/api/emails') {
        return await handleListEmails(url, store);
      }
      if (request.method === 'PATCH' && path.startsWith('/api/emails/')) {
        return await handlePatchEmail(path.slice('/api/emails/'.length), request, store);
      }
      if (request.method === 'POST' && path.startsWith('/api/emails/') && path.endsWith('/self-view')) {
        const id = path.slice('/api/emails/'.length, -'/self-view'.length);
        return await handleSelfView(id, request, salt, store);
      }
      if (request.method === 'GET' && path.startsWith('/api/emails/') && path.endsWith('/events')) {
        const id = path.slice('/api/emails/'.length, -'/events'.length);
        return await handleGetEvents(id, store);
      }
      if (request.method === 'GET' && path.startsWith('/api/emails/')) {
        const id = path.slice('/api/emails/'.length);
        return await handleGetEmail(id, store);
      }
      if (request.method === 'GET' && path === '/api/events/recent') {
        return await handleRecentEvents(store);
      }
    }

    if (path === '/health') {
      return json({
        ok: true,
        protocolVersion: 3,
        features: [
          'self_view_claims',
          'event_reclassification',
          'classified_clicks',
          'sender_fingerprint_claims',
        ],
        store: store.kind,
      });
    }

    return json({ error: 'not_found' }, 404);
  } catch (err) {
    // Store and driver messages can echo row values; clients get a code only.
    if (err instanceof StoreError) {
      console.error('[tracker] store request failed');
      return json({ error: 'store_unavailable' }, 503);
    }
    console.error('[tracker] request failed', errorName(err));
    return json({ error: 'internal' }, 500);
  }
}

/** Self-hosted tracker: one owner, authenticated with PERSONAL_API_TOKEN. */
export default {
  async fetch(request: Request, env: Env): Promise<Response> {
    const store = getStore(env);
    return handleTrackerRequest(request, {
      publicStore: store,
      authorize: async (req) => requireAuth(req, env) ?? { store },
      ipSalt: env.PERSONAL_API_TOKEN || 'salt',
    });
  },
};

/**
 * Store a link once. A repeat for the same email is a no-op (sends retry and the
 * request modifier can run twice); false means the click ID belongs elsewhere.
 */
async function insertLinkOnce(store: TrackerStore, click_id: string, tracking_id: string, destination: string): Promise<boolean> {
  const already = await store.getLink(click_id);
  if (already) return already.tracking_id === tracking_id;
  try {
    await store.insertLink({ click_id, tracking_id, destination });
    return true;
  } catch (err) {
    // A concurrent insert of the same link wins the race; anything else is a real failure.
    const raced = await store.getLink(click_id);
    if (raced) return raced.tracking_id === tracking_id;
    throw err;
  }
}

async function handleCreateEmail(
  request: Request,
  origin: string,
  store: TrackerStore,
): Promise<Response> {
  const body = await readJson(request);
  if (!body.ok) return body.response;
  const parsed = CreateEmailSchema.safeParse(body.value);
  if (!parsed.success) return json({ error: 'bad_request' }, 400);
  const input = parsed.data;
  const tracking_id = newId('trk');
  const created_at = new Date().toISOString();

  const email: EmailRow = {
    tracking_id,
    status: 'PENDING',
    subject: input.subject,
    sender: input.sender,
    recipients: input.recipients,
    gmail_thread_id: normalizeGmailId(input.gmail_thread_id),
    gmail_message_id: normalizeGmailId(input.gmail_message_id),
    sent_at: null,
    first_opened_at: null,
    last_opened_at: null,
    open_count: 0,
    first_clicked_at: null,
    last_clicked_at: null,
    click_count: 0,
    created_at,
  };
  await store.insertEmail(email);

  const links = (input.links || [])
    .map((link) => safeRedirectUrl(link.url))
    .filter((safe): safe is string => Boolean(safe))
    .map((safe) => ({ click_id: newId('clk'), original: safe }));
  await Promise.all(links.map((link) => store.insertLink({ click_id: link.click_id, tracking_id, destination: link.original })));

  return json({
    tracking_id,
    pixel_url: `${origin}/open/${tracking_id}`,
    status: 'PENDING',
    created_at,
    sent_at: null,
    rewritten_links: links.map((link) => ({ ...link, tracked_url: `${origin}/c/${link.click_id}` })),
  });
}

async function handleGetEmail(id: string, store: TrackerStore): Promise<Response> {
  if (!ID_PATTERN.test(id)) return json({ error: 'bad_id' }, 400);
  const data = await store.getEmail(id);
  if (!data) return json({ error: 'not_found' }, 404);
  return json(data);
}

async function handleListEmails(url: URL, store: TrackerStore): Promise<Response> {
  const raw = Number(url.searchParams.get('limit') || '100');
  const limit = Number.isFinite(raw) ? Math.min(200, Math.max(1, Math.floor(raw))) : 100;
  return json(await store.listEmails(limit));
}

/**
 * The send time to store. A client clock running ahead would push `sent_at`
 * past real recipient opens and make them read as pre-send fetches, so a
 * future time is clamped to the tracker's clock.
 */
function acceptedSentAt(value: string, nowMs: number): string | null {
  const ms = Date.parse(value);
  if (!Number.isFinite(ms)) return null;
  return new Date(Math.min(ms, nowMs)).toISOString();
}

async function handlePatchEmail(
  id: string,
  request: Request,
  store: TrackerStore,
): Promise<Response> {
  if (!ID_PATTERN.test(id)) return json({ error: 'bad_id' }, 400);
  const body = await readJson(request);
  if (!body.ok) return body.response;
  const parsed = PatchEmailSchema.safeParse(body.value);
  if (!parsed.success) return json({ error: 'bad_request' }, 400);
  const existing = await store.getEmail(id);
  if (!existing) return json({ error: 'not_found' }, 404);
  const now = Date.now();
  const patch: Partial<EmailRow> = {};
  if (parsed.data.gmail_thread_id !== undefined) patch.gmail_thread_id = normalizeGmailId(parsed.data.gmail_thread_id);
  if (parsed.data.gmail_message_id !== undefined) patch.gmail_message_id = normalizeGmailId(parsed.data.gmail_message_id);
  if (parsed.data.subject !== undefined) patch.subject = parsed.data.subject;
  if (parsed.data.sender !== undefined) patch.sender = parsed.data.sender;
  if (parsed.data.recipients !== undefined) patch.recipients = parsed.data.recipients;
  // SENT is final: a late discard or retry from another tab must not un-send a delivered message.
  if (parsed.data.status !== undefined && !(existing.status === 'SENT' && parsed.data.status !== 'SENT')) {
    patch.status = parsed.data.status;
  }
  if (parsed.data.sent_at !== undefined) {
    if (parsed.data.sent_at === null) {
      if (existing.status !== 'SENT') patch.sent_at = null;
    } else {
      const sentAt = acceptedSentAt(parsed.data.sent_at, now);
      if (!sentAt) return json({ error: 'bad_request' }, 400);
      patch.sent_at = sentAt;
    }
  }
  if (patch.status === 'SENT' && patch.sent_at === undefined && !existing.sent_at) {
    patch.sent_at = new Date(now).toISOString();
  }
  if (Object.keys(patch).length > 0) await store.updateEmail(id, patch);
  const links = (parsed.data.links || [])
    .map((link) => ({ click_id: link.click_id, destination: safeRedirectUrl(link.url) }))
    .filter((link): link is { click_id: string; destination: string } => Boolean(link.destination));
  const stored = await Promise.all(links.map((link) => insertLinkOnce(store, link.click_id, id, link.destination)));
  if (stored.includes(false)) return json({ error: 'click_id_conflict' }, 409);
  return json(await store.getEmail(id));
}

async function handleGetEvents(id: string, store: TrackerStore): Promise<Response> {
  if (!ID_PATTERN.test(id)) return json({ error: 'bad_id' }, 400);
  return json(await store.listEvents(id));
}

async function handleRecentEvents(store: TrackerStore): Promise<Response> {
  return json(await store.recentEvents());
}

/**
 * Recompute an email's counters from every stored event. Reclassification can
 * move an earlier event out of (or into) the count, so counters are always
 * derived, never incremented.
 */
async function recomputeEmailStats(trackingId: string, store: TrackerStore): Promise<DerivedTrackingStats> {
  const stats = deriveTrackingStats(await store.listEventsForStats(trackingId));
  await store.updateEmail(trackingId, {
    open_count: stats.openCount,
    first_opened_at: stats.firstOpenedAt,
    last_opened_at: stats.lastOpenedAt,
    click_count: stats.clickCount,
    first_clicked_at: stats.firstClickedAt,
    last_clicked_at: stats.lastClickedAt,
  });
  return stats;
}

const CLAIM_TTL_MS = 25_000;

async function handleSelfView(
  id: string,
  request: Request,
  salt: string,
  store: TrackerStore,
): Promise<Response> {
  if (!ID_PATTERN.test(id)) return json({ error: 'bad_id' }, 400);
  const raw = await readJson(request);
  if (!raw.ok) return raw.response;
  const parsed = SelfViewSchema.safeParse(raw.value ?? {});
  if (!parsed.success) return json({ error: 'bad_request' }, 400);
  const existing = await store.getEmail(id);
  if (!existing) return json({ error: 'not_found' }, 404);

  const body = parsed.data;
  // A malformed idempotency key is ignored rather than trusted as a row ID.
  const selfViewEventId = body.selfViewEventId && SELF_VIEW_EVENT_ID_PATTERN.test(body.selfViewEventId) ? body.selfViewEventId : undefined;
  const ts = body.timestamp && !Number.isNaN(Date.parse(body.timestamp))
    ? new Date(body.timestamp).toISOString()
    : new Date().toISOString();
  const selfMs = Date.parse(ts);

  const normThread = normalizeGmailId(body.gmailThreadId ?? body.gmail_thread_id);
  const normMessage = normalizeGmailId(body.gmailMessageId ?? body.gmail_message_id);
  const source = body.source || 'MESSAGE_EXPANDED';
  const reconcile = body.reconcileGmailIds === true || body.reconcile_gmail_ids === true;
  const ua = request.headers.get('User-Agent');
  const ip = clientIp(request);
  const senderIpHash = ip ? await hashIp(ip, salt) : null;
  const senderUaFamily = normalizeUserAgentFamily(ua);

  // Idempotency: repeated delivery with the same selfViewEventId
  if (selfViewEventId) {
    const events = await store.listEvents(id);
    const alreadyEvt = events.find((e) => e.id === selfViewEventId);
    if (alreadyEvt) {
      const claim =
        (await store.getActiveClaim(id, normMessage, selfMs)) ||
        (await store.getClaim(`clm_${selfViewEventId}`));
      return json({
        ok: true,
        claimId: claim?.id || `clm_${selfViewEventId}`,
        claimExpiresAt: claim?.expires_at || new Date(selfMs + CLAIM_TTL_MS).toISOString(),
        open_count: existing.open_count,
        reclassifiedEventIds: [],
      });
    }
  }

  const emailPatch: Partial<EmailRow> = {};
  if (normThread && (reconcile || !existing.gmail_thread_id) && existing.gmail_thread_id !== normThread) {
    emailPatch.gmail_thread_id = normThread;
  }
  if (normMessage && (reconcile || !existing.gmail_message_id) && existing.gmail_message_id !== normMessage) {
    emailPatch.gmail_message_id = normMessage;
  }
  if (Object.keys(emailPatch).length > 0) {
    await store.updateEmail(id, emailPatch);
  }

  // Active claim create or refresh
  const activeClaim = await store.getActiveClaim(id, normMessage, selfMs);
  let claimId: string;
  let claimExpiresAt: string;

  if (activeClaim) {
    claimId = activeClaim.id;
    if (source === 'CACHE_REINSPECTION') {
      claimExpiresAt = activeClaim.expires_at;
      const patch: Partial<ClaimRow> = {};
      if (normMessage && (reconcile || !activeClaim.gmail_message_id)) patch.gmail_message_id = normMessage;
      if (normThread && (reconcile || !activeClaim.gmail_thread_id)) patch.gmail_thread_id = normThread;
      if (senderIpHash) patch.sender_ip_hash = senderIpHash;
      if (senderUaFamily) patch.sender_ua_family = senderUaFamily;
      if (Object.keys(patch).length > 0) await store.updateClaim(activeClaim.id, patch);
    } else {
      claimExpiresAt = new Date(selfMs + CLAIM_TTL_MS).toISOString();
      const patch: Partial<ClaimRow> = {
        last_observed_at: ts,
        expires_at: claimExpiresAt,
        source,
      };
      if (normMessage && (reconcile || !activeClaim.gmail_message_id)) patch.gmail_message_id = normMessage;
      if (normThread && (reconcile || !activeClaim.gmail_thread_id)) patch.gmail_thread_id = normThread;
      if (senderIpHash) patch.sender_ip_hash = senderIpHash;
      if (senderUaFamily) patch.sender_ua_family = senderUaFamily;
      await store.updateClaim(activeClaim.id, patch);
    }
  } else {
    claimId = selfViewEventId ? `clm_${selfViewEventId}` : newId('clm');
    claimExpiresAt = new Date(selfMs + CLAIM_TTL_MS).toISOString();
    const existingClaim = await store.getClaim(claimId);
    if (existingClaim) {
      await store.updateClaim(claimId, {
        last_observed_at: ts,
        expires_at: claimExpiresAt,
        source,
        ...(senderIpHash ? { sender_ip_hash: senderIpHash } : {}),
        ...(senderUaFamily ? { sender_ua_family: senderUaFamily } : {}),
      });
    } else {
      const newClaim: ClaimRow = {
        id: claimId,
        tracking_id: id,
        gmail_message_id: normMessage,
        gmail_thread_id: normThread,
        sender_ip_hash: senderIpHash,
        sender_ua_family: senderUaFamily,
        first_observed_at: ts,
        last_observed_at: ts,
        expires_at: claimExpiresAt,
        source,
        consumed_by_event_id: null,
        proxy_consumed_by_event_id: null,
        proxy_consumed_at: null,
        created_at: new Date().toISOString(),
      };
      await store.insertClaim(newClaim);
    }
  }

  const eventId = selfViewEventId ?? newId('evt');
  await store.insertEvent({
    id: eventId,
    tracking_id: id,
    type: 'SELF_VIEW',
    timestamp: ts,
    user_agent: ua,
    ip_hash: senderIpHash,
    suspected_self_open: true,
    confidence: 1,
    classification: 'SELF_LIKELY',
  });

  const events = await store.listEvents(id);
  const reclassifiedEventIds: string[] = [];
  let claimConsumed = false;

  const claimExpiresAtMs = Date.parse(claimExpiresAt);
  const claimStartMs = selfMs - 5_000;

  for (const evt of events) {
    const matchesSender = openEventMatchesSenderClaim({
      eventType: evt.type,
      eventTs: Date.parse(evt.timestamp),
      claimStartMs,
      claimEndMs: claimExpiresAtMs,
      userAgent: evt.user_agent,
      ipHash: evt.ip_hash,
      senderIpHash,
      senderUaFamily,
    });
    if (!matchesSender) continue;
    if (evt.classification !== 'SELF_LIKELY') {
      await store.updateEvent(evt.id, {
        classification: 'SELF_LIKELY',
        suspected_self_open: true,
        confidence: 1,
      });
      reclassifiedEventIds.push(evt.id);
    }
    if (evt.type === 'OPEN' && !claimConsumed) {
      claimConsumed = true;
      await store.consumeClaim(claimId, evt.id, evt.timestamp, evt.user_agent, evt.ip_hash);
    }
  }

  if (source === 'PAGE_RELOAD') {
    const reloadEvents = await store.listEvents(id);
    const claim = await store.getClaim(claimId);
    const observedProxy = {
      proxyConsumedByEventId: claim?.proxy_consumed_by_event_id ?? null,
      proxyConsumedAt: claim?.proxy_consumed_at ?? null,
    };
    const plan = planPageReloadProxy(
      reloadEvents.map((evt) => ({
        id: evt.id,
        type: evt.type,
        timestamp: evt.timestamp,
        classification: evt.classification,
        user_agent: evt.user_agent,
      })),
      selfMs,
      observedProxy,
    );
    if (plan.reclassifyEventId) {
      const evt = reloadEvents.find((row) => row.id === plan.reclassifyEventId);
      if (evt && evt.classification !== 'SELF_LIKELY') {
        await store.updateEvent(evt.id, {
          classification: 'SELF_LIKELY',
          suspected_self_open: true,
          confidence: 1,
        });
        reclassifiedEventIds.push(evt.id);
      }
    }
    if (plan.updateProxySlot && claim) {
      if (plan.proxyConsumedByEventId) {
        await store.updateClaim(claimId, {
          proxy_consumed_by_event_id: plan.proxyConsumedByEventId,
          proxy_consumed_at: plan.proxyConsumedAt,
        });
      } else {
        const latest = await store.getClaim(claimId);
        const unchanged =
          (latest?.proxy_consumed_by_event_id ?? null) === observedProxy.proxyConsumedByEventId &&
          (latest?.proxy_consumed_at ?? null) === observedProxy.proxyConsumedAt;
        if (unchanged) {
          await store.updateClaim(claimId, {
            proxy_consumed_by_event_id: null,
            proxy_consumed_at: null,
          });
        }
      }
    }
  }

  const stats = await recomputeEmailStats(id, store);
  return json({
    ok: true,
    claimId,
    claimExpiresAt,
    open_count: stats.openCount,
    reclassifiedEventIds,
  });
}

/** Run bookkeeping after the response when the host allows it; never let it fail the response. */
async function record(task: () => Promise<void>, label: string, defer?: (task: Promise<unknown>) => void): Promise<void> {
  const run = task().catch((err) => {
    console.error(`[tracker] ${label} record failed`, errorName(err));
  });
  if (defer) defer(run);
  else await run;
}

async function handleOpen(
  trackingId: string,
  request: Request,
  salt: string,
  store: TrackerStore,
  defer?: (task: Promise<unknown>) => void,
): Promise<Response> {
  // Always return the GIF. Malformed and unknown IDs look exactly like known ones.
  if (!ID_PATTERN.test(trackingId)) return gifResponse();
  const ua = request.headers.get('User-Agent');
  const ip = clientIp(request);
  const now = Date.now();
  await record(() => recordOpen(trackingId, ua, ip, now, salt, store), 'open', defer);
  return gifResponse();
}

async function recordOpen(
  trackingId: string,
  ua: string | null,
  ip: string,
  now: number,
  salt: string,
  store: TrackerStore,
): Promise<void> {
  const email = await store.getEmail(trackingId);
  if (!email) return;
  const ip_hash = ip ? await hashIp(ip, salt) : null;
  const ts = new Date(now).toISOString();
  const eventId = newId('evt');

  // One read of this email's claims answers every claim question below.
  const claimRows = await store.listClaims(trackingId);
  const activeClaim = pickActiveClaim(claimRows, email.gmail_message_id, now);
  const proxySelection = selectSenderProxyClaim(
    claimRows.map((claim) => ({
      id: claim.id,
      gmailMessageId: claim.gmail_message_id,
      lastObservedAt: claim.last_observed_at,
      expiresAt: claim.expires_at,
      proxyConsumedByEventId: claim.proxy_consumed_by_event_id ?? null,
      proxyConsumedAt: claim.proxy_consumed_at ?? null,
    })),
    now,
    email.gmail_message_id,
  );
  const recentConsumed = activeClaim ? null : pickRecentConsumedClaim(claimRows, now, 1000, ua, ip_hash);
  const recentMatches = Boolean(
    recentConsumed &&
      senderFingerprintMatches(
        {
          senderIpHash: recentConsumed.sender_ip_hash || recentConsumed.consumed_ip_hash,
          senderUaFamily: recentConsumed.sender_ua_family || normalizeUserAgentFamily(recentConsumed.consumed_ua),
        },
        { ipHash: ip_hash, userAgent: ua },
      ),
  );
  let selfViewTs: number | null = null;
  if (!activeClaim && !recentMatches && claimRows.length === 0) {
    // Trackers older than self-view claims only recorded SELF_VIEW events.
    const events = await store.listEvents(trackingId);
    const recentSelfView = events.find((e) => e.type === 'SELF_VIEW' && isSelfViewCorrelated(now, Date.parse(e.timestamp)));
    selfViewTs = recentSelfView ? Date.parse(recentSelfView.timestamp) : null;
  }
  const verdict = decideTrackedOpen({
    sentAt: email.sent_at,
    now,
    ua,
    ipHash: ip_hash,
    selfViewTs,
    activeClaim: activeClaim
      ? { senderIpHash: activeClaim.sender_ip_hash, senderUaFamily: activeClaim.sender_ua_family }
      : null,
    recentConsumedMatches: recentMatches,
    proxySuppression: proxySelection?.mode ?? 'none',
  });
  if (verdict.consumeClaim && activeClaim) {
    await store.consumeClaim(activeClaim.id, eventId, ts, ua, ip_hash);
  }
  if (verdict.consumeProxySuppression && proxySelection) {
    await store.consumeProxySuppression(proxySelection.claim.id, eventId, ts);
  }

  await store.insertEvent({
    id: eventId,
    tracking_id: trackingId,
    type: 'OPEN',
    timestamp: ts,
    user_agent: ua,
    ip_hash,
    suspected_self_open: verdict.suspected,
    confidence: verdict.confidence,
    classification: verdict.classification,
  });

  await recomputeEmailStats(trackingId, store);
}

async function handleClick(
  clickId: string,
  request: Request,
  salt: string,
  store: TrackerStore,
  defer?: (task: Promise<unknown>) => void,
): Promise<Response> {
  if (!ID_PATTERN.test(clickId)) return linkUnavailable(400);

  // Only a stored link redirects, and only to an http(s) destination: never an open redirect.
  let link: Awaited<ReturnType<TrackerStore['getLink']>>;
  try {
    link = await store.getLink(clickId);
  } catch (err) {
    console.error('[tracker] click lookup failed', errorName(err));
    return linkUnavailable(503);
  }
  if (!link) return linkUnavailable(404);
  const destination = safeRedirectUrl(link.destination);
  if (!destination) return linkUnavailable(400);

  const ua = request.headers.get('User-Agent');
  const ip = clientIp(request);
  const now = Date.now();
  await record(async () => {
    const ip_hash = ip ? await hashIp(ip, salt) : null;
    const [email, events] = await Promise.all([store.getEmail(link.tracking_id), store.listEvents(link.tracking_id)]);
    const recentSelfView = events.find((e) => e.type === 'SELF_VIEW' && isSelfViewCorrelated(now, Date.parse(e.timestamp)));
    const verdict = classifyClick({
      sentAt: email?.sent_at ?? null,
      now,
      ua,
      selfViewTs: recentSelfView ? Date.parse(recentSelfView.timestamp) : null,
    });
    await store.insertEvent({
      id: newId('evt'),
      tracking_id: link.tracking_id,
      type: 'CLICK',
      timestamp: new Date(now).toISOString(),
      user_agent: ua,
      ip_hash,
      click_id: clickId,
      destination,
      suspected_self_open: verdict.suspected,
      confidence: verdict.confidence,
      classification: verdict.classification,
    });
    await recomputeEmailStats(link.tracking_id, store);
  }, 'click', defer);

  return redirect(destination);
}
