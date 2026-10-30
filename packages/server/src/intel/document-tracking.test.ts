import type { DocumentLink, DocumentSummary, RouteResponse } from '@pigeonbox/api-contract';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { createApiHandler } from '../api.js';
import { API } from '../testing.js';
import { testPdf } from '../testing/pdf.js';
import { connectedUser, createIntelHarness, type IntelHarness } from '../testing/intel-harness.js';
import { SupabaseDocumentStorage } from './documents.js';

const UA = 'Mozilla/5.0 Chrome/130.0.0.0 Safari/537.36';
const harnesses: IntelHarness[] = [];
afterEach(async () => { await Promise.all(harnesses.splice(0).map(h => h.pg.close())); });
async function setup() {
  const h = await createIntelHarness(); harnesses.push(h);
  const owner = await connectedUser(h, 'owner@work.test');
  const pdf = await testPdf();
  const created = await h.route<{ document: DocumentSummary; uploadPath: string }>('controlDocumentCreate', owner.token, { title: 'Proposal', filename: 'proposal.pdf' });
  const put = (bytes = pdf, token = owner.token) => h.api(new Request(`${API}${created.uploadPath}`, { method: 'PUT', headers: { Authorization: `Bearer ${token}`, 'Content-Type': 'application/pdf' }, body: bytes }));
  expect((await put()).status).toBe(200);
  const { link } = await h.route<{ link: DocumentLink }>('documentLinkCreate', owner.token, { documentId: created.document.id, recipientEmail: 'client@work.test', allowDownload: true });
  const path = new URL(link.url).pathname;
  const request = (suffix = '', body?: unknown, headers = {}) => h.api(new Request(`${API}${path}${suffix}`, { method: body === undefined ? 'GET' : 'POST', headers: { 'User-Agent': UA, ...(body === undefined ? {} : { 'Content-Type': 'application/json' }), ...headers }, ...(body === undefined ? {} : { body: JSON.stringify(body) }) }));
  const session = async (body = {}, headers = {}) => {
    const response = await request('/session', body, headers); expect(response.status).toBe(200);
    return await response.json() as { sessionId: string; sessionToken: string; preview: boolean };
  };
  const analytics = () => h.route<any>('documentAnalytics', owner.token, { documentId: created.document.id });
  return { h, owner, put, link, path, request, session, analytics, document: created.document };
}
const start = { id: 'view-0001', kind: 'view_start' };
const page = { id: 'page-0001', kind: 'page_view', page: 1 };

describe('Document tracking trust boundaries', () => {
  it('shows observed PDF opens and downloads beside email activity and keeps associations owner-only', async () => {
    const f = await setup();
    const threadId = 'abc123';
    const token = new URL(f.link.url).pathname.split('/')[2]!;
    const signals = (token = f.owner.token, thread = threadId) => f.h.route<RouteResponse<'threadSignals'>>('threadSignals', token, { threadId: thread });
    await f.h.route('documentLinkAssociate', f.owner.token, { token, threadId });
    await f.h.route('documentLinkAssociate', f.owner.token, { token, threadId }); // retry safe
    await expect(f.h.route('documentLinkAssociate', f.owner.token, { token, threadId: 'other123' })).rejects.toMatchObject({ code: 'not_found' });
    const stranger = await f.h.signIn('stranger@work.test');
    await expect(f.h.route('documentLinkAssociate', stranger.accessToken, { token, threadId })).rejects.toMatchObject({ code: 'not_found' });
    const recipient = await f.session();
    expect((await f.request('/events', { ...recipient, events: [start, page] })).status).toBe(200);
    expect((await f.request('/download', undefined, { 'X-Document-Session': recipient.sessionToken })).status).toBe(200);
    // Sender and scanner sessions never show up in the email's PDF activity.
    const sender = await f.session({}, { Authorization: `Bearer ${f.owner.token}` });
    await f.request('/events', { ...sender, events: [start, page] });
    await f.request('/download', undefined, { 'X-Document-Session': sender.sessionToken });
    const scanner = await f.session({}, { 'User-Agent': 'Barracuda scanner bot' });
    await f.request('/events', { ...scanner, events: [start] });
    const result = await signals();
    expect(result.events.map(event => event.type).sort()).toEqual(['document_download', 'document_view']);
    expect(result.events.every(event => event.eventClass === 'RECIPIENT_LIKELY' && event.explanation.includes('proposal.pdf'))).toBe(true);
    expect(JSON.stringify(result)).not.toContain(new URL(f.link.url).pathname.split('/')[2]);
    expect((await signals(stranger.accessToken)).events).toEqual([]);
    expect((await signals(f.owner.token, 'different123')).events).toEqual([]);
    // Older manually inserted links can be matched through the email tracker.
    await f.h.sql(`update public.document_recipients set gmail_thread_id = null where id = $1`, [f.link.id]);
    await f.h.sql(`insert into public.tracked_emails (tracking_id,user_id,status,subject,sender,recipients,gmail_thread_id,sent_at) values ('trk_pdf',$1,'SENT','Proposal','owner@work.test','[]',$2,now())`, [f.owner.userId, threadId]);
    await f.h.sql(`insert into public.tracked_links (click_id,tracking_id,user_id,destination) values ('clk_pdf','trk_pdf',$1,$2)`, [f.owner.userId, f.link.url]);
    expect((await signals()).events.map(event => event.type).sort()).toEqual(['document_download', 'document_view']);
    // Activity in an older conversation must not disappear after 500 other sends.
    await f.h.sql(`update public.tracked_emails set sent_at = now() - interval '30 days' where tracking_id = 'trk_pdf'`);
    await f.h.sql(`insert into public.tracked_emails (tracking_id,user_id,status,subject,sender,recipients,gmail_thread_id,sent_at)
      select 'trk_other_' || n,$1,'SENT','Other','owner@work.test','[]','other' || n,now() from generate_series(1,501) n`, [f.owner.userId]);
    expect((await signals()).events.map(event => event.type).sort()).toEqual(['document_download', 'document_view']);
    expect((await signals()).signals.map(signal => signal.kind)).not.toContain('no_engagement');
  });
  it('rejects invented, borrowed and expired sessions, and bounds time and pages', async () => {
    const f = await setup();
    const first = await f.session();
    expect((await f.request('/events', { ...first, sessionToken: 'x'.repeat(32), events: [start] })).status).toBe(403);
    expect((await f.request('/events', { ...first, sessionId: crypto.randomUUID(), events: [start] })).status).toBe(403);
    expect((await f.request('/events', { ...first, events: [{ ...page, page: 3 }] })).status).toBe(400);
    expect((await f.request('/events', { ...first, events: [page] })).status).toBe(400);
    expect((await f.request('/events', { ...first, events: [start, page, { id: 'beat-0001', kind: 'heartbeat', page: 1, visibleMs: 30_000 }] })).status).toBe(400);
    expect((await f.analytics()).links[0].views).toBe(0); // transaction rolled back
    await f.h.advance(8 * 3_600_000 + 1);
    expect((await f.request('/events', { ...first, events: [start, page] })).status).toBe(403);
  });

  it('deduplicates retries and semantic starts/pages without losing later observations', async () => {
    const f = await setup(); const s = await f.session();
    await f.h.advance(20_000);
    const events = [start, page, { id: 'beat-0001', kind: 'heartbeat', page: 1, visibleMs: 10_000 }];
    const send = async (batch: unknown[]) => { const r = await f.request('/events', { ...s, events: batch }); expect(r.status).toBe(200); return r.json() as Promise<{ stored: number }>; };
    expect(await send(events)).toEqual({ stored: 3 });
    expect(await send(events)).toEqual({ stored: 0 });
    expect(await send([{ ...start, id: 'view-0002' }, { ...page, id: 'page-0002' }])).toEqual({ stored: 0 });
    await f.h.advance(10_000);
    await send([{ id: 'beat-0002', kind: 'heartbeat', page: 1, visibleMs: 10_000 }]);
    expect((await f.analytics()).links[0]).toMatchObject({ views: 1, visibleSeconds: 20, pages: [{ page: 1, views: 1, visibleSeconds: 20 }] });
    const second = await f.session();
    await f.request('/events', { ...second, events: [start, page] });
    expect((await f.analytics()).links[0].views).toBe(2); // IDs are scoped to session
  });

  it('binds sessions and preview proofs to one link and one owner', async () => {
    const f = await setup(); const s = await f.session();
    const { link: other } = await f.h.route<{ link: DocumentLink }>('documentLinkCreate', f.owner.token, { documentId: f.document.id });
    const otherPath = new URL(other.url).pathname;
    const post = (suffix: string, body: unknown) => f.h.api(new Request(`${API}${otherPath}${suffix}`, { method: 'POST', headers: { 'User-Agent': UA, 'Content-Type': 'application/json' }, body: JSON.stringify(body) }));
    expect((await post('/events', { ...s, events: [start] })).status).toBe(403);
    const { url } = await f.h.route<{ url: string }>('controlDocumentPreview', f.owner.token, { linkId: f.link.id });
    const preview = new URLSearchParams(new URL(url).hash.slice(1)).get('preview')!;
    expect((await post('/session', { preview })).status).toBe(403);
    const stranger = await f.h.signIn('stranger@work.test');
    const token = new URL(f.link.url).pathname.split('/')[2]!;
    expect(await f.h.route('documentPreview', stranger.accessToken, { token })).toEqual({ url: null });
    const resolved = await f.h.route<{ url: string }>('documentPreview', f.owner.token, { token });
    expect(resolved.url).toContain('#preview=');
    expect((await f.analytics()).links[0].views).toBe(0);
    await expect(f.h.route('controlDocumentPreview', stranger.accessToken, { linkId: f.link.id })).rejects.toMatchObject({ code: 'not_found' });
    for (const [name, body] of [['documentAnalytics', { documentId: f.document.id }], ['documentLinkCreate', { documentId: f.document.id }], ['documentLinkRevoke', { linkId: f.link.id }], ['controlDocumentDelete', { id: f.document.id }]] as const) {
      await expect(f.h.route(name, stranger.accessToken, body)).rejects.toMatchObject({ code: 'not_found' });
    }
    expect((await f.put(await testPdf(), stranger.accessToken)).status).toBe(404);
    await expect(f.h.db.asUser(stranger.user.id, tx => tx.query(`insert into public.document_recipients (id,user_id,document_id,token_hash,token_hint,token_key_id,token_iv,token_ciphertext) values ($1,$2,$3,'fake','fake','k','i','c')`, [crypto.randomUUID(), stranger.user.id, f.document.id]))).rejects.toThrow();
  });

  it('excludes sender previews across delayed reloads, file fetches and downloads', async () => {
    const f = await setup();
    const { url } = await f.h.route<{ url: string }>('controlDocumentPreview', f.owner.token, { linkId: f.link.id });
    const preview = new URLSearchParams(new URL(url).hash.slice(1)).get('preview')!;
    const s = await f.session({ preview }); expect(s.preview).toBe(true);
    await f.h.advance(60_000); // beyond email sender-claim TTL
    await f.request('/events', { ...s, events: [start, page, { id: 'beat-0001', kind: 'heartbeat', page: 1, visibleMs: 20_000 }] });
    await f.request('/file', undefined, { 'X-Document-Session': s.sessionToken });
    await f.request('/download', undefined, { 'X-Document-Session': s.sessionToken });
    const ownerSession = await f.session({}, { Authorization: `Bearer ${f.owner.token}` });
    expect(ownerSession.preview).toBe(true);
    await f.request('/events', { ...ownerSession, events: [start, page] });
    const stats = (await f.analytics()).links[0];
    expect(stats).toMatchObject({ views: 0, downloads: 0, precision: 'none', pages: null, visibleSeconds: null });
    expect((await f.analytics()).document.lastViewedAt).toBeNull();
    await f.h.advance(5 * 60_000);
    expect((await f.request('/session', { preview })).status).toBe(403);
    // Refreshing the same signed-out tab resumes its server classification
    // even after the short-lived URL proof expired.
    const resumed = await f.session({ resume: s.sessionToken });
    expect(resumed).toMatchObject({ sessionId: s.sessionId, sessionToken: s.sessionToken, preview: true });
    expect((await f.request('/session', { resume: 'x'.repeat(32) })).status).toBe(403);
    expect((await f.request('/session', { resume: s.sessionToken, preview })).status).toBe(400);
    await f.h.advance(8 * 3_600_000);
    expect((await f.request('/session', { resume: s.sessionToken })).status).toBe(403);
  });

  it('excludes scanner fetches and client events even when events use a browser UA', async () => {
    const f = await setup(); const s = await f.session({}, { 'User-Agent': 'Barracuda scanner bot' });
    await f.request('/events', { ...s, events: [start, page] });
    await f.request('/file', undefined, { 'User-Agent': 'scanner bot' });
    await f.request('/download', undefined, { 'User-Agent': 'scanner bot' });
    expect((await f.analytics()).links[0]).toMatchObject({ views: 0, downloads: 0, precision: 'none' });
    expect((await f.request('/events', { ...s, events: [start] }, { Origin: 'https://evil.test' })).status).toBe(403);
    expect((await f.request('/file/extra')).status).toBe(404);
  });

  it('expires and revokes every access route, including already-issued sessions', async () => {
    const f = await setup(); const s = await f.session();
    await f.h.route('documentLinkRevoke', f.owner.token, { linkId: f.link.id });
    for (const suffix of ['', '/file', '/download']) expect((await f.request(suffix)).status).toBe(404);
    expect((await f.request('/events', { ...s, events: [start, page] })).status).toBe(404);
    expect((await f.request('/session', {})).status).toBe(404);
    const { link } = await f.h.route<{ link: DocumentLink }>('documentLinkCreate', f.owner.token, { documentId: f.document.id, expiresAt: new Date(f.h.now().getTime() + 1000).toISOString() });
    await f.h.advance(2000);
    expect((await f.h.api(new Request(link.url))).status).toBe(404);
  });

  it('validates compressed PDFs, rejects broken files and makes upload retries immutable', async () => {
    const f = await setup();
    expect((await f.put()).status).toBe(200); // idempotent retry
    expect((await f.put(await testPdf(3))).status).toBe(409);
    const created = await f.h.route<{ document: DocumentSummary; uploadPath: string }>('controlDocumentCreate', f.owner.token, { title: 'Broken', filename: 'broken.pdf' });
    const response = await f.h.api(new Request(`${API}${created.uploadPath}`, { method: 'PUT', headers: { Authorization: `Bearer ${f.owner.token}`, 'Content-Type': 'application/pdf' }, body: '%PDF-1.7\n/Type /Page\n%%EOF' }));
    expect(response.status).toBe(400);
    await expect(f.h.route('documentLinkCreate', f.owner.token, { documentId: created.document.id })).rejects.toMatchObject({ code: 'not_found' });
    expect((await f.analytics()).document.pageCount).toBe(2);
  });

  it('disables links even if storage cleanup fails, and permits owner cleanup retry', async () => {
    const f = await setup(); const remove = vi.spyOn(f.h.storage, 'delete').mockRejectedValueOnce(new Error('storage unavailable'));
    await expect(f.h.route('controlDocumentDelete', f.owner.token, { id: f.document.id })).rejects.toThrow();
    expect((await f.request('/file')).status).toBe(404);
    const list = await f.h.route<{ documents: DocumentSummary[] }>('documents', f.owner.token);
    expect(list.documents[0].status).toBe('deleted');
    await f.h.route('controlDocumentDelete', f.owner.token, { id: f.document.id });
    expect(remove).toHaveBeenCalledTimes(2);
    expect(f.h.storage.files.size).toBe(0);
    expect(await f.h.sql('select * from public.document_recipients')).toEqual([]);
  });

  it('bounds streamed uploads without trusting declared lengths', async () => {
    const f = await setup();
    f.h.config.intel.documentMaxBytes = 10;
    const api = createApiHandler(f.h.deps);
    const body = new ReadableStream({ start(c) { c.enqueue(new Uint8Array(6)); c.enqueue(new Uint8Array(6)); c.close(); } });
    const response = await api(new Request(`${API}/v1/documents/${f.document.id}/content`, { method: 'PUT', headers: { Authorization: `Bearer ${f.owner.token}`, 'Content-Type': 'application/pdf', 'Content-Length': '1' }, body, duplex: 'half' } as RequestInit));
    expect(response.status).toBe(413);
  });

  it('removes document files and all viewer records when the account is deleted', async () => {
    const f = await setup(); await f.session();
    await f.h.route('accountDelete', f.owner.token, { confirm: 'delete my account' });
    expect(f.h.storage.files.size).toBe(0);
    expect(await f.h.sql('select * from public.document_viewer_sessions')).toEqual([]);
    expect((await f.request('/file')).status).toBe(404);
  });
});

it('reports Supabase deletion failures instead of acknowledging an orphaned file', async () => {
  const storage = new SupabaseDocumentStorage('https://storage.test', 'secret', 'documents', vi.fn(async () => new Response('{}', { status: 500 })));
  await expect(storage.delete(['owner/file.pdf'])).rejects.toMatchObject({ code: 'internal' });
});

it('refuses public storage buckets rather than exposing private documents', async () => {
  const fetch = vi.fn(async () => new Response(JSON.stringify({ public: true })));
  const storage = new SupabaseDocumentStorage('https://storage.test', 'secret', 'documents', fetch);
  await expect(storage.put('owner/file.pdf', await testPdf(), 'application/pdf')).rejects.toMatchObject({ code: 'not_configured' });
  await expect(storage.get('owner/file.pdf')).rejects.toMatchObject({ code: 'not_configured' });
  expect(fetch.mock.calls).toHaveLength(2);
});
