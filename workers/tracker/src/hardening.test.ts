/**
 * Internet-facing behavior of the shared tracker handler: bounded input,
 * safe errors, link redirects, counters over long histories and deferred
 * bookkeeping. Protocol v3 classification is covered in memory.test.ts.
 */
import { describe, expect, it } from 'vitest';
import { createMemoryState, createMemoryStore, handleTrackerRequest, MAX_BODY_BYTES, StoreError, type TrackerDeps, type TrackerStore } from './index';

const ORIGIN = 'https://t.example';
const CHROME_UA = 'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/130.0.0.0 Safari/537.36';
const PROXY_UA = 'Mozilla/5.0 (Windows NT 5.1; rv:11.0) Gecko Firefox/11.0 (via ggpht.com GoogleImageProxy)';

function setup(overrides: Partial<TrackerDeps> = {}) {
  const store = createMemoryStore(createMemoryState());
  const deps: TrackerDeps = { publicStore: store, authorize: async () => ({ store }), ipSalt: 'salt', ...overrides };
  const call = (path: string, init: RequestInit & { headers?: Record<string, string> } = {}) =>
    handleTrackerRequest(new Request(`${ORIGIN}${path}`, init), deps);
  const send = (path: string, method: string, body: unknown) =>
    call(path, { method, headers: { 'Content-Type': 'application/json' }, body: typeof body === 'string' ? body : JSON.stringify(body) });
  return { store, deps, call, send };
}

async function createSent(t: ReturnType<typeof setup>, sentAgoMs = 10 * 60_000, links: string[] = []) {
  const created = (await (await t.send('/api/emails', 'POST', { subject: 'Plan', sender: 'me@example.com', recipients: ['r@example.com'], links: links.map((url) => ({ url })) })).json()) as {
    tracking_id: string;
    rewritten_links: Array<{ click_id: string; tracked_url: string }>;
  };
  await t.send(`/api/emails/${created.tracking_id}`, 'PATCH', { status: 'SENT', sent_at: new Date(Date.now() - sentAgoMs).toISOString() });
  return created;
}

describe('management input', () => {
  it('rejects invalid JSON and schema violations with 400, not 500', async () => {
    const t = setup();
    expect((await t.send('/api/emails', 'POST', '{not json')).status).toBe(400);
    expect((await t.send('/api/emails', 'POST', { subject: 'x' })).status).toBe(400);
    expect((await t.send('/api/emails', 'POST', { subject: 'x', sender: 'a', recipients: [], extra: true })).status).toBe(400);
    const res = await t.send('/api/emails', 'POST', { subject: 'x', sender: 'a', recipients: ['b@example.com'], links: [{ url: 'not a url' }] });
    expect(res.status).toBe(400);
    expect(await res.json()).toEqual({ error: 'bad_request' });
  });

  it('refuses bodies over the size limit', async () => {
    const t = setup();
    const huge = JSON.stringify({ subject: 'x'.repeat(MAX_BODY_BYTES), sender: 'a', recipients: ['b@example.com'] });
    expect((await t.send('/api/emails', 'POST', huge)).status).toBe(413);
  });

  it('validates IDs on every management route', async () => {
    const t = setup();
    for (const path of ['/api/emails/bad%20id', '/api/emails/bad.id/events']) {
      expect((await t.call(path)).status).toBe(400);
    }
    expect((await t.send('/api/emails/a.b', 'PATCH', { subject: 'x' })).status).toBe(400);
    expect((await t.send('/api/emails/a.b/self-view', 'POST', {})).status).toBe(400);
  });

  it('rejects an unknown self-view source and ignores a malformed idempotency key', async () => {
    const t = setup();
    const { tracking_id } = await createSent(t);
    expect((await t.send(`/api/emails/${tracking_id}/self-view`, 'POST', { source: 'GUESS' })).status).toBe(400);
    const res = (await (await t.send(`/api/emails/${tracking_id}/self-view`, 'POST', { source: 'MESSAGE_EXPANDED', selfViewEventId: '../../x' })).json()) as { claimId: string };
    expect(res.claimId).toMatch(/^clm_[0-9a-f]{32}$/);
  });

  it('never returns store error details', async () => {
    const failing = createMemoryStore(createMemoryState());
    const broken: TrackerStore = {
      ...failing,
      listEmails: async () => {
        throw new StoreError('duplicate key value violates unique constraint "secret_detail"');
      },
    };
    const t = setup({ authorize: async () => ({ store: broken }) });
    const res = await t.call('/api/emails');
    expect(res.status).toBe(503);
    const text = await res.text();
    expect(text).toBe(JSON.stringify({ error: 'store_unavailable' }));
    expect(res.headers.get('x-content-type-options')).toBe('nosniff');
  });
});

describe('sent state', () => {
  it('keeps SENT final when a late cancel arrives', async () => {
    const t = setup();
    const { tracking_id } = await createSent(t);
    const after = (await (await t.send(`/api/emails/${tracking_id}`, 'PATCH', { status: 'CANCELLED' })).json()) as { status: string; sent_at: string | null };
    expect(after.status).toBe('SENT');
    expect(after.sent_at).not.toBeNull();
  });

  it('clamps a send time from a fast client clock to the tracker clock', async () => {
    const t = setup();
    const created = (await (await t.send('/api/emails', 'POST', { subject: 'x', sender: 'a', recipients: ['b@example.com'] })).json()) as { tracking_id: string };
    const before = Date.now();
    const res = (await (await t.send(`/api/emails/${created.tracking_id}`, 'PATCH', { status: 'SENT', sent_at: new Date(before + 3_600_000).toISOString() })).json()) as { sent_at: string };
    expect(Date.parse(res.sent_at)).toBeLessThanOrEqual(Date.now());
    expect(Date.parse(res.sent_at)).toBeGreaterThanOrEqual(before);
    expect((await t.send(`/api/emails/${created.tracking_id}`, 'PATCH', { sent_at: 'yesterday' })).status).toBe(400);
  });
});

describe('links', () => {
  it('registers a client-allocated link once, however often the send is retried', async () => {
    const t = setup();
    const { tracking_id } = await createSent(t);
    const links = [{ click_id: 'clk_0123456789abcdef', url: 'https://example.com/a' }];
    expect((await t.send(`/api/emails/${tracking_id}`, 'PATCH', { links })).status).toBe(200);
    expect((await t.send(`/api/emails/${tracking_id}`, 'PATCH', { links })).status).toBe(200);
    expect(await t.store.getLink('clk_0123456789abcdef')).toMatchObject({ tracking_id, destination: 'https://example.com/a' });
  });

  it('refuses a click ID that already belongs to another email', async () => {
    const t = setup();
    const a = await createSent(t);
    const b = await createSent(t);
    const links = [{ click_id: 'clk_shared', url: 'https://example.com/a' }];
    expect((await t.send(`/api/emails/${a.tracking_id}`, 'PATCH', { links })).status).toBe(200);
    expect((await t.send(`/api/emails/${b.tracking_id}`, 'PATCH', { links })).status).toBe(409);
    expect((await t.store.getLink('clk_shared'))?.tracking_id).toBe(a.tracking_id);
  });

  it('redirects only stored http(s) links and shows recipients plain text otherwise', async () => {
    const t = setup();
    const { rewritten_links } = await createSent(t, 60_000, ['https://example.com/doc?x=1#part']);
    const click = await t.call(new URL(rewritten_links[0]!.tracked_url).pathname, { headers: { 'User-Agent': CHROME_UA } });
    expect(click.status).toBe(302);
    expect(click.headers.get('location')).toBe('https://example.com/doc?x=1#part');
    expect(click.headers.get('cache-control')).toBe('no-store');
    expect(click.headers.get('referrer-policy')).toBe('no-referrer');

    for (const [path, status] of [['/c/clk_unknown', 404], ['/c/bad.id', 400], ['/c/', 400]] as const) {
      const res = await t.call(path);
      expect(res.status).toBe(status);
      expect(res.headers.get('content-type')).toContain('text/plain');
      expect(res.headers.get('location')).toBeNull();
    }

    // A stored row with an unsafe destination never redirects.
    await t.store.insertLink({ click_id: 'clk_js', tracking_id: (await createSent(t)).tracking_id, destination: 'javascript:alert(1)' });
    const unsafe = await t.call('/c/clk_js');
    expect(unsafe.status).toBe(400);
    expect(unsafe.headers.get('location')).toBeNull();
  });

  it('still redirects when click bookkeeping fails', async () => {
    const t = setup();
    const { rewritten_links } = await createSent(t, 60_000, ['https://example.com/doc']);
    t.store.insertEvent = async () => {
      throw new StoreError('down');
    };
    const click = await t.call(new URL(rewritten_links[0]!.tracked_url).pathname, { headers: { 'User-Agent': CHROME_UA } });
    expect(click.status).toBe(302);
  });
});

describe('open bookkeeping', () => {
  it('returns the image for malformed, unknown and failing IDs', async () => {
    const t = setup();
    for (const id of ['bad.id', 'trk_unknown', 'x'.repeat(81)]) {
      const res = await t.call(`/open/${id}`);
      expect(res.status).toBe(200);
      expect(res.headers.get('content-type')).toBe('image/gif');
      expect(res.headers.get('cache-control')).toContain('no-store');
    }
    const { tracking_id } = await createSent(t);
    t.store.listClaims = async () => {
      throw new StoreError('down');
    };
    expect((await t.call(`/open/${tracking_id}`, { headers: { 'User-Agent': CHROME_UA } })).status).toBe(200);
  });

  it('derives counters from the whole history, not the newest 200 events', async () => {
    const t = setup();
    const { tracking_id } = await createSent(t, 24 * 3_600_000);
    const base = Date.now() - 23 * 3_600_000;
    for (let i = 0; i < 260; i += 1) {
      await t.store.insertEvent({
        id: `evt_${i}`,
        tracking_id,
        type: 'OPEN',
        timestamp: new Date(base + i * 60_000).toISOString(),
        user_agent: PROXY_UA,
        ip_hash: null,
        suspected_self_open: false,
        confidence: 0.8,
        classification: 'PROXY_LIKELY',
      });
    }
    await t.call(`/open/${tracking_id}`, { headers: { 'User-Agent': PROXY_UA } });
    const email = (await (await t.call(`/api/emails/${tracking_id}`)).json()) as { open_count: number; first_opened_at: string };
    expect(email.open_count).toBe(261);
    expect(email.first_opened_at).toBe(new Date(base).toISOString());
  });

  it('responds before deferred bookkeeping runs, and the bookkeeping still lands', async () => {
    const deferred: Promise<unknown>[] = [];
    const t = setup({ defer: (task) => void deferred.push(task) });
    const { tracking_id, rewritten_links } = await createSent(t, 60_000, ['https://example.com/doc']);
    const pixel = await t.call(`/open/${tracking_id}`, { headers: { 'User-Agent': CHROME_UA, 'CF-Connecting-IP': '198.51.100.7' } });
    expect(pixel.status).toBe(200);
    const click = await t.call(new URL(rewritten_links[0]!.tracked_url).pathname, { headers: { 'User-Agent': CHROME_UA } });
    expect(click.status).toBe(302);
    expect(deferred).toHaveLength(2);
    await Promise.all(deferred);
    const email = (await (await t.call(`/api/emails/${tracking_id}`)).json()) as { open_count: number; click_count: number };
    expect(email).toMatchObject({ open_count: 1, click_count: 1 });
  });

  it('stores a salted hash, never the client IP', async () => {
    const t = setup();
    const { tracking_id } = await createSent(t);
    await t.call(`/open/${tracking_id}`, { headers: { 'User-Agent': CHROME_UA, 'CF-Connecting-IP': '198.51.100.7' } });
    const events = (await (await t.call(`/api/emails/${tracking_id}/events`)).json()) as Array<{ ip_hash: string }>;
    expect(events[0]!.ip_hash).toMatch(/^[0-9a-f]{64}$/);
    expect(JSON.stringify(events)).not.toContain('198.51.100.7');
  });
});
