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
