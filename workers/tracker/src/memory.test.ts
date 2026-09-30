import { beforeEach, describe, expect, it, vi } from 'vitest';
import worker, { type Env } from './index';
import { readMemoryClaims, resetMemoryStore } from './store';

const env: Env = {
  PERSONAL_API_TOKEN: 'test-token',
};

const SENDER_IP = '203.0.113.10';
const RECIPIENT_IP = '198.51.100.20';
const CHROME_UA =
  'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36';

function authHeaders(): Record<string, string> {
  return {
    Authorization: 'Bearer test-token',
    'Content-Type': 'application/json',
  };
}

function browserHeaders(extra?: Record<string, string>): Record<string, string> {
  return {
    'User-Agent': CHROME_UA,
    'X-Forwarded-For': SENDER_IP,
    ...extra,
  };
}

function senderViewHeaders(extra?: Record<string, string>): Record<string, string> {
  return {
    ...authHeaders(),
    'User-Agent': CHROME_UA,
    'X-Forwarded-For': SENDER_IP,
    ...extra,
  };
}

function recipientHeaders(): Record<string, string> {
  return {
    'User-Agent': CHROME_UA,
    'X-Forwarded-For': RECIPIENT_IP,
  };
}

function proxyHeaders(): HeadersInit {
  return {
    'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 GoogleImageProxy',
  };
}

async function createSentTracked(sentAt: string, subject = 'Reload'): Promise<{ tracking_id: string; pixel_url: string }> {
  const created = await worker.fetch(
    new Request('http://127.0.0.1:8787/api/emails', {
      method: 'POST',
      headers: authHeaders(),
      body: JSON.stringify({
        subject,
        sender: 'me@example.com',
        recipients: ['r@example.com'],
        gmail_thread_id: 'thread_reload',
        gmail_message_id: 'msg_reload',
      }),
    }),
    env,
  );
  const body = (await created.json()) as { tracking_id: string; pixel_url: string };
  await worker.fetch(
    new Request(`http://127.0.0.1:8787/api/emails/${body.tracking_id}`, {
      method: 'PATCH',
      headers: authHeaders(),
      body: JSON.stringify({ status: 'SENT', sent_at: sentAt, gmail_message_id: 'msg_reload' }),
    }),
    env,
  );
  return body;
}

async function postSelfView(trackingId: string, body: Record<string, unknown>) {
  const res = await worker.fetch(
    new Request(`http://127.0.0.1:8787/api/emails/${trackingId}/self-view`, {
      method: 'POST',
      headers: senderViewHeaders(),
      body: JSON.stringify(body),
    }),
    env,
  );
  return (await res.json()) as {
    ok: boolean;
    open_count: number;
    reclassifiedEventIds?: string[];
    claimId?: string;
  };
}

async function readOpenCount(trackingId: string): Promise<number> {
  const email = (await (
    await worker.fetch(new Request(`http://127.0.0.1:8787/api/emails/${trackingId}`, { headers: authHeaders() }), env)
  ).json()) as { open_count: number };
  return email.open_count;
}

async function readOpenEvents(trackingId: string) {
  const events = (await (
    await worker.fetch(new Request(`http://127.0.0.1:8787/api/emails/${trackingId}/events`, { headers: authHeaders() }), env)
  ).json()) as Array<{ id: string; type: string; classification?: string; timestamp: string }>;
  return events.filter((event) => event.type === 'OPEN');
}

beforeEach(() => {
  resetMemoryStore();
});

describe('local memory tracker', () => {
  it('reports memory mode on /health without Supabase', async () => {
    const res = await worker.fetch(new Request('http://127.0.0.1:8787/health'), env);
    expect(await res.json()).toEqual({
      ok: true,
      protocolVersion: 3,
      features: ['self_view_claims', 'event_reclassification', 'classified_clicks', 'sender_fingerprint_claims'],
      store: 'memory',
    });
  });

  it('rejects management calls without the token', async () => {
    const res = await worker.fetch(
      new Request('http://127.0.0.1:8787/api/events/recent'),
      env,
    );
    expect(res.status).toBe(401);
  });

  it('records an open and a click redirect', async () => {
    const created = await worker.fetch(
      new Request('http://127.0.0.1:8787/api/emails', {
        method: 'POST',
        headers: authHeaders(),
        body: JSON.stringify({
          subject: 'Hello',
          sender: 'me@example.com',
          recipients: ['you@example.com'],
          links: [{ url: 'https://example.com/docs' }],
        }),
      }),
      env,
    );
    expect(created.status).toBe(200);
    const body = (await created.json()) as {
      tracking_id: string;
      pixel_url: string;
      rewritten_links: Array<{ tracked_url: string }>;
    };
    expect(body.pixel_url).toBe(`http://127.0.0.1:8787/open/${body.tracking_id}`);
    expect(body.rewritten_links).toHaveLength(1);

    const pendingPixel = await worker.fetch(new Request(body.pixel_url), env);
    expect(pendingPixel.status).toBe(200);
    expect(pendingPixel.headers.get('Content-Type')).toContain('image/gif');
    const pending = (await (
      await worker.fetch(new Request(`http://127.0.0.1:8787/api/emails/${body.tracking_id}`, { headers: authHeaders() }), env)
    ).json()) as { open_count: number; status: string; sent_at: string | null };
    expect(pending.status).toBe('PENDING');
    expect(pending.sent_at).toBeNull();
    expect(pending.open_count).toBe(0);

    const sentAt = new Date(Date.now() - 60_000).toISOString();
    const marked = await worker.fetch(
      new Request(`http://127.0.0.1:8787/api/emails/${body.tracking_id}`, {
        method: 'PATCH',
        headers: authHeaders(),
        body: JSON.stringify({ status: 'SENT', sent_at: sentAt }),
      }),
      env,
    );
    expect(marked.status).toBe(200);

    const pixel = await worker.fetch(new Request(body.pixel_url, { headers: browserHeaders() }), env);
    expect(pixel.status).toBe(200);
    expect(pixel.headers.get('Content-Type')).toContain('image/gif');

    const email = await worker.fetch(
      new Request(`http://127.0.0.1:8787/api/emails/${body.tracking_id}`, {
        headers: authHeaders(),
      }),
      env,
    );
    expect(email.status).toBe(200);
    expect(((await email.json()) as { open_count: number }).open_count).toBe(1);

    const click = await worker.fetch(new Request(body.rewritten_links[0].tracked_url), env);
    expect(click.status).toBe(302);
    expect(click.headers.get('Location')).toBe('https://example.com/docs');

    const recent = await worker.fetch(
      new Request('http://127.0.0.1:8787/api/events/recent', { headers: authHeaders() }),
      env,
    );
    const events = (await recent.json()) as Array<{ type: string; classification?: string }>;
    expect(events.filter((event) => event.type === 'CLICK')).toHaveLength(1);
    expect(events.filter((event) => event.type === 'OPEN')).toHaveLength(2);
    expect(events.some((event) => event.classification === 'SELF_LIKELY')).toBe(true);
    expect(events.some((event) => event.classification === 'RECIPIENT_LIKELY')).toBe(true);
  });

  it('lists tracked mail and links a gmail thread without changing opens', async () => {
    const created = await worker.fetch(
      new Request('http://127.0.0.1:8787/api/emails', {
        method: 'POST',
        headers: authHeaders(),
        body: JSON.stringify({
          subject: 'Invoice',
          sender: 'me@example.com',
          recipients: ['you@example.com'],
        }),
      }),
      env,
    );
    const { tracking_id } = (await created.json()) as { tracking_id: string };

    const patched = await worker.fetch(
      new Request(`http://127.0.0.1:8787/api/emails/${tracking_id}`, {
        method: 'PATCH',
        headers: authHeaders(),
        body: JSON.stringify({ gmail_thread_id: 'thread-1', open_count: 9 }),
      }),
      env,
    );
    expect(patched.status).toBe(400);

    const linked = await worker.fetch(
      new Request(`http://127.0.0.1:8787/api/emails/${tracking_id}`, {
        method: 'PATCH',
        headers: authHeaders(),
        body: JSON.stringify({ gmail_thread_id: 'thread-1', gmail_message_id: 'msg-1' }),
      }),
      env,
    );
    expect(linked.status).toBe(200);
    const row = (await linked.json()) as { gmail_thread_id: string; open_count: number };
    expect(row.gmail_thread_id).toBe('thread-1');
    expect(row.open_count).toBe(0);

    const list = await worker.fetch(
      new Request('http://127.0.0.1:8787/api/emails?limit=10', { headers: authHeaders() }),
      env,
    );
    expect(list.status).toBe(200);
    const emails = (await list.json()) as Array<{ tracking_id: string }>;
    expect(emails.map((email) => email.tracking_id)).toContain(tracking_id);
  });

  it('Case A — pre-send fetch: OPEN before sentAt does not count', async () => {
    const created = await worker.fetch(
      new Request('http://127.0.0.1:8787/api/emails', {
        method: 'POST',
        headers: authHeaders(),
        body: JSON.stringify({ subject: 'Case A', sender: 'me@example.com', recipients: ['r@example.com'] }),
      }),
      env,
    );
    const { tracking_id, pixel_url } = (await created.json()) as { tracking_id: string; pixel_url: string };

    // 1. Pixel opens while status is still PENDING
    await worker.fetch(new Request(pixel_url), env);

    const emailPending = (await (
      await worker.fetch(new Request(`http://127.0.0.1:8787/api/emails/${tracking_id}`, { headers: authHeaders() }), env)
    ).json()) as { open_count: number; status: string };
    expect(emailPending.status).toBe('PENDING');
    expect(emailPending.open_count).toBe(0);

    // 2. Event inserted before sentAt timestamp
    const futureSent = new Date(Date.now() + 60_000).toISOString();
    await worker.fetch(
      new Request(`http://127.0.0.1:8787/api/emails/${tracking_id}`, {
        method: 'PATCH',
        headers: authHeaders(),
        body: JSON.stringify({ status: 'SENT', sent_at: futureSent }),
      }),
      env,
    );

    // Fetch pixel when now < sentAt
    await worker.fetch(new Request(pixel_url), env);
    const emailFuture = (await (
      await worker.fetch(new Request(`http://127.0.0.1:8787/api/emails/${tracking_id}`, { headers: authHeaders() }), env)
    ).json()) as { open_count: number };
    expect(emailFuture.open_count).toBe(0);
  });

  it('Case B — legitimate fast recipient: sentAt = T, OPEN = T + 1 second, no SELF_VIEW -> recipient open count = 1', async () => {
    const created = await worker.fetch(
      new Request('http://127.0.0.1:8787/api/emails', {
        method: 'POST',
        headers: authHeaders(),
        body: JSON.stringify({ subject: 'Case B', sender: 'me@example.com', recipients: ['r@example.com'] }),
      }),
      env,
    );
    const { tracking_id, pixel_url } = (await created.json()) as { tracking_id: string; pixel_url: string };

    // sentAt = 1 second ago
    const sentAt = new Date(Date.now() - 1000).toISOString();
    await worker.fetch(
      new Request(`http://127.0.0.1:8787/api/emails/${tracking_id}`, {
        method: 'PATCH',
        headers: authHeaders(),
        body: JSON.stringify({ status: 'SENT', sent_at: sentAt }),
      }),
      env,
    );

    // Recipient opens fast (1 second after send), no SELF_VIEW
    await worker.fetch(new Request(pixel_url, { headers: browserHeaders() }), env);

    const email = (await (
      await worker.fetch(new Request(`http://127.0.0.1:8787/api/emails/${tracking_id}`, { headers: authHeaders() }), env)
    ).json()) as { open_count: number };
    expect(email.open_count).toBe(1);

    const events = (await (
      await worker.fetch(new Request(`http://127.0.0.1:8787/api/emails/${tracking_id}/events`, { headers: authHeaders() }), env)
    ).json()) as Array<{ classification: string }>;
    expect(events[0]?.classification).toBe('RECIPIENT_LIKELY');
  });

  it('Case C — sender views own message: SELF_VIEW = T + 30 seconds, OPEN = SELF_VIEW + small delta -> classified SELF_LIKELY -> recipient open count remains 0', async () => {
    const created = await worker.fetch(
      new Request('http://127.0.0.1:8787/api/emails', {
        method: 'POST',
        headers: authHeaders(),
        body: JSON.stringify({ subject: 'Case C', sender: 'me@example.com', recipients: ['r@example.com'] }),
      }),
      env,
    );
    const { tracking_id, pixel_url } = (await created.json()) as { tracking_id: string; pixel_url: string };

    // Sent 30 seconds ago
    const sentAt = new Date(Date.now() - 30_000).toISOString();
    await worker.fetch(
      new Request(`http://127.0.0.1:8787/api/emails/${tracking_id}`, {
        method: 'PATCH',
        headers: authHeaders(),
        body: JSON.stringify({ status: 'SENT', sent_at: sentAt }),
      }),
      env,
    );

    // Sender views own message: SELF_VIEW reported
    const selfViewTime = new Date().toISOString();
    await worker.fetch(
      new Request(`http://127.0.0.1:8787/api/emails/${tracking_id}/self-view`, {
        method: 'POST',
        headers: senderViewHeaders(),
        body: JSON.stringify({ timestamp: selfViewTime }),
      }),
      env,
    );

    // Pixel loads right after (small delta)
    await worker.fetch(new Request(pixel_url, { headers: browserHeaders() }), env);

    const email = (await (
      await worker.fetch(new Request(`http://127.0.0.1:8787/api/emails/${tracking_id}`, { headers: authHeaders() }), env)
    ).json()) as { open_count: number };
    expect(email.open_count).toBe(0);

    const events = (await (
      await worker.fetch(new Request(`http://127.0.0.1:8787/api/emails/${tracking_id}/events`, { headers: authHeaders() }), env)
    ).json()) as Array<{ type: string; classification: string }>;
    const openEvt = events.find((e) => e.type === 'OPEN');
    expect(openEvt?.classification).toBe('SELF_LIKELY');
  });

  it('Case D — race: OPEN arrives, SELF_VIEW arrives shortly afterward -> reclassification occurs -> final aggregate recipient open count = 0', async () => {
    const created = await worker.fetch(
      new Request('http://127.0.0.1:8787/api/emails', {
        method: 'POST',
        headers: authHeaders(),
        body: JSON.stringify({ subject: 'Case D', sender: 'me@example.com', recipients: ['r@example.com'] }),
      }),
      env,
    );
    const { tracking_id, pixel_url } = (await created.json()) as { tracking_id: string; pixel_url: string };

    await worker.fetch(
      new Request(`http://127.0.0.1:8787/api/emails/${tracking_id}`, {
        method: 'PATCH',
        headers: authHeaders(),
        body: JSON.stringify({ status: 'SENT', sent_at: new Date(Date.now() - 10_000).toISOString() }),
      }),
      env,
    );

    // Pixel fetched before self-view
    await worker.fetch(new Request(pixel_url, { headers: browserHeaders() }), env);
    const emailBefore = (await (
      await worker.fetch(new Request(`http://127.0.0.1:8787/api/emails/${tracking_id}`, { headers: authHeaders() }), env)
    ).json()) as { open_count: number };
    expect(emailBefore.open_count).toBe(1);

    // Self-view arrives shortly afterward (within correlation window)
    const selfViewRes = await worker.fetch(
      new Request(`http://127.0.0.1:8787/api/emails/${tracking_id}/self-view`, {
        method: 'POST',
        headers: senderViewHeaders(),
        body: JSON.stringify({ timestamp: new Date().toISOString() }),
      }),
      env,
    );
    expect(selfViewRes.status).toBe(200);

    const emailAfter = (await (
      await worker.fetch(new Request(`http://127.0.0.1:8787/api/emails/${tracking_id}`, { headers: authHeaders() }), env)
    ).json()) as { open_count: number };
    expect(emailAfter.open_count).toBe(0);
  });

  it('Case E — sender view after recipient open: recipient OPEN -> count = 1, later SELF_VIEW + own pixel fetch -> count remains 1', async () => {
    const created = await worker.fetch(
      new Request('http://127.0.0.1:8787/api/emails', {
        method: 'POST',
        headers: authHeaders(),
        body: JSON.stringify({ subject: 'Case E', sender: 'me@example.com', recipients: ['r@example.com'] }),
      }),
      env,
    );
    const { tracking_id, pixel_url } = (await created.json()) as { tracking_id: string; pixel_url: string };

    await worker.fetch(
      new Request(`http://127.0.0.1:8787/api/emails/${tracking_id}`, {
        method: 'PATCH',
        headers: authHeaders(),
        body: JSON.stringify({ status: 'SENT', sent_at: new Date(Date.now() - 120_000).toISOString() }),
      }),
      env,
    );

    // Recipient opens email
    const openRes = await worker.fetch(new Request(pixel_url, { headers: browserHeaders() }), env);
    expect(openRes.status).toBe(200);

    const emailAfterRecipient = (await (
      await worker.fetch(new Request(`http://127.0.0.1:8787/api/emails/${tracking_id}`, { headers: authHeaders() }), env)
    ).json()) as { open_count: number };
    expect(emailAfterRecipient.open_count).toBe(1);

    // Later (>15s after recipient open), sender views own message
    const laterSelfViewTime = new Date(Date.now() + 30_000).toISOString();
    await worker.fetch(
      new Request(`http://127.0.0.1:8787/api/emails/${tracking_id}/self-view`, {
        method: 'POST',
        headers: senderViewHeaders(),
        body: JSON.stringify({ timestamp: laterSelfViewTime }),
      }),
      env,
    );

    const emailAfterSelfView = (await (
      await worker.fetch(new Request(`http://127.0.0.1:8787/api/emails/${tracking_id}`, { headers: authHeaders() }), env)
    ).json()) as { open_count: number };
    expect(emailAfterSelfView.open_count).toBe(1);
  });

  it('Case F — repeated sender opens: Multiple sender self-views must not inflate recipient count', async () => {
    vi.useFakeTimers();
    try {
      const baseTime = Date.parse('2026-09-24T10:00:00.000Z');
      vi.setSystemTime(baseTime);

      const created = await worker.fetch(
        new Request('http://127.0.0.1:8787/api/emails', {
          method: 'POST',
          headers: authHeaders(),
          body: JSON.stringify({ subject: 'Case F', sender: 'me@example.com', recipients: ['r@example.com'] }),
        }),
        env,
      );
      const { tracking_id, pixel_url } = (await created.json()) as { tracking_id: string; pixel_url: string };

      await worker.fetch(
        new Request(`http://127.0.0.1:8787/api/emails/${tracking_id}`, {
          method: 'PATCH',
          headers: authHeaders(),
          body: JSON.stringify({ status: 'SENT', sent_at: new Date(baseTime - 60_000).toISOString() }),
        }),
        env,
      );

      // Sender views repeatedly (3 times) with advancing time
      for (let i = 0; i < 3; i++) {
        vi.advanceTimersByTime(20_000);
        const now = new Date().toISOString();
        await worker.fetch(
          new Request(`http://127.0.0.1:8787/api/emails/${tracking_id}/self-view`, {
            method: 'POST',
            headers: senderViewHeaders(),
            body: JSON.stringify({ timestamp: now }),
          }),
          env,
        );
        await worker.fetch(new Request(pixel_url, { headers: browserHeaders() }), env);
      }

      const email = (await (
        await worker.fetch(new Request(`http://127.0.0.1:8787/api/emails/${tracking_id}`, { headers: authHeaders() }), env)
      ).json()) as { open_count: number };
      // None of the sender self-views should inflate recipient open count
      expect(email.open_count).toBe(0);
    } finally {
      vi.useRealTimers();
    }
  });

  it('automatic Google-image-proxy fetch stores PROXY_LIKELY and counts as one open', async () => {
    const created = await worker.fetch(
      new Request('http://127.0.0.1:8787/api/emails', {
        method: 'POST',
        headers: authHeaders(),
        body: JSON.stringify({ subject: 'Proxy Test', sender: 'me@example.com', recipients: ['r@example.com'] }),
      }),
      env,
    );
    const { tracking_id, pixel_url } = (await created.json()) as { tracking_id: string; pixel_url: string };

    await worker.fetch(
      new Request(`http://127.0.0.1:8787/api/emails/${tracking_id}`, {
        method: 'PATCH',
        headers: authHeaders(),
        body: JSON.stringify({ status: 'SENT', sent_at: new Date(Date.now() - 60_000).toISOString() }),
      }),
      env,
    );

    // Pixel request with GoogleImageProxy UA
    const pixelRes = await worker.fetch(new Request(pixel_url, { headers: proxyHeaders() }), env);
    expect(pixelRes.status).toBe(200);

    const email = (await (
      await worker.fetch(new Request(`http://127.0.0.1:8787/api/emails/${tracking_id}`, { headers: authHeaders() }), env)
    ).json()) as { open_count: number };
    expect(email.open_count).toBe(1);

    const events = (await (
      await worker.fetch(new Request(`http://127.0.0.1:8787/api/emails/${tracking_id}/events`, { headers: authHeaders() }), env)
    ).json()) as Array<{ type: string; classification: string }>;
    expect(events).toHaveLength(1);
    expect(events[0].classification).toBe('PROXY_LIKELY');
  });

  it('scanner fetch stores MACHINE_LIKELY and does not increment open_count', async () => {
    const created = await worker.fetch(
      new Request('http://127.0.0.1:8787/api/emails', {
        method: 'POST',
        headers: authHeaders(),
        body: JSON.stringify({ subject: 'Scanner Test', sender: 'me@example.com', recipients: ['r@example.com'] }),
      }),
      env,
    );
    const { tracking_id, pixel_url } = (await created.json()) as { tracking_id: string; pixel_url: string };

    await worker.fetch(
      new Request(`http://127.0.0.1:8787/api/emails/${tracking_id}`, {
        method: 'PATCH',
        headers: authHeaders(),
        body: JSON.stringify({ status: 'SENT', sent_at: new Date(Date.now() - 1000).toISOString() }),
      }),
      env,
    );

    // Pixel request with scanner UA
    const pixelRes = await worker.fetch(
      new Request(pixel_url, { headers: { 'User-Agent': 'Barracuda Sentinel Scanner/1.0' } }),
      env,
    );
    expect(pixelRes.status).toBe(200);

    const email = (await (
      await worker.fetch(new Request(`http://127.0.0.1:8787/api/emails/${tracking_id}`, { headers: authHeaders() }), env)
    ).json()) as { open_count: number };
    expect(email.open_count).toBe(0);

    const events = (await (
      await worker.fetch(new Request(`http://127.0.0.1:8787/api/emails/${tracking_id}/events`, { headers: authHeaders() }), env)
    ).json()) as Array<{ type: string; classification: string }>;
    expect(events).toHaveLength(1);
    expect(events[0].classification).toBe('MACHINE_LIKELY');
  });

  it('Self-view reported with gmailThreadId links to email', async () => {
    const created = await worker.fetch(
      new Request('http://127.0.0.1:8787/api/emails', {
        method: 'POST',
        headers: authHeaders(),
        body: JSON.stringify({ subject: 'Link Thread', sender: 'me@example.com', recipients: ['r@example.com'] }),
      }),
      env,
    );
    const { tracking_id } = (await created.json()) as { tracking_id: string };

    const selfViewRes = await worker.fetch(
      new Request(`http://127.0.0.1:8787/api/emails/${tracking_id}/self-view`, {
        method: 'POST',
        headers: senderViewHeaders(),
        body: JSON.stringify({ timestamp: new Date().toISOString(), gmailThreadId: 'thread-xyz' }),
      }),
      env,
    );
    expect(selfViewRes.status).toBe(200);

    const email = (await (
      await worker.fetch(new Request(`http://127.0.0.1:8787/api/emails/${tracking_id}`, { headers: authHeaders() }), env)
    ).json()) as { gmail_thread_id: string };
    expect(email.gmail_thread_id).toBe('thread-xyz');
  });

  it('MV3 background delay: self-view arriving 5s after pixel fetch reclassifies preceding open and resets open_count to 0', async () => {
    const baseTime = Date.parse('2026-09-24T12:00:00.000Z');
    vi.useFakeTimers();
    vi.setSystemTime(baseTime);
    try {
      const created = await worker.fetch(
        new Request('http://127.0.0.1:8787/api/emails', {
          method: 'POST',
          headers: authHeaders(),
          body: JSON.stringify({ subject: 'MV3 Delay Test', sender: 'me@example.com', recipients: ['r@example.com'] }),
        }),
        env,
      );
      const { tracking_id, pixel_url } = (await created.json()) as { tracking_id: string; pixel_url: string };

      // Mark sent
      await worker.fetch(
        new Request(`http://127.0.0.1:8787/api/emails/${tracking_id}`, {
          method: 'PATCH',
          headers: authHeaders(),
          body: JSON.stringify({ status: 'SENT', sent_at: new Date(baseTime).toISOString() }),
        }),
        env,
      );

      // Sender views email at T+10s in content script
      vi.advanceTimersByTime(10_000);
      const observedAtIso = new Date().toISOString();

      // Browser requests tracking pixel at T+10.5s (before MV3 background wakes up)
      vi.advanceTimersByTime(500);
      const pixelRes = await worker.fetch(new Request(pixel_url, { headers: browserHeaders() }), env);
      expect(pixelRes.status).toBe(200);

      // Pixel open is temporarily classified as recipient open before self-view arrives
      const midEmail = (await (
        await worker.fetch(new Request(`http://127.0.0.1:8787/api/emails/${tracking_id}`, { headers: authHeaders() }), env)
      ).json()) as { open_count: number };
      expect(midEmail.open_count).toBe(1);

      // MV3 background service worker wakes up 4.5s later (T+15s) and delivers the content interaction timestamp (T+10s)
      vi.advanceTimersByTime(4500);
      const selfViewRes = await worker.fetch(
        new Request(`http://127.0.0.1:8787/api/emails/${tracking_id}/self-view`, {
          method: 'POST',
          headers: senderViewHeaders(),
          body: JSON.stringify({ timestamp: observedAtIso }),
        }),
        env,
      );
      expect(selfViewRes.status).toBe(200);
      const selfViewBody = (await selfViewRes.json()) as { ok: boolean; open_count: number };
      expect(selfViewBody.ok).toBe(true);
      expect(selfViewBody.open_count).toBe(0);

      // Verified: Email open_count is reverted to 0
      const finalEmail = (await (
        await worker.fetch(new Request(`http://127.0.0.1:8787/api/emails/${tracking_id}`, { headers: authHeaders() }), env)
      ).json()) as { open_count: number; first_opened_at: string | null };
      expect(finalEmail.open_count).toBe(0);
      expect(finalEmail.first_opened_at).toBeNull();

      // Event classification was updated to SELF_LIKELY with suspected_self_open: true
      const events = (await (
        await worker.fetch(new Request(`http://127.0.0.1:8787/api/emails/${tracking_id}/events`, { headers: authHeaders() }), env)
      ).json()) as Array<{ type: string; classification: string; suspected_self_open: boolean }>;
      const openEvent = events.find((e) => e.type === 'OPEN');
      expect(openEvent?.classification).toBe('SELF_LIKELY');
      expect(openEvent?.suspected_self_open).toBe(true);
    } finally {
      vi.useRealTimers();
    }
  });

  it('Self-view preserves payload timestamp over server arrival time, and falls back to now when omitted', async () => {
    const created = await worker.fetch(
      new Request('http://127.0.0.1:8787/api/emails', {
        method: 'POST',
        headers: authHeaders(),
        body: JSON.stringify({ subject: 'Timestamp Test', sender: 'me@example.com', recipients: ['r@example.com'] }),
      }),
      env,
    );
    const { tracking_id } = (await created.json()) as { tracking_id: string };

    const customTs = '2026-09-24T08:15:30.000Z';
    await worker.fetch(
      new Request(`http://127.0.0.1:8787/api/emails/${tracking_id}/self-view`, {
        method: 'POST',
        headers: senderViewHeaders(),
        body: JSON.stringify({ timestamp: customTs }),
      }),
      env,
    );

    let events = (await (
      await worker.fetch(new Request(`http://127.0.0.1:8787/api/emails/${tracking_id}/events`, { headers: authHeaders() }), env)
    ).json()) as Array<{ type: string; timestamp: string }>;
    expect(events).toHaveLength(1);
    expect(events[0].timestamp).toBe(customTs);

    // Now test fallback when timestamp is omitted
    const created2 = await worker.fetch(
      new Request('http://127.0.0.1:8787/api/emails', {
        method: 'POST',
        headers: authHeaders(),
        body: JSON.stringify({ subject: 'Fallback Test', sender: 'me@example.com', recipients: ['r@example.com'] }),
      }),
      env,
    );
    const { tracking_id: tracking_id_2 } = (await created2.json()) as { tracking_id: string };

    const before = Date.now();
    await worker.fetch(
      new Request(`http://127.0.0.1:8787/api/emails/${tracking_id_2}/self-view`, {
        method: 'POST',
        headers: senderViewHeaders(),
        body: JSON.stringify({}),
      }),
      env,
    );
    const after = Date.now();

    events = (await (
      await worker.fetch(new Request(`http://127.0.0.1:8787/api/emails/${tracking_id_2}/events`, { headers: authHeaders() }), env)
    ).json()) as Array<{ type: string; timestamp: string }>;
    expect(events).toHaveLength(1);
    const fallbackMs = Date.parse(events[0].timestamp);
    expect(fallbackMs).toBeGreaterThanOrEqual(before - 1000);
    expect(fallbackMs).toBeLessThanOrEqual(after + 1000);
  });

  it('Normalizes gmail message and thread IDs with msg-a:, msg-f:, and # prefixes across create, patch, and self-view', async () => {
    // 1. Create with prefixes
    const created = await worker.fetch(
      new Request('http://127.0.0.1:8787/api/emails', {
        method: 'POST',
        headers: authHeaders(),
        body: JSON.stringify({
          subject: 'Normalize Test',
          sender: 'me@example.com',
          recipients: ['r@example.com'],
          gmail_message_id: 'msg-a:r-1234567890',
          gmail_thread_id: '#thread-f:189abcdef',
        }),
      }),
      env,
    );
    const { tracking_id } = (await created.json()) as { tracking_id: string };

    let email = (await (
      await worker.fetch(new Request(`http://127.0.0.1:8787/api/emails/${tracking_id}`, { headers: authHeaders() }), env)
    ).json()) as { gmail_message_id: string; gmail_thread_id: string };
    expect(email.gmail_message_id).toBe('r-1234567890');
    expect(email.gmail_thread_id).toBe('189abcdef');

    // 2. Patch with prefixes
    await worker.fetch(
      new Request(`http://127.0.0.1:8787/api/emails/${tracking_id}`, {
        method: 'PATCH',
        headers: authHeaders(),
        body: JSON.stringify({
          gmail_message_id: 'msg-f:r-9999999999',
          gmail_thread_id: 'thread-a:999abcdef',
        }),
      }),
      env,
    );

    email = (await (
      await worker.fetch(new Request(`http://127.0.0.1:8787/api/emails/${tracking_id}`, { headers: authHeaders() }), env)
    ).json()) as { gmail_message_id: string; gmail_thread_id: string };
    expect(email.gmail_message_id).toBe('r-9999999999');
    expect(email.gmail_thread_id).toBe('999abcdef');

    // 3. Self-view linking with prefixes on an email without existing ids
    const created2 = await worker.fetch(
      new Request('http://127.0.0.1:8787/api/emails', {
        method: 'POST',
        headers: authHeaders(),
        body: JSON.stringify({
          subject: 'Normalize Self-View Link Test',
          sender: 'me@example.com',
          recipients: ['r@example.com'],
        }),
      }),
      env,
    );
    const { tracking_id: tracking_id_2 } = (await created2.json()) as { tracking_id: string };

    await worker.fetch(
      new Request(`http://127.0.0.1:8787/api/emails/${tracking_id_2}/self-view`, {
        method: 'POST',
        headers: senderViewHeaders(),
        body: JSON.stringify({
          gmailMessageId: '#msg-a:linked-msg-456',
          gmailThreadId: 'thread-f:linked-thread-789',
        }),
      }),
      env,
    );

    const email2 = (await (
      await worker.fetch(new Request(`http://127.0.0.1:8787/api/emails/${tracking_id_2}`, { headers: authHeaders() }), env)
    ).json()) as { gmail_message_id: string; gmail_thread_id: string };
    expect(email2.gmail_message_id).toBe('linked-msg-456');
    expect(email2.gmail_thread_id).toBe('linked-thread-789');
  });

  it('Delayed pixel at T+9s is suppressed by active claim (fixes the fixed 8s window bug)', async () => {
    const baseTime = Date.parse('2026-09-24T12:00:00.000Z');
    vi.useFakeTimers();
    vi.setSystemTime(baseTime);
    try {
      const created = await worker.fetch(
        new Request('http://127.0.0.1:8787/api/emails', {
          method: 'POST',
          headers: authHeaders(),
          body: JSON.stringify({ subject: 'Delayed Pixel Test', sender: 'me@example.com', recipients: ['r@example.com'] }),
        }),
        env,
      );
      const { tracking_id, pixel_url } = (await created.json()) as { tracking_id: string; pixel_url: string };

      // Mark SENT at baseTime
      await worker.fetch(
        new Request(`http://127.0.0.1:8787/api/emails/${tracking_id}`, {
          method: 'PATCH',
          headers: authHeaders(),
          body: JSON.stringify({ status: 'SENT', sent_at: new Date(baseTime).toISOString() }),
        }),
        env,
      );

      // Sender views email in Sent folder at T+0
      const selfViewRes = await worker.fetch(
        new Request(`http://127.0.0.1:8787/api/emails/${tracking_id}/self-view`, {
          method: 'POST',
          headers: senderViewHeaders(),
          body: JSON.stringify({
            timestamp: new Date(baseTime).toISOString(),
            source: 'MESSAGE_EXPANDED',
          }),
        }),
        env,
      );
      expect(selfViewRes.status).toBe(200);
      const selfViewBody = (await selfViewRes.json()) as { ok: boolean; claimId: string; claimExpiresAt: string };
      expect(selfViewBody.ok).toBe(true);
      expect(selfViewBody.claimId).toBeDefined();

      // Gmail delays image loading until T+9.2s (beyond old fixed 8s window)
      vi.advanceTimersByTime(9200);
      const pixelRes = await worker.fetch(new Request(pixel_url, { headers: browserHeaders() }), env);
      expect(pixelRes.status).toBe(200);

      // The open MUST be suppressed by the claim, open_count MUST remain 0!
      const email = (await (
        await worker.fetch(new Request(`http://127.0.0.1:8787/api/emails/${tracking_id}`, { headers: authHeaders() }), env)
      ).json()) as { open_count: number };
      expect(email.open_count).toBe(0);

      const events = (await (
        await worker.fetch(new Request(`http://127.0.0.1:8787/api/emails/${tracking_id}/events`, { headers: authHeaders() }), env)
      ).json()) as Array<{ type: string; classification: string }>;
      const openEvent = events.find((e) => e.type === 'OPEN');
      expect(openEvent?.classification).toBe('SELF_LIKELY');
    } finally {
      vi.useRealTimers();
    }
  });

  it('One-shot claim consumption: first pixel consumes claim, grace period protects burst, subsequent recipient open counts', async () => {
    const baseTime = Date.parse('2026-09-24T12:00:00.000Z');
    vi.useFakeTimers();
    vi.setSystemTime(baseTime);
    try {
      const created = await worker.fetch(
        new Request('http://127.0.0.1:8787/api/emails', {
          method: 'POST',
          headers: authHeaders(),
          body: JSON.stringify({ subject: 'One Shot Test', sender: 'me@example.com', recipients: ['r@example.com'] }),
        }),
        env,
      );
      const { tracking_id, pixel_url } = (await created.json()) as { tracking_id: string; pixel_url: string };

      await worker.fetch(
        new Request(`http://127.0.0.1:8787/api/emails/${tracking_id}`, {
          method: 'PATCH',
          headers: authHeaders(),
          body: JSON.stringify({ status: 'SENT', sent_at: new Date(baseTime).toISOString() }),
        }),
        env,
      );

      // Sender self-view at T+0 creates claim
      await worker.fetch(
        new Request(`http://127.0.0.1:8787/api/emails/${tracking_id}/self-view`, {
          method: 'POST',
          headers: senderViewHeaders(),
          body: JSON.stringify({ timestamp: new Date(baseTime).toISOString(), source: 'MESSAGE_EXPANDED' }),
        }),
        env,
      );

      // First pixel fetch at T+2s consumes the claim
      vi.advanceTimersByTime(2000);
      await worker.fetch(new Request(pixel_url, { headers: browserHeaders() }), env);

      let email = (await (
        await worker.fetch(new Request(`http://127.0.0.1:8787/api/emails/${tracking_id}`, { headers: authHeaders() }), env)
      ).json()) as { open_count: number };
      expect(email.open_count).toBe(0);

      // Duplicate burst pixel fetch at T+2.3s (within 1000ms grace period)
      vi.advanceTimersByTime(300);
      await worker.fetch(new Request(pixel_url, { headers: browserHeaders() }), env);

      email = (await (
        await worker.fetch(new Request(`http://127.0.0.1:8787/api/emails/${tracking_id}`, { headers: authHeaders() }), env)
      ).json()) as { open_count: number };
      expect(email.open_count).toBe(0);

      // Recipient legitimately opens at T+4.0s (claim was consumed at T+2.0s, grace period 1000ms expired at T+3.0s;
      // must NOT be suppressed by legacy 8s timestamp correlation window from T+0)
      vi.advanceTimersByTime(1700);
      await worker.fetch(new Request(pixel_url, { headers: browserHeaders() }), env);

      email = (await (
        await worker.fetch(new Request(`http://127.0.0.1:8787/api/emails/${tracking_id}`, { headers: authHeaders() }), env)
      ).json()) as { open_count: number };
      expect(email.open_count).toBe(1);
    } finally {
      vi.useRealTimers();
    }
  });

  it('Claim expires after 25s TTL without suppressing late recipient opens', async () => {
    const baseTime = Date.parse('2026-09-24T12:00:00.000Z');
    vi.useFakeTimers();
    vi.setSystemTime(baseTime);
    try {
      const created = await worker.fetch(
        new Request('http://127.0.0.1:8787/api/emails', {
          method: 'POST',
          headers: authHeaders(),
          body: JSON.stringify({ subject: 'Expiry Test', sender: 'me@example.com', recipients: ['r@example.com'] }),
        }),
        env,
      );
      const { tracking_id, pixel_url } = (await created.json()) as { tracking_id: string; pixel_url: string };

      await worker.fetch(
        new Request(`http://127.0.0.1:8787/api/emails/${tracking_id}`, {
          method: 'PATCH',
          headers: authHeaders(),
          body: JSON.stringify({ status: 'SENT', sent_at: new Date(baseTime).toISOString() }),
        }),
        env,
      );

      // Sender self-view at T+0 (expires at T+25s)
      await worker.fetch(
        new Request(`http://127.0.0.1:8787/api/emails/${tracking_id}/self-view`, {
          method: 'POST',
          headers: senderViewHeaders(),
          body: JSON.stringify({ timestamp: new Date(baseTime).toISOString() }),
        }),
        env,
      );

      // Recipient opens at T+30s (past the 25s TTL, and outside correlation window)
      vi.advanceTimersByTime(30_000);
      await worker.fetch(new Request(pixel_url, { headers: browserHeaders() }), env);

      const email = (await (
        await worker.fetch(new Request(`http://127.0.0.1:8787/api/emails/${tracking_id}`, { headers: authHeaders() }), env)
      ).json()) as { open_count: number };
      expect(email.open_count).toBe(1);
    } finally {
      vi.useRealTimers();
    }
  });

  it('Self-view idempotency on retry with identical selfViewEventId', async () => {
    const created = await worker.fetch(
      new Request('http://127.0.0.1:8787/api/emails', {
        method: 'POST',
        headers: authHeaders(),
        body: JSON.stringify({ subject: 'Idempotency Test', sender: 'me@example.com', recipients: ['r@example.com'] }),
      }),
      env,
    );
    const { tracking_id } = (await created.json()) as { tracking_id: string };

    const firstRes = await worker.fetch(
      new Request(`http://127.0.0.1:8787/api/emails/${tracking_id}/self-view`, {
        method: 'POST',
        headers: senderViewHeaders(),
        body: JSON.stringify({
          selfViewEventId: 'evt_idempotent_123',
          timestamp: new Date().toISOString(),
          source: 'MESSAGE_EXPANDED',
        }),
      }),
      env,
    );
    expect(firstRes.status).toBe(200);
    const firstBody = (await firstRes.json()) as { ok: boolean; claimId: string };
    expect(firstBody.ok).toBe(true);

    // Second call with SAME selfViewEventId
    const secondRes = await worker.fetch(
      new Request(`http://127.0.0.1:8787/api/emails/${tracking_id}/self-view`, {
        method: 'POST',
        headers: senderViewHeaders(),
        body: JSON.stringify({
          selfViewEventId: 'evt_idempotent_123',
          timestamp: new Date().toISOString(),
          source: 'MESSAGE_EXPANDED',
        }),
      }),
      env,
    );
    expect(secondRes.status).toBe(200);
    const secondBody = (await secondRes.json()) as { ok: boolean; claimId: string };
    expect(secondBody.ok).toBe(true);
    expect(secondBody.claimId).toBe(firstBody.claimId);

    // Ensure only 1 event recorded
    const events = (await (
      await worker.fetch(new Request(`http://127.0.0.1:8787/api/emails/${tracking_id}/events`, { headers: authHeaders() }), env)
    ).json()) as Array<{ id: string }>;
    expect(events.filter((e) => e.id === 'evt_idempotent_123')).toHaveLength(1);
  });

  it('Isolates self-view claims between different messages in the same thread', async () => {
    // Message A in thread_shared
    const createA = await worker.fetch(
      new Request('http://127.0.0.1:8787/api/emails', {
        method: 'POST',
        headers: authHeaders(),
        body: JSON.stringify({
          subject: 'Thread Message A',
          sender: 'me@example.com',
          recipients: ['r@example.com'],
          gmail_thread_id: 'thread_shared',
          gmail_message_id: 'msg_aaa',
        }),
      }),
      env,
    );
    const { tracking_id: trkA } = (await createA.json()) as { tracking_id: string };
    await worker.fetch(
      new Request(`http://127.0.0.1:8787/api/emails/${trkA}`, {
        method: 'PATCH',
        headers: authHeaders(),
        body: JSON.stringify({ status: 'SENT', sent_at: '2026-09-24T12:00:00.000Z' }),
      }),
      env,
    );

    // Message B in thread_shared
    const createB = await worker.fetch(
      new Request('http://127.0.0.1:8787/api/emails', {
        method: 'POST',
        headers: authHeaders(),
        body: JSON.stringify({
          subject: 'Thread Message B',
          sender: 'me@example.com',
          recipients: ['r@example.com'],
          gmail_thread_id: 'thread_shared',
          gmail_message_id: 'msg_bbb',
        }),
      }),
      env,
    );
    const { tracking_id: trkB, pixel_url: pixelUrlB } = (await createB.json()) as { tracking_id: string; pixel_url: string };
    await worker.fetch(
      new Request(`http://127.0.0.1:8787/api/emails/${trkB}`, {
        method: 'PATCH',
        headers: authHeaders(),
        body: JSON.stringify({ status: 'SENT', sent_at: '2026-09-24T12:01:00.000Z' }),
      }),
      env,
    );

    // Sender views Message A only
    await worker.fetch(
      new Request(`http://127.0.0.1:8787/api/emails/${trkA}/self-view`, {
        method: 'POST',
        headers: senderViewHeaders(),
        body: JSON.stringify({
          gmailMessageId: 'msg_aaa',
          gmailThreadId: 'thread_shared',
        }),
      }),
      env,
    );

    // Message B's pixel is requested (e.g. by recipient)
    await worker.fetch(new Request(pixelUrlB, { headers: browserHeaders() }), env);

    // Message B's open count MUST increment to 1 (not suppressed by Message A's claim)
    const emailB = (await (
      await worker.fetch(new Request(`http://127.0.0.1:8787/api/emails/${trkB}`, { headers: authHeaders() }), env)
    ).json()) as { open_count: number };
    expect(emailB.open_count).toBe(1);
  });

  // Requirement 36: Exact reproduction case:
  // T=0 MESSAGE_EXPANDED, T=9 MESSAGE_LOAD, claim refreshed to T=9, T=9.5 pixel arrives -> SELF_LIKELY, open_count = 0
  it('Requirement 36: MESSAGE_EXPANDED at T0, MESSAGE_LOAD at T+9s, pixel at T+9.5s -> SELF_LIKELY and open_count = 0', async () => {
    const baseTime = Date.parse('2026-09-24T12:00:00.000Z');
    vi.useFakeTimers();
    vi.setSystemTime(baseTime);

    try {
      const created = await worker.fetch(
        new Request('http://127.0.0.1:8787/api/emails', {
          method: 'POST',
          headers: authHeaders(),
          body: JSON.stringify({
            subject: 'Req 36 Test',
            sender: 'sender@example.com',
            recipients: ['recipient@example.com'],
            gmail_message_id: 'msg_req36',
          }),
        }),
        env,
      );
      const { tracking_id, pixel_url } = (await created.json()) as { tracking_id: string; pixel_url: string };

      await worker.fetch(
        new Request(`http://127.0.0.1:8787/api/emails/${tracking_id}`, {
          method: 'PATCH',
          headers: authHeaders(),
          body: JSON.stringify({ status: 'SENT', sent_at: new Date(baseTime).toISOString() }),
        }),
        env,
      );

      // T = 0: Sender expands message view
      const expandedRes = await worker.fetch(
        new Request(`http://127.0.0.1:8787/api/emails/${tracking_id}/self-view`, {
          method: 'POST',
          headers: senderViewHeaders(),
          body: JSON.stringify({
            timestamp: new Date(baseTime).toISOString(),
            source: 'MESSAGE_EXPANDED',
            gmailMessageId: 'msg_req36',
          }),
        }),
        env,
      );
      const expandedBody = (await expandedRes.json()) as { ok: boolean; claimId: string; claimExpiresAt: string };
      expect(expandedBody.ok).toBe(true);

      // T = 9s: MessageView finishes rendering body and emits load
      vi.advanceTimersByTime(9000);
      const loadRes = await worker.fetch(
        new Request(`http://127.0.0.1:8787/api/emails/${tracking_id}/self-view`, {
          method: 'POST',
          headers: senderViewHeaders(),
          body: JSON.stringify({
            timestamp: new Date(Date.now()).toISOString(),
            source: 'MESSAGE_LOAD',
            gmailMessageId: 'msg_req36',
          }),
        }),
        env,
      );
      const loadBody = (await loadRes.json()) as { ok: boolean; claimId: string; claimExpiresAt: string };
      expect(loadBody.ok).toBe(true);
      // Same claim is refreshed
      expect(loadBody.claimId).toBe(expandedBody.claimId);
      expect(Date.parse(loadBody.claimExpiresAt)).toBeGreaterThan(Date.parse(expandedBody.claimExpiresAt));

      // T = 9.5s: Gmail remote image proxy fetches pixel
      vi.advanceTimersByTime(500);
      const pixelRes = await worker.fetch(new Request(pixel_url, { headers: browserHeaders() }), env);
      expect(pixelRes.status).toBe(200);

      // Open count MUST remain 0!
      const email = (await (
        await worker.fetch(new Request(`http://127.0.0.1:8787/api/emails/${tracking_id}`, { headers: authHeaders() }), env)
      ).json()) as { open_count: number };
      expect(email.open_count).toBe(0);

      const events = (await (
        await worker.fetch(new Request(`http://127.0.0.1:8787/api/emails/${tracking_id}/events`, { headers: authHeaders() }), env)
      ).json()) as Array<{ type: string; classification: string }>;
      const openEvent = events.find((e) => e.type === 'OPEN');
      expect(openEvent?.classification).toBe('SELF_LIKELY');
    } finally {
      vi.useRealTimers();
    }
  });

  // Requirement 30: Duplicate pixel burst from one sender render is suppressed even with delayed load
  it('Requirement 30: Duplicate pixel burst after delayed render at T+9.2s and T+9.5s suppresses both, while subsequent recipient open at T+15s counts', async () => {
    const baseTime = Date.parse('2026-09-24T12:00:00.000Z');
    vi.useFakeTimers();
    vi.setSystemTime(baseTime);

    try {
      const created = await worker.fetch(
        new Request('http://127.0.0.1:8787/api/emails', {
          method: 'POST',
          headers: authHeaders(),
          body: JSON.stringify({
            subject: 'Req 30 Burst Test',
            sender: 'sender@example.com',
            recipients: ['recipient@example.com'],
          }),
        }),
        env,
      );
      const { tracking_id, pixel_url } = (await created.json()) as { tracking_id: string; pixel_url: string };

      await worker.fetch(
        new Request(`http://127.0.0.1:8787/api/emails/${tracking_id}`, {
          method: 'PATCH',
          headers: authHeaders(),
          body: JSON.stringify({ status: 'SENT', sent_at: new Date(baseTime).toISOString() }),
        }),
        env,
      );

      // Sender self-view at T=0
      await worker.fetch(
        new Request(`http://127.0.0.1:8787/api/emails/${tracking_id}/self-view`, {
          method: 'POST',
          headers: senderViewHeaders(),
          body: JSON.stringify({
            timestamp: new Date(baseTime).toISOString(),
            source: 'MESSAGE_EXPANDED',
          }),
        }),
        env,
      );

      // Gmail delays image rendering until T+9.2s
      vi.advanceTimersByTime(9200);
      // Pixel 1 arrives: consumes claim
      await worker.fetch(new Request(pixel_url, { headers: browserHeaders() }), env);

      let email = (await (
        await worker.fetch(new Request(`http://127.0.0.1:8787/api/emails/${tracking_id}`, { headers: authHeaders() }), env)
      ).json()) as { open_count: number };
      expect(email.open_count).toBe(0);

      // Duplicate pixel 2 arrives at T+9.5s (300ms after pixel 1, same render burst)
      vi.advanceTimersByTime(300);
      await worker.fetch(new Request(pixel_url, { headers: browserHeaders() }), env);

      email = (await (
        await worker.fetch(new Request(`http://127.0.0.1:8787/api/emails/${tracking_id}`, { headers: authHeaders() }), env)
      ).json()) as { open_count: number };
      expect(email.open_count).toBe(0);

      // Real recipient opens at T+15s (grace window <1000ms expired, claim consumed)
      vi.advanceTimersByTime(5500);
      await worker.fetch(new Request(pixel_url, { headers: browserHeaders() }), env);

      email = (await (
        await worker.fetch(new Request(`http://127.0.0.1:8787/api/emails/${tracking_id}`, { headers: authHeaders() }), env)
      ).json()) as { open_count: number };
      expect(email.open_count).toBe(1);
    } finally {
      vi.useRealTimers();
    }
  });

  // Requirement 45: Late cache arrival preserves original expansion timestamp and does NOT extend expiry
  it('Requirement 45: CACHE_REINSPECTION preserves original T0 timestamp and does not extend claim expiry', async () => {
    const baseTime = Date.parse('2026-09-24T12:00:00.000Z');
    vi.useFakeTimers();
    vi.setSystemTime(baseTime);

    try {
      const created = await worker.fetch(
        new Request('http://127.0.0.1:8787/api/emails', {
          method: 'POST',
          headers: authHeaders(),
          body: JSON.stringify({
            subject: 'Cache Reinspection Test',
            sender: 'sender@example.com',
            recipients: ['recipient@example.com'],
          }),
        }),
        env,
      );
      const { tracking_id, pixel_url } = (await created.json()) as { tracking_id: string; pixel_url: string };

      await worker.fetch(
        new Request(`http://127.0.0.1:8787/api/emails/${tracking_id}`, {
          method: 'PATCH',
          headers: authHeaders(),
          body: JSON.stringify({ status: 'SENT', sent_at: new Date(baseTime).toISOString() }),
        }),
        env,
      );

      // T = 0: Sender opens email, but cache was missing.
      // Cache arrives at T = 20s. Content script sends CACHE_REINSPECTION with observedAt = T0 (baseTime).
      vi.advanceTimersByTime(20_000);
      const reinspectRes = await worker.fetch(
        new Request(`http://127.0.0.1:8787/api/emails/${tracking_id}/self-view`, {
          method: 'POST',
          headers: senderViewHeaders(),
          body: JSON.stringify({
            timestamp: new Date(baseTime).toISOString(), // Original T0 timestamp!
            source: 'CACHE_REINSPECTION',
          }),
        }),
        env,
      );
      const reinspectBody = (await reinspectRes.json()) as { ok: boolean; claimExpiresAt: string };
      expect(reinspectBody.ok).toBe(true);

      // Expiry must be based on original T0 (baseTime + 25s = 25s), NOT T20 + 25s = 45s!
      const expiresMs = Date.parse(reinspectBody.claimExpiresAt);
      expect(expiresMs).toBe(baseTime + 25_000);

      // Pixel at T = 24s is within 25s TTL -> suppressed
      vi.advanceTimersByTime(4000); // Now at T = 24s
      await worker.fetch(new Request(pixel_url, { headers: browserHeaders() }), env);

      let email = (await (
        await worker.fetch(new Request(`http://127.0.0.1:8787/api/emails/${tracking_id}`, { headers: authHeaders() }), env)
      ).json()) as { open_count: number };
      expect(email.open_count).toBe(0);

      // Advance past T = 25s (to T = 30s)
      vi.advanceTimersByTime(6000);
      // Now claim is consumed and expired. New open from recipient at T = 30s must count
      await worker.fetch(new Request(pixel_url, { headers: browserHeaders() }), env);

      email = (await (
        await worker.fetch(new Request(`http://127.0.0.1:8787/api/emails/${tracking_id}`, { headers: authHeaders() }), env)
      ).json()) as { open_count: number };
      expect(email.open_count).toBe(1);
    } finally {
      vi.useRealTimers();
    }
  });

  // Retroactive reclassification beyond 8s window
  it('Retroactively reclassifies delayed open arriving at T+8.5s when SELF_VIEW claim arrives at T+9s', async () => {
    const baseTime = Date.parse('2026-09-24T12:00:00.000Z');
    vi.useFakeTimers();
    vi.setSystemTime(baseTime);

    try {
      const created = await worker.fetch(
        new Request('http://127.0.0.1:8787/api/emails', {
          method: 'POST',
          headers: authHeaders(),
          body: JSON.stringify({
            subject: 'Retroactive Delayed Test',
            sender: 'sender@example.com',
            recipients: ['recipient@example.com'],
          }),
        }),
        env,
      );
      const { tracking_id, pixel_url } = (await created.json()) as { tracking_id: string; pixel_url: string };

      await worker.fetch(
        new Request(`http://127.0.0.1:8787/api/emails/${tracking_id}`, {
          method: 'PATCH',
          headers: authHeaders(),
          body: JSON.stringify({ status: 'SENT', sent_at: new Date(baseTime).toISOString() }),
        }),
        env,
      );

      // Sender rendered message at T=0. Pixel arrives at T+8.5s before SELF_VIEW was delivered
      vi.advanceTimersByTime(8500);
      await worker.fetch(new Request(pixel_url, { headers: browserHeaders() }), env);

      // Temporarily open_count is 1
      let email = (await (
        await worker.fetch(new Request(`http://127.0.0.1:8787/api/emails/${tracking_id}`, { headers: authHeaders() }), env)
      ).json()) as { open_count: number };
      expect(email.open_count).toBe(1);

      // Background wake-up delay: SELF_VIEW claim reaches server at T+9s
      vi.advanceTimersByTime(500);
      const svRes = await worker.fetch(
        new Request(`http://127.0.0.1:8787/api/emails/${tracking_id}/self-view`, {
          method: 'POST',
          headers: senderViewHeaders(),
          body: JSON.stringify({
            timestamp: new Date(baseTime).toISOString(),
            source: 'MESSAGE_EXPANDED',
          }),
        }),
        env,
      );
      const svBody = (await svRes.json()) as { ok: boolean; open_count: number; reclassifiedEventIds: string[] };
      expect(svBody.ok).toBe(true);
      expect(svBody.reclassifiedEventIds.length).toBeGreaterThan(0);
      expect(svBody.open_count).toBe(0);

      // Open count was retroactively corrected to 0
      email = (await (
        await worker.fetch(new Request(`http://127.0.0.1:8787/api/emails/${tracking_id}`, { headers: authHeaders() }), env)
      ).json()) as { open_count: number };
      expect(email.open_count).toBe(0);
    } finally {
      vi.useRealTimers();
    }
  });

  // Requirement 38: Backend delivery retry simulation with same idempotency key
  it('Requirement 38: Backend delivery retries with same idempotency key create single claim and suppress sender pixel', async () => {
    const baseTime = Date.parse('2026-09-24T12:00:00.000Z');
    vi.useFakeTimers();
    vi.setSystemTime(baseTime);

    try {
      const created = await worker.fetch(
        new Request('http://127.0.0.1:8787/api/emails', {
          method: 'POST',
          headers: authHeaders(),
          body: JSON.stringify({
            subject: 'Retry Test',
            sender: 'sender@example.com',
            recipients: ['recipient@example.com'],
          }),
        }),
        env,
      );
      const { tracking_id, pixel_url } = (await created.json()) as { tracking_id: string; pixel_url: string };

      await worker.fetch(
        new Request(`http://127.0.0.1:8787/api/emails/${tracking_id}`, {
          method: 'PATCH',
          headers: authHeaders(),
          body: JSON.stringify({ status: 'SENT', sent_at: new Date(baseTime).toISOString() }),
        }),
        env,
      );

      const idempotencyKey = 'sv_idempotent_test_key_abc';

      // Simulate attempt 1 failure (e.g. invalid endpoint or token)
      const attempt1 = await worker.fetch(
        new Request(`http://127.0.0.1:8787/api/emails/${tracking_id}/self-view`, {
          method: 'POST',
          headers: { Authorization: 'Bearer bad-token', 'Content-Type': 'application/json' },
          body: JSON.stringify({ timestamp: new Date(baseTime).toISOString(), selfViewEventId: idempotencyKey }),
        }),
        env,
      );
      expect(attempt1.status).toBe(401);

      // Simulate attempt 2 after 500ms failure (e.g. malformed id)
      vi.advanceTimersByTime(500);
      const attempt2 = await worker.fetch(
        new Request(`http://127.0.0.1:8787/api/emails/bad_id%2Fwith_slash/self-view`, {
          method: 'POST',
          headers: senderViewHeaders(),
          body: JSON.stringify({ timestamp: new Date(baseTime).toISOString(), selfViewEventId: idempotencyKey }),
        }),
        env,
      );
      expect(attempt2.status).toBe(400);

      // Simulate attempt 3 after 2000ms: succeeds with same idempotency key
      vi.advanceTimersByTime(2000);
      const attempt3 = await worker.fetch(
        new Request(`http://127.0.0.1:8787/api/emails/${tracking_id}/self-view`, {
          method: 'POST',
          headers: senderViewHeaders(),
          body: JSON.stringify({
            timestamp: new Date(baseTime).toISOString(),
            source: 'MESSAGE_EXPANDED',
            selfViewEventId: idempotencyKey,
          }),
        }),
        env,
      );
      expect(attempt3.status).toBe(200);
      const body3 = (await attempt3.json()) as { ok: boolean; claimId: string };
      expect(body3.ok).toBe(true);

      // Repeated retry with same idempotency key returns same claim and doesn't duplicate
      const retrySame = await worker.fetch(
        new Request(`http://127.0.0.1:8787/api/emails/${tracking_id}/self-view`, {
          method: 'POST',
          headers: senderViewHeaders(),
          body: JSON.stringify({
            timestamp: new Date(baseTime).toISOString(),
            source: 'MESSAGE_EXPANDED',
            selfViewEventId: idempotencyKey,
          }),
        }),
        env,
      );
      const retryBody = (await retrySame.json()) as { ok: boolean; claimId: string };
      expect(retryBody.claimId).toBe(body3.claimId);

      // Pixel open is suppressed
      await worker.fetch(new Request(pixel_url, { headers: browserHeaders() }), env);
      const email = (await (
        await worker.fetch(new Request(`http://127.0.0.1:8787/api/emails/${tracking_id}`, { headers: authHeaders() }), env)
      ).json()) as { open_count: number };
      expect(email.open_count).toBe(0);
    } finally {
      vi.useRealTimers();
    }
  });

  it('proxy does not consume the sender claim, then the sender browser is excluded and a different recipient counts once', async () => {
    const created = await worker.fetch(
      new Request('http://127.0.0.1:8787/api/emails', {
        method: 'POST',
        headers: authHeaders(),
        body: JSON.stringify({ subject: 'Proxy then sender', sender: 'me@example.com', recipients: ['r@example.com'] }),
      }),
      env,
    );
    const { tracking_id, pixel_url } = (await created.json()) as { tracking_id: string; pixel_url: string };
    await worker.fetch(
      new Request(`http://127.0.0.1:8787/api/emails/${tracking_id}`, {
        method: 'PATCH',
        headers: authHeaders(),
        body: JSON.stringify({ status: 'SENT', sent_at: new Date(Date.now() - 60_000).toISOString() }),
      }),
      env,
    );
    await worker.fetch(
      new Request(`http://127.0.0.1:8787/api/emails/${tracking_id}/self-view`, {
        method: 'POST',
        headers: senderViewHeaders(),
        body: JSON.stringify({ timestamp: new Date().toISOString(), source: 'MESSAGE_EXPANDED' }),
      }),
      env,
    );
    await worker.fetch(new Request(pixel_url, { headers: proxyHeaders() }), env);
    await worker.fetch(new Request(pixel_url, { headers: browserHeaders() }), env);
    await new Promise((resolve) => setTimeout(resolve, 1100));
    await worker.fetch(new Request(pixel_url, { headers: recipientHeaders() }), env);

    const events = (await (
      await worker.fetch(new Request(`http://127.0.0.1:8787/api/emails/${tracking_id}/events`, { headers: authHeaders() }), env)
    ).json()) as Array<{ type: string; classification: string; user_agent?: string }>;
    const opens = events.filter((event) => event.type === 'OPEN');
    expect(opens.map((event) => event.classification).sort()).toEqual(['RECIPIENT_LIKELY', 'SELF_LIKELY', 'SELF_LIKELY']);
    const email = (await (
      await worker.fetch(new Request(`http://127.0.0.1:8787/api/emails/${tracking_id}`, { headers: authHeaders() }), env)
    ).json()) as { open_count: number };
    expect(email.open_count).toBe(1);
    const claims = readMemoryClaims(tracking_id);
    expect(claims).toHaveLength(1);
    expect(claims[0]?.proxy_consumed_by_event_id).toBeTruthy();
    expect(claims[0]?.consumed_by_event_id).toBeTruthy();
    expect(claims[0]?.proxy_consumed_by_event_id).not.toBe(claims[0]?.consumed_by_event_id);
  });

  it('suppresses one sender GoogleImageProxy render, then counts a later recipient proxy', async () => {
    const base = Date.parse('2026-09-24T15:00:00.000Z');
    vi.useFakeTimers();
    vi.setSystemTime(base);
    try {
      const created = await worker.fetch(
        new Request('http://127.0.0.1:8787/api/emails', {
          method: 'POST',
          headers: authHeaders(),
          body: JSON.stringify({ subject: 'Sender proxy then recipient', sender: 'me@example.com', recipients: ['r@example.com'] }),
        }),
        env,
      );
      const { tracking_id, pixel_url } = (await created.json()) as { tracking_id: string; pixel_url: string };
      await worker.fetch(
        new Request(`http://127.0.0.1:8787/api/emails/${tracking_id}`, {
          method: 'PATCH',
          headers: authHeaders(),
          body: JSON.stringify({ status: 'SENT', sent_at: new Date(base - 60_000).toISOString(), gmail_message_id: 'msg_seq' }),
        }),
        env,
      );
      await worker.fetch(
        new Request(`http://127.0.0.1:8787/api/emails/${tracking_id}/self-view`, {
          method: 'POST',
          headers: senderViewHeaders(),
          body: JSON.stringify({
            timestamp: new Date(base).toISOString(),
            source: 'MESSAGE_EXPANDED',
            gmailMessageId: 'msg_seq',
          }),
        }),
        env,
      );
      vi.advanceTimersByTime(200);
      await worker.fetch(new Request(pixel_url, { headers: proxyHeaders() }), env);
      vi.advanceTimersByTime(1_000);
      await worker.fetch(new Request(pixel_url, { headers: proxyHeaders() }), env);
      const mid = (await (
        await worker.fetch(new Request(`http://127.0.0.1:8787/api/emails/${tracking_id}`, { headers: authHeaders() }), env)
      ).json()) as { open_count: number };
      expect(mid.open_count).toBe(0);

      vi.advanceTimersByTime(3_000);
      await worker.fetch(new Request(pixel_url, { headers: proxyHeaders() }), env);
      const email = (await (
        await worker.fetch(new Request(`http://127.0.0.1:8787/api/emails/${tracking_id}`, { headers: authHeaders() }), env)
      ).json()) as { open_count: number };
      expect(email.open_count).toBe(1);
      const events = (await (
        await worker.fetch(new Request(`http://127.0.0.1:8787/api/emails/${tracking_id}/events`, { headers: authHeaders() }), env)
      ).json()) as Array<{ type: string; classification: string }>;
      const opens = events.filter((event) => event.type === 'OPEN').map((event) => event.classification).sort();
      expect(opens).toEqual(['PROXY_LIKELY', 'SELF_LIKELY', 'SELF_LIKELY']);
      const claims = readMemoryClaims(tracking_id);
      expect(claims[0]?.proxy_consumed_by_event_id).toBeTruthy();
      expect(claims[0]?.consumed_by_event_id).toBeNull();
    } finally {
      vi.useRealTimers();
    }
  });

  it('suppresses a second sender proxy after PAGE_RELOAD and still counts a later recipient proxy', async () => {
    const base = Date.parse('2026-09-24T16:00:00.000Z');
    vi.useFakeTimers();
    vi.setSystemTime(base);
    try {
      const { tracking_id, pixel_url } = await createSentTracked(new Date(base - 60_000).toISOString());
      await postSelfView(tracking_id, {
        timestamp: new Date(base).toISOString(),
        source: 'MESSAGE_EXPANDED',
        gmailMessageId: 'msg_reload',
        selfViewEventId: 'sv_open',
      });
      vi.advanceTimersByTime(200);
      await worker.fetch(new Request(pixel_url, { headers: proxyHeaders() }), env);
      expect(await readOpenCount(tracking_id)).toBe(0);

      vi.advanceTimersByTime(3_000);
      const navigationStartedAt = Date.now();
      const reload = await postSelfView(tracking_id, {
        timestamp: new Date(navigationStartedAt).toISOString(),
        source: 'PAGE_RELOAD',
        gmailMessageId: 'msg_reload',
        selfViewEventId: `sv_${tracking_id}_PAGE_RELOAD_${navigationStartedAt}`,
      });
      expect(reload.ok).toBe(true);
      expect(readMemoryClaims(tracking_id)[0]?.proxy_consumed_by_event_id ?? null).toBeNull();

      vi.advanceTimersByTime(400);
      await worker.fetch(new Request(pixel_url, { headers: proxyHeaders() }), env);
      expect(await readOpenCount(tracking_id)).toBe(0);
      const consumed = readMemoryClaims(tracking_id)[0]?.proxy_consumed_by_event_id;
      expect(consumed).toBeTruthy();

      await postSelfView(tracking_id, {
        timestamp: new Date(Date.now()).toISOString(),
        source: 'MESSAGE_EXPANDED',
        gmailMessageId: 'msg_reload',
        selfViewEventId: 'sv_expand_after_reload',
      });
      await postSelfView(tracking_id, {
        timestamp: new Date(Date.now()).toISOString(),
        source: 'MESSAGE_LOAD',
        gmailMessageId: 'msg_reload',
        selfViewEventId: 'sv_load_after_reload',
      });
      await postSelfView(tracking_id, {
        timestamp: new Date(navigationStartedAt).toISOString(),
        source: 'CACHE_REINSPECTION',
        gmailMessageId: 'msg_reload',
        selfViewEventId: 'sv_cache_after_reload',
      });
      expect(readMemoryClaims(tracking_id)[0]?.proxy_consumed_by_event_id).toBe(consumed);

      vi.advanceTimersByTime(10_000);
      await worker.fetch(new Request(pixel_url, { headers: proxyHeaders() }), env);
      expect(await readOpenCount(tracking_id)).toBe(1);
      const opens = await readOpenEvents(tracking_id);
      expect(opens.filter((event) => event.classification === 'PROXY_LIKELY')).toHaveLength(1);
      expect(opens.filter((event) => event.classification === 'SELF_LIKELY')).toHaveLength(2);
    } finally {
      vi.useRealTimers();
    }
  });

  it('reclassifies a GoogleImageProxy that arrives before PAGE_RELOAD reaches the backend', async () => {
    const base = Date.parse('2026-09-24T16:30:00.000Z');
    vi.useFakeTimers();
    vi.setSystemTime(base);
    try {
      const { tracking_id, pixel_url } = await createSentTracked(new Date(base - 60_000).toISOString(), 'Race');
      await postSelfView(tracking_id, {
        timestamp: new Date(base).toISOString(),
        source: 'MESSAGE_EXPANDED',
        gmailMessageId: 'msg_reload',
        selfViewEventId: 'sv_race_open',
      });
      vi.advanceTimersByTime(200);
      await worker.fetch(new Request(pixel_url, { headers: proxyHeaders() }), env);
      expect(await readOpenCount(tracking_id)).toBe(0);

      const navigationStartedAt = base + 3_000;
      vi.setSystemTime(navigationStartedAt + 500);
      await worker.fetch(new Request(pixel_url, { headers: proxyHeaders() }), env);
      expect(await readOpenCount(tracking_id)).toBe(1);

      vi.setSystemTime(navigationStartedAt + 2_000);
      const reload = await postSelfView(tracking_id, {
        timestamp: new Date(navigationStartedAt).toISOString(),
        source: 'PAGE_RELOAD',
        gmailMessageId: 'msg_reload',
        selfViewEventId: `sv_${tracking_id}_PAGE_RELOAD_${navigationStartedAt}`,
      });
      expect(reload.open_count).toBe(0);
      expect(reload.reclassifiedEventIds).toHaveLength(1);
      expect(await readOpenCount(tracking_id)).toBe(0);
      const raced = (await readOpenEvents(tracking_id)).find((event) => event.id === reload.reclassifiedEventIds?.[0]);
      expect(raced?.classification).toBe('SELF_LIKELY');

      vi.advanceTimersByTime(10_000);
      await worker.fetch(new Request(pixel_url, { headers: proxyHeaders() }), env);
      expect(await readOpenCount(tracking_id)).toBe(1);
      expect((await readOpenEvents(tracking_id)).filter((event) => event.classification === 'PROXY_LIKELY')).toHaveLength(1);
    } finally {
      vi.useRealTimers();
    }
  });

  it('does not re-arm proxy suppression for expand, load, or cache reinspection', async () => {
    const base = Date.parse('2026-09-24T17:00:00.000Z');
    vi.useFakeTimers();
    vi.setSystemTime(base);
    try {
      const { tracking_id, pixel_url } = await createSentTracked(new Date(base - 60_000).toISOString(), 'No rearm');
      await postSelfView(tracking_id, {
        timestamp: new Date(base).toISOString(),
        source: 'MESSAGE_EXPANDED',
        gmailMessageId: 'msg_reload',
        selfViewEventId: 'sv_guard_open',
      });
      vi.advanceTimersByTime(200);
      await worker.fetch(new Request(pixel_url, { headers: proxyHeaders() }), env);
      const consumed = readMemoryClaims(tracking_id)[0]?.proxy_consumed_by_event_id;
      expect(consumed).toBeTruthy();
      expect(await readOpenCount(tracking_id)).toBe(0);

      vi.advanceTimersByTime(3_000);
      for (const source of ['MESSAGE_EXPANDED', 'MESSAGE_LOAD', 'CACHE_REINSPECTION'] as const) {
        await postSelfView(tracking_id, {
          timestamp: new Date(base).toISOString(),
          source,
          gmailMessageId: 'msg_reload',
          selfViewEventId: `sv_guard_${source}`,
        });
      }
      expect(readMemoryClaims(tracking_id)[0]?.proxy_consumed_by_event_id).toBe(consumed);

      vi.advanceTimersByTime(500);
      await worker.fetch(new Request(pixel_url, { headers: proxyHeaders() }), env);
      expect(await readOpenCount(tracking_id)).toBe(1);
    } finally {
      vi.useRealTimers();
    }
  });

  it('does not reclassify a browser recipient open when applying PAGE_RELOAD', async () => {
    const base = Date.parse('2026-09-24T17:30:00.000Z');
    vi.useFakeTimers();
    vi.setSystemTime(base);
    try {
      const { tracking_id, pixel_url } = await createSentTracked(new Date(base - 60_000).toISOString(), 'Browser');
      await postSelfView(tracking_id, {
        timestamp: new Date(base).toISOString(),
        source: 'MESSAGE_EXPANDED',
        gmailMessageId: 'msg_reload',
        selfViewEventId: 'sv_browser_open',
      });
      vi.advanceTimersByTime(200);
      await worker.fetch(new Request(pixel_url, { headers: proxyHeaders() }), env);

      const navigationStartedAt = base + 3_000;
      vi.setSystemTime(navigationStartedAt + 500);
      await worker.fetch(new Request(pixel_url, { headers: proxyHeaders() }), env);
      vi.setSystemTime(navigationStartedAt + 2_000);
      await worker.fetch(new Request(pixel_url, { headers: recipientHeaders() }), env);
      expect(await readOpenCount(tracking_id)).toBe(2);

      vi.setSystemTime(navigationStartedAt + 2_500);
      const reload = await postSelfView(tracking_id, {
        timestamp: new Date(navigationStartedAt).toISOString(),
        source: 'PAGE_RELOAD',
        gmailMessageId: 'msg_reload',
        selfViewEventId: `sv_${tracking_id}_PAGE_RELOAD_${navigationStartedAt}`,
      });
      expect(reload.reclassifiedEventIds).toHaveLength(1);
      expect(reload.open_count).toBe(1);
      const opens = await readOpenEvents(tracking_id);
      expect(opens.find((event) => event.id === reload.reclassifiedEventIds?.[0])?.classification).toBe('SELF_LIKELY');
      expect(opens.filter((event) => event.classification === 'RECIPIENT_LIKELY')).toHaveLength(1);
    } finally {
      vi.useRealTimers();
    }
  });

  it('does not re-arm the slot when the same PAGE_RELOAD event is delivered again', async () => {
    const base = Date.parse('2026-09-24T18:00:00.000Z');
    vi.useFakeTimers();
    vi.setSystemTime(base);
    try {
      const { tracking_id, pixel_url } = await createSentTracked(new Date(base - 60_000).toISOString(), 'Idempotent reload');
      const navigationStartedAt = base;
      const selfViewEventId = `sv_${tracking_id}_PAGE_RELOAD_${navigationStartedAt}`;
      await postSelfView(tracking_id, {
        timestamp: new Date(navigationStartedAt).toISOString(),
        source: 'PAGE_RELOAD',
        gmailMessageId: 'msg_reload',
        selfViewEventId,
      });
      vi.advanceTimersByTime(300);
      await worker.fetch(new Request(pixel_url, { headers: proxyHeaders() }), env);
      const consumed = readMemoryClaims(tracking_id)[0]?.proxy_consumed_by_event_id;
      expect(consumed).toBeTruthy();
      expect(await readOpenCount(tracking_id)).toBe(0);

      vi.advanceTimersByTime(3_000);
      await postSelfView(tracking_id, {
        timestamp: new Date(navigationStartedAt).toISOString(),
        source: 'PAGE_RELOAD',
        gmailMessageId: 'msg_reload',
        selfViewEventId,
      });
      expect(readMemoryClaims(tracking_id)[0]?.proxy_consumed_by_event_id).toBe(consumed);

      vi.advanceTimersByTime(500);
      await worker.fetch(new Request(pixel_url, { headers: proxyHeaders() }), env);
      expect(await readOpenCount(tracking_id)).toBe(1);
    } finally {
      vi.useRealTimers();
    }
  });
});
