/** Semantic draft evals require a real model. Offline mocks cannot validate conversational judgment. */
import { describe, expect, it } from 'vitest';
import { createInferenceBackend } from '../ai/backends.js';
import { strictJsonSchema } from '../ai/json-schema.js';
import { loadConfig } from '../config.js';
import { analysisPrompt, AnalysisOutputSchema, draftPrompt, DraftOutputSchema, type AnalysisInput, type DraftPromptInput } from '../intel/prompts.js';
import { testEnv } from '../testing.js';

const LIVE = process.env.PIGEONBOX_EVAL_LIVE === '1';
const now = '2026-10-08T16:00:00.000Z';
const zone = 'America/Los_Angeles';
const message = (text: string, direction: 'inbound' | 'outbound' = 'inbound') => ({ from: direction === 'outbound' ? 'Ada <ada@work.test>' : 'Jan <jan@client.test>', direction, date: now, text });
const general = { id: 'S2', kind: 'calendar_event', title: 'Your availability · 3 open times', text: 'General calendar openings; the specific time discussed in the thread has not been checked: Friday, Oct 9, 9:00–9:30 AM PDT; Monday, Oct 12, 9:00–9:30 AM PDT; Tuesday, Oct 13, 9:00–9:30 AM PDT. Supporting evidence only.' };
const open = { id: 'S2', kind: 'calendar_event', title: 'Your availability · 1 open time', text: 'Verified opening within the current proposed/requested window: Friday, Oct 9, 1:30–2:00 PM PDT.' };
const busy = { ...open, title: 'Your availability · busy then · 1 other time', text: 'No open time Friday, Oct 9, 1:30–2:00 PM PDT. A calendar event conflicts with that window. Other verified opening, if alternatives are needed: Friday, Oct 9, 2:30–3:00 PM PDT.' };

function backend() {
  const env = Object.fromEntries(Object.entries(process.env).filter(([key]) => key.startsWith('CLOUD_AI_'))) as Record<string, string>;
  if (!env.CLOUD_AI_PROVIDER || env.CLOUD_AI_PROVIDER === 'mock' || !env.CLOUD_AI_API_KEY || !env.CLOUD_AI_BASE_URL || !env.CLOUD_AI_PRIMARY_MODEL)
    throw new Error('Live conversational evals require real CLOUD_AI provider credentials.');
  return createInferenceBackend(loadConfig(testEnv(env)));
}

async function draft(thread: DraftPromptInput['thread'], sources: DraftPromptInput['sources'], instructions: string | null = null, kind: DraftPromptInput['kind'] = 'scheduling') {
  const prompt = draftPrompt({ kind, now, timeZone: zone, owner: { email: 'ada@work.test', name: 'Ada' }, recipients: [{ email: 'jan@client.test', name: 'Jan' }], subject: 'QA role', thread,
    sources: [{ id: 'S1', kind: 'thread', title: 'QA role', text: 'Current conversation supplied separately.' }, ...sources],
    style: { greeting: null, signoff: null, targetWords: null, formality: 'casual', bullets: false, emoji: false, notes: [] }, instructions, allowVariants: true });
  const reply = await backend().chat({ messages: [{ role: 'system', content: prompt.system }, { role: 'user', content: prompt.user }], reasoningEffort: 'low', serviceTier: 'standard', maxTokens: 1400,
    responseFormat: { type: 'json_schema', name: 'pigeonbox_draft_eval', schema: strictJsonSchema(DraftOutputSchema)! } }, { operation: 'grounded_draft', requestId: 'eval_conversation_draft', signal: AbortSignal.timeout(60_000) });
  return DraftOutputSchema.parse(JSON.parse(reply.text));
}

describe.skipIf(!LIVE)('live conversational judgment in drafts', () => {
  it.each(['scheduling', 'reply'] as const)('acknowledges a proposal inside the owner’s stated availability without unsolicited fallback options (%s)', async (kind) => {
    const output = await draft([message('I am free today from 1 to 3pm to chat about the QA role.', 'outbound'), message("Sounds good, let's shoot for 1:30pm if that works for you!\nCheers,\nJan")], [general], null, kind);
    expect(output.variants).toHaveLength(1);
    const body = output.variants[0]!.body;
    expect(body).toMatch(/1:30|half past (?:one|1)/i);
    expect(body).not.toMatch(/no longer|if .*doesn.t work|also free|other times|which (?:one|time) works|9:00|UTC|Oct 1[23]/i);
  }, 65_000);

  it('accepts a verified proposal without inventing a reason to reschedule', async () => {
    const output = await draft([message('Let’s aim for tomorrow at 1:30pm, if you can make it.')], [open]);
    expect(output.variants).toHaveLength(1);
    expect(output.variants[0]!.body).toMatch(/1:30/);
    expect(output.variants[0]!.body).not.toMatch(/no longer|also free|which (?:one|time) works|UTC/i);
  }, 65_000);

  it('offers an actual alternative when the proposed time conflicts', async () => {
    const output = await draft([message('Can we talk tomorrow at 1:30pm?')], [busy]);
    expect(output.variants[0]!.body).toMatch(/2:30/);
    expect(output.variants[0]!.body).not.toMatch(/1:30 (?:works|is (?:good|fine|perfect))/i);
  }, 65_000);

  it('asks for a missing day rather than treating generic openings as proof the proposed time is unavailable', async () => {
    const output = await draft([message("Let's shoot for 1:30pm if that works for you.")], [general]);
    expect(output.variants[0]!.body).toMatch(/(?:what|which) (?:day|date)|\[DATE NEEDED\]/i);
    expect(output.variants[0]!.body).not.toMatch(/no longer|also free|9:00|UTC/i);
  }, 65_000);

  it('includes backup options when the owner actually requests them', async () => {
    const output = await draft([message('Can we talk tomorrow at 1:30pm?')], [open, { ...busy, id: 'S3', text: 'Other verified opening: Friday, Oct 9, 2:30–3:00 PM PDT.' }], 'Confirm 1:30 and also offer 2:30 as a backup.');
    expect(output.variants[0]!.body).toMatch(/1:30/);
    expect(output.variants[0]!.body).toMatch(/2:30/);
  }, 65_000);

  it('resolves the day from earlier messages while attributing the proposal to the latest inbound message', async () => {
    const messages: AnalysisInput['messages'] = [
      { gmailMessageId: 'owner-1', from: 'ada@work.test', fromName: 'Ada', to: ['jan@client.test'], cc: [], date: now, direction: 'outbound', isAuto: false, listUnsubscribe: false, text: 'I am free Friday afternoon, October 9, for a half-hour call.', attachments: [] },
      { gmailMessageId: 'jan-2', from: 'jan@client.test', fromName: 'Jan', to: ['ada@work.test'], cc: [], date: now, direction: 'inbound', isAuto: false, listUnsubscribe: false, text: "Sounds good, let's shoot for 1:30pm if that works for you!", attachments: [] },
    ];
    const prompt = analysisPrompt({ now, timeZone: zone, ownerEmails: ['ada@work.test'], subject: 'QA role', labels: [], defaultMeetingMinutes: 30, messages });
    const reply = await backend().chat({ messages: [{ role: 'system', content: prompt.system }, { role: 'user', content: prompt.user }], reasoningEffort: 'low', serviceTier: 'standard', maxTokens: 1000,
      responseFormat: { type: 'json_schema', name: 'pigeonbox_analysis_eval', schema: strictJsonSchema(AnalysisOutputSchema)! } }, { operation: 'thread_analysis', requestId: 'eval_conversation_time', signal: AbortSignal.timeout(60_000) });
    const analysis = AnalysisOutputSchema.parse(JSON.parse(reply.text));
    expect(analysis.meeting.isScheduling).toBe(true);
    const proposed = analysis.meeting.requestedWindow!;
    expect(proposed).toBeTruthy();
    expect(proposed.messageId).toBe('jan-2');
    expect(new Date(proposed.start).toISOString()).toBe('2026-10-09T20:30:00.000Z');
    expect(new Date(proposed.end).toISOString()).toBe('2026-10-09T21:00:00.000Z');
  }, 65_000);
});
