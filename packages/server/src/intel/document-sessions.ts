import { iso, num, one } from '../db/sql.js';
import { ApiError } from '../http.js';
import { randomToken, sha256Hex } from '../platform/crypto.js';
import type { IntelDeps } from './context.js';
import { resolveLink, viewerOrigin } from './documents.js';

export type ViewerLink = NonNullable<Awaited<ReturnType<typeof resolveLink>>>;
export type DocumentEventClass = 'RECIPIENT_LIKELY' | 'SELF_LIKELY' | 'MACHINE_LIKELY' | 'UNKNOWN';
export type ViewerEvent = { id: string; kind: 'view_start' | 'page_view' | 'heartbeat' | 'view_end'; page?: number | null; visibleMs?: number };
type SessionRow = { id: string; event_class: DocumentEventClass; created_at: unknown; expires_at: unknown; visible_ms: number; started: boolean };

/** Gmail may resolve an owned share URL without generating document activity. */
export async function previewDocumentByToken(deps: IntelDeps, userId: string, token: string): Promise<string | null> {
  const hash = await sha256Hex(token);
  const row = await deps.db.asUser(userId, tx => one<{ id: string }>(tx, `select r.id from public.document_recipients r join public.documents d on d.id = r.document_id
    where r.token_hash = $1 and r.revoked_at is null and (r.expires_at is null or r.expires_at > $2::timestamptz) and d.status = 'ready'`, [hash, deps.now()]));
  return row ? createDocumentPreview(deps, userId, row.id) : null;
}

/** Short-lived, link-bound preview proof. The fragment is removed before any fetch. */
export async function createDocumentPreview(deps: IntelDeps, userId: string, linkId: string): Promise<string> {
  const row = await deps.db.asUser(userId, tx => one<{ token_key_id: string; token_iv: string; token_ciphertext: string }>(tx,
    `select r.token_key_id, r.token_iv, r.token_ciphertext from public.document_recipients r join public.documents d on d.id = r.document_id
     where r.id = $1::uuid and r.revoked_at is null and (r.expires_at is null or r.expires_at > $2::timestamptz) and d.status = 'ready'`, [linkId, deps.now()]));
  if (!row) throw new ApiError('not_found', 'That link is not available.');
  const token = await deps.box.open({ keyId: row.token_key_id, iv: row.token_iv, ciphertext: row.token_ciphertext }, { purpose: 'document_token', userId, recordId: linkId });
  const proof = await deps.box.seal(JSON.stringify({ expires: deps.now().getTime() + 5 * 60_000 }), { purpose: 'document_preview', userId, recordId: linkId });
  const encoded = btoa(JSON.stringify(proof)).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
  return `${viewerOrigin(deps)}/d/${token}#preview=${encoded}`;
}

export async function verifyDocumentPreview(deps: IntelDeps, link: ViewerLink, proof: string): Promise<void> {
  try {
    const sealed = JSON.parse(atob(proof.replace(/-/g, '+').replace(/_/g, '/')));
    const body = JSON.parse(await deps.box.open(sealed, { purpose: 'document_preview', userId: link.userId, recordId: link.id }));
    if (typeof body.expires !== 'number' || body.expires <= deps.now().getTime()) throw new Error('expired');
  } catch {
    throw new ApiError('forbidden', 'This preview expired. Open a new preview from Documents.');
  }
}

export async function startDocumentSession(deps: IntelDeps, link: ViewerLink, eventClass: DocumentEventClass) {
  const id = crypto.randomUUID();
  const token = randomToken(24);
  const now = deps.now();
  const expiresAt = new Date(now.getTime() + 8 * 3_600_000);
  await deps.db.asUser(link.userId, async tx => {
    const valid = await one(tx, `select r.id from public.document_recipients r join public.documents d on d.id = r.document_id
      where r.id = $1::uuid and r.revoked_at is null and (r.expires_at is null or r.expires_at > $2::timestamptz) and d.status = 'ready' for share of r, d`, [link.id, now]);
    if (!valid) throw new ApiError('not_found', 'That link is not available.');
    await tx.query(`delete from public.document_viewer_sessions where expires_at <= $1::timestamptz`, [now]);
    await tx.query(`insert into public.document_viewer_sessions (id, user_id, document_id, recipient_id, token_hash, event_class, created_at, expires_at)
      values ($1::uuid, $2::uuid, $3::uuid, $4::uuid, $5, $6, $7::timestamptz, $8::timestamptz)`,
      [id, link.userId, link.documentId, link.id, await sha256Hex(token), eventClass, now, expiresAt]);
  });
  return { sessionId: id, sessionToken: token, preview: eventClass === 'SELF_LIKELY', expiresAt: expiresAt.toISOString() };
}

export async function documentSessionClass(deps: IntelDeps, link: ViewerLink, credential: string): Promise<{ id: string; eventClass: DocumentEventClass; expiresAt: string }> {
  const hash = credential ? await sha256Hex(credential) : '';
  const row = await deps.db.asUser(link.userId, tx => one<SessionRow>(tx,
    `select * from public.document_viewer_sessions where recipient_id = $1::uuid and token_hash = $2 and expires_at > $3::timestamptz`,
    [link.id, hash, deps.now()]));
  if (!row) throw new ApiError('forbidden', 'Open the document again to continue.');
  return { id: row.id, eventClass: row.event_class, expiresAt: iso(row.expires_at) };
}

/** A tab reload keeps the issued classification; it never reclassifies a sender. */
export async function resumeDocumentSession(deps: IntelDeps, link: ViewerLink, credential: string) {
  const session = await documentSessionClass(deps, link, credential);
  return { sessionId: session.id, sessionToken: credential, preview: session.eventClass === 'SELF_LIKELY', expiresAt: session.expiresAt };
}

/** Lock the session so parallel batches cannot spend the same time budget. */
export async function acceptDocumentEvents(deps: IntelDeps, link: ViewerLink, input: { sessionId: string; sessionToken: string; events: ViewerEvent[] }, meta: { ipHash: string | null; uaFamily: string | null }): Promise<number> {
  const hash = await sha256Hex(input.sessionToken);
  return deps.db.asUser(link.userId, async tx => {
    const session = await one<SessionRow>(tx, `select * from public.document_viewer_sessions where id = $1::uuid and recipient_id = $2::uuid and token_hash = $3 and expires_at > $4::timestamptz for update`, [input.sessionId, link.id, hash, deps.now()]);
    if (!session) throw new ApiError('forbidden', 'Open the document again to continue.');
    // Recheck policy inside the write transaction; revoke/delete may have
    // happened while the request body or storage was being read.
    const valid = await one<{ page_count: number | null }>(tx, `select d.page_count from public.document_recipients r join public.documents d on d.id = r.document_id
      where r.id = $1::uuid and r.revoked_at is null and (r.expires_at is null or r.expires_at > $2::timestamptz) and d.status = 'ready' for share of r, d`, [link.id, deps.now()]);
    if (!valid) throw new ApiError('not_found', 'That link is not available.');
    let stored = 0;
    let visibleMs = num(session.visible_ms);
    let started = session.started;
    const budget = Math.max(0, deps.now().getTime() - Date.parse(iso(session.created_at))) + 2_000;
    for (const event of input.events) {
      if (await one(tx, `select id from public.document_events where recipient_id = $1::uuid and client_event_id = $2`, [link.id, `${session.id}:${event.id}`])) continue;
      const ms = event.visibleMs ?? 0;
      if (event.page !== undefined && event.page !== null && event.page > (valid.page_count ?? 500)) throw new ApiError('invalid_request', 'Invalid page.');
      if (event.kind === 'view_start') {
        if (event.page != null || ms !== 0) throw new ApiError('invalid_request', 'Invalid view start.');
        if (started) continue;
      } else {
        if (!started) throw new ApiError('invalid_request', 'The viewer has not opened.');
        if (event.kind === 'page_view' && (event.page == null || ms !== 0)) throw new ApiError('invalid_request', 'Invalid page observation.');
        if (ms > 0 && event.page == null) throw new ApiError('invalid_request', 'Visible time needs a page.');
        if (event.kind !== 'page_view' && event.page != null && !await one(tx, `select id from public.document_events where recipient_id = $1::uuid and session_id = $2 and kind = 'page_view' and page = $3`, [link.id, session.id, event.page])) throw new ApiError('invalid_request', 'That page has not been observed.');
      }
      if (visibleMs + ms > budget) throw new ApiError('invalid_request', 'Visible time exceeds the session duration.');
      const rows = await tx.query(`insert into public.document_events (user_id, document_id, recipient_id, session_id, client_event_id, kind, page, visible_ms, at, ip_hash, ua_family, event_class)
        values ($1::uuid, $2::uuid, $3::uuid, $4, $5, $6, $7, $8, $9::timestamptz, $10, $11, $12) on conflict do nothing returning id`,
        [link.userId, link.documentId, link.id, session.id, `${session.id}:${event.id}`, event.kind, event.page ?? null, ms, deps.now(), meta.ipHash, meta.uaFamily, session.event_class]);
      if (rows.length) {
        stored += 1;
        visibleMs += ms;
        if (event.kind === 'view_start') started = true;
      }
    }
    await tx.query(`update public.document_viewer_sessions set visible_ms = $2, started = $3 where id = $1::uuid`, [session.id, visibleMs, started]);
    return stored;
  });
}
