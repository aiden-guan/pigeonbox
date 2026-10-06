import { z } from 'zod';
import { ThreadStateSchema } from '@pigeonbox/shared';
import { GmailIdSchema, IdSchema, InstantSchema, IsoSchema } from './common.js';
import { MailAccountSchema } from './connections.js';
import { FocusQueueResponseSchema } from './mail.js';
import { BriefingSchema } from './calendar.js';
import { SmartViewSchema, AutomationSchema, AutomationRunSchema } from './automation.js';

/**
 * The newest conversations where someone else wrote last, with what PigeonBox
 * thinks of each: Home's "what came in" feed, independent of `since`.
 */
export const RecentMailSchema = z.object({
  threadId: GmailIdSchema,
  accountId: IdSchema,
  subject: z.string().max(998),
  who: z.string().max(320),
  lastMessageAt: IsoSchema,
  state: ThreadStateSchema,
  /** One-line summary from analysis; null before analysis or when unreadable. */
  summary: z.string().max(400).nullable(),
  draftReady: z.boolean(),
});
export type RecentMail = z.infer<typeof RecentMailSchema>;

/** One bounded read; failed optional sections never masquerade as zero work. */
export const CloudOverviewRequestSchema = z.object({ since: InstantSchema.optional() });
export const CloudOverviewResponseSchema = z.object({
  generatedAt: IsoSchema,
  since: IsoSchema,
  accounts: z.array(MailAccountSchema).max(20).nullable(),
  work: z.object({
    threadsAnalyzed: z.number().int().nonnegative(),
    draftsPrepared: z.number().int().nonnegative().nullable(),
    followUpsDetected: z.number().int().nonnegative(),
    approvalsWaiting: z.number().int().nonnegative(),
  }).nullable(),
  /**
   * What is prepared right now, independent of `since`. Optional for older
   * servers; `drafts` is null without the drafts capability.
   */
  prepared: z.object({
    drafts: z.object({
      ready: z.number().int().nonnegative(),
      inGmail: z.number().int().nonnegative(),
      needsUpdate: z.number().int().nonnegative(),
      preparing: z.number().int().nonnegative(),
    }).nullable(),
    followUpsOpen: z.number().int().nonnegative(),
    approvalsWaiting: z.number().int().nonnegative(),
  }).nullable().optional(),
  focus: FocusQueueResponseSchema.nullable(),
  /** Newest inbound conversations. Optional for older servers; null when it could not load. */
  recent: z.array(RecentMailSchema).max(40).nullable().optional(),
  latestBriefing: BriefingSchema.nullable(),
  automatic: z.object({
    views: z.array(SmartViewSchema).max(100),
    automations: z.array(AutomationSchema).max(100),
    runs: z.array(AutomationRunSchema).max(10),
  }).nullable(),
  unavailable: z.array(z.enum(['accounts', 'work', 'focus', 'briefing', 'automatic'])).max(5),
});
export type CloudOverview = z.infer<typeof CloudOverviewResponseSchema>;
