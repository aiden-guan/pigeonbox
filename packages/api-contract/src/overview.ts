import { z } from 'zod';
import { InstantSchema, IsoSchema } from './common.js';
import { MailAccountSchema } from './connections.js';
import { FocusQueueResponseSchema } from './mail.js';
import { BriefingSchema } from './calendar.js';
import { SmartViewSchema, AutomationSchema, AutomationRunSchema } from './automation.js';

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
  latestBriefing: BriefingSchema.nullable(),
  automatic: z.object({
    views: z.array(SmartViewSchema).max(100),
    automations: z.array(AutomationSchema).max(100),
    runs: z.array(AutomationRunSchema).max(10),
  }).nullable(),
  unavailable: z.array(z.enum(['accounts', 'work', 'focus', 'briefing', 'automatic'])).max(5),
});
export type CloudOverview = z.infer<typeof CloudOverviewResponseSchema>;
