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
  /** Share of this month's AI budget used, 0 to 1 (0 without a budget). Shown as a usage bar; the budget itself is not exposed. */
  aiMonthlyUsed: z.number().min(0).max(1).default(0),
});

export const MeResponseSchema = z.object({
  user: CloudUserSchema,
});
export type MeResponse = z.infer<typeof MeResponseSchema>;

export const CapabilitiesResponseSchema = z.object({
  capabilities: CapabilityListSchema,
});

export const EntitlementsResponseSchema = z.object({
  capabilities: CapabilityListSchema,
  limits: LimitsSchema,
  usage: UsageSummarySchema,
});
export type EntitlementsResponse = z.infer<typeof EntitlementsResponseSchema>;

/** Deleting an account requires re-stating intent in the body. */
export const AccountDeleteRequestSchema = z.object({ confirm: z.literal('delete my account') }).strict();
