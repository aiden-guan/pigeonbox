import { describe, expect, it, vi } from 'vitest';
import {
  shouldRewriteLink,
  stableClickId,
  summaryFromRemote,
  trackerOriginOf,
  TrackingClient,
  TrackingHttpError,
  transformOutgoingHtml,
} from './index.js';

const created = { tracking_id: 'trk_1', pixel_url: 'https://t.example/open/trk_1', rewritten_links: [] };

function respond(status: number, body: unknown = {}): Response {
  return new Response(JSON.stringify(body), { status, headers: { 'Content-Type': 'application/json' } });
}

describe('TrackingClient credentials', () => {
  it('refreshes an expired Cloud token once and retries the same request', async () => {
    const fetcher = vi.fn<typeof fetch>()
      .mockResolvedValueOnce(respond(401, { error: 'unauthorized' }))
      .mockResolvedValueOnce(respond(200, created));
    const credential = { get: vi.fn(async () => 'old'), refresh: vi.fn(async () => 'new') };
    const client = new TrackingClient('https://t.example/', credential, { fetcher });
    await expect(client.createEmail({ subject: 's', sender: 'a', recipients: ['b@example.com'] })).resolves.toEqual(created);
    expect(credential.refresh).toHaveBeenCalledTimes(1);
    expect(fetcher).toHaveBeenCalledTimes(2);
    const [firstUrl, first] = fetcher.mock.calls[0]!;
    const [, second] = fetcher.mock.calls[1]!;
    expect(firstUrl).toBe('https://t.example/api/emails');
    expect((first!.headers as Record<string, string>).Authorization).toBe('Bearer old');
    expect((second!.headers as Record<string, string>).Authorization).toBe('Bearer new');
    expect(second!.body).toBe(first!.body);
  });

  it('does not retry entitlement, server or network failures, so a create is never duplicated', async () => {
    for (const status of [402, 500, 503]) {
      const fetcher = vi.fn<typeof fetch>().mockResolvedValue(respond(status));
      const refresh = vi.fn(async () => 'new');
      const client = new TrackingClient('https://t.example', { get: async () => 'tok', refresh }, { fetcher });
      const error = await client.createEmail({ subject: 's', sender: 'a', recipients: ['b@example.com'] }).catch((e: unknown) => e);
      expect(error).toBeInstanceOf(TrackingHttpError);
      expect((error as TrackingHttpError).status).toBe(status);
      expect((error as Error).message).toBe(`tracking create failed: ${status}`);
      expect(fetcher).toHaveBeenCalledTimes(1);
      expect(refresh).not.toHaveBeenCalled();
    }
    const offline = vi.fn<typeof fetch>().mockRejectedValue(new TypeError('Failed to fetch'));
    const client = new TrackingClient('https://t.example', { get: async () => 'tok', refresh: async () => 'new' }, { fetcher: offline });
    await expect(client.listEmails()).rejects.toThrow('Failed to fetch');
    expect(offline).toHaveBeenCalledTimes(1);
  });

  it('fails without a request when the Cloud session has no token', async () => {
    const fetcher = vi.fn<typeof fetch>();
    const client = new TrackingClient('https://t.example', { get: async () => null }, { fetcher });
    await expect(client.getRecentEvents()).rejects.toMatchObject({ status: 401 });
    expect(fetcher).not.toHaveBeenCalled();
  });

  it('sends a fixed personal token unchanged and bounds every request', async () => {
    const fetcher = vi.fn<typeof fetch>().mockResolvedValue(respond(200, []));
    await new TrackingClient('https://t.example', 'personal', { fetcher, timeoutMs: 50 }).getEvents('trk_1');
    const [url, init] = fetcher.mock.calls[0]!;
    expect(url).toBe('https://t.example/api/emails/trk_1/events');
    expect((init!.headers as Record<string, string>).Authorization).toBe('Bearer personal');
    expect(init!.signal).toBeInstanceOf(AbortSignal);
  });
});

describe('outgoing link policy', () => {
  it('wraps ordinary links whose paths only resemble tracker routes', () => {
    expect(shouldRewriteLink('https://www.youtube.com/c/SomeChannel')).toBe(true);
    expect(shouldRewriteLink('https://example.com/open/source')).toBe(true);
    expect(shouldRewriteLink('https://example.com/docs?ref=a#b')).toBe(true);
  });

  it('never wraps tracker URLs, Gmail, credentials-in-URL or malformed links', () => {
    expect(shouldRewriteLink('https://other-tracker.example/c/clk_0123456789abcdef')).toBe(false);
    expect(shouldRewriteLink('https://other-tracker.example/open/trk_0123')).toBe(false);
    expect(shouldRewriteLink('https://mail.google.com/mail/u/0/#inbox')).toBe(false);
    expect(shouldRewriteLink('https://user:pw@example.com/')).toBe(false);
    expect(shouldRewriteLink('https://')).toBe(false);
    expect(shouldRewriteLink('chrome-extension://abc/page.html')).toBe(false);
    expect(shouldRewriteLink('data:text/html,hi')).toBe(false);
  });

  it('leaves links on its own tracker alone', () => {
    const pixel = 'https://t.example/open/trk_abc';
    const html = '<a href="https://t.example/status">status</a><a href="https://example.com/a">a</a>';
    const out = transformOutgoingHtml(html, {
      pixelUrl: pixel,
      trackOpens: true,
      trackLinks: true,
      allocateTrackedUrl: (url) => `https://t.example/c/${stableClickId('trk_abc', url)}`,
    });
    expect(out.linksRewritten).toBe(1);
    expect(out.html).toContain('href="https://t.example/status"');
  });

  it('honors each open and link setting independently', () => {
    const pixel = 'https://t.example/open/trk_abc';
    const html = '<p>Hi</p><a href="https://example.com/a">a</a>';
    const allocateTrackedUrl = (url: string) => `https://t.example/c/${stableClickId('trk_abc', url)}`;
    const both = transformOutgoingHtml(html, { pixelUrl: pixel, trackOpens: true, trackLinks: true, allocateTrackedUrl });
    expect([both.pixelPresent, both.linksRewritten]).toEqual([true, 1]);
    const opensOnly = transformOutgoingHtml(html, { pixelUrl: pixel, trackOpens: true, trackLinks: false, allocateTrackedUrl });
    expect([opensOnly.pixelPresent, opensOnly.linksRewritten]).toEqual([true, 0]);
    const linksOnly = transformOutgoingHtml(html, { pixelUrl: pixel, trackOpens: false, trackLinks: true, allocateTrackedUrl });
    expect([linksOnly.pixelPresent, linksOnly.linksRewritten]).toEqual([false, 1]);
    const neither = transformOutgoingHtml(html, { pixelUrl: pixel, trackOpens: false, trackLinks: false, allocateTrackedUrl });
    expect(neither.html).toBe(html);
  });
});

describe('tracked email summaries', () => {
  it('keep the issuing tracker and click times', () => {
    const summary = summaryFromRemote(
      { tracking_id: 'trk_1', subject: 's', sender: 'a', recipients: ['b@example.com'], status: 'SENT', sent_at: '2026-01-01T00:00:00.000Z', click_count: 1, last_clicked_at: '2026-01-01T00:05:00.000Z' },
      null,
      'cloud:https://api.example',
    );
    expect(summary).toMatchObject({ issuer: 'cloud:https://api.example', clickCount: 1, lastClickedAt: '2026-01-01T00:05:00.000Z' });
    expect(summaryFromRemote({ tracking_id: 'trk_1', subject: 's', sender: 'a', sent_at: null }, summary).issuer).toBe('cloud:https://api.example');
    expect(trackerOriginOf('https://t.example/open/trk_1')).toBe('https://t.example');
    expect(trackerOriginOf('javascript:alert(1)')).toBeNull();
  });
});
