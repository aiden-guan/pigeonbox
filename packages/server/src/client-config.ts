import {
  CLIENT_CONFIG_SCHEMA_VERSION,
  ClientConfigSchema,
  compareClientVersions,
  extensionVersionFromClientHeader,
  type ClientConfigInput,
  type ClientConfigResponse,
} from '@pigeonbox/api-contract';

/**
 * `CLIENT_CONFIG` → what `GET /v1/client/config` serves. The schema (and its
 * bounds and allowlists) lives in @pigeonbox/api-contract; the extension
 * re-validates every field anyway. A value that does not parse is ignored as a
 * whole and logged, so a typo never ships half a config.
 */
export type ServedClientConfig = {
  config: ClientConfigInput;
  revision: string;
  /** Extensions below this version get 426 on gated routes. */
  minimumVersion: string | null;
  invalid: boolean;
};

/** How long an extension keeps a fetched config before asking again. */
export const CLIENT_CONFIG_TTL_SECONDS = 900;

/** Routes an outdated extension can still use: discovery, signing out, and forgetting or deleting data. */
export const VERSION_GATE_EXEMPT: ReadonlySet<string> = new Set(['health', 'version', 'clientConfig', 'authSignOut', 'accountDelete', 'memoryForget', 'memoryPurge']);

/** Stable, order-independent JSON for the revision hash. */
function canonical(value: unknown): string {
  if (Array.isArray(value)) return `[${value.map(canonical).join(',')}]`;
  if (value && typeof value === 'object') {
    return `{${Object.keys(value).sort().map((key) => `${JSON.stringify(key)}:${canonical((value as Record<string, unknown>)[key])}`).join(',')}}`;
  }
  return JSON.stringify(value);
}

/** FNV-1a: a short revision that changes when the config does. Not a security boundary. */
function fnv1a(text: string): string {
  let hash = 0x811c9dc5;
  for (let index = 0; index < text.length; index += 1) {
    hash ^= text.charCodeAt(index);
    hash = Math.imul(hash, 0x01000193) >>> 0;
  }
  return hash.toString(16).padStart(8, '0');
}

export function parseClientConfig(value: string | undefined): ServedClientConfig {
  const text = value?.trim() ?? '';
  let config: ClientConfigInput = {};
  let invalid = false;
  if (text) {
    try {
      const parsed = ClientConfigSchema.safeParse(JSON.parse(text));
      if (parsed.success) config = parsed.data;
      else invalid = true;
    } catch {
      invalid = true;
    }
  }
  return {
    config,
    revision: `c${CLIENT_CONFIG_SCHEMA_VERSION}-${fnv1a(canonical(config))}`,
    minimumVersion: config.compatibility?.minimumVersion ?? null,
    invalid,
  };
}

export function clientConfigResponse(served: ServedClientConfig): ClientConfigResponse {
  return { schema: CLIENT_CONFIG_SCHEMA_VERSION, revision: served.revision, ttlSeconds: CLIENT_CONFIG_TTL_SECONDS, config: served.config };
}

/**
 * The minimum version this extension request is below, or null. Only requests
 * that say they are a PigeonBox extension with a version are gated; the web
 * dashboard, API tokens and unknown clients are not.
 */
export function belowMinimumVersion(clientHeader: string | null, minimumVersion: string | null): string | null {
  if (!minimumVersion) return null;
  const version = extensionVersionFromClientHeader(clientHeader);
  if (!version) return null;
  return (compareClientVersions(version, minimumVersion) ?? 0) < 0 ? minimumVersion : null;
}
