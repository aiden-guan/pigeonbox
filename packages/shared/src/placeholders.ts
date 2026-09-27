/**
 * Explicit placeholders for facts a draft must not invent.
 *
 * A draft that does not know a date, price, address or name says so with a
 * structured marker such as `[DATE NEEDED]` or `[CONFIRM PRICE]` instead of a
 * plausible guess. Before sending, PigeonBox finds unresolved markers and warns.
 * The short legacy forms (`[DATE]`, `[AMOUNT]`, …) are still recognized.
 */

export type PlaceholderKind = 'date' | 'time' | 'amount' | 'number' | 'address' | 'name' | 'link' | 'attachment' | 'fact';

export type Placeholder = {
  /** The marker exactly as written, e.g. `[CONFIRM PRICE]`. */
  token: string;
  kind: PlaceholderKind;
  /** `needed`: the fact is missing. `confirm`: a value exists but must be checked. */
  mode: 'needed' | 'confirm';
  /** Human wording, e.g. "Price to confirm". */
  label: string;
  /** Character offset in the text. */
  index: number;
};

const LEGACY = ['DATE', 'TIME', 'LINK', 'NAME', 'ATTACHMENT', 'AMOUNT'] as const;

/** `[X NEEDED]`, `[CONFIRM X]` and the legacy one-word markers. Case-insensitive. */
const PATTERN = /\[(?:([A-Za-z][A-Za-z ]{0,30}?)\s+NEEDED|CONFIRM\s+([A-Za-z][A-Za-z ]{0,30}?)|(DATE|TIME|LINK|NAME|ATTACHMENT|AMOUNT))\]/gi;

const KIND_WORDS: Array<[RegExp, PlaceholderKind]> = [
  [/\b(date|day|deadline)\b/i, 'date'],
  [/\b(time|hour|slot)\b/i, 'time'],
  [/\b(price|amount|cost|fee|budget|rate|total)\b/i, 'amount'],
  [/\b(number|count|quantity|phone)\b/i, 'number'],
  [/\b(address|location|venue|room)\b/i, 'address'],
  [/\b(name|person|contact)\b/i, 'name'],
  [/\b(link|url)\b/i, 'link'],
  [/\b(attachment|file|document)\b/i, 'attachment'],
];

function kindOf(words: string): PlaceholderKind {
  for (const [pattern, kind] of KIND_WORDS) if (pattern.test(words)) return kind;
  return 'fact';
}

function titleCase(words: string): string {
  const lower = words.trim().toLowerCase();
  return lower.charAt(0).toUpperCase() + lower.slice(1);
}

export function findPlaceholders(text: string): Placeholder[] {
  const found: Placeholder[] = [];
  for (const match of text.matchAll(PATTERN)) {
    const [token, needed, confirm, legacy] = match;
    if (needed) {
      found.push({ token, kind: kindOf(needed), mode: 'needed', label: `${titleCase(needed)} needed`, index: match.index ?? 0 });
    } else if (confirm) {
      found.push({ token, kind: kindOf(confirm), mode: 'confirm', label: `${titleCase(confirm)} to confirm`, index: match.index ?? 0 });
    } else if (legacy) {
      found.push({ token, kind: kindOf(legacy), mode: 'needed', label: `${titleCase(legacy)} needed`, index: match.index ?? 0 });
    }
  }
  return found;
}

/** Unique marker tokens in order of appearance. Legacy markers are upper-cased. */
export function detectPlaceholders(text: string): string[] {
  const tokens = new Set<string>();
  for (const placeholder of findPlaceholders(text)) {
    const upper = placeholder.token.toUpperCase();
    tokens.add((LEGACY as readonly string[]).includes(upper.slice(1, -1)) ? upper : placeholder.token);
  }
  return [...tokens];
}

export function hasUnresolvedPlaceholders(text: string): boolean {
  PATTERN.lastIndex = 0;
  const found = PATTERN.test(text);
  PATTERN.lastIndex = 0;
  return found;
}

const KIND_TOKEN: Record<PlaceholderKind, string> = {
  date: 'DATE',
  time: 'TIME',
  amount: 'PRICE',
  number: 'NUMBER',
  address: 'ADDRESS',
  name: 'NAME',
  link: 'LINK',
  attachment: 'ATTACHMENT',
  fact: 'DETAIL',
};

/** The canonical marker for a missing or unverified fact. */
export function placeholderToken(kind: PlaceholderKind, mode: 'needed' | 'confirm' = 'needed'): string {
  const word = KIND_TOKEN[kind];
  return mode === 'confirm' ? `[CONFIRM ${word}]` : `[${word} NEEDED]`;
}

/** @deprecated Use `findPlaceholders`. Kept for callers that match the legacy markers directly. */
export const PLACEHOLDER_PATTERN = /\[(DATE|TIME|LINK|NAME|ATTACHMENT|AMOUNT)\]/gi;
