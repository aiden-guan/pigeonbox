/**
 * Whether an Ask Pigeon answer is backed by what it cited. The agent already
 * cites every source it used; this is the server's own check on top of the
 * prompt, so an answer that searched mail but cited nothing is never presented
 * as complete. It does not rewrite the answer (a correct "I found nothing" must
 * survive); it marks coverage incomplete with a plain note, which every client
 * already shows. Signals are counts only.
 */

/** Tools whose results are mail-derived evidence that an answer should cite. */
const MAIL_EVIDENCE = new Set(['search_mail', 'read_thread', 'search_index', 'recall_memory', 'search_notes']);

export const UNVERIFIED_NOTE = 'I couldn’t verify that from the mail I’ve indexed.';

export type Answerability = 'grounded' | 'partial' | 'unsupported' | 'not_searched';

export type AnswerabilityInput = {
  /** Tool name → calls. */
  used: ReadonlyMap<string, number>;
  /** Distinct candidates the tools returned. */
  candidates: number;
  /** Numbered sources the answer resolved to. */
  cited: number;
  /** Coverage was already incomplete (no Gmail, provider problems, out of time). */
  incomplete: boolean;
};

export function answerability(input: AnswerabilityInput): Answerability {
  const tools = [...input.used].filter(([, count]) => count > 0).map(([name]) => name);
  if (!tools.length) return 'not_searched';
  if (input.cited > 0) return input.incomplete ? 'partial' : 'grounded';
  // Only mail evidence was consulted and none of it was cited: the answer is not supported by mail.
  if (tools.every((name) => MAIL_EVIDENCE.has(name))) return 'unsupported';
  // Calendar, follow-up or count tools answer from structured state that is not always cited.
  return input.incomplete ? 'partial' : 'grounded';
}
