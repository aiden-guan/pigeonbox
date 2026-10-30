import { findPlaceholders, placeholderToken, type Placeholder, type PlaceholderKind } from '@pigeonbox/shared';

/**
 * Placeholder protection. After a model writes a draft, every date, time,
 * price, number with units, phone number, link, email address and street
 * address in it must appear in the context PigeonBox gave the model (the
 * thread, retrieved sources, the user's own profile). Anything unsupported is
 * replaced with an explicit placeholder such as [CONFIRM PRICE] or
 * [DATE NEEDED], so the user sees what to fill in instead of a plausible
 * invention. Source markers like [S1] are stripped from the body.
 */

type Detector = { kind: PlaceholderKind; mode: 'needed' | 'confirm'; pattern: RegExp; normalize: (match: string) => string[] };

const MONTHS = ['jan', 'feb', 'mar', 'apr', 'may', 'jun', 'jul', 'aug', 'sep', 'oct', 'nov', 'dec'];
const WEEKDAYS = ['sunday', 'monday', 'tuesday', 'wednesday', 'thursday', 'friday', 'saturday'];

function digitsOnly(value: string): string {
  return value.replace(/[^\d]/g, '');
}

function timeKeys(value: string): string[] {
  const match = value.toLowerCase().match(/(\d{1,2})(?::(\d{2}))?\s*(a\.?m\.?|p\.?m\.?)?/);
  if (!match) return [value.toLowerCase()];
  let hour = Number(match[1]);
  const minute = match[2] ?? '00';
  if (match[3]?.startsWith('p') && hour < 12) hour += 12;
  if (match[3]?.startsWith('a') && hour === 12) hour = 0;
  return [`${hour}:${minute}`];
}

function dateKeys(value: string): string[] {
  const lower = value.toLowerCase();
  const keys: string[] = [];
  const weekday = WEEKDAYS.find((day) => lower.includes(day.slice(0, 3)) && new RegExp(`\\b${day.slice(0, 3)}`).test(lower));
  if (weekday) keys.push(weekday);
  const monthIndex = MONTHS.findIndex((month) => new RegExp(`\\b${month}`).test(lower));
  const day = lower.match(/\b(\d{1,2})(?:st|nd|rd|th)?\b/);
  if (monthIndex >= 0 && day) keys.push(`${monthIndex + 1}/${Number(day[1])}`);
  const numeric = lower.match(/\b(\d{1,2})\/(\d{1,2})(?:\/\d{2,4})?\b/);
  if (numeric) keys.push(`${Number(numeric[1])}/${Number(numeric[2])}`);
  const isoDate = lower.match(/\b\d{4}-(\d{2})-(\d{2})\b/);
  if (isoDate) keys.push(`${Number(isoDate[1])}/${Number(isoDate[2])}`);
  return keys.length ? keys : [lower];
}

const MONTH_WORDS = 'jan(?:uary)?|feb(?:ruary)?|mar(?:ch)?|apr(?:il)?|may|june?|july?|aug(?:ust)?|sept?(?:ember)?|oct(?:ober)?|nov(?:ember)?|dec(?:ember)?';
const DAY_WORDS = 'mon(?:day)?|tue(?:s(?:day)?)?|wed(?:nesday)?|thu(?:r(?:s(?:day)?)?)?|fri(?:day)?|sat(?:urday)?|sun(?:day)?';

const DETECTORS: Detector[] = [
  {
    kind: 'fact',
    mode: 'confirm',
    pattern: /\b(?:chapter|midterm|room|section)\s+\d+(?:[.-]\d+)?\b/gi,
    normalize: (match) => [match.toLowerCase().replace(/\s+/g, ' ')],
  },
  {
    kind: 'amount',
    mode: 'confirm',
    pattern: /(?:[$€£¥]\s?\d[\d,]*(?:\.\d{1,2})?(?:\s?(?:k|m|mm|million|billion|bn))?|\b\d[\d,]*(?:\.\d{1,2})?\s?(?:usd|eur|gbp|dollars|euros|pounds)\b)/gi,
    normalize: (match) => [digitsOnly(match)],
  },
  {
    kind: 'address',
    mode: 'needed',
    pattern: /\b\d{1,5}\s+(?:[A-Z][a-z]+\s+){1,3}(?:Street|St|Avenue|Ave|Road|Rd|Boulevard|Blvd|Lane|Ln|Drive|Dr|Way|Court|Ct|Place|Pl|Square|Sq)\b\.?(?:,?\s+(?:Suite|Ste|Apt|Unit|Floor|#)\s*[\w-]+)?/g,
    normalize: (match) => [match.toLowerCase().replace(/[^a-z0-9]/g, '')],
  },
  { kind: 'link', mode: 'needed', pattern: /\bhttps?:\/\/[^\s)>\]]+/gi, normalize: (match) => [match.toLowerCase().replace(/[/.]+$/, '')] },
  { kind: 'fact', mode: 'confirm', pattern: /\b[A-Za-z0-9._%+-]+@[A-Za-z0-9.-]+\.[A-Za-z]{2,}\b/g, normalize: (match) => [match.toLowerCase()] },
  { kind: 'number', mode: 'needed', pattern: /(?:\+\d{1,3}[\s.-]?)?\(?\d{3}\)?[\s.-]\d{3}[\s.-]\d{4}\b/g, normalize: (match) => [digitsOnly(match).slice(-10)] },
  {
    kind: 'time',
    mode: 'needed',
    pattern: /\b(?:[01]?\d|2[0-3])(?::[0-5]\d)?\s?(?:a\.?m\.?|p\.?m\.?)(?=\W|$)|\b(?:[01]\d|2[0-3]):[0-5]\d\b/gi,
    normalize: timeKeys,
  },
  {
    kind: 'date',
    mode: 'needed',
    pattern: new RegExp(
      `\\b(?:(?:${DAY_WORDS}),?\\s+)?(?:(?:${MONTH_WORDS})\\.?\\s+\\d{1,2}(?:st|nd|rd|th)?|\\d{1,2}(?:st|nd|rd|th)?\\s+(?:of\\s+)?(?:${MONTH_WORDS}))\\b|\\b\\d{4}-\\d{2}-\\d{2}\\b|\\b\\d{1,2}\\/\\d{1,2}(?:\\/\\d{2,4})?\\b|\\b(?:next\\s+)?(?:monday|tuesday|wednesday|thursday|friday|saturday|sunday)\\b`,
      'gi',
    ),
    normalize: dateKeys,
  },
  {
    kind: 'number',
    mode: 'confirm',
    pattern: /\b\d[\d,]*(?:\.\d+)?\s?(?:%|percent|seats?|users?|licen[cs]es?|units?|people|attendees|pages?|copies|hours?|hrs?|days?|weeks?|months?|years?)\b/gi,
    normalize: (match) => [match.toLowerCase().replace(/\s+/g, '').replace(/s$/, '')],
  },
];

/** Normalized keys for everything factual in the context, so draft facts can be checked against it. */
export function buildFactIndex(corpus: string): Set<string> {
  const keys = new Set<string>();
  for (const detector of DETECTORS) {
    for (const match of corpus.matchAll(detector.pattern)) for (const key of detector.normalize(match[0])) keys.add(`${detector.kind}:${key}`);
  }
  // Weekday names and month/day mentions anywhere support the same in the draft.
  const lower = corpus.toLowerCase();
  for (const day of WEEKDAYS) if (lower.includes(day)) keys.add(`date:${day}`);
  return keys;
}

function supported(index: Set<string>, detector: Detector, match: string): boolean {
  const keys = detector.normalize(match);
  if (detector.kind === 'date') return keys.some((key) => index.has(`date:${key}`));
  // "30 minutes"/"3 weeks": accept when the corpus has the same number with the same unit family.
  return keys.every((key) => index.has(`${detector.kind}:${key}`)) || (detector.kind === 'number' && keys.every((key) => index.has(`number:${key.replace(/s$/, '')}`)));
}

export type GroundedDraft = { body: string; edits: number; placeholders: Placeholder[] };

/** Replace unsupported facts with placeholders; merge adjacent placeholders of one kind. */
export function groundDraft(body: string, index: Set<string>): GroundedDraft {
  let text = body.replace(/\s?\[(?:S\d+(?:\s*,\s*S\d+)*)\]/g, '').replace(/\s?【[^】]*】/g, '');
  let edits = 0;
  // Longest, most specific patterns first so "Tuesday, October 6 at 3pm" becomes one date and one time.
  for (const detector of DETECTORS) {
    text = text.replace(detector.pattern, (match) => {
      if (/^\[[A-Z ]+\]$/.test(match)) return match;
      if (supported(index, detector, match)) return match;
      edits += 1;
      return placeholderToken(detector.kind, detector.mode);
    });
  }
  text = text.replace(/(\[[A-Z ]+ NEEDED\])(?:,?\s*(?:at\s+)?\1)+/g, '$1').replace(/(\[DATE NEEDED\]),?\s+(?:at\s+)?(?=\[TIME NEEDED\])/g, '$1 at ');
  return { body: text.trim(), edits, placeholders: findPlaceholders(text) };
}

/** Near-duplicate variants are not real alternatives. */
export function similarity(a: string, b: string): number {
  const words = (value: string) => new Set(value.toLowerCase().match(/[a-z0-9']+/g) ?? []);
  const left = words(a);
  const right = words(b);
  if (!left.size && !right.size) return 1;
  let shared = 0;
  for (const word of left) if (right.has(word)) shared += 1;
  return shared / (left.size + right.size - shared);
}
