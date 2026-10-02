import { z } from 'zod';
import { EmailAddressSchema, IdSchema, IsoSchema } from './common.js';

/**
 * Cloud-only Google connections. PigeonBox Cloud holds the Google credentials
 * server-side (encrypted); the extension and web app only see connection
 * status. Local mode never uses a Google API and never needs this.
 *
 * Features map to the narrowest Google scopes the server can use for them and
 * are requested incrementally. Sending is its own feature and is never needed
 * for the rest of Cloud.
 */
export const CONNECTION_FEATURES = ['mail_read', 'drafts', 'organize', 'calendar_read', 'calendar_write', 'send'] as const;
export const ConnectionFeatureSchema = z.enum(CONNECTION_FEATURES);
export type ConnectionFeature = z.infer<typeof ConnectionFeatureSchema>;

export const CONNECTION_FEATURE_COPY: Record<ConnectionFeature, { title: string; detail: string }> = {
  mail_read: { title: 'Read and sync mail', detail: 'Keeps triage, follow-ups and drafts current while Gmail is closed.' },
  drafts: { title: 'Create drafts', detail: 'Places prepared drafts in Gmail. Nothing is sent.' },
  organize: { title: 'Organize mail', detail: 'Applies labels and archives for rules you turn on. Every change is undoable.' },
  calendar_read: { title: 'Read calendar', detail: 'Finds free time and prepares meeting briefs.' },
  calendar_write: { title: 'Add calendar events', detail: 'Creates events after you approve them.' },
  send: { title: 'Send mail', detail: 'Only sends messages you approve. Off unless you turn it on.' },
};

export const ConnectionStatusSchema = z.enum(['active', 'needs_reauth', 'paused', 'error', 'disconnected']);
export type ConnectionStatus = z.infer<typeof ConnectionStatusSchema>;

export const SyncStateSchema = z.enum(['initializing', 'healthy', 'catching_up', 'recovering', 'degraded', 'stalled', 'paused']);

/**
 * One plain answer to "is my mail current, and is PigeonBox still working?".
 * Mail synchronization and the AI review that follows it are separate: an
 * account is `analyzing` when Gmail is fully synced but new conversations are
 * still being reviewed, never "syncing".
 */
export const SYNC_PHASES = ['importing', 'recovering', 'catching_up', 'analyzing', 'up_to_date', 'degraded', 'stalled', 'needs_reauth', 'paused'] as const;
export const SyncPhaseSchema = z.enum(SYNC_PHASES);
export type SyncPhase = z.infer<typeof SyncPhaseSchema>;

export const SyncHealthSchema = z.object({
  state: SyncStateSchema,
  lastSyncAt: IsoSchema.nullable(),
  lastPushAt: IsoSchema.nullable(),
  watchExpiresAt: IsoSchema.nullable(),
  /**
   * Deprecated: every queued job for the account, including AI analysis, so it
   * does not say whether mail is current. Use `syncBacklog` and `processingBacklog`.
   */
  backlog: z.number().int().nonnegative(),
  /** Gmail sync and recovery jobs still waiting. Only these mean mail may not be current. */
  syncBacklog: z.number().int().nonnegative().optional(),
  /** Synced conversations still waiting for AI review. Mail itself can already be current. */
  processingBacklog: z.number().int().nonnegative().optional(),
  /** Derived with `syncPhase`. Optional so newer clients keep working with older servers. */
  phase: SyncPhaseSchema.optional(),
  lastErrorCode: z.string().max(64).nullable(),
  /** Oldest message date PigeonBox has synced, which bounds answers about older mail. */
  coverageSince: IsoSchema.nullable(),
  threadsTracked: z.number().int().nonnegative(),
});
export type SyncHealth = z.infer<typeof SyncHealthSchema>;

type PhaseInput = { status: ConnectionStatus; sync: Pick<SyncHealth, 'state' | 'coverageSince' | 'syncBacklog' | 'processingBacklog' | 'phase'> };

/**
 * The account's phase. The server sets `sync.phase` with this function; a
 * client talking to an older server derives it from the other fields. Only
 * Gmail sync work affects mail freshness; analysis work never does.
 */
export function syncPhase(account: PhaseInput): SyncPhase {
  if (account.sync.phase) return account.sync.phase;
  if (account.status === 'needs_reauth') return 'needs_reauth';
  if (account.status === 'paused' || account.sync.state === 'paused') return 'paused';
  if (account.status === 'error' || account.sync.state === 'stalled') return 'stalled';
  if (account.sync.state === 'degraded') return 'degraded';
  if (account.sync.state === 'initializing') return 'importing';
  // A recovery before the first completed import is still the first import.
  if (account.sync.state === 'recovering') return account.sync.coverageSince ? 'recovering' : 'importing';
  if (account.sync.state === 'catching_up' || (account.sync.syncBacklog ?? 0) > 0) return 'catching_up';
  if ((account.sync.processingBacklog ?? 0) > 0) return 'analyzing';
  return 'up_to_date';
}

export const MailAccountSchema = z.object({
  id: IdSchema,
  provider: z.literal('google'),
  email: z.string().max(320),
  displayName: z.string().max(200).nullable(),
  status: ConnectionStatusSchema,
  features: z.array(ConnectionFeatureSchema).max(CONNECTION_FEATURES.length),
  sync: SyncHealthSchema,
  connectedAt: IsoSchema,
});
export type MailAccount = z.infer<typeof MailAccountSchema>;

export const ConnectionsResponseSchema = z.object({
  accounts: z.array(MailAccountSchema).max(20),
  /** Google OAuth is configured on this server. */
  googleConfigured: z.boolean(),
  maxAccounts: z.number().int().nonnegative(),
});

export const ConnectStartRequestSchema = z.object({
  features: z.array(ConnectionFeatureSchema).min(1).max(CONNECTION_FEATURES.length),
  /** Add features to an existing connection (incremental authorization). */
  accountId: IdSchema.optional(),
  loginHint: EmailAddressSchema.optional(),
  /** Where the browser lands afterwards. */
  returnTo: z.enum(['extension', 'web']).default('web'),
});
export const ConnectStartResponseSchema = z.object({ url: z.string().url().max(4_000) });

export const ConnectionUpdateRequestSchema = z.object({ accountId: IdSchema, paused: z.boolean() });
export const ConnectionDisconnectRequestSchema = z.object({
  accountId: IdSchema,
  /** Also delete everything synced from this account. Credentials are always deleted. */
  deleteData: z.boolean(),
});
export const ConnectionResyncRequestSchema = z.object({ accountId: IdSchema });
export const ConnectionResponseSchema = z.object({ account: MailAccountSchema });
