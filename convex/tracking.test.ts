import { describe, expect, it } from 'vitest';
import * as tracking from './tracking';

type MockDoc = Record<string, any>;

function createMockDb() {
  const tables = new Map<string, MockDoc[]>();
  let idCounter = 1;

  function getTable(table: string): MockDoc[] {
    let t = tables.get(table);
    if (!t) {
      t = [];
      tables.set(table, t);
    }
    return t;
  }

  const db = {
    async insert(table: string, doc: MockDoc) {
      const _id = `${table}_${idCounter++}`;
      const newDoc = { ...doc, _id, _creationTime: Date.now() };
      getTable(table).push(newDoc);
      return _id;
    },
    async patch(id: string, patch: MockDoc) {
      for (const t of tables.values()) {
        const doc = t.find((d) => d._id === id);
        if (doc) {
          Object.assign(doc, patch);
          return;
        }
      }
    },
    async get(id: string) {
      for (const t of tables.values()) {
        const doc = t.find((d) => d._id === id);
        if (doc) return { ...doc };
      }
      return null;
    },
    query(table: string) {
      let docs = [...getTable(table)];

      const builder = {
        withIndex(indexName: string, indexFn?: (q: any) => any) {
          if (indexFn) {
            let eqField: string | null = null;
            let eqVal: any = null;
            const q = {
              eq(field: string, val: any) {
                eqField = field;
                eqVal = val;
                return q;
              },
            };
            indexFn(q);
            if (eqField) {
              docs = docs.filter((d) => d[eqField!] === eqVal);
            }
          }
          return builder;
        },
        filter(filterFn: (q: any) => any) {
          const q = {
            eq(a: any, b: any) {
              return a === b;
            },
            field(name: string) {
              return (doc: any) => doc[name];
            },
          };
          docs = docs.filter((d) => {
            const pred = filterFn({
              eq(left: any, right: any) {
                const val = typeof left === 'function' ? left(d) : left;
                return val === right;
              },
              field(name: string) {
                return (doc: any) => doc[name];
              },
            });
            return pred;
          });
          return builder;
        },
        order(direction: 'asc' | 'desc') {
          if (direction === 'desc') {
            docs.reverse();
          }
          return builder;
        },
        async take(n: number) {
          return docs.slice(0, n).map((d) => ({ ...d }));
        },
        async collect() {
          return docs.map((d) => ({ ...d }));
        },
        async unique() {
          return docs[0] ? { ...docs[0] } : null;
        },
      };
      return builder;
    },
  };

  return { db, ctx: { db } };
}

function callMutation<T = any>(mutation: any, ctx: any, args: any): Promise<T> {
  const fn = mutation._handler || mutation;
  return fn(ctx, args);
}

function callQuery<T = any>(query: any, ctx: any, args: any = {}): Promise<T> {
  const fn = query._handler || query;
  return fn(ctx, args);
}

describe('Convex tracking mutations and self-view suppression', () => {
  it('creates email, handles self-view claim and suppresses subsequent open', async () => {
    const { ctx } = createMockDb();
    const trackingId = 'trk_convex_1';
    const sentAt = new Date().toISOString();

    await callMutation(tracking.createEmail, ctx, {
      trackingId,
      subject: 'Test convex self-view',
      sender: 'sender@example.com',
      recipients: ['recipient@example.com'],
      gmailThreadId: 'thread_1',
      gmailMessageId: 'msg_1',
      sentAt,
      createdAt: sentAt,
      links: [],
    });

    const emailBefore = await callQuery(tracking.getEmail, ctx, { trackingId });
    expect(emailBefore.openCount).toBe(0);

    // 1. Sender views own email in Gmail Sent -> emits recordSelfView
    const selfViewTime = new Date().toISOString();
    const selfRes = await callMutation(tracking.recordSelfView, ctx, {
      eventId: 'evt_sv_1',
      trackingId,
      timestamp: selfViewTime,
      userAgent: 'Mozilla/5.0 Chrome',
      ipHash: 'ip_1',
      gmailThreadId: 'thread_1',
      gmailMessageId: 'msg_1',
      source: 'MESSAGE_EXPANDED',
    });
    expect(selfRes.ok).toBe(true);
    expect(selfRes.claimId).toBe('clm_evt_sv_1');
    expect(selfRes.openCount).toBe(0);

    // 2. Pixel fetch arrives immediately due to sender opening the email
    await callMutation(tracking.recordOpenEvent, ctx, {
      eventId: 'evt_open_sender',
      trackingId,
      type: 'OPEN',
      timestamp: new Date().toISOString(),
      userAgent: 'Mozilla/5.0 Chrome',
      ipHash: 'ip_1',
      suspectedSelfOpen: false,
      confidence: 0,
      clickId: null,
      destination: null,
    });

    // Email open count should remain 0
    const emailAfterSender = await callQuery(tracking.getEmail, ctx, { trackingId });
    expect(emailAfterSender.openCount).toBe(0);

    const events = await callQuery(tracking.listEvents, ctx, { trackingId });
    const openEvent = events.find((e: any) => e.eventId === 'evt_open_sender');
    expect(openEvent).toBeDefined();
    expect(openEvent.classification).toBe('SELF_LIKELY');
    expect(openEvent.suspectedSelfOpen).toBe(true);

    // 3. Duplicate render burst within 1000ms is also suppressed
    await callMutation(tracking.recordOpenEvent, ctx, {
      eventId: 'evt_open_sender_burst',
      trackingId,
      type: 'OPEN',
      timestamp: new Date().toISOString(),
      userAgent: 'Mozilla/5.0 Chrome',
      ipHash: 'ip_1',
      suspectedSelfOpen: false,
      confidence: 0,
      clickId: null,
      destination: null,
    });
    const emailAfterBurst = await callQuery(tracking.getEmail, ctx, { trackingId });
    expect(emailAfterBurst.openCount).toBe(0);

    // 4. Genuine recipient open later (claim already consumed)
    const laterOpen = new Date(Date.now() + 5000).toISOString();
    await callMutation(tracking.recordOpenEvent, ctx, {
      eventId: 'evt_open_recipient',
      trackingId,
      type: 'OPEN',
      timestamp: laterOpen,
      userAgent: 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) Chrome/120.0.0.0 Safari/537.36',
      ipHash: 'ip_2',
      suspectedSelfOpen: false,
      confidence: 0,
      clickId: null,
      destination: null,
    });

    const emailAfterRecipient = await callQuery(tracking.getEmail, ctx, { trackingId });
    expect(emailAfterRecipient.openCount).toBe(1);
    expect(emailAfterRecipient.firstOpenedAt).toBe(laterOpen);
  });

  it('retroactively reclassifies open arriving up to 5s before self-view', async () => {
    const { ctx } = createMockDb();
    const trackingId = 'trk_retro_1';
    const baseTime = Date.now();
    const sentAt = new Date(baseTime - 30_000).toISOString();

    await callMutation(tracking.createEmail, ctx, {
      trackingId,
      subject: 'Retro test',
      sender: 'sender@example.com',
      recipients: ['recipient@example.com'],
      gmailThreadId: 'thread_2',
      gmailMessageId: 'msg_2',
      sentAt,
      createdAt: sentAt,
      links: [],
    });

    // 1. Pixel arrives before the extension content script reports self-view (e.g. 1.5s prior)
    const openTs = new Date(baseTime - 1500).toISOString();
    await callMutation(tracking.recordOpenEvent, ctx, {
      eventId: 'evt_early_pixel',
      trackingId,
      type: 'OPEN',
      timestamp: openTs,
      userAgent: 'Mozilla/5.0 Chrome',
      ipHash: 'ip_sender',
      suspectedSelfOpen: false,
      confidence: 0,
      clickId: null,
      destination: null,
    });

    const emailInitially = await callQuery(tracking.getEmail, ctx, { trackingId });
    expect(emailInitially.openCount).toBe(1);

    // 2. Extension reports self-view at baseTime
    const selfViewRes = await callMutation(tracking.recordSelfView, ctx, {
      eventId: 'evt_sv_retro',
      trackingId,
      timestamp: new Date(baseTime).toISOString(),
      userAgent: 'Mozilla/5.0 Chrome',
      ipHash: 'ip_sender',
      gmailThreadId: 'thread_2',
      gmailMessageId: 'msg_2',
      source: 'MESSAGE_EXPANDED',
    });

    expect(selfViewRes.reclassifiedEventIds).toContain('evt_early_pixel');
    expect(selfViewRes.openCount).toBe(0);

    const emailFinal = await callQuery(tracking.getEmail, ctx, { trackingId });
    expect(emailFinal.openCount).toBe(0);
  });

  it('guarantees idempotency on self-view retries with deterministic claim ID', async () => {
    const { ctx } = createMockDb();
    const trackingId = 'trk_idemp_1';
    const sentAt = new Date().toISOString();

    await callMutation(tracking.createEmail, ctx, {
      trackingId,
      subject: 'Idempotency test',
      sender: 'sender@example.com',
      recipients: ['recipient@example.com'],
      gmailThreadId: 'thread_3',
      gmailMessageId: 'msg_3',
      sentAt,
      createdAt: sentAt,
      links: [],
    });

    const sv1 = await callMutation(tracking.recordSelfView, ctx, {
      eventId: 'selfview_unique_123',
      trackingId,
      timestamp: sentAt,
      userAgent: 'Mozilla/5.0 Chrome',
      gmailThreadId: 'thread_3',
      gmailMessageId: 'msg_3',
      source: 'MESSAGE_EXPANDED',
    });

    expect(sv1.ok).toBe(true);
    expect(sv1.claimId).toBe('clm_selfview_unique_123');

    // Repeated call with the exact same eventId
    const sv2 = await callMutation(tracking.recordSelfView, ctx, {
      eventId: 'selfview_unique_123',
      trackingId,
      timestamp: sentAt,
      userAgent: 'Mozilla/5.0 Chrome',
      gmailThreadId: 'thread_3',
      gmailMessageId: 'msg_3',
      source: 'MESSAGE_EXPANDED',
    });

    expect(sv2.ok).toBe(true);
    expect(sv2.claimId).toBe('clm_selfview_unique_123');
  });

  it('isolates claims by exact gmailMessageId in the same thread', async () => {
    const { ctx } = createMockDb();
    const trackingId1 = 'trk_msg1';
    const trackingId2 = 'trk_msg2';
    const now = Date.now();
    const sentAt = new Date(now - 10000).toISOString();

    await callMutation(tracking.createEmail, ctx, {
      trackingId: trackingId1,
      subject: 'Thread Msg 1',
      sender: 'me@example.com',
      recipients: ['r@example.com'],
      gmailThreadId: 'thread_shared',
      gmailMessageId: 'msg_first',
      sentAt,
      createdAt: sentAt,
      links: [],
    });

    await callMutation(tracking.createEmail, ctx, {
      trackingId: trackingId2,
      subject: 'Thread Msg 2',
      sender: 'me@example.com',
      recipients: ['r@example.com'],
      gmailThreadId: 'thread_shared',
      gmailMessageId: 'msg_second',
      sentAt,
      createdAt: sentAt,
      links: [],
    });

    // Sender views msg_second specifically
    await callMutation(tracking.recordSelfView, ctx, {
      eventId: 'evt_sv_msg2',
      trackingId: trackingId2,
      timestamp: new Date().toISOString(),
      userAgent: 'Mozilla/5.0 Chrome',
      ipHash: 'ip_sender',
      gmailThreadId: 'thread_shared',
      gmailMessageId: 'msg_second',
      source: 'MESSAGE_EXPANDED',
    });

    // Recipient opens msg_first (has no claim) -> should count as open!
    await callMutation(tracking.recordOpenEvent, ctx, {
      eventId: 'evt_open_msg1',
      trackingId: trackingId1,
      type: 'OPEN',
      timestamp: new Date().toISOString(),
      userAgent: 'Mozilla/5.0 Chrome',
      ipHash: 'ip_recipient',
      suspectedSelfOpen: false,
      confidence: 0,
      clickId: null,
      destination: null,
    });

    const email1 = await callQuery(tracking.getEmail, ctx, { trackingId: trackingId1 });
    expect(email1.openCount).toBe(1);

    // Pixel for msg_second arrives -> suppressed by claim!
    await callMutation(tracking.recordOpenEvent, ctx, {
      eventId: 'evt_open_msg2',
      trackingId: trackingId2,
      type: 'OPEN',
      timestamp: new Date().toISOString(),
      userAgent: 'Mozilla/5.0 Chrome',
      ipHash: 'ip_sender',
      suspectedSelfOpen: false,
      confidence: 0,
      clickId: null,
      destination: null,
    });

    const email2 = await callQuery(tracking.getEmail, ctx, { trackingId: trackingId2 });
    expect(email2.openCount).toBe(0);
  });

  it('proxy then sender browser then recipient browser ends at openCount 1 and does not burn the browser claim on the proxy', async () => {
    const { ctx, db } = createMockDb();
    const trackingId = 'trk_proxy_first';
    const sentAt = new Date(Date.now() - 60_000).toISOString();
    await callMutation(tracking.createEmail, ctx, {
      trackingId,
      subject: 'Proxy first',
      sender: 'me@example.com',
      recipients: ['r@example.com'],
      gmailThreadId: 'thread_p',
      gmailMessageId: 'msg_p',
      sentAt,
      createdAt: sentAt,
      links: [],
    });
    await callMutation(tracking.recordSelfView, ctx, {
      eventId: 'evt_sv_proxy',
      trackingId,
      timestamp: new Date().toISOString(),
      userAgent: 'Mozilla/5.0 (Macintosh) AppleWebKit/537.36 Chrome/120.0.0.0 Safari/537.36',
      ipHash: 'ip_sender',
      gmailMessageId: 'msg_p',
      source: 'MESSAGE_EXPANDED',
    });

    await callMutation(tracking.recordOpenEvent, ctx, {
      eventId: 'evt_proxy',
      trackingId,
      type: 'OPEN',
      timestamp: new Date().toISOString(),
      userAgent: 'Mozilla/5.0 GoogleImageProxy',
      ipHash: 'ip_google',
      suspectedSelfOpen: false,
      confidence: 0,
      clickId: null,
      destination: null,
    });
    await callMutation(tracking.recordOpenEvent, ctx, {
      eventId: 'evt_sender_browser',
      trackingId,
      type: 'OPEN',
      timestamp: new Date().toISOString(),
      userAgent: 'Mozilla/5.0 (Macintosh) AppleWebKit/537.36 Chrome/120.0.0.0 Safari/537.36',
      ipHash: 'ip_sender',
      suspectedSelfOpen: false,
      confidence: 0,
      clickId: null,
      destination: null,
    });
    await callMutation(tracking.recordOpenEvent, ctx, {
      eventId: 'evt_recipient_browser',
      trackingId,
      type: 'OPEN',
      timestamp: new Date(Date.now() + 2000).toISOString(),
      userAgent: 'Mozilla/5.0 (Windows NT 10.0) AppleWebKit/537.36 Chrome/121.0.0.0 Safari/537.36',
      ipHash: 'ip_recipient',
      suspectedSelfOpen: false,
      confidence: 0,
      clickId: null,
      destination: null,
    });

    const events = await callQuery(tracking.listEvents, ctx, { trackingId });
    expect(events.find((e: any) => e.eventId === 'evt_proxy').classification).toBe('SELF_LIKELY');
    expect(events.find((e: any) => e.eventId === 'evt_sender_browser').classification).toBe('SELF_LIKELY');
    expect(events.find((e: any) => e.eventId === 'evt_recipient_browser').classification).toBe('RECIPIENT_LIKELY');
    const email = await callQuery(tracking.getEmail, ctx, { trackingId });
    expect(email.openCount).toBe(1);
    const claims = await db.query('selfViewClaims').collect();
    expect(claims[0].proxyConsumedByEventId).toBe('evt_proxy');
    expect(claims[0].consumedByEventId).toBe('evt_sender_browser');
  });

  it('does not let a different fingerprint consume the sender claim', async () => {
    const { ctx } = createMockDb();
    const trackingId = 'trk_fp';
    const sentAt = new Date(Date.now() - 60_000).toISOString();
    await callMutation(tracking.createEmail, ctx, {
      trackingId,
      subject: 'Fingerprint',
      sender: 'me@example.com',
      recipients: ['r@example.com'],
      gmailThreadId: null,
      gmailMessageId: 'msg_fp',
      sentAt,
      createdAt: sentAt,
      links: [],
    });
    await callMutation(tracking.recordSelfView, ctx, {
      eventId: 'evt_sv_fp',
      trackingId,
      timestamp: new Date().toISOString(),
      userAgent: 'Mozilla/5.0 (Macintosh) AppleWebKit/537.36 Chrome/120.0.0.0 Safari/537.36',
      ipHash: 'ip_sender',
      source: 'MESSAGE_EXPANDED',
    });
    await callMutation(tracking.recordOpenEvent, ctx, {
      eventId: 'evt_recipient_first',
      trackingId,
      type: 'OPEN',
      timestamp: new Date().toISOString(),
      userAgent: 'Mozilla/5.0 (Windows NT 10.0) AppleWebKit/537.36 Chrome/121.0.0.0 Safari/537.36',
      ipHash: 'ip_recipient',
      suspectedSelfOpen: false,
      confidence: 0,
      clickId: null,
      destination: null,
    });
    await callMutation(tracking.recordOpenEvent, ctx, {
      eventId: 'evt_sender_after',
      trackingId,
      type: 'OPEN',
      timestamp: new Date(Date.now() + 1500).toISOString(),
      userAgent: 'Mozilla/5.0 (Macintosh) AppleWebKit/537.36 Chrome/120.0.0.0 Safari/537.36',
      ipHash: 'ip_sender',
      suspectedSelfOpen: false,
      confidence: 0,
      clickId: null,
      destination: null,
    });
    const email = await callQuery(tracking.getEmail, ctx, { trackingId });
    expect(email.openCount).toBe(1);
    const events = await callQuery(tracking.listEvents, ctx, { trackingId });
    expect(events.find((e: any) => e.eventId === 'evt_recipient_first').classification).toBe('RECIPIENT_LIKELY');
    expect(events.find((e: any) => e.eventId === 'evt_sender_after').classification).toBe('SELF_LIKELY');
  });

  it('reclassifies only the fingerprint-matched browser open when the pixel arrives before SELF_VIEW', async () => {
    const { ctx } = createMockDb();
    const trackingId = 'trk_retro_fp';
    const base = Date.now();
    const sentAt = new Date(base - 60_000).toISOString();
    await callMutation(tracking.createEmail, ctx, {
      trackingId,
      subject: 'Retro fingerprint',
      sender: 'me@example.com',
      recipients: ['r@example.com'],
      gmailThreadId: null,
      gmailMessageId: 'old_id',
      sentAt,
      createdAt: sentAt,
      links: [],
    });
    await callMutation(tracking.recordOpenEvent, ctx, {
      eventId: 'evt_proxy_before',
      trackingId,
      type: 'OPEN',
      timestamp: new Date(base - 1000).toISOString(),
      userAgent: 'GoogleImageProxy',
      ipHash: 'ip_google',
      suspectedSelfOpen: false,
      confidence: 0,
      clickId: null,
      destination: null,
    });
    await callMutation(tracking.recordOpenEvent, ctx, {
      eventId: 'evt_sender_before',
      trackingId,
      type: 'OPEN',
      timestamp: new Date(base - 800).toISOString(),
      userAgent: 'Mozilla/5.0 (Macintosh) AppleWebKit/537.36 Chrome/120.0.0.0 Safari/537.36',
      ipHash: 'ip_sender',
      suspectedSelfOpen: false,
      confidence: 0,
      clickId: null,
      destination: null,
    });
    await callMutation(tracking.recordOpenEvent, ctx, {
      eventId: 'evt_recipient_before',
      trackingId,
      type: 'OPEN',
      timestamp: new Date(base - 700).toISOString(),
      userAgent: 'Mozilla/5.0 (Windows NT 10.0) AppleWebKit/537.36 Chrome/121.0.0.0 Safari/537.36',
      ipHash: 'ip_recipient',
      suspectedSelfOpen: false,
      confidence: 0,
      clickId: null,
      destination: null,
    });
    const result = await callMutation(tracking.recordSelfView, ctx, {
      eventId: 'evt_sv_retro_fp',
      trackingId,
      timestamp: new Date(base).toISOString(),
      userAgent: 'Mozilla/5.0 (Macintosh) AppleWebKit/537.36 Chrome/120.0.0.0 Safari/537.36',
      ipHash: 'ip_sender',
      gmailMessageId: 'new_id',
      reconcileGmailIds: true,
      source: 'MESSAGE_EXPANDED',
    });
    expect(result.reclassifiedEventIds).toContain('evt_sender_before');
    expect(result.reclassifiedEventIds).not.toContain('evt_proxy_before');
    expect(result.reclassifiedEventIds).not.toContain('evt_recipient_before');
    const email = await callQuery(tracking.getEmail, ctx, { trackingId });
    expect(email.openCount).toBe(1);
    expect(email.gmailMessageId).toBe('new_id');
    const events = await callQuery(tracking.listEvents, ctx, { trackingId });
    expect(events.find((e: any) => e.eventId === 'evt_proxy_before').classification).toBe('PROXY_LIKELY');
    expect(events.find((e: any) => e.eventId === 'evt_sender_before').classification).toBe('SELF_LIKELY');
    expect(events.find((e: any) => e.eventId === 'evt_recipient_before').classification).toBe('RECIPIENT_LIKELY');
  });

  it('scanner request does not consume an active sender claim', async () => {
    const { ctx } = createMockDb();
    const trackingId = 'trk_scan';
    const sentAt = new Date(Date.now() - 60_000).toISOString();
    await callMutation(tracking.createEmail, ctx, {
      trackingId,
      subject: 'Scanner',
      sender: 'me@example.com',
      recipients: ['r@example.com'],
      gmailThreadId: null,
      gmailMessageId: null,
      sentAt,
      createdAt: sentAt,
      links: [],
    });
    await callMutation(tracking.recordSelfView, ctx, {
      eventId: 'evt_sv_scan',
      trackingId,
      timestamp: new Date().toISOString(),
      userAgent: 'Mozilla/5.0 (Macintosh) AppleWebKit/537.36 Chrome/120.0.0.0 Safari/537.36',
      ipHash: 'ip_sender',
      source: 'MESSAGE_EXPANDED',
    });
    await callMutation(tracking.recordOpenEvent, ctx, {
      eventId: 'evt_scan',
      trackingId,
      type: 'OPEN',
      timestamp: new Date().toISOString(),
      userAgent: 'Barracuda Sentinel Scanner/1.0',
      ipHash: 'ip_scan',
      suspectedSelfOpen: false,
      confidence: 0,
      clickId: null,
      destination: null,
    });
    await callMutation(tracking.recordOpenEvent, ctx, {
      eventId: 'evt_sender_after_scan',
      trackingId,
      type: 'OPEN',
      timestamp: new Date(Date.now() + 500).toISOString(),
      userAgent: 'Mozilla/5.0 (Macintosh) AppleWebKit/537.36 Chrome/120.0.0.0 Safari/537.36',
      ipHash: 'ip_sender',
      suspectedSelfOpen: false,
      confidence: 0,
      clickId: null,
      destination: null,
    });
    const events = await callQuery(tracking.listEvents, ctx, { trackingId });
    expect(events.find((e: any) => e.eventId === 'evt_scan').classification).toBe('MACHINE_LIKELY');
    expect(events.find((e: any) => e.eventId === 'evt_sender_after_scan').classification).toBe('SELF_LIKELY');
    const email = await callQuery(tracking.getEmail, ctx, { trackingId });
    expect(email.openCount).toBe(0);
  });

  it('counts a Gmail recipient proxy, suppresses one sender proxy, then counts the next recipient proxy', async () => {
    const { ctx, db } = createMockDb();
    const sentAt = new Date(Date.now() - 60_000).toISOString();
    const proxyUa = 'Mozilla/5.0 GoogleImageProxy';

    await callMutation(tracking.createEmail, ctx, {
      trackingId: 'trk_proxy_recipient',
      subject: 'Recipient proxy',
      sender: 'me@example.com',
      recipients: ['r@example.com'],
      gmailThreadId: null,
      gmailMessageId: 'msg_proxy_recipient',
      sentAt,
      createdAt: sentAt,
      links: [],
    });
    await callMutation(tracking.recordOpenEvent, ctx, {
      eventId: 'evt_recipient_proxy',
      trackingId: 'trk_proxy_recipient',
      type: 'OPEN',
      timestamp: new Date().toISOString(),
      userAgent: proxyUa,
      ipHash: 'ip_google',
      suspectedSelfOpen: false,
      confidence: 0,
      clickId: null,
      destination: null,
    });
    const recipientOnly = await callQuery(tracking.getEmail, ctx, { trackingId: 'trk_proxy_recipient' });
    expect(recipientOnly.openCount).toBe(1);
    const recipientEvents = await callQuery(tracking.listEvents, ctx, { trackingId: 'trk_proxy_recipient' });
    expect(recipientEvents.find((event: any) => event.eventId === 'evt_recipient_proxy').classification).toBe('PROXY_LIKELY');

    const base = Date.now();
    await callMutation(tracking.createEmail, ctx, {
      trackingId: 'trk_sender_then_recipient',
      subject: 'Sender then recipient',
      sender: 'me@example.com',
      recipients: ['r@example.com'],
      gmailThreadId: null,
      gmailMessageId: 'msg_sender_then',
      sentAt,
      createdAt: sentAt,
      links: [],
    });
    await callMutation(tracking.recordSelfView, ctx, {
      eventId: 'evt_sv_then',
      trackingId: 'trk_sender_then_recipient',
      timestamp: new Date(base).toISOString(),
      userAgent: 'Mozilla/5.0 (Macintosh) AppleWebKit/537.36 Chrome/120.0.0.0 Safari/537.36',
      ipHash: 'ip_sender',
      gmailMessageId: 'msg_sender_then',
      source: 'MESSAGE_EXPANDED',
    });
    await callMutation(tracking.recordOpenEvent, ctx, {
      eventId: 'evt_sender_proxy',
      trackingId: 'trk_sender_then_recipient',
      type: 'OPEN',
      timestamp: new Date(base + 200).toISOString(),
      userAgent: proxyUa,
      ipHash: 'ip_google',
      suspectedSelfOpen: false,
      confidence: 0,
      clickId: null,
      destination: null,
    });
    await callMutation(tracking.recordOpenEvent, ctx, {
      eventId: 'evt_sender_proxy_burst',
      trackingId: 'trk_sender_then_recipient',
      type: 'OPEN',
      timestamp: new Date(base + 1_200).toISOString(),
      userAgent: proxyUa,
      ipHash: 'ip_google',
      suspectedSelfOpen: false,
      confidence: 0,
      clickId: null,
      destination: null,
    });
    const afterSender = await callQuery(tracking.getEmail, ctx, { trackingId: 'trk_sender_then_recipient' });
    expect(afterSender.openCount).toBe(0);
    await callMutation(tracking.recordOpenEvent, ctx, {
      eventId: 'evt_later_recipient_proxy',
      trackingId: 'trk_sender_then_recipient',
      type: 'OPEN',
      timestamp: new Date(base + 4_000).toISOString(),
      userAgent: proxyUa,
      ipHash: 'ip_google',
      suspectedSelfOpen: false,
      confidence: 0,
      clickId: null,
      destination: null,
    });
    const afterRecipient = await callQuery(tracking.getEmail, ctx, { trackingId: 'trk_sender_then_recipient' });
    expect(afterRecipient.openCount).toBe(1);
    const events = await callQuery(tracking.listEvents, ctx, { trackingId: 'trk_sender_then_recipient' });
    expect(events.find((event: any) => event.eventId === 'evt_sender_proxy').classification).toBe('SELF_LIKELY');
    expect(events.find((event: any) => event.eventId === 'evt_sender_proxy_burst').classification).toBe('SELF_LIKELY');
    expect(events.find((event: any) => event.eventId === 'evt_later_recipient_proxy').classification).toBe('PROXY_LIKELY');
    const claims = await db.query('selfViewClaims').collect();
    const claim = claims.find((row) => row.trackingId === 'trk_sender_then_recipient');
    expect(claim).toMatchObject({
      proxyConsumedByEventId: 'evt_sender_proxy',
      consumedByEventId: null,
    });
  });

  it('does not count Gmail delivery prefetch, and repairs one that was already stored as an open', async () => {
    const { ctx } = createMockDb();
    const gmailPrefetch =
      'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/42.0.2311.135 Safari/537.36 Edge/12.246 Mozilla/5.0';
    const sentAt = new Date(Date.now() - 13_000).toISOString();
    await callMutation(tracking.createEmail, ctx, {
      trackingId: 'trk_prefetch',
      subject: 'Just sent',
      sender: 'me@example.com',
      recipients: ['r@example.com'],
      gmailThreadId: null,
      gmailMessageId: null,
      sentAt,
      createdAt: sentAt,
      links: [],
    });
    await callMutation(tracking.recordOpenEvent, ctx, {
      eventId: 'evt_prefetch',
      trackingId: 'trk_prefetch',
      type: 'OPEN',
      timestamp: new Date().toISOString(),
      userAgent: gmailPrefetch,
      ipHash: 'ip_google',
      suspectedSelfOpen: false,
      confidence: 0,
      clickId: null,
      destination: null,
    });
    const fresh = await callQuery(tracking.getEmail, ctx, { trackingId: 'trk_prefetch' });
    expect(fresh.openCount).toBe(0);
    const freshEvents = await callQuery(tracking.listEvents, ctx, { trackingId: 'trk_prefetch' });
    expect(freshEvents[0].classification).toBe('MACHINE_LIKELY');

    await callMutation(tracking.createEmail, ctx, {
      trackingId: 'trk_prefetch_old',
      subject: 'Already marked',
      sender: 'me@example.com',
      recipients: ['r@example.com'],
      gmailThreadId: null,
      gmailMessageId: null,
      sentAt,
      createdAt: sentAt,
      links: [],
    });
    const stored = await callQuery(tracking.getEmail, ctx, { trackingId: 'trk_prefetch_old' });
    await ctx.db.patch(stored._id, { openCount: 1, firstOpenedAt: new Date().toISOString(), lastOpenedAt: new Date().toISOString() });
    await ctx.db.insert('trackingEvents', {
      eventId: 'evt_old_prefetch',
      trackingId: 'trk_prefetch_old',
      type: 'OPEN',
      timestamp: new Date().toISOString(),
      userAgent: gmailPrefetch,
      ipHash: 'ip_google',
      suspectedSelfOpen: false,
      confidence: 0,
      classification: 'RECIPIENT_LIKELY',
      clickId: null,
      destination: null,
    });
    const repaired = await callMutation(tracking.repairDeliveryPrefetchOpens, ctx, {});
    expect(repaired.repaired).toBeGreaterThanOrEqual(1);
    const cleared = await callQuery(tracking.getEmail, ctx, { trackingId: 'trk_prefetch_old' });
    expect(cleared.openCount).toBe(0);
    expect(cleared.firstOpenedAt).toBeNull();
  });

  const proxyUa = 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 GoogleImageProxy';
  const browserUa =
    'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36';

  async function seedReloadEmail(ctx: any, trackingId: string, sentAt: string) {
    await callMutation(tracking.createEmail, ctx, {
      trackingId,
      subject: trackingId,
      sender: 'me@example.com',
      recipients: ['r@example.com'],
      gmailThreadId: 'thread_reload',
      gmailMessageId: 'msg_reload',
      sentAt,
      createdAt: sentAt,
      links: [],
    });
  }

  function openArgs(trackingId: string, eventId: string, timestamp: string, userAgent: string, ipHash: string) {
    return {
      eventId,
      trackingId,
      type: 'OPEN' as const,
      timestamp,
      userAgent,
      ipHash,
      suspectedSelfOpen: false,
      confidence: 0,
      clickId: null,
      destination: null,
    };
  }

  it('suppresses a second sender proxy after PAGE_RELOAD and still counts a later recipient proxy', async () => {
    const { ctx, db } = createMockDb();
    const base = Date.parse('2026-09-24T16:00:00.000Z');
    const trackingId = 'trk_page_reload';
    await seedReloadEmail(ctx, trackingId, new Date(base - 60_000).toISOString());
    await callMutation(tracking.recordSelfView, ctx, {
      eventId: 'sv_open',
      trackingId,
      timestamp: new Date(base).toISOString(),
      userAgent: browserUa,
      ipHash: 'ip_sender',
      gmailMessageId: 'msg_reload',
      source: 'MESSAGE_EXPANDED',
    });
    await callMutation(tracking.recordOpenEvent, ctx, openArgs(trackingId, 'evt_first_proxy', new Date(base + 200).toISOString(), proxyUa, 'ip_google'));
    expect((await callQuery(tracking.getEmail, ctx, { trackingId })).openCount).toBe(0);

    const navigationStartedAt = base + 3_000;
    const reload = await callMutation(tracking.recordSelfView, ctx, {
      eventId: `sv_${trackingId}_PAGE_RELOAD_${navigationStartedAt}`,
      trackingId,
      timestamp: new Date(navigationStartedAt).toISOString(),
      userAgent: browserUa,
      ipHash: 'ip_sender',
      gmailMessageId: 'msg_reload',
      source: 'PAGE_RELOAD',
    });
    expect(reload.ok).toBe(true);
    const rearmed = (await db.query('selfViewClaims').collect()).find((row) => row.trackingId === trackingId);
    expect(rearmed?.proxyConsumedByEventId ?? null).toBeNull();

    await callMutation(
      tracking.recordOpenEvent,
      ctx,
      openArgs(trackingId, 'evt_reload_proxy', new Date(navigationStartedAt + 400).toISOString(), proxyUa, 'ip_google'),
    );
    expect((await callQuery(tracking.getEmail, ctx, { trackingId })).openCount).toBe(0);
    const consumed = (await db.query('selfViewClaims').collect()).find((row) => row.trackingId === trackingId);
    expect(consumed?.proxyConsumedByEventId).toBe('evt_reload_proxy');

    for (const source of ['MESSAGE_EXPANDED', 'MESSAGE_LOAD', 'CACHE_REINSPECTION'] as const) {
      await callMutation(tracking.recordSelfView, ctx, {
        eventId: `sv_after_${source}`,
        trackingId,
        timestamp: new Date(navigationStartedAt + 800).toISOString(),
        userAgent: browserUa,
        ipHash: 'ip_sender',
        gmailMessageId: 'msg_reload',
        source,
      });
    }
    const afterSources = (await db.query('selfViewClaims').collect()).find((row) => row.trackingId === trackingId);
    expect(afterSources?.proxyConsumedByEventId).toBe('evt_reload_proxy');

    await callMutation(
      tracking.recordOpenEvent,
      ctx,
      openArgs(trackingId, 'evt_later_recipient', new Date(navigationStartedAt + 12_000).toISOString(), proxyUa, 'ip_google'),
    );
    expect((await callQuery(tracking.getEmail, ctx, { trackingId })).openCount).toBe(1);
    const events = await callQuery(tracking.listEvents, ctx, { trackingId });
    expect(events.find((event: any) => event.eventId === 'evt_first_proxy').classification).toBe('SELF_LIKELY');
    expect(events.find((event: any) => event.eventId === 'evt_reload_proxy').classification).toBe('SELF_LIKELY');
    expect(events.find((event: any) => event.eventId === 'evt_later_recipient').classification).toBe('PROXY_LIKELY');
  });

  it('reclassifies a GoogleImageProxy that arrives before PAGE_RELOAD reaches the backend', async () => {
    const { ctx } = createMockDb();
    const base = Date.parse('2026-09-24T16:30:00.000Z');
    const trackingId = 'trk_page_reload_race';
    await seedReloadEmail(ctx, trackingId, new Date(base - 60_000).toISOString());
    await callMutation(tracking.recordSelfView, ctx, {
      eventId: 'sv_race_open',
      trackingId,
      timestamp: new Date(base).toISOString(),
      userAgent: browserUa,
      ipHash: 'ip_sender',
      gmailMessageId: 'msg_reload',
      source: 'MESSAGE_EXPANDED',
    });
    await callMutation(tracking.recordOpenEvent, ctx, openArgs(trackingId, 'evt_first_proxy', new Date(base + 200).toISOString(), proxyUa, 'ip_google'));
    expect((await callQuery(tracking.getEmail, ctx, { trackingId })).openCount).toBe(0);

    const navigationStartedAt = base + 3_000;
    await callMutation(
      tracking.recordOpenEvent,
      ctx,
      openArgs(trackingId, 'evt_raced_proxy', new Date(navigationStartedAt + 500).toISOString(), proxyUa, 'ip_google'),
    );
    expect((await callQuery(tracking.getEmail, ctx, { trackingId })).openCount).toBe(1);

    const reload = await callMutation(tracking.recordSelfView, ctx, {
      eventId: `sv_${trackingId}_PAGE_RELOAD_${navigationStartedAt}`,
      trackingId,
      timestamp: new Date(navigationStartedAt).toISOString(),
      userAgent: browserUa,
      ipHash: 'ip_sender',
      gmailMessageId: 'msg_reload',
      source: 'PAGE_RELOAD',
    });
    expect(reload.reclassifiedEventIds).toContain('evt_raced_proxy');
    expect(reload.openCount).toBe(0);
    const events = await callQuery(tracking.listEvents, ctx, { trackingId });
    expect(events.find((event: any) => event.eventId === 'evt_raced_proxy').classification).toBe('SELF_LIKELY');

    await callMutation(
      tracking.recordOpenEvent,
      ctx,
      openArgs(trackingId, 'evt_recipient_after', new Date(navigationStartedAt + 12_000).toISOString(), proxyUa, 'ip_google'),
    );
    expect((await callQuery(tracking.getEmail, ctx, { trackingId })).openCount).toBe(1);
    const after = await callQuery(tracking.listEvents, ctx, { trackingId });
    expect(after.find((event: any) => event.eventId === 'evt_recipient_after').classification).toBe('PROXY_LIKELY');
  });

  it('reclassifies the sender proxy render of a just-sent reply that beats the self-view', async () => {
    const { ctx, db } = createMockDb();
    const sentMs = Date.parse('2026-09-28T10:00:00.000Z');
    const trackingId = 'trk_reply_race';
    await seedReloadEmail(ctx, trackingId, new Date(sentMs).toISOString());

    // Gmail inserts the sent reply into the open thread; its proxy fetch lands first.
    await callMutation(tracking.recordOpenEvent, ctx, openArgs(trackingId, 'evt_reply_proxy', new Date(sentMs + 1_500).toISOString(), proxyUa, 'ip_google'));
    await callMutation(tracking.recordOpenEvent, ctx, openArgs(trackingId, 'evt_reply_proxy_dup', new Date(sentMs + 2_000).toISOString(), proxyUa, 'ip_google'));
    expect((await callQuery(tracking.getEmail, ctx, { trackingId })).openCount).toBe(1);

    const view = await callMutation(tracking.recordSelfView, ctx, {
      eventId: 'sv_reply_race',
      trackingId,
      timestamp: new Date(sentMs + 1_000).toISOString(),
      userAgent: browserUa,
      ipHash: 'ip_sender',
      gmailMessageId: 'msg_reload',
      source: 'MESSAGE_EXPANDED',
    });
    expect(view.reclassifiedEventIds).toEqual(['evt_reply_proxy', 'evt_reply_proxy_dup']);
    expect(view.openCount).toBe(0);

    // The follow-up MESSAGE_LOAD must not spend anything else.
    await callMutation(tracking.recordSelfView, ctx, {
      eventId: 'sv_reply_race_load',
      trackingId,
      timestamp: new Date(sentMs + 2_500).toISOString(),
      userAgent: browserUa,
      ipHash: 'ip_sender',
      gmailMessageId: 'msg_reload',
      source: 'MESSAGE_LOAD',
    });
    const claim = (await db.query('selfViewClaims').collect()).find((row) => row.trackingId === trackingId);
    expect(claim?.proxyConsumedByEventId).toBe('evt_reply_proxy');

    await callMutation(tracking.recordOpenEvent, ctx, openArgs(trackingId, 'evt_reply_recipient', new Date(sentMs + 6_000).toISOString(), proxyUa, 'ip_google'));
    expect((await callQuery(tracking.getEmail, ctx, { trackingId })).openCount).toBe(1);
    const events = await callQuery(tracking.listEvents, ctx, { trackingId });
    expect(events.find((event: any) => event.eventId === 'evt_reply_recipient').classification).toBe('PROXY_LIKELY');
  });

  it('reclassifies a just-sent render that lands at send time when the first claim arrives several seconds later', async () => {
    const { ctx } = createMockDb();
    const sentMs = Date.parse('2026-09-29T02:09:08.952Z');
    const trackingId = 'trk_late_claim';
    await seedReloadEmail(ctx, trackingId, new Date(sentMs).toISOString());
    await callMutation(tracking.recordOpenEvent, ctx, openArgs(trackingId, 'evt_send_render', new Date(sentMs + 489).toISOString(), proxyUa, 'ip_google'));
    const view = await callMutation(tracking.recordSelfView, ctx, {
      eventId: 'sv_late_claim',
      trackingId,
      timestamp: new Date(sentMs + 7_392).toISOString(),
      userAgent: browserUa,
      ipHash: 'ip_sender',
      gmailMessageId: 'msg_reload',
      source: 'MESSAGE_EXPANDED',
    });
    expect(view.reclassifiedEventIds).toEqual(['evt_send_render']);
    expect(view.openCount).toBe(0);
  });

  it('does not count an old tracked pixel quoted in a newer message the sender opens', async () => {
    const { ctx } = createMockDb();
    const base = Date.parse('2026-09-29T04:47:58.026Z');
    const oldId = 'trk_quoted_old';
    await seedReloadEmail(ctx, oldId, new Date(base - 4 * 24 * 60 * 60_000).toISOString());

    // Claim posted before the quoted pixel loads: live suppression.
    await callMutation(tracking.recordSelfView, ctx, {
      eventId: 'sv_quoted_first',
      trackingId: oldId,
      timestamp: new Date(base).toISOString(),
      userAgent: browserUa,
      ipHash: 'ip_sender',
      gmailThreadId: null,
      gmailMessageId: null,
      source: 'MESSAGE_EXPANDED',
      quotedRender: true,
    });
    await callMutation(tracking.recordOpenEvent, ctx, openArgs(oldId, 'evt_quoted_live', new Date(base + 302).toISOString(), proxyUa, 'ip_google'));
    expect((await callQuery(tracking.getEmail, ctx, { trackingId: oldId })).openCount).toBe(0);
    // A quoted claim carries no Gmail ids, so it must not overwrite the old message's ids.
    expect((await callQuery(tracking.getEmail, ctx, { trackingId: oldId })).gmailMessageId).toBe('msg_reload');

    // Later view where the image fetch beats the claim by a few milliseconds.
    const later = base + 60 * 60_000;
    await callMutation(tracking.recordOpenEvent, ctx, openArgs(oldId, 'evt_quoted_race', new Date(later + 20).toISOString(), proxyUa, 'ip_google'));
    const view = await callMutation(tracking.recordSelfView, ctx, {
      eventId: 'sv_quoted_race',
      trackingId: oldId,
      timestamp: new Date(later).toISOString(),
      userAgent: browserUa,
      ipHash: 'ip_sender',
      gmailThreadId: null,
      gmailMessageId: null,
      source: 'MESSAGE_EXPANDED',
      quotedRender: true,
    });
    expect(view.reclassifiedEventIds).toEqual(['evt_quoted_race']);
    expect(view.openCount).toBe(0);

    // A recipient opening well after the sender's view still counts.
    await callMutation(tracking.recordOpenEvent, ctx, openArgs(oldId, 'evt_quoted_recipient', new Date(later + 120_000).toISOString(), proxyUa, 'ip_google'));
    expect((await callQuery(tracking.getEmail, ctx, { trackingId: oldId })).openCount).toBe(1);
  });

  it('markOpensAsSelf repairs stored self opens and recomputes the count', async () => {
    const { ctx } = createMockDb();
    const base = Date.parse('2026-09-29T02:27:06.000Z');
    const trackingId = 'trk_repair';
    await seedReloadEmail(ctx, trackingId, new Date(base - 60 * 60_000).toISOString());
    await callMutation(tracking.recordOpenEvent, ctx, openArgs(trackingId, 'evt_self_a', new Date(base).toISOString(), proxyUa, 'ip_google'));
    await callMutation(tracking.recordOpenEvent, ctx, openArgs(trackingId, 'evt_real', new Date(base + 60_000).toISOString(), proxyUa, 'ip_google'));
    expect((await callQuery(tracking.getEmail, ctx, { trackingId })).openCount).toBe(2);
    const result = await callMutation(tracking.markOpensAsSelf, ctx, { eventIds: ['evt_self_a', 'evt_missing'] });
    expect(result.marked).toEqual(['evt_self_a']);
    expect(result.openCounts[trackingId]).toBe(1);
  });

  it('does not reclassify an earlier recipient proxy when the self-view is not right after send', async () => {
    const { ctx } = createMockDb();
    const base = Date.parse('2026-09-28T11:00:00.000Z');
    const trackingId = 'trk_old_send';
    await seedReloadEmail(ctx, trackingId, new Date(base - 10 * 60_000).toISOString());
    await callMutation(tracking.recordOpenEvent, ctx, openArgs(trackingId, 'evt_old_recipient', new Date(base - 1_000).toISOString(), proxyUa, 'ip_google'));
    const view = await callMutation(tracking.recordSelfView, ctx, {
      eventId: 'sv_old_send',
      trackingId,
      timestamp: new Date(base).toISOString(),
      userAgent: browserUa,
      ipHash: 'ip_sender',
      gmailMessageId: 'msg_reload',
      source: 'MESSAGE_EXPANDED',
    });
    expect(view.reclassifiedEventIds).toEqual([]);
    expect(view.openCount).toBe(1);
  });

  it('does not re-arm proxy suppression for expand, load, or cache reinspection', async () => {
    const { ctx, db } = createMockDb();
    const base = Date.parse('2026-09-24T17:00:00.000Z');
    const trackingId = 'trk_no_rearm';
    await seedReloadEmail(ctx, trackingId, new Date(base - 60_000).toISOString());
    await callMutation(tracking.recordSelfView, ctx, {
      eventId: 'sv_guard_open',
      trackingId,
      timestamp: new Date(base).toISOString(),
      userAgent: browserUa,
      ipHash: 'ip_sender',
      gmailMessageId: 'msg_reload',
      source: 'MESSAGE_EXPANDED',
    });
    await callMutation(tracking.recordOpenEvent, ctx, openArgs(trackingId, 'evt_guard_proxy', new Date(base + 200).toISOString(), proxyUa, 'ip_google'));
    for (const source of ['MESSAGE_EXPANDED', 'MESSAGE_LOAD', 'CACHE_REINSPECTION'] as const) {
      await callMutation(tracking.recordSelfView, ctx, {
        eventId: `sv_guard_${source}`,
        trackingId,
        timestamp: new Date(base + 3_000).toISOString(),
        userAgent: browserUa,
        ipHash: 'ip_sender',
        gmailMessageId: 'msg_reload',
        source,
      });
    }
    const claim = (await db.query('selfViewClaims').collect()).find((row) => row.trackingId === trackingId);
    expect(claim?.proxyConsumedByEventId).toBe('evt_guard_proxy');
    await callMutation(
      tracking.recordOpenEvent,
      ctx,
      openArgs(trackingId, 'evt_guard_recipient', new Date(base + 4_000).toISOString(), proxyUa, 'ip_google'),
    );
    expect((await callQuery(tracking.getEmail, ctx, { trackingId })).openCount).toBe(1);
    const events = await callQuery(tracking.listEvents, ctx, { trackingId });
    expect(events.find((event: any) => event.eventId === 'evt_guard_recipient').classification).toBe('PROXY_LIKELY');
  });

  it('does not reclassify a browser recipient open when applying PAGE_RELOAD', async () => {
    const { ctx } = createMockDb();
    const base = Date.parse('2026-09-24T17:30:00.000Z');
    const trackingId = 'trk_page_reload_browser';
    await seedReloadEmail(ctx, trackingId, new Date(base - 60_000).toISOString());
    await callMutation(tracking.recordSelfView, ctx, {
      eventId: 'sv_browser_open',
      trackingId,
      timestamp: new Date(base).toISOString(),
      userAgent: browserUa,
      ipHash: 'ip_sender',
      gmailMessageId: 'msg_reload',
      source: 'MESSAGE_EXPANDED',
    });
    await callMutation(tracking.recordOpenEvent, ctx, openArgs(trackingId, 'evt_sender_proxy', new Date(base + 200).toISOString(), proxyUa, 'ip_google'));
    const navigationStartedAt = base + 3_000;
    await callMutation(
      tracking.recordOpenEvent,
      ctx,
      openArgs(trackingId, 'evt_raced_proxy', new Date(navigationStartedAt + 500).toISOString(), proxyUa, 'ip_google'),
    );
    await callMutation(
      tracking.recordOpenEvent,
      ctx,
      openArgs(trackingId, 'evt_browser_recipient', new Date(navigationStartedAt + 2_000).toISOString(), browserUa, 'ip_recipient'),
    );
    expect((await callQuery(tracking.getEmail, ctx, { trackingId })).openCount).toBe(2);
    const reload = await callMutation(tracking.recordSelfView, ctx, {
      eventId: `sv_${trackingId}_PAGE_RELOAD_${navigationStartedAt}`,
      trackingId,
      timestamp: new Date(navigationStartedAt).toISOString(),
      userAgent: browserUa,
      ipHash: 'ip_sender',
      gmailMessageId: 'msg_reload',
      source: 'PAGE_RELOAD',
    });
    expect(reload.reclassifiedEventIds).toEqual(['evt_raced_proxy']);
    expect(reload.openCount).toBe(1);
    const events = await callQuery(tracking.listEvents, ctx, { trackingId });
    expect(events.find((event: any) => event.eventId === 'evt_browser_recipient').classification).toBe('RECIPIENT_LIKELY');
    expect(events.find((event: any) => event.eventId === 'evt_raced_proxy').classification).toBe('SELF_LIKELY');
  });

  it('does not re-arm the slot when the same PAGE_RELOAD event is delivered again', async () => {
    const { ctx, db } = createMockDb();
    const base = Date.parse('2026-09-24T18:00:00.000Z');
    const trackingId = 'trk_page_reload_retry';
    const eventId = `sv_${trackingId}_PAGE_RELOAD_${base}`;
    await seedReloadEmail(ctx, trackingId, new Date(base - 60_000).toISOString());
    await callMutation(tracking.recordSelfView, ctx, {
      eventId,
      trackingId,
      timestamp: new Date(base).toISOString(),
      userAgent: browserUa,
      ipHash: 'ip_sender',
      gmailMessageId: 'msg_reload',
      source: 'PAGE_RELOAD',
    });
    await callMutation(tracking.recordOpenEvent, ctx, openArgs(trackingId, 'evt_reload_proxy', new Date(base + 300).toISOString(), proxyUa, 'ip_google'));
    expect((await callQuery(tracking.getEmail, ctx, { trackingId })).openCount).toBe(0);
    await callMutation(tracking.recordSelfView, ctx, {
      eventId,
      trackingId,
      timestamp: new Date(base).toISOString(),
      userAgent: browserUa,
      ipHash: 'ip_sender',
      gmailMessageId: 'msg_reload',
      source: 'PAGE_RELOAD',
    });
    const claim = (await db.query('selfViewClaims').collect()).find((row) => row.trackingId === trackingId);
    expect(claim?.proxyConsumedByEventId).toBe('evt_reload_proxy');
    await callMutation(
      tracking.recordOpenEvent,
      ctx,
      openArgs(trackingId, 'evt_recipient_after_retry', new Date(base + 4_000).toISOString(), proxyUa, 'ip_google'),
    );
    expect((await callQuery(tracking.getEmail, ctx, { trackingId })).openCount).toBe(1);
  });
});
