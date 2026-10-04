import { z } from 'zod';
import { CapabilityListSchema } from './capabilities.js';

export const HealthResponseSchema = z.object({
  ok: z.literal(true),
  service: z.string().max(64),
  time: z.string().max(40),
});

export const VersionResponseSchema = z.object({
  service: z.string().max(64),
  version: z.string().max(40),
  protocol: z.object({
    current: z.number().int(),
    supported: z.array(z.number().int()).min(1),
  }),
});

/**
 * Plan identifiers are product names, not prices. The server maps its billing
 * state to a plan and the plan to capabilities; clients never branch on plan.
 */
export const PlanIdSchema = z.string().max(64);

export const SubscriptionStatusSchema = z.enum([
  'none',
  'active',
  'trialing',
  'past_due',
  'canceled',
  'incomplete',
  'incomplete_expired',
  'unpaid',
  'paused',
]);
export type SubscriptionStatus = z.infer<typeof SubscriptionStatusSchema>;

export const CloudUserSchema = z.object({
  id: z.string().max(64),
  email: z.string().max(320).nullable(),
});
export type CloudUser = z.infer<typeof CloudUserSchema>;

export const LimitsSchema = z.object({
  aiRequestsPerDay: z.number().int().nonnegative().nullable(),
  aiTokensPerMonth: z.number().int().nonnegative().nullable(),
  aiRequestsPerMinute: z.number().int().nonnegative().nullable(),
});

export const UsageSummarySchema = z.object({
  aiRequestsToday: z.number().int().nonnegative(),
  aiTokensThisMonth: z.number().int().nonnegative(),
  /** Share of this month's Cloud AI allowance used, 0 to 1. Shown as a usage bar; the allowance itself is not exposed. */
  aiMonthlyUsed: z.number().min(0).max(1).default(0),
});

export const MeResponseSchema = z.object({
  user: CloudUserSchema,
  plan: PlanIdSchema,
  subscription: z.object({
    status: SubscriptionStatusSchema,
    currentPeriodEnd: z.string().max(40).nullable(),
    cancelAtPeriodEnd: z.boolean(),
  }),
});
export type MeResponse = z.infer<typeof MeResponseSchema>;

export const CapabilitiesResponseSchema = z.object({
  plan: PlanIdSchema,
  capabilities: CapabilityListSchema,
});

export const EntitlementsResponseSchema = z.object({
  plan: PlanIdSchema,
  capabilities: CapabilityListSchema,
  limits: LimitsSchema,
  usage: UsageSummarySchema,
});
export type EntitlementsResponse = z.infer<typeof EntitlementsResponseSchema>;

export const BillingRedirectResponseSchema = z.object({ url: z.string().url().max(2_000) });
export const BillingCheckoutRequestSchema = z.object({}).strict();
export const BillingPortalRequestSchema = z.object({}).strict();

/** Deleting an account requires re-stating intent in the body. */
export const AccountDeleteRequestSchema = z.object({ confirm: z.literal('delete my account') }).strict();
