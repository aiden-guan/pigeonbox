import { z } from 'zod';
import type { ComposeCheckResponse, ComposeCompletion } from '@pigeonbox/api-contract';
import { classifyComposeClaim, detectComposeWriting, normalizeClaim } from '@pigeonbox/shared';
import { buildFactIndex, groundDraft } from './grounding.js';
import { safeMemoryText } from './memory/policy.js';

export const WritingJudgmentSchema = z.object({
  text: z.string().min(1).max(700),
  reason: z.enum(['concision', 'grammar', 'clarity']),
  confidence: z.number().min(0).max(1),
});

export const WRITING_INSTRUCTIONS = `Writing assistance is separate from factual evidence. It must preserve the writer's meaning and never assert an unsupported fact.
For completion.kind="writing", offer one short natural ending to an unfinished request or connective/courtesy prose, at most 16 words. Use proofs:[]; no sources prove ordinary wording. Confidence must be >=0.96. Do not add names, numbers, dates, achievements, personal history, statuses, opinions, availability, promises, commitments or an assertion about anyone. Never disguise a missing factual detail as writing assistance. Keep completion:null when the next useful words require evidence that is absent. Preserve the prefix and give only its new suffix. Prefer a relevant grounded continuation when evidence supplies a useful detail.
For a wording edit, writing:null or {text:string,reason:"concision"|"grammar"|"clarity",confidence:number}. Only offer a clearly useful edit, such as removing repetition or wordiness. No cosmetic synonym swapping. Give the complete edited clause. Preserve its facts, uncertainty, negation, question/request, people, tense, and commitments. Reuse its content words; do not introduce a new topic or factual content. Confidence must be >=0.96. A factual correction always takes priority.`;

/** Content-free continuations cannot use the weaker writing path to invent facts. */
export function validateWritingCompletion(text: string, claim: string, confidence: number): ComposeCompletion | undefined {
  if (confidence < 0.96 || !safeMemoryText(text) || text.trim().split(/\s+/).length > 16 ||
      /[<>[\]\r\n\d$€£¥]|https?:|www\.|@/i.test(text)) return;
  // Newly named people/organizations and objective temporal details need proof.
  if (/\b[A-Z][\p{L}]{2,}\b/u.test(text) || /\b(?:today|tomorrow|yesterday|tonight|next|last|monday|tuesday|wednesday|thursday|friday|saturday|sunday|am|pm)\b/i.test(text)) return;
  if (/\b(?:i|we|my|our|he|she|they|their|it)\b.{0,24}\b(?:am|is|are|was|were|have|has|had|will|can|did|made|earned|generated|founded|graduated|worked|live|lived|sent|submitted|paid|signed|booked|confirmed|finished)\b/i.test(text) ||
      /\b(?:i'll|we'll|promise|guarantee|revenue|profit|income|members|subscribers|available|free|attached|already|approved|accepted|signed|paid|sent|received|booked|confirmed|submitted|finished|earned|generated|founded|graduated|worked)\b/i.test(text)) return;
  const connective = text.replace(/\bit (?:is|'s) (?:convenient|possible|helpful|ready)\b/gi, '');
  if (/\b(?:is|are|was|were|has|had|did)\b/i.test(connective)) return;
  const grounded = groundDraft(text, buildFactIndex(claim));
  if (grounded.edits || grounded.placeholders.length) return;
  // No catalog of opening phrases: unfamiliar requests and connective prose
  // are eligible too. An unfinished factual value or biography still needs proof.
  const prefix = normalizeClaim(claim).replace(/\bi was wondering\b/g, '');
  if (classifyComposeClaim(claim) || /\b(?:i|we)\s+(?:used to|have|had|ran|worked|earned|made|founded|graduated|live|lived|was|were)\b|\b(?:my|our)\s+(?:background|experience|revenue|profit|income|role|job|degree)\b|\b(?:i'll|we'll|i will|we will)\b/i.test(prefix) ||
      /\b(?:is|are|was|were|has|have|had|includes|located in|based in)\s*$/i.test(prefix)) return;
  return { text, confidence, kind: 'writing', sources: [] };
}

const FUNCTION_WORDS = new Set('a an the to of for from in on at by as and or but so that this these those it its is are was were be been being i me my we us our you your they them their he she his her could would can may might will should do does did have has had please just really very actually basically simply wanted want wondering wonder if whether order due fact point time purpose'.split(' '));
const tokens = (text: string) => normalizeClaim(text).match(/[\p{L}\p{N}']+/gu) ?? [];
const stance = (text: string) => tokens(text).filter(word => /^(?:not|no|never|don't|doesn't|didn't|can't|cannot|won't|haven't|hasn't|hadn't|might|may|could|will|should|maybe|probably|think|hope|is|are|am|was|were|have|has|had|i'm|we're|it's)$/.test(word)).sort().join('|');

/** Wording edits reuse content and preserve objective values and the writer's stance. */
export function validateWritingJudgment(value: z.infer<typeof WritingJudgmentSchema> | null | undefined, claim: string): ComposeCheckResponse | null {
  if (!value || value.confidence < 0.96 || !detectComposeWriting(claim)) return null;
  const text = value.text.trim();
  if (text === claim || !safeMemoryText(text) || /[<>[\]\r\n]|https?:|www\.|@/i.test(text) || stance(text) !== stance(claim)) return null;
  const original = new Set(tokens(claim));
  if (tokens(text).some(word => !original.has(word) && !FUNCTION_WORDS.has(word))) return null;
  const values = (source: string) => source.match(/[$€£¥]?\d[\d,.:/-]*|\b[A-Z][a-z]+\b/g)?.sort().join('|') ?? '';
  if (values(text) !== values(claim) || /\?$/.test(text) !== /\?$/.test(claim)) return null;
  const grounded = groundDraft(text, buildFactIndex(claim));
  if (grounded.edits || grounded.placeholders.length) return null;
  // A real edit must remove repetition or substantially shorten the wording.
  const repeated = /\b([a-z]{2,})\s+\1\b/i.test(claim);
  if (!repeated && text.length > claim.length * 0.9) return null;
  return { status: 'notice', kind: 'writing_suggestion', severity: 'info',
    message: value.reason === 'grammar' ? 'Remove the repetition.' : value.reason === 'concision' ? 'A shorter way to say this.' : 'A clearer way to say this.',
    confidence: value.confidence, suggestedText: text, sources: [] };
}
