import type { GmailClient, GmailMessage } from '../google/gmail.js';
import { attachmentNames, decodeEncodedWords, headerValue, messageText, parseAddressList, stripQuotedReply, type Address } from '../google/mime.js';
import type { AnalysisInput } from './prompts.js';

/**
 * Just-in-time reading of a thread for one AI operation. Bodies are fetched
 * from Gmail, trimmed to each message's own words, bounded, used, and dropped
 * with the request. Nothing here is persisted.
 */

export const PER_MESSAGE_CHARS = 4_000;
export const THREAD_CHARS = 16_000;

export type ReadMessage = AnalysisInput['messages'][number] & {
  gmailMessageId: string;
  rfc822MessageId: string | null;
  references: string | null;
  subject: string;
  /** Preserve header identities separately from message prose and quoted greetings. */
  toPeople?: Address[];
  ccPeople?: Address[];
  replyTo?: Address[];
};

export type ReadThread = { gmailThreadId: string; subject: string; labels: string[]; messages: ReadMessage[] };

function toReadMessage(message: GmailMessage, owners: Set<string>): ReadMessage | null {
  const labels = message.labelIds ?? [];
  if (labels.includes('DRAFT') || labels.includes('SPAM') || labels.includes('TRASH')) return null;
  const headers = message.payload?.headers;
  const from = parseAddressList(headerValue(headers, 'From'))[0];
  const to = parseAddressList(headerValue(headers, 'To'));
  const cc = parseAddressList(headerValue(headers, 'Cc'));
  const outbound = labels.includes('SENT') || (from ? owners.has(from.email) : false);
  const date = Number(message.internalDate);
  return {
    gmailMessageId: message.id,
    rfc822MessageId: headerValue(headers, 'Message-ID'),
    references: headerValue(headers, 'References'),
    subject: decodeEncodedWords(headerValue(headers, 'Subject') ?? ''),
    from: from?.email ?? '',
    fromName: from?.name ?? null,
    to: to.map((a) => a.email),
    cc: cc.map((a) => a.email),
    toPeople: to,
    ccPeople: cc,
    replyTo: parseAddressList(headerValue(headers, 'Reply-To')),
    date: new Date(Number.isFinite(date) && date > 0 ? date : Date.now()).toISOString(),
    direction: outbound ? 'outbound' : 'inbound',
    isAuto: /^(no-?reply|do-?not-?reply|notifications?|mailer-daemon)/i.test(from?.email.split('@')[0] ?? '') || Boolean(headerValue(headers, 'Auto-Submitted') && headerValue(headers, 'Auto-Submitted') !== 'no'),
    listUnsubscribe: Boolean(headerValue(headers, 'List-Unsubscribe')),
    text: stripQuotedReply(messageText(message.payload)).slice(0, PER_MESSAGE_CHARS),
    attachments: attachmentNames(message.payload).map((file) => file.filename).slice(0, 10),
  };
}

/** Keep the newest messages whole and drop the oldest when the thread is long. */
export function boundThread(messages: ReadMessage[], budget = THREAD_CHARS): ReadMessage[] {
  const kept: ReadMessage[] = [];
  let used = 0;
  for (const message of [...messages].reverse()) {
    if (used + message.text.length > budget && kept.length) break;
    kept.push(message);
    used += message.text.length;
  }
  return kept.reverse();
}

/** Header-backed identities. A person's own newest From name wins over address-book labels. */
export function threadPeople(messages: ReadMessage[]): Address[] {
  const people = new Map<string, Address>();
  const add = (person: Address) => {
    if (!person.email) return;
    const email = person.email.toLowerCase();
    people.set(email, { email, ...(person.name ? { name: person.name } : people.get(email)?.name ? { name: people.get(email)!.name } : {}) });
  };
  for (const message of messages) for (const person of [...(message.toPeople ?? []), ...(message.ccPeople ?? []), ...(message.replyTo ?? [])]) add(person);
  for (const message of messages) add({ email: message.from, ...(message.fromName ? { name: message.fromName } : {}) });
  return [...people.values()];
}

/** Shared by Chat's thread evidence and prepared drafts, so both target the same people. */
export function replyRecipients(thread: ReadThread, ownerEmail: string, kind: 'reply' | 'follow_up' = 'reply'): { to: Address[]; cc: string[] } {
  const owner = ownerEmail.toLowerCase();
  const latest = [...thread.messages].reverse().find((message) => message.direction === (kind === 'follow_up' ? 'outbound' : 'inbound'));
  if (!latest) return { to: [], cc: [] };
  const people = new Map(threadPeople(thread.messages).map((person) => [person.email, person]));
  const targets = kind === 'follow_up' ? latest.to : latest.replyTo?.length ? latest.replyTo.map((person) => person.email) : [latest.from];
  const emails = [...new Set(targets.map((email) => email.toLowerCase()))].filter((email) => email && email !== owner);
  const to = emails.map((email) => people.get(email) ?? { email });
  const cc = [...new Set((kind === 'follow_up' ? latest.cc : [...latest.to, ...latest.cc]).map((email) => email.toLowerCase()))]
    .filter((email) => email && email !== owner && !emails.includes(email)).slice(0, 20);
  return { to, cc };
}

export async function readThread(gmail: GmailClient, gmailThreadId: string, ownerEmails: string[], format: 'full' | 'metadata' = 'full'): Promise<ReadThread> {
  const thread = await gmail.getThread(gmailThreadId, format);
  const owners = new Set(ownerEmails.map((email) => email.toLowerCase()));
  const messages = (thread.messages ?? [])
    .map((message) => toReadMessage(message, owners))
    .filter((message): message is ReadMessage => Boolean(message))
    .sort((a, b) => a.date.localeCompare(b.date));
  const labels = [...new Set((thread.messages ?? []).flatMap((message) => message.labelIds ?? []))];
  return { gmailThreadId, subject: messages[0]?.subject || messages[messages.length - 1]?.subject || '', labels, messages };
}

export async function fingerprintInput(value: unknown): Promise<string> {
  const digest = new Uint8Array(await crypto.subtle.digest('SHA-256', new TextEncoder().encode(JSON.stringify(value))));
  return [...digest].map((byte) => byte.toString(16).padStart(2, '0')).join('');
}
