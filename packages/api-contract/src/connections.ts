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

export const SyncHealthSchema = z.object({
  state: SyncStateSchema,
  lastSyncAt: IsoSchema.nullable(),
  lastPushAt: IsoSchema.nullable(),
  watchExpiresAt: IsoSchema.nullable(),
  /** Jobs waiting for this account. */
  backlog: z.number().int().nonnegative(),
  lastErrorCode: z.string().max(64).nullable(),
  /** Oldest message date PigeonBox has synced, which bounds answers about older mail. */
  coverageSince: IsoSchema.nullable(),
  threadsTracked: z.number().int().nonnegative(),
});
export type SyncHealth = z.infer<typeof SyncHealthSchema>;

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
