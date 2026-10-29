import { AuthorizeQuerySchema, DocumentSummarySchema, EmailAddressSchema, IdSchema, IsoSchema, OkResponseSchema, SharedThreadSchema, type RouteDef } from '@pigeonbox/api-contract';
import { z } from 'zod';

/**
 * Routes used only by the server's web dashboard (and not by the
 * public extension): workspace administration, API tokens, webhooks,
 * analytics, privacy tools, document uploads and sequences. Same conventions
 * as the public contract: POST with a validated body, validated responses,
 * capability gates.
 */

const Scope = z.enum(['read', 'prepare', 'write']);

const TokenSchema = z.object({
  id: IdSchema,
  name: z.string().max(120),
  prefix: z.string().max(12),
  scopes: z.array(Scope).max(3),
  lastUsedAt: IsoSchema.nullable(),
  expiresAt: IsoSchema.nullable(),
  revokedAt: IsoSchema.nullable(),
  createdAt: IsoSchema,
});

const EngagementRowSchema = z.object({
  key: z.string().max(320),
  sent: z.number().int(),
  opens: z.number().int(),
  emailsOpened: z.number().int(),
  clicks: z.number().int(),
  emailsClicked: z.number().int(),
  medianFirstOpenMinutes: z.number().nullable(),
  replies: z.number().int(),
  medianResponseHours: z.number().nullable(),
  followUpsDue: z.number().int(),
  followUpsAnswered: z.number().int(),
});

/**
 * Extension settings saved to the account (see intel/extension-settings.ts).
 * Plain setting values only: secrets are refused, and the extension checks
 * every key and value again before it applies a restore.
 */
const SECRET_SETTINGS = new Set(['aiApiKey', 'personalApiToken', 'cloudApiUrl']);
const ExtensionSettingScalarSchema = z.union([z.string().max(4000), z.number(), z.boolean(), z.null()]);
// Objects (the voice profile) are one level of plain values.
const ExtensionSettingValueSchema = z.union([ExtensionSettingScalarSchema, z.array(z.string().max(500)).max(500), z.record(z.string(), ExtensionSettingScalarSchema).refine((value) => Object.keys(value).length <= 40)]);
const ExtensionSettingsSchema = z.record(z.string().regex(/^[A-Za-z][A-Za-z0-9]{0,63}$/), ExtensionSettingValueSchema)
  .refine((settings) => Object.keys(settings).length <= 80, 'Too many settings.')
  .refine((settings) => !Object.keys(settings).some((key) => SECRET_SETTINGS.has(key)), 'Secrets are not saved to your account.');
const ExtensionSettingsBackupSchema = z.object({ settings: z.record(z.string(), ExtensionSettingValueSchema), rules: z.array(z.string().max(500)).max(100).nullable(), updatedAt: IsoSchema });

const AnalyticsRequestSchema = z.object({ from: z.string().max(40), to: z.string().max(40), groupBy: z.enum(['day', 'contact', 'domain']).default('day') });

const UnsubscribeMethodSchema = z.enum(['one_click', 'link', 'mailto', 'archive_only']);
const UnsubscribeStatusSchema = z.enum(['done', 'needs_user', 'failed']);

const SubscriptionSchema = z.object({
  accountId: IdSchema,
  account: z.string().max(320),
  email: z.string().max(320),
  name: z.string().max(200).nullable(),
  messages: z.number().int(),
  recent: z.number().int(),
  inInbox: z.number().int(),
  lastAt: IsoSchema,
  unsubscribed: z.object({ at: IsoSchema, method: UnsubscribeMethodSchema, status: UnsubscribeStatusSchema, silenced: z.boolean(), since: z.number().int() }).nullable(),
});

const UnsubscribeResultSchema = z.object({
  accountId: IdSchema,
  email: z.string().max(320),
  name: z.string().max(200).nullable(),
  method: UnsubscribeMethodSchema.nullable(),
  status: UnsubscribeStatusSchema,
  archived: z.number().int(),
  silenced: z.boolean(),
  followUp: z
    .discriminatedUnion('kind', [
      z.object({ kind: z.literal('open'), url: z.string().url().max(2_000) }),
      z.object({ kind: z.literal('email'), to: z.string().max(320), subject: z.string().max(300), body: z.string().max(2_000), gmailUrl: z.string().url().max(4_000) }),
    ])
    .optional(),
  message: z.string().max(400),
});

const SequenceStepSchema = z.object({
  delayBusinessDays: z.number().int().min(0).max(60),
  subject: z.string().min(1).max(500),
  body: z.string().min(1).max(10_000),
  aiPersonalize: z.boolean().default(false),
});

const SequenceSchema = z.object({
  id: IdSchema,
  name: z.string().max(120),
  status: z.string().max(20),
  accountId: IdSchema,
  dailyLimit: z.number().int(),
  window: z.object({ start: z.string().max(5), end: z.string().max(5) }),
  stopOnReply: z.boolean(),
  trackOpens: z.boolean(),
  steps: z.array(SequenceStepSchema).max(5),
  counts: z.object({ enrolled: z.number().int(), active: z.number().int(), replied: z.number().int(), sent: z.number().int(), pendingApproval: z.number().int() }),
  createdAt: IsoSchema,
});

const HourMinute = z.string().regex(/^([01]\d|2[0-3]):[0-5]\d$/);

const HealthLevelSchema = z.enum(['healthy', 'syncing', 'degraded', 'stale', 'action_required', 'failed']);
const HealthReasonsSchema = z.array(z.string().max(40)).max(20);
const HealthResponseSchema = z.object({
  generatedAt: IsoSchema,
  level: HealthLevelSchema,
  title: z.string().max(80),
  detail: z.string().max(200),
  cause: z.enum(['mail', 'calendar', 'intelligence', 'connection']).nullable(),
  mail: z.array(z.object({
    accountId: IdSchema,
    email: z.string().max(320),
    level: HealthLevelSchema,
    reasons: HealthReasonsSchema,
    lastPushAt: IsoSchema.nullable(),
    lastSyncAt: IsoSchema.nullable(),
    cursorBehind: z.boolean(),
    backfill: z.enum(['running', 'complete']),
    coverageSince: IsoSchema.nullable(),
    syncBacklog: z.number().int(),
    processingBacklog: z.number().int(),
    deadJobs24h: z.number().int(),
  })).max(20),
  calendar: z.array(z.object({ accountId: IdSchema, email: z.string().max(320), level: HealthLevelSchema, reasons: HealthReasonsSchema, lastRefreshAt: IsoSchema.nullable() })).max(20),
  intelligence: z.object({
    level: HealthLevelSchema,
    reasons: HealthReasonsSchema,
    analysisBacklog: z.number().int(),
    oldestPendingMinutes: z.number().int().nullable(),
    memoryPending: z.number().int(),
    draftsPreparing: z.number().int(),
    deadJobs24h: z.number().int(),
  }),
});

export const CONTROL_ROUTES = {
  controlMcpConfig: { method: 'GET', path: '/v1/control/mcp/config', auth: 'user', response: z.object({ oauthEnabled: z.boolean(), trackingConfigured: z.boolean() }), capability: 'cloud_mcp' },
  controlMcpOAuthDetails: { method: 'POST', path: '/v1/control/mcp/oauth/details', auth: 'user', request: z.object({ authorizationId: IdSchema }), response: z.union([z.object({ redirectUrl: z.string().url().max(6000) }), z.object({ authorizationId: IdSchema, clientId: IdSchema, clientName: z.string().max(300), identityScopes: z.string().max(1000), redirectUri: z.string().url().max(4000) })]), capability: 'cloud_mcp' },
  controlMcpOAuthDecide: { method: 'POST', path: '/v1/control/mcp/oauth/decide', auth: 'user', request: z.object({ authorizationId: IdSchema, decision: z.enum(['approve', 'deny']), scopes: z.array(Scope).min(1).max(3) }), response: z.object({ redirectUrl: z.string().url().max(6000) }), capability: 'cloud_mcp' },
  controlAuthLink: { method: 'POST', path: '/v1/auth/link', auth: 'user', request: AuthorizeQuerySchema.extend({ code_challenge: z.string().regex(/^[A-Za-z0-9_-]{43}$/) }), response: z.object({ code: z.string().min(8).max(512), state: z.string().min(16).max(200) }) },
  controlOverview: {
    method: 'GET',
    path: '/v1/control/overview',
    auth: 'user',
    response: z.object({
      connections: z.number().int(),
      syncHealthy: z.boolean(),
      focus: z.record(z.string().max(20), z.number().int()),
      pendingApprovals: z.number().int(),
      followUpsDue: z.number().int(),
      draftsReady: z.number().int(),
      latestBriefing: z.object({ id: IdSchema, title: z.string().max(200), generatedAt: IsoSchema }).nullable(),
      usage: z.object({ backgroundToday: z.number().int(), tokensThisMonth: z.number().int() }),
    }),
    capability: 'cloud_mail_sync',
  },
  /** Derived, read-only health for Overview and Connections (intel/health.ts). Fixed codes, no content. */
  controlHealth: {
    method: 'GET',
    path: '/v1/control/health',
    auth: 'user',
    response: HealthResponseSchema,
    capability: 'cloud_mail_sync',
  },
  controlWorkspaceCreate: { method: 'POST', path: '/v1/control/workspaces/create', auth: 'user', request: z.object({ name: z.string().min(1).max(120) }), response: z.object({ id: IdSchema }), capability: 'cloud_team' },
  controlWorkspaceInvite: { method: 'POST', path: '/v1/control/workspaces/invite', auth: 'user', request: z.object({ workspaceId: IdSchema, email: EmailAddressSchema, role: z.enum(['admin', 'member']).default('member') }), response: z.object({ id: IdSchema, url: z.string().url().max(2_000) }), capability: 'cloud_team' },
  controlWorkspaceAccept: { method: 'POST', path: '/v1/control/workspaces/accept', auth: 'user', request: z.object({ token: z.string().min(16).max(200) }), response: z.object({ workspaceId: IdSchema }), capability: 'cloud_team' },
  controlMemberUpdate: { method: 'POST', path: '/v1/control/workspaces/member', auth: 'user', request: z.object({ workspaceId: IdSchema, userId: IdSchema, role: z.enum(['admin', 'member']).optional(), remove: z.boolean().optional() }), response: OkResponseSchema, capability: 'cloud_team' },
  controlAssigned: { method: 'GET', path: '/v1/control/team/assigned', auth: 'user', response: z.object({ shares: z.array(SharedThreadSchema).max(50) }), capability: 'cloud_team' },
  controlShare: { method: 'POST', path: '/v1/control/team/share', auth: 'user', request: z.object({ shareId: IdSchema }), response: z.object({ share: SharedThreadSchema }), capability: 'cloud_team' },

  controlTokens: { method: 'GET', path: '/v1/control/tokens', auth: 'user', response: z.object({ tokens: z.array(TokenSchema).max(200) }), capability: 'cloud_mcp' },
  controlTokenCreate: {
    method: 'POST',
    path: '/v1/control/tokens/create',
    auth: 'user',
    request: z.object({ name: z.string().min(1).max(120), scopes: z.array(Scope).min(1).max(3), expiresInDays: z.number().int().min(1).max(365).nullable().default(90) }),
    response: z.object({ id: IdSchema, token: z.string().max(200), name: z.string().max(120), scopes: z.array(Scope), prefix: z.string().max(12), expiresAt: IsoSchema.nullable(), createdAt: IsoSchema }),
    capability: 'cloud_mcp',
  },
  controlTokenRevoke: { method: 'POST', path: '/v1/control/tokens/revoke', auth: 'user', request: z.object({ id: IdSchema }), response: OkResponseSchema, capability: 'cloud_mcp' },
  controlWebhooks: {
    method: 'GET',
    path: '/v1/control/webhooks',
    auth: 'user',
    response: z.object({ webhooks: z.array(z.object({ id: IdSchema, url: z.string().max(2_000), events: z.array(z.string().max(40)), enabled: z.boolean(), failures: z.number().int(), lastStatus: z.number().int().nullable(), lastDeliveryAt: IsoSchema.nullable(), createdAt: IsoSchema })).max(50) }),
    capability: 'cloud_mcp',
  },
  controlWebhookCreate: { method: 'POST', path: '/v1/control/webhooks/create', auth: 'user', request: z.object({ url: z.string().url().max(2_000), events: z.array(z.string().max(40)).min(1).max(10) }), response: z.object({ id: IdSchema, url: z.string().max(2_000), events: z.array(z.string()), secret: z.string().max(100) }), capability: 'cloud_mcp' },
  controlWebhookDelete: { method: 'POST', path: '/v1/control/webhooks/delete', auth: 'user', request: z.object({ id: IdSchema }), response: OkResponseSchema, capability: 'cloud_mcp' },

  controlAnalytics: { method: 'POST', path: '/v1/control/analytics', auth: 'user', request: AnalyticsRequestSchema, response: z.object({ rows: z.array(EngagementRowSchema).max(1000), totals: z.record(z.string().max(40), z.number()), notes: z.array(z.string().max(300)).max(6) }), capability: 'cloud_tracking' },
  controlAnalyticsExport: { method: 'POST', path: '/v1/control/analytics/export', auth: 'user', request: AnalyticsRequestSchema, response: z.object({ filename: z.string().max(100), csv: z.string().max(2_000_000) }), capability: 'cloud_tracking' },
  controlActivity: {
    method: 'POST',
    path: '/v1/control/activity',
    auth: 'user',
    request: z.object({ limit: z.number().int().min(1).max(200).default(50) }),
    response: z.object({ items: z.array(z.object({ at: IsoSchema, kind: z.string().max(40), label: z.string().max(200), threadId: z.string().max(64).nullable() })).max(200) }),
    capability: 'cloud_relationships',
  },

  controlPrivacy: {
    method: 'GET',
    path: '/v1/control/privacy',
    auth: 'user',
    response: z.object({ inventory: z.array(z.object({ table: z.string().max(60), label: z.string().max(200), content: z.enum(['metadata', 'encrypted', 'configuration']), count: z.number().int() })).max(40), fastRecall: z.object({ enabled: z.boolean(), retentionDays: z.number().int() }) }),
    capability: 'cloud_mail_sync',
  },
  controlPurgeMail: { method: 'POST', path: '/v1/control/privacy/purge-mail', auth: 'user', request: z.object({ confirm: z.literal('delete synced mail data') }), response: z.object({ removed: z.number().int() }), capability: 'cloud_mail_sync' },

  controlDocumentCreate: {
    method: 'POST',
    path: '/v1/control/documents/create',
    auth: 'user',
    request: z.object({ title: z.string().min(1).max(300), filename: z.string().min(1).max(255) }),
    response: z.object({ document: DocumentSummarySchema, uploadPath: z.string().max(200) }),
    capability: 'cloud_documents',
  },
  controlDocumentDelete: { method: 'POST', path: '/v1/control/documents/delete', auth: 'user', request: z.object({ id: IdSchema }), response: OkResponseSchema, capability: 'cloud_documents' },
  controlDocumentPreview: { method: 'POST', path: '/v1/control/documents/preview', auth: 'user', request: z.object({ linkId: IdSchema }), response: z.object({ url: z.string().url().max(4000) }), capability: 'cloud_documents' },

  controlSequences: { method: 'GET', path: '/v1/control/sequences', auth: 'user', response: z.object({ sequences: z.array(SequenceSchema).max(200), dailyLimit: z.number().int() }), capability: 'cloud_sequences' },
  controlSequenceSave: {
    method: 'POST',
    path: '/v1/control/sequences/save',
    auth: 'user',
    request: z.object({ id: IdSchema.optional(), name: z.string().min(1).max(120), accountId: IdSchema, dailyLimit: z.number().int().min(1).max(500).default(25), window: z.object({ start: HourMinute, end: HourMinute }).default(() => ({ start: '09:00', end: '17:00' })), stopOnReply: z.boolean().default(true), trackOpens: z.boolean().default(false), steps: z.array(SequenceStepSchema).min(1).max(5) }),
    response: z.object({ id: IdSchema }),
    capability: 'cloud_sequences',
  },
  controlSequenceEnroll: {
    method: 'POST',
    path: '/v1/control/sequences/enroll',
    auth: 'user',
    request: z.object({ sequenceId: IdSchema, recipients: z.array(z.object({ email: z.string().max(320), fields: z.record(z.string().max(40), z.string().max(500)).default(() => ({})) })).min(1).max(500) }),
    response: z.object({ added: z.number().int(), suppressed: z.number().int(), invalid: z.number().int() }),
    capability: 'cloud_sequences',
  },
  controlSequenceStatus: {
    method: 'POST',
    path: '/v1/control/sequences/status',
    auth: 'user',
    request: z.object({ sequenceId: IdSchema, status: z.enum(['active', 'paused', 'stopped']) }),
    response: z.object({ approvalId: IdSchema.nullable(), count: z.number().int(), blocked: z.number().int() }),
    capability: 'cloud_sequences',
  },
  controlSuppressions: { method: 'GET', path: '/v1/control/suppressions', auth: 'user', response: z.object({ suppressions: z.array(z.object({ email: z.string().max(320), reason: z.string().max(20), createdAt: IsoSchema })).max(1000) }), capability: 'cloud_sequences' },
  controlSuppressionUpdate: { method: 'POST', path: '/v1/control/suppressions/update', auth: 'user', request: z.object({ email: EmailAddressSchema, action: z.enum(['add', 'remove']) }), response: OkResponseSchema, capability: 'cloud_sequences' },

  // Mailing lists: senders with a List-Unsubscribe header, and leaving them (intel/subscriptions.ts).
  controlSubscriptions: {
    method: 'POST',
    path: '/v1/control/subscriptions',
    auth: 'user',
    request: z.object({ query: z.string().max(200).optional(), limit: z.number().int().min(1).max(500).optional() }),
    response: z.object({ subscriptions: z.array(SubscriptionSchema).max(500), canArchive: z.boolean() }),
    capability: 'cloud_mail_sync',
  },
  controlUnsubscribe: {
    method: 'POST',
    path: '/v1/control/subscriptions/unsubscribe',
    auth: 'user',
    request: z.object({ senders: z.array(z.object({ accountId: IdSchema, email: EmailAddressSchema })).min(1).max(50), archive: z.boolean().default(true) }),
    response: z.object({ results: z.array(UnsubscribeResultSchema).max(50) }),
    capability: 'cloud_mail_sync',
  },
  controlSubscriptionUpdate: {
    method: 'POST',
    path: '/v1/control/subscriptions/update',
    auth: 'user',
    request: z.object({ accountId: IdSchema, email: EmailAddressSchema, silence: z.boolean() }),
    response: OkResponseSchema,
    capability: 'cloud_mail_sync',
  },

  // The extension's settings, kept with the account so they survive a reinstall. Any signed-in account.
  controlExtensionSettings: { method: 'GET', path: '/v1/control/extension-settings', auth: 'user', response: z.object({ backup: ExtensionSettingsBackupSchema.nullable() }) },
  controlExtensionSettingsSave: {
    method: 'POST',
    path: '/v1/control/extension-settings/save',
    auth: 'user',
    // `replace` stores a whole snapshot; otherwise `settings` is merged over what is saved.
    request: z.object({ settings: ExtensionSettingsSchema, rules: z.array(z.string().max(500)).max(100).optional(), replace: z.boolean().default(false) }),
    response: z.object({ backup: ExtensionSettingsBackupSchema }),
  },

  controlTasks: {
    method: 'GET',
    path: '/v1/control/tasks',
    auth: 'user',
    response: z.object({ tasks: z.array(z.object({ id: IdSchema, title: z.string().max(300), threadId: z.string().max(64).nullable(), dueAt: IsoSchema.nullable(), status: z.string().max(20), createdAt: IsoSchema })).max(200) }),
    capability: 'cloud_automations',
  },
  controlTaskUpdate: { method: 'POST', path: '/v1/control/tasks/update', auth: 'user', request: z.object({ id: IdSchema, status: z.enum(['open', 'done', 'cancelled']) }), response: OkResponseSchema, capability: 'cloud_automations' },
} as const satisfies Record<string, RouteDef>;

export type ControlRouteName = keyof typeof CONTROL_ROUTES;
