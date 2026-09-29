import { v } from "convex/values";
import { internalMutation, internalQuery, type MutationCtx, type QueryCtx } from "./_generated/server";
import {
  decideTrackedOpen,
  deriveTrackingStats,
  detectOpenRequestSource,
  isSelfViewCorrelated,
  normalizeGmailId,
  normalizeUserAgentFamily,
  openEventMatchesSenderClaim,
  planJustSentProxy,
  planPageReloadProxy,
  selectSenderProxyClaim,
  senderFingerprintMatches,
} from "./openRequest";

async function getAllEventsForEmail(ctx: { db: QueryCtx["db"] | MutationCtx["db"] }, trackingId: string) {
  return await ctx.db
    .query("trackingEvents")
    .withIndex("by_trackingId", (q) => q.eq("trackingId", trackingId))
    .collect();
}

const emailArgs = {
  trackingId: v.string(),
  subject: v.string(),
  sender: v.string(),
  recipients: v.array(v.string()),
  gmailThreadId: v.union(v.string(), v.null()),
  gmailMessageId: v.union(v.string(), v.null()),
  status: v.optional(v.union(v.literal("PENDING"), v.literal("SENT"), v.literal("CANCELLED"), v.literal("FAILED"))),
  sentAt: v.union(v.string(), v.null()),
  createdAt: v.string(),
  links: v.array(v.object({ clickId: v.string(), destination: v.string() })),
};

export const createEmail = internalMutation({
  args: emailArgs,
  handler: async (ctx, args) => {
    await ctx.db.insert("trackedEmails", {
      trackingId: args.trackingId,
      subject: args.subject,
      sender: args.sender,
      recipients: args.recipients,
      gmailThreadId: normalizeGmailId(args.gmailThreadId),
      gmailMessageId: normalizeGmailId(args.gmailMessageId),
      status: args.status || (args.sentAt ? "SENT" : "PENDING"),
      sentAt: args.sentAt,
      firstOpenedAt: null,
      lastOpenedAt: null,
      openCount: 0,
      firstClickedAt: null,
      lastClickedAt: null,
      clickCount: 0,
      createdAt: args.createdAt,
    });
    for (const link of args.links) {
      await ctx.db.insert("trackedLinks", {
        clickId: link.clickId,
        trackingId: args.trackingId,
        destination: link.destination,
      });
    }
  },
});

export const getEmail = internalQuery({
  args: { trackingId: v.string() },
  handler: async (ctx, args) => {
    const rows = await ctx.db
      .query("trackedEmails")
      .withIndex("by_trackingId", (q) => q.eq("trackingId", args.trackingId))
      .take(5);
    return rows.sort((a, b) => b.openCount - a.openCount)[0] ?? null;
  },
});

export const listEmails = internalQuery({
  args: { limit: v.number() },
  handler: async (ctx, args) => {
    return await ctx.db.query("trackedEmails").order("desc").take(args.limit);
  },
});

export const patchEmail = internalMutation({
  args: {
    trackingId: v.string(),
    gmailThreadId: v.optional(v.union(v.string(), v.null())),
    gmailMessageId: v.optional(v.union(v.string(), v.null())),
    status: v.optional(v.union(v.literal("PENDING"), v.literal("SENT"), v.literal("CANCELLED"), v.literal("FAILED"))),
    sentAt: v.optional(v.union(v.string(), v.null())),
    subject: v.optional(v.string()),
    sender: v.optional(v.string()),
    recipients: v.optional(v.array(v.string())),
    links: v.optional(v.array(v.object({ clickId: v.string(), destination: v.string() }))),
  },
  handler: async (ctx, args) => {
    const rows = await ctx.db
      .query("trackedEmails")
      .withIndex("by_trackingId", (q) => q.eq("trackingId", args.trackingId))
      .take(1);
    const row = rows[0];
    if (!row) return null;
    const patch: {
      gmailThreadId?: string | null;
      gmailMessageId?: string | null;
      status?: "PENDING" | "SENT" | "CANCELLED" | "FAILED";
      sentAt?: string | null;
      subject?: string;
      sender?: string;
      recipients?: string[];
    } = {};
    if (args.gmailThreadId !== undefined) patch.gmailThreadId = normalizeGmailId(args.gmailThreadId);
    if (args.gmailMessageId !== undefined) patch.gmailMessageId = normalizeGmailId(args.gmailMessageId);
    if (args.status !== undefined) patch.status = args.status;
    if (args.sentAt !== undefined) patch.sentAt = args.sentAt;
    if (args.subject !== undefined) patch.subject = args.subject;
    if (args.sender !== undefined) patch.sender = args.sender;
    if (args.recipients !== undefined) patch.recipients = args.recipients;
    if (patch.status === "SENT" && patch.sentAt === undefined && !row.sentAt) {
      patch.sentAt = new Date().toISOString();
    }
    if (Object.keys(patch).length) await ctx.db.patch(row._id, patch);
    for (const link of args.links || []) {
      const existing = await ctx.db
        .query("trackedLinks")
        .withIndex("by_clickId", (q) => q.eq("clickId", link.clickId))
        .unique();
      if (!existing) {
        await ctx.db.insert("trackedLinks", {
          clickId: link.clickId,
          trackingId: args.trackingId,
          destination: link.destination,
        });
      }
    }
    return await ctx.db.get(row._id);
  },
});

export const listEvents = internalQuery({
  args: { trackingId: v.string() },
  handler: async (ctx, args) => {
    const events = await getAllEventsForEmail(ctx, args.trackingId);
    return events.sort((a, b) => (a.timestamp < b.timestamp ? 1 : -1));
  },
});

export const recentEvents = internalQuery({
  args: {},
  handler: async (ctx) => {
    return await ctx.db.query("trackingEvents").order("desc").take(50);
  },
});

export const getLink = internalQuery({
  args: { clickId: v.string() },
  handler: async (ctx, args) => {
    return await ctx.db
      .query("trackedLinks")
      .withIndex("by_clickId", (q) => q.eq("clickId", args.clickId))
      .unique();
  },
});

const eventArgs = {
  eventId: v.string(),
  trackingId: v.string(),
  type: v.union(v.literal("OPEN"), v.literal("CLICK"), v.literal("SELF_VIEW")),
  timestamp: v.string(),
  userAgent: v.union(v.string(), v.null()),
  ipHash: v.union(v.string(), v.null()),
  suspectedSelfOpen: v.boolean(),
  confidence: v.number(),
  classification: v.optional(
    v.union(
      v.literal("RECIPIENT_LIKELY"),
      v.literal("SELF_LIKELY"),
      v.literal("PROXY_LIKELY"),
      v.literal("MACHINE_LIKELY"),
      v.literal("UNKNOWN"),
    ),
  ),
  clickId: v.union(v.string(), v.null()),
  destination: v.union(v.string(), v.null()),
};

export const recomputeEmailStats = internalMutation({
  args: { trackingId: v.string() },
  handler: async (ctx, args) => {
    const emailRows = await ctx.db
      .query("trackedEmails")
      .withIndex("by_trackingId", (q) => q.eq("trackingId", args.trackingId))
      .take(1);
    const email = emailRows[0];
    if (!email) return null;

    const allEvents = await getAllEventsForEmail(ctx, args.trackingId);

    const stats = deriveTrackingStats(allEvents);
    await ctx.db.patch(email._id, {
      openCount: stats.openCount,
      firstOpenedAt: stats.firstOpenedAt,
      lastOpenedAt: stats.lastOpenedAt,
      clickCount: stats.clickCount,
      firstClickedAt: stats.firstClickedAt,
      lastClickedAt: stats.lastClickedAt,
    });
    return { ok: true, stats };
  },
});

const CLAIM_TTL_MS = 25_000;

export const recordSelfView = internalMutation({
  args: {
    eventId: v.string(),
    trackingId: v.string(),
    timestamp: v.string(),
    userAgent: v.union(v.string(), v.null()),
    gmailThreadId: v.optional(v.union(v.string(), v.null())),
    gmailMessageId: v.optional(v.union(v.string(), v.null())),
    ipHash: v.optional(v.union(v.string(), v.null())),
    reconcileGmailIds: v.optional(v.boolean()),
    quotedRender: v.optional(v.boolean()),
    source: v.optional(
      v.union(
        v.literal("ROW_INTERACTION"),
        v.literal("MESSAGE_EXPANDED"),
        v.literal("MESSAGE_LOAD"),
        v.literal("CACHE_REINSPECTION"),
        v.literal("PAGE_RELOAD"),
      ),
    ),
  },
  handler: async (ctx, args) => {
    const emailRows = await ctx.db
      .query("trackedEmails")
      .withIndex("by_trackingId", (q) => q.eq("trackingId", args.trackingId))
      .take(1);
    const email = emailRows[0];
    if (!email) return { ok: false };

    const normThread = normalizeGmailId(args.gmailThreadId);
    const normMessage = normalizeGmailId(args.gmailMessageId);
    const source = args.source || "MESSAGE_EXPANDED";
    const selfMs = Date.parse(args.timestamp) || Date.now();

    // Idempotency: check if eventId already recorded
    const existingEvt = await ctx.db
      .query("trackingEvents")
      .withIndex("by_trackingId", (q) => q.eq("trackingId", args.trackingId))
      .filter((q) => q.eq(q.field("eventId"), args.eventId))
      .take(1);
    if (existingEvt.length > 0) {
      const claims = await ctx.db
        .query("selfViewClaims")
        .withIndex("by_trackingId", (q) => q.eq("trackingId", args.trackingId))
        .collect();
      const byClaimId = claims.find((c) => c.claimId === `clm_${args.eventId}`);
      const activeClaim = claims.find(
        (c) => c.consumedByEventId === null && Date.parse(c.expiresAt) > selfMs,
      );
      const existingClaim = activeClaim || byClaimId;
      return {
        ok: true,
        claimId: existingClaim?.claimId || `clm_${args.eventId}`,
        claimExpiresAt: existingClaim?.expiresAt || new Date(selfMs + CLAIM_TTL_MS).toISOString(),
        openCount: email.openCount,
        reclassifiedEventIds: [],
      };
    }

    const reconcile = args.reconcileGmailIds === true;
    const senderIpHash = args.ipHash || null;
    const senderUaFamily = normalizeUserAgentFamily(args.userAgent);
    const emailPatch: { gmailThreadId?: string | null; gmailMessageId?: string | null } = {};
    if (normThread && (reconcile || !email.gmailThreadId) && email.gmailThreadId !== normThread) {
      emailPatch.gmailThreadId = normThread;
    }
    if (normMessage && (reconcile || !email.gmailMessageId) && email.gmailMessageId !== normMessage) {
      emailPatch.gmailMessageId = normMessage;
    }
    if (Object.keys(emailPatch).length > 0) {
      await ctx.db.patch(email._id, emailPatch);
    }

    // Active claim create or refresh
    const existingClaims = await ctx.db
      .query("selfViewClaims")
      .withIndex("by_trackingId", (q) => q.eq("trackingId", args.trackingId))
      .collect();
    const validClaims = existingClaims.filter(
      (c) => c.consumedByEventId === null && Date.parse(c.expiresAt) > selfMs,
    );
    validClaims.sort((a, b) => {
      const normA = normalizeGmailId(a.gmailMessageId);
      const normB = normalizeGmailId(b.gmailMessageId);
      if (normMessage) {
        const aExact = normA === normMessage ? 1 : 0;
        const bExact = normB === normMessage ? 1 : 0;
        if (aExact !== bExact) return bExact - aExact;
      }
      return (Date.parse(b.lastObservedAt) || 0) - (Date.parse(a.lastObservedAt) || 0);
    });
    const activeClaim = validClaims[0] ?? null;

    let claimId: string;
    let claimExpiresAt: string;

    if (activeClaim) {
      claimId = activeClaim.claimId;
      if (source === "CACHE_REINSPECTION") {
        claimExpiresAt = activeClaim.expiresAt;
        const patch: any = {};
        if (normMessage && (reconcile || !activeClaim.gmailMessageId)) patch.gmailMessageId = normMessage;
        if (normThread && (reconcile || !activeClaim.gmailThreadId)) patch.gmailThreadId = normThread;
        if (senderIpHash) patch.senderIpHash = senderIpHash;
        if (senderUaFamily) patch.senderUaFamily = senderUaFamily;
        if (Object.keys(patch).length > 0) await ctx.db.patch(activeClaim._id, patch);
      } else {
        claimExpiresAt = new Date(selfMs + CLAIM_TTL_MS).toISOString();
        const patch: any = {
          lastObservedAt: args.timestamp,
          expiresAt: claimExpiresAt,
          source,
        };
        if (normMessage && (reconcile || !activeClaim.gmailMessageId)) patch.gmailMessageId = normMessage;
        if (normThread && (reconcile || !activeClaim.gmailThreadId)) patch.gmailThreadId = normThread;
        if (senderIpHash) patch.senderIpHash = senderIpHash;
        if (senderUaFamily) patch.senderUaFamily = senderUaFamily;
        await ctx.db.patch(activeClaim._id, patch);
      }
    } else {
      claimId = args.eventId ? `clm_${args.eventId}` : `clm_${crypto.randomUUID().replace(/-/g, "")}`;
      claimExpiresAt = new Date(selfMs + CLAIM_TTL_MS).toISOString();
      const byClaimId = await ctx.db
        .query("selfViewClaims")
        .withIndex("by_claimId", (q) => q.eq("claimId", claimId))
        .take(1);
      const existingClaim = byClaimId[0];
      if (existingClaim) {
        await ctx.db.patch(existingClaim._id, {
          lastObservedAt: args.timestamp,
          expiresAt: claimExpiresAt,
          source,
          ...(senderIpHash ? { senderIpHash } : {}),
          ...(senderUaFamily ? { senderUaFamily } : {}),
          ...(normMessage && (reconcile || !existingClaim.gmailMessageId) ? { gmailMessageId: normMessage } : {}),
          ...(normThread && (reconcile || !existingClaim.gmailThreadId) ? { gmailThreadId: normThread } : {}),
        });
      } else {
        await ctx.db.insert("selfViewClaims", {
          claimId,
          trackingId: args.trackingId,
          gmailMessageId: normMessage,
          gmailThreadId: normThread,
          senderIpHash,
          senderUaFamily,
          firstObservedAt: args.timestamp,
          lastObservedAt: args.timestamp,
          expiresAt: claimExpiresAt,
          source,
          consumedByEventId: null,
          proxyConsumedByEventId: null,
          proxyConsumedAt: null,
          createdAt: new Date().toISOString(),
        });
      }
    }

    await ctx.db.insert("trackingEvents", {
      eventId: args.eventId,
      trackingId: args.trackingId,
      type: "SELF_VIEW",
      timestamp: args.timestamp,
      userAgent: args.userAgent,
      ipHash: senderIpHash,
      suspectedSelfOpen: true,
      confidence: 1,
      classification: "SELF_LIKELY",
      clickId: null,
      destination: null,
    });

    const events = await getAllEventsForEmail(ctx, args.trackingId);
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
        userAgent: evt.userAgent,
        ipHash: evt.ipHash,
        senderIpHash,
        senderUaFamily,
      });
      if (!matchesSender) continue;
      if (evt.classification !== "SELF_LIKELY") {
        await ctx.db.patch(evt._id, {
          classification: "SELF_LIKELY",
          suspectedSelfOpen: true,
          confidence: 1,
        });
        reclassifiedEventIds.push(evt.eventId);
      }
      if (evt.type === "OPEN" && !claimConsumed) {
        claimConsumed = true;
        const claimRows = await ctx.db
          .query("selfViewClaims")
          .withIndex("by_claimId", (q) => q.eq("claimId", claimId))
          .take(1);
        if (claimRows[0]) {
          await ctx.db.patch(claimRows[0]._id, {
            consumedByEventId: evt.eventId,
            consumedAt: evt.timestamp,
            consumedUa: evt.userAgent,
            consumedIpHash: evt.ipHash,
          });
        }
      }
    }

    if (source !== "PAGE_RELOAD" && source !== "ROW_INTERACTION") {
      const claimRows = await ctx.db
        .query("selfViewClaims")
        .withIndex("by_claimId", (q) => q.eq("claimId", claimId))
        .take(1);
      const claim = claimRows[0];
      const sentAtMs = email.sentAt ? Date.parse(email.sentAt) : null;
      const plan = claim
        ? planJustSentProxy(
            events.map((evt) => ({
              eventId: evt.eventId,
              type: evt.type,
              timestamp: evt.timestamp,
              classification: evt.classification,
              userAgent: evt.userAgent,
            })),
            {
              sentAtMs,
              selfViewMs: selfMs,
              proxySlotConsumed: Boolean(claim.proxyConsumedByEventId),
              quotedRender: args.quotedRender === true,
            },
          )
        : null;
      if (plan && claim) {
        for (const evt of events) {
          if (!plan.reclassifyEventIds.includes(evt.eventId) || evt.classification === "SELF_LIKELY") continue;
          await ctx.db.patch(evt._id, {
            classification: "SELF_LIKELY",
            suspectedSelfOpen: true,
            confidence: 1,
          });
          reclassifiedEventIds.push(evt.eventId);
        }
        await ctx.db.patch(claim._id, {
          proxyConsumedByEventId: plan.proxyConsumedByEventId,
          proxyConsumedAt: plan.proxyConsumedAt,
        });
      }
    }

    if (source === "PAGE_RELOAD") {
      const reloadEvents = await getAllEventsForEmail(ctx, args.trackingId);
      const claimRows = await ctx.db
        .query("selfViewClaims")
        .withIndex("by_claimId", (q) => q.eq("claimId", claimId))
        .take(1);
      const claim = claimRows[0];
      const observedProxy = {
        proxyConsumedByEventId: claim?.proxyConsumedByEventId ?? null,
        proxyConsumedAt: claim?.proxyConsumedAt ?? null,
      };
      const plan = planPageReloadProxy(
        reloadEvents.map((evt) => ({
          eventId: evt.eventId,
          type: evt.type,
          timestamp: evt.timestamp,
          classification: evt.classification,
          userAgent: evt.userAgent,
        })),
        selfMs,
        observedProxy,
      );
      if (plan.reclassifyEventId) {
        const evt = reloadEvents.find((row) => row.eventId === plan.reclassifyEventId);
        if (evt && evt.classification !== "SELF_LIKELY") {
          await ctx.db.patch(evt._id, {
            classification: "SELF_LIKELY",
            suspectedSelfOpen: true,
            confidence: 1,
          });
          reclassifiedEventIds.push(evt.eventId);
        }
      }
      if (plan.updateProxySlot && claim) {
        const slotStillMatches =
          (claim.proxyConsumedByEventId ?? null) === observedProxy.proxyConsumedByEventId &&
          (claim.proxyConsumedAt ?? null) === observedProxy.proxyConsumedAt;
        if (plan.proxyConsumedByEventId || slotStillMatches) {
          await ctx.db.patch(claim._id, {
            proxyConsumedByEventId: plan.proxyConsumedByEventId,
            proxyConsumedAt: plan.proxyConsumedAt,
          });
        }
      }
    }

    const allEvents = await getAllEventsForEmail(ctx, args.trackingId);
    const stats = deriveTrackingStats(allEvents);
    await ctx.db.patch(email._id, {
      openCount: stats.openCount,
      firstOpenedAt: stats.firstOpenedAt,
      lastOpenedAt: stats.lastOpenedAt,
      clickCount: stats.clickCount,
      firstClickedAt: stats.firstClickedAt,
      lastClickedAt: stats.lastClickedAt,
    });

    return {
      ok: true,
      claimId,
      claimExpiresAt,
      openCount: stats.openCount,
      reclassifiedEventIds,
    };
  },
});

export const recordOpenEvent = internalMutation({
  args: eventArgs,
  handler: async (ctx, args) => {
    const emailRows = await ctx.db
      .query("trackedEmails")
      .withIndex("by_trackingId", (q) => q.eq("trackingId", args.trackingId))
      .take(1);
    const email = emailRows[0];
    const now = Date.parse(args.timestamp) || Date.now();

    // Check for active unconsumed sender claim
    const claims = await ctx.db
      .query("selfViewClaims")
      .withIndex("by_trackingId", (q) => q.eq("trackingId", args.trackingId))
      .collect();

    const normEmailMsg = normalizeGmailId(email?.gmailMessageId);
    const validClaims = claims.filter((c) => {
      if (c.consumedByEventId !== null) return false;
      const exp = Date.parse(c.expiresAt);
      if (Number.isFinite(exp) && exp <= now) return false;
      return true;
    });

    validClaims.sort((a, b) => {
      const normA = normalizeGmailId(a.gmailMessageId);
      const normB = normalizeGmailId(b.gmailMessageId);
      if (normEmailMsg) {
        const aExact = normA === normEmailMsg ? 1 : 0;
        const bExact = normB === normEmailMsg ? 1 : 0;
        if (aExact !== bExact) return bExact - aExact;
      }
      return (Date.parse(b.lastObservedAt) || 0) - (Date.parse(a.lastObservedAt) || 0);
    });

    const activeClaim = validClaims[0] ?? null;
    const proxySelection = selectSenderProxyClaim(
      claims.map((claim) => ({
        ...claim,
        id: claim.claimId,
        gmailMessageId: claim.gmailMessageId,
        lastObservedAt: claim.lastObservedAt,
        expiresAt: claim.expiresAt,
        proxyConsumedByEventId: claim.proxyConsumedByEventId ?? null,
        proxyConsumedAt: claim.proxyConsumedAt ?? null,
      })),
      now,
      normEmailMsg,
    );

    const recentConsumed = claims.find((c) => {
      if (!c.consumedByEventId || !c.consumedAt) return false;
      const consumedMs = Date.parse(c.consumedAt);
      if (!Number.isFinite(consumedMs) || Math.abs(now - consumedMs) > 1000) return false;
      return senderFingerprintMatches(
        {
          senderIpHash: c.senderIpHash || c.consumedIpHash,
          senderUaFamily: c.senderUaFamily || normalizeUserAgentFamily(c.consumedUa),
        },
        { ipHash: args.ipHash, userAgent: args.userAgent },
      );
    });

    let selfViewTs: number | null = null;
    if (claims.length === 0) {
      const events = await getAllEventsForEmail(ctx, args.trackingId);
      const recentSelfView = events.find((e) => {
        if (e.type !== "SELF_VIEW") return false;
        const svMs = Date.parse(e.timestamp);
        return isSelfViewCorrelated(now, svMs);
      });
      selfViewTs = recentSelfView ? Date.parse(recentSelfView.timestamp) : null;
    }

    const sentAtMs = email?.sentAt ? Date.parse(email.sentAt) : null;
    const decision = decideTrackedOpen({
      eventTs: now,
      sentAt: sentAtMs != null && Number.isFinite(sentAtMs) ? sentAtMs : null,
      userAgent: args.userAgent,
      ipHash: args.ipHash,
      selfViewTs: activeClaim || recentConsumed ? null : selfViewTs,
      activeClaim: activeClaim
        ? { senderIpHash: activeClaim.senderIpHash, senderUaFamily: activeClaim.senderUaFamily }
        : null,
      recentConsumedMatches: Boolean(recentConsumed),
      proxySuppression: proxySelection?.mode ?? "none",
    });

    if (decision.consumeClaim && activeClaim) {
      await ctx.db.patch(activeClaim._id, {
        consumedByEventId: args.eventId,
        consumedAt: args.timestamp,
        consumedUa: args.userAgent,
        consumedIpHash: args.ipHash,
      });
    }
    if (decision.consumeProxySuppression && proxySelection) {
      await ctx.db.patch(proxySelection.claim._id, {
        proxyConsumedByEventId: args.eventId,
        proxyConsumedAt: args.timestamp,
      });
    }

    const finalClassification = decision.classification;
    const suspectedSelfOpen = decision.suspected;
    const confidence = decision.confidence;

    await ctx.db.insert("trackingEvents", {
      eventId: args.eventId,
      trackingId: args.trackingId,
      type: args.type,
      timestamp: args.timestamp,
      userAgent: args.userAgent,
      ipHash: args.ipHash,
      suspectedSelfOpen,
      confidence,
      classification: finalClassification,
      clickId: args.clickId,
      destination: args.destination,
    });

    if (email) {
      const allEvents = await getAllEventsForEmail(ctx, args.trackingId);
      const stats = deriveTrackingStats(allEvents);
      await ctx.db.patch(email._id, {
        openCount: stats.openCount,
        firstOpenedAt: stats.firstOpenedAt,
        lastOpenedAt: stats.lastOpenedAt,
        clickCount: stats.clickCount,
        firstClickedAt: stats.firstClickedAt,
        lastClickedAt: stats.lastClickedAt,
      });
    }
  },
});

export const recordClick = internalMutation({
  args: eventArgs,
  handler: async (ctx, args) => {
    await ctx.db.insert("trackingEvents", {
      eventId: args.eventId,
      trackingId: args.trackingId,
      type: args.type,
      timestamp: args.timestamp,
      userAgent: args.userAgent,
      ipHash: args.ipHash,
      suspectedSelfOpen: args.suspectedSelfOpen,
      confidence: args.confidence,
      classification: args.classification || "UNKNOWN",
      clickId: args.clickId,
      destination: args.destination,
    });

    const emailRows = await ctx.db
      .query("trackedEmails")
      .withIndex("by_trackingId", (q) => q.eq("trackingId", args.trackingId))
      .take(1);
    const email = emailRows[0];
    if (!email) return;

    const allEvents = await getAllEventsForEmail(ctx, args.trackingId);
    const stats = deriveTrackingStats(allEvents);
    await ctx.db.patch(email._id, {
      openCount: stats.openCount,
      firstOpenedAt: stats.firstOpenedAt,
      lastOpenedAt: stats.lastOpenedAt,
      clickCount: stats.clickCount,
      firstClickedAt: stats.firstClickedAt,
      lastClickedAt: stats.lastClickedAt,
    });
  },
});

/** Mark specific OPEN events as the sender's own views and recompute their emails. For manual repair from the dashboard or CLI. */
export const markOpensAsSelf = internalMutation({
  args: { eventIds: v.array(v.string()) },
  handler: async (ctx, args) => {
    const wanted = new Set(args.eventIds);
    const touched = new Set<string>();
    const marked: string[] = [];
    for (const evt of await ctx.db.query("trackingEvents").collect()) {
      if (!wanted.has(evt.eventId) || evt.type !== "OPEN") continue;
      touched.add(evt.trackingId);
      if (evt.classification === "SELF_LIKELY") continue;
      await ctx.db.patch(evt._id, { classification: "SELF_LIKELY", suspectedSelfOpen: true, confidence: 1 });
      marked.push(evt.eventId);
    }
    const openCounts: Record<string, number> = {};
    for (const trackingId of touched) {
      const email = (
        await ctx.db
          .query("trackedEmails")
          .withIndex("by_trackingId", (q) => q.eq("trackingId", trackingId))
          .take(1)
      )[0];
      if (!email) continue;
      const stats = deriveTrackingStats(await getAllEventsForEmail(ctx, trackingId));
      await ctx.db.patch(email._id, {
        openCount: stats.openCount,
        firstOpenedAt: stats.firstOpenedAt,
        lastOpenedAt: stats.lastOpenedAt,
        clickCount: stats.clickCount,
        firstClickedAt: stats.firstClickedAt,
        lastClickedAt: stats.lastClickedAt,
      });
      openCounts[trackingId] = stats.openCount;
    }
    return { marked, openCounts };
  },
});

/** Reclassify Gmail's delivery prefetch that was stored as a recipient open. */
export const repairDeliveryPrefetchOpens = internalMutation({
  args: {},
  handler: async (ctx) => {
    const events = await ctx.db.query("trackingEvents").collect();
    const touched = new Set<string>();
    for (const evt of events) {
      if (evt.type !== "OPEN") continue;
      const source = detectOpenRequestSource(evt.userAgent);
      if (source !== "scanner" && source !== "headless") continue;
      if (evt.classification === "MACHINE_LIKELY" && evt.suspectedSelfOpen) continue;
      await ctx.db.patch(evt._id, {
        classification: "MACHINE_LIKELY",
        suspectedSelfOpen: true,
        confidence: 0.9,
      });
      touched.add(evt.trackingId);
    }
    for (const trackingId of touched) {
      const emailRows = await ctx.db
        .query("trackedEmails")
        .withIndex("by_trackingId", (q) => q.eq("trackingId", trackingId))
        .take(1);
      const email = emailRows[0];
      if (!email) continue;
      const allEvents = await getAllEventsForEmail(ctx, trackingId);
      const stats = deriveTrackingStats(allEvents);
      await ctx.db.patch(email._id, {
        openCount: stats.openCount,
        firstOpenedAt: stats.firstOpenedAt,
        lastOpenedAt: stats.lastOpenedAt,
        clickCount: stats.clickCount,
        firstClickedAt: stats.firstClickedAt,
        lastClickedAt: stats.lastClickedAt,
      });
    }
    return { repaired: touched.size };
  },
});
