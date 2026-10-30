import { detectInjection } from '../heuristics.js';
import type { ReadMessage } from '../thread-reader.js';
import type { MemoryCandidate } from './types.js';

// Deterministic deny-list supplements the model. Secrets are never memories,
// even when a model labels them ordinary or a user submits a correction.
const RESTRICTED =
  /\b(?:otp|one[ -]time (?:code|password)|verification code|security code|login code|password|passcode|api[ _-]?key|access[ _-]?token|refresh[ _-]?token|private key|secret key|recovery (?:code|phrase)|social security|ssn|passport|routing number|account number|credit card|diagnosis|medical|therapy|prescription|bank balance|sexual|intimate|legal advice|privileged|attorney.client)\b|-----BEGIN|\b(?:sk|ghp|gho|pbx)_[A-Za-z0-9_-]{12,}/i;
const NOISE = /\b(?:unsubscribe|sale ends|limited.time offer|promo code|newsletter|tracking number|order confirmation|receipt for|invoice attached)\b/i;
const SPECULATION = /\b(?:maybe|might|possibly|i guess|rumou?r|unconfirmed|probably|i think)\b/i;
/** Secrets, health, legal and financial identifiers, or embedded instructions (no noise rules). */
export function sensitiveText(text: string): boolean {
  return RESTRICTED.test(text) || detectInjection(text);
}
export function safeMemoryText(text: string): boolean {
  return !RESTRICTED.test(text) && !detectInjection(text) && !NOISE.test(text);
}
export function eligibleMessage(message: ReadMessage): boolean {
  return !message.isAuto && !message.listUnsubscribe && safeMemoryText(`${message.subject}\n${message.text}`);
}

/**
 * In-progress situations that change quickly unless reconfirmed: "is interviewing
 * with X", "is applying to", "is traveling", "is out sick". They expire after 14
 * days from their source; a later message that confirms them extends that
 * (store.ts confirmation). Durable facts ("attends UC Berkeley") are unaffected.
 */
export const TRANSIENT_STATUS =
  /\b(?:is|are|am|was|currently|now)\s+(?:\w+\s+)?(?:interviewing|applying|job[- ]hunting|looking for (?:a )?(?:job|role|internship)|considering|deciding|negotiating|traveling|travelling|visiting|out of (?:the )?office|on (?:vacation|leave|holiday)|out sick|sick|recovering|moving|relocating|in the process of)\b/i;

/** Storage requires attribution, specificity and a trustworthy entity. */
export function persistenceDecision(
  candidate: MemoryCandidate,
  message: ReadMessage,
  now: Date,
): { accepted: boolean; score: number; validFrom: string; validUntil: string | null } {
  const emails = new Set([message.from, ...message.to, ...message.cc].map((email) => email.toLowerCase()));
  const own = message.direction === 'outbound';
  // A page must be attributable: facts about the owner come from their own words
  // or from a named participant; a person page only for someone on this message.
  const linked =
    candidate.subject.type === 'person'
      ? emails.has(candidate.subject.key.toLowerCase())
      : own || candidate.entities.some((entity) => entity.type === 'email' && emails.has(entity.key.toLowerCase()));
  const score = candidate.importance * candidate.confidence * candidate.usefulness * (linked ? 1 : 0.35);
  const validFrom = candidate.validFrom ?? message.date;
  const temporary =
    candidate.temporary ||
    candidate.kind === 'episodic' ||
    /\b(?:this week|tomorrow|office hours|midterm|exam|meeting|deadline)\b/i.test(candidate.canonicalText) ||
    TRANSIENT_STATUS.test(candidate.canonicalText);
  const fallbackDays = /\b(?:tomorrow|this week|office hours)\b/i.test(candidate.canonicalText) ? 7 : TRANSIENT_STATUS.test(candidate.canonicalText) ? 14 : 30;
  // Expiry is anchored to the source, never to a later retry/backfill.
  const fallbackUntil = Date.parse(message.date) + fallbackDays * 86_400_000;
  const validUntil = temporary
    ? new Date(Math.min(candidate.validUntil ? Date.parse(candidate.validUntil) : fallbackUntil, fallbackUntil)).toISOString()
    : candidate.validUntil;
  const accepted =
    eligibleMessage(message) &&
    safeMemoryText(candidate.canonicalText) &&
    safeMemoryText(candidate.evidence) &&
    candidate.entities.every((entity) => safeMemoryText(entity.key)) &&
    // No email address from outside this message, on any page.
    candidate.entities.every((entity) => entity.type !== 'email' || emails.has(entity.key.toLowerCase())) &&
    candidate.sensitivity === 'ordinary' &&
    candidate.kind !== 'instruction' &&
    // Only the owner, in their own words, can tell Pidgy what they want or prefer.
    (!['preference', 'goal'].includes(candidate.kind) || (own && candidate.subject.type === 'self')) &&
    // update/confirm must name a known fact; add must not.
    (candidate.op === 'add') === (candidate.ref === null) &&
    candidate.confidence >= 0.8 &&
    candidate.importance >= 0.6 &&
    candidate.usefulness >= 0.65 &&
    score >= 0.36 &&
    linked &&
    !SPECULATION.test(candidate.evidence) &&
    !SPECULATION.test(candidate.canonicalText) &&
    message.text.includes(candidate.evidence) &&
    candidate.gmailMessageId === message.gmailMessageId &&
    Date.parse(validFrom) <= now.getTime() &&
    (!validUntil || (Date.parse(validUntil) > now.getTime() && Date.parse(validUntil) > Date.parse(validFrom)));
  return { accepted, score, validFrom, validUntil };
}

/** No fuzzy conflicts: exact subject/attribute scope and an explicit correction. */
export function isExplicitReplacement(candidate: MemoryCandidate): boolean {
  return (
    Boolean(candidate.concept) &&
    candidate.explicitUpdate &&
    /\b(?:moved|rescheduled|changed|instead|correction|no longer|now|updated)\b/i.test(candidate.evidence)
  );
}

/** The numbers, months and weekdays a fact states, normalized ("October" → "oct"). */
function specifics(text: string): string[] {
  return [...(text.toLowerCase().match(/\d+(?:[.:/]\d+)*|\b(?:jan|feb|mar|apr|may|jun|jul|aug|sep|oct|nov|dec)[a-z]*\b|\b(?:mon|tues|wednes|thurs|fri|satur|sun)day\b/g) ?? [])]
    .map((token) => (/^\d/.test(token) ? token : token.slice(0, 3)))
    .sort();
}

/** Digits and month names must match exactly before two facts may merge (Oct 14 vs Oct 16). */
export function sameSpecifics(a: string, b: string): boolean {
  return specifics(a).join(' ') === specifics(b).join(' ');
}

/** Every number and date in `detail` also appears in `fuller` ("Oct 14" is covered by "Oct 14 at 3"). */
export function coversSpecifics(fuller: string, detail: string): boolean {
  const pool = specifics(fuller);
  return specifics(detail).every((token) => {
    const at = pool.indexOf(token);
    if (at < 0) return false;
    pool.splice(at, 1);
    return true;
  });
}

const FILLER = new Set(
  'a an the is are was were be been am to of in on at for and or with as by from i im i\'m me my you your youre you\'re he she they them their his her it its this that these those will would has have had who which also currently'.split(' '),
);
const NEGATION = /\b(?:not|no|never|none|nor|without|cannot|can't|won't|don't|doesn't|didn't|isn't|aren't|wasn't|weren't|hasn't|haven't|no longer)\b/i;

/** Content words, lightly stemmed, so "studies"/"studying" and "UC Berkeley"/"Berkeley" line up. */
function words(text: string): Set<string> {
  return new Set(
    text
      .toLowerCase()
      .replace(/[’']/g, "'")
      .split(/[^\p{L}\p{N}']+/u)
      .filter((word) => word.length > 1 && !FILLER.has(word))
      .map((word) => word.replace(/'s$/, '').replace(/(?:ing|ed|es|s)$/, (end, at) => (at >= 4 ? '' : end)).replace(/(?<=\p{L}{3})i$/u, 'y')),
  );
}

/**
 * Two wordings of the same fact: nearly the same content words, the same polarity
 * and the same numbers and dates. Deterministic, so it needs no model call.
 */
export function sameFactWording(a: string, b: string): boolean {
  if (NEGATION.test(a) !== NEGATION.test(b) || !sameSpecifics(a, b)) return false;
  const x = words(a);
  const y = words(b);
  const shared = [...x].filter((word) => y.has(word)).length;
  return shared / Math.max(1, new Set([...x, ...y]).size) >= 0.75;
}

/**
 * `fuller` says everything `detail` says and more: "Freshman at Berkeley" is
 * absorbed by "Freshman at Berkeley studying data science". Needs three or more
 * content words so short phrases ("likes coffee") never swallow each other.
 */
export function absorbsFact(fuller: string, detail: string): boolean {
  if (NEGATION.test(fuller) !== NEGATION.test(detail) || !coversSpecifics(fuller, detail)) return false;
  const big = words(fuller);
  const small = words(detail);
  if (small.size < 3 || big.size < small.size) return false;
  return [...small].filter((word) => big.has(word)).length / small.size >= 0.9;
}
/** Cosine similarity at or above which a new fact is the same as a known one on that page. */
export const DUPLICATE_SIMILARITY = 0.9;
/** Same-page facts at least this similar are pointed out to the consolidation pass as likely duplicates. */
export const NEAR_DUPLICATE_HINT = 0.8;
