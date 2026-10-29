import type { z } from 'zod';
import { CompletionJudgmentSchema } from './compose-completion-schema.js';
import type { ComposeCompletion } from '@pigeonbox/api-contract';
import { detectComposeCompletion, normalizeClaim } from '@pigeonbox/shared';
import { buildFactIndex, groundDraft } from './grounding.js';
import { eventInComposeWindow } from './compose-context.js';
import { safeMemoryText } from './memory/policy.js';
import type { ContextItem } from './memory/rank.js';
import { validateWritingCompletion } from './compose-writing.js';

const COMPLETION_STOP = new Set('about after again also been before being both could didnt does doing done from have here into just like make more most much only other over really same send sent should some such than that their them then there these they this those through very want week what when where which while will with would your yours today tomorrow monday tuesday wednesday thursday friday saturday sunday morning afternoon evening tonight thanks'.split(' '));

function topicWords(text: string): Set<string> {
  return new Set((normalizeClaim(text).match(/[\p{L}\p{N}]{3,}/gu) ?? []).filter(word => !COMPLETION_STOP.has(word)));
}

/**
 * Use the same private, live evidence pool as Brain checks, but let useful
 * continuations draw on ordinary learned facts that are trustworthy even when
 * the extractor assigned less than the check-only 0.9 confidence threshold.
 * A same-thread tie is useful context by itself; outside it, require a topic,
 * entity, recipient, or strong semantic tie before letting a source reach AI.
 */
export function selectCompletionEvidence(items: ContextItem[], claim: string, now: Date, zone: string): ContextItem[] {
  const words = topicWords(claim);
  return items.filter(item => {
    if (item.status !== 'active' || item.confidence < 0.8 || (item.validUntil && (!Number.isFinite(Date.parse(item.validUntil)) || Date.parse(item.validUntil) <= now.getTime())) ||
        !Number.isFinite(Date.parse(item.at)) || item.ref.id === 'profile:self' || item.ref.kind === 'contact' ||
        item.fact?.kind === 'instruction' || (['preference', 'goal'].includes(item.fact?.kind ?? '') && !item.fact?.corrected) ||
        !safeMemoryText(`${item.ref.title}\n${item.assertion ?? item.text}`)) return false;
    if (item.calendar && !eventInComposeWindow(item, claim, now, zone)) return false;
    const sourceWords = topicWords(item.assertion ?? item.text);
    const shared = [...words].filter(word => sourceWords.has(word)).length;
    // For a dated statement, the refreshed event window is itself the relevant
    // tie. Calendar evidence is re-read or freshness-checked before returning.
    if (item.calendar) return true;
    if (item.threadMatch) return shared > 0 || item.semantic >= 0.48;
    if ((item.recipientMatch || item.entityMatch) && (shared > 0 || item.semantic >= 0.58)) return true;
    if (item.subject?.type === 'self' && (shared > 0 || item.semantic >= 0.66)) return true;
    return item.semantic >= 0.78 && shared > 0;
  }).sort((a, b) => {
    const score = (item: ContextItem) => Number(item.threadMatch) * 3 + Number(item.entityMatch) * 2 + Number(item.recipientMatch) * 1.5 +
      Number(item.subject?.type === 'self') + item.semantic + Math.min(3, [...words].filter(word => topicWords(item.assertion ?? item.text).has(word)).length) * 0.25;
    return score(b) - score(a);
  }).slice(0, 8);
}

// Unlike digit-only amount normalization, 35k and 35,000 agree while 35 and
// 35k, or dollars and euros, remain distinct. Also catches bare numeric claims.
function numbers(text: string): string[] {
  return [...text.matchAll(/([$€£¥])?\s*\b(\d[\d,]*(?:\.\d+)?)(?:\s*(thousand|million|billion|k|m|bn)\b)?\s*(%|percent|usd|eur|gbp|dollars|euros|pounds)?/gi)].map(m => {
    const multiplier = ({ k: 1e3, thousand: 1e3, m: 1e6, million: 1e6, billion: 1e9, bn: 1e9 } as Record<string, number>)[m[3]?.toLowerCase() ?? ''] ?? 1;
    const unit = m[1] ?? m[4]?.toLowerCase() ?? '';
    const currency = ({ dollars: '$', usd: '$', euros: '€', eur: '€', pounds: '£', gbp: '£', percent: '%' } as Record<string, string>)[unit] ?? unit;
    return `${Number(m[2]!.replace(/,/g, '')) * multiplier}:${currency}`;
  });
}

/** Validate proof quotes, relevance, objective values and freshness after AI. */
export function validateCompletion(value: z.infer<typeof CompletionJudgmentSchema> | null | undefined, input: {
  claim: string; ids: string[]; evidence: ContextItem[]; now: Date; timeZone: string; allowWriting?: boolean;
}): ComposeCompletion | undefined {
  if (!value || value.confidence < 0.9 || !detectComposeCompletion(input.claim)) return;
  let text = value.text.replace(/\s+/g, ' ');
  if (/^[\p{L}\p{N}]/u.test(text)) text = ` ${text}`;
  if (text.length > 240) return;
  if (!text.trim() || !safeMemoryText(text) || /[<>[\]]|https?:|www\.|@/i.test(text) ||
      /\b(?:i(?:'ll| will)|we(?:'ll| will)|i promise|we promise|guarantee)\b/i.test(text)) return;
  if (text.trimStart().toLowerCase().startsWith(input.claim.trim().toLowerCase())) return;
  if (value.kind === 'writing') return input.allowWriting && !value.proofs.length ? validateWritingCompletion(text, input.claim, value.confidence) : undefined;
  if (!value.proofs.length) return;
  const proofs = value.proofs.map(proof => {
    const index = input.ids.indexOf(proof.sourceId);
    const item = input.evidence[index];
    const corpus = item?.assertion ?? item?.text ?? '';
    return item && corpus.includes(proof.quote) && safeMemoryText(proof.quote) ? { item, quote: proof.quote } : null;
  });
  if (proofs.some(proof => !proof)) return;
  const cited = [...new Set(proofs.map(proof => proof!.item))];
  const relevant = selectCompletionEvidence(cited, input.claim, input.now, input.timeZone);
  if (relevant.length !== cited.length) return;
  const corpus = proofs.map(proof => proof!.quote).join('\n');
  // Personal achievements must come from the writer's own memory page. A
  // recipient's biography or a thread summary cannot establish "I made …".
  if (/\b(?:i|my)\b/i.test(text) && !cited.every(item => item.subject?.type === 'self' || Boolean(item.calendar && item.ref.accountId))) return;
  const metrics = text.toLowerCase().match(/\b(?:revenue|profit|income|sales|loss|lost|members|users|subscribers|customers|attendees|seats)\b/g) ?? [];
  if (metrics.some(metric => !new RegExp(`\\b${metric}\\b`, 'i').test(corpus))) return;
  const known = numbers(`${input.claim}\n${corpus}`);
  if (numbers(text).some(number => !known.includes(number) &&
      // A bare shorthand can reuse a sourced currency amount, never a different value.
      !(number.endsWith(':') && known.some(key => key.startsWith(number))))) return;
  // Validate dates, times, links and named objective values using shared draft grounding.
  // Numeric shorthand is checked above because the draft amount index has a
  // stricter representation rule (35k vs 35,000).
  const expandShorthand = (prose: string) => prose.replace(/\b(\d[\d,]*(?:\.\d+)?)\s*(thousand|million|billion|k|m|bn)\b/gi,
    (_, digits: string, unit: string) => String(Number(digits.replace(/,/g, '')) * ({ k: 1e3, thousand: 1e3, m: 1e6, million: 1e6, billion: 1e9, bn: 1e9 } as Record<string, number>)[unit.toLowerCase()]!));
  const grounded = groundDraft(expandShorthand(text), buildFactIndex(expandShorthand(`${input.claim}\n${corpus}`)));
  if (grounded.placeholders.length || grounded.edits) return;
  return { text, confidence: value.confidence, sources: cited.map(item => item.ref).slice(0, 4) };
}

export { CompletionJudgmentSchema } from './compose-completion-schema.js';
