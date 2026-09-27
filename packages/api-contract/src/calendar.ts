import { z } from 'zod';
import { EmailAddressSchema, GmailIdSchema, IdSchema, IdempotencyKeySchema, InstantSchema, IsoSchema, MailboxSelectorSchema, SourceRefSchema } from './common.js';
import { DraftSchema } from './mail.js';

/**
 * Calendar Copilot. Availability always comes from the user's real calendar
 * (Google free/busy); PigeonBox never proposes a time it did not check.
 * Creating an event is a separate, policy-checked step.
 */
export const SlotSchema = z.object({
  start: IsoSchema,
  end: IsoSchema,
  /** Higher is better. */
  score: z.number(),
  reasons: z.array(z.string().max(120)).max(4),
});
export type Slot = z.infer<typeof SlotSchema>;

export const AvailabilityRequestSchema = z.object({
  durationMinutes: z.number().int().min(5).max(480),
  window: z.object({ start: InstantSchema, end: InstantSchema }),
  timeZone: z.string().max(64).optional(),
  count: z.number().int().min(1).max(8).default(4),
  preferMornings: z.boolean().optional(),
  accountId: IdSchema.optional(),
});
export const AvailabilityResponseSchema = z.object({
  slots: z.array(SlotSchema).max(8),
  timeZone: z.string().max(64),
  calendarsChecked: z.number().int().nonnegative(),
  note: z.string().max(300),
});

export const SchedulingRequestSchema = z.object({
  isScheduling: z.boolean(),
  durationMinutes: z.number().int().min(5).max(480),
  durationSource: z.enum(['stated', 'inferred', 'default']),
  constraints: z.array(z.string().max(200)).max(6),
  attendees: z.array(z.string().max(320)).max(50),
  window: z.object({ start: IsoSchema, end: IsoSchema }),
});

export const ScheduleProposeRequestSchema = MailboxSelectorSchema.extend({ threadId: GmailIdSchema });
export const ScheduleProposeResponseSchema = z.object({
  request: SchedulingRequestSchema,
  slots: z.array(SlotSchema).max(4),
  timeZone: z.string().max(64),
  /** A scheduling reply offering the slots, when a response is expected. */
  draft: DraftSchema.nullable(),
  note: z.string().max(300),
});

export const PreparedEventStatusSchema = z.enum(['prepared', 'approval_pending', 'created', 'cancelled', 'failed']);
export const PreparedEventSchema = z.object({
  id: IdSchema,
  title: z.string().max(300),
  start: IsoSchema,
  end: IsoSchema,
  timeZone: z.string().max(64),
  attendees: z.array(z.string().max(320)).max(50),
  location: z.string().max(300).nullable(),
  description: z.string().max(5_000).nullable(),
  notifyAttendees: z.boolean(),
  threadId: GmailIdSchema.nullable(),
  status: PreparedEventStatusSchema,
  calendarEventId: z.string().max(256).nullable(),
  htmlLink: z.string().url().max(2_000).nullable(),
  approvalId: IdSchema.nullable(),
});
export type PreparedEvent = z.infer<typeof PreparedEventSchema>;

export const EventPrepareRequestSchema = MailboxSelectorSchema.extend({
  threadId: GmailIdSchema.optional(),
  title: z.string().min(1).max(300),
  start: InstantSchema,
  end: InstantSchema,
  timeZone: z.string().max(64).optional(),
  attendees: z.array(EmailAddressSchema).max(50).default([]),
  location: z.string().max(300).optional(),
  description: z.string().max(5_000).optional(),
  /** Sending invitations is an external side effect and always needs approval. */
  notifyAttendees: z.boolean().default(false),
});
export const EventResponseSchema = z.object({ event: PreparedEventSchema });
export const EventCreateRequestSchema = z.object({ preparedEventId: IdSchema, idempotencyKey: IdempotencyKeySchema });

export const MeetingBriefRequestSchema = z.object({ eventId: z.string().min(1).max(256), accountId: IdSchema.optional() });

export const BriefItemSchema = z.object({
  text: z.string().max(500),
  threadId: GmailIdSchema.optional(),
  sourceIds: z.array(z.string().max(128)).max(6),
  at: IsoSchema.optional(),
});
export const BriefSectionSchema = z.object({
  id: z.string().max(40),
  title: z.string().max(120),
  items: z.array(BriefItemSchema).max(25),
  empty: z.string().max(200).optional(),
});

export const BriefingKindSchema = z.enum(['morning', 'end_of_day', 'meeting']);
export const BriefingSchema = z.object({
  id: IdSchema,
  kind: BriefingKindSchema,
  title: z.string().max(200),
  generatedAt: IsoSchema,
  periodStart: IsoSchema,
  periodEnd: IsoSchema,
  eventId: z.string().max(256).nullable(),
  sections: z.array(BriefSectionSchema).max(10),
  sources: z.array(SourceRefSchema).max(80),
  coverageNote: z.string().max(300),
});
export type Briefing = z.infer<typeof BriefingSchema>;
export const BriefingSummarySchema = BriefingSchema.pick({ id: true, kind: true, title: true, generatedAt: true, eventId: true });

export const MeetingBriefResponseSchema = z.object({ briefing: BriefingSchema });
export const BriefingsListRequestSchema = z.object({ kind: BriefingKindSchema.optional(), limit: z.number().int().min(1).max(50).default(10) });
export const BriefingsListResponseSchema = z.object({ briefings: z.array(BriefingSummarySchema).max(50) });
export const BriefingGetRequestSchema = z.object({ id: IdSchema });
export const BriefingGenerateRequestSchema = z.object({ kind: z.enum(['morning', 'end_of_day']) });
export const BriefingResponseSchema = z.object({ briefing: BriefingSchema });
