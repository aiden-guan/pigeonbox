/**
 * Real-time Pidgy checks: the cheap, deterministic gate that decides whether a
 * clause someone is typing is worth checking against their calendar and Brain.
 *
 * It intentionally errs toward skipping. Ordinary prose returns null and
 * causes no request. The same function runs in the extension (before anything
 * leaves Gmail) and in Cloud (which re-derives the kind instead of trusting
 * the extension's hint). Pure text in, no DOM, no network.
 */

export const COMPOSE_CLAIM_KINDS = ['availability', 'scheduling', 'commitment', 'deadline', 'fact'] as const;
export type ComposeClaimKind = (typeof COMPOSE_CLAIM_KINDS)[number];

/** Upper bound on one checked clause. Mirrors COMPOSE_CHECK_MAX_CLAIM in @pigeonbox/api-contract. */
export const COMPOSE_CLAIM_MAX = 700;

const MONTH = '(?:jan(?:uary)?|feb(?:ruary)?|mar(?:ch)?|apr(?:il)?|may|june?|july?|aug(?:ust)?|sept?(?:ember)?|oct(?:ober)?|nov(?:ember)?|dec(?:ember)?)';
// Full weekday names (plus "tues"/"thurs"/"weds"): "sat", "sun" and "mon" are ordinary words too often.
const WEEKDAY = '(?:monday|tuesday|tues|wednesday|weds|thursday|thurs|friday|saturday|sunday)';
const DAY_REF = new RegExp(
  `\\b(?:today|tonight|tomorrow|tmrw|this (?:week|weekend)|next week|(?:this |next )?${WEEKDAY}|${MONTH}\\.?\\s+\\d{1,2}(?:st|nd|rd|th)?|\\d{1,2}(?:st|nd|rd|th)?\\s+(?:of\\s+)?${MONTH}|\\d{1,2}/\\d{1,2})\\b`,
  'i',
);
const CLOCK = '\\d{1,2}(?::[0-5]\\d)?\\s*(?:am|pm|a\\.m\\.|p\\.m\\.)';
const TIME_REF = new RegExp(
  `(?:\\b(?:at|@|around|from|between|after|before|until|til)\\s+\\d{1,2}(?::[0-5]\\d)?\\b|\\b${CLOCK}|\\b\\d{1,2}:[0-5]\\d\\b|\\b(?:noon|midday|midnight|morning|afternoon|evening|tonight|lunchtime)\\b)`,
  'i',
);
const DEADLINE_REF = new RegExp(`\\b(?:by|before|no later than|until)\\s+(?:the\\s+)?(?:end of (?:the |this )?(?:day|week|month)|eod|eow|cob|today|tonight|tomorrow|${WEEKDAY}|${MONTH}\\.?\\s+\\d{1,2}|\\d{1,2}/\\d{1,2}|${CLOCK})\\b`, 'i');

const AVAILABILITY = /\b(?:free|available|availability|works?(?:\s+(?:well|great|fine|best))?(?:\s+for\s+(?:me|us))?|work for (?:me|us)|can (?:do|make|meet|talk|chat|hop on)|could (?:do|make|meet)|i'?m (?:around|in|open))\b/i;
/** Words that state availability outright, as opposed to "can do" (which is also how promises start). */
const STATED_AVAILABILITY = /\b(?:free|available|works?(?:\s+(?:well|great|fine|best))?\s+for\s+(?:me|us)|work for (?:me|us))\b|\bworks\b/i;
const PAST = /\b(?:had|was|were|went|met|did|used to)\b/i;
const SCHEDULING = /\b(?:meet|meeting|call|chat|talk|sync|catch up|hop on|zoom|coffee|lunch|dinner|schedule|reschedule|book(?:ed)?|see you)\b/i;
const NEGATED = /\b(?:not|cannot|can'?t|won'?t|unavailable|busy|no longer)\b|n['’]t\b/i;
const PROMISE = /\b(?:i'?ll|i will|i can|i'?m going to|i am going to|we'?ll|we will|you'?ll (?:have|get))\b/i;
const DELIVER = /\b(?:send|share|get|have|finish|deliver|submit|email|forward|follow up|circle back|get back|review|sign|pay|update|write|draft|prepare|wrap up|turn in|hand in|reply|respond|confirm)\b/i;
const DEADLINE = /\b(?:deadline|due(?!\s+to\b)(?:\s+date)?)\b/i;
const FACT = /\b(?:already (?:sent|paid|submitted|signed|replied|emailed|shared|booked|confirmed)|we (?:already )?(?:agreed|decided|settled)|agreed (?:on|to)|(?:the )?meeting is (?:in|at|on)|(?:is|was|has been|got) (?:moved|rescheduled|changed|pushed) to|the deadline is|i'?m supposed to|last time|you said|you mentioned|i told you|as (?:we )?discussed|we'?re meeting|(?:is|are) (?:in|at) (?:room|building|the [a-z]+ hall)|located (?:in|at)|the (?:price|cost|rate|budget|fee|total) (?:is|was|will be))\b/i;
/** "Midterm 2 is on October 14", "The interview was moved to Room 4": a named event and where or when it is. */
const EVENT_FACT = /\b(?:exam|midterm|final|quiz|class|lecture|section|meeting|interview|review|appointment|presentation|demo|offsite|session|office hours|party|dinner)s?\b(?:\s+[\w#-]+){0,3}\s+(?:is|are|was|will be|has been|have been|got)\s+(?:now\s+)?(?:on|at|in|moved|rescheduled|changed|pushed)\b/i;
/** Something concrete a fact claim can be compared on: a number or a proper name mid-sentence (a day counts too). */
const ANCHOR = /\d|\s[A-Z][a-z]+/;
/** Still being typed: "I'm free tomorrow at". */
const DANGLING = /\b(?:at|on|by|around|from|between|before|after|until|to|the|is|in|and|or|a|an|of|for|with)\s*$/i;
const ABBREVIATIONS = /\b(?:a\.m|p\.m|e\.g|i\.e|etc|dr|mr|mrs|ms|prof|vs|approx|jr|sr)$/i;

/** Normalized form used for comparing and caching clauses: case, quotes, spacing and edge punctuation do not matter. */
export function normalizeClaim(text: string): string {
  return text
    .normalize('NFKC')
    .replace(/[‘’]/g, "'")
    .replace(/[“”]/g, '"')
    .toLowerCase()
    .replace(/\s+/g, ' ')
    .replace(/^[\s,;:–—-]+|[\s.,;:!?–—-]+$/g, '')
    .replace(/^(?:and|but|so|also|ok|okay|yeah|yes|sure)\b[\s,]*/, '')
    .trim();
}

/**
 * Drop everything that is not newly written prose: quoted replies ("On … wrote:"
 * and everything after it), "> " lines, forwarded headers, and a signature after "-- ".
 */
export function stripQuotedHistory(text: string): string {
  const lines = text.replace(/\r\n?/g, '\n').split('\n');
  const out: string[] = [];
  for (const line of lines) {
    const trimmed = line.trim();
    if (/^on\b.{0,240}\bwrote:\s*$/i.test(trimmed)) break;
    if (/^-{2,}\s*(?:original message|forwarded message)\s*-{2,}$/i.test(trimmed)) break;
    if (/^(?:from|sent|to|subject):\s/i.test(trimmed) && out.length && /^(?:from|sent):\s/i.test(trimmed)) break;
    if (line === '-- ' || trimmed === '--') break;
    if (/^>/.test(trimmed)) continue;
    out.push(line);
  }
  return out.join('\n');
}

/** Sentences and semicolon clauses of draft text, trimmed, in order. Abbreviations such as "p.m." do not split. */
export function splitComposeClauses(text: string): string[] {
  const clauses: string[] = [];
  for (const block of text.split(/\n+/)) {
    let start = 0;
    const boundary = /[.!?]+(?=\s|$)|;/g;
    let match: RegExpExecArray | null;
    while ((match = boundary.exec(block))) {
      const end = match.index + match[0].length;
      if (match[0] !== ';' && ABBREVIATIONS.test(block.slice(start, match.index + 1).replace(/\.$/, ''))) continue;
      const clause = block.slice(start, match[0] === ';' ? match.index : end).trim();
      if (clause) clauses.push(clause);
      start = end;
    }
    const rest = block.slice(start).trim();
    if (rest) clauses.push(rest);
  }
  return clauses;
}

/** At most `max` characters, cut at a word boundary from the end (the newest words matter most). */
export function boundClaim(text: string, max = COMPOSE_CLAIM_MAX): string {
  const clean = text.replace(/\s+/g, ' ').trim();
  if (clean.length <= max) return clean;
  const tail = clean.slice(clean.length - max);
  const space = tail.indexOf(' ');
  return (space > 0 && space < 40 ? tail.slice(space + 1) : tail).trim();
}

/**
 * Whether a clause is worth checking, and as what. Null for ordinary prose.
 * Every kind needs a concrete anchor (a day, a time, a date, a deadline or a
 * named value); questions about the recipient's own plans without one are skipped.
 */
export function classifyComposeClaim(clause: string): ComposeClaimKind | null {
  const text = clause.replace(/\s+/g, ' ').trim();
  if (text.length < 8 || text.length > COMPOSE_CLAIM_MAX * 2) return null;
  if (!/[a-z]/i.test(text) || DANGLING.test(text.replace(/[.,;:!?]+$/, ''))) return null;
  if (/\bwrote:\s*$/i.test(text) || /^https?:\/\//i.test(text)) return null;
  const day = DAY_REF.test(text);
  const time = TIME_REF.test(text);
  const stated = STATED_AVAILABILITY.test(text);
  // "I can do that by 5pm" is a promise, not availability.
  if (AVAILABILITY.test(text) && (time || (day && stated)) && (stated || !DEADLINE_REF.test(text))) {
    // "I can't do 3" / "I'm busy then" / "I was free": none of these can contradict a calendar.
    return NEGATED.test(text) || PAST.test(text) ? null : 'availability';
  }
  if (SCHEDULING.test(text) && time && !NEGATED.test(text) && !PAST.test(text)) return 'scheduling';
  if (PROMISE.test(text) && DELIVER.test(text) && (day || DEADLINE_REF.test(text))) return 'commitment';
  if (DEADLINE.test(text) && (day || DEADLINE_REF.test(text) || /\d/.test(text))) return 'deadline';
  if ((FACT.test(text) || EVENT_FACT.test(text)) && (ANCHOR.test(text) || day)) return 'fact';
  return null;
}
