import { allowScriptedAskAction } from '../testing/scripted-ask.js';
import { AskStreamEventSchema, ROUTES, type AskPigeonResponse, type AskStreamEvent, type EngagementSignal, type RelationshipBrief } from '@pigeonbox/api-contract';
import { compactResult, coverageNote, nameWords, passages, recipient, splitFollowUps } from './ask-agent.js';
import { fetchPage, htmlToText } from '../platform/ssrf.js';
import { zonedParts, zonedTimeToUtc } from '@pigeonbox/shared';
import { describe, expect, it } from 'vitest';
import { connectedUser, createIntelHarness, deliverAndSync, type IntelHarness } from '../testing/intel-harness.js';
import { proposeSlots } from './scheduling.js';
import { classifyTrackingEvent, deriveSignals } from './signals.js';

const ADA = 'ada@work.test';
const MAYA = 'maya@client.test';

async function sources(h: IntelHarness, answer: AskPigeonResponse) {
  // Every claim cites a source we returned, and every source resolves to a record.
  const ids = new Set(answer.sources.map((source) => source.id));
  for (const claim of answer.claims) for (const id of claim.sourceIds) expect(ids.has(id)).toBe(true);
  for (const source of answer.sources) {
    if (source.gmailThreadId) expect(await h.sql('select 1 from public.threads where gmail_thread_id = $1', [source.gmailThreadId])).toHaveLength(1);
  }
}

describe('Ask Pigeon', () => {
  it('answers who you are waiting on from follow-up state, with sources', async () => {
    const h = await createIntelHarness();
    const user = await connectedUser(h, ADA);
    await deliverAndSync(h, ADA, { from: ADA, to: [MAYA], subject: 'Proposal', body: 'Could you review the proposal and let me know by Thursday?' });
    const answer = await h.route<AskPigeonResponse>('askPigeon', user.token, { query: 'Who am I waiting on?' });
    expect(answer.retrieval.strategies).toContain('filters');
    expect(answer.claims.length).toBeGreaterThan(0);
    expect(answer.answer).toMatch(/Proposal/);
    // Inline markers are renumbered to match the order of the returned sources.
    expect(answer.answer).toMatch(/\[1\]/);
    expect(answer.answer).not.toMatch(/\[S\d+\]/);
    await sources(h, answer);
  });

  it('finds a person named in lower case by searching Gmail live and reading the thread', async () => {
    const h = await createIntelHarness();
    const user = await connectedUser(h, ADA);
    await deliverAndSync(h, ADA, { from: 'news@claude.test', to: [ADA], subject: 'This week in Claude Code', body: 'Build your own mods.' });
    await deliverAndSync(h, ADA, { from: 'allen.hu@partner.test', fromName: 'Allen Hu', to: [ADA], subject: 'Contract redlines', body: 'I sent the redlines back. Can we sign by Monday?' });
    const answer = await h.route<AskPigeonResponse>('askPigeon', user.token, { query: 'who is allen h and what has he said to me recently' });
    expect(answer.answer).toMatch(/Allen Hu/);
    expect(answer.answer).toMatch(/sign by Monday/);
    expect(answer.sources.map((source) => source.title)).toEqual(['Contract redlines']);
    expect(answer.sources[0]!.gmailThreadId).toBeTruthy();
    await sources(h, answer);
  });

  it('streams progress, answer text and the cited response', async () => {
    const h = await createIntelHarness();
    const user = await connectedUser(h, ADA);
    await deliverAndSync(h, ADA, { from: 'allen.hu@partner.test', fromName: 'Allen Hu', to: [ADA], subject: 'Contract redlines', body: 'I sent the redlines back. Can we sign by Monday?' });
    const response = await h.call(ROUTES.askPigeonStream.path, { method: 'POST', body: { query: 'what did allen say?' }, token: user.token });
    expect(response.status).toBe(200);
    expect(response.headers.get('Content-Type')).toMatch(/application\/x-ndjson/);
    const events = (await response.text())
      .split('\n')
      .filter(Boolean)
      .map((line) => AskStreamEventSchema.parse(JSON.parse(line)) as AskStreamEvent);
    const statuses = events.filter((event) => event.type === 'status').map((event) => (event as { text: string }).text);
    expect(statuses).toContain('Searching Gmail: allen');
    expect(statuses).toContain('Reading "Contract redlines"');
    const streamed = events.filter((event) => event.type === 'delta').map((event) => (event as { text: string }).text).join('');
    expect(streamed).toMatch(/sign by Monday\?\s*\[S\d+\]/);
    const last = events[events.length - 1]!;
    expect(last.type).toBe('done');
    const done = (last as { response: AskPigeonResponse }).response;
    expect(done.answer).toMatch(/sign by Monday\?\s*\[1\]/);
    expect(done.sources[0]!.title).toBe('Contract redlines');
  });

  it('streams an error event when the answer fails', async () => {
    const h = await createIntelHarness();
    const user = await connectedUser(h, ADA);
    const response = await h.call(ROUTES.askPigeonStream.path, { method: 'POST', body: { query: 'what about [[mock:500]]' }, token: user.token });
    const events = (await response.text()).split('\n').filter(Boolean).map((line) => JSON.parse(line) as AskStreamEvent);
    expect(events[events.length - 1]).toMatchObject({ type: 'error', code: 'provider_error' });
  });

  it('shortens earlier tool results without losing their labels', () => {
    const long = JSON.stringify({ source: 'S1', messages: Array.from({ length: 14 }, (_, index) => ({ from: `p${index}@x.test`, text: 'x'.repeat(5_000) })) });
    const short = JSON.parse(compactResult(long)) as { source: string; compacted: boolean; messages: Array<{ text: string }> };
    expect(short.source).toBe('S1');
    expect(short.compacted).toBe(true);
    expect(short.messages).toHaveLength(10);
    expect(short.messages[0]!.text.length).toBeLessThan(700);
  });

  it('keeps the conversation: a follow-up question gets the earlier turns', async () => {
    const h = await createIntelHarness();
    const user = await connectedUser(h, ADA);
    let seen = '';
    const chat = h.deps.inference.chat.bind(h.deps.inference);
    h.deps.inference.chat = async (request, context) => {
      const approval = allowScriptedAskAction(request);
      if (approval) return approval;
      seen = request.messages.map((message) => `${message.role}:${message.content}`).join('\n');
      return chat(request, context);
    };
    await h.route<AskPigeonResponse>('askPigeon', user.token, {
      query: 'what else did he ask?',
      history: [
        { role: 'user', content: 'who is allen?' },
        { role: 'assistant', content: 'Allen Hu sent the contract redlines.' },
      ],
    });
    expect(seen).toMatch(/user:who is allen\?/);
    // The time goes in the question, so the system prompt and tools stay cacheable.
    expect(seen).toMatch(/user:\[Now: [^\]]+\]\nwhat else did he ask\?/);
    expect(seen.split('\nuser:')[0]).not.toMatch(/Now:/);
    expect(seen).toMatch(/assistant:Allen Hu sent the contract redlines/);
  });

  it('finds what you promised a person, from encrypted commitments', async () => {
    const h = await createIntelHarness();
    const user = await connectedUser(h, ADA);
    await deliverAndSync(h, ADA, { from: MAYA, fromName: 'Maya Chen', to: [ADA], subject: 'Deck', body: 'Can you send the deck?' });
    await deliverAndSync(h, ADA, { from: ADA, to: [MAYA], subject: 'Re: Deck', body: "Sure, I'll send the final deck by Friday.", threadId: [...h.google.account(ADA).messages.values()].find((m) => m.headers.Subject === 'Deck')!.threadId });
    const [row] = await h.sql<{ text_ciphertext: string }>('select text_ciphertext from public.commitments');
    expect(row!.text_ciphertext).not.toMatch(/deck/i);
    const answer = await h.route<AskPigeonResponse>('askPigeon', user.token, { query: 'What did I promise Maya by Friday?' });
    expect(answer.answer.toLowerCase()).toContain('deck');
    expect(answer.sources.some((source) => source.kind === 'commitment')).toBe(true);
    await sources(h, answer);
  });

  it('answers availability from the real calendar and says what it cannot see', async () => {
    const h = await createIntelHarness();
    const user = await connectedUser(h, ADA);
    await deliverAndSync(h, ADA, { from: 'david@partner.test', fromName: 'David Park', to: [ADA], subject: 'Hello', body: 'Nice to meet you.' });
    const now = h.now();
    for (let day = 0; day < 10; day += 1) {
      const start = new Date(now.getTime() + day * 86_400_000);
      h.google.addEvent(ADA, { summary: 'Blocked', start: new Date(start.setUTCHours(13, 0, 0, 0)), end: new Date(start.setUTCHours(20, 0, 0, 0)) });
    }
    const answer = await h.route<AskPigeonResponse>('askPigeon', user.token, { query: 'When am I free for a 30-minute call with David?' });
    expect(answer.retrieval.strategies).toContain('calendar');
    expect(answer.answer).toMatch(/Free /);
    expect(answer.sources[0]!.title).toBe('Your calendar availability');
  });

  it('says so when it finds nothing, without citing unrelated mail', async () => {
    const h = await createIntelHarness();
    const user = await connectedUser(h, ADA);
    await deliverAndSync(h, ADA, { from: MAYA, to: [ADA], subject: 'Lunch', body: 'Tacos on Friday?' });
    const answer = await h.route<AskPigeonResponse>('askPigeon', user.token, { query: 'What did the zebra committee decide about llamas?' });
    expect(answer.claims).toHaveLength(0);
    expect(answer.sources).toHaveLength(0);
    expect(answer.answer).toMatch(/couldn't find/);
  });

  it('flags incomplete coverage when Gmail access is lost', async () => {
    const h = await createIntelHarness();
    const user = await connectedUser(h, ADA);
    await h.sql(`update public.mail_accounts set features = array_remove(features, 'mail_read')`);
    const answer = await h.route<AskPigeonResponse>('askPigeon', user.token, { query: 'What did the zebra committee decide?' });
    expect(answer.coverage.complete).toBe(false);
    expect(answer.coverage.note).toMatch(/No Gmail account/);
  });

  it('answers a greeting without searching mail or citing sources', async () => {
    const h = await createIntelHarness();
    const user = await connectedUser(h, ADA);
    await deliverAndSync(h, ADA, { from: MAYA, to: [ADA], subject: 'Burglary reported', body: 'Keep records of all keys issued.' });
    const answer = await h.route<AskPigeonResponse>('askPigeon', user.token, { query: 'hi' });
    expect(answer.answer).toMatch(/^Hi! How can I help\?/);
    expect(answer.sources).toHaveLength(0);
    expect(answer.retrieval.candidates).toBe(0);
  });

  it('keeps Fast Recall off by default and deletes excerpts when turned off', async () => {
    const h = await createIntelHarness();
    const user = await connectedUser(h, ADA);
    await deliverAndSync(h, ADA, { from: MAYA, to: [ADA], subject: 'Budget', body: 'The budget for Q3 is approved at the level we discussed.' });
    expect(await h.sql('select * from public.recall_chunks')).toHaveLength(0);
    expect((await h.sql<{ n: number }>('select count(*)::int as n from public.search_documents'))[0]!.n).toBeGreaterThan(0);
    await h.route('preferencesUpdate', user.token, { preferences: { fastRecall: { enabled: true, retentionDays: 30 } } });
    await deliverAndSync(h, ADA, { from: MAYA, to: [ADA], subject: 'Hiring', body: 'We can open two engineering roles next quarter.' });
    const chunks = await h.sql<{ text_ciphertext: string; expires_at: Date }>('select text_ciphertext, expires_at from public.recall_chunks');
    expect(chunks.length).toBeGreaterThan(0);
    expect(chunks[0]!.text_ciphertext).not.toMatch(/engineering/);
    // Turning it off deletes the excerpts at once.
    await h.route('preferencesUpdate', user.token, { preferences: { fastRecall: { enabled: false } } });
    expect(await h.sql('select * from public.recall_chunks')).toHaveLength(0);
    // Purging synced mail data removes the derived index too.
    await h.route('controlPurgeMail', user.token, { confirm: 'delete synced mail data' });
    expect(await h.sql('select * from public.search_documents')).toHaveLength(0);
  });
});

describe('Calendar Copilot', () => {
  it('never proposes a slot that overlaps a busy interval or its buffer (randomized)', () => {
    const now = new Date('2026-10-05T12:00:00Z');
    for (let run = 0; run < 25; run += 1) {
      const busy = Array.from({ length: 12 }, () => {
        const start = now.getTime() + Math.floor(Math.random() * 7 * 24) * 3_600_000 + Math.floor(Math.random() * 4) * 15 * 60_000;
        return { start: new Date(start).toISOString(), end: new Date(start + (30 + Math.floor(Math.random() * 4) * 30) * 60_000).toISOString() };
      });
      const slots = proposeSlots({ busy, window: { start: now, end: new Date(now.getTime() + 7 * 86_400_000) }, durationMinutes: 30, timeZone: 'America/Los_Angeles', workdays: [1, 2, 3, 4, 5], workingHours: { start: '09:00', end: '17:00' }, bufferMinutes: 10, avoidBackToBack: true, preferMornings: false, focusBlocks: [{ day: 3, start: '09:00', end: '12:00' }], count: 4, now });
      for (const slot of slots) {
        for (const interval of busy) {
          const overlap = Date.parse(slot.start) < Date.parse(interval.end) + 15 * 60_000 && Date.parse(interval.start) - 15 * 60_000 < Date.parse(slot.end);
          expect(overlap).toBe(false);
        }
        const local = zonedParts(new Date(slot.start), 'America/Los_Angeles');
        expect(local.hour).toBeGreaterThanOrEqual(9);
        expect(local.hour * 60 + local.minute + 30).toBeLessThanOrEqual(17 * 60);
        expect([1, 2, 3, 4, 5]).toContain(local.weekday);
        expect(local.weekday === 3 && local.hour < 12).toBe(false);
      }
    }
  });

  it('proposes times in the user’s zone across daylight saving changes', () => {
    const now = zonedTimeToUtc({ year: 2026, month: 10, day: 30, hour: 6, minute: 0 }, 'America/New_York');
    const slots = proposeSlots({ busy: [], window: { start: now, end: new Date(now.getTime() + 6 * 86_400_000) }, durationMinutes: 60, timeZone: 'America/New_York', workdays: [1, 2, 3, 4, 5], workingHours: { start: '09:00', end: '10:00' }, bufferMinutes: 0, avoidBackToBack: false, preferMornings: false, focusBlocks: [], count: 3, now });
    // DST ends Nov 1: 09:00 local is 13:00Z before and 14:00Z after.
    expect(slots.map((slot) => slot.start)).toEqual(['2026-10-30T13:00:00.000Z', '2026-11-02T14:00:00.000Z', '2026-11-03T14:00:00.000Z']);
  });

  it('creates events only with the right permission, and sends invitations only after approval', async () => {
    const h = await createIntelHarness();
    const readOnly = await connectedUser(h, 'reader@work.test', ['mail_read', 'calendar_read']);
    const start = new Date(h.now().getTime() + 3 * 86_400_000).toISOString();
    const end = new Date(h.now().getTime() + 3 * 86_400_000 + 1_800_000).toISOString();
    const prepared = await h.route<{ event: { id: string } }>('eventPrepare', readOnly.token, { title: 'Sync', start, end, attendees: [] });
    await expect(h.route('eventCreate', readOnly.token, { preparedEventId: prepared.event.id, idempotencyKey: 'event-create-0001' })).rejects.toMatchObject({ code: 'forbidden' });

    const writer = await connectedUser(h, ADA);
    const hold = await h.route<{ event: { id: string } }>('eventPrepare', writer.token, { title: 'Focus hold', start, end, attendees: [] });
    const created = await h.route<{ event: { status: string; calendarEventId: string } }>('eventCreate', writer.token, { preparedEventId: hold.event.id, idempotencyKey: 'event-create-0002' });
    expect(created.event.status).toBe('created');
    expect(h.google.account(ADA).events.find((event) => event.id === created.event.calendarEventId)?.sendUpdates).toBe('none');

    const invite = await h.route<{ event: { id: string } }>('eventPrepare', writer.token, { title: 'Kickoff', start, end, attendees: [MAYA], notifyAttendees: true });
    const pending = await h.route<{ event: { status: string; approvalId: string } }>('eventCreate', writer.token, { preparedEventId: invite.event.id, idempotencyKey: 'event-create-0003' });
    expect(pending.event.status).toBe('approval_pending');
    expect(h.google.account(ADA).events.some((event) => event.summary === 'Kickoff')).toBe(false);
    await h.route('approvalDecide', writer.token, { id: pending.event.approvalId, decision: 'approve', idempotencyKey: 'approve-kickoff-01' });
    await h.drain();
    const kickoff = h.google.account(ADA).events.find((event) => event.summary === 'Kickoff');
    expect(kickoff?.sendUpdates).toBe('all');
  });
});

describe('Signal intelligence', () => {
  const at = (minutes: number) => new Date(Date.parse('2026-09-28T15:00:00Z') + minutes * 60_000).toISOString();
  const browser = 'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/17.0 Safari/605.1.15';
  const proxy = 'Mozilla/5.0 (Windows NT 5.1; rv:11.0) Gecko Firefox/11.0 (via ggpht.com GoogleImageProxy)';

  it('deduplicates renders per tracked message, keeping simultaneous opens of separate messages', () => {
    const events = ['first', 'second', 'first'].map((tracking_id, index) => ({ id: String(index), tracking_id, type: 'OPEN' as const,
      timestamp: new Date(Date.parse(at(0)) + index * 200).toISOString(), user_agent: browser, suspected_self_open: false,
      confidence: 0.7, classification: 'RECIPIENT_LIKELY', destination: null }));
    const result = deriveSignals({ events, recipients: ['a@x.test'], sentAt: at(-5), now: new Date(at(1)), followUpPending: false });
    expect(result.events).toHaveLength(2);
    expect(result.signals.find(signal => signal.kind === 'open_count')?.explanation).toContain('2 opens');
  });

  it('does not claim no recipient activity when a link click exists without an email-open detection', () => {
    const events = [{ id: 'click', tracking_id: 't', type: 'CLICK' as const, timestamp: at(1), user_agent: browser,
      suspected_self_open: false, confidence: 0.7, classification: 'RECIPIENT_LIKELY', destination: 'https://example.com' }];
    const result = deriveSignals({ events, recipients: ['a@x.test'], sentAt: at(0), now: new Date(at(60 * 24 * 4)), followUpPending: false });
    expect(result.signals.map(signal => signal.kind)).toContain('click');
    expect(result.signals.map(signal => signal.kind)).not.toContain('no_engagement');
  });

  it('does not infer first-ever or absent activity from a partial history', () => {
    const input = { recipients: ['a@x.test'], sentAt: at(0), now: new Date(at(60 * 24 * 4)), followUpPending: false, historyComplete: false };
    const empty = deriveSignals({ ...input, events: [] });
    expect(empty.signals.map(signal => signal.kind)).not.toContain('no_engagement');
    const events = [{ id: 'recent', tracking_id: 't', type: 'OPEN' as const, timestamp: at(30), user_agent: browser,
      suspected_self_open: false, confidence: 0.7, classification: 'RECIPIENT_LIKELY', destination: null }];
    const recent = deriveSignals({ ...input, events });
    expect(recent.signals.map(signal => signal.kind)).not.toContain('first_open');
    expect(recent.signals.map(signal => signal.kind)).toContain('latest_open');
    expect(recent.signals.find(signal => signal.kind === 'open_count')?.label).toContain('At least 1');
    expect(recent.attributionNote).toContain('recent activity only');
  });

  it('keeps self-views, machines and proxies out of human opens, and dedupes repeats', () => {
    const events = [
      { id: '1', tracking_id: 't', type: 'OPEN' as const, timestamp: at(0), user_agent: browser, suspected_self_open: true, confidence: 0.9, classification: 'SELF_LIKELY', destination: null },
      { id: '2', tracking_id: 't', type: 'OPEN' as const, timestamp: at(1), user_agent: 'Barracuda scanner', suspected_self_open: false, confidence: 0.8, classification: 'MACHINE_LIKELY', destination: null },
      { id: '3', tracking_id: 't', type: 'OPEN' as const, timestamp: at(2), user_agent: proxy, suspected_self_open: false, confidence: 0.4, classification: 'PROXY_LIKELY', destination: null },
      { id: '4', tracking_id: 't', type: 'OPEN' as const, timestamp: at(30), user_agent: browser, suspected_self_open: false, confidence: 0.7, classification: 'RECIPIENT_LIKELY', destination: null },
      { id: '5', tracking_id: 't', type: 'OPEN' as const, timestamp: new Date(Date.parse(at(30)) + 300).toISOString(), user_agent: browser, suspected_self_open: false, confidence: 0.7, classification: 'RECIPIENT_LIKELY', destination: null },
      { id: '6', tracking_id: 't', type: 'CLICK' as const, timestamp: at(31), user_agent: browser, suspected_self_open: false, confidence: 0.7, classification: 'RECIPIENT_LIKELY', destination: 'https://example.com/pricing' },
    ];
    const result = deriveSignals({ events, recipients: ['maya@client.test'], sentAt: at(-60), now: new Date(at(40)), followUpPending: true });
    const classes = result.events.map((event) => event.eventClass);
    expect(classes).toEqual(['SELF_LIKELY', 'MACHINE_LIKELY', 'PRIVACY_PROXY', 'RECIPIENT_LIKELY', 'RECIPIENT_LIKELY']);
    const count = result.signals.find((signal) => signal.kind === 'open_count') as EngagementSignal;
    expect(count.label).toBe('1 likely recipient open');
    expect(result.signals.find((signal) => signal.kind === 'click')!.label).toBe('Clicked example.com/pricing');
    expect(result.signals.find((signal) => signal.kind === 'ambiguous_activity')).toBeTruthy();
    expect(result.signals.every((signal) => !/read|interested|hot/i.test(signal.label))).toBe(true);
    expect(classifyTrackingEvent({ type: 'OPEN', classification: null, suspected_self_open: false, user_agent: proxy, confidence: null }).eventClass).toBe('PRIVACY_PROXY');
  });

  it('explains bursts and reopenings, and never claims per-recipient certainty for group mail', () => {
    const opens = [0, 10, 40, 60 * 24 * 15].map((minutes, index) => ({ id: String(index), tracking_id: 't', type: 'OPEN' as const, timestamp: at(minutes), user_agent: browser, suspected_self_open: false, confidence: 0.7, classification: 'RECIPIENT_LIKELY', destination: null }));
    const group = deriveSignals({ events: opens, recipients: ['a@x.test', 'b@x.test'], sentAt: at(-5), now: new Date(at(60 * 24 * 15 + 5)), followUpPending: false });
    expect(group.signals.find((signal) => signal.kind === 'engagement_burst')!.explanation).toBe('3 human-likely opens in 40 minutes.');
    expect(group.signals.find((signal) => signal.kind === 'reopened_after_inactivity')!.label).toBe('Reopened after 15 days');
    expect(group.signals.every((signal) => signal.attribution === 'message' && !signal.recipient)).toBe(true);
    expect(group.attributionNote).toMatch(/cannot be tied to a specific person/);
  });

  it('moves a waiting follow-up to engaged from tracking, and builds a relationship brief', async () => {
    const h = await createIntelHarness();
    const user = await connectedUser(h, ADA);
    const sent = await deliverAndSync(h, ADA, { from: ADA, to: [MAYA], subject: 'Pricing', body: 'Could you look at the pricing page and tell me what you think?' });
    await h.sql(`insert into public.tracked_emails (tracking_id, user_id, status, subject, sender, recipients, gmail_thread_id, sent_at) values ('trk_1', $1::uuid, 'SENT', 'Pricing', $2, $3::jsonb, $4, now())`, [user.userId, ADA, JSON.stringify([MAYA]), sent.threadId]);
    await h.sql(`insert into public.tracking_events (id, tracking_id, type, timestamp, user_agent, classification, confidence) values ('evt_1', 'trk_1', 'OPEN', now(), $1, 'RECIPIENT_LIKELY', 0.7)`, [browser]);
    await h.advance(60_000);
    await h.drain();
    const follow = await h.route<{ followUps: Array<{ followUp: { stage: string; engagement: { likelyOpens: number } } }> }>('followUps', user.token, {});
    expect(follow.followUps[0]!.followUp).toMatchObject({ stage: 'engaged', engagement: { likelyOpens: 1 } });
    const signals = await h.route<{ signals: EngagementSignal[] }>('threadSignals', user.token, { mailbox: ADA, threadId: sent.threadId });
    expect(signals.signals.map((signal) => signal.kind)).toContain('follow_up_timely');
    const brief = await h.route<{ brief: RelationshipBrief }>('contactBrief', user.token, { email: MAYA });
    expect(brief.brief.contact).toMatchObject({ email: MAYA, sentCount: 1, waiting: 'on_them' });
    expect(brief.brief.timeline.map((entry) => entry.kind)).toEqual(expect.arrayContaining(['email_out', 'open']));
    const radar = await h.route<Record<string, unknown[]>>('radar', user.token);
    expect(Object.keys(radar)).toEqual(['goingCold', 'unansweredImportant', 'promisedFollowUps', 'revived', 'upcomingMeetings', 'vipActivity']);
  });
});

describe('Ask Pigeon harness', () => {
  type Call = { id: string; name: string; arguments: string };
  /** A scripted model: each round returns the next tool calls, then an answer. Records what it was sent. */
  function script(h: IntelHarness, rounds: Call[][], answer = 'Done [S1].') {
    const sent: Array<Array<{ role: string; content: string }>> = [];
    h.deps.inference.chat = async (request) => {
      const approval = allowScriptedAskAction(request);
      if (approval) return approval;
      sent.push(request.messages.map((message) => ({ role: message.role, content: message.content })));
      const calls = rounds[sent.length - 1] ?? [];
      const usage = { inputTokens: 1_000, outputTokens: 10, cachedInputTokens: 800 };
      return calls.length ? { text: '', toolCalls: calls, model: 'scripted', provider: 'mock', serviceTier: request.serviceTier, usage } : { text: answer, model: 'scripted', provider: 'mock', serviceTier: request.serviceTier, usage };
    };
    return sent;
  }
  const gmail = (h: IntelHarness, pattern: RegExp) => h.google.calls.filter((call) => pattern.test(call.path)).length;

  it('runs an identical tool call once and points the model at the earlier result', async () => {
    const h = await createIntelHarness();
    const user = await connectedUser(h, ADA);
    await deliverAndSync(h, ADA, { from: 'allen.hu@partner.test', fromName: 'Allen Hu', to: [ADA], subject: 'Contract redlines', body: 'Can we sign by Monday?' });
    const sent = script(h, [[{ id: 'a', name: 'search_mail', arguments: '{"query":"allen"}' }], [{ id: 'b', name: 'search_mail', arguments: '{"query":" allen ","max_results":null}' }]]);
    const before = gmail(h, /\/messages$/);
    // No name in the question, so nothing is looked up before the model's own calls.
    const answer = await h.route<AskPigeonResponse>('askPigeon', user.token, { query: 'any news?' });
    expect(gmail(h, /\/messages$/) - before).toBe(1);
    const tools = sent.at(-1)!.filter((message) => message.role === 'tool').map((message) => JSON.parse(message.content) as Record<string, unknown>);
    expect(tools[0]!.results).toHaveLength(1);
    expect(tools[1]).toMatchObject({ sameAsEarlierCall: true });
    expect(answer.sources.map((source) => source.title)).toEqual(['Contract redlines']);
  });

  it('answers who opened but has not replied from tracking, with reply status', async () => {
    const h = await createIntelHarness();
    const user = await connectedUser(h, ADA);
    const KARAN = 'karan@kanu.test';
    const OWEN = 'owen@forum.test';
    const ERIC = 'eric@dreamscale.test';
    // Karan opened and replied (synced); Owen opened and never replied; Eric never opened.
    const toKaran = await deliverAndSync(h, ADA, { from: ADA, to: [KARAN], subject: 'Quick intro: PigeonBox', body: 'Would love 15 minutes.', at: new Date(Date.now() - 3 * 86_400_000) });
    await deliverAndSync(h, ADA, { from: KARAN, to: [ADA], subject: 'Re: Quick intro: PigeonBox', body: 'Sure, Tuesday works.', threadId: toKaran.threadId });
    const toOwen = await deliverAndSync(h, ADA, { from: ADA, to: [OWEN], subject: 'Quick intro: PigeonBox', body: 'Would love 15 minutes.', at: new Date(Date.now() - 3 * 86_400_000) });
    // Not synced: the reply check falls back to a live Gmail search.
    h.google.deliver(ADA, { from: ERIC, to: [ADA], subject: 'Re: Quick intro', body: 'Not interested, thanks.' });
    const insert = `insert into public.tracked_emails (tracking_id, user_id, status, subject, sender, recipients, gmail_thread_id, sent_at, open_count, first_opened_at, last_opened_at)
                    values ($1, $2::uuid, 'SENT', 'Quick intro: PigeonBox', $3, $4::jsonb, $5, now() - interval '3 days', $6, $7, $7)`;
    await h.sql(insert, ['trk_k', user.userId, ADA, JSON.stringify([KARAN]), toKaran.threadId, 2, new Date()]);
    await h.sql(insert, ['trk_o', user.userId, ADA, JSON.stringify([OWEN]), toOwen.threadId, 3, new Date()]);
    await h.sql(insert, ['trk_e', user.userId, ADA, JSON.stringify([ERIC]), 'thread-unsynced-1', 0, null]);
    await h.sql(`insert into public.tracked_emails (tracking_id, user_id, status, subject, sender, recipients, sent_at) values ('trk_old', $1::uuid, 'SENT', 'Other', $2, $3::jsonb, now() - interval '90 days')`, [user.userId, ADA, JSON.stringify([OWEN])]);
    const sent = script(h, [[
      { id: 'a', name: 'email_tracking', arguments: '{"status":"opened_no_reply","subject":"quick intro"}' },
      { id: 'b', name: 'email_tracking', arguments: '{"recipient":"dreamscale"}' },
    ]], 'Owen opened it and has not replied [S1].');
    const answer = await h.route<AskPigeonResponse>('askPigeon', user.token, { query: 'who opened my cold outreach but has not replied' });
    const [opened, eric] = sent.at(-1)!.filter((message) => message.role === 'tool').map((message) => JSON.parse(message.content) as { totals: Record<string, number>; results: Array<Record<string, unknown>>; error?: string });
    expect(opened.error).toBeUndefined();
    expect(opened.totals).toMatchObject({ tracked: 3, opened: 2, replied: 2, matching: 1 });
    expect(opened.results).toEqual([expect.objectContaining({ to: [OWEN], opens: 3, replied: 'no' })]);
    expect(eric.results).toEqual([expect.objectContaining({ to: [ERIC], opens: 0, replied: 'yes' })]);
    expect(answer.sources).toEqual([expect.objectContaining({ kind: 'tracking', who: OWEN })]);
    expect(answer.coverage.note).toBe('Looked at email tracking.');
  });

  it('counts opens across a whole campaign, past the scan window and the last month', async () => {
    const h = await createIntelHarness();
    const user = await connectedUser(h, ADA);
    // 1,205 cold emails sent 40 days ago, every third one opened; plus one other email.
    await h.sql(
      `insert into public.tracked_emails (tracking_id, user_id, status, subject, sender, recipients, gmail_thread_id, sent_at, open_count)
       select 'trk_' || n, $1::uuid, 'SENT', 'Hungry Kid x Company ' || n, $2, jsonb_build_array('founder' || n || '@co.test'), 'thread-cold-' || n,
              now() - interval '40 days' + n * interval '1 second', case when n % 3 = 0 then 2 else 0 end
         from generate_series(1, 1205) n`,
      [user.userId, ADA],
    );
    await h.sql(`insert into public.tracked_emails (tracking_id, user_id, status, subject, sender, recipients, sent_at, open_count) values ('trk_other', $1::uuid, 'SENT', 'Lunch?', $2, $3::jsonb, now() - interval '40 days', 1)`, [user.userId, ADA, JSON.stringify(['pal@friend.test'])]);
    const sent = script(h, [[{ id: 'a', name: 'email_tracking', arguments: '{"subject":"hungry kid","max_results":1}' }]], 'About a third were opened [S1].');
    await h.route<AskPigeonResponse>('askPigeon', user.token, { query: 'out of all the hungry kid cold emails I sent, how many were opened' });
    const [result] = sent.at(-1)!.filter((message) => message.role === 'tool').map((message) => JSON.parse(message.content) as { period: string; totals: Record<string, number>; notes: string[]; error?: string });
    expect(result!.error).toBeUndefined();
    expect(result!.period).toBe('sent in the last 365 days');
    expect(result!.totals).toMatchObject({ tracked: 1205, opened: 401, matching: 1000 });
    expect(result!.notes).toEqual(expect.arrayContaining([expect.stringMatching(/count all 1205; .* newest 1000/)]));
  });

  it('gives Ask relationship briefs, memory and sequences, and tells it how to address people', async () => {
    const h = await createIntelHarness();
    const user = await connectedUser(h, ADA);
    await deliverAndSync(h, ADA, { from: 'wchen@cs.uni.test', fromName: 'Wei Chen', to: [ADA], subject: 'Office hours', body: 'Come by Thursday.\n\nWei Chen, PhD\nProfessor of Computer Science' });
    let system = '';
    let offered: string[] = [];
    const rounds = [[
      { id: 'a', name: 'contact_brief', arguments: '{"email":"wchen@cs.uni.test"}' },
      { id: 'b', name: 'list_sequences', arguments: '{}' },
      { id: 'c', name: 'recall_memory', arguments: '{"topic":"office hours","people":["wchen@cs.uni.test"]}' },
      { id: 'd', name: 'contact_brief', arguments: '{"email":"nobody@nowhere.test"}' },
    ]];
    const tools: string[][] = [];
    h.deps.inference.chat = async (request) => {
      const approval = allowScriptedAskAction(request);
      if (approval) return approval;
      system = request.messages.find((message) => message.role === 'system')?.content ?? system;
      offered = (request.tools ?? []).map((tool) => tool.name);
      tools.push(request.messages.filter((message) => message.role === 'tool').map((message) => message.content));
      const calls = rounds[tools.length - 1] ?? [];
      const usage = { inputTokens: 10, outputTokens: 1 };
      return calls.length ? { text: '', toolCalls: calls, model: 'scripted', provider: 'mock', serviceTier: request.serviceTier, usage } : { text: 'Done [S1].', model: 'scripted', provider: 'mock', serviceTier: request.serviceTier, usage };
    };
    await h.route<AskPigeonResponse>('askPigeon', user.token, { query: 'email professor chen about office hours', features: ['compose'] });
    expect(offered).toEqual(expect.arrayContaining(['contact_brief', 'recall_memory', 'list_sequences', 'email_tracking']));
    expect(system).toMatch(/Dr\. Chen/);
    expect(system).toMatch(/Never greet someone by a bare last name/);
    const [brief, sequences, memory, missing] = tools.at(-1)!.map((content) => JSON.parse(content) as Record<string, unknown>);
    expect(brief).toMatchObject({ email: 'wchen@cs.uni.test', name: 'Wei Chen' });
    expect(sequences).toMatchObject({ sequences: [] });
    expect(memory.error).toBeUndefined();
    expect(missing.error).toMatch(/no synced mail/);
  });

  it('reads the open email while the model decides, without reading it twice', async () => {
    const h = await createIntelHarness();
    const user = await connectedUser(h, ADA);
    const open = await deliverAndSync(h, ADA, { from: MAYA, to: [ADA], subject: 'Pricing', body: 'Can you send the updated pricing by Friday?' });
    const sent = script(h, [[{ id: 'a', name: 'read_thread', arguments: '{"source":"S1"}' }]], 'Maya wants the pricing by Friday [S1].');
    const reads = () => gmail(h, new RegExp(`/threads/${open.threadId}$`));
    const before = reads();
    const answer = await h.route<AskPigeonResponse>('askPigeon', user.token, { mailbox: ADA, threadId: open.threadId, query: 'what does she want?' });
    expect(reads() - before).toBe(1);
    expect(sent.at(-1)!.find((message) => message.role === 'tool')!.content).toMatch(/updated pricing/);
    expect(answer.sources[0]!.title).toBe('Pricing');
  });

  it('keeps the shared instructions first and identical for every user, and history within budget', async () => {
    const h = await createIntelHarness();
    const ada = await connectedUser(h, ADA);
    const maya = await connectedUser(h, MAYA);
    const sent = script(h, []);
    const history = Array.from({ length: 20 }, (_, index) => ({ role: index % 2 ? ('assistant' as const) : ('user' as const), content: `${index} ${'x'.repeat(3_000)}` }));
    await h.route<AskPigeonResponse>('askPigeon', ada.token, { query: 'and then?', history });
    await h.route<AskPigeonResponse>('askPigeon', maya.token, { query: 'hello there, what is new?' });
    const [first, second] = [sent[0]!, sent[1]!];
    expect(first[0]).toEqual(second[0]);
    expect(first[0]!.content).not.toMatch(/ada@|maya@/);
    expect(first[1]!.content).toMatch(/ada@work\.test/);
    expect(second[1]!.content).toMatch(/maya@client\.test/);
    const earlier = first.slice(2, -1);
    expect(earlier.reduce((sum, message) => sum + message.content.length, 0)).toBeLessThanOrEqual(64_000);
    expect(earlier.at(-1)!.content).toMatch(/^19 /);
  });
});

describe('Ask Pigeon on the web', () => {
  const DIRECTORY = `<html><head><title>EECS People | UC Berkeley</title><script>var x = "<a href='mailto:fake@x.com'>"</script></head><body>
    <nav><a href="/about">About</a></nav>
    <table><tr><td>Jane Kim</td><td><a href="mailto:jkim@example.edu">Email</a></td></tr>
    <tr><td>Remy Avery Lin</td><td>Undergraduate, EECS</td><td><a href="/cdn-cgi/l/email-protection" data-cfemail="${cf('remylin@example.edu')}">[email&#160;protected]</a></td></tr></table>
  </body></html>`;
  function cf(address: string): string {
    const key = 0x42;
    return [key, ...[...address].map((char) => char.charCodeAt(0) ^ key)].map((byte) => byte.toString(16).padStart(2, '0')).join('');
  }

  it('reads a directory page as text, with mailto and Cloudflare-hidden addresses visible', () => {
    const page = htmlToText(DIRECTORY, 'https://eecs.example.edu/people');
    expect(page.title).toBe('EECS People | UC Berkeley');
    expect(page.text).toMatch(/Jane Kim \| Email \(jkim@example\.edu\)/);
    expect(page.text).toMatch(/Remy Avery Lin.*remylin@example\.edu/);
    expect(page.text).not.toMatch(/fake@x\.com/);
    expect(page.text).toMatch(/About \(https:\/\/eecs\.example\.edu\/about\)/);
  });

  it('keeps only the passages that mention what it is looking for', () => {
    const text = ['intro', 'a', 'b', 'Remy Lin, EECS', 'remylin@example.edu', 'c', 'd', 'e', 'Jane Kim'].join('\n');
    expect(passages(text, ['eecs'], 1_000)).toBe('b\nRemy Lin, EECS\nremylin@example.edu');
    expect(passages(text, ['nobody'], 1_000)).toBe('');
  });

  it('accepts only real addresses as recipients', () => {
    expect(recipient('Remy Lin <RemyLin@Example.edu>')).toEqual({ email: 'remylin@example.edu', name: 'Remy Lin' });
    expect(recipient('remylin@example.edu')).toEqual({ email: 'remylin@example.edu' });
    expect(recipient('Remy Lin')).toBeNull();
    expect(recipient('remylin@example')).toBeNull();
    expect(recipient(42)).toBeNull();
  });

  it('follows safe redirects and refuses ones into private networks', async () => {
    const fake = (async (url: string) =>
      url === 'https://example.com/a'
        ? new Response(null, { status: 301, headers: { location: '/b' } })
        : url === 'https://example.com/b'
          ? new Response('<title>B</title><p>hello</p>', { headers: { 'content-type': 'text/html' } })
          : new Response(null, { status: 302, headers: { location: 'https://10.0.0.1/admin' } })) as unknown as typeof fetch;
    await expect(fetchPage(fake, 'https://example.com/a')).resolves.toMatchObject({ url: 'https://example.com/b', title: 'B', text: 'hello' });
    await expect(fetchPage(fake, 'https://example.com/c')).rejects.toThrow(/private_ip/);
  });

  it('caps a page even when a single network chunk exceeds the byte budget', async () => {
    const fake = (async () => new Response('x'.repeat(100_000), { headers: { 'content-type': 'text/plain' } })) as typeof fetch;
    expect((await fetchPage(fake, 'https://example.com/page', { maxBytes: 128 })).text).toHaveLength(128);
  });

  it('finds a person on the web and opens an addressed email in the composer', async () => {
    const h = await createIntelHarness({ env: { WEB_SEARCH_PROVIDER: 'brave', WEB_SEARCH_API_KEY: 'brave-test' } });
    const user = await connectedUser(h, ADA);
    await h.route('preferencesUpdate', user.token, { preferences: { webResearch: true } });
    const intel = h.deps.intel!;
    const google = intel.fetch;
    const web: string[] = [];
    intel.fetch = (async (input: RequestInfo | URL, init?: RequestInit) => {
      const url = String(input);
      if (url.startsWith('https://api.search.brave.com/')) {
        web.push(new URL(url).searchParams.get('q') ?? '');
        return Response.json({ web: { results: [{ title: 'EECS People', url: 'https://eecs.example.edu/people', description: 'Directory of EECS students' }] } });
      }
      if (url === 'https://eecs.example.edu/people') return new Response(DIRECTORY, { headers: { 'content-type': 'text/html; charset=utf-8' } });
      return google(input, init);
    }) as typeof fetch;
    const rounds = [
      [{ id: 'a', name: 'find_contacts', arguments: '{"name":"remy lin"}' }, { id: 'b', name: 'web_search', arguments: '{"query":"Remy Avery Lin UC Berkeley email"}' }],
      [{ id: 'c', name: 'read_webpage', arguments: '{"url":"https://eecs.example.edu/people","look_for":"Lin"}' }],
      [{ id: 'd', name: 'compose_email', arguments: JSON.stringify({ to: ['Remy Lin <remylin@example.edu>', 'not an address'], subject: 'Hi Remy', body: 'Hi Remy,\n\nJust wanted to say hi.\n\nAda' }) }],
    ];
    const sent: string[][] = [];
    h.deps.inference.chat = async (request) => {
      const approval = allowScriptedAskAction(request);
      if (approval) return approval;
      sent.push(request.messages.filter((message) => message.role === 'tool').map((message) => message.content));
      const calls = rounds[sent.length - 1] ?? [];
      const usage = { inputTokens: 100, outputTokens: 10 };
      return calls.length ? { text: '', toolCalls: calls, model: 'scripted', provider: 'mock', serviceTier: request.serviceTier, usage } : { text: 'Opened an email to Remy Lin, whose address is on the EECS directory [S1].', model: 'scripted', provider: 'mock', serviceTier: request.serviceTier, usage };
    };
    const answer = await h.route<AskPigeonResponse>('askPigeon', user.token, { query: "draft an email to remy avery lin, he's a student at berkeley", features: ['compose'] });
    expect(web).toEqual(['remy avery lin uc berkeley email']);
    const page = JSON.parse(sent[2]!.at(-1)!) as { emailAddressesOnPage: string[]; text: string };
    expect(page.emailAddressesOnPage).toEqual(['jkim@example.edu', 'remylin@example.edu']);
    expect(page.text).toMatch(/Remy Avery Lin/);
    expect(page.text).not.toMatch(/Jane Kim/);
    expect(JSON.parse(sent[3]!.at(-1)!)).toMatchObject({ opened: true, to: ['remylin@example.edu'], ignored: ['not an address'] });
    expect(answer.compose).toEqual([{ to: [{ email: 'remylin@example.edu', name: 'Remy Lin' }], cc: [], subject: 'Hi Remy', body: 'Hi Remy,\n\nJust wanted to say hi.\n\nBest,\nada' }]);
    expect(answer.sources).toEqual([expect.objectContaining({ kind: 'web', url: 'https://eecs.example.edu/people' })]);
    expect(answer.coverage.note).toBe('Looked at your contacts and the web (1 page).');
  });

  it('keeps Ask off the web when the user turns web search off', async () => {
    const h = await createIntelHarness({ env: { WEB_SEARCH_PROVIDER: 'brave', WEB_SEARCH_API_KEY: 'brave-test' } });
    const user = await connectedUser(h, ADA);
    await h.route('preferencesUpdate', user.token, { preferences: { webResearch: false } });
    let offered: string[] = [];
    h.deps.inference.chat = async (request) => {
      const approval = allowScriptedAskAction(request);
      if (approval) return approval;
      offered = (request.tools ?? []).map((tool) => tool.name);
      return { text: 'ok', model: 'scripted', provider: 'mock', serviceTier: request.serviceTier, usage: { inputTokens: 1, outputTokens: 1 } };
    };
    await h.route<AskPigeonResponse>('askPigeon', user.token, { query: 'who runs acme corp?', features: ['compose'] });
    expect(offered).toContain('compose_email');
    expect(offered).not.toContain('web_search');
    expect(offered).not.toContain('read_webpage');
    // An extension that cannot open emails in Gmail is never offered compose_email.
    await h.route<AskPigeonResponse>('askPigeon', user.token, { query: 'email acme corp' });
    expect(offered).not.toContain('compose_email');
  });
});

describe('Ask Pigeon, faster and better', () => {
  it('picks out the words that could name a person or topic', () => {
    expect(nameWords("What did allen h say about the lease?")).toEqual(['allen', 'lease']);
    expect(nameWords("Draft a reply to Maya's last email")).toEqual(['maya']);
    expect(nameWords('what am I waiting on?')).toEqual(['waiting']);
  });

  it('splits suggested follow-ups off the end of the answer', () => {
    expect(splitFollowUps('Allen wants to sign Monday [S1].\n\nNext: Draft a reply to Allen | What else is due this week?')).toEqual({ answer: 'Allen wants to sign Monday [S1].', followUps: ['Draft a reply to Allen', 'What else is due this week?'] });
    expect(splitFollowUps('Done.\n**Next:** "Open it" | "Remind me Friday" | x | Four | Five')).toEqual({ answer: 'Done.', followUps: ['Open it', 'Remind me Friday', 'Four'] });
    expect(splitFollowUps('Next steps are in the email.')).toEqual({ answer: 'Next steps are in the email.', followUps: [] });
  });

  it('looks up the person in the question before the model starts, so it can answer in one round', async () => {
    const h = await createIntelHarness();
    const user = await connectedUser(h, ADA);
    await deliverAndSync(h, ADA, { from: 'allen.hu@partner.test', fromName: 'Allen Hu', to: [ADA], subject: 'Contract redlines', body: 'Can we sign by Monday?' });
    const sent: string[] = [];
    h.deps.inference.chat = async (request) => {
      const approval = allowScriptedAskAction(request);
      if (approval) return approval;
      sent.push(request.messages.at(-1)!.content);
      // Parallel lookups may assign labels in either order; cite the mail's actual label.
      const source = request.messages.at(-1)!.content.match(/Latest mail with [^\n]*"source":"(S\d+)"/)?.[1];
      expect(source).toBeTruthy();
      return { text: `Allen sent the contract redlines [${source}].\nNext: Read the redlines | Draft a reply to Allen`, model: 'scripted', provider: 'mock', serviceTier: request.serviceTier, usage: { inputTokens: 10, outputTokens: 10 } };
    };
    const searches = () => h.google.calls.filter((call) => /\/messages$/.test(call.path)).length;
    const before = searches();
    const answer = await h.route<AskPigeonResponse>('askPigeon', user.token, { query: 'what did allen h send me?' });
    expect(sent).toHaveLength(1);
    expect(sent[0]).toMatch(/Contacts matching words in the question: .*allen\.hu@partner\.test/);
    expect(sent[0]).toMatch(/Latest mail with Allen Hu <allen\.hu@partner\.test>.*Contract redlines/);
    expect(sent[0]).toMatch(/Reminders: .*Next: line\.$/);
    expect(searches() - before).toBe(1);
    expect(answer.answer).toBe('Allen sent the contract redlines [1].');
    expect(answer.sources.map((source) => source.title)).toEqual(['Contract redlines']);
    expect(answer.followUps).toEqual(['Read the redlines', 'Draft a reply to Allen']);
    expect(answer.requestId).toBeTruthy();
    expect(answer.coverage.note).toMatch(/1 Gmail search/);
  });

  it('stores feedback with the question encrypted, and a second rating replaces the first', async () => {
    const h = await createIntelHarness();
    const user = await connectedUser(h, ADA);
    await h.route('askFeedback', user.token, { requestId: 'req-1', rating: 'up', question: 'what did allen say?' });
    await h.route('askFeedback', user.token, { requestId: 'req-1', rating: 'down', question: 'what did allen say?', note: 'Missed his second email' });
    const rows = await h.sql<{ rating: string; question_ciphertext: string; note_ciphertext: string }>('select rating, question_ciphertext, note_ciphertext from public.ask_feedback');
    expect(rows).toHaveLength(1);
    expect(rows[0]!.rating).toBe('down');
    expect(rows[0]!.question_ciphertext).not.toMatch(/allen/);
    expect(rows[0]!.note_ciphertext).toBeTruthy();
  });
});

describe('Ask Pigeon across inboxes', () => {
  const SCHOOL = 'ada@school.test';
  async function twoInboxes() {
    const h = await createIntelHarness();
    const user = await connectedUser(h, ADA);
    h.google.addAccount(SCHOOL);
    await h.connect(user.token, SCHOOL, ['mail_read', 'drafts']);
    await h.drain();
    await deliverAndSync(h, SCHOOL, { from: 'jun@school.test', fromName: 'Jun Oh', to: [SCHOOL], subject: 'Problem set 4', body: 'Due Friday.' });
    await deliverAndSync(h, ADA, { from: 'jun@partner.test', fromName: 'Jun Park', to: [ADA], subject: 'Lunch?', body: 'Free Thursday?' });
    const sent: Array<Array<{ role: string; content: string }>> = [];
    const script = (rounds: Array<Array<{ id: string; name: string; arguments: string }>>) => {
      sent.length = 0;
      h.deps.inference.chat = async (request) => {
      const approval = allowScriptedAskAction(request);
      if (approval) return approval;
        sent.push(request.messages.map((message) => ({ role: message.role, content: message.content })));
        const calls = rounds[sent.length - 1] ?? [];
        const usage = { inputTokens: 10, outputTokens: 10 };
        return calls.length ? { text: '', toolCalls: calls, model: 'scripted', provider: 'mock', serviceTier: request.serviceTier, usage } : { text: 'Done [S1].', model: 'scripted', provider: 'mock', serviceTier: request.serviceTier, usage };
      };
    };
    return { h, user, sent, script };
  }

  it('searches every inbox but puts the one the user is in first, and says which is which', async () => {
    const { h, user, sent, script } = await twoInboxes();
    script([[{ id: 'a', name: 'search_mail', arguments: '{"query":"jun"}' }]]);
    await h.route<AskPigeonResponse>('askPigeon', user.token, { query: 'any news?', mailbox: SCHOOL });
    const question = sent[0]!.at(-1)!.content;
    expect(question).toMatch(/in their ada@school\.test inbox right now/);
    expect(question).toMatch(/other connected inbox is ada@work\.test/);
    const result = JSON.parse(sent[1]!.find((message) => message.role === 'tool')!.content) as { results: Array<{ subject: string; account: string }> };
    // The school thread is older but comes first: it is the inbox the user is in.
    expect(result.results.map((item) => [item.subject, item.account])).toEqual([['Problem set 4', SCHOOL], ['Lunch?', ADA]]);
  });

  it('searches one inbox when asked to', async () => {
    const { h, user, sent, script } = await twoInboxes();
    script([[{ id: 'a', name: 'search_mail', arguments: JSON.stringify({ query: 'jun', account: ADA }) }, { id: 'b', name: 'search_mail', arguments: '{"query":"jun","account":"nobody@x.test"}' }]]);
    await h.route<AskPigeonResponse>('askPigeon', user.token, { query: 'any news?', mailbox: SCHOOL });
    const [only, unknown] = sent[1]!.filter((message) => message.role === 'tool').map((message) => JSON.parse(message.content) as { results?: Array<{ subject: string }>; error?: string });
    expect(only!.results!.map((item) => item.subject)).toEqual(['Lunch?']);
    expect(unknown!.error).toMatch(/not a connected inbox/);
  });

  it('tells the model when the user is in an inbox that is not connected', async () => {
    const h = await createIntelHarness();
    const user = await connectedUser(h, ADA);
    let question = '';
    h.deps.inference.chat = async (request) => {
      const approval = allowScriptedAskAction(request);
      if (approval) return approval;
      question = request.messages.at(-1)!.content;
      return { text: 'ok', model: 'scripted', provider: 'mock', serviceTier: request.serviceTier, usage: { inputTokens: 1, outputTokens: 1 } };
    };
    await h.route<AskPigeonResponse>('askPigeon', user.token, { query: 'any news?', mailbox: 'ada@school.test' });
    expect(question).toMatch(/ada@school\.test Gmail, which is not connected to PigeonBox/);
  });
});

describe('Ask coverage note', () => {
  it('says what Pigeon looked at, in plain words', () => {
    expect(coverageNote(new Map([['search_mail', 2], ['read_thread', 1], ['calendar_events', 1]]))).toBe('Looked at 2 Gmail searches, 1 thread and your calendar.');
    expect(coverageNote(new Map([['list_waiting_on', 1]]))).toBe('Looked at your follow-ups.');
    expect(coverageNote(new Map())).toBe('');
  });
});
