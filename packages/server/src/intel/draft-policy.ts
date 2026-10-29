import { sensitiveText } from './memory/policy.js';

/**
 * Whether a background reply draft is worth preparing at all. This decides
 * *if*, never *what*: wording, grounding and approval stay in drafts.ts.
 * Nothing is ever sent; a skipped draft can still be requested by the person.
 *
 * Good candidates are routine: scheduling, a clear yes/no, a confirmation, a
 * short question. Threads that need judgment the person should bring
 * themselves (negotiation, conflict, sensitive news, a large group, an unclear
 * or many-part request) are left alone. Each skip has a fixed reason code for
 * logs and tests; no content is recorded.
 */

/** Auto drafts per person per window; follow-up drafts have their own cap in followups.ts. */
export const AUTO_DRAFTS_PER_WINDOW = 8;
export const AUTO_DRAFT_WINDOW_MS = 20 * 3_600_000;
/** More distinct people than this on the latest inbound message makes a "large group" thread. */
export const AUTO_DRAFT_MAX_PARTICIPANTS = 4;
/** Below this analysis confidence the request itself is unclear. */
export const AUTO_DRAFT_MIN_CONFIDENCE = 0.6;
/** More questions than this in the latest message needs original reasoning, not a prepared reply. */
export const AUTO_DRAFT_MAX_QUESTIONS = 3;

export type AutoDraftSkip =
  | 'injection_suspected'
  | 'uncertain_request'
  | 'large_group'
  | 'sensitive'
  | 'negotiation_or_conflict'
  | 'complex_request'
  | 'needs_original_work'
  | 'window_budget';

export type AutoDraftDecision = { prepare: true; reason: 'routine' | 'scheduling' } | { prepare: false; reason: AutoDraftSkip };

export type AutoDraftInput = {
  scheduling: boolean;
  confidence: number;
  suspiciousInstructions: boolean;
  nextAction: string;
  /** Distinct non-owner addresses on the latest inbound message (from, to, cc). */
  participants: number;
  /** Latest inbound message text, read for this analysis and not stored; null for metadata-only analysis. */
  latestInbound: string | null;
  /** Auto drafts already prepared for this person in the current window. */
  recentAutoDrafts: number;
};

/** Words that mark a conversation as negotiation, disagreement or bad news. Deliberately narrow. */
const JUDGMENT = new RegExp(
  [
    'negotiat', 'counter[- ]?offer', 'counter[- ]?proposal', 'final offer', 'salary', 'compensation', 'severance', 'pricing proposal',
    'contract terms', 'redline', 'dispute', 'disagree', 'unacceptable', 'disappointed', 'frustrat', 'complain', 'escalat', 'refund',
    'legal action', 'lawyer', 'attorney', 'lawsuit', 'cease and desist', 'terminat', 'laid off', 'layoff', 'resign', 'fired',
    'condolence', 'passed away', 'funeral', 'bereavement', 'diagnos', 'hospital', 'apologi[sz]e', 'sorry for',
  ].join('|'),
  'i',
);

/** Actions that need the person's own work, not a reply: sending a file, reviewing a document. */
const ORIGINAL_WORK = new Set(['send_deliverable', 'review']);

export function autoDraftDecision(input: AutoDraftInput): AutoDraftDecision {
  if (input.suspiciousInstructions) return { prepare: false, reason: 'injection_suspected' };
  if (input.recentAutoDrafts >= AUTO_DRAFTS_PER_WINDOW) return { prepare: false, reason: 'window_budget' };
  if (input.confidence < AUTO_DRAFT_MIN_CONFIDENCE) return { prepare: false, reason: 'uncertain_request' };
  if (input.participants > AUTO_DRAFT_MAX_PARTICIPANTS) return { prepare: false, reason: 'large_group' };
  if (ORIGINAL_WORK.has(input.nextAction)) return { prepare: false, reason: 'needs_original_work' };
  const text = input.latestInbound;
  if (text !== null) {
    if (sensitiveText(text)) return { prepare: false, reason: 'sensitive' };
    if (JUDGMENT.test(text)) return { prepare: false, reason: 'negotiation_or_conflict' };
    // Count questions in the new text only, not in quoted history.
    const fresh = text.split(/\n\s*(?:>|On .{0,200} wrote:)/)[0] ?? text;
    if ((fresh.match(/\?/g) ?? []).length > AUTO_DRAFT_MAX_QUESTIONS && !input.scheduling) return { prepare: false, reason: 'complex_request' };
  }
  return { prepare: true, reason: input.scheduling ? 'scheduling' : 'routine' };
}
