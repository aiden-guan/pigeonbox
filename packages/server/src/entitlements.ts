import type { PigeonBoxCapability } from '@pigeonbox/api-contract';
import { isAllowedEmail } from './auth.js';
import { servedCapabilities, type Config } from './config.js';
import type { CloudStore } from './store/types.js';

/**
 * What an account may use, decided only here, on the server. There are no
 * plans: an account on the server's ALLOWED_EMAILS list gets every capability
 * this server has the infrastructure for (`servedCapabilities`), and anyone
 * else gets none. Clients receive the capability list.
 *
 * The limits are the server owner's safety net against runaway AI spend.
 */
export type Entitlements = {
  capabilities: PigeonBoxCapability[];
  limits: { aiRequestsPerDay: number | null; aiTokensPerMonth: number | null; aiRequestsPerMinute: number | null };
  /** Monthly AI budget per account in estimated micro-dollars; null when unlimited. Never sent to clients. */
  monthlyBudgetMicros: number | null;
};

const NONE: Entitlements = {
  capabilities: [],
  limits: { aiRequestsPerDay: 0, aiTokensPerMonth: 0, aiRequestsPerMinute: 0 },
  monthlyBudgetMicros: 0,
};

export async function getEntitlements(userId: string, store: CloudStore, config: Config): Promise<Entitlements> {
  // The access list is checked at sign-in too; checking again here also covers API
  // tokens and background jobs of an account removed from the list later.
  if (!config.allowedEmails.includes('*') && !isAllowedEmail(await store.profileEmail(userId), config.allowedEmails)) return NONE;
  return {
    capabilities: [...servedCapabilities(config)],
    limits: {
      aiRequestsPerDay: config.limits.dailyRequests || null,
      aiTokensPerMonth: config.limits.monthlyTokens || null,
      aiRequestsPerMinute: config.limits.perMinute || null,
    },
    monthlyBudgetMicros: config.limits.monthlyBudgetMicros || null,
  };
}

export function hasCapability(entitlements: Entitlements, capability: PigeonBoxCapability): boolean {
  return entitlements.capabilities.includes(capability);
}
