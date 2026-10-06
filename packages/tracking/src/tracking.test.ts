import { describe, expect, it } from 'vitest';
import {
  applyRecentOpens,
  shouldRewriteLink,
  buildTrackingPixelHtml,
  formatSentTrackingBadge,
  isLikelySelfOpen,
  rewriteHtmlLinks,
  appendTrackingPixel,
  applyTrackingToOutgoingHtml,
  classifyOpenEvent,
  describeOpenClient,
  describeTrackingNotification,
  describeTrackingStatus,
  inspectTrackedMime,
  isNotifiableTrackingEvent,
  isLoopbackTracker,
  matchTrackedEmail,
  normalizeGmailId,
  normalizeSubject,
  stableClickId,
  summaryFromRemote,
  trackerPermissionOrigin,
  transformOutgoingHtml,
  type TrackedEmailSummary,
} from '@pigeonbox/tracking';

// Local copies of worker helpers to avoid cross-package TS project refs in tests
function safeRedirectUrl(url: string): string | null {
  try {
    const u = new URL(url);
    if (u.protocol !== 'http:' && u.protocol !== 'https:') return null;
    return u.toString();
  } catch {
    return null;
  }
}
function suspectSelfOpen(opts: {
  sentAt: string | null;
  now: number;
  ua: string | null;
}): { suspected: boolean; confidence: number } {
  let score = 0;
  if (opts.sentAt) {
    const delta = opts.now - Date.parse(opts.sentAt);
    if (delta >= 0 && delta < 5000) score += 0.5;
  }
  if (opts.ua && /Headless|Lighthouse/i.test(opts.ua)) score += 0.3;
  return { suspected: score >= 0.5, confidence: Math.min(1, score) };
}

describe('link rewriting policy', () => {
  it('only rewrites http(s)', () => {
    expect(shouldRewriteLink('https://example.com/a')).toBe(true);
    expect(shouldRewriteLink('http://example.com/a')).toBe(true);
    expect(shouldRewriteLink('mailto:a@b.com')).toBe(false);
    expect(shouldRewriteLink('tel:+123')).toBe(false);
    expect(shouldRewriteLink('javascript:alert(1)')).toBe(false);
    expect(shouldRewriteLink('#section')).toBe(false);
    expect(shouldRewriteLink('https://mail.google.com/mail/u/0/#inbox')).toBe(false);
  });

  it('rewrites html hrefs via map', () => {
    const map = new Map([['https://example.com', 'https://tracker/c/1']]);
    const html = rewriteHtmlLinks('<a href="https://example.com">x</a><a href="mailto:a@b.com">y</a>', map);
    expect(html).toContain('https://tracker/c/1');
    expect(html).toContain('mailto:a@b.com');
  });
});

describe('pixel + badges', () => {
  it('builds a pixel clients will actually fetch', () => {
    const html = buildTrackingPixelHtml('https://tracker/open/abc');
    expect(html).toContain('src="https://tracker/open/abc"');
    expect(html).toContain('width="1"');
    expect(html).not.toContain('display:none');
    expect(html).toContain('referrerpolicy="no-referrer"');
  });

  it('appends the pixel once and rewrites only the mapped link', () => {
    const map = new Map([['https://example.com/a', 'https://tracker/c/1']]);
    const once = applyTrackingToOutgoingHtml('<p>Hi</p><a href="https://example.com/a">a</a>', {
      pixelUrl: 'https://tracker/open/abc',
      linkMap: map,
      trackOpens: true,
      trackLinks: true,
    });
    expect(once).toContain('https://tracker/c/1');
    expect(once).toContain('https://tracker/open/abc');
    expect(appendTrackingPixel(once, 'https://tracker/open/abc')).toBe(once);
  });

  it('formats sent badges with open-detected wording', () => {
    expect(formatSentTrackingBadge({ open_count: 0, click_count: 0 })).toMatch(/no open detected/);
    expect(formatSentTrackingBadge({ open_count: 1, click_count: 0 })).toMatch(/open detected/);
    expect(formatSentTrackingBadge({ open_count: 3, click_count: 1 })).toMatch(/Link 1/);
  });
});

describe('self-open filtering', () => {
  it('flags immediate opens', () => {
    const now = Date.now();
    expect(
      isLikelySelfOpen({ eventTs: now + 1000, sentAt: now, senderActiveRecently: true }).suspected,
    ).toBe(true);
  });

  it('worker helper matches', () => {
    const r = suspectSelfOpen({
      sentAt: new Date().toISOString(),
      now: Date.now() + 1000,
      ua: 'Mozilla',
    });
    expect(r.suspected).toBe(true);
  });
});

describe('safe redirects', () => {
  it('allows only http(s)', () => {
    expect(safeRedirectUrl('https://example.com/path')).toBe('https://example.com/path');
    expect(safeRedirectUrl('javascript:alert(1)')).toBeNull();
    expect(safeRedirectUrl('mailto:a@b.com')).toBeNull();
  });
});

describe('sent mail status', () => {
  const base: TrackedEmailSummary = {
    trackingId: 'trk_1',
    subject: 'Hello',
    sender: 'me@example.com',
    recipients: ['a@b.com'],
    gmailThreadId: 'thread-1',
    gmailMessageId: null,
    sentAt: '2026-09-22T15:00:00.000Z',
    firstOpenedAt: null,
    lastOpenedAt: null,
    openCount: 0,
    clickCount: 0,
    notifyIfNoReply: false,
  };

  it('matches a row by thread id and ignores a different thread with the same subject', () => {
    const other = { ...base, trackingId: 'trk_2', gmailThreadId: 'thread-2', subject: 'Hello' };
    const unlinked = {
      ...base,
      trackingId: 'trk_3',
      gmailThreadId: null,
      subject: 'Hello',
      sentAt: '2026-09-22T16:00:00.000Z',
    };
    expect(
      matchTrackedEmail(
        { threadIds: ['thread-1'], subject: 'Re: Hello', emails: ['a@b.com'] },
        [other, unlinked, base],
      )?.trackingId,
    ).toBe('trk_1');
  });

  it('matches one tracked email by subject when the row has no address', () => {
    expect(
      matchTrackedEmail({ threadIds: ['other-id'], subject: 'Hello', emails: [] }, [base])?.trackingId,
    ).toBe('trk_1');
  });

  it('matches a sent row when a category chip is glued to the subject', () => {
    expect(normalizeSubject('sdefsfseWaiting')).toBe('sdefsfse');
    expect(
      matchTrackedEmail(
        { threadIds: [], subject: 'HelloWaiting', emails: ['a@b.com'] },
        [{ ...base, gmailThreadId: null }],
      )?.trackingId,
    ).toBe('trk_1');
  });

  it('matches a sent row whose subject line also contains the preview', () => {
    expect(
      matchTrackedEmail(
        { threadIds: [], subject: 'Hello - can you review this today', emails: ['a@b.com'] },
        [{ ...base, gmailThreadId: null }],
      )?.trackingId,
    ).toBe('trk_1');
  });

  it('matches an unlinked send by subject and recipient', () => {
    const unlinked = { ...base, gmailThreadId: null };
    expect(
      matchTrackedEmail(
        { threadIds: ['thread-9'], subject: 'Hello', emails: ['A@B.com'] },
        [unlinked],
      )?.trackingId,
    ).toBe('trk_1');
  });

  it('describes an open the way the sent-mail card should read', () => {
    const sent = Date.parse('2026-09-22T15:00:00.000Z');
    const opened = sent + 20_000;
    const copy = describeTrackingStatus(
      {
        ...base,
        openCount: 2,
        firstOpenedAt: new Date(opened).toISOString(),
        lastOpenedAt: new Date(opened).toISOString(),
      },
      { now: opened + 15_000 },
    );
    expect(copy.opened).toBe(true);
    expect(copy.headline).toBe('Open detected less than a minute ago.');
    expect(copy.detail).toBe('First open detected less than a minute after you sent.');
    expect(copy.attributionNote).toBeNull();
    expect(copy.countLabel).toBe('Opened 2 times');
    expect(copy.markLabel).toBe('Opened 2×');
  });

  it('describes mail that has not been opened', () => {
    const copy = describeTrackingStatus(base, { now: Date.parse(base.sentAt) + 60_000 });
    expect(copy.opened).toBe(false);
    expect(copy.headline).toBe('No open detected yet.');
    expect(copy.detail).toBe('Tracking is on for this email.');
    expect(copy.countLabel).toBe('No open detected yet');
    expect(copy.markLabel).toBe('Sent');
  });

  it('keeps a click visible on an email that was also opened', () => {
    const copy = describeTrackingStatus(
      { ...base, openCount: 7, lastOpenedAt: '2026-09-22T15:00:00.000Z', clickCount: 1, lastClickedAt: '2026-09-22T15:10:00.000Z' },
      { now: Date.parse('2026-09-22T15:22:00.000Z') },
    );
    expect(copy.markLabel).toBe('Opened 7× · clicked');
    expect(copy.headline).toBe('Open detected 22 minutes ago. Link clicked 12 minutes ago.');
  });

  it('labels a click-only email and never names a reader of a shared pixel', () => {
    const copy = describeTrackingStatus(
      { ...base, recipients: ['a@b.com', 'c@d.com'], clickCount: 1, lastClickedAt: '2026-09-22T15:10:00.000Z' },
      { now: Date.parse('2026-09-22T15:22:00.000Z') },
    );
    expect(copy.markLabel).toBe('Link clicked');
    expect(copy.headline).toBe('Link clicked 12 minutes ago.');
    expect(copy.attributionNote).toBe('Sent to 2 people in one email, so PigeonBox cannot tell which of them opened it.');
    expect(`${copy.headline}${copy.detail}${copy.countLabel}`).not.toMatch(/a@b\.com|c@d\.com/);
  });

  it('reports a pending email as not sent rather than unopened', () => {
    const copy = describeTrackingStatus({ ...base, status: 'PENDING', sentAt: null });
    expect(copy.markLabel).toBe('Pending');
    expect(copy.headline).toBe('Not sent yet.');
  });

  it('shows the newest tracked send even when an older message in the same thread was opened', () => {
    const opened = { ...base, openCount: 1, lastOpenedAt: '2026-09-22T15:05:00.000Z', sentAt: '2026-09-22T15:00:00.000Z' };
    const newer = { ...base, trackingId: 'trk_new', openCount: 0, sentAt: '2026-09-22T18:00:00.000Z', firstOpenedAt: null, lastOpenedAt: null };
    const match = matchTrackedEmail({ threadIds: ['thread-1'], subject: 'Hello', emails: ['a@b.com'] }, [newer, opened]);
    expect(match?.trackingId).toBe('trk_new');
    expect(match?.openCount).toBe(0);
    const copy = describeTrackingStatus(match!);
    expect(copy.markLabel).toBe('Sent');
    expect(copy.countLabel).toBe('No open detected yet');
  });

  it('shows the newest opened send when the older send is unopened', () => {
    const older = { ...base, openCount: 0, sentAt: '2026-09-22T15:00:00.000Z', firstOpenedAt: null, lastOpenedAt: null };
    const newerOpened = { ...base, trackingId: 'trk_new', openCount: 1, sentAt: '2026-09-22T18:00:00.000Z', lastOpenedAt: '2026-09-22T18:05:00.000Z' };
    const match = matchTrackedEmail({ threadIds: ['thread-1'], subject: 'Hello', emails: ['a@b.com'] }, [newerOpened, older]);
    expect(match?.trackingId).toBe('trk_new');
    expect(match?.openCount).toBe(1);
    const copy = describeTrackingStatus(match!);
    expect(copy.markLabel).toBe('Opened');
  });

  it('matches by exact gmailMessageId when available over thread fallback', () => {
    const msg1 = { ...base, trackingId: 'trk_msg1', gmailMessageId: 'msg-1', openCount: 1, sentAt: '2026-09-22T15:00:00.000Z' };
    const msg2 = { ...base, trackingId: 'trk_msg2', gmailMessageId: 'msg-2', openCount: 0, sentAt: '2026-09-22T18:00:00.000Z' };
    const match = matchTrackedEmail({ threadIds: ['thread-1'], messageId: 'msg-1', subject: 'Hello', emails: ['a@b.com'] }, [msg1, msg2]);
    expect(match?.trackingId).toBe('trk_msg1');
  });

  it('raises a zero open count when a recent open event exists', () => {
    const [next] = applyRecentOpens(
      [base],
      [{ tracking_id: 'trk_1', type: 'OPEN', timestamp: '2026-09-22T16:00:00.000Z' }],
    );
    expect(next?.openCount).toBe(1);
    expect(next?.firstOpenedAt).toBe('2026-09-22T16:00:00.000Z');
  });

  it('does not lower an open count that is already higher than the recent events', () => {
    const [next] = applyRecentOpens(
      [{ ...base, openCount: 4, firstOpenedAt: base.sentAt, lastOpenedAt: base.sentAt }],
      [{ tracking_id: 'trk_1', type: 'OPEN', timestamp: '2026-09-22T16:00:00.000Z' }],
    );
    expect(next?.openCount).toBe(4);
  });

  it('keeps the local reply reminder when remote stats refresh', () => {
    const merged = summaryFromRemote(
      {
        tracking_id: 'trk_1',
        subject: 'Hello',
        sender: 'me@example.com',
        recipients: ['a@b.com'],
        sent_at: base.sentAt,
        open_count: 1,
        gmail_thread_id: null,
      },
      { ...base, notifyIfNoReply: true },
    );
    expect(merged.openCount).toBe(1);
    expect(merged.notifyIfNoReply).toBe(true);
    expect(merged.gmailThreadId).toBe('thread-1');
  });

  it('treats localhost as unreachable for recipient opens', () => {
    expect(isLoopbackTracker('http://127.0.0.1:8787')).toBe(true);
    expect(isLoopbackTracker('https://track.example')).toBe(false);
    expect(trackerPermissionOrigin('http://127.0.0.1:8787')).toBe('http://127.0.0.1:8787/*');
    expect(trackerPermissionOrigin('http://track.example')).toBeNull();
    expect(trackerPermissionOrigin('https://track.example/path')).toBe('https://track.example/*');
  });
});

describe('outgoing html', () => {
  const pixel = 'https://track.example/open/trk_abc';

  it('inserts one pixel, rewrites http links, and leaves the rest of the message alone', () => {
    const html = [
      '<div>Hi Sam</div>',
      '<div class="gmail_signature">--<br>Aiden</div>',
      '<blockquote class="gmail_quote">On Monday, Pat wrote:<br><a href="https://example.com/docs">docs</a></blockquote>',
      '<a href="mailto:a@b.com">mail</a>',
      '<a href="tel:+15551212">call</a>',
      '<a href="cid:logo">logo</a>',
      '<a href="#section">section</a>',
      '<a href="https://mail.google.com/mail/u/0/">gmail</a>',
      '<img src="https://example.com/photo.png" alt="photo">',
    ].join('');
    const once = transformOutgoingHtml(html, {
      pixelUrl: pixel,
      trackOpens: true,
      trackLinks: true,
      linkMap: new Map(),
      allocateTrackedUrl: (url) => `https://track.example/c/${stableClickId('trk_abc', url)}`,
    });
    expect(once.pixelPresent).toBe(true);
    expect(once.html.match(new RegExp(pixel.replace(/[.*+?^${}()|[\]\\]/g, '\\$&'), 'g'))).toHaveLength(1);
    expect(once.html).toContain('Hi Sam');
    expect(once.html).toContain('gmail_signature');
    expect(once.html).toContain('Aiden');
    expect(once.html).toContain('On Monday, Pat wrote:');
    expect(once.html).toContain('mailto:a@b.com');
    expect(once.html).toContain('tel:+15551212');
    expect(once.html).toContain('cid:logo');
    expect(once.html).toContain('#section');
    expect(once.html).toContain('https://mail.google.com/mail/u/0/');
    expect(once.html).toContain('https://example.com/photo.png');
    expect(once.html).not.toContain('href="https://example.com/docs"');
    expect(once.linksRewritten).toBe(1);
    const twice = transformOutgoingHtml(once.html, {
      pixelUrl: pixel,
      trackOpens: true,
      trackLinks: true,
      linkMap: new Map([['https://example.com/docs', `https://track.example/c/${stableClickId('trk_abc', 'https://example.com/docs')}`]]),
      allocateTrackedUrl: () => {
        throw new Error('second pass must not allocate');
      },
    });
    expect(twice.html).toBe(once.html);
    expect(twice.linksRewritten).toBe(0);
    expect(transformOutgoingHtml('', { pixelUrl: pixel, trackOpens: true, trackLinks: false }).html).toContain(pixel);
  });

  it('drops pixels of earlier tracked messages from the quote, including Gmail proxy URLs', () => {
    const html = [
      '<div>Following up</div>',
      '<div class="gmail_quote"><blockquote class="gmail_quote">Earlier:',
      '<img src="https://track.example/open/trk_old1" width="1" height="1">',
      '<img src="https://ci3.googleusercontent.com/meips/ADKq_abc=s0-d-e1-ft#https://track.example/open/trk_old2" width="1">',
      '<img data-src="https://track.example/open/trk_old3.gif">',
      '<img src="https://example.com/photo.png" alt="photo">',
      '</blockquote></div>',
    ].join('');
    const out = transformOutgoingHtml(html, { pixelUrl: pixel, trackOpens: true, trackLinks: false });
    expect(out.html).not.toMatch(/trk_old/);
    expect(out.html).toContain('https://example.com/photo.png');
    expect(out.html).toContain('Earlier:');
    expect(out.pixelPresent).toBe(true);
    expect(transformOutgoingHtml(out.html, { pixelUrl: pixel, trackOpens: true, trackLinks: false }).html).toBe(out.html);
  });

  it('does not count a fetch from before sentAt as a recipient open', () => {
    const sent = Date.parse('2026-09-23T12:00:00.000Z');
    const browserUa = 'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36';
    const proxyUa = 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 GoogleImageProxy';
    const scannerUa = 'Barracuda Sentinel Scanner/1.0';
    const headlessUa = 'Mozilla/5.0 (X11; Linux x86_64) AppleWebKit/537.36 HeadlessChrome/120.0';

    // Pre-send
    expect(classifyOpenEvent({ eventTs: sent - 1, sentAt: sent, userAgent: browserUa }).countsAsOpen).toBe(false);
    expect(classifyOpenEvent({ eventTs: sent - 1, sentAt: sent, userAgent: browserUa }).classification).toBe('SELF_LIKELY');

    // Self-view correlated
    expect(classifyOpenEvent({ eventTs: sent + 1000, sentAt: sent, userAgent: browserUa, selfViewTs: sent + 1000 }).classification).toBe('SELF_LIKELY');
    expect(classifyOpenEvent({ eventTs: sent + 1000, sentAt: sent, userAgent: browserUa, selfViewTs: sent + 1000 }).countsAsOpen).toBe(false);

    // Self-view boundary checks: [-3s, +8s]
    const sv = sent + 10_000;
    expect(classifyOpenEvent({ eventTs: sv - 3000, sentAt: sent, userAgent: browserUa, selfViewTs: sv }).classification).toBe('SELF_LIKELY');
    expect(classifyOpenEvent({ eventTs: sv - 3001, sentAt: sent, userAgent: browserUa, selfViewTs: sv }).classification).toBe('RECIPIENT_LIKELY');
    expect(classifyOpenEvent({ eventTs: sv + 8000, sentAt: sent, userAgent: browserUa, selfViewTs: sv }).classification).toBe('SELF_LIKELY');
    expect(classifyOpenEvent({ eventTs: sv + 8001, sentAt: sent, userAgent: browserUa, selfViewTs: sv }).classification).toBe('RECIPIENT_LIKELY');

    // Google image proxy counts unless sender proxy suppression is active.
    expect(classifyOpenEvent({ eventTs: sent + 1000, sentAt: sent, userAgent: proxyUa }).classification).toBe('PROXY_LIKELY');
    expect(classifyOpenEvent({ eventTs: sent + 1000, sentAt: sent, userAgent: proxyUa }).countsAsOpen).toBe(true);
    expect(classifyOpenEvent({ eventTs: sent + 1000, sentAt: sent, userAgent: proxyUa, selfViewTs: sent + 1000, hasActiveSenderClaim: true }).classification).toBe('PROXY_LIKELY');
    expect(classifyOpenEvent({ eventTs: sent + 1000, sentAt: sent, userAgent: proxyUa, selfViewTs: sent + 1000, hasActiveSenderClaim: true }).countsAsOpen).toBe(true);
    expect(
      classifyOpenEvent({
        eventTs: sent + 1000,
        sentAt: sent,
        userAgent: proxyUa,
        hasActiveSenderProxySuppression: true,
      }).classification,
    ).toBe('SELF_LIKELY');

    // Security scanner fetch
    expect(classifyOpenEvent({ eventTs: sent + 1000, sentAt: sent, userAgent: scannerUa }).classification).toBe('MACHINE_LIKELY');
    expect(classifyOpenEvent({ eventTs: sent + 1000, sentAt: sent, userAgent: scannerUa }).countsAsOpen).toBe(false);

    // Headless / Lighthouse
    expect(classifyOpenEvent({ eventTs: sent + 1000, sentAt: sent, userAgent: headlessUa }).classification).toBe('MACHINE_LIKELY');
    expect(classifyOpenEvent({ eventTs: sent + 1000, sentAt: sent, userAgent: headlessUa }).countsAsOpen).toBe(false);

    // Unknown UA
    expect(classifyOpenEvent({ eventTs: sent + 1000, sentAt: sent, userAgent: '' }).classification).toBe('UNKNOWN');
    expect(classifyOpenEvent({ eventTs: sent + 1000, sentAt: sent, userAgent: '' }).countsAsOpen).toBe(false);

    // Genuine recipient open with browser UA
    expect(classifyOpenEvent({ eventTs: sent + 1000, sentAt: sent, userAgent: browserUa }).classification).toBe('RECIPIENT_LIKELY');
    expect(classifyOpenEvent({ eventTs: sent + 1000, sentAt: sent, userAgent: browserUa }).countsAsOpen).toBe(true);
    expect(classifyOpenEvent({ eventTs: sent + 60_000, sentAt: sent, userAgent: browserUa }).classification).toBe('RECIPIENT_LIKELY');
  });

  it('keeps a local sent linkage when the tracker still says pending', () => {
    const local: TrackedEmailSummary = {
      trackingId: 'trk_1',
      status: 'SENT',
      subject: 'Hello',
      sender: 'me@example.com',
      recipients: ['a@b.com'],
      gmailThreadId: 'thread-1',
      gmailMessageId: 'msg-1',
      sentAt: '2026-09-23T12:00:00.000Z',
      firstOpenedAt: null,
      lastOpenedAt: null,
      openCount: 1,
      clickCount: 0,
      notifyIfNoReply: true,
    };
    const merged = summaryFromRemote(
      {
        tracking_id: 'trk_1',
        status: 'PENDING',
        subject: 'Hello',
        sender: 'me@example.com',
        recipients: ['a@b.com'],
        sent_at: null,
        open_count: 0,
        gmail_thread_id: null,
        gmail_message_id: null,
      },
      local,
    );
    expect(merged.status).toBe('SENT');
    expect(merged.sentAt).toBe(local.sentAt);
    expect(merged.gmailThreadId).toBe('thread-1');
    expect(merged.openCount).toBe(1);
  });

  it('matches thread ids after InboxSDK prefix normalization', () => {
    expect(normalizeGmailId('msg-a:abc')).toBe('abc');
    expect(normalizeGmailId('#thread-f:abc')).toBe('abc');
    const email: TrackedEmailSummary = {
      trackingId: 'trk_1',
      status: 'SENT',
      subject: 'Hello',
      sender: 'me',
      recipients: ['a@b.com'],
      gmailThreadId: 'abc',
      gmailMessageId: null,
      sentAt: '2026-09-23T12:00:00.000Z',
      firstOpenedAt: null,
      lastOpenedAt: null,
      openCount: 0,
      clickCount: 0,
      notifyIfNoReply: false,
    };
    expect(matchTrackedEmail({ threadIds: ['thread-f:abc'], subject: 'Hello', emails: [] }, [email])?.trackingId).toBe('trk_1');
  });

  it('reads a tracking pixel out of raw mime', () => {
    const raw = `Content-Type: text/html\n\n<div>Hi</div><img src="https://track.example/open/trk_abc" width="1"><a href="https://track.example/c/clk_123">docs</a>`;
    expect(inspectTrackedMime(raw)).toMatchObject({
      pixelFound: true,
      trackingIds: ['trk_abc'],
      pixelCount: 1,
      trackedLinks: 1,
    });
    expect(inspectTrackedMime('Hello there').pixelFound).toBe(false);
  });

  it('notifies for recipient browser opens and Gmail proxy opens, and skips self, machine, and unknown', () => {
    const browser = 'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 Chrome/120.0.0.0 Safari/537.36';
    const events = [
      { id: 'ev_browser', type: 'OPEN', classification: 'RECIPIENT_LIKELY', user_agent: browser },
      { id: 'ev_proxy', type: 'OPEN', classification: 'PROXY_LIKELY', user_agent: 'GoogleImageProxy' },
      { id: 'ev_proxy_browser_ua', type: 'OPEN', classification: 'PROXY_LIKELY', user_agent: browser },
      { id: 'ev_self', type: 'OPEN', classification: 'SELF_LIKELY', suspected_self_open: true, user_agent: browser },
      { id: 'ev_machine', type: 'OPEN', classification: 'MACHINE_LIKELY', user_agent: 'Barracuda Sentinel Scanner' },
      { id: 'ev_unknown', type: 'OPEN', classification: 'UNKNOWN', user_agent: 'curl/8.0' },
      { id: 'ev_view', type: 'SELF_VIEW', classification: 'SELF_LIKELY', user_agent: browser },
      { id: 'ev_click', type: 'CLICK', classification: 'RECIPIENT_LIKELY', user_agent: browser },
    ];
    expect(events.filter((event) => isNotifiableTrackingEvent(event)).map((event) => event.id)).toEqual([
      'ev_browser',
      'ev_proxy',
      'ev_click',
    ]);
  });
});

describe('tracking notification text', () => {
  const proxyUa = 'Mozilla/5.0 (Windows NT 5.1; rv:11.0) Gecko Firefox/11.0 (via ggpht.com GoogleImageProxy)';
  const chromeUa = 'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36';

  it('reports a detection for the email and never claims who read it', () => {
    expect(describeTrackingNotification({ type: 'OPEN', user_agent: chromeUa }, { subject: 'Invoice' })).toEqual({
      title: 'PigeonBox',
      message: 'Open detected for “Invoice”',
    });
    expect(describeTrackingNotification({ type: 'OPEN', user_agent: proxyUa }, { subject: 'Plan' }, 3).message).toBe('Open detected for “Plan” (3 times)');
    expect(describeTrackingNotification({ type: 'CLICK', user_agent: chromeUa }, { subject: 'Plan' })).toEqual({
      title: 'PigeonBox',
      message: 'A link was clicked in “Plan”',
    });
  });

  it('falls back to a generic subject when the email is unknown', () => {
    expect(describeTrackingNotification({ type: 'OPEN' }, null).message).toBe('Open detected for “your email”');
  });

  it('recognises common mail apps and stays quiet for plain browsers', () => {
    expect(describeOpenClient(proxyUa)).toBe('Gmail');
    expect(describeOpenClient('Microsoft Office/16.0 (Windows NT 10.0; Microsoft Outlook 16.0.17126; Pro)')).toBe('Outlook');
    expect(describeOpenClient('Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/605.1.15 (KHTML, like Gecko)')).toBe('Apple Mail');
    expect(
      describeOpenClient('Mozilla/5.0 (iPhone; CPU iPhone OS 17_0 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) Mobile/15E148'),
    ).toBe('Apple Mail on iOS');
    expect(describeOpenClient(chromeUa)).toBeNull();
    expect(describeOpenClient('Mozilla/5.0')).toBeNull();
    expect(describeOpenClient(undefined)).toBeNull();
  });
});
