import type { AskPigeonResponse, AskTurn } from '@pigeonbox/api-contract';
import { zonedTimeToUtc } from '@pigeonbox/shared';
import { describe, expect, it } from 'vitest';
import type { ChatRequest, ChatResult } from '../ai/backends.js';
import { connectedUser, createIntelHarness, deliverAndSync, type IntelHarness } from '../testing/intel-harness.js';
import { formatRange, parseLocalTime } from './ask-actions.js';

const ADA = 'ada@work.test';
const MARTIN = 'martin@acme.test';
const ZONE = 'America/New_York';

const reply = (request: ChatRequest, patch: Partial<ChatResult>): ChatResult => ({ text: '', model: 'scripted', provider: 'mock', serviceTier: request.serviceTier, usage: { inputTokens: 10, outputTokens: 10 }, ...patch });
const toolResults = (request: ChatRequest) => request.messages.filter((message) => message.role === 'tool').map((message) => JSON.parse(message.content) as Record<string, unknown>);

/** "YYYY-MM-DDTHH:MM" in Ada's time zone, `days` from now. */
function local(days: number, time: string): string {
  const day = new Intl.DateTimeFormat('en-CA', { timeZone: ZONE, year: 'numeric', month: '2-digit', day: '2-digit' }).format(new Date(Date.now() + days * 86_400_000));
  return `${day}T${time}`;
}
const utc = (value: string) => {
  const [date, time] = value.split('T') as [string, string];
  const [year, month, day] = date.split('-').map(Number) as [number, number, number];
  const [hour, minute] = time.split(':').map(Number) as [number, number];
  return zonedTimeToUtc({ year, month, day, hour, minute }, ZONE);
};

/** One scripted proposal, then a short answer. */
function propose(h: IntelHarness, tool: string, args: Record<string, unknown>, seen: { tools?: string[]; result?: Record<string, unknown> } = {}) {
  let round = 0;
  h.deps.inference.chat = async (request) => {
    seen.tools ??= request.tools?.map((item) => item.name);
    if (!round++) return reply(request, { toolCalls: [{ id: 'p', name: tool, arguments: JSON.stringify(args) }] });
    seen.result = toolResults(request).at(-1);
    return reply(request, { text: 'Allow it below to add it.' });
  };
  return seen;
}

async function allow(h: IntelHarness, token: string, answer: AskPigeonResponse, query: string) {
  let told = '';
  h.deps.inference.chat = async (request) => {
    told = String(request.messages.at(-1)!.content);
    return reply(request, { text: 'Added to your calendar [S1].' });
  };
  const history: AskTurn[] = [{ role: 'user', content: query }, { role: 'assistant', content: answer.answer, ...(answer.context ? { context: answer.context } : {}) }];
  const done = await h.route<AskPigeonResponse>('askPigeon', token, { query: 'Allow', history, features: ['approval'], decision: { token: answer.approval!.token, allow: true } });
  return { done, told };
}

describe('Chat adds calendar events after the user allows them', () => {
  it('reads a bare local time in the user\'s time zone, never as UTC', () => {
    expect(parseLocalTime('2026-10-22T12:30', 'America/Los_Angeles')!.toISOString()).toBe('2026-10-22T19:30:00.000Z');
    expect(parseLocalTime('2026-10-22T12:30:00-04:00', 'America/Los_Angeles')!.toISOString()).toBe('2026-10-22T16:30:00.000Z');
    expect(parseLocalTime('next Thursday', 'UTC')).toBeNull();
    expect(parseLocalTime('2026-13-01T10:00', 'UTC')).toBeNull();
    expect(formatRange(new Date('2026-10-22T19:30:00Z'), new Date('2026-10-22T20:00:00Z'), 'America/Los_Angeles')).toBe('Thu, Oct 22, 12:30–1:00 PM PDT');
  });

  it('proposes a meeting with an invitation, creates nothing until Allow, then creates exactly that event', async () => {
    const h = await createIntelHarness();
    const user = await connectedUser(h, ADA);
    const account = h.google.account(ADA);
    const start = local(1, '12:30');
    const query = 'schedule a 30 minute meeting with Martin tomorrow at 12:30';
    const seen = propose(h, 'create_event', { title: 'Ada / Martin', start, duration_minutes: 30, attendees: [`Martin Li <${MARTIN}>`, ADA], invite: true, google_meet: true });
    const answer = await h.route<AskPigeonResponse>('askPigeon', user.token, { query, features: ['compose', 'approval'] });

    expect(seen.tools).toEqual(expect.arrayContaining(['create_event', 'remind_me', 'change_mail']));
    expect(seen.result).toMatchObject({ status: 'awaiting_user_approval', actionTaken: false });
    expect(answer.approval?.title).toBe('Schedule “Ada / Martin”');
    const steps = answer.approval!.steps;
    expect(steps[0]!.text).toContain(`Add “Ada / Martin” to your calendar (${ADA}): ${formatRange(utc(start), new Date(utc(start).getTime() + 30 * 60_000), ZONE)}`);
    expect(steps[0]!.examples).toEqual(['Google Meet link']);
    // The user's own address is not a guest; the invitation is called out as irreversible.
    expect(steps.at(-1)).toMatchObject({ examples: [MARTIN], count: 1, destructive: true });
    expect(steps.at(-1)!.text).toContain('can’t be unsent');
    expect(account.events).toEqual([]);

    const { done, told } = await allow(h, user.token, answer, query);
    expect(told).toContain('The user allowed');
    expect(told).toContain('invitationsSentTo');
    expect(told).toContain('https://meet.test/');
    expect(done.approval).toBeUndefined();
    expect(account.events).toHaveLength(1);
    expect(account.events[0]).toMatchObject({ summary: 'Ada / Martin', start: utc(start).toISOString(), end: new Date(utc(start).getTime() + 30 * 60_000).toISOString(), attendees: [MARTIN], sendUpdates: 'all' });
    expect(done.sources).toEqual([expect.objectContaining({ kind: 'calendar_event', title: 'Ada / Martin', url: expect.stringContaining('https://calendar.test/') })]);
    const [audit] = await h.sql<{ action: string; tier: number; actor_name: string }>(`select action, tier, actor_name from public.audit_events where action = 'create_event'`);
    expect(audit).toMatchObject({ action: 'create_event', tier: 3, actor_name: 'Chat' });

    // A second Allow of the same card does nothing.
    const again = await allow(h, user.token, answer, query);
    expect(again.done.answer).toContain('couldn\'t verify');
    expect(account.events).toHaveLength(1);
  });

  it('adds a private hold without emailing anyone, shows overlaps, and can be undone', async () => {
    const h = await createIntelHarness();
    const user = await connectedUser(h, ADA);
    const account = h.google.account(ADA);
    const start = local(2, '15:00');
    h.google.addEvent(ADA, { summary: 'Standup', start: new Date(utc(start).getTime() - 15 * 60_000), end: new Date(utc(start).getTime() + 15 * 60_000) });
    propose(h, 'create_event', { title: 'Focus', start, end: local(2, '16:00'), attendees: [MARTIN] });
    const answer = await h.route<AskPigeonResponse>('askPigeon', user.token, { query: 'block 3-4 for focus', features: ['approval'] });
    const steps = answer.approval!.steps;
    expect(steps[1]!.text).toBe('It overlaps something already on your calendar');
    expect(steps[1]!.examples[0]).toMatch(/^Busy /);
    expect(steps[2]).toMatchObject({ text: 'List a guest without emailing them', destructive: false });

    await allow(h, user.token, answer, 'block 3-4 for focus');
    const created = account.events.find((event) => event.summary === 'Focus')!;
    expect(created.sendUpdates).toBe('none');
    const [audit] = await h.sql<{ id: string; reversible: boolean }>(`select id, reversible from public.audit_events where action = 'create_event'`);
    expect(audit!.reversible).toBe(true);
  });

  it('explains how to allow calendar writes instead of proposing', async () => {
    const h = await createIntelHarness();
    const user = await connectedUser(h, ADA, ['mail_read', 'calendar_read']);
    const seen = propose(h, 'create_event', { title: 'Lunch', start: local(1, '12:00') });
    const answer = await h.route<AskPigeonResponse>('askPigeon', user.token, { query: 'put lunch on my calendar tomorrow at noon', features: ['approval'] });
    expect(answer.approval).toBeUndefined();
    expect(JSON.stringify(seen.result)).toContain('Add calendar events');
  });

  it('refuses times in the past and guessed attendees', async () => {
    const h = await createIntelHarness();
    const user = await connectedUser(h, ADA);
    const past = propose(h, 'create_event', { title: 'Late', start: local(-2, '09:00') });
    expect((await h.route<AskPigeonResponse>('askPigeon', user.token, { query: 'add it', features: ['approval'] })).approval).toBeUndefined();
    expect(past.result).toMatchObject({ error: expect.stringContaining('already passed') });
    const named = propose(h, 'create_event', { title: 'Call', start: local(1, '10:00'), attendees: ['Martin'] });
    expect((await h.route<AskPigeonResponse>('askPigeon', user.token, { query: 'add it', features: ['approval'] })).approval).toBeUndefined();
    expect(named.result).toMatchObject({ invalid: ['Martin'] });
  });

  it('does not offer calendar changes to apps that cannot ask the user', async () => {
    const h = await createIntelHarness();
    const user = await connectedUser(h, ADA);
    const seen = propose(h, 'calendar_events', {});
    await h.route<AskPigeonResponse>('askPigeon', user.token, { query: 'what is on my calendar', features: ['compose'] });
    expect(seen.tools).not.toContain('create_event');
    expect(seen.tools).not.toContain('remind_me');
  });
});

describe('Chat sets reminders and snoozes after the user allows them', () => {
  it('snoozes an email: archived on Allow, back in the inbox with a notification at the chosen time', async () => {
    const h = await createIntelHarness();
    const user = await connectedUser(h, ADA, undefined, { notifications: { followUpsDue: false } });
    const account = h.google.account(ADA);
    const mail = await deliverAndSync(h, ADA, { from: MARTIN, to: [ADA], subject: 'Contract redlines', body: 'Can you look at these next week?' });
    const at = local(3, '09:00');
    let round = 0;
    h.deps.inference.chat = async (request) => {
      if (round === 0) { round += 1; return reply(request, { toolCalls: [{ id: 'l', name: 'list_threads', arguments: JSON.stringify({ query: 'in:inbox' }) }] }); }
      if (round === 1) {
        round += 1;
        const source = (toolResults(request)[0]!.threads as Array<{ source: string }>)[0]!.source;
        return reply(request, { toolCalls: [{ id: 'r', name: 'remind_me', arguments: JSON.stringify({ at, thread: source, snooze: true, note: 'Review the redlines' }) }] });
      }
      return reply(request, { text: 'Allow it below.' });
    };
    const query = 'snooze the redlines email until Thursday 9am';
    const answer = await h.route<AskPigeonResponse>('askPigeon', user.token, { query, features: ['approval'] });
    expect(answer.approval!.steps.map((step) => step.text)).toEqual([
      'Archive this thread now; it comes back to your inbox at the reminder',
      expect.stringMatching(/^Remind you about “Contract redlines” on /),
    ]);
    const inInbox = () => [...account.messages.values()].filter((message) => message.threadId === mail.threadId).every((message) => message.labelIds.includes('INBOX'));
    expect(inInbox()).toBe(true);

    await allow(h, user.token, answer, query);
    expect(inInbox()).toBe(false);
    const [reminder] = await h.sql<{ source: string; remind_at: Date }>(`select source, remind_at from public.reminders`);
    expect(reminder).toMatchObject({ source: 'manual' });
    expect(new Date(reminder!.remind_at).toISOString()).toBe(utc(at).toISOString());

    await h.advance(utc(at).getTime() - Date.now() + 60_000);
    await h.drain();
    expect(inInbox()).toBe(true);
    // A time the user chose is delivered even with routine follow-up alerts switched off.
    expect(await h.sql(`select title, body from public.notifications where kind = 'follow_up_due'`)).toEqual([{ title: 'Reminder: Contract redlines', body: 'Review the redlines' }]);
  });

  it('sets a plain reminder without touching the mailbox', async () => {
    const h = await createIntelHarness();
    const user = await connectedUser(h, ADA, ['mail_read']);
    propose(h, 'remind_me', { at: local(1, '08:00'), note: 'Send the deck to Martin' });
    const answer = await h.route<AskPigeonResponse>('askPigeon', user.token, { query: 'remind me tomorrow at 8 to send the deck', features: ['approval'] });
    expect(answer.approval!.steps).toEqual([expect.objectContaining({ examples: ['Send the deck to Martin'], destructive: false })]);
    await allow(h, user.token, answer, 'remind me tomorrow at 8 to send the deck');
    expect(await h.sql(`select reason, source, thread_id from public.reminders`)).toEqual([{ reason: 'Send the deck to Martin', source: 'manual', thread_id: null }]);
  });
});
