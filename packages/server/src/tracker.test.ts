import { describe, expect, it, vi } from 'vitest';
import { createHarness } from './testing.js';

const browser = { 'User-Agent': 'Mozilla/5.0 (Macintosh) AppleWebKit/537.36 Chrome/130 Safari/537.36', 'CF-Connecting-IP': '203.0.113.9' };

async function tracked(h: ReturnType<typeof createHarness>, token: string, subject = 'Proposal') {
  const response = await h.trackerCall('/api/emails', {
    token,
    body: { subject, sender: 'ada@example.com', recipients: ['dana@example.com'], links: [{ url: 'https://example.com/doc' }] },
  });
  expect(response.status).toBe(200);
  return (await response.json()) as { tracking_id: string; pixel_url: string; rewritten_links: Array<{ click_id: string; tracked_url: string }> };
}

describe('hosted tracker', () => {
  it('requires a token from this server for management routes', async () => {
    const h = createHarness();
    const anonymous = await h.trackerCall('/api/emails');
    expect(anonymous.status).toBe(401);
    expect(anonymous.headers.get('x-content-type-options')).toBe('nosniff');
    expect((await h.trackerCall('/api/emails', { token: 'forged' })).status).toBe(401);
    const s = await h.signIn('ada@example.com');
    expect((await h.trackerCall('/api/emails', { token: s.accessToken })).status).toBe(200);
  });

  it('keeps each account’s tracked mail private', async () => {
    const h = createHarness();
    const ada = await h.signIn('ada@example.com');
    const bob = await h.signIn('bob@example.com');
    const email = await tracked(h, ada.accessToken, 'Ada only');

    const list = async (token: string) => (await (await h.trackerCall('/api/emails', { token })).json()) as Array<{ tracking_id: string }>;
    expect((await list(ada.accessToken)).map((row) => row.tracking_id)).toEqual([email.tracking_id]);
    expect(await list(bob.accessToken)).toEqual([]);

    const clickId = email.rewritten_links[0]!.click_id;
    expect((await h.trackerCall(`/api/links/${clickId}`)).status).toBe(401);
    expect((await h.trackerCall(`/api/links/${clickId}`, { token: bob.accessToken })).status).toBe(404);
    const resolved = await h.trackerCall(`/api/links/${clickId}`, { token: ada.accessToken });
    expect(await resolved.json()).toEqual({ tracking_id: email.tracking_id, destination: 'https://example.com/doc' });
    expect(await (await h.trackerCall(`/api/emails/${email.tracking_id}/events`, { token: ada.accessToken })).json()).toEqual([]);

    // Bob cannot read, patch, list events for, or claim self-views on Ada's email.
    expect((await h.trackerCall(`/api/emails/${email.tracking_id}`, { token: bob.accessToken })).status).toBe(404);
    expect((await h.trackerCall(`/api/emails/${email.tracking_id}`, { token: bob.accessToken, method: 'PATCH', body: { subject: 'hijacked' } })).status).toBe(404);
    expect(await (await h.trackerCall(`/api/emails/${email.tracking_id}/events`, { token: bob.accessToken })).json()).toEqual([]);
    const selfView = await h.trackerCall(`/api/emails/${email.tracking_id}/self-view`, { token: bob.accessToken, body: { source: 'MESSAGE_EXPANDED' } });
    expect([404, 400]).toContain(selfView.status);
    const adaView = (await (await h.trackerCall(`/api/emails/${email.tracking_id}`, { token: ada.accessToken })).json()) as { subject: string };
    expect(adaView.subject).toBe('Ada only');
  });

  it('records public pixel and click hits for the owner only', async () => {
    const h = createHarness();
    const ada = await h.signIn('ada@example.com');
    const bob = await h.signIn('bob@example.com');
    const email = await tracked(h, ada.accessToken);
    await h.trackerCall(`/api/emails/${email.tracking_id}`, { token: ada.accessToken, method: 'PATCH', body: { status: 'SENT', sent_at: new Date(Date.now() - 10 * 60_000).toISOString() } });

    const pixel = await h.trackerCall(new URL(email.pixel_url).pathname, { headers: browser });
    expect(pixel.status).toBe(200);
    expect(pixel.headers.get('content-type')).toBe('image/gif');
    const click = await h.trackerCall(new URL(email.rewritten_links[0]!.tracked_url).pathname, { headers: browser });
    expect(click.status).toBe(302);
    expect(click.headers.get('location')).toBe('https://example.com/doc');

    const adaEvents = (await (await h.trackerCall('/api/events/recent', { token: ada.accessToken })).json()) as Array<{ type: string }>;
    expect(adaEvents.map((event) => event.type).sort()).toEqual(['CLICK', 'OPEN']);
    expect(await (await h.trackerCall('/api/events/recent', { token: bob.accessToken })).json()).toEqual([]);
  });

  it('answers public routes for unknown IDs without leaking anything', async () => {
    const h = createHarness();
    const pixel = await h.trackerCall('/open/trk_doesnotexist', { headers: browser });
    expect(pixel.status).toBe(200);
    expect(pixel.headers.get('content-type')).toBe('image/gif');
    expect((await h.trackerCall('/c/clk_doesnotexist')).status).toBe(404);
  });

  it('reports protocol v3 on health', async () => {
    const h = createHarness();
    expect(await (await h.trackerCall('/health')).json()).toMatchObject({ ok: true, protocolVersion: 3 });
  });

  it('tracking IDs are random and carry no mailbox data', async () => {
    const h = createHarness();
    const s = await h.signIn('ada@example.com');
    const email = await tracked(h, s.accessToken, 'Quarterly numbers');
    expect(email.tracking_id).toMatch(/^trk_[0-9a-f]{32}$/);
    // The ID is random hex and can contain "ada" by chance, so check the rest of the URL.
    expect(email.pixel_url.endsWith(`/open/${email.tracking_id}`)).toBe(true);
    expect(email.pixel_url.replace(email.tracking_id, '')).not.toMatch(/Quarterly|dana|ada/i);
  });

  describe('sender drafting a reply inside their own tracked thread', () => {
    // Same timeline as the public tracker's tests: sender renders and Gmail proxy fetches racing either way.
    type DraftStep = [offsetMs: number, kind: 'render' | 'quoted' | 'inspect' | 'proxy' | 'recipient', observedMs?: number];
    const SENDER_DRAFTING: DraftStep[] = [
      [0, 'render'], [300, 'proxy'], [400, 'proxy'],
      [5_100, 'proxy'], [5_400, 'quoted', 5_000],
      [17_000, 'quoted'], [17_250, 'proxy'],
      [20_000, 'render'], [20_200, 'proxy'],
      [29_150, 'proxy'], [29_500, 'quoted', 29_000],
      [33_000, 'inspect'],
      [41_000, 'quoted'], [41_300, 'proxy'],
      [47_200, 'proxy'], [47_600, 'render', 47_000],
      [53_100, 'proxy'], [53_400, 'quoted', 53_000],
      [60_000, 'render'], [60_250, 'proxy'],
    ];
    const proxy = { 'User-Agent': 'Mozilla/5.0 (Windows NT 5.1; rv:11.0) Gecko Firefox/11.0 (via ggpht.com GoogleImageProxy)', 'CF-Connecting-IP': '66.249.84.1' };

    async function drafting() {
      const h = createHarness();
      const s = await h.signIn('ada@example.com');
      const email = await tracked(h, s.accessToken);
      const start = Date.now();
      await h.trackerCall(`/api/emails/${email.tracking_id}`, { token: s.accessToken, method: 'PATCH', body: { status: 'SENT', sent_at: new Date(start - 3_600_000).toISOString() } });
      const replay = async (steps: DraftStep[]) => {
        const clock = vi.spyOn(Date, 'now');
        try {
          for (const [offset, kind, observed = offset] of steps) {
            clock.mockReturnValue(start + offset);
            if (kind === 'proxy' || kind === 'recipient') await h.trackerCall(`/open/${email.tracking_id}`, { headers: proxy });
            else await h.trackerCall(`/api/emails/${email.tracking_id}/self-view`, { token: s.accessToken, headers: browser, body: { timestamp: new Date(start + observed).toISOString(), source: kind === 'inspect' ? 'CACHE_REINSPECTION' : 'MESSAGE_LOAD', ...(kind === 'inspect' ? {} : { pixelRender: true, quotedRender: kind === 'quoted' }), selfViewEventId: `sv_${email.tracking_id}_nomessage_${kind}_${start + observed}` } });
          }
        } finally {
          clock.mockRestore();
        }
      };
      const openCount = async () => ((await (await h.trackerCall(`/api/emails/${email.tracking_id}`, { token: s.accessToken })).json()) as { open_count: number }).open_count;
      const opens = async () => ((await (await h.trackerCall(`/api/emails/${email.tracking_id}/events`, { token: s.accessToken })).json()) as Array<{ type: string; classification: string; timestamp: string }>).filter((event) => event.type === 'OPEN');
      return { start, replay, openCount, opens };
    }

    it('never counts a minute of sender renders, autosaves and restores, then still counts recipients', async () => {
      const { replay, openCount, opens } = await drafting();
      await replay([...SENDER_DRAFTING, [62_000, 'inspect']]);
      expect(await openCount()).toBe(0);
      const sender = await opens();
      expect(sender).toHaveLength(SENDER_DRAFTING.filter(([, kind]) => kind === 'proxy').length);
      expect(sender.every((event) => event.classification === 'SELF_LIKELY')).toBe(true);
      await replay([[95_000, 'recipient'], [130_000, 'recipient']]);
      expect(await openCount()).toBe(2);
    });

    it('still counts a real recipient who opens while the sender is drafting', async () => {
      const { start, replay, openCount, opens } = await drafting();
      await replay([...SENDER_DRAFTING, [35_500, 'recipient'] as DraftStep].sort((a, b) => a[0] - b[0]));
      expect(await openCount()).toBe(1);
      expect((await opens()).find((event) => event.timestamp === new Date(start + 35_500).toISOString())?.classification).toBe('PROXY_LIKELY');
    });
  });
});
