import { detectOpenRequestSource, normalizeUserAgentFamily } from '@pigeonbox/tracking';
import { z } from 'zod';
import { ApiError, json } from '../http.js';
import { resolveToken } from '../intel/api-tokens.js';
import { recordDocumentEvents, resolveLink, uploadDocument } from '../intel/documents.js';
import { acceptDocumentEvents, documentSessionClass, resumeDocumentSession, startDocumentSession, verifyDocumentPreview, type DocumentEventClass } from '../intel/document-sessions.js';
import { handleMcpMessage } from '../intel/mcp.js';
import { mcpResource, resolveOAuthClient } from '../intel/mcp-oauth.js';
import { unsubscribeByToken } from '../intel/sequences.js';
import { getEntitlements } from '../entitlements.js';
import { authenticate } from '../auth.js';
import { hmacSha256Hex } from '../platform/crypto.js';
import { ensureSqlProfile } from './profile.js';
import type { RequestContext } from './types.js';

/**
 * Non-JSON and public endpoints: the MCP server, the binary document upload,
 * the tracked-document viewer and one-click unsubscribe.
 */

const HTML_HEADERS = {
  'Content-Type': 'text/html; charset=utf-8',
  'Cache-Control': 'no-store',
  'Referrer-Policy': 'no-referrer',
  'X-Content-Type-Options': 'nosniff',
  'X-Frame-Options': 'DENY',
};

function escape(value: string): string {
  return value.replace(/[&<>"']/g, (char) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[char]!);
}

const NOTICE_CSP = "default-src 'none'; style-src 'self'; img-src 'self'; form-action 'self'; base-uri 'none'; frame-ancestors 'none'";

function page(title: string, body: string, options: { csp?: string; status?: number } = {}): Response {
  const html = `<!doctype html><html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width, initial-scale=1"><meta name="robots" content="noindex"><title>${escape(title)}</title><link rel="stylesheet" href="/viewer/viewer.css"></head><body>${body}</body></html>`;
  return new Response(html, { status: options.status ?? 200, headers: { ...HTML_HEADERS, 'Content-Security-Policy': options.csp ?? NOTICE_CSP } });
}

async function ipHash(ctx: RequestContext): Promise<string | null> {
  const ip = ctx.request.headers.get('CF-Connecting-IP');
  return ip ? (await hmacSha256Hex(ctx.deps.config.ipHashSalt, ip)).slice(0, 32) : null;
}

// ---------------------------------------------------------------------------
// MCP (Streamable HTTP, stateless JSON responses)
// ---------------------------------------------------------------------------

export async function handleMcp(ctx: RequestContext): Promise<Response> {
  if (ctx.request.method === 'GET') return new Response(null, { status: 405, headers: { Allow: 'POST' } });
  if (ctx.request.method !== 'POST') throw new ApiError('method_not_allowed', 'Method not allowed.');
  const header = ctx.request.headers.get('Authorization') ?? '';
  const token = header.startsWith('Bearer ') ? header.slice(7).trim() : '';
  const intel = ctx.intel();
  const client = token.startsWith('pbx_') ? await resolveToken(intel, token) : await resolveOAuthClient(ctx, token);
  const challenge = ctx.deps.config.auth.mcpOAuthEnabled ? `Bearer resource_metadata="${new URL('/.well-known/oauth-protected-resource/v1/mcp', mcpResource(ctx)).href}", scope="openid"` : 'Bearer realm="pigeonbox"';
  if (!client) return json({ error: 'unauthorized' }, 401, ctx.requestId, { 'WWW-Authenticate': challenge });
  const entitlements = await getEntitlements(client.userId, ctx.deps.store, ctx.deps.config);
  if (!entitlements.capabilities.includes('cloud_mcp')) return json({ error: 'entitlement_required' }, 402, ctx.requestId);
  const text = await ctx.request.text();
  if (text.length > 200_000) throw new ApiError('payload_too_large', 'The request is too large.');
  let body: unknown;
  try {
    body = JSON.parse(text);
  } catch {
    return json({ jsonrpc: '2.0', id: null, error: { code: -32700, message: 'Parse error' } }, 200, ctx.requestId);
  }
  const toolCtx = { deps: intel, userId: client.userId, scopes: client.scopes, clientId: client.clientId, requestId: ctx.requestId };
  const messages = Array.isArray(body) ? body.slice(0, 20) : [body];
  const replies = [];
  for (const message of messages) {
    const reply = await handleMcpMessage(toolCtx, message, ctx.deps.config.version);
    if (reply) replies.push(reply);
  }
  if (!replies.length) return new Response(null, { status: 202 });
  return json(Array.isArray(body) ? replies : replies[0], 200, ctx.requestId, { 'MCP-Protocol-Version': '2025-06-18' });
}

// ---------------------------------------------------------------------------
// Document upload (binary PUT)
// ---------------------------------------------------------------------------

export async function handleDocumentUpload(ctx: RequestContext, documentId: string): Promise<Response> {
  if (!/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(documentId)) throw new ApiError('not_found', 'Not found.');
  const user = await authenticate(ctx.request, ctx.deps.auth);
  const entitlements = await getEntitlements(user.userId, ctx.deps.store, ctx.deps.config);
  if (!entitlements.capabilities.includes('cloud_documents')) throw new ApiError('entitlement_required', 'Tracked documents need DOCUMENTS_BUCKET and DATABASE_URL on this server.');
  const intel = ctx.intel();
  await ensureSqlProfile(ctx.deps.intel!.database, intel, user, ctx.deps.config.auth.provider === 'dev' && !ctx.deps.config.production);
  const declared = Number(ctx.request.headers.get('Content-Length') ?? 0);
  if (declared > ctx.deps.config.intel.documentMaxBytes) throw new ApiError('payload_too_large', 'That file is too large.');
  if (!/^application\/pdf(?:\s*;|\s*$)/i.test(ctx.request.headers.get('Content-Type') ?? '')) throw new ApiError('invalid_request', 'Upload the PDF with Content-Type: application/pdf.');
  const bytes = await boundedBytes(ctx.request, ctx.deps.config.intel.documentMaxBytes);
  const document = await uploadDocument(intel, user.userId, documentId, bytes);
  return json({ document }, 200, ctx.requestId);
}

// ---------------------------------------------------------------------------
// Tracked-document viewer
// ---------------------------------------------------------------------------

const EventsSchema = z.object({
  sessionId: z.string().uuid(),
  sessionToken: z.string().regex(/^[A-Za-z0-9_-]{32}$/),
  events: z
    .array(
      z.object({
        id: z.string().regex(/^[A-Za-z0-9_-]{4,64}$/),
        kind: z.enum(['view_start', 'page_view', 'heartbeat', 'view_end']),
        page: z.number().int().min(1).max(500).nullable().optional(),
        visibleMs: z.number().int().min(0).max(30_000).optional(),
      }),
    )
    .min(1)
    .max(50),
});

/** Enforce actual streamed size even when Content-Length is missing or false. */
async function boundedBytes(request: Request, limit: number): Promise<Uint8Array<ArrayBuffer>> {
  const reader = request.body?.getReader();
  if (!reader) return new Uint8Array();
  const chunks: Uint8Array[] = [];
  let size = 0;
  try {
    for (;;) {
      const { done, value } = await reader.read();
      if (done) break;
      size += value.byteLength;
      if (size > limit) { await reader.cancel(); throw new ApiError('payload_too_large', 'That file or request is too large.'); }
      chunks.push(value);
    }
  } finally { reader.releaseLock(); }
  const bytes = new Uint8Array(size);
  let offset = 0;
  for (const chunk of chunks) { bytes.set(chunk, offset); offset += chunk.length; }
  return bytes;
}

async function viewerPayload(ctx: RequestContext): Promise<unknown> {
  if (!/^application\/json(?:\s*;|\s*$)/i.test(ctx.request.headers.get('Content-Type') ?? '')) throw new ApiError('invalid_request', 'Expected JSON.');
  const origin = ctx.request.headers.get('Origin');
  if ((origin && origin !== ctx.url.origin) || ctx.request.headers.get('Sec-Fetch-Site') === 'cross-site') throw new ApiError('forbidden', 'Open the document in its viewer.');
  try { return JSON.parse(new TextDecoder().decode(await boundedBytes(ctx.request, 20_000))); }
  catch (error) { if (error instanceof ApiError) throw error; throw new ApiError('invalid_request', 'Invalid viewer request.'); }
}

function eventClass(userAgent: string | null): 'RECIPIENT_LIKELY' | 'MACHINE_LIKELY' | 'UNKNOWN' {
  if (!userAgent) return 'UNKNOWN';
  const source = detectOpenRequestSource(userAgent);
  if (source === 'scanner' || source === 'headless' || /bot|crawler|spider|preview|scanner|slurp|curl|wget|python|go-http/i.test(userAgent)) return 'MACHINE_LIKELY';
  return source === 'browser_like' ? 'RECIPIENT_LIKELY' : 'UNKNOWN';
}

export async function handleDocumentViewer(ctx: RequestContext, rest: string): Promise<Response> {
  const [token, action, extra] = rest.split('/');
  if (extra !== undefined || (action && !['file', 'download', 'events', 'session'].includes(action))) throw new ApiError('not_found', 'Not found.');
  const intel = ctx.intel();
  const link = await resolveLink(intel, token ?? '');
  // Unknown, expired and revoked links look the same.
  if (!link) return page('Link unavailable', `<main class="notice"><h1>This link is not available</h1><p>It may have expired or been revoked by the sender.</p></main>`, { status: 404 });
  const ua = ctx.request.headers.get('User-Agent');
  let classification: DocumentEventClass = eventClass(ua);
  if (ctx.request.headers.has('Authorization')) {
    const identity = await authenticate(ctx.request, ctx.deps.auth);
    if (identity.userId === link.userId) classification = 'SELF_LIKELY';
  }
  const meta = { ipHash: await ipHash(ctx), uaFamily: normalizeUserAgentFamily(ua), eventClass: classification };
  const limitKey = `doc:${link.id}:${meta.ipHash ?? 'unknown'}`;
  const windowStart = new Date(Math.floor(ctx.now.getTime() / 60_000) * 60_000);
  if ((await ctx.deps.store.hitRateLimit(limitKey, windowStart)) > 120) return new Response('Too many requests', { status: 429, headers: { ...HTML_HEADERS, 'Retry-After': '60' } });

  if (action === 'session' && ctx.request.method === 'POST') {
    const parsed = z.object({ preview: z.string().max(2000).optional(), resume: z.string().regex(/^[A-Za-z0-9_-]{32}$/).optional() }).strict()
      .refine(body => !(body.preview && body.resume)).safeParse(await viewerPayload(ctx));
    if (!parsed.success) throw new ApiError('invalid_request', 'Invalid viewer session.');
    if (parsed.data.preview) { await verifyDocumentPreview(intel, link, parsed.data.preview); classification = 'SELF_LIKELY'; }
    if ((await ctx.deps.store.hitRateLimit(`${limitKey}:session`, windowStart)) > 10) throw new ApiError('rate_limited', 'Please wait before opening again.', { retryAfter: 60 });
    if (parsed.data.resume) return json(await resumeDocumentSession(intel, link, parsed.data.resume), 200, ctx.requestId);
    return json(await startDocumentSession(intel, link, classification), 200, ctx.requestId);
  }

  if (!action && ctx.request.method === 'GET') {
    const watermark = link.watermark ? escape(link.recipient_email ?? 'Shared privately') : '';
    return page(
      link.title,
      `<main class="viewer" data-token="${escape(token!)}" data-filename="${escape(link.filename)}" data-watermark="${watermark}" data-download="${link.allow_download ? '1' : '0'}" data-pages="${link.page_count ?? ''}">
        <header class="bar" aria-label="PDF controls">
          <strong title="${escape(link.title)}">${escape(link.title)}</strong>
          <div class="page-controls"><button id="previous-page" type="button" aria-label="Previous page" disabled>‹</button><label><input id="page-number" type="number" min="1" value="1" aria-label="Page" disabled><span id="page-count"> / —</span></label><button id="next-page" type="button" aria-label="Next page" disabled>›</button></div>
          <div class="zoom-controls"><button id="zoom-out" type="button" aria-label="Zoom out" disabled>−</button><select id="zoom" aria-label="Zoom" disabled><option value="auto">Automatic</option><option value="fit-width">Fit width</option><option value="fit-page">Fit page</option>${[50,75,100,125,150,200,300].map(value => `<option value="${value}">${value}%</option>`).join('')}</select><button id="zoom-in" type="button" aria-label="Zoom in" disabled>+</button></div>
          <div class="file-controls">${link.allow_download ? `<button id="native-pdf" type="button" title="Open the original PDF in your browser’s viewer to print" aria-label="Open PDF for printing" disabled>Print</button><a class="download" href="/d/${escape(token!)}/download" aria-disabled="true">Download</a>` : ''}
          <details class="document-info"><summary aria-label="Document information" title="Document information">ⓘ</summary><div><strong>Shared with PigeonBox</strong><p>The sender can see opens, pages on screen, and time while this viewer is visible and focused. Downloads are recorded separately.</p><p>Anyone with this link can open it. A recipient label does not verify identity. Screenshots, printouts, and activity outside this viewer are not measured.</p><p id="tracking-status" role="status">Activity starts after a page is displayed.</p></div></details></div>
        </header>
        <div class="viewer-feedback"><p id="viewer-status" role="status" aria-live="polite">Loading PDF…</p><button id="retry-document" type="button" hidden>Try again</button></div>
        <div id="pages" class="pages" aria-label="Document pages" aria-busy="true"></div>
        <noscript><p class="status">Enable JavaScript to preview this PDF.</p></noscript>
      </main><script type="module" src="/viewer/viewer.js?v=4"></script>`,
      // pdf.js needs WebAssembly (image decoders) and a same-origin worker; nothing else is loosened.
      { csp: "default-src 'none'; script-src 'self' 'wasm-unsafe-eval'; style-src 'self'; img-src 'self' data: blob:; font-src 'self' data:; connect-src 'self'; worker-src 'self' blob:; form-action 'none'; base-uri 'none'; frame-ancestors 'none'" },
    );
  }
  if ((action === 'file' || action === 'download') && ctx.request.method === 'GET') {
    if (action === 'download' && !link.allow_download) return new Response('Downloads are turned off for this document.', { status: 403, headers: HTML_HEADERS });
    const credential = ctx.request.headers.get('X-Document-Session');
    const session = credential ? await documentSessionClass(intel, link, credential) : null;
    if (session) meta.eventClass = session.eventClass;
    const bytes = await intel.storage?.get(link.storage_path);
    if (!bytes || !await resolveLink(intel, token!)) return new Response('Not found', { status: 404, headers: HTML_HEADERS });
    // Direct fetches are not evidence of a human download. Only the interactive
    // viewer's session can attribute a download to a likely recipient.
    if (!session && meta.eventClass === 'RECIPIENT_LIKELY') meta.eventClass = 'UNKNOWN';
    await recordDocumentEvents(intel, { id: link.id, userId: link.userId, documentId: link.documentId }, [{ id: `${action}-${crypto.randomUUID()}`, kind: action === 'download' ? 'download' : 'file_fetch' }], { sessionId: session?.id ?? 'fetch', ...meta });
    return new Response(bytes, {
      headers: {
        'Content-Type': 'application/pdf',
        'Cache-Control': 'no-store',
        'X-Content-Type-Options': 'nosniff',
        'Content-Disposition': `${action === 'download' ? 'attachment' : 'inline'}; filename="${link.filename.replace(/["\\]/g, '')}"`,
        'Referrer-Policy': 'no-referrer',
        'Content-Security-Policy': "sandbox; default-src 'none'",
        'X-Frame-Options': 'DENY',
        'X-Robots-Tag': 'noindex, nofollow, noarchive',
      },
    });
  }
  if (action === 'events' && ctx.request.method === 'POST') {
    const parsed = EventsSchema.safeParse(await viewerPayload(ctx));
    if (!parsed.success) throw new ApiError('invalid_request', 'Invalid events.');
    const stored = await acceptDocumentEvents(intel, link, parsed.data, meta);
    return json({ stored }, 200, ctx.requestId);
  }
  throw new ApiError('not_found', 'Not found.');
}

// ---------------------------------------------------------------------------
// One-click unsubscribe (RFC 8058). GET only shows a confirmation, so link
// scanners cannot unsubscribe people by prefetching.
// ---------------------------------------------------------------------------

export async function handleUnsubscribe(ctx: RequestContext, token: string): Promise<Response> {
  if (ctx.request.method === 'GET') {
    return page(
      'Unsubscribe',
      `<main class="notice"><h1>Unsubscribe</h1><p>Stop receiving these emails from this sender?</p><form method="post" action="/u/${escape(token)}"><button type="submit">Unsubscribe</button></form></main>`,
    );
  }
  if (ctx.request.method !== 'POST') throw new ApiError('method_not_allowed', 'Method not allowed.');
  const ok = await unsubscribeByToken(ctx.intel(), token);
  return ok
    ? page('Unsubscribed', `<main class="notice"><h1>You are unsubscribed</h1><p>You will not receive more emails from this sequence or sender.</p></main>`)
    : page('Link not recognized', `<main class="notice"><h1>Link not recognized</h1><p>This unsubscribe link is invalid.</p></main>`, { status: 404 });
}
