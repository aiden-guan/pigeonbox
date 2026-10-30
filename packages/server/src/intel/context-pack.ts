import type { ContextItem } from './memory/rank.js';
import type { DraftKind, Preferences, SourceRef } from '@pigeonbox/api-contract';
import type { SecretBox } from '../platform/crypto.js';
import type { IntelDeps } from './context.js';
import type { AccountRow } from './google-access.js';
import { RequestedMeetingWindowSchema, type DraftSource, type MeetingContext } from './prompts.js';
import { availability, formatSlot, requestedWindow, windowForConstraints, type Availability } from './scheduling.js';
import { replyRecipients, type ReadThread } from './thread-reader.js';
import { resolveStyle, type ResolvedStyle } from './writing.js';

/**
 * DraftContextPack: everything a draft may rely on, retrieved narrowly and
 * with provenance. Each item becomes a numbered source (S1…) for the model and
 * a source chip in the UI ("Used to prepare this draft"). Nothing outside the
 * pack is available to the model, and the grounding guard checks the draft
 * against exactly this text.
 */

export type PackSource = { ref: SourceRef; promptId: string; text: string };

export type ContextPack = {
  kind: DraftKind;
  owner: { email: string; name: string };
  to: Array<{ email: string; name?: string }>;
  cc: string[];
  subject: string;
  inReplyTo: string | null;
  references: string | null;
  basedOnMessageId: string | null;
  thread: ReadThread;
  sources: PackSource[];
  style: ResolvedStyle;
  availability: Availability | null;
  /** All text the draft may draw facts from. */
  corpus: string;
};

export async function buildContextPack(
  deps: IntelDeps,
  input: {
    userId: string;
    relevantContext: ContextItem[];
    account: AccountRow;
    threadRowId: string;
    thread: ReadThread;
    kind: DraftKind;
    prefs: Preferences;
    meeting: MeetingContext | null;
    box: SecretBox;
  },
): Promise<ContextPack> {
  const { thread, account, prefs } = input;
  const messages = thread.messages;
  const lastInbound = [...messages].reverse().find((message) => message.direction === 'inbound') ?? null;
  const lastOutbound = [...messages].reverse().find((message) => message.direction === 'outbound') ?? null;
  const replyBase = input.kind === 'follow_up' ? lastOutbound ?? messages[messages.length - 1] : lastInbound ?? messages[messages.length - 1];

  const { to, cc } = replyRecipients(thread, account.email, input.kind === 'follow_up' ? 'follow_up' : 'reply');
  const counterparty = to[0]?.email ?? null;

  const sources: PackSource[] = [];
  const add = (ref: SourceRef, text: string) => {
    const promptId = `S${sources.length + 1}`;
    sources.push({ ref, promptId, text: text.slice(0, 1_200) });
  };

  add(
    { id: `thread:${thread.gmailThreadId}`, kind: 'thread', title: thread.subject || '(no subject)', gmailThreadId: thread.gmailThreadId, accountId: account.id, at: replyBase?.date, who: replyBase?.from },
    'The current thread (messages provided separately).',
  );

  // Unified, bounded hybrid retrieval ran before entering this transaction.
  for (const item of input.relevantContext) add(item.ref,item.text);

  // The model can resolve a proposal across messages; free/busy still decides
  // whether it is open. A legacy analysis can use the narrow time parser.
  let slots: Availability | null = null;
  const scheduling = input.kind === 'scheduling' || Boolean(input.meeting?.isScheduling);
  if (scheduling && account.features.includes('calendar_read')) {
    try {
      const durationMinutes = input.meeting?.durationMinutes ?? prefs.calendar.defaultDurationMinutes;
      const resolved = RequestedMeetingWindowSchema.safeParse(input.meeting?.requestedWindow);
      const window = resolved.success ? resolved.data : null;
      const start = window ? new Date(window.start) : null;
      const end = window ? new Date(window.end) : null;
      const currentWindow = window && window.messageId === lastInbound?.gmailMessageId && start! >= deps.now()
        && end!.getTime() - start!.getTime() >= durationMinutes * 60_000
        && end!.getTime() - start!.getTime() <= 24 * 60 * 60_000;
      const asked = currentWindow
        ? { start: start!, end: end!, label: formatSlot(window!, prefs.timeZone) }
        : lastInbound ? requestedWindow(lastInbound.text, deps.now(), prefs, new Date(lastInbound.date)) : null;
      let described = false;
      if (asked) {
        // Every open stretch inside what they asked for, not one per day.
        slots = await availability(deps, account, prefs, { durationMinutes, window: { start: asked.start, end: asked.end }, count: 3, minNoticeMinutes: 30, spreadMinutes: durationMinutes,
          exactStart: asked.end.getTime() - asked.start.getTime() === durationMinutes * 60_000 });
        if (!slots.slots.length) {
          const other = await availability(deps, account, prefs, { durationMinutes, window: windowForConstraints(input.meeting?.constraints ?? [], deps.now(), prefs), count: 3 });
          add(
            { id: `availability:${slots.busyHash}`, kind: 'calendar_event', title: availabilityTitle(0, other.slots.length), accountId: account.id, version: slots.busyHash },
            `There is no open time ${asked.label} (${slots.timeZone}), the current proposed/requested window, under your calendar and scheduling preferences. ${slots.note}${other.slots.length ? ` Other open times, if alternatives are needed: ${other.slots.map((slot) => formatSlot(slot, other.timeZone)).join('; ')}` : ''}`,
          );
          slots = other;
          described = true;
        }
      } else {
        slots = await availability(deps, account, prefs, { durationMinutes, window: windowForConstraints(input.meeting?.constraints ?? [], deps.now(), prefs), count: 3 });
      }
      if (slots.slots.length && !described) {
        add(
          { id: `availability:${slots.busyHash}`, kind: 'calendar_event', title: availabilityTitle(slots.slots.length), accountId: account.id, version: slots.busyHash },
          `${asked ? 'Verified openings within the current proposed/requested window' : 'General calendar openings; the specific time discussed in the thread has not been checked'} (${slots.timeZone}): ${slots.slots.map((slot) => formatSlot(slot, slots!.timeZone)).join('; ')}. ${slots.note} Supporting evidence only; the conversation determines whether to include times in the reply.`,
        );
      }
    } catch (error) {
      deps.log('warn', 'availability unavailable for draft', { userId: input.userId, accountId: account.id, code: (error as { code?: string })?.code ?? 'error' });
    }
  }

  // Attachments are named, not read.
  for (const message of messages.slice(-3)) {
    for (const file of message.attachments.slice(0, 3)) {
      add({ id: `attachment:${message.gmailMessageId}:${file}`, kind: 'document', title: file, gmailThreadId: thread.gmailThreadId, gmailMessageId: message.gmailMessageId, accountId: account.id, at: message.date }, `Attachment in the thread: ${file}`);
    }
  }

  const style = await deps.db.asUser(input.userId, (tx) => resolveStyle(tx, input.userId, {
    recipient: counterparty,
    emailType: input.kind === 'follow_up' ? 'follow_up' : scheduling ? 'scheduling' : 'reply',
    voice: prefs.voice,
  }));
  const ownerName = prefs.voice?.name || account.display_name || '';
  const corpus = [
    thread.subject,
    ...messages.map((message) => `${message.from} ${message.fromName ?? ''} ${message.to.join(' ')} ${message.date} ${message.text}`),
    ...sources.map((source) => source.text),
    ownerName,
    account.email,
    prefs.voice?.about ?? '',
    prefs.voice?.schedulingPreference ?? '',
  ].join('\n');

  return {
    kind: input.kind,
    owner: { email: account.email, name: ownerName },
    to,
    cc,
    subject: thread.subject,
    inReplyTo: replyBase?.rfc822MessageId ?? null,
    references: [replyBase?.references, replyBase?.rfc822MessageId].filter(Boolean).join(' ').slice(0, 2_000) || null,
    basedOnMessageId: messages[messages.length - 1]?.gmailMessageId ?? null,
    thread,
    sources,
    style,
    availability: slots,
    corpus,
  };
}

/**
 * The availability source's title, which the extension shows as the scheduling
 * headline ("2 open times"). Counts come only from the slots actually found.
 */
export function availabilityTitle(open: number, otherwise = 0): string {
  if (open) return `Your availability · ${open} open time${open === 1 ? '' : 's'}`;
  return otherwise ? `Your availability · busy then · ${otherwise} other time${otherwise === 1 ? '' : 's'}` : 'Your availability · busy then';
}

export function promptSources(pack: ContextPack): DraftSource[] {
  return pack.sources.map((source) => ({ id: source.promptId, kind: source.ref.kind, title: source.ref.title, text: source.text }));
}
