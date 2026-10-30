import type { ComposeCheckResponse, PersonalMemory } from '@pigeonbox/api-contract';
import { addCalendarDays, detectComposeContext, zonedParts, zonedTimeToUtc } from '@pigeonbox/shared';
import { afterEach, describe, expect, it } from 'vitest';
import { InferenceError, type ChatRequest, type InferenceContext } from '../ai/backends.js';
import { createIntelHarness, connectedUser, deliverAndSync, type IntelHarness } from '../testing/intel-harness.js';
import { MemoryFixtureAI } from '../testing/memory-fixtures.js';
import { composeInferenceFixture } from '../testing/compose-inference-fixture.js';
import { readDataBlock } from './prompts.js';
import { ensureEventCached } from './calendar.js';
import { createIntelDeps } from './context.js';
import { calendarConflict, COMPOSE_CHECKS_PER_MINUTE, validateJudgment } from './compose-check.js';

const ADA = 'ada@work.test';
const ALEX = 'alex@client.test';
const PROFESSOR = 'professor@berkeley.test';
const ZONE = 'America/New_York';

type Judgment = Record<string, unknown> | ((request: ChatRequest) => Record<string, unknown>) | 'outage' | 'timeout' | null;
/** Real pipeline; only the model is controlled. Counts compose_check calls and embeddings. */
class ComposeAI extends MemoryFixtureAI {
  judgment: Judgment = null;
  checks: ChatRequest[] = [];
  beforeAnswer?: () => Promise<void>;
  override async chat(request: ChatRequest, context: InferenceContext) {
    if (context.operation !== 'compose_check') return super.chat(request, context);
    this.checks.push(request);
    await this.beforeAnswer?.();
    if (this.judgment === 'outage') throw new InferenceError('provider_error', 'Mock provider failed.', 500);
    if (this.judgment === 'timeout') throw new InferenceError('provider_timeout', 'Mock provider timed out.');
    const data = readDataBlock(request.messages.at(-1)!.content) as { evidence: Array<{ id: string; advisories?: string[] }> };
    const text = JSON.stringify(composeInferenceFixture((typeof this.judgment === 'function' ? this.judgment(request) : this.judgment) ?? { surface: false }, data.evidence));
    return { text, model: 'fixture', provider: 'mock', serviceTier: request.serviceTier, usage: { inputTokens: 300, outputTokens: 40 } };
  }
}

const harnesses: IntelHarness[] = [];
afterEach(async () => {
  for (const h of harnesses.splice(0)) await h.pg.close();
});

/** A harness whose app clock is Monday 10:00 in New York, so "tomorrow" is a Tuesday workday. */
async function setup(preferences: Record<string, unknown> = { memory: { realtimeComposeChecks: true } }, owner = ADA) {
  const inference = new ComposeAI();
  const h = await createIntelHarness({ inference, env: { CLOUD_AI_INPUT_COST_PER_1K_MICROS: '100', CLOUD_AI_OUTPUT_COST_PER_1K_MICROS: '500', CLOUD_AI_MONTHLY_BUDGET_MICROS: '2000000' } });
  harnesses.push(h);
  const user = await connectedUser(h, owner, ['mail_read', 'drafts', 'calendar_read'], { autoDrafts: { enabled: false }, ...preferences });
  const p = zonedParts(h.now(), ZONE);
  const monday = addCalendarDays({ year: p.year, month: p.month, day: p.day }, (8 - p.weekday) % 7 || 7);
  await h.advance(zonedTimeToUtc({ ...monday, hour: 10, minute: 0 }, ZONE).getTime() - h.now().getTime());
  const deps = createIntelDeps({ config: h.config, db: h.db, box: h.box, google: h.deps.intel!.google, inference, store: h.store, log: h.deps.log, now: h.now, fetch: h.google.fetch, storage: h.storage });
  /** Local wall-clock time on a day relative to the app's Monday. */
  const at = (days: number, hour: number, minute = 0) => zonedTimeToUtc({ ...addCalendarDays(monday, days), hour, minute }, ZONE);
  const check = (claim: string, extra: Record<string, unknown> = {}, token = user.token) =>
    h.route<ComposeCheckResponse>('composeCheck', token, { claim, subject: 'Catching up', recipientEmails: [ALEX], mailbox: owner, hint: detectComposeContext(claim) ?? undefined, ...extra });
  return { h, user, inference, deps, at, check };
}

describe('real-time Pidgy checks (Cloud)', () => {
  it.each([false, true])('checks Sunday on a selected subscribed calendar, including a feed without free/busy support (%s)', async freeBusyError => {
    const { h, at, check, inference } = await setup();
    h.google.account(ADA).calendars.push({ id: 'subscribed-feed', selected: true, accessRole: 'reader', freeBusyError });
    h.google.addEvent(ADA, { calendarId: 'subscribed-feed', summary: 'Hackathon', start: at(6, 9), end: at(6, 21) });
    const result = await check('I am free all day on sunday', { recipientEmails: [], subject: '' });
    expect(result).toMatchObject({ status: 'notice', kind: 'calendar_conflict', severity: 'warning', message: 'Your calendar shows busy time on Sunday.', sources: [expect.objectContaining({ url: 'https://calendar.google.com/calendar/?authuser=ada%40work.test' })] });
    expect(inference.checks).toHaveLength(0);
  });
  it.each([{ selected: false }, { selected: true, hidden: true }, { selected: true, deleted: true }])('excludes a deselected, hidden or deleted subscription (%o)', async state => {
    const { h, at, check } = await setup();
    h.google.account(ADA).calendars.push({ id: 'subscribed-feed', accessRole: 'reader', ...state });
    h.google.addEvent(ADA, { calendarId: 'subscribed-feed', summary: 'Hackathon', start: at(6, 9), end: at(6, 21) });
    expect(await check('I am free all day on sunday')).toEqual({ status: 'none' });
  });
  it('keeps a verified conflict but proposes no free time when a selected feed cannot be read', async () => {
    const { h, at, check } = await setup();
    h.google.account(ADA).calendars.push({ id: 'subscribed-feed', selected: true, accessRole: 'reader', freeBusyError: true });
    h.google.failures.push({ pattern: /calendars\/subscribed-feed\/events/, status: 503, remaining: 1 });
    h.google.addEvent(ADA, { summary: 'Meeting', start: at(1, 15), end: at(1, 16) });
    const result = await check("I'm free tomorrow at 3.");
    expect(result).toMatchObject({ status: 'notice', kind: 'calendar_conflict' });
    if (result.status !== 'notice') throw new Error('Expected verified calendar conflict');
    expect(result.suggestedText).toBeUndefined();
    expect(result.message).not.toContain("You're free");
  });
  it('checks the screenshot all-day Sunday claim against evening events with no recipient or subject', async () => {
    const { h, at, check, inference } = await setup();
    h.google.addEvent(ADA, { summary: 'Dinner', start: at(6, 20), end: at(6, 21) });
    const result = await check('I should be free on Sunday all day', { recipientEmails: [], subject: '' });
    expect(result).toMatchObject({ status: 'notice', kind: 'calendar_conflict', severity: 'warning', message: "Your calendar shows busy time on Sunday." });
    expect(inference.checks).toHaveLength(0);
  });
  it('offers an everyday wording edit with no saved memory and rechecks opt-in after inference', async () => {
    const { check, inference, h, user } = await setup();
    const claim = 'I just wanted to ask if you could send the proposal in order to review it before Friday.';
    const text = 'I wanted to ask if you could send the proposal to review it before Friday.';
    inference.judgment = { surface: false, writing: { text, reason: 'concision', confidence: 0.98 } };
    expect(await check(claim, { includeWriting: true, recipientEmails: [] })).toMatchObject({ status: 'notice', kind: 'writing_suggestion', suggestedText: text, sources: [] });
    expect(await check(claim, { includeWriting: false, recipientEmails: [] })).toEqual({ status: 'none' });
    inference.beforeAnswer = async () => { await h.route('preferencesUpdate', user.token, { preferences: { memory: { realtimeComposeChecks: false } } }); };
    expect(await check(claim, { includeWriting: true, recipientEmails: [] })).toEqual({ status: 'none' });
    expect(await check(claim, { includeWriting: true, recipientEmails: [] })).toEqual({ status: 'disabled' });
  });
  it('keeps ordinary writing useful when a common word matches ambiguous contact names, without guessing a person', async () => {
    const { h, check, inference } = await setup({ memory: { realtimeComposeChecks: true, smartComposeCompletion: true } });
    for (const [name, email] of [['Time Smith', 'time1@work.test'], ['Time Jones', 'time2@work.test']]) {
      await deliverAndSync(h, ADA, { from: email!, fromName: name!, to: [ADA], subject: 'Update', body: 'A short update.', at: h.now() });
    }
    inference.judgment = { surface: false, completion: { text: ' review this.', confidence: 0.98, kind: 'writing', proofs: [] } };
    const request = { includeCompletion: true, recipientEmails: [], subject: '' };
    expect(await check('Thanks for taking the time to', request)).toEqual({ status: 'none' });
    expect(inference.checks).toHaveLength(0);
    expect(await check('Thanks for taking the time to', { ...request, includeWriting: true })).toMatchObject({
      status: 'none', completion: { kind: 'writing', text: ' review this.', sources: [] },
    });
    const data = readDataBlock(inference.checks[0]!.messages.at(-1)!.content) as { evidence: unknown[] };
    expect(data.evidence).toEqual([]);
    expect(await check("I haven't heard from Time in months", { ...request, includeWriting: true })).toEqual({ status: 'none' });
    expect(inference.checks).toHaveLength(1);
  });
  it('answers a contextual drafting question from the actual recipient conversation', async () => {
    const { h, check, inference } = await setup();
    await deliverAndSync(h, ADA, { from: ALEX, to: [ADA], subject: 'Workshop fee', body: 'Confirming the workshop fee is $450, as we agreed on the call.', at: h.now() });
    inference.judgment = request => {
      const data = readDataBlock(request.messages.at(-1)!.content) as { evidence: Array<{ id: string; advisories: string[] }> };
      return { surface: true, kind: 'helpful_context', message: data.evidence[0]!.advisories[0], confidence: 0.98, sourceIds: [data.evidence[0]!.id], suggestedText: null };
    };
    expect(await check('Could you remind me what we agreed on for the workshop proposal?', { includeWriting: true })).toMatchObject({ status: 'notice', kind: 'helpful_context', sources: [expect.objectContaining({ title: 'Workshop fee' })] });
  });
  it('does nothing while the preference is off, and never examines the claim', async () => {
    const { h, check, inference } = await setup({});
    const calls = h.google.calls.length;
    expect(await check("I'm free tomorrow at 3.")).toEqual({ status: 'disabled' });
    expect(h.google.calls.length).toBe(calls);
    expect(inference.checks).toHaveLength(0);
    expect(inference.embeds).toHaveLength(0);
  });

  it('answers none for a mailbox that is not connected or is paused', async () => {
    const { h, user, check } = await setup();
    expect(await check("I'm free tomorrow at 3.", { mailbox: 'someone-else@work.test' })).toEqual({ status: 'none' });
    await h.route('connectionUpdate', user.token, { accountId: user.accountId, paused: true });
    expect(await check("I'm free tomorrow at 3.")).toEqual({ status: 'none' });
  });

  it.each([
    'i dont have any meetings left today', 'My schedule is wide open today.',
    'I have the whole day to myself.', 'My afternoon is completely clear.',
    'Everything on my calendar has wrapped up.', 'I am done for the day.',
    'There is nothing else on my plate today.',
  ])('routes unfamiliar wording through live evidence and one semantic judgment: %s', async claim => {
    const { h, at, check, inference } = await setup();
    const event = h.google.addEvent(ADA, { summary: 'Meeting with Alex', start: at(0, 14), end: at(0, 14, 30), attendees: [ADA, ALEX] });
    inference.judgment = request => {
      const data = readDataBlock(request.messages.at(-1)!.content) as { sentence: string; evidence: Array<{ id: string; advisories: string[] }> };
      expect(data.sentence).toBe(claim);
      expect(data.evidence[0]!.advisories[0]).toBe('You have Meeting with Alex from 2–2:30 PM today.');
      return { surface: true, kind: 'calendar_conflict', message: data.evidence[0]!.advisories[0], confidence: 0.98, sourceIds: [data.evidence[0]!.id], suggestedText: null, highlightText: null };
    };
    const result = await check(claim, { recipientEmails: [], subject: '' });
    expect(result).toMatchObject({ status: 'notice', kind: 'calendar_conflict', severity: 'warning', message: 'You have Meeting with Alex from 2–2:30 PM today.', sources: [expect.objectContaining({ id: `live-event:${event.id}` })] });
    expect(result).not.toHaveProperty('suggestedText');
    expect(inference.checks).toHaveLength(1);
  });

  it.each(['i dont have any meetings left today', 'I have nothing today.'])('only presents what semantic judgment approves, with no notice forced by wording: %s', async claim => {
    const { h, at, check, inference } = await setup();
    h.google.addEvent(ADA, { summary: 'Meeting with Alex', start: at(0, 12), end: at(0, 13) });
    expect(await check(claim, { recipientEmails: [] })).toEqual({ status: 'none' });
    expect(inference.checks).toHaveLength(1);
    const data = readDataBlock(inference.checks[0]!.messages.at(-1)!.content) as { evidence: unknown[] };
    expect(data.evidence).toHaveLength(1);
  });

  it('excludes ended and wrong-day events without calling the judgment model', async () => {
    const { h, at, check, inference } = await setup();
    h.google.addEvent(ADA, { summary: 'Morning meeting', start: at(0, 8), end: at(0, 9) });
    h.google.addEvent(ADA, { summary: 'Tomorrow meeting', start: at(1, 12), end: at(1, 13) });
    expect(await check('I have no meetings left today.')).toEqual({ status: 'none' });
    expect(inference.checks).toHaveLength(0);
  });

  it('leaves calendar claims unchecked when Google is unavailable or calendar access is absent', async () => {
    const { h, at, check, inference } = await setup();
    h.google.addEvent(ADA, { summary: 'Meeting', start: at(0, 12), end: at(0, 13) });
    h.google.failures.push({ pattern: /\/events$/, status: 503, remaining: 1 });
    expect(await check('I have no meetings today.')).toEqual({ status: 'none' });
    await h.db.system(tx => tx.query("update public.mail_accounts set features = array['mail_read']::text[]"));
    expect(await check('I have no meetings today.')).toEqual({ status: 'none' });
    expect(inference.checks).toHaveLength(0);
  });

  it('rechecks cited live events after judgment and drops changed or cancelled evidence', async () => {
    const { h, at, check, inference } = await setup();
    const event = h.google.addEvent(ADA, { summary: 'Meeting with Alex', start: at(0, 12), end: at(0, 13) });
    inference.judgment = request => {
      const data = readDataBlock(request.messages.at(-1)!.content) as { evidence: Array<{ id: string; advisories: string[] }> };
      event.status = 'cancelled';
      return { surface: true, kind: 'calendar_conflict', message: data.evidence[0]!.advisories[0], confidence: 0.98, sourceIds: ['E1'], suggestedText: null };
    };
    expect(await check('My schedule is wide open today.')).toEqual({ status: 'none' });
    expect(inference.checks).toHaveLength(1);
  });

  it.each(['overlooked_context', 'helpful_context'])('keeps %s notices readable by older clients without changing their proof', async kind => {
    const { h, at, check, inference } = await setup();
    h.google.addEvent(ADA, { summary: 'Meeting with Alex', start: at(0, 12), end: at(0, 13) });
    inference.judgment = request => {
      const data = readDataBlock(request.messages.at(-1)!.content) as { evidence: Array<{ id: string; advisories: string[] }> };
      return { surface: true, kind, message: data.evidence[0]!.advisories[0], confidence: 0.99, sourceIds: ['E1'], suggestedText: null };
    };
    const claim = 'My calendar is completely clear today.';
    const modern = await check(claim);
    expect(modern).toMatchObject({ status: 'notice', kind, severity: 'info' });
    expect(await check(claim, { hint: undefined })).toEqual({ ...modern, kind: 'context' });
  });

  it('surfaces a real calendar conflict with the event, its source and an alternative from the availability engine', async () => {
    const { h, at, check, deps, user, inference } = await setup();
    const event = h.google.addEvent(ADA, { summary: 'Math 52', start: at(1, 14), end: at(1, 16) });
    // Without event detail in the cache the free/busy proof still stands, stated plainly.
    const plain = await check("I'm free tomorrow at 3.");
    expect(plain).toMatchObject({ status: 'notice', kind: 'calendar_conflict', message: expect.stringMatching(/^Your calendar shows you're busy at 3 PM tomorrow\./) });
    await ensureEventCached(deps, user.userId, event.id);
    const result = await check("I'm free tomorrow at 3.");
    expect(result).toMatchObject({
      status: 'notice',
      kind: 'calendar_conflict',
      severity: 'warning',
      // The engine's own pick (it prefers room after back-to-back time), never a model's.
      message: "You have Math 52 from 2–4 PM tomorrow. You're free at 5 PM.",
      suggestedText: "I'm free tomorrow at 5.",
    });
    if (result.status !== 'notice') throw new Error('expected a notice');
    expect(result.confidence).toBeGreaterThanOrEqual(0.9);
    expect(result.sources).toEqual([expect.objectContaining({ id: `event:${event.id}`, kind: 'calendar_event', title: 'Math 52' })]);
    // Deterministic: no chat model, no embedding.
    expect(inference.checks).toHaveLength(0);
    expect(inference.embeds).toHaveLength(0);
  });

  it('stays quiet for a genuinely free time, and for a daypart that still has room', async () => {
    const { h, at, check } = await setup();
    h.google.addEvent(ADA, { summary: 'Math 52', start: at(1, 14), end: at(1, 16) });
    expect(await check("I'm free tomorrow at 10.")).toEqual({ status: 'none' });
    expect(await check("I'm free tomorrow afternoon.")).toEqual({ status: 'none' });
    expect(await check("I'm free Thursday morning.")).toEqual({ status: 'none' });
    h.google.addEvent(ADA, { summary: 'Lab', start: at(1, 12), end: at(1, 14) });
    h.google.addEvent(ADA, { summary: 'Office hours', start: at(1, 16), end: at(1, 17) });
    expect(await check("I'm free tomorrow afternoon.")).toMatchObject({ status: 'notice', message: expect.stringMatching(/^Your calendar is nearly full 12–5 PM tomorrow/) });
  });

  it('reads times in the user’s PigeonBox time zone', async () => {
    const { h, at, check, user } = await setup();
    h.google.addEvent(ADA, { summary: 'Standup', start: at(1, 15), end: at(1, 16) }); // 3 PM New York = noon Los Angeles
    expect((await check('I can meet tomorrow at 3pm.')).status).toBe('notice');
    await h.route('preferencesUpdate', user.token, { preferences: { timeZone: 'America/Los_Angeles' } });
    expect(await check('I can meet tomorrow at 3pm.')).toEqual({ status: 'none' });
    expect(await check('I can meet tomorrow at noon.')).toMatchObject({ status: 'notice' });
  });

  it('does not pretend the calendar is free or busy when it cannot be read', async () => {
    const { h, at, check } = await setup();
    h.google.addEvent(ADA, { summary: 'Math 52', start: at(1, 14), end: at(1, 16) });
    h.google.failures.push({ pattern: /freeBusy/, status: 503, remaining: 1 });
    expect(await check("I'm free tomorrow at 3.")).toEqual({ status: 'none' });
  });

  it('catches a later promise than an open commitment to the same person, from structure alone', async () => {
    const { h, check, inference } = await setup();
    await deliverAndSync(h, ADA, { from: ADA, to: [ALEX], subject: 'Board deck', body: "Hi Alex, I'll send the deck by Wednesday.", at: h.now() });
    // Syncing the sent mail indexes it in the background; the checks below add no embeddings.
    const embeds = inference.embeds.length;
    const result = await check("I'll send the deck Friday.");
    expect(result).toMatchObject({ status: 'notice', kind: 'commitment_conflict', message: expect.stringContaining('You previously told'), suggestedText: "I'll send the deck Wednesday." });
    if (result.status !== 'notice') throw new Error('expected a notice');
    expect(result.sources[0]).toMatchObject({ kind: 'commitment', title: 'Board deck' });
    expect(await check("I'll send the deck Tuesday.")).toEqual({ status: 'none' });
    expect(inference.checks).toHaveLength(0);
    expect(inference.embeds).toHaveLength(embeds);
  });

  it('prefers the newest trusted value: replaced and corrected facts, never superseded or expired ones', async () => {
    const { h, check, user } = await setup();
    const send = (body: string, subject: string) => deliverAndSync(h, ADA, { from: PROFESSOR, to: [ADA], subject, body, at: h.now() });
    await send('Midterm 2 is October 14.', 'Midterm 2 Date');
    await h.advance(60_000);
    await send('Midterm 2 has been moved to October 16.', 'Midterm 2 updated date');
    const about = { recipientEmails: [PROFESSOR] };
    const stale = await check('Midterm 2 is on October 14.', about);
    expect(stale).toMatchObject({ status: 'notice', kind: 'fact_conflict', message: 'The latest Midterm 2 details say October 16.', suggestedText: 'Midterm 2 is on October 16.' });
    if (stale.status !== 'notice') throw new Error('expected a notice');
    expect(stale.sources[0]).toMatchObject({ kind: 'message', title: 'Midterm 2 updated date' });
    // The superseded value is not evidence of anything; the current one is consistent.
    expect(await check('Midterm 2 is on October 16.', about)).toEqual({ status: 'none' });
    // Unrelated topic: nothing.
    expect(await check('The design review is on October 14.', about)).toEqual({ status: 'none' });
    // A user correction wins and is very strong evidence.
    const { memories } = await h.route<{ memories: PersonalMemory[] }>('memoryList', user.token, { query: 'Midterm', limit: 50 });
    const active = memories.find((memory) => memory.status === 'active' && /October 16/.test(memory.text))!;
    await h.route('memoryUpdate', user.token, { memoryId: active.id, text: 'Midterm 2 is October 20.', validUntil: new Date(h.now().getTime() + 2 * 86_400_000).toISOString() });
    expect(await check('Midterm 2 is on October 16.', about)).toMatchObject({ status: 'notice', message: 'The latest Midterm 2 details say October 20.', confidence: 0.95 });
    // Once that correction expires it is not used.
    await h.advance(3 * 86_400_000);
    expect(await check('Midterm 2 is on October 16.', about)).toEqual({ status: 'none' });
  });

  it('asks Luna only with strong anchored evidence, keeps only confident cited answers, and grounds suggestions', async () => {
    const { h, check, inference } = await setup();
    await deliverAndSync(h, ADA, { from: ALEX, to: [ADA], subject: 'Workshop fee', body: 'Confirming the workshop fee is $450, as we agreed on the call.', at: h.now() });
    const claim = 'We already agreed on $500 for the workshop.';
    // No judgment configured: a careful model says nothing.
    expect(await check(claim)).toEqual({ status: 'none' });
    expect(inference.checks).toHaveLength(1);
    const data = readDataBlock(inference.checks[0]!.messages.at(-1)!.content) as { sentence: string; evidence: Array<{ id: string; text: string; advisories: string[] }> };
    expect(data.sentence).toBe(claim);
    expect(data.evidence.length).toBeGreaterThan(0);
    expect(inference.checks[0]!.maxTokens).toBeLessThanOrEqual(220);
    expect(inference.checks[0]!.serviceTier).toBe('standard');
    expect(inference.checks[0]!.reasoningEffort).toBe('none');

    inference.judgment = { surface: true, kind: 'fact_conflict', message: data.evidence[0]!.advisories.find(text => text.includes("$450"))!, confidence: 0.95, sourceIds: ['E1'], suggestedText: 'We already agreed on $450 for the workshop.' };
    const surfaced = await check(claim);
    expect(surfaced).toMatchObject({ status: 'notice', kind: 'fact_conflict', message: data.evidence[0]!.advisories.find(text => text.includes("$450"))!, suggestedText: 'We already agreed on $450 for the workshop.' });
    if (surfaced.status !== 'notice') throw new Error('expected a notice');
    expect(surfaced.sources[0]).toMatchObject({ title: 'Workshop fee' });

    // An invented value in the suggestion drops the suggestion, not the cited notice.
    inference.judgment = { ...inference.judgment, suggestedText: 'We already agreed on $600 for the workshop.' };
    expect(await check(claim)).not.toHaveProperty('suggestedText');
    // Low confidence or unknown sources are successful negative answers.
    for (const judgment of [{ ...inference.judgment, confidence: 0.7 }, { ...inference.judgment, sourceIds: ['E9'] }, { ...inference.judgment, sourceIds: ['E1', 'S1'] }]) {
      inference.judgment = judgment;
      expect(await check(claim)).toEqual({ status: 'none' });
    }
    for (const failure of ['outage', 'timeout'] as const) {
      inference.judgment = failure;
      await expect(check(claim)).rejects.toMatchObject({ status: 503, code: 'provider_unavailable' });
    }
    // Ordinary text with no anchored evidence never reaches the model.
    const before = inference.checks.length;
    expect(await check("I'll send the photos Friday.")).toEqual({ status: 'none' });
    expect(inference.checks).toHaveLength(before);
  });

  it('honors paid-AI limits before Luna and rate-limits checks', async () => {
    const { h, check, inference, user } = await setup();
    await deliverAndSync(h, ADA, { from: ALEX, to: [ADA], subject: 'Workshop fee', body: 'Confirming the workshop fee is $450, as we agreed on the call.', at: h.now() });
    inference.judgment = { surface: true, kind: 'fact_conflict', message: 'Alex confirmed $450 for the workshop.', confidence: 0.95, sourceIds: ['E1'], suggestedText: null };
    await h.store.recordUsage({ userId: user.userId, operation: 'draft', provider: 'mock', model: 'm', status: 'ok', errorCode: null, latencyMs: 1, inputTokens: 1, outputTokens: 1, estimatedCostMicros: 50_000_000, requestId: 'req_budget', createdAt: h.now().toISOString() });
    expect(await check('We already agreed on $500 for the workshop.')).toEqual({ status: 'none' });
    expect(inference.checks).toHaveLength(0);
    for (let i = 0; i < COMPOSE_CHECKS_PER_MINUTE; i += 1) await check('Thanks again.');
    expect(h.logs.filter((entry) => entry.message === 'compose check' && entry.fields?.decision === 'rate_limited').length).toBeGreaterThan(0);
  });

  it('keeps users apart: another account’s calendar, commitments and memories never answer', async () => {
    const a = await setup();
    a.h.google.addEvent(ADA, { summary: 'Math 52', start: a.at(1, 14), end: a.at(1, 16) });
    await deliverAndSync(a.h, ADA, { from: ADA, to: [ALEX], subject: 'Board deck', body: "Hi Alex, I'll send the deck by Wednesday.", at: a.h.now() });
    const bob = await a.h.signIn('bob@other.test');
    a.h.google.addAccount('bob@other.test');
    await a.h.route('preferencesUpdate', bob.accessToken, { preferences: { timeZone: ZONE, memory: { realtimeComposeChecks: true } } });
    await a.h.connect(bob.accessToken, 'bob@other.test', ['mail_read', 'calendar_read']);
    await a.h.drain();
    for (const extra of [{ mailbox: 'bob@other.test' }, { mailbox: ADA }]) {
      expect(await a.check("I'm free tomorrow at 3.", extra, bob.accessToken)).toEqual({ status: 'none' });
      expect(await a.check("I'll send the deck Friday.", extra, bob.accessToken)).toEqual({ status: 'none' });
    }
  });

  it('never stores, queues, logs or learns from the clause, including sensitive text', async () => {
    const { h, check, at, user } = await setup();
    h.google.addEvent(ADA, { summary: 'Math 52', start: at(1, 14), end: at(1, 16) });
    await deliverAndSync(h, ADA, { from: ALEX, to: [ADA], subject: 'Workshop fee', body: 'Confirming the workshop fee is $450, as we agreed on the call.', at: h.now() });
    const memoriesBefore = (await h.route<{ memories: PersonalMemory[] }>('memoryList', user.token, { limit: 50, includeHistory: true })).memories.length;
    const marker = 'Zebrafish4471';
    const claims = [
      `I'm free tomorrow at 3 for ${marker}.`,
      `I'll send the ${marker} deck Friday.`,
      `We already agreed on $500 for the ${marker} workshop.`,
      `I'm free tomorrow at 3 after my therapy appointment ${marker}.`,
      `The deadline is October 10 for my ${marker} prescription.`,
      `I don't think I have any upcoming ${marker} hackathons.`,
      `I can't remember if I submitted ${marker} yet.`,
    ];
    for (const claim of claims) await check(claim);
    expect(await check(claims[3]!)).toEqual({ status: 'none' });
    await h.drain();
    // Every table, including job rows and the pgmq queue.
    const tables = await h.sql<{ schema: string; name: string }>(
      `select table_schema as schema, table_name as name from information_schema.tables where table_schema in ('public', 'app', 'pgmq') and table_type = 'BASE TABLE'`,
    );
    for (const table of tables) {
      const rows = await h.sql<{ row: string }>(`select t::text as row from "${table.schema}"."${table.name}" t`);
      expect(rows.some((row) => row.row.includes(marker)), `${table.schema}.${table.name}`).toBe(false);
    }
    expect(JSON.stringify(h.logs)).not.toContain(marker);
    expect(JSON.stringify(h.logs)).not.toMatch(/therapy|free tomorrow at 3/);
    expect(JSON.stringify(await h.store.usageSummary(user.userId, h.now()))).not.toContain(marker);
    const memories = (await h.route<{ memories: PersonalMemory[] }>('memoryList', user.token, { limit: 50, includeHistory: true })).memories;
    expect(memories).toHaveLength(memoriesBefore);
    expect(JSON.stringify(memories)).not.toMatch(new RegExp(`${marker}|therapy`));
  });
});

describe('compose check decisions', () => {
  const interval = (start: string, end: string, precision: 'point' | 'range' | 'span') => ({ start: new Date(start), end: new Date(end), precision });
  it('needs real overlap for a time and a full daypart for a span', () => {
    const busy = [{ start: '2026-10-06T18:00:00Z', end: '2026-10-06T20:00:00Z' }];
    expect(calendarConflict(interval('2026-10-06T19:00:00Z', '2026-10-06T19:30:00Z', 'point'), busy, 30)).toBe(true);
    expect(calendarConflict(interval('2026-10-06T20:00:00Z', '2026-10-06T20:30:00Z', 'point'), busy, 30)).toBe(false);
    expect(calendarConflict(interval('2026-10-06T19:55:00Z', '2026-10-06T20:25:00Z', 'point'), busy, 30)).toBe(false);
    expect(calendarConflict(interval('2026-10-06T16:00:00Z', '2026-10-06T21:00:00Z', 'span'), busy, 30)).toBe(false);
    expect(calendarConflict(interval('2026-10-06T18:00:00Z', '2026-10-06T20:20:00Z', 'span'), busy, 30)).toBe(true);
  });
  it('drops model answers that are unsure, uncited, cite unknown sources or carry links', () => {
    const evidence = [{ ref: { id: 'thread:1', kind: 'thread' as const, title: 'Fee' }, text: 'The fee is $450.', confidence: 0.9, importance: 0.6, semantic: 0, recipientMatch: true, threadMatch: false, openLoop: false, at: '2026-10-01T00:00:00Z', validUntil: null, durable: false, status: 'active' as const }];
    const base = { surface: true, kind: 'fact_conflict' as const, message: 'The fee is $450.', confidence: 0.95, sourceIds: ['E1'], suggestedText: null };
    const input = { claim: 'We agreed on $500 for the fee.', ids: ['E1'], evidence };
    expect(validateJudgment(base, input)).toMatchObject({ status: 'notice', sources: [{ id: 'thread:1' }] });
    for (const bad of [{ ...base, surface: false }, { ...base, confidence: 0.89 }, { ...base, sourceIds: [] }, { ...base, sourceIds: ['E2'] }, { ...base, message: 'See https://evil.test now' }, { ...base, message: 'ok' }])
      expect(validateJudgment(bad, input)).toEqual({ status: 'none' });
  });
});
