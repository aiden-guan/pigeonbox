import type { PigeonBoxCapability } from '@pigeonbox/api-contract';
import { z } from 'zod';
import { parseKeyring, type MasterKey } from './platform/crypto.js';
import { parseRollout } from './rollout.js';
import { parseNoticePolicy } from './intel/compose-policy.js';
import { parseClientConfig } from './client-config.js';

/** Must match `vector(768)` in the search migration. Providers are asked for this size; other sizes are resized. */
export const EMBEDDING_DIMENSIONS = 768;

/**
 * Worker environment → typed config. Every value arrives as a string from
 * wrangler vars/secrets. Production refuses development-only settings so a
 * missing secret fails loudly instead of silently running in mock mode.
 */
const list = z
  .string()
  .optional()
  .transform((value) => (value ?? '').split(',').map((item) => item.trim()).filter(Boolean));
const int = (fallback: number) =>
  z
    .string()
    .optional()
    .transform((value) => (value === undefined || value === '' ? fallback : Number(value)))
    .pipe(z.number().int().nonnegative());
const optional = z.string().optional().transform((value) => (value?.trim() ? value.trim() : undefined));

const EnvSchema = z.object({
  ENVIRONMENT: z.enum(['development', 'test', 'production']).default('development'),
  SERVICE_VERSION: z.string().default('0.1.0'),
  SERVICE_COMMIT: z.string().regex(/^[a-f0-9]{40}$/).optional(),
  API_BASE_URL: optional,
  PUBLIC_APP_URL: optional,
  ALLOWED_EXTENSION_IDS: list,
  ALLOWED_WEB_ORIGINS: list,
  /**
   * Who may use this server: email addresses and `@domain` entries, comma-separated,
   * or `*` for anyone who can sign in. Required in production; development defaults to `*`.
   */
  ALLOWED_EMAILS: list,

  AUTH_PROVIDER: z.enum(['supabase', 'dev']).default('dev'),
  AUTH_OAUTH_PROVIDER: z.string().default('google'),
  MCP_OAUTH_ENABLED: z.enum(['true', 'false']).default('false'),
  DEV_AUTH_SECRET: optional,

  DATA_STORE: z.enum(['supabase', 'memory']).optional(),
  SUPABASE_URL: optional,
  SUPABASE_ANON_KEY: optional,
  SUPABASE_SERVICE_ROLE_KEY: optional,
  SUPABASE_JWT_SECRET: optional,

  CLOUD_AI_PROVIDER: z.enum(['mock', 'cloudflare', 'openai_compatible']).default('mock'),
  CLOUD_AI_BASE_URL: optional,
  CLOUD_AI_API_KEY: optional,
  CLOUD_AI_GATEWAY_TOKEN: optional,
  CLOUD_AI_PRIMARY_MODEL: z.string().default('mock-small'),
  CLOUD_AI_FALLBACK_MODELS: list,
  CLOUD_AI_EMBED_MODEL: z.string().default('mock-embed'),
  CLOUD_AI_TIMEOUT_MS: int(30_000),
  /**
   * Processing tier for background AI (nobody waiting): flex is half price but slower and
   * sometimes out of capacity, so failed calls retry through the job queue. Interactive calls
   * always use standard. Set to standard to turn Flex off without a deploy of code.
   */
  CLOUD_AI_BACKGROUND_TIER: z.enum(['flex', 'standard']).default('flex'),
  /** Per-request timeout for Flex calls. Background jobs retry a timeout with backoff. */
  CLOUD_AI_FLEX_TIMEOUT_MS: int(60_000),
  CLOUD_AI_DAILY_REQUEST_LIMIT: int(500),
  /**
   * Optional per-user monthly AI budget in estimated micro-dollars (CLOUD_AI_*_COST_PER_1K_MICROS),
   * covering Ask, drafts and background analysis. 2_000_000 = $2. 0 (the default) turns it off.
   */
  CLOUD_AI_MONTHLY_BUDGET_MICROS: int(0),
  /** Optional hard cap on tokens per user per month, on top of the budget. 0 = off. */
  CLOUD_AI_MONTHLY_TOKEN_LIMIT: int(0),
  CLOUD_AI_RATE_LIMIT_PER_MINUTE: int(30),
  CLOUD_AI_GLOBAL_DAILY_TOKEN_BUDGET: int(50_000_000),
  /** Estimated cost in micro-dollars per 1K tokens, for usage records only. */
  CLOUD_AI_INPUT_COST_PER_1K_MICROS: int(0),
  CLOUD_AI_OUTPUT_COST_PER_1K_MICROS: int(0),
  /** Input tokens served from the provider's prompt cache. Unset: a tenth of the input cost. */
  CLOUD_AI_CACHED_INPUT_COST_PER_1K_MICROS: optional,
  /** Flex prices. Unset: half of the matching standard price (OpenAI's Flex discount). */
  CLOUD_AI_FLEX_INPUT_COST_PER_1K_MICROS: optional,
  CLOUD_AI_FLEX_CACHED_INPUT_COST_PER_1K_MICROS: optional,
  CLOUD_AI_FLEX_OUTPUT_COST_PER_1K_MICROS: optional,

  IP_HASH_SALT: optional,

  // --- Intelligence layer (always-on Cloud) --------------------------------
  /** Direct driver URL. Hyperdrive uses the Supabase session pooler on 5432. */
  DATABASE_URL: optional,
  /** `kid:base64(32 bytes),…`; the first key encrypts, all keys decrypt. */
  DATA_ENCRYPTION_KEYS: optional,
  GOOGLE_CLIENT_ID: optional,
  GOOGLE_CLIENT_SECRET: optional,
  /** Defaults to API_BASE_URL + /v1/connections/google/callback. */
  GOOGLE_REDIRECT_URI: optional,
  /** `projects/<project>/topics/<topic>` that Gmail publishes to. */
  GOOGLE_PUBSUB_TOPIC: optional,
  /** The audience configured on the Pub/Sub push subscription's OIDC token. */
  GOOGLE_PUBSUB_AUDIENCE: optional,
  /** The service account the push subscription signs with. */
  GOOGLE_PUBSUB_SERVICE_ACCOUNT: optional,
  /** Shared secret for `POST /internal/jobs/drain` (optional Supabase Cron → pg_net trigger). */
  INTERNAL_JOB_SECRET: optional,
  MAX_MAIL_ACCOUNTS: int(5),
  SYNC_BACKFILL_DAYS: int(30),
  /** Per-user daily limit for background AI (analysis, auto drafts, briefings). */
  CLOUD_AI_BACKGROUND_DAILY_LIMIT: int(1_500),
  /** Supabase Storage bucket for tracked documents (private). */
  DOCUMENTS_BUCKET: optional,
  DOCUMENT_MAX_BYTES: int(20_000_000),
  SEQUENCES_ENABLED: z.enum(['true', 'false']).default('false'),
  /** Public origin of the hosted tracker, for open tracking in sequences. */
  TRACKER_BASE_URL: optional,
  SEQUENCE_DAILY_LIMIT: int(50),
  WEB_SEARCH_PROVIDER: z.enum(['none', 'brave']).default('none'),
  WEB_SEARCH_API_KEY: optional,
  /** Server-side rollout stages and cohorts (rollout.ts). Empty: every feature on for every entitled user. */
  CLOUD_ROLLOUT: z.string().optional(),
  CLOUD_INTERNAL_USER_IDS: z.string().optional(),
  CLOUD_EARLY_BETA_USER_IDS: z.string().optional(),
  /** Per-category compose notice thresholds; can only tighten (intel/compose-policy.ts). */
  COMPOSE_NOTICE_POLICY: z.string().optional(),
  /** JSON served at GET /v1/client/config (client-config.ts). Non-secret tuning and kill switches only. */
  CLIENT_CONFIG: z.string().optional(),
});

export type RawEnv = Record<string, string | undefined>;
export type Config = ReturnType<typeof loadConfig>;

export class ConfigError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'ConfigError';
  }
}

/** Which Worker is loading config. The tracker neither runs AI nor serves the account site. */
export type Service = 'api' | 'tracker';

export function loadConfig(env: RawEnv, service: Service = 'api') {
  const parsed = EnvSchema.safeParse(env);
  if (!parsed.success) {
    throw new ConfigError(`Invalid configuration: ${parsed.error.issues.map((issue) => issue.path.join('.')).join(', ')}`);
  }
  const e = parsed.data;
  const hasSupabase = Boolean(e.SUPABASE_URL && e.SUPABASE_SERVICE_ROLE_KEY);
  const dataStore = e.DATA_STORE ?? (hasSupabase ? 'supabase' : 'memory');
  const production = e.ENVIRONMENT === 'production';

  const problems: string[] = [];
  if (e.MCP_OAUTH_ENABLED === 'true' && (e.AUTH_PROVIDER !== 'supabase' || !e.API_BASE_URL?.startsWith('https://') || !e.DATABASE_URL)) problems.push('MCP OAuth needs Supabase Auth, DATABASE_URL and an HTTPS API_BASE_URL');
  if (production) {
    if (e.AUTH_PROVIDER !== 'supabase') problems.push('AUTH_PROVIDER must be supabase in production');
    if (dataStore !== 'supabase') problems.push('DATA_STORE must be supabase in production');
    if (service === 'api' && e.CLOUD_AI_PROVIDER === 'mock') problems.push('CLOUD_AI_PROVIDER=mock is not allowed in production');
    if (!e.IP_HASH_SALT) problems.push('IP_HASH_SALT is required in production');
    if (!e.ALLOWED_EMAILS.length) problems.push('ALLOWED_EMAILS is required in production (addresses, @domains, or * for anyone)');
    if (service === 'api' && !e.PUBLIC_APP_URL?.startsWith('https://')) problems.push('PUBLIC_APP_URL must be https in production');
    // The monthly budget is counted in estimated cost; without prices it would never fill.
    if (service === 'api' && e.CLOUD_AI_MONTHLY_BUDGET_MICROS > 0 && !(e.CLOUD_AI_INPUT_COST_PER_1K_MICROS > 0 && e.CLOUD_AI_OUTPUT_COST_PER_1K_MICROS > 0)) {
      problems.push('CLOUD_AI_MONTHLY_BUDGET_MICROS needs CLOUD_AI_INPUT_COST_PER_1K_MICROS and CLOUD_AI_OUTPUT_COST_PER_1K_MICROS in production');
    }
  }
  if (e.AUTH_PROVIDER === 'supabase' && !(e.SUPABASE_URL && e.SUPABASE_ANON_KEY)) problems.push('AUTH_PROVIDER=supabase needs SUPABASE_URL and SUPABASE_ANON_KEY');
  if (e.AUTH_PROVIDER === 'dev' && !e.DEV_AUTH_SECRET) problems.push('AUTH_PROVIDER=dev needs DEV_AUTH_SECRET');
  if (dataStore === 'supabase' && !hasSupabase) problems.push('DATA_STORE=supabase needs SUPABASE_URL and SUPABASE_SERVICE_ROLE_KEY');
  if (service === 'api' && e.CLOUD_AI_PROVIDER !== 'mock' && !(e.CLOUD_AI_BASE_URL && e.CLOUD_AI_API_KEY)) problems.push(`CLOUD_AI_PROVIDER=${e.CLOUD_AI_PROVIDER} needs CLOUD_AI_BASE_URL and CLOUD_AI_API_KEY`);

  // The always-on layer is all-or-nothing per feature: a half-configured Google connection must fail loudly.
  let keyring: MasterKey[] = [];
  try {
    keyring = parseKeyring(e.DATA_ENCRYPTION_KEYS);
  } catch (error) {
    problems.push((error as Error).message);
  }
  const googleVars = [e.GOOGLE_CLIENT_ID, e.GOOGLE_CLIENT_SECRET, e.GOOGLE_PUBSUB_TOPIC, e.GOOGLE_PUBSUB_AUDIENCE, e.GOOGLE_PUBSUB_SERVICE_ACCOUNT];
  const googleAny = googleVars.some(Boolean);
  const googleAll = googleVars.every(Boolean);
  const apiBase = e.API_BASE_URL?.replace(/\/+$/, '');
  const redirectUri = e.GOOGLE_REDIRECT_URI ?? (apiBase ? `${apiBase}/v1/connections/google/callback` : undefined);
  if (googleAny && !googleAll) problems.push('Google connections need GOOGLE_CLIENT_ID, GOOGLE_CLIENT_SECRET, GOOGLE_PUBSUB_TOPIC, GOOGLE_PUBSUB_AUDIENCE and GOOGLE_PUBSUB_SERVICE_ACCOUNT together');
  if (googleAny && !e.DATABASE_URL) problems.push('Google connections need DATABASE_URL (or a Hyperdrive binding)');
  if (googleAny && !keyring.length) problems.push('Google connections need DATA_ENCRYPTION_KEYS');
  if (googleAny && !redirectUri) problems.push('Google connections need API_BASE_URL or GOOGLE_REDIRECT_URI');
  if (e.GOOGLE_PUBSUB_TOPIC && !/^projects\/[a-z][a-z0-9-]{4,62}\/topics\/[A-Za-z][\w.~%+-]{2,254}$/.test(e.GOOGLE_PUBSUB_TOPIC)) problems.push('GOOGLE_PUBSUB_TOPIC must look like projects/<project>/topics/<topic>');
  if (production && googleAny && !redirectUri?.startsWith('https://')) problems.push('GOOGLE_REDIRECT_URI must be https in production');
  if (e.DOCUMENTS_BUCKET && !hasSupabase) problems.push('DOCUMENTS_BUCKET needs SUPABASE_URL and SUPABASE_SERVICE_ROLE_KEY');
  if (e.DOCUMENTS_BUCKET && !e.DATABASE_URL) problems.push('DOCUMENTS_BUCKET needs DATABASE_URL');
  if (e.WEB_SEARCH_PROVIDER !== 'none' && !e.WEB_SEARCH_API_KEY) problems.push('WEB_SEARCH_PROVIDER needs WEB_SEARCH_API_KEY');
  if (production && e.DATABASE_URL && !keyring.length) problems.push('DATABASE_URL needs DATA_ENCRYPTION_KEYS in production');
  if (problems.length) throw new ConfigError(problems.join('; '));

  const price = (value: string | undefined, fallback: number) => (value !== undefined && Number.isFinite(Number(value)) && Number(value) >= 0 ? Number(value) : fallback);
  const standard = {
    input: e.CLOUD_AI_INPUT_COST_PER_1K_MICROS,
    cachedInput: price(e.CLOUD_AI_CACHED_INPUT_COST_PER_1K_MICROS, e.CLOUD_AI_INPUT_COST_PER_1K_MICROS / 10),
    output: e.CLOUD_AI_OUTPUT_COST_PER_1K_MICROS,
  };

  return {
    environment: e.ENVIRONMENT,
    production,
    version: e.SERVICE_VERSION,
    commit: e.SERVICE_COMMIT ?? null,
    apiBaseUrl: e.API_BASE_URL,
    publicAppUrl: e.PUBLIC_APP_URL,
    allowedExtensionIds: e.ALLOWED_EXTENSION_IDS,
    allowedWebOrigins: e.ALLOWED_WEB_ORIGINS,
    allowedEmails: e.ALLOWED_EMAILS.length ? e.ALLOWED_EMAILS.map((entry) => entry.toLowerCase()) : ['*'],
    auth: {
      provider: e.AUTH_PROVIDER,
      oauthProvider: e.AUTH_OAUTH_PROVIDER,
      mcpOAuthEnabled: e.MCP_OAUTH_ENABLED === 'true',
      devSecret: e.DEV_AUTH_SECRET,
    },
    dataStore,
    supabase: {
      url: e.SUPABASE_URL,
      anonKey: e.SUPABASE_ANON_KEY,
      serviceRoleKey: e.SUPABASE_SERVICE_ROLE_KEY,
      jwtSecret: e.SUPABASE_JWT_SECRET,
    },
    ai: {
      provider: e.CLOUD_AI_PROVIDER,
      baseUrl: e.CLOUD_AI_BASE_URL,
      apiKey: e.CLOUD_AI_API_KEY,
      gatewayToken: e.CLOUD_AI_GATEWAY_TOKEN,
      primaryModel: e.CLOUD_AI_PRIMARY_MODEL,
      fallbackModels: e.CLOUD_AI_FALLBACK_MODELS,
      embedModel: e.CLOUD_AI_EMBED_MODEL,
      timeoutMs: e.CLOUD_AI_TIMEOUT_MS,
      flexTimeoutMs: e.CLOUD_AI_FLEX_TIMEOUT_MS,
      backgroundTier: e.CLOUD_AI_BACKGROUND_TIER,
      /** Estimated micro-dollars per 1K tokens, per processing tier. Used for usage rows and the monthly budget. */
      pricing: {
        standard,
        flex: {
          input: price(e.CLOUD_AI_FLEX_INPUT_COST_PER_1K_MICROS, standard.input / 2),
          cachedInput: price(e.CLOUD_AI_FLEX_CACHED_INPUT_COST_PER_1K_MICROS, standard.cachedInput / 2),
          output: price(e.CLOUD_AI_FLEX_OUTPUT_COST_PER_1K_MICROS, standard.output / 2),
        },
      },
    },
    limits: {
      dailyRequests: e.CLOUD_AI_DAILY_REQUEST_LIMIT,
      monthlyTokens: e.CLOUD_AI_MONTHLY_TOKEN_LIMIT,
      monthlyBudgetMicros: e.CLOUD_AI_MONTHLY_BUDGET_MICROS,
      perMinute: e.CLOUD_AI_RATE_LIMIT_PER_MINUTE,
      globalDailyTokens: e.CLOUD_AI_GLOBAL_DAILY_TOKEN_BUDGET,
    },
    ipHashSalt: e.IP_HASH_SALT ?? 'pigeonbox-dev-salt',
    database: { url: e.DATABASE_URL },
    encryption: { keyring },
    google: googleAll
      ? {
          clientId: e.GOOGLE_CLIENT_ID!,
          clientSecret: e.GOOGLE_CLIENT_SECRET!,
          redirectUri: redirectUri!,
          pubsubTopic: e.GOOGLE_PUBSUB_TOPIC!,
          pubsubAudience: e.GOOGLE_PUBSUB_AUDIENCE!,
          pubsubServiceAccount: e.GOOGLE_PUBSUB_SERVICE_ACCOUNT!,
        }
      : null,
    internalJobSecret: e.INTERNAL_JOB_SECRET,
    rollout: parseRollout(e),
    composePolicy: parseNoticePolicy(e.COMPOSE_NOTICE_POLICY),
    clientConfig: parseClientConfig(e.CLIENT_CONFIG),
    intel: {
      maxMailAccounts: e.MAX_MAIL_ACCOUNTS,
      backfillDays: Math.min(365, Math.max(1, e.SYNC_BACKFILL_DAYS)),
      embedDimensions: EMBEDDING_DIMENSIONS,
      backgroundDailyLimit: e.CLOUD_AI_BACKGROUND_DAILY_LIMIT,
      documentsBucket: e.DOCUMENTS_BUCKET,
      documentMaxBytes: Math.min(100_000_000, e.DOCUMENT_MAX_BYTES),
      sequencesEnabled: e.SEQUENCES_ENABLED === 'true',
      sequenceDailyLimit: Math.min(500, e.SEQUENCE_DAILY_LIMIT),
      trackerBaseUrl: e.TRACKER_BASE_URL?.replace(/\/+$/, ''),
      webSearch: e.WEB_SEARCH_PROVIDER !== 'none' ? { provider: e.WEB_SEARCH_PROVIDER, apiKey: e.WEB_SEARCH_API_KEY! } : null,
    },
  };
}

/**
 * Capabilities this server can serve with its configuration. Every allowed
 * account gets all of them (entitlements.ts), so a capability is never
 * advertised without the infrastructure behind it.
 */
export function servedCapabilities(config: Config): Set<PigeonBoxCapability> {
  const served = new Set<PigeonBoxCapability>(['cloud_ai', 'cloud_tracking', 'ask_inbox']);
  const database = Boolean(config.database.url) && config.encryption.keyring.length > 0;
  if (database) {
    served.add('cloud_team');
    served.add('cloud_mcp');
  }
  if (database && config.google) {
    served.add('cloud_mail_sync');
    served.add('cloud_auto_drafts');
    served.add('cloud_automations');
    served.add('cloud_calendar');
    served.add('cloud_semantic_search');
    served.add('cloud_relationships');
    if (config.intel.sequencesEnabled) served.add('cloud_sequences');
  }
  if (database && config.intel.documentsBucket && config.supabase.url && config.supabase.serviceRoleKey) served.add('cloud_documents');
  return served;
}
