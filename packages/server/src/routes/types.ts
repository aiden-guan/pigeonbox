import type { JWTVerifyGetKey } from 'jose';
import type { CloudInferenceBackend } from '../ai/backends.js';
import type { AuthProvider, Identity } from '../auth.js';
import type { Config } from '../config.js';
import type { DatabaseProvider } from '../db/sql.js';
import type { OperationalReporter } from '../observability.js';
import type { Logger } from '../http.js';
import type { GoogleContext, IntelDeps } from '../intel/context.js';
import type { ExtraHandlers } from '../intel/jobs.js';
import type { SecretBox } from '../platform/crypto.js';
import type { DocumentStorage } from '../intel/documents.js';
import type { CloudStore } from '../store/types.js';

/** What the always-on layer needs from the host. Null when the server has no database configured. */
export type IntelRuntime = {
  database: DatabaseProvider;
  box: SecretBox;
  google: GoogleContext | null;
  fetch: typeof fetch;
  storage: DocumentStorage | null;
  /** Keys that verify Google-signed push tokens (tests); production fetches Google's JWKS. */
  pushKeys?: JWTVerifyGetKey;
  /** Additional job handlers (registered by modules). */
  jobs?: (deps: IntelDeps) => ExtraHandlers;
};

export type ApiDeps = {
  report?: OperationalReporter;
  config: Config;
  store: CloudStore;
  auth: AuthProvider;
  inference: CloudInferenceBackend;
  log: Logger;
  now?: () => Date;
  intel?: IntelRuntime | null;
};

export type WaitUntil = (promise: Promise<unknown>) => void;

export type RequestContext = {
  request: Request;
  url: URL;
  requestId: string;
  deps: ApiDeps;
  now: Date;
  /** Intelligence services for this request; opens the database on first use. */
  intel: () => IntelDeps;
  waitUntil: WaitUntil;
};

export type User = Identity & { token: string; via: 'session' | 'api_token'; scopes?: Array<'read' | 'prepare' | 'write'> };

export type Handler = (ctx: RequestContext, body: unknown, user: User) => Promise<unknown>;
