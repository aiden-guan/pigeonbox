import { COMPOSE_CLAIM_MAX, classifyComposeClaim, normalizeClaim, stripQuotedHistory } from './compose-claims.js';

/** Routing hints, never truth judgments. Shared by the idle gate and Cloud. */
export const COMPOSE_CONTEXT_HINTS = ['availability', 'scheduling', 'commitment', 'deadline', 'fact', 'existence', 'status', 'uncertainty', 'prior_reference', 'relationship', 'temporal', 'general_context'] as const;
export type ComposeContextHint = (typeof COMPOSE_CONTEXT_HINTS)[number];

const SUBJECTIVE = /\b(?:like|love|hate|want|wish|prefer|hope|feel|appreciate|glad|excited|ugly|beautiful|interesting|exciting|funny|joking|joke|great)\b/;
const HYPOTHETICAL = /^(?:if|suppose|imagine|hypothetically|maybe)\b|\b(?:might|may|could) (?:try|start|plan|attend|go|build)\b/;
const STATUS = /\b(?:sent|submitted|paid|signed|booked|confirmed|received|finished|approved|accepted|replied|decided|agreed|waiting|contract|application|submission)\b/;
const HISTORY = /\b(?:discussed|mentioned|told|agreed|decided|last time|previously|before|never|haven't|hasn't|hadn't)\b/;
const UNCERTAIN = /\b(?:think|pretty sure|as far as i know|can't remember|cannot remember|not sure)\b/;
const FUTURE = /\b(?:upcoming|coming up|scheduled|going on|later|next|today|tonight|tomorrow|weekend|month|week|deadline|due)\b/;
const EXISTENCE = /\b(?:have|has|anything|any|nothing|no|there|going on|coming up)\b/;
const PERSONAL = /\b(?:i|i'm|i've|me|we|we've|we're|us|my|our|you|your|they|their|the meeting|the interview|the deadline)\b/;

/** High recall for checkable personal context, low traffic for social prose. */
export function detectComposeContext(clause: string): ComposeContextHint | null {
  if (clause.length > COMPOSE_CLAIM_MAX * 2 || clause.length < 8) return null;
  if (stripQuotedHistory(clause).trim() !== clause.trim() || /https?:|www\.|[<>]|\?\s*$/i.test(clause)) return null;
  const text = normalizeClaim(clause);
  if (/^(?:who|what|when|where|why|how|can you|could you|would you|do you|are you|let|please)\b/.test(text)) return null;
  if (SUBJECTIVE.test(text) || HYPOTHETICAL.test(text) || /\b(?:at|on|by|to|the|is|in|and|or|of|for|with)\s*$/.test(text)) return null;
  const specific = classifyComposeClaim(clause);
  if (specific) return specific;
  const objectiveState = /\b(?:is|are|was|were|has|have|had|isn't|aren't|wasn't|weren't|hasn't|haven't|hadn't)\b/.test(text);
  if (!PERSONAL.test(text) && !objectiveState) return null;
  const history = HISTORY.test(text);
  if (/\b(?:heard from|talked to|spoken to|emailed|contacted|met)\b/.test(text) && (history || /\b(?:while|months|weeks|recently)\b/.test(text))) return 'relationship';
  if (STATUS.test(text) && (history || UNCERTAIN.test(text) || /\b(?:already|still|yet)\b/.test(text))) return 'status';
  if (EXISTENCE.test(text) && FUTURE.test(text) && (/\b(?:not|no|nothing|don't|haven't|anything|any)\b/.test(text) || UNCERTAIN.test(text))) return 'existence';
  if (history && /\b(?:discussed|mentioned|told|agreed|decided|talked|spoken|sent)\b/.test(text)) return 'prior_reference';
  if (/\b(?:meeting|interview|appointment|deadline|price|fee|location)\b.{0,40}\b(?:is|was|are)\s+(?:in|at|on|remote|virtual|\$)\b/.test(text)) return 'fact';
  // Uncertainty needs an objective predicate; "I think this is great" is noise.
  if (UNCERTAIN.test(text) && /\b(?:have|has|sent|submitted|paid|booked|scheduled|remote|in person)\b/.test(text)) return 'uncertainty';
  if (FUTURE.test(text) && /\b(?:meeting|interview|event|trip|deadline|appointment|course|hackathon)s?\b/.test(text)) return 'temporal';
  // This is a relevance gate, not a sentence recognizer. Unfamiliar wording must
  // reach semantic reasoning too; Cloud decides whether evidence supports an issue.
  const personalAssertion = /\b(?:i|we|they|my|our|your|their)\b/.test(text) || /^you\b/.test(text);
  if ((personalAssertion || objectiveState) && text.length >= 14 && text.split(/\s+/).length >= 4) return 'general_context';
  return null;
}

/** Exact unique text, never model offsets or markup. Invalid highlights fall back. */
export function validComposeHighlight(claim: string, highlight: string | null | undefined): string | undefined {
  if (!highlight || highlight.length > 160 || !highlight.trim() || /[<>\r\n]|https?:|www\./i.test(highlight)) return undefined;
  const start = claim.indexOf(highlight);
  return start >= 0 && claim.indexOf(highlight, start + 1) < 0 ? highlight : undefined;
}
