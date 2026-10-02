import { describe, expect, it } from 'vitest';
import {
  applyRecentOpens,
  classifyClickEvent,
  deriveTrackingStats,
  describeTrackingStatus,
  planPageReloadProxy,
  detectOpenRequestSource,
  isSelfViewCorrelated,
  matchTrackedEmail,
  normalizeGmailId,
  transformOutgoingHtml,
  classifyOpenEvent,
  probeTracker,
  formatTrackingReport,
  TrackingClient,
  TRACKER_PROTOCOL_VERSION,
  type TrackedEmailSummary,
  type TrackingDiagnosticsReport,
  type TrackingEvent,
} from './index';

describe('Regression Matrix (Cases A through N)', () => {
  // Case A: Same thread, second email sent -> second email unread -> row must show UNREAD / gray.
  it('Case A: Same thread, second email sent -> second email unread -> row must show UNREAD / pending', () => {
    const olderOpened: TrackedEmailSummary = {
      trackingId: 'trk_send_1',
      subject: 'Discussion',
      sender: 'me@example.com',
      recipients: ['alice@example.com'],
      gmailThreadId: 'thread_100',
      gmailMessageId: 'msg_1',
      sentAt: '2026-09-24T10:00:00.000Z',
      firstOpenedAt: '2026-09-24T10:05:00.000Z',
      lastOpenedAt: '2026-09-24T10:05:00.000Z',
      openCount: 1,
      clickCount: 0,
      notifyIfNoReply: false,
    };
    const newerUnread: TrackedEmailSummary = {
      trackingId: 'trk_send_2',
      subject: 'Discussion',
      sender: 'me@example.com',
      recipients: ['alice@example.com'],
      gmailThreadId: 'thread_100',
      gmailMessageId: 'msg_2',
      sentAt: '2026-09-24T12:00:00.000Z',
      firstOpenedAt: null,
      lastOpenedAt: null,
      openCount: 0,
      clickCount: 0,
      notifyIfNoReply: false,
    };

    const matched = matchTrackedEmail(
      { threadIds: ['thread_100'], subject: 'Discussion', emails: ['alice@example.com'] },
      [olderOpened, newerUnread],
    );

    expect(matched?.trackingId).toBe('trk_send_2');
    expect(matched?.openCount).toBe(0);
    const status = describeTrackingStatus(matched!, { trackerBaseUrl: 'https://track.example' });
    expect(status.opened).toBe(false);
    expect(status.markLabel).toBe('Sent');
    expect(status.countLabel).toBe('No open detected yet');
  });

  // Case B: Same thread, second email sent -> second email opened -> row must show OPENED.
  it('Case B: Same thread, second email sent -> second email opened -> row must show OPENED', () => {
    const olderUnread: TrackedEmailSummary = {
      trackingId: 'trk_send_1',
      subject: 'Discussion',
      sender: 'me@example.com',
      recipients: ['alice@example.com'],
      gmailThreadId: 'thread_100',
      gmailMessageId: 'msg_1',
      sentAt: '2026-09-24T10:00:00.000Z',
      firstOpenedAt: null,
      lastOpenedAt: null,
      openCount: 0,
      clickCount: 0,
      notifyIfNoReply: false,
    };
    const newerOpened: TrackedEmailSummary = {
      trackingId: 'trk_send_2',
      subject: 'Discussion',
      sender: 'me@example.com',
      recipients: ['alice@example.com'],
      gmailThreadId: 'thread_100',
      gmailMessageId: 'msg_2',
      sentAt: '2026-09-24T12:00:00.000Z',
      firstOpenedAt: '2026-09-24T12:10:00.000Z',
      lastOpenedAt: '2026-09-24T12:10:00.000Z',
      openCount: 1,
      clickCount: 0,
      notifyIfNoReply: false,
    };

    const matched = matchTrackedEmail(
      { threadIds: ['thread_100'], subject: 'Discussion', emails: ['alice@example.com'] },
      [olderUnread, newerOpened],
    );

    expect(matched?.trackingId).toBe('trk_send_2');
    expect(matched?.openCount).toBe(1);
    const status = describeTrackingStatus(matched!, { trackerBaseUrl: 'https://track.example' });
    expect(status.opened).toBe(true);
    expect(status.markLabel).toBe('Opened');
    expect(status.countLabel).toBe('Opened once');
  });

  // Case C: GoogleImageProxy fetch alone counts as one Gmail recipient render.
  it('Case C: GoogleImageProxy fetch alone counts as one open', () => {
    const proxyUA = 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36 GoogleImageProxy';
    expect(detectOpenRequestSource(proxyUA)).toBe('google_image_proxy');

    const stats = deriveTrackingStats([
      {
        type: 'OPEN',
        timestamp: '2026-09-24T10:01:00.000Z',
        userAgent: proxyUA,
        classification: 'PROXY_LIKELY',
      },
    ]);
    expect(stats.openCount).toBe(1);
    expect(stats.firstOpenedAt).toBe('2026-09-24T10:01:00.000Z');
  });

  // Case D: Bot / scanner / headless fetch -> raw event logged -> openCount remains 0.
  it('Case D: Bot / scanner / headless fetch -> raw event logged -> openCount remains 0', () => {
    const scannerUA = 'Barracuda Sentinel Scanner/2.1 (Security Crawler)';
    const headlessUA = 'Mozilla/5.0 HeadlessChrome/120.0.0.0 Safari/537.36';

    expect(detectOpenRequestSource(scannerUA)).toBe('scanner');
    expect(detectOpenRequestSource(headlessUA)).toBe('headless');

    const stats = deriveTrackingStats([
      {
        type: 'OPEN',
        timestamp: '2026-09-24T10:01:00.000Z',
        userAgent: scannerUA,
        classification: 'MACHINE_LIKELY',
      },
      {
        type: 'OPEN',
        timestamp: '2026-09-24T10:02:00.000Z',
        userAgent: headlessUA,
        classification: 'MACHINE_LIKELY',
      },
    ]);
    expect(stats.openCount).toBe(0);
  });

  // Case E: Missing UA fetch -> raw event logged -> openCount remains 0.
  it('Case E: Missing UA fetch -> raw event logged -> openCount remains 0', () => {
    expect(detectOpenRequestSource('')).toBe('unknown');
    expect(detectOpenRequestSource(null)).toBe('unknown');
    expect(detectOpenRequestSource(undefined)).toBe('unknown');

    const stats = deriveTrackingStats([
      {
        type: 'OPEN',
        timestamp: '2026-09-24T10:01:00.000Z',
        userAgent: null,
        classification: 'UNKNOWN',
      },
    ]);
    expect(stats.openCount).toBe(0);
  });

  // Case F: Self-view in Sent folder -> open arrives 1.5s later -> self-view suppresses open.
  it('Case F: Self-view in Sent folder -> open arrives 1.5s later -> self-view suppresses open', () => {
    const selfViewTs = Date.parse('2026-09-24T10:00:00.000Z');
    const openTs = selfViewTs + 1500; // 1.5s later

    expect(isSelfViewCorrelated(openTs, selfViewTs)).toBe(true);

    const stats = deriveTrackingStats([
      {
        type: 'SELF_VIEW',
        timestamp: new Date(selfViewTs).toISOString(),
      },
      {
        type: 'OPEN',
        timestamp: new Date(openTs).toISOString(),
        classification: 'SELF_LIKELY',
        suspectedSelfOpen: true,
      },
    ]);
    expect(stats.openCount).toBe(0);
  });

  // Case G: Recipient opens email -> openCount becomes 1 -> sender opens email 20s later -> openCount remains 1.
  it('Case G: Recipient opens email -> openCount becomes 1 -> sender opens email 20s later -> openCount remains 1', () => {
    const recipientOpenTs = Date.parse('2026-09-24T10:00:00.000Z');
    const senderSelfViewTs = recipientOpenTs + 20_000;
    const senderPixelOpenTs = senderSelfViewTs + 500;

    // Recipient open is NOT correlated with sender self view (+20s later)
    expect(isSelfViewCorrelated(recipientOpenTs, senderSelfViewTs)).toBe(false);
    // Sender pixel open IS correlated with sender self view
    expect(isSelfViewCorrelated(senderPixelOpenTs, senderSelfViewTs)).toBe(true);

    const stats = deriveTrackingStats([
      {
        type: 'OPEN',
        timestamp: new Date(recipientOpenTs).toISOString(),
        classification: 'RECIPIENT_LIKELY',
        userAgent: 'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 Chrome/120 Safari/537.36',
      },
      {
        type: 'SELF_VIEW',
        timestamp: new Date(senderSelfViewTs).toISOString(),
      },
      {
        type: 'OPEN',
        timestamp: new Date(senderPixelOpenTs).toISOString(),
        classification: 'SELF_LIKELY',
        suspectedSelfOpen: true,
        userAgent: 'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 Chrome/120 Safari/537.36',
      },
    ]);

    expect(stats.openCount).toBe(1);
    expect(stats.firstOpenedAt).toBe(new Date(recipientOpenTs).toISOString());
    expect(stats.lastOpenedAt).toBe(new Date(recipientOpenTs).toISOString());
  });

  // Case H: Deduplicated pixel reload within 800ms -> openCount increments by 1, not 2.
  it('Case H: Deduplicated pixel reload within 800ms -> openCount increments by 1, not 2', () => {
    const browserUA = 'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 Chrome/120 Safari/537.36';
    const stats = deriveTrackingStats([
      {
        type: 'OPEN',
        timestamp: '2026-09-24T10:00:00.000Z',
        classification: 'RECIPIENT_LIKELY',
        userAgent: browserUA,
      },
      {
        type: 'OPEN',
        timestamp: '2026-09-24T10:00:00.500Z', // 500ms later (< 800ms)
        classification: 'RECIPIENT_LIKELY',
        userAgent: browserUA,
      },
      {
        type: 'OPEN',
        timestamp: '2026-09-24T10:05:00.000Z', // 5 mins later (> 800ms)
        classification: 'RECIPIENT_LIKELY',
        userAgent: browserUA,
      },
    ]);

    expect(stats.openCount).toBe(2);
    expect(stats.firstOpenedAt).toBe('2026-09-24T10:00:00.000Z');
    expect(stats.lastOpenedAt).toBe('2026-09-24T10:05:00.000Z');
  });

  // Case I: Worker store derives aggregates correctly on self-view reclassification.
  it('Case I: Worker store derives aggregates correctly on self-view reclassification', () => {
    const rawEvents: Array<{
      type: string;
      timestamp: string;
      classification?: string;
      suspectedSelfOpen?: boolean;
      userAgent?: string | null;
    }> = [
      {
        type: 'OPEN',
        timestamp: '2026-09-24T10:00:01.000Z',
        classification: 'RECIPIENT_LIKELY',
        userAgent: 'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 Chrome/120 Safari/537.36',
      },
    ];

    let stats = deriveTrackingStats(rawEvents);
    expect(stats.openCount).toBe(1);

    // Now a self-view is registered at 10:00:00.000Z, reclassifying the open at 10:00:01.000Z to SELF_LIKELY
    rawEvents[0].classification = 'SELF_LIKELY';
    rawEvents[0].suspectedSelfOpen = true;

    stats = deriveTrackingStats(rawEvents);
    expect(stats.openCount).toBe(0);
    expect(stats.firstOpenedAt).toBeNull();
  });

  it('Case J: Client applyRecentOpens counts Gmail proxy opens and ignores machine and self opens', () => {
    const email: TrackedEmailSummary = {
      trackingId: 'trk_test',
      subject: 'Test',
      sender: 'me@example.com',
      recipients: ['bob@example.com'],
      gmailThreadId: 'thread_1',
      gmailMessageId: 'msg_1',
      sentAt: '2026-09-24T10:00:00.000Z',
      firstOpenedAt: null,
      lastOpenedAt: null,
      openCount: 0,
      clickCount: 0,
      notifyIfNoReply: false,
    };

    const machineEvents: TrackingEvent[] = [
      {
        id: 'ev_1',
        tracking_id: 'trk_test',
        type: 'OPEN',
        timestamp: '2026-09-24T10:01:00.000Z',
        classification: 'PROXY_LIKELY',
        user_agent: 'GoogleImageProxy',
      },
      {
        id: 'ev_2',
        tracking_id: 'trk_test',
        type: 'OPEN',
        timestamp: '2026-09-24T10:02:00.000Z',
        classification: 'MACHINE_LIKELY',
        user_agent: 'Scanner/1.0',
      },
      {
        id: 'ev_3',
        tracking_id: 'trk_test',
        type: 'OPEN',
        timestamp: '2026-09-24T10:03:00.000Z',
        classification: 'SELF_LIKELY',
        suspected_self_open: true,
        user_agent: 'Mozilla/5.0 Chrome/120',
      },
    ];

    const updated = applyRecentOpens([email], machineEvents);
    expect(updated[0].openCount).toBe(1);
    expect(updated[0].firstOpenedAt).toBe('2026-09-24T10:01:00.000Z');

    const ignored = applyRecentOpens([email], machineEvents.filter((event) => event.classification !== 'PROXY_LIKELY'));
    expect(ignored[0].openCount).toBe(0);
  });

  // Case K: Exact messageId match prioritizes correct email even if threadId has multiple sends.
  it('Case K: Exact messageId match prioritizes correct email even if threadId has multiple sends', () => {
    const send1: TrackedEmailSummary = {
      trackingId: 'trk_1',
      subject: 'Thread Test',
      sender: 'me@example.com',
      recipients: ['carol@example.com'],
      gmailThreadId: 'thread_xyz',
      gmailMessageId: 'msg_send_1',
      sentAt: '2026-09-24T08:00:00.000Z',
      firstOpenedAt: '2026-09-24T08:10:00.000Z',
      lastOpenedAt: '2026-09-24T08:10:00.000Z',
      openCount: 1,
      clickCount: 0,
      notifyIfNoReply: false,
    };
    const send2: TrackedEmailSummary = {
      trackingId: 'trk_2',
      subject: 'Thread Test',
      sender: 'me@example.com',
      recipients: ['carol@example.com'],
      gmailThreadId: 'thread_xyz',
      gmailMessageId: 'msg_send_2',
      sentAt: '2026-09-24T12:00:00.000Z',
      firstOpenedAt: null,
      lastOpenedAt: null,
      openCount: 0,
      clickCount: 0,
      notifyIfNoReply: false,
    };

    // Query targeting message msg_send_1 specifically inside thread_xyz
    const matchMsg1 = matchTrackedEmail(
      {
        threadIds: ['thread_xyz'],
        messageId: 'msg_send_1',
        messageIds: ['msg_send_1'],
        subject: 'Thread Test',
        emails: ['carol@example.com'],
      },
      [send1, send2],
    );
    expect(matchMsg1?.trackingId).toBe('trk_1');

    // Query targeting message msg_send_2 specifically inside thread_xyz
    const matchMsg2 = matchTrackedEmail(
      {
        threadIds: ['thread_xyz'],
        messageId: 'msg_send_2',
        messageIds: ['msg_send_2'],
        subject: 'Thread Test',
        emails: ['carol@example.com'],
      },
      [send1, send2],
    );
    expect(matchMsg2?.trackingId).toBe('trk_2');
  });

  // Case L: Outbound compose tracking injection remains untouched and produces working MIME.
  it('Case L: Outbound compose tracking injection produces working HTML with pixel and link rewrites', () => {
    const inputHtml = '<div>Hello Carol, please check <a href="https://example.com/docs">our docs</a>.</div>';
    const pixelUrl = 'https://track.example/open/trk_case_l.gif';
    const rewritten = transformOutgoingHtml(inputHtml, {
      pixelUrl,
      trackOpens: true,
      trackLinks: true,
      linkMap: new Map([
        ['https://example.com/docs', 'https://track.example/c/clk_123'],
      ]),
    });

    expect(rewritten.pixelPresent).toBe(true);
    expect(rewritten.linksRewritten).toBe(1);
    expect(rewritten.html).toContain('https://track.example/c/clk_123');
    expect(rewritten.html).toContain('<img src="https://track.example/open/trk_case_l.gif"');
    expect(rewritten.html).toContain('role="presentation"');
  });

  // Case M: MV3 background wake-up delay - sender interaction observed timestamp reclassifies open and resets open count to 0.
  it('Case M: MV3 background wake-up delay - sender interaction observed timestamp reclassifies open and resets open count to 0', () => {
    const sentAt = Date.parse('2026-09-24T12:00:00.000Z');
    const senderObservedAt = sentAt + 10_000; // T+10s: sender views email in Sent folder
    const openArrivalTs = senderObservedAt + 500; // T+10.5s: pixel fetch arrives at server

    // Before self-view arrives, pixel fetch is considered a recipient open:
    const initialEvents: TrackingEvent[] = [
      {
        id: 'ev_open_1',
        tracking_id: 'trk_mv3_delay',
        type: 'OPEN',
        timestamp: new Date(openArrivalTs).toISOString(),
        classification: 'RECIPIENT_LIKELY',
        user_agent: 'Mozilla/5.0 Chrome/120',
      },
    ];

    const email: TrackedEmailSummary = {
      trackingId: 'trk_mv3_delay',
      subject: 'MV3 Delay Matrix Test',
      sender: 'me@example.com',
      recipients: ['recipient@example.com'],
      gmailThreadId: 'thread_mv3',
      gmailMessageId: 'msg_mv3',
      sentAt: new Date(sentAt).toISOString(),
      firstOpenedAt: null,
      lastOpenedAt: null,
      openCount: 0,
      clickCount: 0,
      notifyIfNoReply: false,
    };

    let updated = applyRecentOpens([email], initialEvents);
    expect(updated[0].openCount).toBe(1);

    // MV3 background service worker wakes up 5 seconds later (T+15s), but sends the content script interaction timestamp (T+10s):
    expect(isSelfViewCorrelated(openArrivalTs, senderObservedAt)).toBe(true);

    const reclassifiedEvents: TrackingEvent[] = [
      {
        id: 'ev_open_1',
        tracking_id: 'trk_mv3_delay',
        type: 'OPEN',
        timestamp: new Date(openArrivalTs).toISOString(),
        classification: 'SELF_LIKELY',
        suspected_self_open: true,
        user_agent: 'Mozilla/5.0 Chrome/120',
      },
      {
        id: 'ev_self_1',
        tracking_id: 'trk_mv3_delay',
        type: 'SELF_VIEW',
        timestamp: new Date(senderObservedAt).toISOString(),
        classification: 'SELF_LIKELY',
        suspected_self_open: true,
      },
    ];

    updated = applyRecentOpens([email], reclassifiedEvents);
    expect(updated[0].openCount).toBe(0);
    expect(updated[0].firstOpenedAt).toBeNull();

    const stats = deriveTrackingStats(reclassifiedEvents);
    expect(stats.openCount).toBe(0);
    expect(stats.firstOpenedAt).toBeNull();
  });

  // Case N: Gmail ID normalization with msg-a: / thread-f: prefixes matches stored bare IDs accurately in thread view.
  it('Case N: Gmail ID normalization with msg-a: / thread-f: prefixes matches stored bare IDs accurately', () => {
    expect(normalizeGmailId('msg-a:r-1234567890')).toBe('r-1234567890');
    expect(normalizeGmailId('#thread-f:thread-abc')).toBe('thread-abc');

    const storedEmail: TrackedEmailSummary = {
      trackingId: 'trk_norm_test',
      subject: 'Normalized IDs',
      sender: 'me@example.com',
      recipients: ['bob@example.com'],
      gmailThreadId: 'thread_xyz',
      gmailMessageId: 'msg_bare_123',
      sentAt: '2026-09-24T10:00:00.000Z',
      firstOpenedAt: null,
      lastOpenedAt: null,
      openCount: 0,
      clickCount: 0,
      notifyIfNoReply: false,
    };

    // Client query arrives from InboxSDK MessageView with 'msg-a:msg_bare_123' and thread 'thread-f:thread_xyz'
    const matched = matchTrackedEmail(
      {
        threadIds: ['thread-f:thread_xyz'],
        messageId: 'msg-a:msg_bare_123',
        messageIds: ['msg-a:msg_bare_123'],
        subject: 'Normalized IDs',
        emails: ['bob@example.com'],
      },
      [storedEmail],
    );

    expect(matched?.trackingId).toBe('trk_norm_test');
  });

  // Case O: Click classification and telemetry (recipient clicks vs sender clicks vs scanner clicks, and pixelLoadCount / possibleOpenCount)
  it('Case O: Click classification and telemetry derives accurate click and open counts', () => {
    const sendTs = Date.parse('2026-09-24T10:00:00.000Z');
    const senderSelfViewTs = Date.parse('2026-09-24T10:01:00.000Z');

    // 1. Pre-send click (composer/preview) -> SELF_LIKELY
    const preSendClick = classifyClickEvent({
      eventTs: sendTs - 5000,
      sentAt: sendTs,
      userAgent: 'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7)',
    });
    expect(preSendClick.classification).toBe('SELF_LIKELY');
    expect(preSendClick.countsAsClick).toBe(false);

    // 2. Sender self-click correlated with self-view -> SELF_LIKELY
    const senderClick = classifyClickEvent({
      eventTs: senderSelfViewTs + 1000,
      sentAt: sendTs,
      userAgent: 'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7)',
      selfViewTs: senderSelfViewTs,
    });
    expect(senderClick.classification).toBe('SELF_LIKELY');
    expect(senderClick.countsAsClick).toBe(false);

    // 3. Security scanner click -> MACHINE_LIKELY
    const scannerClick = classifyClickEvent({
      eventTs: sendTs + 60000,
      sentAt: sendTs,
      userAgent: 'Proofpoint-URL-Scanner/2.0',
    });
    expect(scannerClick.classification).toBe('MACHINE_LIKELY');
    expect(scannerClick.countsAsClick).toBe(false);

    // 4. Recipient click -> RECIPIENT_LIKELY
    const recipientClick = classifyClickEvent({
      eventTs: sendTs + 120000,
      sentAt: sendTs,
      userAgent: 'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 Chrome/120.0.0.0 Safari/537.36',
    });
    expect(recipientClick.classification).toBe('RECIPIENT_LIKELY');
    expect(recipientClick.countsAsClick).toBe(true);

    // 5. Derive stats from mixed events including proxy opens, self-view, and clicks
    const stats = deriveTrackingStats([
      // Pixel load from GoogleImageProxy (proxy open, possible open)
      {
        type: 'OPEN',
        timestamp: '2026-09-24T10:00:30.000Z',
        classification: 'PROXY_LIKELY',
        userAgent: 'GoogleImageProxy',
      },
      // Sender self-view pixel load (must not count towards verified open or possible open)
      {
        type: 'OPEN',
        timestamp: '2026-09-24T10:01:00.000Z',
        classification: 'SELF_LIKELY',
        suspectedSelfOpen: true,
      },
      // Sender click correlated with self-view
      {
        type: 'CLICK',
        timestamp: '2026-09-24T10:01:01.000Z',
        classification: 'SELF_LIKELY',
        suspectedSelfOpen: true,
      },
      // Scanner click
      {
        type: 'CLICK',
        timestamp: '2026-09-24T10:02:00.000Z',
        classification: 'MACHINE_LIKELY',
      },
      // Legitimate recipient open
      {
        type: 'OPEN',
        timestamp: '2026-09-24T10:05:00.000Z',
        classification: 'RECIPIENT_LIKELY',
        userAgent: 'Mozilla/5.0 Safari/605.1.15',
      },
      // Legitimate recipient click
      {
        type: 'CLICK',
        timestamp: '2026-09-24T10:05:30.000Z',
        classification: 'RECIPIENT_LIKELY',
      },
      // Legacy unclassified click (backward compatibility fallback)
      {
        type: 'CLICK',
        timestamp: '2026-09-24T10:06:00.000Z',
        userAgent: 'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7)',
      },
    ]);

    expect(stats.openCount).toBe(2); // Gmail proxy render + recipient open
    expect(stats.pixelLoadCount).toBe(3); // All 3 OPEN events
    expect(stats.possibleOpenCount).toBe(2); // Proxy open + recipient open (self-view excluded)
    expect(stats.clickCount).toBe(2); // 1 RECIPIENT_LIKELY + 1 legacy unclassified (self and scanner clicks excluded)
    expect(stats.firstClickedAt).toBe('2026-09-24T10:05:30.000Z');
  });

  // Case P: Aggregation with >200 events derives stats accurately without truncation
  it('Case P: Aggregation with >200 events derives accurate counts without truncation', () => {
    const events: Array<{ type: string; timestamp: string; classification: string }> = [];
    const baseTime = Date.parse('2026-09-24T10:00:00.000Z');

    // Generate 250 distinct recipient opens 2 seconds apart
    for (let i = 0; i < 250; i++) {
      events.push({
        type: 'OPEN',
        timestamp: new Date(baseTime + i * 2000).toISOString(),
        classification: 'RECIPIENT_LIKELY',
      });
    }

    const stats = deriveTrackingStats(events);
    expect(stats.openCount).toBe(250);
    expect(stats.pixelLoadCount).toBe(250);
    expect(stats.firstOpenedAt).toBe(new Date(baseTime).toISOString());
    expect(stats.lastOpenedAt).toBe(new Date(baseTime + 249 * 2000).toISOString());
  });

  // Case Q: probeTracker detects outdated protocol version (< 3)
  it('Case Q: probeTracker flags outdated protocol version', async () => {
    const mockFetcher = (async (url: string) => {
      if (url.endsWith('/health')) {
        return new Response(JSON.stringify({ ok: true, protocolVersion: 2, features: ['self_view_claims'] }), {
          status: 200,
          headers: { 'Content-Type': 'application/json' },
        });
      }
      return new Response(JSON.stringify({ ok: true }), { status: 200 });
    }) as typeof fetch;

    const probe = await probeTracker('https://track.example.com', 'secret-token', mockFetcher);
    expect(probe.status).toBe('outdated');
    expect(probe.protocolVersion).toBe(2);
    expect(probe.label).toContain('outdated');
  });

  // Case R: probeTracker detects missing self_view_claims feature
  it('Case R: probeTracker flags missing self_view_claims feature', async () => {
    const mockFetcher = (async (url: string) => {
      if (url.endsWith('/health')) {
        return new Response(JSON.stringify({ ok: true, protocolVersion: 3, features: ['event_reclassification'] }), {
          status: 200,
          headers: { 'Content-Type': 'application/json' },
        });
      }
      return new Response(JSON.stringify({ ok: true }), { status: 200 });
    }) as typeof fetch;

    const probe = await probeTracker('https://track.example.com', 'secret-token', mockFetcher);
    expect(probe.status).toBe('outdated');
    expect(probe.features).toEqual(['event_reclassification']);
    expect(probe.label).toContain('outdated');
  });

  // Case S: probeTracker succeeds when protocolVersion >= 3 and self_view_claims present
  it('Case S: probeTracker succeeds with protocolVersion >= 3 and self_view_claims', async () => {
    const mockFetcher = (async (url: string) => {
      if (url.endsWith('/health')) {
        return new Response(
          JSON.stringify({ ok: true, protocolVersion: 3, features: ['self_view_claims', 'event_reclassification'] }),
          { status: 200, headers: { 'Content-Type': 'application/json' } },
        );
      }
      if (url.includes('/api/emails')) {
        return new Response(JSON.stringify([]), { status: 200, headers: { 'Content-Type': 'application/json' } });
      }
      return new Response(JSON.stringify({ ok: true }), { status: 200 });
    }) as typeof fetch;

    const probe = await probeTracker('https://track.example.com', 'secret-token', mockFetcher);
    expect(probe.status).toBe('healthy');
    expect(probe.protocolVersion).toBe(TRACKER_PROTOCOL_VERSION);
    expect(probe.label).toBe('Tracker healthy');
  });

  // Case T: a sender claim suppresses browser-like opens. Proxy counts unless proxy suppression is active.
  it('Case T: classifyOpenEvent with hasActiveSenderClaim classifies browser opens as SELF_LIKELY', () => {
    const baseTime = Date.parse('2026-09-24T10:00:00.000Z');
    const openTime = baseTime + 10_000; // T+10s (outside legacy correlation window)

    // With hasActiveSenderClaim: true, browser UA is suppressed as SELF_LIKELY
    const browserVerdict = classifyOpenEvent({
      eventTs: openTime,
      sentAt: baseTime,
      userAgent: 'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36',
      hasActiveSenderClaim: true,
    });
    expect(browserVerdict.classification).toBe('SELF_LIKELY');
    expect(browserVerdict.countsAsOpen).toBe(false);
    expect(browserVerdict.suspected).toBe(true);

    // A browser sender claim does not suppress GoogleImageProxy. Proxy suppression does.
    const proxyVerdict = classifyOpenEvent({
      eventTs: openTime,
      sentAt: baseTime,
      userAgent: 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 GoogleImageProxy',
      hasActiveSenderClaim: true,
    });
    expect(proxyVerdict.classification).toBe('PROXY_LIKELY');
    expect(proxyVerdict.countsAsOpen).toBe(true);
    expect(proxyVerdict.source).toBe('google_image_proxy');
    const suppressedProxy = classifyOpenEvent({
      eventTs: openTime,
      sentAt: baseTime,
      userAgent: 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 GoogleImageProxy',
      hasActiveSenderProxySuppression: true,
    });
    expect(suppressedProxy.classification).toBe('SELF_LIKELY');
    expect(suppressedProxy.countsAsOpen).toBe(false);

    // Without active claim or self-view at T+10s, browser UA is RECIPIENT_LIKELY
    const recipientVerdict = classifyOpenEvent({
      eventTs: openTime,
      sentAt: baseTime,
      userAgent: 'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36',
      hasActiveSenderClaim: false,
    });
    expect(recipientVerdict.classification).toBe('RECIPIENT_LIKELY');
    expect(recipientVerdict.countsAsOpen).toBe(true);
  });

  // Case U: formatTrackingReport formats diagnostics report including lastSelfView
  it('Case U: formatTrackingReport includes lastSelfView diagnostic details', () => {
    const report: TrackingDiagnosticsReport = {
      health: 'healthy',
      endpoint: 'https://track.example.com',
      auth: 'configured',
      inboxSdk: 'ready',
      pageWorld: 'ready',
      composeHook: 'ready',
      last: null,
      lastSelfView: {
        observedAt: '2026-09-24T09:59:00.000Z',
        source: 'MESSAGE_LOAD',
        trackingId: 'trk_xyz',
        normalizedMessageId: 'msg_123',
        deliveryStatus: 'delivered',
        claimId: 'clm_abc',
        claimExpiresAt: '2026-09-24T09:59:25.000Z',
        retryCount: 0,
        lastError: null,
        claimConsumed: false,
        openCount: 0,
      },
    };

    const formatted = formatTrackingReport(report);
    expect(formatted).toContain('Tracker healthy');
    expect(formatted).toContain('trk_xyz');
    expect(formatted).toContain('msg_123');
    expect(formatted).toContain('MESSAGE_LOAD');
    expect(formatted).toContain('clm_abc');
    expect(formatted).toContain('2026-09-24T09:59:25.000Z');
  });

  // Case V: Requirement 37 - Old architecture failure vs New claim architecture on delayed pixel
  it('Case V: Proves old timestamp correlation fails on T+9.5s pixel while claim-based architecture succeeds', () => {
    const t0 = 1000;
    const tPixel = t0 + 9500; // T+9.5s
    const ua = 'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36';

    // 1. Old architecture: uses ONLY timestamp correlation ([-3s, +8s])
    const oldCorrelated = isSelfViewCorrelated(tPixel, t0);
    expect(oldCorrelated).toBe(false); // 9500 > 8000 -> FAILS TO CORRELATE!
    const oldVerdict = classifyOpenEvent({
      eventTs: tPixel,
      sentAt: t0 - 10_000,
      userAgent: ua,
      selfViewTs: t0,
      hasActiveSenderClaim: false, // Old architecture had no claim concept
    });
    // Old architecture incorrectly counted sender open as recipient open!
    expect(oldVerdict.classification).toBe('RECIPIENT_LIKELY');
    expect(oldVerdict.countsAsOpen).toBe(true);

    // 2. New architecture: hasActiveSenderClaim (with 25s TTL)
    const newVerdict = classifyOpenEvent({
      eventTs: tPixel,
      sentAt: t0 - 10_000,
      userAgent: ua,
      selfViewTs: t0,
      hasActiveSenderClaim: true,
    });
    // New architecture correctly suppresses the delayed open!
    expect(newVerdict.classification).toBe('SELF_LIKELY');
    expect(newVerdict.countsAsOpen).toBe(false);
  });

  // Case W: Requirement 40 - 401 Unauthorized handling in probeTracker and TrackingClient
  it('Case W: 401 token failure marks probe as unauthorized and TrackingClient throws', async () => {
    const mockFetcher: typeof fetch = async (input, _init) => {
      const url = String(input);
      if (url.endsWith('/health')) {
        return new Response(JSON.stringify({ ok: true, protocolVersion: 3, features: ['self_view_claims'] }), { status: 200 });
      }
      if (url.includes('/api/emails')) {
        return new Response(JSON.stringify({ error: 'unauthorized' }), { status: 401 });
      }
      return new Response(null, { status: 404 });
    };

    const probe = await probeTracker('https://track.example.com', 'bad-token', mockFetcher);
    expect(probe.status).toBe('unauthorized');
    expect(probe.label).toContain('Unauthorized');

    const client = new TrackingClient('https://track.example.com', 'bad-token');
    // Using global fetch mock for client
    const origFetch = globalThis.fetch;
    try {
      globalThis.fetch = mockFetcher;
      await expect(client.recordSelfView('trk_test', { timestamp: new Date().toISOString() })).rejects.toThrow('401');
    } finally {
      globalThis.fetch = origFetch;
    }
  });

  // Case X: Requirement 41 - Probe /health returning 404 flags tracker as outdated
  it('Case X: Probe /health returning 404 identifies outdated tracker deployment', async () => {
    const mockFetcher: typeof fetch = async (input) => {
      const url = String(input);
      if (url.endsWith('/health')) {
        return new Response(JSON.stringify({ error: 'not_found' }), { status: 404 });
      }
      return new Response(null, { status: 200 });
    };

    const probe = await probeTracker('https://track.example.com', 'secret-token', mockFetcher);
    expect(probe.status).toBe('outdated');
    expect(probe.label).toContain('outdated');
  });

  it('Case Y: a sender reload reclassifies one raced GoogleImageProxy and a later recipient proxy still counts', () => {
    const nav = Date.parse('2026-09-24T18:00:00.000Z');
    const proxyUa = 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 GoogleImageProxy';
    const browserUa =
      'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36';
    const raced = {
      eventId: 'evt_reload_proxy',
      type: 'OPEN',
      timestamp: new Date(nav + 500).toISOString(),
      classification: 'PROXY_LIKELY',
      userAgent: proxyUa,
      user_agent: proxyUa,
    };
    const browser = {
      eventId: 'evt_browser',
      type: 'OPEN',
      timestamp: new Date(nav + 2_000).toISOString(),
      classification: 'RECIPIENT_LIKELY',
      userAgent: browserUa,
      user_agent: browserUa,
    };
    expect(deriveTrackingStats([raced, browser]).openCount).toBe(2);
    const plan = planPageReloadProxy([raced, browser], nav, {
      proxyConsumedByEventId: 'evt_original',
      proxyConsumedAt: new Date(nav - 5_000).toISOString(),
    });
    expect(plan.reclassifyEventId).toBe('evt_reload_proxy');
    expect(plan.proxyConsumedByEventId).toBe('evt_reload_proxy');
    expect(
      deriveTrackingStats([
        { ...raced, classification: 'SELF_LIKELY' },
        browser,
        {
          type: 'OPEN',
          timestamp: new Date(nav + 20_000).toISOString(),
          classification: 'PROXY_LIKELY',
          userAgent: proxyUa,
          user_agent: proxyUa,
        },
      ]).openCount,
    ).toBe(2);
  });
});
