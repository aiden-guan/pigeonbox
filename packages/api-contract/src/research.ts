import { z } from 'zod';
import { IdSchema, InstantSchema, IsoSchema, MailboxSelectorSchema, SourceRefSchema } from './common.js';
import { DraftSchema } from './mail.js';

/**
 * Ask Pigeon: an assistant over the user's mail, calendar, contacts,
 * commitments, tracking activity and notes. The model works agentically: it
 * searches Gmail, reads threads and queries the user's records with tools,
 * as many rounds as the question needs, then answers. Facts from the
 * mailbox cite the source records they came from.
 */
export const AskTurnSchema = z.object({
  role: z.enum(['user', 'assistant']),
  content: z.string().max(8_000),
});
export type AskTurn = z.infer<typeof AskTurnSchema>;

export const AskPigeonRequestSchema = MailboxSelectorSchema.extend({
  query: z.string().min(1).max(2_000),
  threadId: z.string().max(128).optional(),
  /** Only honoured when the user enabled web research in preferences. */
  includeWeb: z.boolean().optional(),
  timeZone: z.string().max(64).optional(),
  /** Earlier turns of this conversation, oldest first, so follow-up questions have context. */
  history: z.array(AskTurnSchema).max(20).optional(),
});

export const AskClaimSchema = z.object({
  text: z.string().max(1_000),
  /** IDs from `sources`. Empty means the claim is PigeonBox's own framing, not a fact from mail. */
  sourceIds: z.array(z.string().max(128)).max(8),
});

export const AskActionSchema = z.object({
  kind: z.enum(['draft_follow_ups', 'propose_times', 'open_thread', 'open_contact', 'open_view']),
  label: z.string().max(120),
  threadId: z.string().max(64).optional(),
  contactId: IdSchema.optional(),
});

export const AskPigeonResponseSchema = z.object({
  answer: z.string().max(8_000),
  claims: z.array(AskClaimSchema).max(40),
  sources: z.array(SourceRefSchema).max(40),
  coverage: z.object({
    complete: z.boolean(),
    note: z.string().max(500),
    /** Earliest synced mail the answer could draw on. */
    since: IsoSchema.nullable(),
  }),
  /** Things the question assumed that PigeonBox could not verify. */
  unverified: z.array(z.string().max(300)).max(10),
  actions: z.array(AskActionSchema).max(6),
  /** Drafts prepared when the question asked for them ("draft follow-ups for…"). */
  drafts: z.array(DraftSchema).max(10),
  /** How the answer was produced, for transparency. */
  retrieval: z.object({
    strategies: z.array(z.enum(['filters', 'lexical', 'semantic', 'entities', 'dates', 'relationships', 'calendar', 'tracking', 'web'])).max(9),
    candidates: z.number().int().nonnegative(),
    used: z.number().int().nonnegative(),
    window: z.object({ from: IsoSchema.nullable(), to: IsoSchema.nullable() }),
  }),
});
export type AskPigeonResponse = z.infer<typeof AskPigeonResponseSchema>;

/**
 * Ask Pigeon, streamed: one JSON event per line (application/x-ndjson).
 * `status` says what the agent is doing ("Searching Gmail: from:allen"),
 * `delta` is answer text as it is written (raw: citation markers like [S3]
 * are not resolved yet), `reset` discards deltas from a round that turned
 * into tool calls, and `done` carries the final, cited response. A stream
 * ends with exactly one `done` or `error`.
 */
export const AskStreamEventSchema = z.discriminatedUnion('type', [
  z.object({ type: z.literal('status'), text: z.string().max(300) }),
  z.object({ type: z.literal('delta'), text: z.string().max(4_000) }),
  z.object({ type: z.literal('reset') }),
  z.object({ type: z.literal('done'), response: AskPigeonResponseSchema }),
  z.object({ type: z.literal('error'), code: z.string().max(64), message: z.string().max(500) }),
]);
export type AskStreamEvent = z.infer<typeof AskStreamEventSchema>;

export const ParsedWindowSchema = z.object({ from: InstantSchema.nullable(), to: InstantSchema.nullable() });
