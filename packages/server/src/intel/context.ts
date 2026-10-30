import type { JWTVerifyGetKey } from 'jose';
import type { CloudInferenceBackend } from '../ai/backends.js';
import type { Config } from '../config.js';
import type { SqlDatabase } from '../db/sql.js';
import type { Logger } from '../http.js';
import { JobQueue } from '../jobs/queue.js';
import type { SecretBox } from '../platform/crypto.js';
import type { CloudStore } from '../store/types.js';
import { GoogleOAuth, type GoogleEndpoints } from '../google/oauth.js';
import type { DocumentStorage } from './documents.js';

/**
 * Everything the intelligence layer needs for one request or one job. The
 * database is opened per request (Workers cannot reuse sockets across
 * requests); the rest is shared by the isolate.
 */
export type IntelDeps = {
  config: Config;
  db: SqlDatabase;
  box: SecretBox;
  queue: JobQueue;
  google: GoogleContext | null;
  inference: CloudInferenceBackend;
  store: CloudStore;
  log: Logger;
  now: () => Date;
  fetch: typeof fetch;
  /** Private file storage for tracked documents; null when not configured. */
  storage: DocumentStorage | null;
};

export type GoogleContext = {
  oauth: GoogleOAuth;
  endpoints: GoogleEndpoints;
  pubsub: { topic: string; audience: string; serviceAccount: string };
  /** Verification keys for Google-signed tokens. Unset in production (Google's JWKS is fetched). */
  keys?: JWTVerifyGetKey;
};

export function createGoogleContext(config: Config, fetchImpl: typeof fetch, overrides: { endpoints?: Partial<GoogleEndpoints>; keys?: JWTVerifyGetKey } = {}): GoogleContext | null {
  if (!config.google) return null;
  const oauth = new GoogleOAuth(
    { clientId: config.google.clientId, clientSecret: config.google.clientSecret, redirectUri: config.google.redirectUri, endpoints: overrides.endpoints },
    fetchImpl,
    overrides.keys,
  );
  return {
    oauth,
    endpoints: oauth.endpoints,
    pubsub: { topic: config.google.pubsubTopic, audience: config.google.pubsubAudience, serviceAccount: config.google.pubsubServiceAccount },
    keys: overrides.keys,
  };
}

export function createIntelDeps(parts: Omit<IntelDeps, 'queue'>): IntelDeps {
  return { ...parts, queue: new JobQueue(parts.db) };
}
