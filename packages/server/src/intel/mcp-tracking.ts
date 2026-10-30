import { buildTrackingPixelHtml, shouldRewriteLink } from '@pigeonbox/tracking';
import { getEntitlements, hasCapability } from '../entitlements.js';
import { escapeHtml } from '../google/mime.js';
import { ApiError } from '../http.js';
import { sha256Hex } from '../platform/crypto.js';
import { assertSafeUrl } from '../platform/ssrf.js';
import type { IntelDeps } from './context.js';

export type SendTracking = { opens: boolean; links: boolean };

export const TRACKING_LIMITS = 'Opens and clicks are signals, not proof of reading. Blocked images, image caching, privacy proxies and security scanners limit tracking. Multiple recipients share one message’s signals.';

/** Validate before offering an approval and again at dispatch. Never silently send untracked. */
export async function requireSendTracking(deps: IntelDeps, userId: string, tracking: SendTracking): Promise<string | null> {
  if (!tracking.opens && !tracking.links) return null;
  const entitlements = await getEntitlements(userId, deps.store, deps.config);
  if (!hasCapability(entitlements, 'cloud_tracking')) throw new ApiError('entitlement_required', 'Tracked sending needs Cloud tracking.');
  let url: URL;
  try { url = assertSafeUrl(deps.config.intel.trackerBaseUrl ?? ''); }
  catch { throw new ApiError('not_configured', 'The hosted tracker is not configured. Nothing was sent.'); }
  if (url.protocol !== 'https:' || url.username || url.password || url.search || url.hash || url.pathname !== '/') {
    throw new ApiError('not_configured', 'Tracked sending needs a public HTTPS tracker origin. Nothing was sent.');
  }
  return url.origin;
}

/** Stable across job retries, separate from the approval ID, with no mailbox data in recipient URLs. */
export async function approvalTrackingId(userId: string, approvalId: string): Promise<string> {
  return `trk_${(await sha256Hex(`mcp-send:${userId}:${approvalId}`)).slice(0, 32)}`;
}

/** Render trusted plain text ourselves; the model never supplies HTML or a pixel. */
export async function prepareTrackedSend(deps: IntelDeps, input: {
  userId: string; approvalId: string; sender: string; recipients: string[]; subject: string; body: string; tracking: SendTracking;
}): Promise<{ trackingId: string; html: string } | null> {
  const origin = await requireSendTracking(deps, input.userId, input.tracking);
  if (!origin) return null;
  const trackingId = await approvalTrackingId(input.userId, input.approvalId);
  const store = deps.store.trackerStoreFor(input.userId);
  const existing = await store.getEmail(trackingId);
  if (!existing) {
    await store.insertEmail({
      tracking_id: trackingId, status: 'PENDING', subject: input.subject, sender: input.sender, recipients: input.recipients,
      gmail_thread_id: null, gmail_message_id: null, created_at: deps.now().toISOString(), sent_at: null,
      first_opened_at: null, last_opened_at: null, open_count: 0, first_clicked_at: null, last_clicked_at: null, click_count: 0,
    });
  }
  // Linkify HTTP(S) URLs without treating any of the approved prose as HTML.
  let html = '';
  let offset = 0;
  const links = new Map<string, string>();
  for (const match of input.body.matchAll(/https?:\/\/[^\s<>"']+/gi)) {
    const value = match[0];
    // Leave sentence punctuation and unbalanced closing parentheses outside the link.
    let url = value.replace(/[.,;:!?]+$/, '');
    while (url.endsWith(')') && (url.match(/\)/g)?.length ?? 0) > (url.match(/\(/g)?.length ?? 0)) url = url.slice(0, -1);
    html += escapeHtml(input.body.slice(offset, match.index));
    let href = url;
    if (shouldRewriteLink(url)) {
      if (input.tracking.links && !/unsubscribe|opt[-_]?out/i.test(new URL(url).pathname)) {
        let tracked = links.get(url);
        if (!tracked) {
          if (links.size >= 100) throw new ApiError('invalid_request', 'A tracked email can contain at most 100 distinct links.');
          const clickId = `clk_${(await sha256Hex(`${trackingId}\n${url}`)).slice(0, 32)}`;
          const matches = (link: Awaited<ReturnType<typeof store.getLink>>) => link?.tracking_id === trackingId && link.destination === url;
          const existingLink = await store.getLink(clickId);
          if (existingLink && !matches(existingLink)) throw new ApiError('conflict', 'That tracking link could not be prepared. Nothing was sent.');
          if (!existingLink) {
            try { await store.insertLink({ click_id: clickId, tracking_id: trackingId, destination: url }); }
            catch (error) { if (!matches(await store.getLink(clickId))) throw error; }
          }
          tracked = `${origin}/c/${clickId}`;
          links.set(url, tracked);
        }
        href = tracked;
      }
      html += `<a href="${escapeHtml(href)}">${escapeHtml(url)}</a>${escapeHtml(value.slice(url.length))}`;
    } else html += escapeHtml(value);
    offset = match.index + value.length;
  }
  html += escapeHtml(input.body.slice(offset));
  html = `<div style="white-space:pre-wrap">${html.replace(/\r?\n/g, '<br>')}</div>`;
  if (input.tracking.opens) html += buildTrackingPixelHtml(`${origin}/open/${trackingId}`);
  return { trackingId, html };
}
