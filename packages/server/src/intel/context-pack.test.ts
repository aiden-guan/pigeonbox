import type { CloudDraft } from '@pigeonbox/api-contract';
import { addCalendarDays, zonedParts, zonedTimeToUtc } from '@pigeonbox/shared';
import { afterEach, describe, expect, it } from 'vitest';
import { MockInferenceBackend, type ChatRequest, type InferenceContext } from '../ai/backends.js';
import { connectedUser, createIntelHarness, type IntelHarness } from '../testing/intel-harness.js';
import { readDataBlock, type AnalysisInput, type DraftPromptInput, type MeetingContext } from './prompts.js';
import { formatSlot } from './scheduling.js';

const OWNER = 'ada@work.test';
const JAN = 'jan@client.test';
const ZONE = 'America/Los_Angeles';
const today = zonedParts(new Date(), ZONE);
const monday = addCalendarDays(today, (8 - today.weekday) % 7 || 7);
const friday = addCalendarDays(monday, 4);
const NOW = zonedTimeToUtc({ ...monday, hour: 9, minute: 0 }, ZONE);
const START = zonedTimeToUtc({ ...friday, hour: 13, minute: 30 }, ZONE).toISOString();
const END = zonedTimeToUtc({ ...friday, hour: 14, minute: 0 }, ZONE).toISOString();
const DAY = new Intl.DateTimeFormat('en-US', { month: 'long', day: 'numeric', timeZone: ZONE }).format(new Date(START));
const SLOT = formatSlot({ start: START, end: END }, ZONE);

/** Controlled model output: these tests verify the context pipeline, not model reasoning. */
class SchedulingAI extends MockInferenceBackend {
  drafts: DraftPromptInput[] = [];
  window: MeetingContext['requestedWindow'] | 'current' = 'current';
  override async chat(request: ChatRequest, context: InferenceContext) {
    const reply = await super.chat(request, context);
    if (context.operation === 'thread_analysis') {
      const input = readDataBlock(request.messages.at(-1)!.content) as AnalysisInput;
      const latest = input.messages.filter((message) => message.direction === 'inbound').at(-1)!;
      const analysis = JSON.parse(reply.text);
      analysis.category = 'RESPOND';
      analysis.needsReply = true;
      analysis.replyExpectedFrom = 'owner';
      analysis.meeting = { isScheduling: true, durationMinutes: 30, constraints: [], requestedWindow: this.window === 'current'
        ? { messageId: latest.gmailMessageId, start: START, end: END } : this.window };
      return { ...reply, text: JSON.stringify(analysis) };
    }
    if (context.operation === 'grounded_draft') this.drafts.push(readDataBlock(request.messages.at(-1)!.content) as DraftPromptInput);
    return reply;
  }
}

const worlds: IntelHarness[] = [];
afterEach(async () => { for (const h of worlds.splice(0)) await h.pg.close(); });

async function world() {
  const ai = new SchedulingAI();
  const h = await createIntelHarness({ inference: ai });
  worlds.push(h);
  const user = await connectedUser(h, OWNER, ['mail_read', 'drafts', 'calendar_read'], { timeZone: 'America/Los_Angeles', autoDrafts: { enabled: false } });
  await h.advance(NOW.getTime() - h.now().getTime());
  const first = h.google.deliver(OWNER, { from: OWNER, to: [JAN], subject: 'QA role',
    body: `Happy to chat about the QA role. I am free Friday afternoon, ${DAY}.`, at: NOW });
  const last = h.google.deliver(OWNER, { from: JAN, fromName: 'Jan', to: [OWNER], subject: 'Re: QA role', threadId: first.threadId,
    body: "Sounds good, let's shoot for 1:30pm if that works for you!\n\nCheers,\nJan", at: new Date(NOW.getTime() + 60_000) });
  const prepare = async () => {
    await h.push(OWNER);
    await h.drain();
    return h.route<{ draft: CloudDraft }>('draftPrepare', user.token, { threadId: first.threadId });
  };
  return { ai, h, user, first, last, prepare };
}

describe('calendar evidence for conversational scheduling drafts', () => {
  it('uses the AI-resolved proposal from earlier context, checks only that window, and persists it for on-demand drafts', async () => {
    const { ai, h, last, prepare } = await world();
    const { draft } = await prepare();
    const [state] = await h.sql<{ meeting_request: MeetingContext }>('select meeting_request from public.thread_states');
    expect(state!.meeting_request.requestedWindow).toEqual({ messageId: last.id, start: START, end: END });
    expect(ai.drafts).toHaveLength(1);
    const input = ai.drafts[0]!;
    expect(input.thread).toHaveLength(2);
    expect(input.thread[0]!.text).toContain(`Friday afternoon, ${DAY}`);
    const calendar = input.sources.filter((source) => source.kind === 'calendar_event');
    expect(calendar).toHaveLength(1);
    expect(calendar[0]!.text).toContain('Verified openings within the current proposed/requested window');
    expect(calendar[0]!.text).toContain(SLOT);
    expect(calendar[0]!.text).not.toMatch(/Monday|Tuesday|9:00 AM|UTC/);
    expect(draft.sources.find((source) => source.kind === 'calendar_event')!.title).toBe('Your availability · 1 open time');
    expect(h.google.account(OWNER).sent).toHaveLength(0);
  });

  it('provides the actual conflict and other verified openings when the proposal is unavailable', async () => {
    const { ai, h, prepare } = await world();
    h.google.addEvent(OWNER, { summary: 'Existing call', start: new Date(START), end: new Date(END) });
    const { draft } = await prepare();
    const calendar = ai.drafts[0]!.sources.find((source) => source.kind === 'calendar_event')!;
    expect(calendar.text).toContain(`no open time ${SLOT}`);
    expect(calendar.text).toContain('Other open times, if alternatives are needed');
    expect(draft.sources.find((source) => source.kind === 'calendar_event')!.title).toMatch(/busy then/);
  });

  it.each([null, { messageId: 'an-older-message', start: START, end: END }, { messageId: 'invalid', start: END, end: START }])(
    'does not pass unresolved or obsolete proposals off as checked: %j', async (window) => {
      const { ai, prepare } = await world();
      ai.window = window;
      await prepare();
      const calendar = ai.drafts[0]!.sources.find((source) => source.kind === 'calendar_event')!;
      expect(calendar.text).toContain('the specific time discussed in the thread has not been checked');
      expect(calendar.text).not.toContain('no open time');
    },
  );
});
