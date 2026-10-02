import { z } from 'zod';
import { detectOpenRequestSource, isCountableOpenEvent, normalizeGmailId } from './lifecycle.js';
import { extractTrackingIdFromCandidateUrl } from './pixel-identity.js';

/**
 * Tracking client — talks ONLY to the tracker worker.
 * Mailbox contents must NEVER be sent here.
 * Send mail through Gmail normally; tracking injects pixel/links only.
 */

export const TrackedEmailStatusSchema = z.enum(['PENDING', 'SENT', 'CANCELLED', 'FAILED']);
export type TrackedEmailStatus = z.infer<typeof TrackedEmailStatusSchema>;

export const TrackedEmailSchema = z.object({
  tracking_id: z.string().min(8),
  subject: z.string(),
  sender: z.string(),
  recipients: z.array(z.string()),
  gmail_thread_id: z.string().nullable().optional(),
  gmail_message_id: z.string().nullable().optional(),
  status: TrackedEmailStatusSchema.optional(),
  created_at: z.string().nullable().optional(),
  sent_at: z.string().nullable(),
  first_opened_at: z.string().nullable().optional(),
  last_opened_at: z.string().nullable().optional(),
  open_count: z.number().default(0),
  first_clicked_at: z.string().nullable().optional(),
  last_clicked_at: z.string().nullable().optional(),
  click_count: z.number().default(0),
});
export type TrackedEmail = z.infer<typeof TrackedEmailSchema>;

export const TrackingEventSchema = z.object({
  id: z.string(),
  tracking_id: z.string(),
  type: z.enum(['OPEN', 'CLICK', 'SELF_VIEW']),
  timestamp: z.string(),
  user_agent: z.string().optional(),
  ip_hash: z.string().optional(),
  suspected_self_open: z.boolean().optional(),
  confidence: z.number().optional(),
  classification: z.enum(['RECIPIENT_LIKELY', 'SELF_LIKELY', 'PROXY_LIKELY', 'MACHINE_LIKELY', 'UNKNOWN']).optional(),
  click_id: z.string().optional(),
  destination: z.string().optional(),
});
export type TrackingEvent = z.infer<typeof TrackingEventSchema>;

export type CreateTrackedEmailInput = {
  subject: string;
  sender: string;
  recipients: string[];
  gmail_thread_id?: string;
  gmail_message_id?: string;
  links?: Array<{ url: string }>;
};

export type CreateTrackedEmailResult = {
  tracking_id: string;
  pixel_url: string;
  status?: TrackedEmailStatus;
  created_at?: string;
  sent_at?: string | null;
  rewritten_links: Array<{ click_id: string; original: string; tracked_url: string }>;
};

export type TrackedEmailPatch = {
  gmail_thread_id?: string | null;
  gmail_message_id?: string | null;
  status?: TrackedEmailStatus;
  sent_at?: string | null;
  subject?: string;
  sender?: string;
  recipients?: string[];
  links?: Array<{ click_id: string; url: string }>;
};

/**
 * How the client authenticates to a tracker's management API. A self-hosted
 * tracker uses a fixed personal token. PigeonBox Cloud passes its session's
 * token provider, so an expired access token is refreshed and the request
 * retried once, through the same session that the rest of Cloud uses.
 */
export type TrackerCredential =
  | string
  | {
      get(): Promise<string | null>;
      refresh?(): Promise<string | null>;
    };

/** A tracker answered with a non-2xx status. The message keeps the historic `tracking <op> failed: <status>` shape. */
export class TrackingHttpError extends Error {
  constructor(
    readonly status: number,
    readonly operation: string,
  ) {
    super(`tracking ${operation} failed: ${status}`);
    this.name = 'TrackingHttpError';
  }
}

/** Default bound on one management request. Sending mail never waits longer than this for tracking. */
export const TRACKER_REQUEST_TIMEOUT_MS = 10_000;

export class TrackingClient {
  constructor(
    private readonly baseUrl: string,
    private readonly credential: TrackerCredential,
    private readonly options: { timeoutMs?: number; fetcher?: typeof fetch } = {},
  ) {}

  private async currentToken(): Promise<string | null> {
    return typeof this.credential === 'string' ? this.credential : this.credential.get();
  }

  /**
   * One management request. A 401 is retried once with a refreshed token: the
   * tracker rejects it before doing any work, so the retry cannot duplicate a
   * tracked email or link. Network failures are not retried for that reason.
   */
  private async request<T>(operation: string, path: string, init: { method?: string; body?: unknown } = {}): Promise<T> {
    const fetcher = this.options.fetcher ?? fetch;
    const send = (token: string) =>
      fetcher(`${trim(this.baseUrl)}${path}`, {
        method: init.method ?? 'GET',
        headers: {
          ...(init.body !== undefined ? { 'Content-Type': 'application/json' } : {}),
          Authorization: `Bearer ${token}`,
        },
        ...(init.body !== undefined ? { body: JSON.stringify(init.body) } : {}),
        signal: AbortSignal.timeout(this.options.timeoutMs ?? TRACKER_REQUEST_TIMEOUT_MS),
      });
    const token = await this.currentToken();
    if (!token) throw new TrackingHttpError(401, operation);
    let res = await send(token);
    if (res.status === 401 && typeof this.credential !== 'string' && this.credential.refresh) {
      const next = await this.credential.refresh();
      if (next) res = await send(next);
    }
    if (!res.ok) throw new TrackingHttpError(res.status, operation);
    return res.json() as Promise<T>;
  }

  async createEmail(input: CreateTrackedEmailInput): Promise<CreateTrackedEmailResult> {
    return this.request('create', '/api/emails', { method: 'POST', body: input });
  }

  async getEmail(id: string): Promise<TrackedEmail> {
    return this.request('get', `/api/emails/${encodeURIComponent(id)}`);
  }

  async getEvents(id: string): Promise<TrackingEvent[]> {
    return this.request('events', `/api/emails/${encodeURIComponent(id)}/events`);
  }

  async getRecentEvents(): Promise<TrackingEvent[]> {
    return this.request('recent', '/api/events/recent');
  }

  async listEmails(limit = 100): Promise<TrackedEmail[]> {
    return this.request('list', `/api/emails?limit=${encodeURIComponent(String(limit))}`);
  }

  async linkEmail(id: string, patch: TrackedEmailPatch): Promise<TrackedEmail> {
    return this.request('link', `/api/emails/${encodeURIComponent(id)}`, { method: 'PATCH', body: patch });
  }

  async recordSelfView(
    id: string,
    data?: {
      timestamp?: string;
      gmailThreadId?: string | null;
      gmailMessageId?: string | null;
      source?: 'ROW_INTERACTION' | 'MESSAGE_EXPANDED' | 'MESSAGE_LOAD' | 'CACHE_REINSPECTION' | 'PAGE_RELOAD';
      selfViewEventId?: string;
      reconcileGmailIds?: boolean;
      /** The pixel was rendered inside another message's quote, not its own sent message. */
      quotedRender?: boolean;
    },
  ): Promise<{
    ok: boolean;
    claimId?: string;
    claimExpiresAt?: string;
    open_count?: number;
    openCount?: number;
    click_count?: number;
    first_opened_at?: string | null;
    last_opened_at?: string | null;
    first_clicked_at?: string | null;
    last_clicked_at?: string | null;
    reclassifiedEventIds?: string[];
  }> {
    return this.request('self-view', `/api/emails/${encodeURIComponent(id)}/self-view`, { method: 'POST', body: data || {} });
  }
}

/** `scheme://host[:port]` of a tracker URL, or null when it is not http(s). */
export function trackerOriginOf(url: string | null | undefined): string | null {
  if (!url) return null;
  try {
    const parsed = new URL(url);
    return parsed.protocol === 'http:' || parsed.protocol === 'https:' ? parsed.origin : null;
  } catch {
    return null;
  }
}

/**
 * 1×1 image clients actually fetch.
 * display:none and zero-size images are skipped by Gmail and several other clients.
 */
export function buildTrackingPixelHtml(pixelUrl: string): string {
  const src = escapeAttr(pixelUrl);
  // A table keeps the image when Gmail rewrites the message. Zero-size and display:none are not fetched.
  return `<table role="presentation" width="1" height="1" cellpadding="0" cellspacing="0" border="0" style="width:1px;height:1px;border:0;"><tr><td style="width:1px;height:1px;line-height:0;"><img src="${src}" width="1" height="1" alt="" border="0" referrerpolicy="no-referrer" style="display:block;width:1px;height:1px;border:0;outline:none;" /></td></tr></table>`;
}

/**
 * Remove tracking pixels from earlier messages that a reply or forward quotes.
 * Left in, they load every time anyone (including the sender) views the new
 * message and count as opens of the old one.
 */
export function stripForeignTrackingPixels(html: string, keepPixelUrl?: string | null): { html: string; removed: number } {
  const keepId = keepPixelUrl ? extractTrackingIdFromCandidateUrl(keepPixelUrl) : null;
  let removed = 0;
  const next = html.replace(/<img\b[^>]*>/gi, (tag) => {
    for (const match of tag.matchAll(/\s(?:src|data-src)\s*=\s*(["'])(.*?)\1/gi)) {
      const id = extractTrackingIdFromCandidateUrl(decodeHtmlAttr(match[2] || ''));
      if (id && id !== keepId) {
        removed += 1;
        return '';
      }
    }
    return tag;
  });
  return { html: next, removed };
}

export function appendTrackingPixel(html: string, pixelUrl: string): string {
  if (!pixelUrl || html.includes(pixelUrl)) return html;
  const tag = buildTrackingPixelHtml(pixelUrl);
  if (/<\/body>/i.test(html)) return html.replace(/<\/body>/i, `${tag}</body>`);
  return `${html}${tag}`;
}

/** Href values that should be wrapped, as they appear in the HTML attribute. */
export function extractHttpLinks(html: string): string[] {
  const found: string[] = [];
  const seen = new Set<string>();
  for (const match of html.matchAll(/href=(["'])(.*?)\1/gi)) {
    const raw = match[2] || '';
    if (!shouldRewriteLink(decodeHtmlAttr(raw))) continue;
    if (seen.has(raw)) continue;
    seen.add(raw);
    found.push(raw);
  }
  return found;
}

export function pairRewrittenLinks(
  htmlHrefs: string[],
  rewritten: Array<{ original: string; tracked_url: string }>,
): Map<string, string> {
  const map = new Map<string, string>();
  for (const raw of htmlHrefs) {
    const decoded = decodeHtmlAttr(raw);
    const match = rewritten.find((link) => urlsEqual(link.original, decoded));
    if (match?.tracked_url) map.set(raw, match.tracked_url);
  }
  return map;
}

export function applyTrackingToOutgoingHtml(
  html: string,
  opts: {
    pixelUrl?: string | null;
    linkMap?: Map<string, string>;
    trackOpens: boolean;
    trackLinks: boolean;
  },
): string {
  return transformOutgoingHtml(html, opts).html;
}

export type OutgoingTransform = {
  html: string;
  linksRewritten: number;
  pixelPresent: boolean;
};

/**
 * Deterministic rewrite of the HTML Gmail is about to send.
 * Safe to run more than once: an existing pixel and already-tracked links stay put.
 */
export function transformOutgoingHtml(
  html: string,
  opts: {
    pixelUrl?: string | null;
    linkMap?: Map<string, string>;
    trackOpens: boolean;
    trackLinks: boolean;
    allocateTrackedUrl?: (originalUrl: string) => string | null;
  },
): OutgoingTransform {
  const linkMap = opts.linkMap || new Map<string, string>();
  const ownOrigin = trackerOriginOf(opts.pixelUrl);
  let linksRewritten = 0;
  let next = stripForeignTrackingPixels(html, opts.pixelUrl).html;
  if (opts.trackLinks) {
    next = next.replace(/href=(["'])(.*?)\1/gi, (full, quote: string, raw: string) => {
      const decoded = decodeHtmlAttr(raw);
      if (!shouldRewriteLink(decoded)) return full;
      if (ownOrigin && trackerOriginOf(decoded) === ownOrigin) return full;
      const tracked = linkMap.get(raw) || linkMap.get(decoded) || opts.allocateTrackedUrl?.(decoded) || null;
      if (!tracked || tracked === decoded || tracked === raw) return full;
      linkMap.set(raw, tracked);
      linkMap.set(decoded, tracked);
      linksRewritten += 1;
      return `href=${quote}${escapeAttr(tracked)}${quote}`;
    });
  }
  if (opts.trackOpens && opts.pixelUrl) next = appendTrackingPixel(next, opts.pixelUrl);
  const pixelPresent = Boolean(opts.pixelUrl && next.includes(opts.pixelUrl));
  return { html: next, linksRewritten, pixelPresent };
}

/** Stable click id so a second pass of the same outgoing HTML does not allocate a new link. */
export function stableClickId(trackingId: string, destination: string): string {
  const input = `${trackingId}\n${canonicalDestination(destination)}`;
  let a = 2166136261;
  let b = 2166136261 ^ input.length;
  for (let i = 0; i < input.length; i += 1) {
    const code = input.charCodeAt(i);
    a ^= code;
    a = Math.imul(a, 16777619);
    b ^= code + i;
    b = Math.imul(b, 2246822519);
  }
  const hex = ((a >>> 0).toString(16).padStart(8, '0') + (b >>> 0).toString(16).padStart(8, '0')).slice(0, 16);
  return `clk_${hex}`;
}

export function trackedClickUrl(origin: string, clickId: string): string {
  return `${origin.replace(/\/$/, '')}/c/${clickId}`;
}

export function clickIdFromTrackedUrl(url: string): string | null {
  try {
    const match = new URL(url).pathname.match(/\/c\/([A-Za-z0-9_-]+)/);
    return match?.[1] || null;
  } catch {
    return null;
  }
}

export type TrackedEmailSummary = {
  trackingId: string;
  status?: TrackedEmailStatus;
  subject: string;
  sender: string;
  recipients: string[];
  gmailThreadId: string | null;
  gmailMessageId: string | null;
  createdAt?: string | null;
  sentAt: string | null;
  firstOpenedAt: string | null;
  lastOpenedAt: string | null;
  openCount: number;
  clickCount: number;
  firstClickedAt?: string | null;
  lastClickedAt?: string | null;
  notifyIfNoReply: boolean;
  /**
   * Which tracker issued this tracking ID: `cloud:<API origin>` for PigeonBox
   * Cloud (stable when the hosted tracker changes hostname) or `local:<tracker
   * origin>` for a self-hosted tracker. Management calls for the email go only
   * to a tracker with the same issuer, so a Cloud ID never reaches a Local
   * tracker, or the reverse, after the run mode changes.
   */
  issuer?: string | null;
};

export function summaryFromRemote(
  row: {
    tracking_id: string;
    subject: string;
    sender: string;
    recipients?: unknown;
    status?: string | null;
    gmail_thread_id?: string | null;
    gmail_message_id?: string | null;
    created_at?: string | null;
    sent_at?: string | null;
    first_opened_at?: string | null;
    last_opened_at?: string | null;
    open_count?: number;
    click_count?: number;
    first_clicked_at?: string | null;
    last_clicked_at?: string | null;
  },
  local?: TrackedEmailSummary | null,
  issuer?: string | null,
): TrackedEmailSummary {
  const remoteStatus = asStatus(row.status, row.sent_at);
  const localAhead = local?.status === 'SENT' && remoteStatus === 'PENDING';
  const status: TrackedEmailStatus = localAhead ? 'SENT' : remoteStatus;
  const sentAt = status === 'PENDING' ? null : row.sent_at || local?.sentAt || null;
  const recipients = asStringList(row.recipients);
  const openCount = localAhead
    ? (local?.openCount || 0)
    : (typeof row.open_count === 'number' ? row.open_count : (local?.openCount || 0));
  const clickCount = localAhead
    ? (local?.clickCount || 0)
    : (typeof row.click_count === 'number' ? row.click_count : (local?.clickCount || 0));
  return {
    trackingId: row.tracking_id,
    status,
    subject: row.subject || local?.subject || '',
    sender: row.sender || local?.sender || '',
    recipients: recipients.length ? recipients : local?.recipients || [],
    gmailThreadId: row.gmail_thread_id || local?.gmailThreadId || null,
    gmailMessageId: row.gmail_message_id || local?.gmailMessageId || null,
    createdAt: row.created_at || local?.createdAt || null,
    sentAt,
    firstOpenedAt: openCount === 0 ? null : (row.first_opened_at || local?.firstOpenedAt || null),
    lastOpenedAt: openCount === 0 ? null : (row.last_opened_at || local?.lastOpenedAt || null),
    openCount,
    clickCount,
    firstClickedAt: clickCount === 0 ? null : (row.first_clicked_at || local?.firstClickedAt || null),
    lastClickedAt: clickCount === 0 ? null : (row.last_clicked_at || local?.lastClickedAt || null),
    notifyIfNoReply: local?.notifyIfNoReply ?? false,
    issuer: issuer ?? local?.issuer ?? null,
  };
}

export type TrackingRowQuery = {
  threadIds: string[];
  subject: string;
  emails: string[];
  messageId?: string | null;
  messageIds?: string[];
};

/** Latest tracked send that belongs to this Gmail row or message. */
export function matchTrackedEmail(
  row: TrackingRowQuery,
  emails: TrackedEmailSummary[],
): TrackedEmailSummary | null {
  const delivered = emails.filter(isDeliveredTrackedEmail);

  // 1. Exact Gmail message ID match (strongest identity)
  const candidateMsgIds = [
    ...(row.messageId ? [row.messageId] : []),
    ...(row.messageIds || []),
  ]
    .map(normalizeGmailId)
    .filter(Boolean);

  if (candidateMsgIds.length > 0) {
    const msgIdSet = new Set(candidateMsgIds);
    const byMessage = delivered.find((email) => {
      const emailMsgId = normalizeGmailId(email.gmailMessageId);
      return emailMsgId && msgIdSet.has(emailMsgId);
    });
    if (byMessage) return byMessage;
  }

  // 2. Exact Gmail thread ID + latest tracked send
  const ids = new Set(row.threadIds.map((id) => id.trim()).filter(Boolean));
  if (ids.size > 0) {
    const byThread = delivered.filter((email) => threadIdsMatch(email.gmailThreadId, ids));
    if (byThread.length > 0) return mostRecent(byThread);
  }

  // 3. Careful subject/recipient fallback
  const subject = normalizeSubject(row.subject);
  if (!subject) return null;
  const rowEmails = new Set(row.emails.map(normalizeEmail).filter(Boolean));
  let candidates = delivered.filter((email) => subjectsMatch(row.subject, email.subject));
  if (rowEmails.size > 0) {
    candidates = candidates.filter((email) =>
      email.recipients.some((recipient) => rowEmails.has(normalizeEmail(recipient))),
    );
  }
  if (candidates.length === 1) return candidates[0];
  if (rowEmails.size === 0) return null;
  const sameThread = candidates.filter(
    (email) => !email.gmailThreadId || ids.size === 0 || threadIdsMatch(email.gmailThreadId, ids),
  );
  return sameThread.length > 0 ? mostRecent(sameThread) : null;
}

/**
 * Recent open events can be ahead of the email row when the counter write failed.
 * Only genuine recipient opens count. Never resurrect false/reclassified opens.
 */
export function applyRecentOpens(
  emails: TrackedEmailSummary[],
  events: Array<{
    tracking_id: string;
    type: string;
    timestamp: string;
    classification?: string;
    suspected_self_open?: boolean;
    user_agent?: string | null;
  }>,
): TrackedEmailSummary[] {
  const byId = new Map(emails.map((email) => [email.trackingId, email]));
  const opens = new Map<string, { count: number; first: string; last: string; lastValidMs: number }>();
  const sorted = [...events].sort((a, b) => (a.timestamp > b.timestamp ? 1 : a.timestamp < b.timestamp ? -1 : 0));

  for (const event of sorted) {
    if (event.type !== 'OPEN' || !event.tracking_id || !event.timestamp) continue;
    if (!isCountableOpenEvent(event)) continue;

    const evtMs = Date.parse(event.timestamp);
    const slot = opens.get(event.tracking_id) || { count: 0, first: event.timestamp, last: event.timestamp, lastValidMs: 0 };
    if (slot.lastValidMs && Number.isFinite(evtMs) && evtMs >= slot.lastValidMs && evtMs - slot.lastValidMs < 800) {
      continue;
    }
    slot.count += 1;
    slot.lastValidMs = evtMs;
    if (event.timestamp < slot.first) slot.first = event.timestamp;
    if (event.timestamp > slot.last) slot.last = event.timestamp;
    opens.set(event.tracking_id, slot);
  }

  for (const [id, slot] of opens) {
    const current = byId.get(id);
    if (!current || slot.count <= current.openCount) continue;
    byId.set(id, {
      ...current,
      openCount: slot.count,
      firstOpenedAt: current.firstOpenedAt || slot.first,
      lastOpenedAt: !current.lastOpenedAt || slot.last > current.lastOpenedAt ? slot.last : current.lastOpenedAt,
    });
  }
  return [...byId.values()];
}

/** Desktop alerts follow the same countable-open rules as applyRecentOpens. */
export function isNotifiableTrackingEvent(event: {
  type: string;
  classification?: string | null;
  suspected_self_open?: boolean;
  user_agent?: string | null;
}): boolean {
  if (event.type === 'SELF_VIEW' || event.suspected_self_open) return false;
  if (
    event.classification === 'SELF_LIKELY' ||
    event.classification === 'MACHINE_LIKELY' ||
    event.classification === 'UNKNOWN'
  ) {
    return false;
  }
  if (event.type === 'OPEN') return isCountableOpenEvent(event);
  if (event.type === 'CLICK') return event.classification !== 'PROXY_LIKELY';
  return false;
}

/**
 * The mail app behind a pixel fetch, for display only. Null when the user agent
 * says nothing useful (a generic browser, or none at all).
 */
export function describeOpenClient(userAgent?: string | null): string | null {
  const ua = (userAgent || '').trim();
  if (!ua) return null;
  if (detectOpenRequestSource(ua) === 'google_image_proxy' || /\bgmail\//i.test(ua)) return 'Gmail';
  if (/outlook|ms-office|microsoft office|\bmsoffice\b/i.test(ua)) return 'Outlook';
  if (/yahoo/i.test(ua)) return 'Yahoo Mail';
  if (/thunderbird/i.test(ua)) return 'Thunderbird';
  if (/samsung email/i.test(ua)) return 'Samsung Email';
  if (/iphone|ipad|ipod/i.test(ua)) return /safari\//i.test(ua) ? null : 'Apple Mail on iOS';
  if (/macintosh/i.test(ua) && /applewebkit/i.test(ua) && !/(safari|chrome|firefox|edg)\//i.test(ua)) return 'Apple Mail';
  return null;
}

/**
 * Desktop alert text for a tracked open or click. A pixel fetch shows that the
 * message was rendered somewhere, not that a person read it, and a message
 * sent to several people shares one pixel. The alert therefore names the
 * email, never a reader.
 */
export function describeTrackingNotification(
  event: { type: string; user_agent?: string | null },
  email: { subject?: string | null } | null | undefined,
  count = 1,
): { title: string; message: string } {
  const subject = email?.subject?.trim() || 'your email';
  const times = count > 1 ? ` (${count} times)` : '';
  if (event.type === 'CLICK') {
    return { title: 'PigeonBox', message: `A link was clicked in “${subject}”${times}` };
  }
  return { title: 'PigeonBox', message: `Open detected for “${subject}”${times}` };
}

function threadIdsMatch(stored: string | null, ids: Set<string>): boolean {
  if (!stored) return false;
  const needle = canonicalThreadId(stored);
  if (!needle) return false;
  for (const id of ids) {
    if (canonicalThreadId(id) === needle) return true;
  }
  return false;
}

function canonicalThreadId(id: string): string {
  return id.trim().replace(/^#/, '').replace(/^(msg-a:|msg-f:|thread-a:|thread-f:)/i, '');
}

/** Sent rows append the snippet or a category chip onto the subject. */
export function subjectsMatch(rowSubject: string, emailSubject: string): boolean {
  const row = normalizeSubject(rowSubject);
  const email = normalizeSubject(emailSubject);
  if (!row || !email) return false;
  if (row === email) return true;
  if (email.length >= 4 && (row.startsWith(`${email} `) || row.startsWith(`${email}-`) || row.startsWith(`${email}—`))) {
    return true;
  }
  if (row.length >= 4 && (email.startsWith(`${row} `) || email.startsWith(`${row}-`))) return true;
  return false;
}

export function normalizeSubject(subject: string): string {
  let next = subject.replace(/\s+/g, ' ').trim();
  let prev = '';
  while (next !== prev) {
    prev = next;
    next = next.replace(/^(re|fw|fwd)\s*:\s*/i, '').trim();
  }
  const withoutChip = next.replace(/(respond|waiting|fyi|notifications|promotions|news)\s*·?$/i, '').trim();
  return (withoutChip || next).toLowerCase();
}

export function normalizeEmail(email: string): string {
  return email.trim().toLowerCase().replace(/^mailto:/i, '');
}

export function isLoopbackTracker(baseUrl: string): boolean {
  try {
    const host = new URL(baseUrl).hostname.replace(/^\[|\]$/g, '');
    return host === 'localhost' || host === '127.0.0.1' || host === '::1';
  } catch {
    return false;
  }
}

/**
 * Origin pattern for chrome.permissions.request. Every tracker, including one on
 * this computer, is an optional host permission requested when the user saves it.
 */
export function trackerPermissionOrigin(baseUrl: string): string | null {
  try {
    const url = new URL(baseUrl);
    if (url.protocol !== 'http:' && url.protocol !== 'https:') return null;
    // Plain HTTP is only for a tracker on this computer.
    if (url.protocol === 'http:' && !isLoopbackTracker(baseUrl)) return null;
    return `${url.origin}/*`;
  } catch {
    return null;
  }
}

export function trackingStatusLine(opts: {
  trackingEnabled: boolean;
  trackerBaseUrl: string;
  personalApiToken: string;
}): string | null {
  if (!opts.trackingEnabled) return null;
  if (!opts.trackerBaseUrl.trim() || !opts.personalApiToken.trim()) {
    return 'Open tracking is off until a tracker URL and token are saved in Settings.';
  }
  if (isLoopbackTracker(opts.trackerBaseUrl)) {
    return 'Open tracking is on. This tracker is on your computer, so recipient opens will not show until Settings uses a public URL.';
  }
  return 'Open tracking is on. A check sits beside tracked mail and turns green after someone opens it.';
}

export type TrackingStatusCopy = {
  opened: boolean;
  emphasis: string | null;
  rest: string;
  headline: string;
  detail: string;
  countLabel: string;
  /** Short label beside the subject. The inbox row stays icon-only. */
  markLabel: string;
  /** Set when one pixel was shared by several recipients, so activity cannot name a reader. */
  attributionNote: string | null;
  loopbackWarning: string | null;
};

/**
 * Status copy for a tracked email. Wording reports detections ("Open
 * detected"), never that a named person read the message: image fetches do
 * not prove a human read it, and one pixel is shared by every recipient.
 */
export function describeTrackingStatus(
  email: TrackedEmailSummary,
  opts?: { now?: number; trackerBaseUrl?: string },
): TrackingStatusCopy {
  const now = opts?.now ?? Date.now();
  const opened = email.openCount > 0;
  const clicked = email.clickCount > 0;
  const engaged = opened || clicked;
  const openedWhen = email.lastOpenedAt || email.firstOpenedAt;
  const clickedWhen = email.lastClickedAt || email.firstClickedAt;
  const openAgo = openedWhen ? formatAgo(openedWhen, now) : 'recently';
  const clickAgo = clickedWhen ? formatAgo(clickedWhen, now) : 'recently';
  const delivered = isDeliveredTrackedEmail(email);

  const headline = opened
    ? `Open detected ${openAgo}.`
    : clicked
      ? `Link clicked ${clickAgo}.`
      : delivered
        ? 'No open detected yet.'
        : 'Not sent yet.';

  const detail =
    opened && email.firstOpenedAt && email.sentAt
      ? `First open detected ${formatAfterSend(email.sentAt, email.firstOpenedAt)}.`
      : opened
        ? `Last open detected ${openAgo}.`
        : clicked
          ? 'A link click was detected.'
          : delivered
            ? 'Tracking is on for this email.'
            : 'Tracking starts when Gmail sends this email.';

  let countLabel = delivered ? 'No open detected yet' : 'Not sent yet';
  if (opened && clicked) {
    countLabel = `${openCountLabel(email.openCount)} · ${clickCountLabel(email.clickCount)}`;
  } else if (opened) {
    countLabel = openCountLabel(email.openCount);
  } else if (clicked) {
    countLabel = clickCountLabel(email.clickCount);
  }

  const loopback = Boolean(opts?.trackerBaseUrl && isLoopbackTracker(opts.trackerBaseUrl));
  const markLabel = opened
    ? email.openCount > 1
      ? `Opened ${email.openCount}×`
      : 'Opened'
    : clicked
      ? 'Link clicked'
      : delivered
        ? 'Sent'
        : 'Pending';
  return {
    opened: engaged,
    emphasis: null,
    rest: headline,
    headline,
    detail,
    countLabel,
    markLabel,
    attributionNote:
      engaged && email.recipients.length > 1
        ? `Sent to ${email.recipients.length} people in one email, so PigeonBox cannot tell which of them opened it.`
        : null,
    loopbackWarning: loopback
      ? 'Gmail loads tracking images from Google’s servers, which cannot reach this computer. Use a public tracker URL in Settings to record recipient opens.'
      : null,
  };
}

export function formatAgo(fromIso: string, now: number): string {
  const delta = Math.max(0, now - Date.parse(fromIso));
  return formatSpan(delta, true);
}

export function formatAfterSend(sentIso: string, openedIso: string): string {
  const delta = Math.max(0, Date.parse(openedIso) - Date.parse(sentIso));
  if (!Number.isFinite(delta)) return 'after you sent';
  if (delta < 60_000) return 'less than a minute after you sent';
  if (delta < 2 * 60_000) return 'a minute after you sent';
  if (delta < 60 * 60_000) return `${Math.floor(delta / 60_000)} minutes after you sent`;
  if (delta < 2 * 60 * 60_000) return 'an hour after you sent';
  if (delta < 24 * 60 * 60_000) return `${Math.floor(delta / (60 * 60_000))} hours after you sent`;
  if (delta < 2 * 24 * 60 * 60_000) return 'a day after you sent';
  return `${Math.floor(delta / (24 * 60 * 60_000))} days after you sent`;
}

/**
 * Rewrite only http(s) links. Never mailto, tel, javascript, anchors,
 * tracking URLs, or Gmail internal links.
 */
export function shouldRewriteLink(href: string): boolean {
  const h = href.trim();
  if (!/^https?:\/\//i.test(h)) return false;
  let url: URL;
  try {
    url = new URL(h);
  } catch {
    return false;
  }
  if (!url.hostname || url.username || url.password) return false;
  if (/(^|\.)mail\.google\.com$/i.test(url.hostname)) return false;
  // Pixel and click URLs of any PigeonBox-compatible tracker (Worker, Convex, Cloud).
  if (isTrackerPath(url.pathname)) return false;
  return true;
}

/** `/open/trk_…` and `/c/clk_…`, the only paths trackers issue for recipients. */
export function isTrackerPath(pathname: string): boolean {
  return /\/open\/trk_[\w-]+\/?$/i.test(pathname) || /\/c\/clk_[\w-]+\/?$/i.test(pathname);
}

export function rewriteHtmlLinks(
  html: string,
  map: Map<string, string>,
): string {
  return html.replace(/href=(["'])(.*?)\1/gi, (full, quote: string, url: string) => {
    if (!shouldRewriteLink(url)) return full;
    const tracked = map.get(url);
    if (!tracked) return full;
    return `href=${quote}${tracked}${quote}`;
  });
}

export function formatSentTrackingBadge(email: {
  open_count: number;
  click_count: number;
}): string {
  if (email.open_count <= 0 && email.click_count <= 0) {
    return '✓ tracking enabled · no open detected';
  }
  if (email.click_count > 0) {
    return `✓✓ ${email.open_count} · Link ${email.click_count}`;
  }
  return `✓✓ open detected${email.open_count > 1 ? ` (${email.open_count})` : ''}`;
}

export function isLikelySelfOpen(opts: {
  eventTs: number;
  sentAt: number;
  userAgent?: string;
  senderActiveRecently?: boolean;
  ipHashMatchesSender?: boolean;
}): { suspected: boolean; confidence: number } {
  const delta = opts.eventTs - opts.sentAt;
  let score = 0;
  if (delta >= 0 && delta < 5_000) score += 0.5;
  if (opts.senderActiveRecently) score += 0.3;
  if (opts.ipHashMatchesSender) score += 0.3;
  if (opts.userAgent && /Chrome-Lighthouse|Headless/i.test(opts.userAgent)) score += 0.2;
  return { suspected: score >= 0.5, confidence: Math.min(1, score) };
}

function trim(s: string): string {
  return s.replace(/\/$/, '');
}
function escapeAttr(s: string): string {
  return s.replace(/&/g, '&amp;').replace(/"/g, '&quot;').replace(/</g, '&lt;');
}
/** The URL an `href` attribute value stands for (`&amp;` and friends decoded). */
export function decodeHtmlAttribute(s: string): string {
  return decodeHtmlAttr(s);
}
function decodeHtmlAttr(s: string): string {
  return s
    .replace(/&amp;/g, '&')
    .replace(/&quot;/g, '"')
    .replace(/&#39;/g, "'")
    .replace(/&lt;/g, '<')
    .replace(/&gt;/g, '>');
}
function urlsEqual(a: string, b: string): boolean {
  try {
    return new URL(a).toString() === new URL(b).toString();
  } catch {
    return a === b;
  }
}
function asStringList(value: unknown): string[] {
  if (!Array.isArray(value)) return [];
  return value.filter((item): item is string => typeof item === 'string' && item.trim().length > 0);
}
function mostRecent(emails: TrackedEmailSummary[]): TrackedEmailSummary {
  return [...emails].sort((a, b) => {
    const aTime = sentStamp(a);
    const bTime = sentStamp(b);
    if (aTime !== bTime) {
      return aTime < bTime ? 1 : -1;
    }
    return b.trackingId.localeCompare(a.trackingId);
  })[0];
}

function sentStamp(email: TrackedEmailSummary): string {
  return email.sentAt || email.createdAt || '';
}

export function isDeliveredTrackedEmail(email: TrackedEmailSummary): boolean {
  if (email.status === 'CANCELLED' || email.status === 'FAILED' || email.status === 'PENDING') return false;
  if (email.status === 'SENT') return true;
  return Boolean(email.sentAt);
}

function asStatus(status: string | null | undefined, sentAt: string | null | undefined): TrackedEmailStatus {
  if (status === 'PENDING' || status === 'SENT' || status === 'CANCELLED' || status === 'FAILED') return status;
  return sentAt ? 'SENT' : 'PENDING';
}

function canonicalDestination(url: string): string {
  try {
    const parsed = new URL(url);
    parsed.hash = '';
    return parsed.toString();
  } catch {
    return url.trim();
  }
}

function formatSpan(delta: number, ago: boolean): string {
  if (!Number.isFinite(delta)) return ago ? 'recently' : 'after you sent';
  if (delta < 60_000) return ago ? 'less than a minute ago' : 'less than a minute';
  if (delta < 2 * 60_000) return ago ? 'a minute ago' : 'a minute';
  if (delta < 60 * 60_000) {
    const minutes = Math.floor(delta / 60_000);
    return ago ? `${minutes} minutes ago` : `${minutes} minutes`;
  }
  if (delta < 2 * 60 * 60_000) return ago ? 'an hour ago' : 'an hour';
  if (delta < 24 * 60 * 60_000) {
    const hours = Math.floor(delta / (60 * 60_000));
    return ago ? `${hours} hours ago` : `${hours} hours`;
  }
  if (delta < 2 * 24 * 60 * 60_000) return ago ? 'yesterday' : 'a day';
  const days = Math.floor(delta / (24 * 60 * 60_000));
  return ago ? `${days} days ago` : `${days} days`;
}
function openCountLabel(count: number): string {
  if (count === 1) return 'Opened once';
  return `Opened ${count} times`;
}
function clickCountLabel(count: number): string {
  if (count === 1) return 'Link clicked once';
  return `Link clicked ${count} times`;
}

export {
  CLAIM_TTL_MS,
  SENDER_PROXY_BURST_MS,
  classifyClickEvent,
  classifyOpenEvent,
  decideTrackedOpen,
  deriveTrackingStats,
  deriveTrackingTimeline,
  detectOpenRequestSource,
  isCountableOpenEvent,
  formatTrackingReport,
  inspectTrackedMime,
  isSelfViewCorrelated,
  normalizeGmailId,
  normalizeUserAgentFamily,
  openEventMatchesSenderClaim,
  PAGE_RELOAD_PROXY_WINDOW_MS,
  planPageReloadProxy,
  pageReloadProxyReclassifications,
  probeTracker,
  selectSenderProxyClaim,
  senderProxySuppressionMode,
  SELF_VIEW_POST_WINDOW_MS,
  SELF_VIEW_PRE_WINDOW_MS,
  senderFingerprintMatches,
  TRACKER_PROTOCOL_VERSION,
  TRACKER_REQUIRED_FEATURES,
  TRACKER_SUPPORTED_FEATURES,
  trackerHealthLabel,
  uaFamiliesCompatible,
} from './lifecycle.js';
export type {
  ClickClassification,
  ClickVerdict,
  DerivedTrackingStats,
  MimeTrackingInspection,
  OpenClassification,
  OpenRequestSource,
  OpenVerdict,
  PageReloadProxyEvent,
  PageReloadProxyPlan,
  ProxyClaimCandidate,
  ProxySuppressionMode,
  SelfViewClaim,
  SelfViewSource,
  SenderFingerprint,
  TrackerHealthStatus,
  TrackerProbe,
  TrackingDiagnosticsReport,
  TrackingEventLike,
  TrackingPixelEventDiagnostic,
  TrackingSelfViewDiagnostic,
  TrackingSendReport,
  TrackingTimelineEntry,
} from './lifecycle.js';
export {
  decodeBounded,
  extractTrackingIdFromCandidateUrl,
  extractQuotedTrackingIdsFromMessageBody,
  extractTrackingIdFromMessageBody,
  extractTrackingIdsFromMessageBody,
} from './pixel-identity.js';
export type { PixelCandidateElement, PixelCandidateRoot, TrackerBase } from './pixel-identity.js';

export { SelfViewAttribution, type PendingSelfView, type AttributionSnapshot } from './attribution';
