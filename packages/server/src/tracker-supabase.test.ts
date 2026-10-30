/**
 * The hosted tracker over the production Supabase store (`SupabaseCloudStore`)
 * and the real migrations: PostgREST is emulated on PGlite, so ownership
 * triggers, foreign keys, cascades and constraints all run. Covers the
 * lifecycle, protocol v3 self-view suppression, per-account isolation,
 * entitlements and account deletion.
 */
import type { PGlite } from '@electric-sql/pglite';
import { SignJWT } from 'jose';
import { beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { DevAuthProvider, devUserId } from './auth.js';
import { loadConfig } from './config.js';
import { SupabaseCloudStore } from './store/supabase.js';
import { testEnv, TRACKER } from './testing.js';
import { createPglite, seedUsers } from './testing/database.js';
import { postgrestFetch } from './testing/postgrest.js';
import { createTrackerHandler } from './tracker.js';

const CHROME = 'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/130.0.0.0 Safari/537.36';
const PROXY = 'Mozilla/5.0 (Windows NT 5.1; rv:11.0) Gecko Firefox/11.0 (via ggpht.com GoogleImageProxy)';
const SENDER_IP = '203.0.113.10';
const RECIPIENT_IP = '198.51.100.20';

let pg: PGlite;
let tracker: ReturnType<typeof createTrackerHandler>;
let deferred: Promise<unknown>[];
const config = loadConfig(testEnv());
const users: Record<'ada' | 'bob' | 'eve', { id: string; email: string; token: string }> = {} as never;

async function token(email: string, id: string): Promise<string> {
  return new SignJWT({ email })
    .setProtectedHeader({ alg: 'HS256' })
    .setSubject(id)
    .setIssuer('pigeonbox-dev')
    .setAudience('authenticated')
    .setIssuedAt()
    .setExpirationTime(Math.floor(Date.now() / 1000) + 3600)
    .sign(new TextEncoder().encode(config.auth.devSecret!));
}

function call(path: string, init: { method?: string; body?: unknown; token?: string; headers?: Record<string, string>; defer?: boolean } = {}) {
  const headers: Record<string, string> = { ...(init.headers ?? {}) };
  if (init.token) headers.Authorization = `Bearer ${init.token}`;
  if (init.body !== undefined) headers['Content-Type'] = 'application/json';
  const request = new Request(`${TRACKER}${path}`, { method: init.method ?? (init.body === undefined ? 'GET' : 'POST'), headers, body: init.body === undefined ? undefined : JSON.stringify(init.body) });
  return tracker(request, init.defer ? { waitUntil: (task) => void deferred.push(task) } : undefined);
}

async function json<T>(response: Promise<Response> | Response): Promise<T> {
  return (await (await response).json()) as T;
}

type Created = { tracking_id: string; pixel_url: string; rewritten_links: Array<{ click_id: string; tracked_url: string }> };
type Email = { tracking_id: string; status: string; open_count: number; click_count: number; first_clicked_at: string | null; sent_at: string | null };

async function createSent(who: { token: string }, opts: { links?: string[]; sentAgoMs?: number; recipients?: string[] } = {}): Promise<Created> {
  const created = await json<Created>(call('/api/emails', {
    token: who.token,
    body: { subject: 'Project update', sender: 'ada@example.com', recipients: opts.recipients ?? ['dana@example.com'], links: (opts.links ?? []).map((url) => ({ url })) },
  }));
  const sent = await call(`/api/emails/${created.tracking_id}`, {
    token: who.token,
    method: 'PATCH',
    body: { status: 'SENT', sent_at: new Date(Date.now() - (opts.sentAgoMs ?? 10 * 60_000)).toISOString(), gmail_thread_id: 'thread-f:1', gmail_message_id: 'msg-f:2' },
  });
  expect(sent.status).toBe(200);
  return created;
}

const pixel = (created: Created, ua: string, ip?: string, defer = false) =>
  call(new URL(created.pixel_url).pathname, { headers: { 'User-Agent': ua, ...(ip ? { 'CF-Connecting-IP': ip } : {}) }, defer });

beforeAll(async () => {
  pg = await createPglite();
  for (const name of ['ada', 'bob', 'eve'] as const) {
    const email = `${name}@example.com`;
    const id = await devUserId(email);
    users[name] = { id, email, token: await token(email, id) };
  }
  await seedUsers(pg, Object.values(users));
  const store = new SupabaseCloudStore('https://db.test', 'service-role-test', postgrestFetch(pg));
  tracker = createTrackerHandler({ config, store, auth: new DevAuthProvider(config), log: () => undefined });
}, 60_000);

beforeEach(async () => {
  deferred = [];
});

describe('hosted tracker on the Supabase store', () => {
  it('runs the send, open and click lifecycle with owner-stamped rows', async () => {
    const created = await createSent(users.ada, { links: ['https://example.com/doc?a=1&b=2'] });
    expect(created.tracking_id).toMatch(/^trk_[0-9a-f]{32}$/);
    expect((await pixel(created, CHROME, RECIPIENT_IP)).headers.get('content-type')).toBe('image/gif');
    const click = await call(new URL(created.rewritten_links[0]!.tracked_url).pathname, { headers: { 'User-Agent': CHROME, 'CF-Connecting-IP': RECIPIENT_IP } });
    expect(click.status).toBe(302);
    expect(click.headers.get('location')).toBe('https://example.com/doc?a=1&b=2');

    const email = await json<Email>(call(`/api/emails/${created.tracking_id}`, { token: users.ada.token }));
    expect(email).toMatchObject({ status: 'SENT', open_count: 1, click_count: 1 });
    expect(email.first_clicked_at).not.toBeNull();
    const owners = await pg.query<{ user_id: string; ip_hash: string }>(`select user_id, ip_hash from public.tracking_events where tracking_id = $1`, [created.tracking_id]);
    expect(owners.rows).toHaveLength(2);
    expect(new Set(owners.rows.map((row) => row.user_id))).toEqual(new Set([users.ada.id]));
    expect(JSON.stringify(owners.rows)).not.toContain(RECIPIENT_IP);
  });

  it('suppresses the sender’s own views, including a claim that arrives after the pixel', async () => {
    const created = await createSent(users.ada);
    const selfView = (source: string, id: string) =>
      json<{ ok: boolean; open_count: number; reclassifiedEventIds: string[] }>(call(`/api/emails/${created.tracking_id}/self-view`, {
        token: users.ada.token,
        headers: { 'User-Agent': CHROME, 'CF-Connecting-IP': SENDER_IP },
        body: { source, selfViewEventId: id, gmailMessageId: 'msg-f:2', timestamp: new Date().toISOString() },
      }));

    // Claim first, then the sender's own browser fetch: not an open.
    expect((await selfView('MESSAGE_EXPANDED', `sv_${created.tracking_id}_1`)).ok).toBe(true);
    await pixel(created, CHROME, SENDER_IP);
    expect((await json<Email>(call(`/api/emails/${created.tracking_id}`, { token: users.ada.token }))).open_count).toBe(0);

    // A recipient on another network counts once.
    await pixel(created, CHROME, RECIPIENT_IP);
    expect((await json<Email>(call(`/api/emails/${created.tracking_id}`, { token: users.ada.token }))).open_count).toBe(1);

    // Race: the sender's pixel lands, then the delayed claim reclassifies it.
    const later = await createSent(users.ada);
    await pixel(later, CHROME, SENDER_IP);
    expect((await json<Email>(call(`/api/emails/${later.tracking_id}`, { token: users.ada.token }))).open_count).toBe(1);
    const reclassified = await json<{ open_count: number; reclassifiedEventIds: string[] }>(call(`/api/emails/${later.tracking_id}/self-view`, {
      token: users.ada.token,
      headers: { 'User-Agent': CHROME, 'CF-Connecting-IP': SENDER_IP },
      body: { source: 'MESSAGE_LOAD', selfViewEventId: `sv_${later.tracking_id}_1` },
    }));
    expect(reclassified.reclassifiedEventIds).toHaveLength(1);
    expect(reclassified.open_count).toBe(0);
    // Retrying the same claim delivery changes nothing.
    const retry = await json<{ open_count: number; reclassifiedEventIds: string[] }>(call(`/api/emails/${later.tracking_id}/self-view`, {
      token: users.ada.token,
      headers: { 'User-Agent': CHROME, 'CF-Connecting-IP': SENDER_IP },
      body: { source: 'MESSAGE_LOAD', selfViewEventId: `sv_${later.tracking_id}_1` },
    }));
    expect(retry).toMatchObject({ open_count: 0, reclassifiedEventIds: reclassified.reclassifiedEventIds });
  });

  it('does not count Gmail’s delivery prefetch or scanners', async () => {
    const fresh = await createSent(users.ada, { sentAgoMs: 2_000 });
    await pixel(fresh, PROXY);
    await pixel(fresh, 'Barracuda-Url-Scanner/1.0');
    const events = await json<Array<{ classification: string }>>(call(`/api/emails/${fresh.tracking_id}/events`, { token: users.ada.token }));
    expect(events.map((event) => event.classification).sort()).toEqual(['MACHINE_LIKELY', 'MACHINE_LIKELY']);
    expect((await json<Email>(call(`/api/emails/${fresh.tracking_id}`, { token: users.ada.token }))).open_count).toBe(0);
  });

  it('records after the response when the Worker defers bookkeeping', async () => {
    const created = await createSent(users.ada);
    expect((await pixel(created, PROXY, undefined, true)).status).toBe(200);
    expect(deferred).toHaveLength(1);
    await Promise.all(deferred);
    expect((await json<Email>(call(`/api/emails/${created.tracking_id}`, { token: users.ada.token }))).open_count).toBe(1);
  });

  it('keeps counters exact past 200 events', async () => {
    const created = await createSent(users.ada, { sentAgoMs: 24 * 3_600_000 });
    const base = Date.now() - 23 * 3_600_000;
    const values = Array.from({ length: 230 }, (_, i) => `('evt_bulk_${created.tracking_id}_${i}', '${created.tracking_id}', 'OPEN', '${new Date(base + i * 60_000).toISOString()}', '${PROXY}', false, 0.8, 'PROXY_LIKELY')`);
    await pg.query(`insert into public.tracking_events (id, tracking_id, type, timestamp, user_agent, suspected_self_open, confidence, classification) values ${values.join(',')}`);
    await pixel(created, PROXY);
    expect((await json<Email>(call(`/api/emails/${created.tracking_id}`, { token: users.ada.token }))).open_count).toBe(231);
  });
});

describe('per-account isolation on the Supabase store', () => {
  it('gives another account nothing for a known tracking ID', async () => {
    const ada = await createSent(users.ada, { links: ['https://example.com/a'] });
    const bob = users.bob.token;
    expect((await call(`/api/emails/${ada.tracking_id}`, { token: bob })).status).toBe(404);
    expect((await call(`/api/emails/${ada.tracking_id}`, { token: bob, method: 'PATCH', body: { subject: 'hijacked', status: 'CANCELLED' } })).status).toBe(404);
    expect((await call(`/api/emails/${ada.tracking_id}`, { token: bob, method: 'PATCH', body: { links: [{ click_id: 'clk_bob', url: 'https://evil.example' }] } })).status).toBe(404);
    expect(await json(call(`/api/emails/${ada.tracking_id}/events`, { token: bob }))).toEqual([]);
    expect((await call(`/api/emails/${ada.tracking_id}/self-view`, { token: bob, body: { source: 'MESSAGE_EXPANDED' } })).status).toBe(404);
    const bobList = await json<Array<{ tracking_id: string }>>(call('/api/emails?limit=200', { token: bob }));
    expect(bobList.map((row) => row.tracking_id)).not.toContain(ada.tracking_id);
    const bobRecent = await json<Array<{ tracking_id: string }>>(call('/api/events/recent', { token: bob }));
    expect(bobRecent.map((row) => row.tracking_id)).not.toContain(ada.tracking_id);
    const row = await pg.query<{ subject: string; status: string }>(`select subject, status from public.tracked_emails where tracking_id = $1`, [ada.tracking_id]);
    expect(row.rows[0]).toEqual({ subject: 'Project update', status: 'SENT' });
    expect((await pg.query(`select 1 from public.tracked_links where click_id = 'clk_bob'`)).rows).toHaveLength(0);
  });

  it('cannot take over another account’s self-view claim by reusing its ID', async () => {
    const ada = await createSent(users.ada);
    const shared = `sv_shared_${ada.tracking_id.slice(4, 12)}`;
    await call(`/api/emails/${ada.tracking_id}/self-view`, { token: users.ada.token, headers: { 'User-Agent': CHROME, 'CF-Connecting-IP': SENDER_IP }, body: { source: 'MESSAGE_EXPANDED', selfViewEventId: shared } });
    const bob = await createSent(users.bob);
    const attempt = await call(`/api/emails/${bob.tracking_id}/self-view`, { token: users.bob.token, headers: { 'User-Agent': CHROME, 'CF-Connecting-IP': '192.0.2.1' }, body: { source: 'MESSAGE_EXPANDED', selfViewEventId: shared } });
    expect(attempt.status).toBe(503);
    expect(await attempt.text()).toBe(JSON.stringify({ error: 'store_unavailable' }));
    const claim = await pg.query<{ tracking_id: string; user_id: string }>(`select tracking_id, user_id from public.tracking_self_view_claims where id = $1`, [`clm_${shared}`]);
    expect(claim.rows[0]).toEqual({ tracking_id: ada.tracking_id, user_id: users.ada.id });
  });

  it('lets the database refuse moving any tracking row to another account', async () => {
    const ada = await createSent(users.ada, { links: ['https://example.com/x'] });
    const bob = await createSent(users.bob);
    await call(`/api/emails/${ada.tracking_id}/self-view`, { token: users.ada.token, headers: { 'User-Agent': CHROME, 'CF-Connecting-IP': SENDER_IP }, body: { source: 'MESSAGE_EXPANDED', selfViewEventId: `sv_move_${ada.tracking_id}` } });
    await pixel(ada, CHROME, RECIPIENT_IP);
    for (const [table, key, id] of [
      ['tracked_links', 'click_id', ada.rewritten_links[0]!.click_id],
      ['tracking_self_view_claims', 'id', `clm_sv_move_${ada.tracking_id}`],
    ] as const) {
      await expect(pg.query(`update public.${table} set tracking_id = $1, user_id = $2 where ${key} = $3`, [bob.tracking_id, users.bob.id, id])).rejects.toThrow(/immutable/);
    }
    await expect(pg.query(`update public.tracking_events set user_id = $1 where tracking_id = $2`, [users.bob.id, ada.tracking_id])).rejects.toThrow(/immutable/);
    await expect(pg.query(`update public.tracked_emails set user_id = $1 where tracking_id = $2`, [users.bob.id, ada.tracking_id])).rejects.toThrow(/immutable/);
  });
});

describe('entitlements and account lifecycle', () => {
  it('keeps sent mail tracked and its links working', async () => {
    expect((await call('/api/emails', { token: users.eve.token })).status).toBe(200);
    const created = await createSent(users.ada, { links: ['https://example.com/kept'] });
    expect((await call(`/api/emails/${created.tracking_id}`, { token: users.ada.token })).status).toBe(200);
    expect((await pixel(created, CHROME, RECIPIENT_IP)).status).toBe(200);
    const click = await call(new URL(created.rewritten_links[0]!.tracked_url).pathname, { headers: { 'User-Agent': CHROME } });
    expect(click.headers.get('location')).toBe('https://example.com/kept');
    const counts = await pg.query<{ open_count: number; click_count: number }>(`select open_count, click_count from public.tracked_emails where tracking_id = $1`, [created.tracking_id]);
    expect(counts.rows[0]).toEqual({ open_count: 1, click_count: 1 });
  });

  it('deletes every tracking row with the account and leaves other accounts alone', async () => {
    const eveId = users.eve.id;
    const eve = await createSent(users.eve, { links: ['https://example.com/e'] });
    await call(`/api/emails/${eve.tracking_id}/self-view`, { token: users.eve.token, body: { source: 'MESSAGE_EXPANDED' } });
    await pixel(eve, CHROME, RECIPIENT_IP);
    const bob = await createSent(users.bob);
    await pg.query(`delete from public.profiles where id = $1`, [eveId]);
    for (const table of ['tracked_emails', 'tracked_links', 'tracking_events', 'tracking_self_view_claims']) {
      expect((await pg.query(`select 1 from public.${table} where user_id = $1`, [eveId])).rows, table).toHaveLength(0);
    }
    expect((await pg.query(`select 1 from public.tracked_emails where tracking_id = $1`, [bob.tracking_id])).rows).toHaveLength(1);
    // The deleted email's public URLs now reveal nothing.
    expect((await pixel(eve, CHROME)).headers.get('content-type')).toBe('image/gif');
    expect((await call(new URL(eve.rewritten_links[0]!.tracked_url).pathname)).status).toBe(404);
  });
});
