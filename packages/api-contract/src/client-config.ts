import { z } from 'zod';
import { ComposeCheckKindSchema } from './compose.js';

/**
 * Remote client configuration: non-secret tuning the extension can take from
 * PigeonBox Cloud without a Chrome Web Store update.
 *
 * Safety rules, enforced by this module rather than by convention:
 * - Every field is allowlisted and typed. Numbers have hard bounds; a value out
 *   of bounds is ignored (the built-in default stays), never clamped toward it.
 * - Remote config can only make the extension do less: it can switch a client
 *   feature off, never on beyond what the person and their plan already allow.
 * - There are no URLs, routes, permissions, scopes, HTML, CSS, scripts, free
 *   text or secrets. Maintenance wording is an enum the extension renders itself.
 * - An unknown schema version is ignored as a whole. Unknown fields are dropped.
 * - The extension must behave correctly with no remote config at all:
 *   `DEFAULT_CLIENT_CONFIG` is that behavior.
 */
export const CLIENT_CONFIG_SCHEMA_VERSION = 1;

/** Client features that remote config may switch off in an emergency. */
export const CLIENT_FEATURES = ['compose_checks', 'compose_completion', 'prepared_drafts', 'cloud_notifications'] as const;
export type ClientFeature = (typeof CLIENT_FEATURES)[number];

/** Banner codes; the extension owns the wording. */
export const CLIENT_NOTICE_CODES = ['maintenance', 'degraded'] as const;
export type ClientNoticeCode = (typeof CLIENT_NOTICE_CODES)[number];

/** Inclusive bounds. Values outside them are ignored. */
export const CLIENT_CONFIG_BOUNDS = {
  ttlSeconds: [300, 86_400],
  composeIdleMs: [250, 2_000],
  composeCooldownMs: [1_000, 15_000],
  composeCacheMs: [0, 60_000],
  notificationPollMinutes: [2, 30],
} as const satisfies Record<string, readonly [number, number]>;

const SEMVER = /^\d{1,4}\.\d{1,4}\.\d{1,4}$/;
const bounded = (key: keyof typeof CLIENT_CONFIG_BOUNDS) => z.number().int().min(CLIENT_CONFIG_BOUNDS[key][0]).max(CLIENT_CONFIG_BOUNDS[key][1]);

/** The authored shape (server side, strict). Every field is optional. */
export const ClientConfigSchema = z
  .object({
    compose: z
      .object({
        idleMs: bounded('composeIdleMs').optional(),
        cooldownMs: bounded('composeCooldownMs').optional(),
        cacheMs: bounded('composeCacheMs').optional(),
        disabledKinds: z.array(ComposeCheckKindSchema).max(10).optional(),
      })
      .strict()
      .optional(),
    notifications: z.object({ pollMinutes: bounded('notificationPollMinutes').optional() }).strict().optional(),
    disabledFeatures: z.array(z.enum(CLIENT_FEATURES)).max(CLIENT_FEATURES.length).optional(),
    compatibility: z
      .object({ minimumVersion: z.string().regex(SEMVER).optional(), recommendedVersion: z.string().regex(SEMVER).optional() })
      .strict()
      .optional(),
    notice: z.object({ code: z.enum(CLIENT_NOTICE_CODES) }).strict().optional(),
  })
  .strict();
export type ClientConfigInput = z.infer<typeof ClientConfigSchema>;

/**
 * `GET /v1/client/config`. Deliberately loose on the wire so a newer server can
 * add fields; `resolveClientConfig` is where every value is checked.
 */
export const ClientConfigResponseSchema = z
  .object({
    schema: z.number().int(),
    revision: z.string().min(1).max(64),
    ttlSeconds: z.number().optional(),
    config: z.record(z.unknown()).optional(),
  })
  .passthrough();
export type ClientConfigResponse = z.infer<typeof ClientConfigResponseSchema>;

/** What the extension actually uses. */
export type ClientConfig = {
  schema: typeof CLIENT_CONFIG_SCHEMA_VERSION;
  /** `default` when nothing remote applies. */
  revision: string;
  ttlSeconds: number;
  compose: { idleMs: number; cooldownMs: number; cacheMs: number; disabledKinds: Array<z.infer<typeof ComposeCheckKindSchema>> };
  notifications: { pollMinutes: number };
  disabledFeatures: ClientFeature[];
  compatibility: { minimumVersion: string | null; recommendedVersion: string | null };
  notice: { code: ClientNoticeCode } | null;
};

export const DEFAULT_CLIENT_CONFIG: Readonly<ClientConfig> = Object.freeze({
  schema: CLIENT_CONFIG_SCHEMA_VERSION,
  revision: 'default',
  ttlSeconds: 3_600,
  compose: Object.freeze({ idleMs: 450, cooldownMs: 2_800, cacheMs: 30_000, disabledKinds: [] }),
  notifications: Object.freeze({ pollMinutes: 2 }),
  disabledFeatures: [],
  compatibility: Object.freeze({ minimumVersion: null, recommendedVersion: null }),
  notice: null,
}) as Readonly<ClientConfig>;

const REVISION = /^[A-Za-z0-9._:-]{1,64}$/;

function field<T>(schema: z.ZodType<T>, value: unknown, fallback: T): T {
  const parsed = schema.safeParse(value);
  return parsed.success ? parsed.data : fallback;
}

function record(value: unknown): Record<string, unknown> {
  return value && typeof value === 'object' && !Array.isArray(value) ? (value as Record<string, unknown>) : {};
}

/**
 * Turn an untrusted response into the config the client runs with. Returns null
 * when the response cannot be used at all (wrong schema version, no revision),
 * so the caller keeps its last known good config. Each remaining field is
 * validated on its own: one bad value never discards the others.
 */
export function resolveClientConfig(response: unknown): ClientConfig | null {
  const raw = record(response);
  if (raw.schema !== CLIENT_CONFIG_SCHEMA_VERSION || typeof raw.revision !== 'string' || !REVISION.test(raw.revision)) return null;
  const d = DEFAULT_CLIENT_CONFIG;
  const config = record(raw.config);
  const compose = record(config.compose);
  const compat = record(config.compatibility);
  const notice = field(z.object({ code: z.enum(CLIENT_NOTICE_CODES) }), config.notice, null as { code: ClientNoticeCode } | null);
  return {
    schema: CLIENT_CONFIG_SCHEMA_VERSION,
    revision: raw.revision,
    ttlSeconds: field(bounded('ttlSeconds'), raw.ttlSeconds, d.ttlSeconds),
    compose: {
      idleMs: field(bounded('composeIdleMs'), compose.idleMs, d.compose.idleMs),
      cooldownMs: field(bounded('composeCooldownMs'), compose.cooldownMs, d.compose.cooldownMs),
      cacheMs: field(bounded('composeCacheMs'), compose.cacheMs, d.compose.cacheMs),
      // Unknown kinds (from a newer server) are dropped individually.
      disabledKinds: Array.isArray(compose.disabledKinds)
        ? [...new Set(compose.disabledKinds.slice(0, 10).filter((kind) => ComposeCheckKindSchema.safeParse(kind).success))] as ClientConfig['compose']['disabledKinds']
        : [],
    },
    notifications: { pollMinutes: field(bounded('notificationPollMinutes'), record(config.notifications).pollMinutes, d.notifications.pollMinutes) },
    disabledFeatures: Array.isArray(config.disabledFeatures)
      ? [...new Set(config.disabledFeatures.filter((name): name is ClientFeature => (CLIENT_FEATURES as readonly unknown[]).includes(name)))]
      : [],
    compatibility: {
      minimumVersion: field(z.string().regex(SEMVER), compat.minimumVersion, null as string | null),
      recommendedVersion: field(z.string().regex(SEMVER), compat.recommendedVersion, null as string | null),
    },
    notice,
  };
}

/** Numeric semver comparison; null when either side is not X.Y.Z. */
export function compareClientVersions(left: string, right: string): number | null {
  const parse = (value: string) => (SEMVER.test(value) ? value.split('.').map(Number) : null);
  const a = parse(left);
  const b = parse(right);
  if (!a || !b) return null;
  for (let index = 0; index < 3; index += 1) if (a[index] !== b[index]) return a[index]! - b[index]!;
  return 0;
}

export type ClientCompatibility = 'compatible' | 'update_recommended' | 'update_required';

/**
 * Where an installed version stands against the server's minimums. A version
 * that is not X.Y.Z (a source build) is never told to update.
 */
export function clientCompatibility(version: string, compatibility: { minimumVersion?: string | null; recommendedVersion?: string | null }): ClientCompatibility {
  const below = (target?: string | null) => Boolean(target) && (compareClientVersions(version, target!) ?? 0) < 0;
  if (below(compatibility.minimumVersion)) return 'update_required';
  if (below(compatibility.recommendedVersion)) return 'update_recommended';
  return 'compatible';
}

/** The extension version in `x-pigeonbox-client: extension/X.Y.Z`, or null. */
export function extensionVersionFromClientHeader(value: string | null | undefined): string | null {
  const match = /^extension\/(\d{1,4}\.\d{1,4}\.\d{1,4})$/.exec(value?.trim() ?? '');
  return match ? match[1]! : null;
}
