import { RelationshipImportanceSchema, ThreadStateSchema } from '@pigeonbox/shared';
import { z } from 'zod';
import { CursorSchema, EmailAddressSchema, GmailIdSchema, IdSchema, IsoSchema, MailboxSelectorSchema, SourceRefSchema } from './common.js';
import { CommitmentSchema } from './mail.js';

/**
 * Relationship intelligence derived from mail activity. Transparent signals
 * only: counts, dates, open commitments. No opaque "lead scores".
 */
export const ContactSummarySchema = z.object({
  id: IdSchema,
  email: z.string().max(320),
  name: z.string().max(200).nullable(),
  company: z.string().max(200).nullable(),
  domain: z.string().max(253),
  lastInteractionAt: IsoSchema.nullable(),
  lastInboundAt: IsoSchema.nullable(),
  lastOutboundAt: IsoSchema.nullable(),
  sentCount: z.number().int().nonnegative(),
  receivedCount: z.number().int().nonnegative(),
  waiting: z.enum(['on_me', 'on_them', 'both', 'none']),
  openCommitments: z.number().int().nonnegative(),
  vip: z.boolean(),
  tags: z.array(z.string().max(40)).max(20),
  importance: RelationshipImportanceSchema,
});
export type ContactSummary = z.infer<typeof ContactSummarySchema>;

export const ContactListRequestSchema = z.object({
  query: z.string().max(200).optional(),
  cursor: CursorSchema.optional(),
  limit: z.number().int().min(1).max(100).default(50),
  vipOnly: z.boolean().optional(),
});
export const ContactListResponseSchema = z.object({ contacts: z.array(ContactSummarySchema).max(100), nextCursor: CursorSchema.nullable() });

export const ContactBriefRequestSchema = z
  .object({ contactId: IdSchema.optional(), email: EmailAddressSchema.optional() })
  .refine((value) => Boolean(value.contactId || value.email), 'contactId or email is required');

// ---------------------------------------------------------------------------
// Engagement signals (tracking, documents) with honest confidence
// ---------------------------------------------------------------------------

/**
 * How an open or click event is classified. `PRIVACY_PROXY` covers mail
 * proxies (Gmail's image proxy, Apple Mail Privacy Protection) that load
 * images for the recipient's mail client without saying who or when a person
 * looked. None of these classes means "read".
 */
export const EventClassSchema = z.enum(['RECIPIENT_LIKELY', 'SELF_LIKELY', 'MACHINE_LIKELY', 'PRIVACY_PROXY', 'UNKNOWN']);
export type EventClass = z.infer<typeof EventClassSchema>;

export const SignalKindSchema = z.enum([
  'first_open',
  'latest_open',
  'open_count',
  'click',
  'reopened_after_inactivity',
  'engagement_burst',
  'no_engagement',
  'ambiguous_activity',
  'active_now',
  'document_view',
  'follow_up_timely',
]);

export const EngagementSignalSchema = z.object({
  kind: SignalKindSchema,
  /** Short label, e.g. "Reopened after 14 days". */
  label: z.string().max(160),
  /** Why the signal exists, e.g. "3 human-likely opens in 40 minutes". */
  explanation: z.string().max(400),
  confidence: z.number().min(0).max(1),
  at: IsoSchema.nullable(),
  /** Whether the signal can be tied to one recipient, only to the message, or to nothing. */
  attribution: z.enum(['recipient', 'message', 'unknown']),
  recipient: z.string().max(320).optional(),
});
export type EngagementSignal = z.infer<typeof EngagementSignalSchema>;

export const EngagementEventSchema = z.object({
  at: IsoSchema,
  type: z.enum(['open', 'click', 'document_view', 'document_download']),
  eventClass: EventClassSchema,
  confidence: z.number().min(0).max(1),
  explanation: z.string().max(300),
  destination: z.string().max(2_000).optional(),
  recipient: z.string().max(320).optional(),
});

export const ThreadSignalsRequestSchema = MailboxSelectorSchema.extend({ threadId: GmailIdSchema });
export const ThreadSignalsResponseSchema = z.object({
  signals: z.array(EngagementSignalSchema).max(20),
  events: z.array(EngagementEventSchema).max(200),
  /** How reliable per-recipient attribution is for this message, in plain words. */
  attributionNote: z.string().max(400),
});

// ---------------------------------------------------------------------------
// Brief and radar
// ---------------------------------------------------------------------------

export const TimelineEntrySchema = z.object({
  at: IsoSchema,
  kind: z.enum(['email_in', 'email_out', 'meeting', 'open', 'click', 'document_view', 'commitment', 'note']),
  label: z.string().max(200),
  source: SourceRefSchema.optional(),
});

export const RelationshipBriefSchema = z.object({
  contact: ContactSummarySchema,
  aliases: z.array(z.string().max(320)).max(20),
  /** Assembled from signatures, domains and the user's notes; states when unknown. */
  whoTheyAre: z.string().max(500),
  lastDiscussed: z.object({ text: z.string().max(400), source: SourceRefSchema }).nullable(),
  youOwe: z.array(CommitmentSchema).max(20),
  theyOwe: z.array(CommitmentSchema).max(20),
  recentlyCompleted: z.array(CommitmentSchema).max(20).default([]),
  nextMeeting: z.object({ title: z.string().max(300), start: IsoSchema, source: SourceRefSchema }).nullable(),
  importantThreads: z
    .array(z.object({ threadId: GmailIdSchema, accountId: IdSchema.optional(), subject: z.string().max(998), lastMessageAt: IsoSchema, state: ThreadStateSchema }))
    .max(10),
  timeline: z.array(TimelineEntrySchema).max(40),
  notes: z.string().max(5_000),
  signals: z.array(EngagementSignalSchema).max(10),
});
export type RelationshipBrief = z.infer<typeof RelationshipBriefSchema>;
export const ContactBriefResponseSchema = z.object({ brief: RelationshipBriefSchema });

export const ContactUpdateRequestSchema = z.object({
  contactId: IdSchema,
  vip: z.boolean().optional(),
  tags: z.array(z.string().min(1).max(40)).max(20).optional(),
  notes: z.string().max(5_000).optional(),
});
export const ContactResponseSchema = z.object({ contact: ContactSummarySchema });

export const RadarItemSchema = z.object({
  contact: ContactSummarySchema,
  reason: z.string().max(200),
  threadId: GmailIdSchema.nullable(),
  at: IsoSchema.nullable(),
});
export const RadarResponseSchema = z.object({
  goingCold: z.array(RadarItemSchema).max(20),
  unansweredImportant: z.array(RadarItemSchema).max(20),
  promisedFollowUps: z.array(RadarItemSchema).max(20),
  revived: z.array(RadarItemSchema).max(20),
  upcomingMeetings: z.array(RadarItemSchema).max(20),
  vipActivity: z.array(RadarItemSchema).max(20),
});
