/**
 * Reads what an Ask Pigeon question is filtering on before any search runs.
 *
 * Keyword search alone cannot answer "what emails have I sent recently": every
 * word in it is filler, and "i" prefix-matches nearly every thread. This pulls
 * out the direction (sent or received), the time window and the intent, and
 * leaves only the words worth searching for.
 */

export type AskDirection = 'sent' | 'received';

export type AskIntent =
  /** A plain list of mail, e.g. "what did I send this week". Answered from the index without a model. */
  | 'list'
  /** Threads that still need a reply from the user. */
  | 'needs_reply'
  /** Mail the user sent and is waiting to hear back on. */
  | 'waiting'
  /** Write a new email, e.g. "draft an email to Sam saying I'll be late". */
  | 'compose'
  /** Anything else: search, then let the model read the matches. */
  | 'question';

export type AskQuery = {
  intent: AskIntent;
  direction: AskDirection | null;
  /** Inclusive lower bound, ISO. */
  since: string | null;
  /** Exclusive upper bound, ISO. Only set for closed windows such as "yesterday" or "last week". */
  until: string | null;
  /** Sort newest first and prefer recent threads. */
  recent: boolean;
  /** Words worth searching for, with filler and intent words removed. */
  keywords: string[];
  /** How many threads to show for list answers. */
  limit: number;
};

const STOPWORDS = new Set(
  (
    'a about above after again all am an and any are as at be been before being below between both but by can could ' +
    'did do does doing done down during each few for from further get gets got had has have having he her here hers ' +
    'him his how i if in into is it its just let lets me might more most much must my myself no nor not now of off ' +
    'on once only or other our ours out over own please same she should show so some such tell than that the their ' +
    'them then there these they this those through to too under until up us very was we were what when where which ' +
    'while who whom why will with would you your yours anything something everything thing things any im ive id ' +
    'dont didnt doesnt havent hasnt isnt arent wasnt werent cant couldnt wont shouldnt give list find look see ' +
    'know need needs want wanted anyone someone people person hey hi also again still yet ever'
  ).split(' '),
);

/** Words that describe the question rather than the mail. */
const INTENT_WORDS = new Set(
  (
    'email emails mail mails message messages thread threads conversation conversations inbox inboxes sent send ' +
    'sending wrote write written writing emailed emailing replied reply replies replying respond responded response ' +
    'responses answer answered forwarded forward outgoing outbox incoming received receive receiving recent recently ' +
    'latest newest last past today todays yesterday week weeks weekend month months year days day hours hour ago ' +
    'lately new newer older oldest earlier this previous waiting wait unanswered unread folder'
  ).split(' '),
);

const NUMBER_WORDS: Record<string, number> = {
  one: 1, two: 2, three: 3, four: 4, five: 5, six: 6, seven: 7, eight: 8, nine: 9, ten: 10,
  eleven: 11, twelve: 12, fifteen: 15, twenty: 20, thirty: 30, couple: 2, few: 3, several: 5,
};

const DAY_MS = 86_400_000;

export function tokenizeQuery(text: string): string[] {
  return text
    .toLowerCase()
    .replace(/[’']/g, '')
    .split(/[^\p{L}\p{N}@._+-]+/u)
    .map((word) => word.replace(/^[._+-]+|[._+-]+$/g, ''))
    .filter(Boolean);
}

/** A search term worth matching on: not filler and long enough not to prefix-match everything. */
export function isSearchableTerm(term: string): boolean {
  return term.length > 1 && !STOPWORDS.has(term);
}

export function parseAskQuery(query: string, now: Date = new Date()): AskQuery {
  const text = ` ${query.toLowerCase().replace(/[’']/g, '').replace(/\s+/g, ' ')} `;
  const direction = detectDirection(text);
  const window = detectWindow(text, now);
  const count = detectCount(text);
  const recent = window.since != null || count != null || /\b(recent|recently|latest|newest|lately|last few|last couple)\b/.test(text);
  const keywords = tokenizeQuery(query).filter(
    (word) => isSearchableTerm(word) && !INTENT_WORDS.has(word) && !NUMBER_WORDS[word] && !/^\d+$/.test(word),
  );
  const limit = count ?? 8;

  let intent: AskIntent = 'question';
  if (parseComposeRequest(query)) {
    intent = 'compose';
  } else if (/\b(needs?|needing|owe|have to|must)\b.{0,24}\b(reply|replies|response|respond|answer)\b|\bunanswered\b/.test(text)) {
    intent = 'needs_reply';
  } else if (/\bwaiting (on|for)\b|\b(havent|hasnt|not) (yet )?(replied|responded|gotten back|written back|answered|heard back|opened|read)\b|\bno (reply|response)\b|\bgot back to me\b|\bopened\b|\bopen(ed)? (my|the|it)\b/.test(text)) {
    intent = 'waiting';
  } else if (keywords.length === 0 && (direction != null || recent)) {
    intent = 'list';
  }

  return {
    intent,
    direction: intent === 'waiting' ? 'sent' : direction,
    since: window.since,
    until: window.until,
    recent,
    keywords:
      intent === 'needs_reply' || intent === 'waiting'
        ? keywords.filter((word) => !/^(opened|open|read|heard|back)$/.test(word))
        : intent === 'compose'
          ? keywords.filter((word) => !COMPOSE_WORDS.has(word))
          : keywords,
    limit,
  };
}

export type ComposeRequest = {
  /** Who the email is for, as the user wrote it: a name or an address. Null when the request does not say. */
  recipient: string | null;
};

const POLITE_PREFIX = String.raw`^(?:\s*(?:hey|hi|ok|okay|so|please|pls|can you|could you|would you|will you|go ahead and|help me|i want you to|id like you to|i need you to|i want to|i need to|lets|let's)\b[\s,]*)*`;
const COMPOSE_VERB = new RegExp(
  `${POLITE_PREFIX}(?:draft|write|compose|prepare|start|put together|whip up)(?:\\s+(?:up|out|me))?\\s+(?:(?:an?|the|one|some)\\s+)?(?:(?:quick|short|brief|new|nice|polite|friendly|formal|casual)\\s+)*(?:e-?mail|message|note|mail|reply|response|draft)\\b`,
  'i',
);
/** "email Sam saying…", "write to Sam about…": the verb names the recipient directly. */
const DIRECT_VERB = new RegExp(`${POLITE_PREFIX}(?:e-?mail|message|write to|send (?:an? )?(?:e-?mail|message|note) to)\\s+(?!(?:me|us|from|about|with|of|in|on|to|that|this|thread|threads)\\b)`, 'i');
/** Words that end a recipient and start the content of the email. */
const RECIPIENT_END =
  /\s+(?:saying|say|says|that|about|regarding|re|asking|ask|telling|tell|letting|let|thanking|thank|with|and|inviting|invite|confirming|confirm|following|reminding|remind|explaining|explain|apologi[sz]ing|apologi[sz]e|to|for|on|if|whether|so|because)\b|[,.;:!?"“]|$/i;
const NOT_A_RECIPIENT = /^(?:this|that|these|those|the|a|an|him|her|them|someone|somebody|anyone|everyone|people|my|our|his|their)(?:\s+(?:person|guy|people|one|sender|contact))?$/i;
const COMPOSE_WORDS = new Set('draft drafts compose composing saying say says quick short brief note reply response write'.split(' '));

/**
 * Whether the question asks PigeonBox to write an email rather than find one,
 * and who it is for. "What did I write to Sam" is a question about sent mail,
 * so only requests phrased as an instruction count.
 */
export function parseComposeRequest(query: string): ComposeRequest | null {
  const text = query.replace(/[’]/g, "'").replace(/\s+/g, ' ').trim();
  const verb = text.match(COMPOSE_VERB);
  if (verb) {
    const rest = text.slice(verb[0].length);
    const target = rest.match(/^\s*(?:to|for)\s+(.+)$/i);
    return { recipient: target ? recipientFrom(target[1]!, rest.trimStart().toLowerCase().startsWith('for')) : null };
  }
  const direct = text.match(DIRECT_VERB);
  if (direct) {
    const recipient = recipientFrom(text.slice(direct[0].length), false);
    if (recipient) return { recipient };
  }
  return null;
}

function recipientFrom(rest: string, strict: boolean): string | null {
  const address = rest.match(/^\s*<?([\w.+-]+@[\w-]+(?:\.[\w-]+)+)>?/);
  if (address) return address[1]!;
  const end = rest.search(RECIPIENT_END);
  const candidate = (end >= 0 ? rest.slice(0, end) : rest).trim().replace(/'s$/i, '');
  if (!candidate || candidate.split(/\s+/).length > 5 || NOT_A_RECIPIENT.test(candidate)) return null;
  // "for" also introduces the occasion ("for the meeting"); only trust it before a name.
  if (strict && !/^[A-Z]/.test(candidate)) return null;
  return candidate.replace(/^the\s+/i, '');
}

function detectDirection(text: string): AskDirection | null {
  const sent =
    /\b(i|ive|id|we)\s+(have\s+|had\s+|did\s+|just\s+|recently\s+|already\s+|last\s+)?(sent|send|wrote|write|written|emailed|email|replied|reply|messaged|forwarded|mailed)\b/.test(text) ||
    /\bdid i\b.{0,20}\b(send|write|email|reply|forward)\b/.test(text) ||
    /\b(my|the) sent\b|\bmy\b.{0,20}\bsent (emails?|mail|messages?)\b|\bsent (mail|folder|items|box)\b|\bfrom me\b|\boutgoing\b|\boutbox\b|\bby me\b/.test(text);
  const received =
    /\b(i|ive|we)\s+(have\s+|had\s+|just\s+|recently\s+)?(received|receive|got|gotten)\b/.test(text) ||
    /\b(sent|send|sends|emailed|email|emails|wrote|write|written|replied|forwarded|mailed)\s+(to\s+)?(me|us)\b/.test(text) ||
    /\bin my inbox\b|\bincoming\b|\bto me\b/.test(text);
  if (sent && !received) return 'sent';
  if (received && !sent) return 'received';
  return null;
}

function detectCount(text: string): number | null {
  const match = text.match(/\b(?:last|latest|recent|past|top|first)\s+(\d{1,2}|[a-z]+)\s+(?:sent\s+|received\s+|new\s+)?(?:emails?|messages?|threads?|mails?)\b/);
  if (!match) return null;
  const n = Number(match[1]) || NUMBER_WORDS[match[1]!] || 0;
  return n > 0 ? Math.min(n, 25) : null;
}

function detectWindow(text: string, now: Date): { since: string | null; until: string | null } {
  const startOfDay = new Date(now.getFullYear(), now.getMonth(), now.getDate());
  const iso = (date: Date) => date.toISOString();
  const daysBefore = (days: number) => new Date(startOfDay.getTime() - days * DAY_MS);

  if (/\btoday\b|\bthis morning\b|\btonight\b/.test(text)) return { since: iso(startOfDay), until: null };
  if (/\byesterday\b/.test(text)) return { since: iso(daysBefore(1)), until: iso(startOfDay) };

  const span = text.match(/\b(?:last|past|previous)\s+(\d{1,3}|[a-z]+)\s+(?:of\s+)?(hours?|days?|weeks?|months?)\b|\b(\d{1,3})\s+(days?|weeks?|months?)\s+ago\b/);
  if (span) {
    const raw = span[1] ?? span[3]!;
    const unit = (span[2] ?? span[4])!;
    const n = Number(raw) || NUMBER_WORDS[raw] || 0;
    if (n > 0) {
      const hours = unit.startsWith('hour') ? n : unit.startsWith('day') ? n * 24 : unit.startsWith('week') ? n * 24 * 7 : n * 24 * 30;
      return { since: iso(new Date(now.getTime() - hours * 3_600_000)), until: null };
    }
  }

  // Weeks start on Monday.
  const weekStart = daysBefore((startOfDay.getDay() + 6) % 7);
  if (/\bthis week\b/.test(text)) return { since: iso(weekStart), until: null };
  // "in the last week" is a rolling seven days; "last week" is the previous calendar week.
  if (/\b(in|over|during|within|for) the (last|past) week\b|\bpast week\b/.test(text)) return { since: iso(daysBefore(7)), until: null };
  if (/\blast week\b|\bprevious week\b/.test(text)) return { since: iso(new Date(weekStart.getTime() - 7 * DAY_MS)), until: iso(weekStart) };

  const monthStart = new Date(now.getFullYear(), now.getMonth(), 1);
  if (/\bthis month\b/.test(text)) return { since: iso(monthStart), until: null };
  if (/\blast month\b/.test(text)) return { since: iso(new Date(now.getFullYear(), now.getMonth() - 1, 1)), until: iso(monthStart) };
  if (/\bthis weekend\b|\bover the weekend\b/.test(text)) return { since: iso(daysBefore(((startOfDay.getDay() + 1) % 7) + 1)), until: null };

  return { since: null, until: null };
}

/** Whether an ISO timestamp falls inside the query's window. Undated mail only passes an open window. */
export function inAskWindow(timestamp: string | null | undefined, query: Pick<AskQuery, 'since' | 'until'>): boolean {
  if (!query.since && !query.until) return true;
  const time = timestamp ? Date.parse(timestamp) : NaN;
  if (!Number.isFinite(time)) return false;
  if (query.since && time < Date.parse(query.since)) return false;
  if (query.until && time >= Date.parse(query.until)) return false;
  return true;
}
