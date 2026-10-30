import type { DocumentLink, DocumentSummary } from '@pigeonbox/api-contract';
import { PDFDocument } from 'pdf-lib';
import { iso, isoOrNull, num, one, type SqlExecutor } from '../db/sql.js';
import { ApiError } from '../http.js';
import { randomToken, sha256Hex } from '../platform/crypto.js';
import { recordAudit } from './audit.js';
import type { IntelDeps } from './context.js';

/**
 * Tracked documents. Files live in a private bucket under the owner's ID and
 * are only served through a valid, unexpired, unrevoked per-recipient link.
 * Analytics report what the PigeonBox viewer observed and say how precise
 * each number is; a plain file fetch is never counted as reading.
 */

export interface DocumentStorage {
  put(path: string, bytes: Uint8Array<ArrayBuffer>, contentType: string): Promise<void>;
  get(path: string): Promise<Uint8Array<ArrayBuffer> | null>;
  delete(paths: string[]): Promise<void>;
}

/** Supabase Storage (private bucket) over its REST API with the service key. Server only. */
export class SupabaseDocumentStorage implements DocumentStorage {
  constructor(
    private readonly url: string,
    private readonly serviceKey: string,
    private readonly bucket: string,
    private readonly fetchImpl: typeof fetch = (input, init) => fetch(input, init),
  ) {}

  private headers(extra: Record<string, string> = {}) {
    return { Authorization: `Bearer ${this.serviceKey}`, apikey: this.serviceKey, ...extra };
  }

  private async requirePrivateBucket() {
    const response = await this.fetchImpl(`${this.url.replace(/\/+$/, '')}/storage/v1/bucket/${encodeURIComponent(this.bucket)}`, { headers: this.headers() });
    const bucket = await response.json().catch(() => null) as { public?: unknown } | null;
    if (!response.ok || bucket?.public !== false) throw new ApiError('not_configured', 'Tracked documents require a private storage bucket.');
  }

  async put(path: string, bytes: Uint8Array<ArrayBuffer>, contentType: string) {
    await this.requirePrivateBucket();
    const response = await this.fetchImpl(`${this.url.replace(/\/+$/, '')}/storage/v1/object/${this.bucket}/${path}`, {
      method: 'PUT',
      headers: this.headers({ 'Content-Type': contentType, 'x-upsert': 'true', 'Cache-Control': 'no-store' }),
      body: bytes,
    });
    if (!response.ok) throw new ApiError('internal', 'The document could not be stored.');
  }

  async get(path: string) {
    await this.requirePrivateBucket();
    const response = await this.fetchImpl(`${this.url.replace(/\/+$/, '')}/storage/v1/object/authenticated/${this.bucket}/${path}`, { headers: this.headers() });
    if (response.status === 404 || response.status === 400) return null;
    if (!response.ok) throw new ApiError('internal', 'The document could not be read.');
    return new Uint8Array(await response.arrayBuffer());
  }

  async delete(paths: string[]) {
    if (!paths.length) return;
    const response = await this.fetchImpl(`${this.url.replace(/\/+$/, '')}/storage/v1/object/${this.bucket}`, {
      method: 'DELETE',
      headers: this.headers({ 'Content-Type': 'application/json' }),
      body: JSON.stringify({ prefixes: paths }),
    });
    if (!response.ok) throw new ApiError('internal', 'The document could not be deleted. Try again.');
  }
}

export class MemoryDocumentStorage implements DocumentStorage {
  readonly files = new Map<string, Uint8Array<ArrayBuffer>>();
  async put(path: string, bytes: Uint8Array<ArrayBuffer>) {
    this.files.set(path, bytes);
  }
  async get(path: string) {
    return this.files.get(path) ?? null;
  }
  async delete(paths: string[]) {
    for (const path of paths) this.files.delete(path);
  }
}

function requireStorage(deps: IntelDeps): DocumentStorage {
  if (!deps.storage) throw new ApiError('not_configured', 'Tracked documents are not configured on this server.');
  return deps.storage;
}

type DocRow = { id: string; title: string; filename: string; size_bytes: number; page_count: number | null; status: DocumentSummary['status']; created_at: unknown; links: number; views: number; last_viewed_at: unknown; storage_path: string };

const DOC_SELECT = `select d.id, d.title, d.filename, d.size_bytes, d.page_count, d.status, d.created_at, d.storage_path,
  (select count(*)::int from public.document_recipients r where r.document_id = d.id) as links,
  (select count(*)::int from public.document_events e where e.document_id = d.id and e.kind = 'view_start' and e.event_class = 'RECIPIENT_LIKELY') as views,
  (select max(e.at) from public.document_events e where e.document_id = d.id and e.kind = 'view_start' and e.event_class = 'RECIPIENT_LIKELY') as last_viewed_at
  from public.documents d`;

function toSummary(row: DocRow): DocumentSummary {
  return {
    id: row.id,
    title: row.title.slice(0, 300),
    filename: row.filename.slice(0, 255),
    sizeBytes: num(row.size_bytes),
    pageCount: row.page_count === null ? null : num(row.page_count),
    status: row.status,
    createdAt: iso(row.created_at),
    links: num(row.links),
    views: num(row.views),
    lastViewedAt: isoOrNull(row.last_viewed_at),
  };
}

export async function listDocuments(tx: SqlExecutor): Promise<DocumentSummary[]> {
  return (await tx.query<DocRow>(`${DOC_SELECT} order by d.created_at desc limit 500`)).map(toSummary);
}

export async function createDocument(tx: SqlExecutor, userId: string, input: { title: string; filename: string }): Promise<DocumentSummary & { uploadPath: string }> {
  const id = crypto.randomUUID();
  const filename = input.filename.replace(/[^\w.\- ]+/g, '_').slice(0, 255) || 'document.pdf';
  await tx.query(`insert into public.documents (id, user_id, title, filename, storage_path) values ($1::uuid, $2::uuid, $3, $4, $5)`, [id, userId, input.title.slice(0, 300), filename, `${userId}/${id}.pdf`]);
  const row = await one<DocRow>(tx, `${DOC_SELECT} where d.id = $1::uuid`, [id]);
  return { ...toSummary(row!), uploadPath: `/v1/documents/${id}/content` };
}

/** Parse the page tree, including compressed objects; a PDF header alone is insufficient. */
export async function countPdfPages(bytes: Uint8Array): Promise<number> {
  try {
    const pdf = await PDFDocument.load(bytes, { updateMetadata: false, throwOnInvalidObject: true });
    const pages = pdf.getPageCount();
    if (pages < 1 || pages > 500) throw new Error('unsupported page count');
    return pages;
  } catch {
    throw new ApiError('invalid_request', 'Choose a valid, unencrypted PDF with 1 to 500 pages.');
  }
}

export async function uploadDocument(deps: IntelDeps, userId: string, documentId: string, bytes: Uint8Array<ArrayBuffer>): Promise<DocumentSummary> {
  const storage = requireStorage(deps);
  if (bytes.length === 0) throw new ApiError('invalid_request', 'The file is empty.');
  if (bytes.length > deps.config.intel.documentMaxBytes) throw new ApiError('payload_too_large', `Documents can be up to ${Math.round(deps.config.intel.documentMaxBytes / 1_000_000)} MB.`);
  if (new TextDecoder('latin1').decode(bytes.subarray(0, 5)) !== '%PDF-') throw new ApiError('invalid_request', 'Only PDF files can be tracked.');
  const row = await deps.db.asUser(userId, (tx) => one<{ status: string }>(tx, `select status from public.documents where id = $1::uuid`, [documentId]));
  if (!row || row.status === 'deleted') throw new ApiError('not_found', 'That document does not exist.');
  const pageCount = await countPdfPages(bytes);
  const digest = new Uint8Array(await crypto.subtle.digest('SHA-256', bytes));
  const sha = [...digest].map((byte) => byte.toString(16).padStart(2, '0')).join('');
  return deps.db.asUser(userId, async (tx) => {
    // Serialize upload/retry/delete. A shared document is immutable: replacing
    // its bytes would silently attach old analytics to different content.
    const current = await one<{ status: string; sha256: string | null }>(tx, `select status, sha256 from public.documents where id = $1::uuid for update`, [documentId]);
    if (!current || current.status === 'deleted') throw new ApiError('not_found', 'That document does not exist.');
    if (current.status === 'ready') {
      if (current.sha256 !== sha) throw new ApiError('conflict', 'Upload changed content as a new document.');
      return toSummary((await one<DocRow>(tx, `${DOC_SELECT} where d.id = $1::uuid`, [documentId]))!);
    }
    const path = `${userId}/${documentId}.${sha}.pdf`;
    await storage.put(path, bytes, 'application/pdf');
    await tx.query(`update public.documents set status = 'ready', size_bytes = $2, page_count = $3, sha256 = $4, storage_path = $5 where id = $1::uuid`, [documentId, bytes.length, pageCount, sha, path]);
    return toSummary((await one<DocRow>(tx, `${DOC_SELECT} where d.id = $1::uuid`, [documentId]))!);
  });
}

export async function deleteDocument(deps: IntelDeps, userId: string, documentId: string): Promise<void> {
  // Disable access before storage deletion. A storage outage must not leave
  // working links; preserve the tombstone so the owner can retry cleanup.
  const row = await deps.db.asUser(userId, async (tx) => {
    const doc = await one<{ storage_path: string; title: string }>(tx, `select storage_path, title from public.documents where id = $1::uuid for update`, [documentId]);
    if (!doc) throw new ApiError('not_found', 'That document does not exist.');
    await tx.query(`update public.documents set status = 'deleted', deleted_at = coalesce(deleted_at, now()) where id = $1::uuid`, [documentId]);
    return doc;
  });
  await requireStorage(deps).delete([row.storage_path]);
  await deps.db.asUser(userId, async (tx) => {
    await tx.query(`delete from public.documents where id = $1::uuid`, [documentId]);
    await recordAudit(tx, { userId, actor: { type: 'user', id: userId, name: 'You' }, action: 'delete_document', tier: 0, target: { kind: 'document', id: documentId, title: row.title }, summary: `Deleted "${row.title}" and all its links`, policy: { decision: 'allowed', reason: 'User request' } });
  });
}

/** Account deletion must remove private files before cascading their paths away. */
export async function deleteAccountDocumentFiles(deps: IntelDeps, userId: string): Promise<void> {
  const rows = await deps.db.asUser(userId, tx => tx.query<{ storage_path: string }>(
    `update public.documents set status = 'deleted', deleted_at = coalesce(deleted_at, now()) returning storage_path`));
  if (!rows.length) return;
  const storage = requireStorage(deps);
  for (let i = 0; i < rows.length; i += 100) await storage.delete(rows.slice(i, i + 100).map(row => row.storage_path));
}

type LinkRow = { id: string; document_id: string; token_key_id: string; token_iv: string; token_ciphertext: string; token_hint: string; recipient_email: string | null; expires_at: unknown; allow_download: boolean; watermark: boolean; revoked_at: unknown; gmail_thread_id: string | null; created_at: unknown };

export function viewerOrigin(deps: IntelDeps): string {
  return (deps.config.apiBaseUrl ?? deps.config.publicAppUrl ?? 'https://localhost').replace(/\/+$/, '');
}

async function toLink(deps: IntelDeps, userId: string, row: LinkRow): Promise<DocumentLink> {
  const token = await deps.box.open({ keyId: row.token_key_id, iv: row.token_iv, ciphertext: row.token_ciphertext }, { purpose: 'document_token', userId, recordId: row.id }).catch(() => { throw new ApiError('internal', 'That document link could not be read.'); });
  return {
    id: row.id,
    documentId: row.document_id,
    url: `${viewerOrigin(deps)}/d/${token}`,
    recipientEmail: row.recipient_email,
    expiresAt: isoOrNull(row.expires_at),
    allowDownload: row.allow_download,
    watermark: row.watermark,
    revokedAt: isoOrNull(row.revoked_at),
    threadId: row.gmail_thread_id,
    createdAt: iso(row.created_at),
  };
}

export async function createLink(
  deps: IntelDeps,
  userId: string,
  input: { documentId: string; recipientEmail?: string; expiresAt?: string; allowDownload: boolean; watermark: boolean; threadId?: string },
): Promise<DocumentLink> {
  const token = randomToken(24);
  const id = crypto.randomUUID();
  const sealed = await deps.box.seal(token, { purpose: 'document_token', userId, recordId: id });
  return deps.db.asUser(userId, async (tx) => {
    const doc = await one<{ status: string; title: string }>(tx, `select status, title from public.documents where id = $1::uuid for update`, [input.documentId]);
    if (!doc || doc.status !== 'ready') throw new ApiError('not_found', 'Upload the document before sharing it.');
    const count = await one<{ n: number }>(tx, `select count(*)::int as n from public.document_recipients where document_id = $1::uuid`, [input.documentId]);
    if (num(count?.n) >= 500) throw new ApiError('quota_exceeded', 'This document already has 500 links.');
    if (input.expiresAt && Date.parse(input.expiresAt) <= deps.now().getTime()) throw new ApiError('invalid_request', 'The expiry must be in the future.');
    await tx.query(
      `insert into public.document_recipients (id, user_id, document_id, token_hash, token_hint, token_key_id, token_iv, token_ciphertext, recipient_email, expires_at, allow_download, watermark, gmail_thread_id)
       values ($1::uuid, $2::uuid, $3::uuid, $4, $5, $6, $7, $8, $9, $10::timestamptz, $11, $12, $13)`,
      [id, userId, input.documentId, await sha256Hex(token), token.slice(0, 6), sealed.keyId, sealed.iv, sealed.ciphertext, input.recipientEmail?.toLowerCase() ?? null, input.expiresAt ?? null, input.allowDownload, input.watermark, input.threadId ?? null],
    );
    await recordAudit(tx, {
      userId,
      actor: { type: 'user', id: userId, name: 'You' },
      action: 'create_document_link',
      tier: 0,
      target: { kind: 'document', id: input.documentId, title: doc.title },
      summary: `Created a link to "${doc.title}"${input.recipientEmail ? ` for ${input.recipientEmail}` : ''}`,
      policy: { decision: 'allowed', reason: 'User request' },
    });
    return toLink(deps, userId, (await one<LinkRow>(tx, `select * from public.document_recipients where id = $1::uuid`, [id]))!);
  });
}

export async function revokeLink(deps: IntelDeps, userId: string, linkId: string): Promise<DocumentLink> {
  return deps.db.asUser(userId, async (tx) => {
    const row = await one<LinkRow>(tx, `update public.document_recipients set revoked_at = coalesce(revoked_at, now()) where id = $1::uuid returning *`, [linkId]);
    if (!row) throw new ApiError('not_found', 'That link does not exist.');
    await recordAudit(tx, { userId, actor: { type: 'user', id: userId, name: 'You' }, action: 'revoke_document_link', tier: 0, target: { kind: 'document_link', id: linkId, title: row.recipient_email }, summary: 'Revoked a document link', policy: { decision: 'allowed', reason: 'User request' } });
    return toLink(deps, userId, row);
  });
}

/** A send receipt binds a compose link once; retries cannot move it to another conversation. */
export async function associateDocumentLink(tx: SqlExecutor, token: string, threadId: string): Promise<void> {
  const row = await one(tx, `update public.document_recipients set gmail_thread_id = $2
    where token_hash = $1 and (gmail_thread_id is null or gmail_thread_id = $2) returning id`, [await sha256Hex(token), threadId]);
  if (!row) throw new ApiError('not_found', 'That document link is not available for this conversation.');
}

export async function documentAnalytics(deps: IntelDeps, userId: string, documentId: string) {
  return deps.db.asUser(userId, async (tx) => {
    const doc = await one<DocRow>(tx, `${DOC_SELECT} where d.id = $1::uuid`, [documentId]);
    if (!doc) throw new ApiError('not_found', 'That document does not exist.');
    const links = await tx.query<LinkRow>(`select * from public.document_recipients where document_id = $1::uuid order by created_at limit 500`, [documentId]);
    // Aggregate in Postgres: fetching a document's entire heartbeat history
    // into a Worker eventually exhausts memory on frequently read documents.
    const totals = await tx.query<{ recipient_id: string; views: number; downloads: number; fetches: number; visible_ms: number; first_viewed_at: unknown; last_viewed_at: unknown }>(
      `select recipient_id,
       count(*) filter (where kind = 'view_start' and event_class = 'RECIPIENT_LIKELY') as views,
       count(*) filter (where kind = 'download' and event_class = 'RECIPIENT_LIKELY') as downloads,
       count(*) filter (where kind in ('file_fetch','download') and event_class not in ('SELF_LIKELY','MACHINE_LIKELY')) as fetches,
       coalesce(sum(visible_ms) filter (where event_class = 'RECIPIENT_LIKELY'), 0) as visible_ms,
       min(at) filter (where kind = 'view_start' and event_class = 'RECIPIENT_LIKELY') as first_viewed_at,
       max(at) filter (where kind = 'view_start' and event_class = 'RECIPIENT_LIKELY') as last_viewed_at
       from public.document_events where document_id = $1::uuid group by recipient_id`, [documentId]);
    const observed = await tx.query<{ recipient_id: string; page: number; views: number; visible_ms: number }>(
      `select recipient_id, page, count(*) filter (where kind = 'page_view') as views, sum(visible_ms) as visible_ms
       from public.document_events where document_id = $1::uuid and event_class = 'RECIPIENT_LIKELY'
       and page between 1 and 500 and kind in ('page_view','heartbeat','view_end') group by recipient_id, page order by page`, [documentId]);
    const byLink = new Map(totals.map(row => [row.recipient_id, row]));
    const pageStats = new Map<string, Array<{ page: number; views: number; visibleSeconds: number }>>();
    for (const row of observed) {
      const rows = pageStats.get(row.recipient_id) ?? [];
      rows.push({ page: num(row.page), views: num(row.views), visibleSeconds: Math.round(num(row.visible_ms) / 1000) });
      pageStats.set(row.recipient_id, rows);
    }
    const stats = [];
    for (const link of links) {
      const total = byLink.get(link.id);
      const views = num(total?.views);
      const pages = pageStats.get(link.id) ?? [];
      const precision = pages.length ? 'pages_observed' : views ? 'session_only' : num(total?.fetches) ? 'download_only' : 'none';
      stats.push({
        link: await toLink(deps, userId, link),
        firstViewedAt: isoOrNull(total?.first_viewed_at),
        lastViewedAt: isoOrNull(total?.last_viewed_at),
        views,
        downloads: num(total?.downloads),
        visibleSeconds: views ? Math.round(num(total?.visible_ms) / 1_000) : null,
        pages: pages.length ? pages : null,
        precision: precision as 'pages_observed' | 'session_only' | 'download_only' | 'none',
      });
    }
    return {
      document: toSummary(doc),
      links: stats,
      notes: [
        'Time and pages come from the PigeonBox viewer while its tab is visible and focused. Forwarded links, screenshots and printouts are not visible to PigeonBox.',
        'Downloads are counted separately; a download does not show whether anyone read the file.',
        'Known scanners and authenticated sender previews are excluded. A recipient label identifies the link, not the person holding it.',
      ],
    };
  });
}

/** The public viewer resolves a link by token hash only, then everything runs as the document owner. */
export async function resolveLink(deps: IntelDeps, token: string) {
  if (!/^[A-Za-z0-9_-]{20,64}$/.test(token)) return null;
  const hash = await sha256Hex(token);
  const found = await deps.db.system((tx) => one<{ recipient_id: string; user_id: string; document_id: string }>(tx, `select * from app.resolve_document_link($1)`, [hash]));
  if (!found) return null;
  const link = await deps.db.asUser(found.user_id, (tx) =>
    one<{ id: string; recipient_email: string | null; allow_download: boolean; watermark: boolean; title: string; storage_path: string; page_count: number | null; filename: string }>(
      tx,
      `select r.id, r.recipient_email, r.allow_download, r.watermark, d.title, d.storage_path, d.page_count, d.filename
         from public.document_recipients r join public.documents d on d.id = r.document_id
         where r.id = $1::uuid and r.revoked_at is null and (r.expires_at is null or r.expires_at > $2::timestamptz) and d.status = 'ready'`,
      [found.recipient_id, deps.now()],
    ),
  );
  return link ? { ...link, userId: found.user_id, documentId: found.document_id } : null;
}

export async function recordDocumentEvents(
  deps: IntelDeps,
  link: { id: string; userId: string; documentId: string },
  events: Array<{ id: string; kind: 'view_start' | 'page_view' | 'heartbeat' | 'download' | 'view_end' | 'file_fetch'; page?: number | null; visibleMs?: number; at?: string }>,
  meta: { sessionId: string; ipHash: string | null; uaFamily: string | null; eventClass: 'RECIPIENT_LIKELY' | 'SELF_LIKELY' | 'MACHINE_LIKELY' | 'UNKNOWN' },
): Promise<number> {
  return deps.db.asUser(link.userId, async (tx) => {
    let stored = 0;
    for (const event of events.slice(0, 50)) {
      const at = event.at && Math.abs(Date.parse(event.at) - deps.now().getTime()) < 10 * 60_000 ? new Date(event.at) : deps.now();
      const rows = await tx.query(
        `insert into public.document_events (user_id, document_id, recipient_id, session_id, client_event_id, kind, page, visible_ms, at, ip_hash, ua_family, event_class)
         values ($1::uuid, $2::uuid, $3::uuid, $4, $5, $6, $7, $8, $9::timestamptz, $10, $11, $12) on conflict (recipient_id, client_event_id) do nothing returning id`,
        [link.userId, link.documentId, link.id, meta.sessionId.slice(0, 64), event.id.slice(0, 64), event.kind, event.page ?? null, Math.max(0, Math.min(600_000, Math.round(event.visibleMs ?? 0))), at, meta.ipHash, meta.uaFamily, meta.eventClass],
      );
      stored += rows.length;
    }
    return stored;
  });
}
