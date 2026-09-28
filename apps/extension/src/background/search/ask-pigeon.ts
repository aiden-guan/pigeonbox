/**
 * Ask Pigeon: answers questions about mail from the local index (and, when AI
 * is on, the selected `AIProvider`). Runs entirely on this computer in Local mode.
 */
import type { AskInput, AskOutput } from '@pigeonbox/ai';
import type { IndexCoverage, MessageRow, SearchDocumentRow, ThreadRow } from '@pigeonbox/mailbox';
import { formatCoverageWarning, inAskWindow, parseAskQuery, parseComposeRequest, type AskQuery, type LexicalSearchIndex } from '@pigeonbox/search';
import { isDeliveredTrackedEmail as isDelivered, normalizeGmailId, type TrackedEmailSummary } from '@pigeonbox/tracking';
import { createOwnerMatcher, isPlaceholderAddress, type OwnerMatcher } from '../owner';

/** One row of a list answer. `threadId` is missing for tracked mail PigeonBox has not indexed. */
export type AskItem = {
  threadId: string | null;
  subject: string;
  /** "to Sam" for mail you sent, the sender's name otherwise. */
  who: string;
  timestamp: string | null;
  /** Open status for tracked mail, e.g. "Opened 2×" or "Not opened". */
  status?: string;
  opened?: boolean;
};

/** A new email for the user to review in Gmail. PigeonBox never sends it. */
export type AskDraft = {
  to: Array<{ email: string; name?: string }>;
  subject: string;
  body: string;
};

export type AskResponse = {
  answer: string;
  citations: Array<{ threadId: string; subject: string }>;
  items?: AskItem[];
  draft?: AskDraft;
  coverageNote: string;
  incompleteIndex: boolean;
};

export type AskPigeonInput = {
  query: string;
  now?: Date;
  threads: ThreadRow[];
  messages: MessageRow[];
  searchDocuments: SearchDocumentRow[];
  lexical: LexicalSearchIndex;
  owner: { email: string; name?: string } | null;
  /** Other addresses the user has been signed in as. */
  ownerAliases?: string[];
  tracked: TrackedEmailSummary[];
  coverage: IndexCoverage;
  /** Null when AI is off; list answers never need it. */
  answerWithModel: ((input: AskInput) => Promise<AskOutput>) | null;
};

type ThreadView = {
  row: ThreadRow;
  messages: MessageRow[];
  sentByMe: boolean;
  receivedFromOthers: boolean;
  /** The time that matters for this question: your last message for sent mail, the last one from someone else for received. */
  timestamp: string;
  tracked: TrackedEmailSummary | null;
  /** Latest message from someone other than you. */
  lastFromOthers: MessageRow | null;
  /** Latest message you sent. */
  lastFromMe: MessageRow | null;
  /** Who sent the newest message, when PigeonBox can tell. */
  lastWord: 'me' | 'them' | 'unknown';
};

const MODEL_CHUNKS = 8;

export async function answerAskPigeon(input: AskPigeonInput): Promise<AskResponse> {
  const now = input.now ?? new Date();
  const query = parseAskQuery(input.query, now);
  const coverageNote = coverageFor(input.coverage, query, input.threads.length);
  const isOwner = ownerMatcher(input);
  const views = buildViews(input, isOwner, query);
  const pool = views.filter((view) => matchesDirection(view, query) && inAskWindow(view.timestamp, query));
  const byRecency = (a: ThreadView, b: ThreadView) => (a.timestamp < b.timestamp ? 1 : a.timestamp > b.timestamp ? -1 : 0);

  if (query.intent === 'compose') return composeDraft(input, query, views, isOwner, coverageNote, now);

  if (query.intent === 'waiting') {
    const items = waitingItems(input.tracked, views, query);
    return listResponse(items, coverageNote, items.length ? waitingHeadline(items) : 'Nothing you sent is waiting on a reply.');
  }

  if (query.intent === 'needs_reply') {
    const matched = narrowByKeywords(
      pool.filter((view) => awaitsMyReply(view, isOwner)),
      query,
      input.lexical,
    ).sort(byRecency);
    const items = matched.slice(0, query.limit).map((view) => threadItem(view));
    return listResponse(items, coverageNote, items.length ? `${countLabel(matched.length, 'thread')} still need${matched.length === 1 ? 's' : ''} a reply from you.` : 'Nothing is waiting on a reply from you.');
  }

  if (query.intent === 'list') {
    const items = pool.sort(byRecency).map((view) => threadItem(view));
    if (query.direction === 'sent') items.push(...untrackedSentItems(input.tracked, views, query));
    items.sort((a, b) => ((a.timestamp || '') < (b.timestamp || '') ? 1 : (a.timestamp || '') > (b.timestamp || '') ? -1 : 0));
    const shown = items.slice(0, query.limit);
    return listResponse(shown, coverageNote, listHeadline(query, shown.length));
  }

  // An open question: search, then let the model read the best matches.
  const filtered = query.direction != null || query.since != null;
  let chosen = query.keywords.length ? searchWithin(pool, query, input.lexical) : [];
  if (chosen.length < 3 && (filtered || !query.keywords.length)) {
    const seen = new Set(chosen.map((view) => view.row.threadId));
    chosen = [...chosen, ...[...pool].sort(byRecency).filter((view) => !seen.has(view.row.threadId))];
  }
  chosen = chosen.slice(0, MODEL_CHUNKS);
  if (!chosen.length) {
    return {
      answer: `No matching threads in the local index. ${coverageNote}`,
      citations: [],
      coverageNote,
      incompleteIndex: true,
    };
  }

  const citations = chosen.map((view) => ({ threadId: view.row.threadId, subject: view.row.subject || '(no subject)' }));
  if (!input.answerWithModel) {
    return {
      answer: 'AI is off, so here are the closest local matches.',
      citations,
      items: chosen.map((view) => threadItem(view)),
      coverageNote,
      incompleteIndex: input.coverage.state !== 'idle' || input.coverage.totalIndexedThreads === 0,
    };
  }

  const docs = new Map(input.searchDocuments.map((doc) => [doc.threadId, doc]));
  const result = await input.answerWithModel({
    query: input.query,
    coverageNote: `${coverageNote} Today is ${formatDate(now.toISOString())}.${input.owner ? ` The mailbox belongs to ${ownerLabel(input.owner)}; "you" in the context means them. Each thread starts with a Status line saying who wrote last.` : ''}`,
    contextChunks: chosen.map((view) => ({
      threadId: view.row.threadId,
      subject: view.row.subject || '(no subject)',
      text: contextText(view, docs.get(view.row.threadId), isOwner),
    })),
  });
  // Keep only citations that point at threads we actually gave the model, once each.
  const known = new Map(citations.map((citation) => [citation.threadId, citation]));
  const cited = uniqueBy(
    (result.citations || []).map((citation) => known.get(citation.threadId)).filter((citation): citation is { threadId: string; subject: string } => Boolean(citation)),
    (citation) => citation.threadId,
  );
  return {
    answer: result.answer.trim(),
    citations: cited.length ? cited : uniqueBy(citations, (citation) => citation.threadId).slice(0, 4),
    coverageNote,
    incompleteIndex: result.incompleteIndex,
  };
}

async function composeDraft(
  input: AskPigeonInput,
  query: AskQuery,
  views: ThreadView[],
  isOwner: OwnerMatcher,
  coverageNote: string,
  now: Date,
): Promise<AskResponse> {
  const hint = parseComposeRequest(input.query)?.recipient ?? null;
  const recipient = hint ? findContact(hint, input, isOwner) : null;
  const base = { citations: [], coverageNote, incompleteIndex: false };
  if (!input.answerWithModel) {
    return { ...base, answer: 'Turn on AI in PigeonBox settings and I can write that email for you.' };
  }

  // Their recent threads first, then anything matching the topic.
  const withThem = recipient
    ? views
        .filter((view) => involves(view, recipient.email))
        .sort((a, b) => (a.row.latestTimestamp < b.row.latestTimestamp ? 1 : -1))
        .slice(0, 4)
    : [];
  const hintWords = new Set((hint || '').toLowerCase().split(/\s+/));
  const topic = { ...query, keywords: query.keywords.filter((word) => !hintWords.has(word)) };
  const seen = new Set(withThem.map((view) => view.row.threadId));
  const related = topic.keywords.length ? searchWithin(views, topic, input.lexical).filter((view) => !seen.has(view.row.threadId)).slice(0, 4) : [];
  const docs = new Map(input.searchDocuments.map((doc) => [doc.threadId, doc]));
  const firstName = input.owner?.name?.trim().split(/\s+/)[0] || '';
  const to = recipient ? (recipient.name ? `${recipient.name} <${recipient.email}>` : recipient.email) : hint || 'not given';

  const result = await input.answerWithModel({
    query: [
      `Write a new email for the mailbox owner to send. The owner asked: "${input.query}"`,
      `Recipient: ${to}.`,
      'Put the whole email in "answer" in this exact shape: the first line is "Subject: " followed by a short subject, then a blank line, then the body.',
      'Write as the owner in the first person, to the recipient. Keep it as short as the request allows.',
      'Use the mailbox context only for facts that help this email, and never invent dates, places, or promises.',
      firstName ? `End with a short sign-off and the name "${firstName}".` : 'End with a short sign-off and no name.',
      'No placeholders in square brackets, no notes, and no text before "Subject:". Leave citations empty.',
    ].join('\n'),
    coverageNote: `Today is ${formatDate(now.toISOString())}.${input.owner ? ` The mailbox belongs to ${ownerLabel(input.owner)}; "you" in the context means the owner.` : ''}`,
    contextChunks: [...withThem, ...related].map((view) => ({
      threadId: view.row.threadId,
      subject: view.row.subject || '(no subject)',
      text: contextText(view, docs.get(view.row.threadId), isOwner),
    })),
  });

  const draft = { to: recipient ? [recipient] : [], ...splitDraft(result.answer, firstName) };
  if (!draft.body) return { ...base, answer: 'The model did not write a draft. Try asking again with a little more detail.' };
  const name = recipient?.name || recipient?.email || hint;
  const missing = hint && !recipient ? ` I couldn't find ${hint}'s address in your mail, so add it in Gmail.` : '';
  return { ...base, draft, answer: `${name ? `Here's a draft to ${name}.` : "Here's a draft."}${missing}` };
}

/** "Subject: …" on the first line, the body after it. Tolerates fences, labels, and a stray "To:" line. */
export function splitDraft(text: string, ownerFirstName: string): { subject: string; body: string } {
  const lines = text
    .replace(/^```[a-z]*\s*|```\s*$/gi, '')
    .replace(/\r\n?/g, '\n')
    .trim()
    .split('\n');
  let subject = '';
  const body: string[] = [];
  for (const line of lines) {
    const label = line.match(/^\s*\**(subject|to|from|cc)\**\s*:\**\s*(.*)$/i);
    if (label && !body.some((kept) => kept.trim())) {
      if (label[1]!.toLowerCase() === 'subject') subject = label[2]!.replace(/\*+$/, '').trim();
      continue;
    }
    if (/^\s*body\s*:\s*$/i.test(line) && !body.some((kept) => kept.trim())) continue;
    body.push(line);
  }
  const cleaned = body
    .join('\n')
    .replace(/\[(?:your|my) (?:full )?name\]/gi, ownerFirstName)
    .replace(/^[ \t]*\[[^\]\n]{1,40}\][ \t]*$/gm, '')
    .replace(/\n{3,}/g, '\n\n')
    .trim();
  return { subject, body: cleaned };
}

type ContactHit = { email: string; name?: string; count: number; latest: string };

/** The person the user named, from everyone PigeonBox has seen them write to or hear from. */
function findContact(hint: string, input: AskPigeonInput, isOwner: OwnerMatcher): { email: string; name?: string } | null {
  if (/^[\w.+-]+@[\w-]+(\.[\w-]+)+$/.test(hint)) return { email: hint.toLowerCase() };
  const words = hint.toLowerCase().split(/\s+/).filter((word) => word.length > 1);
  if (!words.length) return null;
  const hits = new Map<string, ContactHit>();
  const see = (contact: { email?: string; name?: string } | undefined, at: string) => {
    const email = contact?.email?.trim().toLowerCase();
    if (!email || !email.includes('@') || isPlaceholderAddress(email) || isOwner(contact)) return;
    const hit = hits.get(email) ?? { email, count: 0, latest: '' };
    const name = contact?.name?.trim();
    if (name && name !== email && (!hit.name || name.length > hit.name.length)) hit.name = name;
    hit.count += 1;
    if (at > hit.latest) hit.latest = at;
    hits.set(email, hit);
  };
  for (const message of input.messages) {
    for (const contact of [message.sender, ...message.recipients, ...message.cc]) see(contact, message.timestamp);
  }
  for (const row of input.threads) {
    for (const contact of [row.latestSender, ...row.participants]) see(contact, row.latestTimestamp);
  }
  for (const email of input.tracked) {
    for (const value of email.recipients) {
      const address = value.match(/[\w.+-]+@[\w-]+(\.[\w-]+)+/)?.[0];
      const name = value.replace(/<[^>]*>/, '').replace(/"/g, '').trim();
      see(address ? { email: address, name: name && name !== address ? name : undefined } : undefined, email.sentAt || '');
    }
  }
  const matches = (hit: ContactHit) => {
    const nameWords = (hit.name || '').toLowerCase().split(/[\s,.'"()-]+/).filter(Boolean);
    const local = hit.email.split('@')[0]!.toLowerCase();
    return words.every((word) => nameWords.some((part) => part.startsWith(word)) || local.includes(word));
  };
  const best = [...hits.values()]
    .filter(matches)
    .sort((a, b) => Number(Boolean(b.name)) - Number(Boolean(a.name)) || b.count - a.count || (a.latest < b.latest ? 1 : -1))[0];
  return best ? (best.name ? { email: best.email, name: best.name } : { email: best.email }) : null;
}

function involves(view: ThreadView, email: string): boolean {
  const same = (contact: { email?: string } | undefined) => contact?.email?.trim().toLowerCase() === email;
  return (
    view.row.participants.some(same) ||
    same(view.row.latestSender) ||
    view.messages.some((message) => same(message.sender) || message.recipients.some(same) || message.cc.some(same))
  );
}

function buildViews(input: AskPigeonInput, isOwner: OwnerMatcher, query: AskQuery): ThreadView[] {
  const byThread = new Map<string, MessageRow[]>();
  for (const message of input.messages) {
    const list = byThread.get(message.threadId) ?? [];
    list.push(message);
    byThread.set(message.threadId, list);
  }
  const trackedByThread = new Map<string, TrackedEmailSummary>();
  for (const email of input.tracked) {
    const id = normalizeGmailId(email.gmailThreadId);
    if (id && isDelivered(email)) {
      const current = trackedByThread.get(id);
      if (!current || (email.sentAt || '') > (current.sentAt || '')) trackedByThread.set(id, email);
    }
  }

  return input.threads.map((row) => {
    const messages = (byThread.get(row.threadId) ?? []).sort((a, b) => (a.timestamp < b.timestamp ? -1 : a.timestamp > b.timestamp ? 1 : 0));
    const tracked = trackedByThread.get(normalizeGmailId(row.threadId) || row.threadId) ?? null;
    // A sender Gmail did not render is neither yours nor theirs.
    const known = messages.filter((message) => !isPlaceholderAddress(message.sender?.email) || message.sender?.name);
    const mine = known.filter((message) => isOwner(message.sender));
    const theirs = known.filter((message) => !isOwner(message.sender));
    const rowIsMine = Boolean(row.latestSender && (isOwner(row.latestSender) || sentRowLabel(row.latestSender.name)));
    const sentByMe = Boolean(row.seenInSent || row.route === 'sent' || mine.length || tracked || rowIsMine);
    // Row previews only name the latest sender; a thread seen outside Sent was received.
    const receivedFromOthers = known.length ? theirs.length > 0 : row.route !== 'sent' && !row.seenInSent && !rowIsMine;
    const latestMine = mine.at(-1)?.timestamp || tracked?.sentAt || '';
    const latestTheirs = theirs.at(-1)?.timestamp || '';
    const timestamp =
      query.direction === 'sent' ? latestMine || row.latestTimestamp : query.direction === 'received' ? latestTheirs || row.latestTimestamp : row.latestTimestamp;
    const lastFromOthers = theirs.at(-1) ?? null;
    const lastFromMe = mine.at(-1) ?? null;
    return {
      row,
      messages,
      sentByMe,
      receivedFromOthers,
      timestamp: timestamp || '',
      tracked,
      lastFromOthers,
      lastFromMe,
      lastWord: lastWordOf(row, messages, known, tracked, rowIsMine, isOwner),
    };
  });
}

/**
 * Whose turn it is, from the newest message PigeonBox could read. A tracked
 * send newer than that means you answered from somewhere it did not index.
 */
function lastWordOf(
  row: ThreadRow,
  messages: MessageRow[],
  known: MessageRow[],
  tracked: TrackedEmailSummary | null,
  rowIsMine: boolean,
  isOwner: OwnerMatcher,
): ThreadView['lastWord'] {
  const newest = messages.at(-1);
  let word: ThreadView['lastWord'] = 'unknown';
  let at = '';
  if (newest && known.includes(newest)) {
    word = isOwner(newest.sender) ? 'me' : 'them';
    at = newest.timestamp;
  } else if (rowIsMine) {
    word = 'me';
  } else if (!messages.length && row.latestSender && !isPlaceholderAddress(row.latestSender.email)) {
    word = 'them';
    at = row.latestTimestamp;
  }
  // Row times are rounded to the minute, so allow a little slack.
  if (tracked?.sentAt && (word !== 'them' || !at || Date.parse(tracked.sentAt) + 5 * 60_000 >= Date.parse(at))) return 'me';
  return word;
}

/** Gmail's Sent list shows "To: Sam" where the sender would be. */
function sentRowLabel(name: string | undefined): boolean {
  return /^\s*to:?\s/i.test(name || '');
}

const AUTOMATED_SENDER =
  /^(?:no[-_.]?reply|do[-_.]?not[-_.]?reply|donotreply|notifications?|notify|alerts?|mailer-daemon|postmaster|bounces?|calendar-notification|news(?:letter)?s?|digest|updates?)(?:[-_+.][^@]*)?@|@(?:[\w-]+\.)*(?:bounce|mailchimp|sendgrid|mcsv|mailgun|substack)\./i;
const AUTOMATED_SUBJECT =
  /^(?:(?:updated )?invitation|accepted|declined|tentatively accepted|(?:event )?cancel+ed(?: event)?|automatic reply|auto-?reply|out of office|undeliverable|delivery status notification|read:)\b/i;

/**
 * Whether a thread is really waiting on you. The saved classification is a
 * hint from when the thread was first seen; this checks the thread as it is now.
 */
function awaitsMyReply(view: ThreadView, isOwner: OwnerMatcher): boolean {
  const { row } = view;
  if (row.archivedLocally) return false;
  if (row.classification !== 'RESPOND' && !row.requiresResponse) return false;
  // Only list threads where someone else clearly wrote last. A wrong "reply to this" costs more than a miss.
  if (view.lastWord !== 'them') return false;
  if (view.sentByMe && !view.receivedFromOthers) return false;
  const from = view.lastFromOthers?.sender || row.latestSender;
  if (from?.email && AUTOMATED_SENDER.test(from.email)) return false;
  const subject = baseSubject(row.subject);
  if (AUTOMATED_SUBJECT.test(subject)) return false;
  // "[Club] Help us run…" went to a list. It needs you only if it named you directly.
  if (/^\[[^\]]+\]/.test(subject)) {
    const last = view.lastFromOthers;
    if (!last || ![...last.recipients, ...last.cc].some((contact) => isOwner(contact))) return false;
  }
  return true;
}

function baseSubject(subject: string): string {
  let value = (subject || '').trim();
  for (let i = 0; i < 5; i += 1) {
    const next = value.replace(/^(?:re|fwd?|fw|aw|sv)\s*(?:\[\d+\])?\s*:\s*/i, '');
    if (next === value) break;
    value = next;
  }
  return value;
}

function matchesDirection(view: ThreadView, query: AskQuery): boolean {
  if (query.direction === 'sent') return view.sentByMe;
  if (query.direction === 'received') return view.receivedFromOthers;
  return true;
}

function searchWithin(pool: ThreadView[], query: AskQuery, lexical: LexicalSearchIndex): ThreadView[] {
  const byId = new Map(pool.map((view) => [view.row.threadId, view]));
  return uniqueBy(
    lexical
      .search(query.keywords.join(' '), 60)
      .map((hit) => byId.get(hit.threadId))
      .filter((view): view is ThreadView => Boolean(view)),
    (view) => view.row.threadId,
  );
}

function narrowByKeywords(pool: ThreadView[], query: AskQuery, lexical: LexicalSearchIndex): ThreadView[] {
  return query.keywords.length ? searchWithin(pool, query, lexical) : pool;
}

function threadItem(view: ThreadView): AskItem {
  const { row } = view;
  const status = view.tracked ? trackedStatus(view.tracked) : null;
  return {
    threadId: row.threadId,
    subject: row.subject || '(no subject)',
    who: view.sentByMe && !view.receivedFromOthers ? `to ${recipientsOf(view)}` : senderName(view),
    timestamp: view.timestamp || row.latestTimestamp || null,
    ...(status ? { status: status.label, opened: status.opened } : {}),
  };
}

function untrackedSentItems(tracked: TrackedEmailSummary[], views: ThreadView[], query: AskQuery): AskItem[] {
  const indexed = new Set(views.map((view) => normalizeGmailId(view.row.threadId) || view.row.threadId));
  return tracked
    .filter((email) => isDelivered(email) && inAskWindow(email.sentAt, query))
    .filter((email) => !email.gmailThreadId || !indexed.has(normalizeGmailId(email.gmailThreadId) || ''))
    .map((email) => trackedItem(email));
}

function waitingItems(tracked: TrackedEmailSummary[], views: ThreadView[], query: AskQuery): AskItem[] {
  const keywords = query.keywords;
  const matchesKeywords = (text: string) => !keywords.length || keywords.some((word) => text.toLowerCase().includes(word));
  const repliedThreads = new Set(
    views
      .filter((view) => view.tracked?.sentAt && view.lastFromOthers && view.lastFromOthers.timestamp > view.tracked.sentAt)
      .map((view) => normalizeGmailId(view.row.threadId)),
  );
  const fromTracking = tracked
    .filter((email) => isDelivered(email) && inAskWindow(email.sentAt, query))
    .filter((email) => !repliedThreads.has(normalizeGmailId(email.gmailThreadId)))
    .filter((email) => matchesKeywords(`${email.subject} ${email.recipients.join(' ')}`))
    .map((email) => trackedItem(email));
  const trackedIds = new Set(tracked.map((email) => normalizeGmailId(email.gmailThreadId)).filter(Boolean));
  const fromThreads = views
    .filter((view) => view.row.classification === 'WAITING' || view.row.awaitingResponse)
    .filter((view) => !trackedIds.has(normalizeGmailId(view.row.threadId)) && inAskWindow(view.timestamp, query))
    .filter((view) => matchesKeywords(`${view.row.subject} ${view.row.participants.map((p) => `${p.name || ''} ${p.email}`).join(' ')}`))
    .map((view) => threadItem(view));
  return [...fromTracking, ...fromThreads]
    .sort((a, b) => ((a.timestamp || '') < (b.timestamp || '') ? 1 : -1))
    .slice(0, Math.max(query.limit, 12));
}

function trackedItem(email: TrackedEmailSummary): AskItem {
  const status = trackedStatus(email);
  return {
    threadId: email.gmailThreadId,
    subject: email.subject || '(no subject)',
    who: `to ${formatRecipients(email.recipients)}`,
    timestamp: email.sentAt || email.createdAt || null,
    status: status.label,
    opened: status.opened,
  };
}

function trackedStatus(email: TrackedEmailSummary): { label: string; opened: boolean } {
  if (email.openCount > 0) return { label: email.openCount > 1 ? `Opened ${email.openCount}×` : 'Opened', opened: true };
  if (email.clickCount > 0) return { label: 'Clicked', opened: true };
  return { label: 'Not opened', opened: false };
}

function waitingHeadline(items: AskItem[]): string {
  const tracked = items.filter((item) => item.status);
  const unopened = tracked.filter((item) => !item.opened).length;
  const base = `${countLabel(items.length, 'email')} waiting on a reply`;
  if (!tracked.length) return `${base}.`;
  return `${base}. ${unopened === 0 ? 'Every tracked one has been opened.' : `${unopened} not opened yet.`}`;
}

function listHeadline(query: AskQuery, count: number): string {
  const what = query.direction === 'sent' ? 'sent' : query.direction === 'received' ? 'received' : 'indexed';
  const window = query.since || query.until ? ' in that window' : '';
  if (!count) return query.direction === 'sent' ? `PigeonBox has not seen any mail you sent${window} yet.` : `No ${what} mail${window} in the local index.`;
  if (query.direction === 'sent') return `Your ${count === 1 ? 'most recent sent email' : `${count} most recent sent emails`}${window}.`;
  if (query.direction === 'received') return `The ${count === 1 ? 'latest email' : `${count} latest emails`} you received${window}.`;
  return `The ${count === 1 ? 'latest thread' : `${count} latest threads`}${window}.`;
}

function listResponse(items: AskItem[], coverageNote: string, answer: string): AskResponse {
  return {
    answer,
    items,
    citations: uniqueBy(
      items.filter((item): item is AskItem & { threadId: string } => Boolean(item.threadId)).map((item) => ({ threadId: item.threadId, subject: item.subject })),
      (citation) => citation.threadId,
    ),
    coverageNote,
    incompleteIndex: false,
  };
}

function coverageFor(coverage: IndexCoverage, query: AskQuery, threadCount: number): string {
  const base = formatCoverageWarning(coverage);
  if (query.direction === 'sent' && coverage.sentMailCoverage !== 'complete' && threadCount > 0) {
    return `${base} Sent mail is included once PigeonBox has seen it; open your Sent folder in Gmail to add more.`;
  }
  return base;
}

/** The model sees who wrote each message and when, not just the text. */
function contextText(view: ThreadView, doc: SearchDocumentRow | undefined, isOwner: OwnerMatcher): string {
  const person = (contact: { email: string; name?: string } | undefined) => {
    if (!contact?.email) return 'unknown';
    if (isOwner(contact)) return 'you';
    if (isPlaceholderAddress(contact.email)) return contact.name || 'unknown';
    return contact.name && contact.name !== contact.email ? `${contact.name} <${contact.email}>` : contact.email;
  };
  // Small models cannot work out whose turn it is from a message list, so say it first.
  const lines: string[] = [turnLine(view)];
  if (view.tracked) {
    const status = trackedStatus(view.tracked);
    const when = view.tracked.lastOpenedAt ? `, last opened ${formatDate(view.tracked.lastOpenedAt)}` : '';
    lines.push(`Tracking: ${status.label}${when}`);
  }
  if (view.messages.length) {
    const recent = view.messages.slice(-4);
    const budget = Math.floor(1500 / recent.length);
    for (const message of recent) {
      lines.push(
        `From: ${person(message.sender)}`,
        `To: ${message.recipients.map(person).join(', ') || 'unknown'}`,
        `Date: ${message.timestamp ? formatDate(message.timestamp) : 'unknown'}`,
        clip(message.bodyText, budget),
        '',
      );
    }
    return lines.join('\n').trim();
  }
  const sent = view.sentByMe && !view.receivedFromOthers;
  lines.push(
    sent ? 'From: you' : `From: ${person(view.row.latestSender)}`,
    sent ? `To: ${recipientsOf(view)}` : `Participants: ${view.row.participants.map(person).join(', ') || 'unknown'}`,
    `Date: ${view.row.latestTimestamp ? formatDate(view.row.latestTimestamp) : 'unknown'}`,
    clip(doc?.text || view.row.snippet || '', 1200),
  );
  return lines.join('\n');
}

function turnLine(view: ThreadView): string {
  if (view.sentByMe && !view.receivedFromOthers) return 'Status: only you have written; no reply yet.';
  if (view.lastWord === 'me') return 'Status: you sent the latest message; the other side owes the next reply.';
  if (view.lastWord === 'them') return 'Status: the latest message is from someone else.';
  return 'Status: unknown who wrote last.';
}

function ownerMatcher(input: AskPigeonInput): OwnerMatcher {
  return createOwnerMatcher({
    owner: input.owner,
    aliases: [...(input.ownerAliases ?? []), ...input.tracked.map((email) => email.sender || '')],
    contacts: [
      ...input.messages.flatMap((message) => [message.sender, ...message.recipients, ...message.cc]),
      ...input.threads.flatMap((row) => [row.latestSender, ...row.participants]),
    ],
  });
}

function ownerLabel(owner: { email: string; name?: string }): string {
  return owner.name ? `${owner.name} <${owner.email}>` : owner.email;
}

function senderName(view: ThreadView): string {
  for (const contact of [view.lastFromOthers?.sender, view.row.latestSender, ...view.row.participants]) {
    if (contact?.name && !/^\s*me\s*$/i.test(contact.name)) return contact.name;
    if (contact?.email && !isPlaceholderAddress(contact.email)) return contact.email;
  }
  return 'Unknown sender';
}

function recipientsOf(view: ThreadView): string {
  if (view.tracked?.recipients.length) return formatRecipients(view.tracked.recipients);
  const mine = view.lastFromMe?.recipients;
  if (mine?.length) return formatRecipients(mine.map((contact) => contact.name || contact.email));
  // In the Sent folder Gmail shows the recipient where the sender usually is.
  const shown = view.row.latestSender?.name || view.row.latestSender?.email || view.row.participants[0]?.name || view.row.participants[0]?.email;
  return shown ? shown.replace(/^to:\s*/i, '') : 'unknown recipients';
}

function formatRecipients(recipients: string[]): string {
  const names = recipients.map((value) => value.replace(/<[^>]*>/, '').trim() || value).filter(Boolean);
  if (!names.length) return 'unknown recipients';
  if (names.length <= 2) return names.join(' and ');
  return `${names[0]} and ${names.length - 1} others`;
}

function formatDate(iso: string): string {
  const date = new Date(iso);
  if (!Number.isFinite(date.getTime())) return iso;
  return date.toLocaleString('en-US', { weekday: 'short', month: 'short', day: 'numeric', year: 'numeric', hour: 'numeric', minute: '2-digit' });
}

function countLabel(n: number, noun: string): string {
  return `${n} ${noun}${n === 1 ? '' : 's'}`;
}

function clip(text: string, max: number): string {
  const clean = text.replace(/\s+/g, ' ').trim();
  return clean.length > max ? `${clean.slice(0, max - 1)}…` : clean;
}

function uniqueBy<T>(items: T[], key: (item: T) => string): T[] {
  const seen = new Set<string>();
  return items.filter((item) => {
    const id = key(item);
    if (seen.has(id)) return false;
    seen.add(id);
    return true;
  });
}
