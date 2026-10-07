import { httpRouter } from "convex/server";
import { internal } from "./_generated/api";
import { httpAction } from "./_generated/server";
import { publicTrackerOrigin, trackingIdFromUrl, classifyOpenEvent, classifyClickEvent, isSelfViewCorrelated } from "./openRequest";

// Unpacked Chrome extension IDs vary. Web page origins are not allowed;
// every management request still authenticates with the personal bearer token.
function extensionOrigin(request: Request): string | null {
  const origin = request.headers.get("Origin") || "";
  return /^chrome-extension:\/\/[a-p]{32}$/.test(origin) ? origin : null;
}

function apiHttpAction(handler: Parameters<typeof httpAction>[0]) {
  return httpAction(async (ctx, request) => {
    const response = await handler(ctx, request);
    const origin = extensionOrigin(request);
    response.headers.set("Vary", "Origin");
    if (origin) {
      response.headers.set("Access-Control-Allow-Origin", origin);
      response.headers.set("Access-Control-Allow-Methods", "GET, POST, PATCH, OPTIONS");
      response.headers.set("Access-Control-Allow-Headers", "Authorization, Content-Type");
    }
    return response;
  });
}

const TRANSPARENT_GIF = Uint8Array.from(
  atob("R0lGODlhAQABAIAAAAAAAP///yH5BAEAAAAALAAAAAABAAEAAAIBRAA7"),
  (c) => c.charCodeAt(0),
);

function json(data: unknown, status = 200): Response {
  return new Response(JSON.stringify(data), {
    status,
    headers: { "Content-Type": "application/json", "Cache-Control": "no-store" },
  });
}

function gif(): Response {
  return new Response(TRANSPARENT_GIF, {
    status: 200,
    headers: {
      "Content-Type": "image/gif",
      "Content-Length": String(TRANSPARENT_GIF.byteLength),
      "Cache-Control": "private, no-cache, no-store, max-age=0, must-revalidate",
      "CDN-Cache-Control": "no-store",
      "Cloudflare-CDN-Cache-Control": "no-store",
      Pragma: "no-cache",
      Expires: "0",
      // A fresh tag on every response keeps a proxy from reusing a cached copy.
      ETag: `"${crypto.randomUUID()}"`,
      "X-Content-Type-Options": "nosniff",
    },
  });
}

/** Compare secrets without leaking their length or matching prefix through timing. */
function timingSafeEqual(a: string, b: string): boolean {
  const left = new TextEncoder().encode(a);
  const right = new TextEncoder().encode(b);
  let diff = left.length ^ right.length;
  const length = Math.max(left.length, right.length);
  for (let i = 0; i < length; i += 1) diff |= (left[i] ?? 0) ^ (right[i] ?? 0);
  return diff === 0;
}

function authorized(request: Request): boolean {
  const token = process.env.PERSONAL_API_TOKEN || "";
  const header = request.headers.get("Authorization") || "";
  const presented = header.startsWith("Bearer ") ? header.slice(7) : "";
  return Boolean(token) && timingSafeEqual(presented, token);
}

function safeRedirectUrl(url: string): string | null {
  try {
    const parsed = new URL(url);
    if (parsed.protocol !== "http:" && parsed.protocol !== "https:") return null;
    return parsed.toString();
  } catch {
    return null;
  }
}

async function hashIp(ip: string): Promise<string | null> {
  if (!ip) return null;
  const salt = process.env.PERSONAL_API_TOKEN || "salt";
  const hash = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(`${salt}:${ip}`));
  return [...new Uint8Array(hash)].map((byte) => byte.toString(16).padStart(2, "0")).join("");
}

function clientIp(request: Request): string {
  return (
    request.headers.get("cf-connecting-ip") ||
    request.headers.get("x-forwarded-for")?.split(",")[0]?.trim() ||
    ""
  );
}

function newId(prefix: string): string {
  return `${prefix}_${crypto.randomUUID().replace(/-/g, "")}`;
}

function validId(id: string): boolean {
  return Boolean(id) && id.length <= 80 && /^[\w-]+$/.test(id);
}

function validEventId(id: string): boolean {
  return Boolean(id) && id.length <= 160 && /^[\w-]+$/.test(id);
}

type EmailDoc = {
  trackingId: string;
  subject: string;
  sender: string;
  recipients: string[];
  gmailThreadId: string | null;
  gmailMessageId: string | null;
  status?: "PENDING" | "SENT" | "CANCELLED" | "FAILED";
  createdAt?: string;
  sentAt: string | null;
  firstOpenedAt: string | null;
  lastOpenedAt: string | null;
  openCount: number;
  firstClickedAt: string | null;
  lastClickedAt: string | null;
  clickCount: number;
};

type EventDoc = {
  eventId: string;
  trackingId: string;
  type: "OPEN" | "CLICK" | "SELF_VIEW";
  timestamp: string;
  userAgent: string | null;
  ipHash: string | null;
  suspectedSelfOpen: boolean;
  confidence: number;
  classification?: "RECIPIENT_LIKELY" | "SELF_LIKELY" | "PROXY_LIKELY" | "MACHINE_LIKELY" | "UNKNOWN";
  clickId: string | null;
  destination: string | null;
};

function emailJson(row: EmailDoc) {
  return {
    tracking_id: row.trackingId,
    subject: row.subject,
    sender: row.sender,
    recipients: row.recipients,
    gmail_thread_id: row.gmailThreadId,
    gmail_message_id: row.gmailMessageId,
    status: row.status || (row.sentAt ? "SENT" : "PENDING"),
    created_at: row.createdAt || null,
    sent_at: row.sentAt,
    first_opened_at: row.firstOpenedAt,
    last_opened_at: row.lastOpenedAt,
    open_count: row.openCount,
    first_clicked_at: row.firstClickedAt,
    last_clicked_at: row.lastClickedAt,
    click_count: row.clickCount,
  };
}

function eventJson(row: EventDoc) {
  return {
    id: row.eventId,
    tracking_id: row.trackingId,
    type: row.type,
    timestamp: row.timestamp,
    user_agent: row.userAgent,
    ip_hash: row.ipHash,
    suspected_self_open: row.suspectedSelfOpen,
    confidence: row.confidence,
    classification: row.classification,
    click_id: row.clickId,
    destination: row.destination,
  };
}

const http = httpRouter();

http.route({
  path: "/health",
  method: "GET",
  handler: httpAction(async () =>
    json({
      ok: true,
      protocolVersion: 3,
      features: ["self_view_claims", "event_reclassification", "classified_clicks", "sender_fingerprint_claims"],
      store: "convex",
    }),
  ),
});

http.route({
  pathPrefix: "/open/",
  method: "GET",
  handler: httpAction(async (ctx, request) => {
    const headerPath = request.headers.get("x-forwarded-uri") || request.headers.get("x-original-url") || "";
    const trackingId = trackingIdFromUrl(request.url) || (headerPath ? trackingIdFromUrl(headerPath) : null);
    if (!trackingId || !validId(trackingId)) return gif();
    try {
      const email = await ctx.runQuery(internal.tracking.getEmail, { trackingId });
      if (email) {
        const now = Date.now();
        const ua = request.headers.get("User-Agent");
        const eventId = newId("evt");
        const ipHash = await hashIp(clientIp(request));
        const event = {
          eventId,
          trackingId,
          type: "OPEN" as const,
          timestamp: new Date(now).toISOString(),
          userAgent: ua,
          ipHash,
          suspectedSelfOpen: false,
          confidence: 0,
          clickId: null,
          destination: null,
        };
        try {
          await ctx.runMutation(internal.tracking.recordOpenEvent, event);
        } catch (error) {
          console.error("open event insert failed", error);
        }
      }
    } catch (error) {
      console.error("open record failed", error);
    }
    return gif();
  }),
});

http.route({
  pathPrefix: "/c/",
  method: "GET",
  handler: httpAction(async (ctx, request) => {
    let rawId = decodeURIComponent(new URL(request.url).pathname.slice("/c/".length)).trim();
    rawId = rawId.replace(/\/+$/, "");
    if (!validId(rawId)) return json({ error: "bad_id" }, 400);
    const clickId = rawId;
    const link = await ctx.runQuery(internal.tracking.getLink, { clickId });
    if (!link) return json({ error: "not_found" }, 404);
    const destination = safeRedirectUrl(link.destination);
    if (!destination) return json({ error: "bad_destination" }, 400);
    try {
      const now = Date.now();
      const ua = request.headers.get("User-Agent");
      const email = await ctx.runQuery(internal.tracking.getEmail, { trackingId: link.trackingId });
      const events = await ctx.runQuery(internal.tracking.listEvents, { trackingId: link.trackingId });
      const recentSelfView = events.find(
        (e) => e.type === "SELF_VIEW" && isSelfViewCorrelated(now, Date.parse(e.timestamp)),
      );
      const selfViewTs = recentSelfView ? Date.parse(recentSelfView.timestamp) : null;
      const sentMs = email?.sentAt ? Date.parse(email.sentAt) : null;
      const verdict = classifyClickEvent({
        eventTs: now,
        sentAt: sentMs != null && Number.isFinite(sentMs) ? sentMs : null,
        userAgent: ua,
        selfViewTs,
      });

      await ctx.runMutation(internal.tracking.recordClick, {
        eventId: newId("evt"),
        trackingId: link.trackingId,
        type: "CLICK",
        timestamp: new Date(now).toISOString(),
        userAgent: ua,
        ipHash: await hashIp(clientIp(request)),
        suspectedSelfOpen: verdict.suspected,
        confidence: verdict.confidence,
        classification: verdict.classification,
        clickId,
        destination,
      });
    } catch (error) {
      console.error("click record failed", error);
    }
    return Response.redirect(destination, 302);
  }),
});

// Browsers do not send the bearer token on a preflight. Authenticate only the
// actual API request, including GETs whose Authorization header triggers CORS.
http.route({
  pathPrefix: "/api/",
  method: "OPTIONS",
  handler: apiHttpAction(async (_ctx, request) => new Response(null, {
    status: extensionOrigin(request) ? 204 : 403,
    headers: { "Cache-Control": "no-store" },
  })),
});

http.route({
  pathPrefix: "/api/",
  method: "GET",
  handler: apiHttpAction(async (ctx, request) => {
    if (!authorized(request)) return json({ error: "unauthorized" }, 401);
    const url = new URL(request.url);
    const path = url.pathname;
    if (path === "/api/emails") {
      const raw = Number(url.searchParams.get("limit") || "100");
      const limit = Number.isFinite(raw) ? Math.min(200, Math.max(1, Math.floor(raw))) : 100;
      const rows = await ctx.runQuery(internal.tracking.listEmails, { limit });
      return json(rows.map(emailJson));
    }
    if (path === "/api/events/recent") {
      const rows = await ctx.runQuery(internal.tracking.recentEvents, {});
      return json(rows.map(eventJson));
    }
    if (path.startsWith("/api/emails/") && path.endsWith("/events")) {
      const id = decodeURIComponent(path.slice("/api/emails/".length, -"/events".length));
      if (!validId(id)) return json({ error: "bad_id" }, 400);
      const rows = await ctx.runQuery(internal.tracking.listEvents, { trackingId: id });
      return json(rows.map(eventJson));
    }
    if (path.startsWith("/api/emails/")) {
      const id = decodeURIComponent(path.slice("/api/emails/".length));
      if (!validId(id)) return json({ error: "bad_id" }, 400);
      const row = await ctx.runQuery(internal.tracking.getEmail, { trackingId: id });
      if (!row) return json({ error: "not_found" }, 404);
      return json(emailJson(row));
    }
    return json({ error: "not_found" }, 404);
  }),
});

http.route({
  path: "/api/emails",
  method: "POST",
  handler: apiHttpAction(async (ctx, request) => {
    if (!authorized(request)) return json({ error: "unauthorized" }, 401);
    const body = (await request.json().catch(() => null)) as {
      subject?: unknown;
      sender?: unknown;
      recipients?: unknown;
      gmail_thread_id?: unknown;
      gmail_message_id?: unknown;
      links?: unknown;
    } | null;
    if (!body || typeof body.subject !== "string" || typeof body.sender !== "string" || !Array.isArray(body.recipients)) {
      return json({ error: "bad_request" }, 400);
    }
    const recipients = body.recipients.filter((item): item is string => typeof item === "string").slice(0, 100);
    if (!recipients.length || body.subject.length > 998) return json({ error: "bad_request" }, 400);
    const trackingId = newId("trk");
    const createdAt = new Date().toISOString();
    const origin = publicTrackerOrigin(process.env.CONVEX_SITE_URL, request.url);
    const links: Array<{ clickId: string; destination: string }> = [];
    const rewritten: Array<{ click_id: string; original: string; tracked_url: string }> = [];
    if (Array.isArray(body.links)) {
      for (const link of body.links.slice(0, 50)) {
        const raw = link && typeof link === "object" && "url" in link ? String((link as { url: unknown }).url) : "";
        const safe = safeRedirectUrl(raw);
        if (!safe) continue;
        const clickId = newId("clk");
        links.push({ clickId, destination: safe });
        rewritten.push({ click_id: clickId, original: safe, tracked_url: `${origin}/c/${clickId}` });
      }
    }
    await ctx.runMutation(internal.tracking.createEmail, {
      trackingId,
      subject: body.subject,
      sender: body.sender.slice(0, 320),
      recipients,
      gmailThreadId: typeof body.gmail_thread_id === "string" ? body.gmail_thread_id.slice(0, 128) : null,
      gmailMessageId: typeof body.gmail_message_id === "string" ? body.gmail_message_id.slice(0, 128) : null,
      status: "PENDING" as const,
      sentAt: null,
      createdAt,
      links,
    });
    return json({
      tracking_id: trackingId,
      pixel_url: `${origin}/open/${trackingId}`,
      status: "PENDING",
      created_at: createdAt,
      sent_at: null,
      rewritten_links: rewritten,
    });
  }),
});

// Authenticated sender lookup: resolving a link never records recipient activity.
http.route({
  pathPrefix: "/api/links/",
  method: "GET",
  handler: apiHttpAction(async (ctx, request) => {
    if (!authorized(request)) return json({ error: "unauthorized" }, 401);
    const clickId = new URL(request.url).pathname.slice("/api/links/".length);
    if (!validId(clickId)) return json({ error: "bad_id" }, 400);
    const link = await ctx.runQuery(internal.tracking.getLink, { clickId });
    if (!link) return json({ error: "not_found" }, 404);
    const destination = safeRedirectUrl(link.destination);
    if (!destination) return json({ error: "bad_destination" }, 400);
    return json({ tracking_id: link.trackingId, destination });
  }),
});

http.route({
  pathPrefix: "/api/emails/",
  method: "POST",
  handler: apiHttpAction(async (ctx, request) => {
    if (!authorized(request)) return json({ error: "unauthorized" }, 401);
    const path = new URL(request.url).pathname;
    if (!path.endsWith("/self-view")) return json({ error: "not_found" }, 404);
    const id = decodeURIComponent(path.slice("/api/emails/".length, -"/self-view".length));
    if (!validId(id) || id.includes("/")) return json({ error: "bad_id" }, 400);

    const body = (await request.json().catch(() => ({}))) as {
      timestamp?: string;
      gmailThreadId?: string | null;
      gmail_thread_id?: string | null;
      gmailMessageId?: string | null;
      gmail_message_id?: string | null;
      source?: "ROW_INTERACTION" | "MESSAGE_EXPANDED" | "MESSAGE_LOAD" | "CACHE_REINSPECTION" | "PAGE_RELOAD";
      selfViewEventId?: string;
      reconcileGmailIds?: boolean;
      reconcile_gmail_ids?: boolean;
      quotedRender?: boolean;
      pixelRender?: boolean;
    };
    const ts = body.timestamp && !Number.isNaN(Date.parse(body.timestamp))
      ? new Date(body.timestamp).toISOString()
      : new Date().toISOString();
    const ua = request.headers.get("User-Agent");
    const threadId = body.gmailThreadId ?? body.gmail_thread_id ?? null;
    const messageId = body.gmailMessageId ?? body.gmail_message_id ?? null;
    const eventId = body.selfViewEventId && validEventId(body.selfViewEventId)
      ? body.selfViewEventId
      : newId("evt");

    const result = await ctx.runMutation(internal.tracking.recordSelfView, {
      eventId,
      trackingId: id,
      timestamp: ts,
      userAgent: ua,
      gmailThreadId: typeof threadId === "string" ? threadId.slice(0, 128) : null,
      gmailMessageId: typeof messageId === "string" ? messageId.slice(0, 128) : null,
      ipHash: await hashIp(clientIp(request)),
      reconcileGmailIds: body.reconcileGmailIds === true || body.reconcile_gmail_ids === true,
      quotedRender: body.quotedRender === true,
      pixelRender: body.pixelRender === true,
      source: body.source,
    });

    if (!result.ok) return json({ error: "not_found" }, 404);
    return json({
      ok: true,
      claimId: result.claimId,
      claimExpiresAt: result.claimExpiresAt,
      open_count: result.openCount,
      openCount: result.openCount,
      click_count: result.clickCount,
      first_opened_at: result.firstOpenedAt,
      last_opened_at: result.lastOpenedAt,
      first_clicked_at: result.firstClickedAt,
      last_clicked_at: result.lastClickedAt,
      reclassifiedEventIds: result.reclassifiedEventIds,
    });
  }),
});

http.route({
  pathPrefix: "/api/emails/",
  method: "PATCH",
  handler: apiHttpAction(async (ctx, request) => {
    if (!authorized(request)) return json({ error: "unauthorized" }, 401);
    const id = decodeURIComponent(new URL(request.url).pathname.slice("/api/emails/".length));
    if (!validId(id) || id.includes("/")) return json({ error: "bad_id" }, 400);
    const body = (await request.json().catch(() => null)) as {
      gmail_thread_id?: unknown;
      gmail_message_id?: unknown;
      status?: unknown;
      sent_at?: unknown;
      subject?: unknown;
      sender?: unknown;
      recipients?: unknown;
      links?: unknown;
    } | null;
    if (!body || typeof body !== "object") return json({ error: "bad_request" }, 400);
    const patch: {
      trackingId: string;
      gmailThreadId?: string | null;
      gmailMessageId?: string | null;
      status?: "PENDING" | "SENT" | "CANCELLED" | "FAILED";
      sentAt?: string | null;
      subject?: string;
      sender?: string;
      recipients?: string[];
      links?: Array<{ clickId: string; destination: string }>;
    } = { trackingId: id };
    if ("gmail_thread_id" in body) {
      patch.gmailThreadId = body.gmail_thread_id == null ? null : String(body.gmail_thread_id).slice(0, 128);
    }
    if ("gmail_message_id" in body) {
      patch.gmailMessageId = body.gmail_message_id == null ? null : String(body.gmail_message_id).slice(0, 128);
    }
    if (body.status === "PENDING" || body.status === "SENT" || body.status === "CANCELLED" || body.status === "FAILED") {
      patch.status = body.status;
    }
    if ("sent_at" in body) patch.sentAt = body.sent_at == null ? null : String(body.sent_at).slice(0, 40);
    if (typeof body.subject === "string") patch.subject = body.subject.slice(0, 998);
    if (typeof body.sender === "string") patch.sender = body.sender.slice(0, 320);
    if (Array.isArray(body.recipients)) {
      patch.recipients = body.recipients.filter((item): item is string => typeof item === "string").slice(0, 100);
    }
    if (Array.isArray(body.links)) {
      const links: Array<{ clickId: string; destination: string }> = [];
      for (const link of body.links.slice(0, 50)) {
        if (!link || typeof link !== "object") continue;
        const clickId = "click_id" in link ? String((link as { click_id: unknown }).click_id) : "";
        const raw = "url" in link ? String((link as { url: unknown }).url) : "";
        const safe = safeRedirectUrl(raw);
        if (!/^[\w-]+$/.test(clickId) || !safe) continue;
        links.push({ clickId, destination: safe });
      }
      patch.links = links;
    }
    const row = await ctx.runMutation(internal.tracking.patchEmail, patch);
    if (!row) return json({ error: "not_found" }, 404);
    return json(emailJson(row));
  }),
});

export default http;
