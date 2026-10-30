import type { Approval, DocumentLink, DocumentSummary } from '@pigeonbox/api-contract';
import { addCalendarDays, zonedParts, zonedTimeToUtc } from '@pigeonbox/shared';
import { describe, expect, it } from 'vitest';
import { testPdf } from '../testing/pdf.js';
import type { z } from 'zod';
import type { DocumentAnalyticsResponseSchema } from '@pigeonbox/api-contract';
import { parseRawMessage } from '../google/mime.js';
import { API } from '../testing.js';
import { connectedUser, createIntelHarness, deliverAndSync, type IntelHarness } from '../testing/intel-harness.js';

const ADA = 'ada@work.test';
const PDF = await testPdf();
const BROWSER = 'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/17.0 Safari/605.1.15';
type Analytics = z.infer<typeof DocumentAnalyticsResponseSchema>;

async function upload(h: IntelHarness, token: string) {
  const created = await h.route<{ document: DocumentSummary; uploadPath: string }>('controlDocumentCreate', token, { title: 'Proposal', filename: 'proposal.pdf' });
  const response = await h.api(new Request(`${API}${created.uploadPath}`, { method: 'PUT', headers: { Authorization: `Bearer ${token}`, 'Content-Type': 'application/pdf', 'Content-Length': String(PDF.length) }, body: PDF }));
  expect(response.status).toBe(200);
  return ((await response.json()) as { document: DocumentSummary }).document;
}

const viewer = (h: IntelHarness, path: string, init: RequestInit = {}) => h.api(new Request(`${API}${path}`, { ...init, headers: { 'User-Agent': BROWSER, ...(init.headers ?? {}) } }));

type ViewerSession = { sessionId: string; sessionToken: string; preview: boolean };
async function startSession(h: IntelHarness, path: string, headers = {}, body = {}) {
  const response = await viewer(h, `${path}/session`, { method: 'POST', headers: { 'Content-Type': 'application/json', ...headers }, body: JSON.stringify(body) });
  expect(response.status).toBe(200);
  return await response.json() as ViewerSession;
}
function eventsFor(h: IntelHarness, path: string, session: ViewerSession, events: unknown[]) {
  return viewer(h, `${path}/events`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ ...session, events }) });
}

describe('Tracked documents', () => {
  it('uploads a PDF, shares it per recipient, and reports only what the viewer observed', async () => {
    const h = await createIntelHarness();
    const user = await connectedUser(h, ADA);
    const document = await upload(h, user.token);
    expect(document).toMatchObject({ status: 'ready', pageCount: 2, sizeBytes: PDF.length });
    const { link } = await h.route<{ link: DocumentLink }>('documentLinkCreate', user.token, { documentId: document.id, recipientEmail: 'maya@client.test' });
    expect(link).toMatchObject({ allowDownload: false, watermark: true, revokedAt: null });
    const path = new URL(link.url).pathname;

    // Never opened.
    let analytics = await h.route<Analytics>('documentAnalytics', user.token, { documentId: document.id });
    expect(analytics.links[0]).toMatchObject({ precision: 'none', views: 0, visibleSeconds: null, pages: null });

    // The viewer page is served with a strict CSP and no download button.
    const page = await viewer(h, path);
    expect(page.status).toBe(200);
    expect(page.headers.get('Content-Security-Policy')).toContain("script-src 'self'");
    const html = await page.text();
    expect(html).toContain('data-download="0"');
    expect(html).toContain('maya@client.test');
    expect(html).not.toContain('/download"');
    expect((await viewer(h, `${path}/download`)).status).toBe(403);

    // Fetching the file alone says nothing about reading.
    expect((await viewer(h, `${path}/file`)).headers.get('Content-Disposition')).toMatch(/^inline/);
    analytics = await h.route<Analytics>('documentAnalytics', user.token, { documentId: document.id });
    expect(analytics.links[0]!.precision).toBe('download_only');

    // Page visibility reported by the viewer, deduplicated by event id.
    const session = await startSession(h, path);
    await h.advance(52_000);
    const events = [
      { id: 'evt-start-1', kind: 'view_start' },
      { id: 'evt-page-1', kind: 'page_view', page: 1 },
      { id: 'evt-beat-1', kind: 'heartbeat', page: 1, visibleMs: 25_000 },
      { id: 'evt-beat-2', kind: 'heartbeat', page: 1, visibleMs: 15_000 },
      { id: 'evt-page-2', kind: 'page_view', page: 2 },
      { id: 'evt-end-1', kind: 'view_end', page: 2, visibleMs: 12_000 },
    ];
    for (let i = 0; i < 2; i += 1) {
      const response = await viewer(h, `${path}/events`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ ...session, events }) });
      expect(response.status).toBe(200);
    }
    expect((await viewer(h, `${path}/events`, { method: 'POST', body: '{not json' })).status).toBe(400);
    analytics = await h.route<Analytics>('documentAnalytics', user.token, { documentId: document.id });
    expect(analytics.links[0]).toMatchObject({ precision: 'pages_observed', views: 1, visibleSeconds: 52 });
    expect(analytics.links[0]!.pages).toEqual([
      { page: 1, views: 1, visibleSeconds: 40 },
      { page: 2, views: 1, visibleSeconds: 12 },
    ]);
  });

  it('ignores scanners, and stops working the moment a link is revoked', async () => {
    const h = await createIntelHarness();
    const user = await connectedUser(h, ADA);
    const document = await upload(h, user.token);
    const { link } = await h.route<{ link: DocumentLink }>('documentLinkCreate', user.token, { documentId: document.id, allowDownload: true });
    const path = new URL(link.url).pathname;
    const session = await startSession(h, path, { 'User-Agent': 'Barracuda scanner bot' });
    await eventsFor(h, path, session, [{ id: 'scan-1', kind: 'view_start' }]);
    let analytics = await h.route<Analytics>('documentAnalytics', user.token, { documentId: document.id });
    expect(analytics.links[0]!.views).toBe(0);
    expect((await viewer(h, `${path}/download`)).headers.get('Content-Disposition')).toMatch(/^attachment/);

    await h.route('documentLinkRevoke', user.token, { linkId: link.id });
    const after = await viewer(h, path);
    expect(await after.text()).toContain('This link is not available');
    expect(after.status).toBe(404);
    expect((await viewer(h, `${path}/file`)).status).toBe(404);
    analytics = await h.route<Analytics>('documentAnalytics', user.token, { documentId: document.id });
    expect(analytics.links[0]!.link.revokedAt).toBeTruthy();
    // Unknown tokens look exactly like revoked ones.
    expect(await (await viewer(h, '/d/aaaaaaaaaaaaaaaaaaaaaaaa')).text()).toContain('This link is not available');
  });

  it('stores only a hash of each link token', async () => {
    const h = await createIntelHarness();
    const user = await connectedUser(h, ADA);
    const document = await upload(h, user.token);
    const { link } = await h.route<{ link: DocumentLink }>('documentLinkCreate', user.token, { documentId: document.id });
    const token = new URL(link.url).pathname.split('/')[2]!;
    const dump = JSON.stringify(await h.sql('select * from public.document_recipients'));
    expect(dump).not.toContain(token);
  });
});

describe('Sequences', () => {
  /** Next weekday at 10:00 in New York. */
  function nextWindow(now: Date) {
    const p = zonedParts(now, 'America/New_York');
    let day = { year: p.year, month: p.month, day: p.day };
    for (let i = 0; i < 8; i += 1) {
      day = addCalendarDays(day, 1);
      const at = zonedTimeToUtc({ ...day, hour: 10, minute: 0 }, 'America/New_York');
      const weekday = zonedParts(at, 'America/New_York').weekday;
      if (weekday >= 1 && weekday <= 5) return at;
    }
    throw new Error('unreachable');
  }

  async function setup(features: Parameters<typeof connectedUser>[2] = ['mail_read', 'drafts', 'organize', 'send'], options: { trackOpens?: boolean } = {}) {
    const h = await createIntelHarness(options.trackOpens ? { env: { TRACKER_BASE_URL: 'https://t.test' } } : {});
    const user = await connectedUser(h, ADA, features);
    await h.route('controlSuppressionUpdate', user.token, { email: 'optout@x.test', action: 'add' });
    const { id } = await h.route<{ id: string }>('controlSequenceSave', user.token, {
      name: 'Pilot outreach',
      accountId: user.accountId,
      window: { start: '09:00', end: '17:00' },
      ...(options.trackOpens ? { trackOpens: true } : {}),
      steps: [
        { delayBusinessDays: 0, subject: 'Pilot for {company}', body: 'Hi {first_name},\n\nWould {company} like to try the pilot?' },
        { delayBusinessDays: 2, subject: 'Pilot for {company}', body: 'Hi {first_name}, just checking in.' },
      ],
    });
    const enrolled = await h.route<{ added: number; suppressed: number; invalid: number }>('controlSequenceEnroll', user.token, {
      sequenceId: id,
      recipients: [
        { email: 'kim@a.test', fields: { first_name: 'Kim', company: 'Acme' } },
        { email: 'raj@b.test', fields: { first_name: 'Raj', company: 'Beta' } },
        { email: 'noname@c.test', fields: { company: 'Gamma' } },
        { email: 'optout@x.test', fields: { first_name: 'Opt', company: 'Out' } },
        { email: 'not-an-email', fields: {} },
      ],
    });
    expect(enrolled).toEqual({ added: 3, suppressed: 1, invalid: 1 });
    return { h, user, sequenceId: id };
  }

  it('tracks opens with a fetchable pixel and marks the tracked email sent', async () => {
    const { h, user, sequenceId } = await setup(undefined, { trackOpens: true });
    const started = await h.route<{ approvalId: string }>('controlSequenceStatus', user.token, { sequenceId, status: 'active' });
    await h.route('approvalDecide', user.token, { id: started.approvalId, decision: 'approve', idempotencyKey: 'approve-seq-track1' });
    const window = nextWindow(h.now());
    await h.advance(window.getTime() - h.now().getTime() + 10 * 60_000);
    await h.drain();
    await h.advance(5 * 60_000);
    await h.drain();
    const sent = h.google.account(ADA).sent;
    expect(sent.length).toBeGreaterThan(0);
    // The HTML alternative of each sent message (parseRawMessage returns the text part).
    const htmlOf = (message: string) => {
      const text = Buffer.from(message.replace(/-/g, '+').replace(/_/g, '/'), 'base64').toString('utf8');
      const part = text.split(/--pb_[0-9a-f]+/).find((chunk: string) => /content-type:\s*text\/html/i.test(chunk)) ?? '';
      return Buffer.from(part.slice(part.indexOf('\r\n\r\n') + 4).replace(/\s+/g, ''), 'base64').toString('utf8');
    };
    const raw = sent.map(htmlOf).join('\n');
    const pixels = [...raw.matchAll(/src="https:\/\/t\.test\/open\/(trk_[0-9a-f]{32})"/g)].map((match) => match[1]);
    expect(pixels.length).toBe(sent.length);
    expect(raw).not.toMatch(/display:\s*none/);
    const tracked = await h.store.trackerStoreFor(user.userId).listEmails(10);
    expect(tracked.map((email) => email.tracking_id).sort()).toEqual([...pixels].sort());
    for (const email of tracked) {
      expect(email.status).toBe('SENT');
      expect(email.sent_at).not.toBeNull();
      expect(email.gmail_message_id).toBeTruthy();
    }
  });

  it('needs the separate send permission', async () => {
    const { h, user, sequenceId } = await setup(['mail_read', 'drafts']);
    await expect(h.route('controlSequenceStatus', user.token, { sequenceId, status: 'active' })).rejects.toMatchObject({ code: 'forbidden' });
  });

  it('sends nothing without approval, never sends an unfilled field, and respects the sending window', async () => {
    const { h, user, sequenceId } = await setup();
    const started = await h.route<{ approvalId: string; count: number; blocked: number }>('controlSequenceStatus', user.token, { sequenceId, status: 'active' });
    expect(started).toMatchObject({ count: 2, blocked: 1 });
    const approval = (await h.route<{ approvals: Approval[] }>('approvals', user.token, {})).approvals[0]!;
    expect(approval).toMatchObject({ id: started.approvalId, kind: 'send_email', tier: 3, preview: { to: ['kim@a.test'], subject: 'Pilot for Acme', count: 2 } });
    expect(approval.preview.body).toContain('Hi Kim,');
    await h.drain();
    expect(h.google.account(ADA).sent).toHaveLength(0);

    await h.route('approvalDecide', user.token, { id: approval.id, decision: 'approve', idempotencyKey: 'approve-seq-00001' });
    // Approved on a weekend or at night: the sends wait for the window without using up retries.
    const window = nextWindow(h.now());
    await h.advance(Math.max(0, window.getTime() - 3 * 3_600_000 - h.now().getTime()));
    await h.drain();
    const early = h.google.account(ADA).sent.length;
    const inWindow = zonedParts(h.now(), 'America/New_York');
    if (!(inWindow.weekday >= 1 && inWindow.weekday <= 5 && inWindow.hour >= 9 && inWindow.hour < 17)) expect(early).toBe(0);
    await h.advance(window.getTime() - h.now().getTime() + 10 * 60_000);
    await h.drain();

    const sent = h.google.account(ADA).sent.map((raw) => parseRawMessage(raw));
    expect(sent.map((message) => message.headers.to).sort()).toEqual(['kim@a.test', 'raj@b.test']);
    for (const message of sent) {
      expect(message.headers['list-unsubscribe']).toMatch(/^<https?:\/\/.+\/u\/[A-Za-z0-9_-]+>$/);
      expect(message.headers['list-unsubscribe-post']).toBe('List-Unsubscribe=One-Click');
      expect(message.body).not.toMatch(/\[[A-Z ]+ NEEDED\]/);
    }
    const jobs = await h.sql<{ status: string; attempts: number }>(`select status, attempts from public.jobs where kind = 'sequence.step' and payload ? 'sendId'`);
    expect(jobs).toHaveLength(2);
    expect(jobs.every((job) => job.status === 'succeeded' && job.attempts === 1)).toBe(true);
  });

  it('stops for people who reply or unsubscribe, and unsubscribes only on POST', async () => {
    const { h, user, sequenceId } = await setup();
    const started = await h.route<{ approvalId: string }>('controlSequenceStatus', user.token, { sequenceId, status: 'active' });
    await h.route('approvalDecide', user.token, { id: started.approvalId, decision: 'approve', idempotencyKey: 'approve-seq-00002' });
    const window = nextWindow(h.now());
    await h.advance(window.getTime() - h.now().getTime() + 10 * 60_000);
    await h.drain();
    // Sends are spaced a few minutes apart.
    await h.advance(5 * 60_000);
    await h.drain();
    const sent = h.google.account(ADA).sent.map((raw) => parseRawMessage(raw));
    const kimThread = [...h.google.account(ADA).messages.values()].find((message) => message.headers.To === 'kim@a.test')!.threadId;

    // Kim replies.
    await deliverAndSync(h, ADA, { from: 'kim@a.test', to: [ADA], subject: 'Re: Pilot for Acme', body: 'Yes, interested!', threadId: kimThread });
    // Raj's link is prefetched by a scanner (GET), then Raj clicks unsubscribe (POST).
    const rajLink = sent.find((message) => message.headers.to === 'raj@b.test')!.headers['list-unsubscribe']!.slice(1, -1);
    const path = new URL(rajLink).pathname;
    const confirm = await h.api(new Request(`${API}${path}`));
    expect(await confirm.text()).toContain('<form method="post"');
    expect(await h.sql(`select 1 from public.suppressions where email_normalized = 'raj@b.test'`)).toHaveLength(0);
    const done = await h.api(new Request(`${API}${path}`, { method: 'POST', body: 'List-Unsubscribe=One-Click', headers: { 'Content-Type': 'application/x-www-form-urlencoded' } }));
    expect(await done.text()).toContain('You are unsubscribed');

    const enrollments = await h.sql<{ email: string; status: string }>(`select email, status from public.sequence_enrollments order by email`);
    expect(Object.fromEntries(enrollments.map((row) => [row.email, row.status]))).toMatchObject({ 'kim@a.test': 'replied', 'raj@b.test': 'unsubscribed' });

    // Two business days later nobody is left for step 2, so nothing is even proposed.
    await h.advance(3 * 86_400_000);
    await h.drain();
    await h.advance(2 * 86_400_000);
    await h.drain();
    expect((await h.route<{ approvals: Approval[] }>('approvals', user.token, {})).approvals).toHaveLength(0);
    expect(h.google.account(ADA).sent).toHaveLength(2);
  });
});
