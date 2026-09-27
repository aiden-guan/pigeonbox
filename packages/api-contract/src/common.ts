import { z } from 'zod';

/**
 * Building blocks shared by the Cloud intelligence routes. Every string and
 * list is bounded; timestamps are ISO-8601 strings.
 */

export const IdSchema = z.string().min(1).max(64);
/** Gmail thread or message ID. Hex from the Gmail API; the server also accepts InboxSDK's decimal and prefixed spellings. */
export const GmailIdSchema = z.string().min(1).max(64);
export const EmailAddressSchema = z.string().min(3).max(320).regex(/^[^\s@<>]+@[^\s@<>]+$/);
export const IsoSchema = z.string().max(40);
/** An ISO timestamp that must parse. */
export const InstantSchema = z
  .string()
  .max(40)
  .refine((value) => Number.isFinite(Date.parse(value)), 'Expected an ISO timestamp');
/** Client-chosen key that makes a write safe to retry. */
export const IdempotencyKeySchema = z.string().regex(/^[A-Za-z0-9._:-]{8,128}$/);
export const LimitSchema = (max: number, fallback: number) => z.number().int().min(1).max(max).default(fallback);

/**
 * Mailbox selector. The extension sends the Gmail address of the open tab; the
 * server resolves it to one of the user's connected accounts. Never trusted
 * for authorization: accounts are always looked up under the signed-in user.
 */
export const MailboxSelectorSchema = z.object({
  mailbox: EmailAddressSchema.optional(),
  accountId: IdSchema.optional(),
});

export const SourceKindSchema = z.enum([
  'thread',
  'message',
  'calendar_event',
  'document',
  'contact',
  'tracking',
  'note',
  'commitment',
  'web',
]);
export type SourceKind = z.infer<typeof SourceKindSchema>;

/**
 * A pointer to the record a statement, draft or brief was based on. Shown as a
 * source chip in PigeonBox UI; never inserted into outgoing mail. `title` is a
 * subject, event title or document name, never message body text.
 */
export const SourceRefSchema = z.object({
  id: z.string().min(1).max(128),
  kind: SourceKindSchema,
  title: z.string().max(300),
  accountId: IdSchema.optional(),
  gmailThreadId: GmailIdSchema.optional(),
  gmailMessageId: GmailIdSchema.optional(),
  /** Only for web results and calendar links. */
  url: z.string().url().max(2_000).optional(),
  at: IsoSchema.optional(),
  who: z.string().max(320).optional(),
  /** Version of the source when it was used, for freshness checks. */
  version: z.string().max(128).optional(),
});
export type SourceRef = z.infer<typeof SourceRefSchema>;

export const PlaceholderInfoSchema = z.object({
  token: z.string().max(64),
  kind: z.enum(['date', 'time', 'amount', 'number', 'address', 'name', 'link', 'attachment', 'fact']),
  mode: z.enum(['needed', 'confirm']),
  label: z.string().max(120),
});
export type PlaceholderInfo = z.infer<typeof PlaceholderInfoSchema>;

export const PersonSchema = z.object({ email: z.string().max(320), name: z.string().max(200).optional() });
export type Person = z.infer<typeof PersonSchema>;

export const CursorSchema = z.string().max(200);

/** Risk tier of an action. See docs: 0 read-only, 1 reversible mailbox change, 2 externally visible draft/state, 3 external side effect. */
export const RiskTierSchema = z.union([z.literal(0), z.literal(1), z.literal(2), z.literal(3)]);
export type RiskTier = z.infer<typeof RiskTierSchema>;
