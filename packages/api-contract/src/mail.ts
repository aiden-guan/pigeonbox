import { FocusSectionSchema, ThreadStateDetailSchema, ThreadStateSchema } from '@pigeonbox/shared';
import { z } from 'zod';
import { VoiceProfileSchema } from './ai.js';
import {
  GmailIdSchema,
  IdSchema,
  IdempotencyKeySchema,
  InstantSchema,
  IsoSchema,
  LimitSchema,
  MailboxSelectorSchema,
  PersonSchema,
  PlaceholderInfoSchema,
  SourceRefSchema,
} from './common.js';

// ---------------------------------------------------------------------------
// Commitments and follow-ups
// ---------------------------------------------------------------------------

export const CommitmentSchema = z.object({
  id: IdSchema,
  /** `mine`: the user promised it. `theirs`: someone promised the user. */
  direction: z.enum(['mine', 'theirs']),
  owner: z.string().max(320),
  text: z.string().max(300),
  dueAt: IsoSchema.nullable(),
  status: z.enum(['open', 'done', 'cancelled']),
  source: SourceRefSchema,
});
export type Commitment = z.infer<typeof CommitmentSchema>;

export const FOLLOW_UP_STAGES = ['sent', 'waiting', 'engaged', 'reply', 'follow_up_due', 'closed'] as const;
export const FollowUpStageSchema = z.enum(FOLLOW_UP_STAGES);
export type FollowUpStage = z.infer<typeof FollowUpStageSchema>;

export const FollowUpSchema = z.object({
  id: IdSchema,
  threadId: GmailIdSchema,
  accountId: IdSchema,
  stage: FollowUpStageSchema,
  /** Who a reply is expected from. */
  expectedFrom: z.array(z.string().max(320)).max(20),
  dueAt: IsoSchema.nullable(),
  /** Why PigeonBox expects a reply, in plain words. */
  reason: z.string().max(300),
  rule: z.enum(['business_days', 'opened_no_reply', 'revived', 'promised', 'deadline', 'manual']),
  lastOutboundAt: IsoSchema,
  lastInboundAt: IsoSchema.nullable(),
  engagement: z
    .object({
      likelyOpens: z.number().int().nonnegative(),
      lastLikelyOpenAt: IsoSchema.nullable(),
      clicks: z.number().int().nonnegative(),
    })
    .nullable(),
  draftId: IdSchema.nullable(),
  snoozedUntil: IsoSchema.nullable(),
});
export type FollowUp = z.infer<typeof FollowUpSchema>;

// ---------------------------------------------------------------------------
// Drafts
// ---------------------------------------------------------------------------

export const DRAFT_KINDS = ['reply', 'follow_up', 'scheduling', 'acknowledgment', 'info_request'] as const;
export const DraftKindSchema = z.enum(DRAFT_KINDS);
export type DraftKind = z.infer<typeof DraftKindSchema>;

export const DraftStatusSchema = z.enum(['preparing', 'ready', 'stale', 'user_edited', 'placed', 'sent', 'discarded', 'failed']);
export type DraftStatus = z.infer<typeof DraftStatusSchema>;

export const DraftVariantSchema = z.object({
  id: IdSchema,
  /** At most one of each. A single `recommended` variant when one answer is obvious. */
  label: z.enum(['recommended', 'shorter', 'alternative']),
  /** What this variant does differently, e.g. "Declines and suggests next month". */
  strategy: z.string().max(200),
  subject: z.string().max(998).optional(),
  body: z.string().min(1).max(20_000),
  placeholders: z.array(PlaceholderInfoSchema).max(20),
});
export type DraftVariant = z.infer<typeof DraftVariantSchema>;

export const DraftSchema = z.object({
  id: IdSchema,
  threadId: GmailIdSchema,
  accountId: IdSchema,
  kind: DraftKindSchema,
  status: DraftStatusSchema,
  variants: z.array(DraftVariantSchema).max(3),
  /** "Used to prepare this draft". Shown in PigeonBox only, never added to the email. */
  sources: z.array(SourceRefSchema).max(24),
  freshness: z.object({
    createdAt: IsoSchema,
    basedOnMessageId: GmailIdSchema.nullable(),
    staleReason: z.string().max(200).nullable(),
    refreshAfter: IsoSchema.nullable(),
  }),
  /** Which writing profile shaped the voice. */
  voice: z.enum(['recipient', 'domain', 'email_type', 'global', 'default']),
  gmailDraftId: z.string().max(128).nullable(),
  placedVariantId: IdSchema.nullable(),
  errorCode: z.string().max(64).nullable(),
});
export type CloudDraft = z.infer<typeof DraftSchema>;

// ---------------------------------------------------------------------------
// Thread intelligence
// ---------------------------------------------------------------------------

export const ThreadIntelSchema = z.object({
  threadId: GmailIdSchema,
  accountId: IdSchema,
  subject: z.string().max(998),
  participants: z.array(PersonSchema).max(50),
  lastMessageAt: IsoSchema,
  lastMessageFromOwner: z.boolean(),
  state: ThreadStateDetailSchema,
  summary: z
    .object({
      oneLine: z.string().max(400),
      keyPoints: z.array(z.string().max(300)).max(8),
    })
    .nullable(),
  commitments: z.array(CommitmentSchema).max(20),
  followUp: FollowUpSchema.nullable(),
  draft: DraftSchema.nullable(),
  /** The message text looked like it tried to instruct an AI. Drafts treat it as data only. */
  injectionSuspected: z.boolean(),
  analyzedAt: IsoSchema.nullable(),
  sources: z.array(SourceRefSchema).max(12),
});
export type ThreadIntel = z.infer<typeof ThreadIntelSchema>;

export const ThreadsIntelRequestSchema = MailboxSelectorSchema.extend({
  threadIds: z.array(GmailIdSchema).min(1).max(40),
});
export const ThreadsIntelResponseSchema = z.object({
  /** Keyed by the thread ID exactly as requested. Threads PigeonBox Cloud has not synced are absent. */
  threads: z.record(z.string().max(64), ThreadIntelSchema),
  /** The mailbox is connected and synced by PigeonBox Cloud. */
  synced: z.boolean(),
  accountId: IdSchema.nullable(),
});

export const ThreadStateUpdateRequestSchema = MailboxSelectorSchema.extend({
  threadId: GmailIdSchema,
  state: ThreadStateSchema,
});
export const ThreadStateUpdateResponseSchema = z.object({ thread: ThreadIntelSchema });

export const FocusItemSchema = z.object({
  threadId: GmailIdSchema,
  accountId: IdSchema,
  subject: z.string().max(998),
  who: z.string().max(320),
  lastMessageAt: IsoSchema,
  section: FocusSectionSchema,
  state: ThreadStateSchema,
  score: z.number().int().nonnegative(),
  /** Why the thread is in the queue, most important first. */
  reasons: z.array(z.string().max(120)).max(6),
  deadlineAt: IsoSchema.nullable(),
  draftReady: z.boolean(),
  followUpDueAt: IsoSchema.nullable(),
});
export type FocusItem = z.infer<typeof FocusItemSchema>;

export const FocusQueueRequestSchema = MailboxSelectorSchema.extend({ limit: LimitSchema(100, 40) });
export const FocusQueueResponseSchema = z.object({
  sections: z.array(z.object({ id: FocusSectionSchema, label: z.string().max(40), items: z.array(FocusItemSchema).max(100) })).max(6),
  generatedAt: IsoSchema,
  coverage: z.object({
    syncedAccounts: z.number().int().nonnegative(),
    since: IsoSchema.nullable(),
    note: z.string().max(300),
  }),
});

export const DraftGetRequestSchema = MailboxSelectorSchema.extend({ threadId: GmailIdSchema });
export const CloudDraftResponseSchema = z.object({ draft: DraftSchema.nullable() });
export const DraftPrepareRequestSchema = MailboxSelectorSchema.extend({
  threadId: GmailIdSchema,
  kind: DraftKindSchema.optional(),
  /** Extra guidance from the user, e.g. "decline politely". */
  instructions: z.string().max(1_000).optional(),
  force: z.boolean().optional(),
});
export const DraftPlaceRequestSchema = z.object({
  draftId: IdSchema,
  variantId: IdSchema,
  /** Text as the user edited it in PigeonBox before placing, if changed. */
  body: z.string().min(1).max(20_000).optional(),
  idempotencyKey: IdempotencyKeySchema,
});
export const DraftFeedbackRequestSchema = z.object({
  draftId: IdSchema,
  variantId: IdSchema.optional(),
  outcome: z.enum(['used', 'edited', 'discarded', 'sent']),
  /**
   * The text the user ended with. Used once to learn structural preferences
   * (length, greeting, sign-off) and then discarded; never stored.
   */
  finalText: z.string().max(20_000).optional(),
});

export const FollowUpListRequestSchema = MailboxSelectorSchema.extend({
  stages: z.array(FollowUpStageSchema).max(FOLLOW_UP_STAGES.length).optional(),
  limit: LimitSchema(200, 50),
});
export const FollowUpItemSchema = z.object({
  followUp: FollowUpSchema,
  subject: z.string().max(998),
  who: z.string().max(320),
});
export const FollowUpListResponseSchema = z.object({ followUps: z.array(FollowUpItemSchema).max(200) });
export const FollowUpUpdateRequestSchema = z.object({
  followUpId: IdSchema,
  action: z.enum(['snooze', 'close', 'reopen', 'remind_at', 'prepare_draft']),
  at: InstantSchema.optional(),
});
export const FollowUpUpdateResponseSchema = z.object({ followUp: FollowUpSchema });

// ---------------------------------------------------------------------------
// Preferences
// ---------------------------------------------------------------------------

const HourMinute = z.string().regex(/^([01]\d|2[0-3]):[0-5]\d$/);

export const PreferencesSchema = z.object({
  timeZone: z.string().max(64),
  workdays: z.array(z.number().int().min(0).max(6)).min(1).max(7),
  workingHours: z.object({ start: HourMinute, end: HourMinute }),
  followUp: z.object({
    defaultBusinessDays: z.number().int().min(1).max(30),
    remindIfOpenedNoReply: z.boolean(),
    remindWhenRevived: z.boolean(),
    prepareDraftMorningOf: z.boolean(),
    morningAt: HourMinute,
  }),
  autoDrafts: z.object({
    enabled: z.boolean(),
    /** Also create the draft in Gmail (needs the Drafts connection). */
    placeInGmail: z.boolean(),
    kinds: z.array(z.enum(['reply', 'follow_up', 'scheduling', 'acknowledgment', 'info_request'])).max(5),
    /** Learn structure from how the user edits drafts. Text is never stored. */
    learnFromEdits: z.boolean(),
  }),
  calendar: z.object({
    bufferMinutes: z.number().int().min(0).max(120),
    avoidBackToBack: z.boolean(),
    preferMornings: z.boolean(),
    defaultDurationMinutes: z.number().int().min(5).max(480),
    focusBlocks: z
      .array(z.object({ day: z.number().int().min(0).max(6), start: HourMinute, end: HourMinute }))
      .max(21),
  }),
  fastRecall: z.object({
    /** Opt-in: keep encrypted excerpts of synced mail for deep search. Off by default. */
    enabled: z.boolean(),
    retentionDays: z.number().int().min(7).max(730),
  }),
  briefings: z.object({
    morning: z.object({ enabled: z.boolean(), at: HourMinute }),
    endOfDay: z.object({ enabled: z.boolean(), at: HourMinute }),
    meeting: z.object({ enabled: z.boolean(), minutesBefore: z.number().int().min(5).max(240), externalOnly: z.boolean() }),
  }),
  notifications: z.object({
    extension: z.boolean(),
    web: z.boolean(),
    followUpsDue: z.boolean(),
    approvals: z.boolean(),
    engagement: z.boolean(),
  }),
  /** Explicit opt-in: allow web research for drafts and Ask Pigeon. */
  webResearch: z.boolean(),
  /**
   * The voice the extension uses for drafts, so background drafts sound the
   * same. The extension keeps it in sync; null until it has.
   */
  voice: VoiceProfileSchema.nullable(),
});
export type Preferences = z.infer<typeof PreferencesSchema>;

export const PreferencesResponseSchema = z.object({ preferences: PreferencesSchema });

/** Partial update, one level deep per section. */
export const PreferencesUpdateRequestSchema = z.object({
  preferences: z
    .object({
      timeZone: PreferencesSchema.shape.timeZone,
      workdays: PreferencesSchema.shape.workdays,
      workingHours: PreferencesSchema.shape.workingHours,
      followUp: PreferencesSchema.shape.followUp.partial(),
      autoDrafts: PreferencesSchema.shape.autoDrafts.partial(),
      calendar: PreferencesSchema.shape.calendar.partial(),
      fastRecall: PreferencesSchema.shape.fastRecall.partial(),
      briefings: z
        .object({
          morning: PreferencesSchema.shape.briefings.shape.morning.partial(),
          endOfDay: PreferencesSchema.shape.briefings.shape.endOfDay.partial(),
          meeting: PreferencesSchema.shape.briefings.shape.meeting.partial(),
        })
        .partial(),
      notifications: PreferencesSchema.shape.notifications.partial(),
      webResearch: PreferencesSchema.shape.webResearch,
      voice: PreferencesSchema.shape.voice,
    })
    .partial(),
});
