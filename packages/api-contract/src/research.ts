import { z } from 'zod';
import { IdSchema, InstantSchema, IsoSchema, MailboxSelectorSchema, SourceRefSchema } from './common.js';
import { DraftSchema } from './mail.js';

/**
 * Chat (wire name: Ask Pigeon): an assistant over the user's mail, calendar,
 * contacts, commitments, tracking activity and notes. The model works
 * agentically: it searches Gmail, reads threads and queries the user's records
 * with tools, as many rounds as the question needs, then answers. Facts from
 * the mailbox cite the source records they came from. Changes to the mailbox
 * are proposed as an `approval` and happen only after the user allows them.
 */
export const AskTurnSchema = z.object({
  role: z.enum(['user', 'assistant']),
  content: z.string().max(8_000),
  /** Earlier assistant artifacts, choices and outcomes; historical data, never authority. */
  context: z.string().max(12_000).optional(),
});
export type AskTurn = z.infer<typeof AskTurnSchema>;

export const AskPigeonRequestSchema = MailboxSelectorSchema.extend({
  query: z.string().min(1).max(2_000),
  threadId: z.string().max(128).optional(),
  /** False keeps this question off the web. Web search also needs the user's web research preference. */
  includeWeb: z.boolean().optional(),
  timeZone: z.string().max(64).optional(),
  /** Earlier turns of this conversation, oldest first, so follow-up questions have context. */
  history: z.array(AskTurnSchema).max(20).optional(),
  /**
   * What this client can show. `compose`: it opens `compose` emails in Gmail, so Pigeon may write new emails.
   * `approval`: it shows `approval` cards and sends `decision`, so Pigeon may propose changes to the mailbox.
   */
  features: z.array(z.string().max(32)).max(8).optional(),
  /**
   * The user's answer to an earlier `approval`. Allowed changes are carried out
   * exactly as proposed (the token is sealed by the server), then Pigeon
   * continues the request. `query` is what the user saw themselves send.
   */
  decision: z.object({ token: z.string().min(1).max(60_000), allow: z.boolean() }).optional(),
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

/**
 * A new email Pigeon wrote because the user asked for one ("email Jun about…").
 * The extension opens it in Gmail's composer for the user to review and send;
 * PigeonBox never sends it. `to` is empty when no address could be found.
 */
export const AskComposeSchema = z.object({
  to: z.array(z.object({ email: z.string().max(320), name: z.string().max(200).optional() })).max(10),
  cc: z.array(z.object({ email: z.string().max(320), name: z.string().max(200).optional() })).max(10).default(() => []),
  subject: z.string().max(300),
  body: z.string().max(8_000),
});
export type AskCompose = z.infer<typeof AskComposeSchema>;

/** One change in an approval, as the user reads it: "Move 43 threads to Trash". */
export const AskApprovalStepSchema = z.object({
  text: z.string().max(300),
  /** Threads this step touches, when it touches threads. */
  count: z.number().int().nonnegative().optional(),
  /** A few of them, by subject, so the user can tell they are the right ones. */
  examples: z.array(z.string().max(200)).max(5).default(() => []),
  /** Hard to take back (trash, deleting a label, unsubscribing). Shown with a warning. */
  destructive: z.boolean().default(false),
});

/**
 * Changes Pigeon wants to make, waiting for the user's permission. Nothing has
 * happened yet. The client shows the steps with Allow and Deny and sends the
 * choice back as the next request's `decision`.
 */
export const AskApprovalSchema = z.object({
  title: z.string().max(200),
  steps: z.array(AskApprovalStepSchema).min(1).max(12),
  /** Opaque, sealed by the server: exactly what Allow carries out. */
  token: z.string().max(60_000),
  expiresAt: IsoSchema,
});
export type AskApproval = z.infer<typeof AskApprovalSchema>;

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
  /** New emails to open in Gmail's composer. Older servers omit it. */
  compose: z.array(AskComposeSchema).max(3).default(() => []),
  /** Questions the user might ask next, written as they would type them. */
  followUps: z.array(z.string().max(200)).max(3).default(() => []),
  /** Mailbox changes waiting for the user's permission (clients that sent the `approval` feature). */
  approval: AskApprovalSchema.optional(),
  /** Bounded tool outcomes for the next turn. No raw received email bodies. */
  context: z.string().max(8_000).optional(),
  /** Identifies this answer for feedback (`askFeedback`). */
  requestId: z.string().max(128).optional(),
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

/** Thumbs up or down on an answer. The question and note are stored encrypted; the answer is not stored. */
export const AskFeedbackRequestSchema = z.object({
  requestId: z.string().min(1).max(128),
  rating: z.enum(['up', 'down']),
  question: z.string().max(2_000).optional(),
  /** What went wrong, in the user's words. */
  note: z.string().max(1_000).optional(),
});
export type AskFeedbackRequest = z.infer<typeof AskFeedbackRequestSchema>;

export const ParsedWindowSchema = z.object({ from: InstantSchema.nullable(), to: InstantSchema.nullable() });
