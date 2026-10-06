import { COMPOSE_CLAIM_KINDS, COMPOSE_CLAIM_MAX } from '@pigeonbox/shared';
import { z } from 'zod';
import { GmailIdSchema, MailboxSelectorSchema, SourceRefSchema } from './common.js';

/**
 * Real-time Pidgy checks (`compose_check`). While the user writes, the
 * extension may send one short changed clause of an unsent draft, never the
 * whole draft. Cloud compares it with the user's calendar and Brain and
 * answers with nothing (the usual case) or one small advisory.
 *
 * The claim is processed in memory and discarded: it is not stored, logged,
 * queued, embedded for storage, or learned from. Opt-in through
 * `preferences.memory.realtimeComposeChecks`.
 */

/** What the extension's local detector thought the clause was. An optimization hint only; the server re-derives it. */
export const ComposeCheckHintSchema = z.enum(COMPOSE_CLAIM_KINDS);
export type ComposeCheckHint = z.infer<typeof ComposeCheckHintSchema>;

/** Longest stretch of unsent draft text one check may carry. */
export const COMPOSE_CHECK_MAX_CLAIM = COMPOSE_CLAIM_MAX;

export const ComposeCheckRequestSchema = MailboxSelectorSchema.extend({
  threadId: GmailIdSchema.optional(),
  recipientEmails: z.array(z.string().email().max(320)).max(20),
  subject: z.string().max(998),
  claim: z.string().trim().min(3).max(COMPOSE_CHECK_MAX_CLAIM),
  hint: ComposeCheckHintSchema.optional(),
});
export type ComposeCheckRequest = z.infer<typeof ComposeCheckRequestSchema>;

export const ComposeCheckKindSchema = z.enum(['calendar_conflict', 'commitment_conflict', 'fact_conflict', 'context']);
export type ComposeCheckKind = z.infer<typeof ComposeCheckKindSchema>;

export const ComposeCheckNoticeSchema = z.object({
  status: z.literal('notice'),
  kind: ComposeCheckKindSchema,
  severity: z.enum(['info', 'warning']),
  /** One short factual sentence, e.g. "You have Math 52 from 2–4 PM tomorrow." */
  message: z.string().min(1).max(240),
  confidence: z.number().min(0).max(1),
  /** A grounded replacement for the whole claim. Absent unless trusted context supplies it. */
  suggestedText: z.string().min(1).max(COMPOSE_CHECK_MAX_CLAIM).optional(),
  sources: z.array(SourceRefSchema).max(4),
});
export type ComposeCheckNotice = z.infer<typeof ComposeCheckNoticeSchema>;

/**
 * `none`: nothing worth saying (the common answer, also used when Cloud cannot check).
 * `disabled`: Real-time Pidgy checks are off for this account; the claim was not examined.
 */
export const ComposeCheckResponseSchema = z.discriminatedUnion('status', [
  z.object({ status: z.literal('none') }),
  z.object({ status: z.literal('disabled') }),
  ComposeCheckNoticeSchema,
]);
export type ComposeCheckResponse = z.infer<typeof ComposeCheckResponseSchema>;
