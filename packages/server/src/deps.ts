import { consumeTrackingBatch, type TrackingEventQueue, type TrackingQueueBatch } from '@pigeonbox/tracker';
import { createInferenceBackend } from './ai/backends.js';
import { createApiHandler } from './api.js';
import { createAuthProvider } from './auth.js';
import { ConfigError, loadConfig, type RawEnv, type Service } from './config.js';
import { consoleLogger } from './http.js';
import { errorTracker } from './error-tracking.js';
import { observedLogger, operationalReporter } from './observability.js';
import { MemoryCloudStore } from './store/memory.js';
import { SupabaseCloudStore } from './store/supabase.js';
import type { CloudStore } from './store/types.js';
import { createTrackerHandler } from './tracker.js';
import { PostgresDatabaseProvider } from './db/postgres.js';
import { createGoogleContext } from './intel/context.js';
import { SupabaseDocumentStorage } from './intel/documents.js';
import { WebCryptoSecretBox } from './platform/crypto.js';
import { drainJobs } from './routes/jobs.js';
import type { IntelRuntime } from './routes/types.js';

/**
 * Build dependencies from the Worker environment once per isolate. The memory
 * store and dev auth keep state in the isolate, so they must be reused across
 * requests rather than rebuilt.
 */
const cache = new WeakMap<object, Map<Service, ReturnType<typeof build>>>();

/** Worker env → raw string env. A Hyperdrive binding supplies the Postgres connection string. */
function rawEnv(env: object): RawEnv {
  const raw = env as Record<string, unknown>;
  const out: RawEnv = {};
  for (const [key, value] of Object.entries(raw)) if (typeof value === 'string') out[key] = value;
  const hyperdrive = raw.HYPERDRIVE as { connectionString?: unknown } | undefined;
  if (!out.DATABASE_URL && typeof hyperdrive?.connectionString === 'string') out.DATABASE_URL = hyperdrive.connectionString;
  return out;
}

function build(env: RawEnv, service: Service) {
  const config = loadConfig(env, service);
  const workerFetch: typeof fetch = (input, init) => fetch(input, init);
  const intel: IntelRuntime | null =
    config.database.url && config.encryption.keyring.length
      ? {
          database: new PostgresDatabaseProvider(config.database.url),
          box: new WebCryptoSecretBox(config.encryption.keyring),
          google: createGoogleContext(config, workerFetch),
          fetch: workerFetch,
          storage:
            config.intel.documentsBucket && config.supabase.url && config.supabase.serviceRoleKey
              ? new SupabaseDocumentStorage(config.supabase.url, config.supabase.serviceRoleKey, config.intel.documentsBucket, workerFetch)
              : null,
        }
      : null;
  const store: CloudStore =
    config.dataStore === 'supabase'
      ? new SupabaseCloudStore(config.supabase.url!, config.supabase.serviceRoleKey!)
      : new MemoryCloudStore();
  const auth = createAuthProvider(config);
  const inference = createInferenceBackend(config);
  const metrics = operationalReporter({ endpoint: env.OBSERVABILITY_ENDPOINT, token: env.OBSERVABILITY_TOKEN, fetch: workerFetch });
  const errors = errorTracker({ dsn: env.SENTRY_DSN, environment: env.ENVIRONMENT, release: env.SERVICE_VERSION, service, fetch: workerFetch });
  // One flush sends both metric samples and error events after the response (waitUntil) or the cron drain.
  const report = { ...metrics, flush: async () => { await Promise.all([metrics.flush(), errors.flush()]); } };
  const log = observedLogger(consoleLogger, metrics, errors);
  // Once per isolate: which rollout entries were not understood (feature names only, never user IDs).
  if (config.composePolicy.invalid.length) log('warn', 'compose policy ignored entries', { code: 'compose_policy_invalid', count: config.composePolicy.invalid.length });
  if (config.clientConfig.invalid) log('warn', 'client config ignored', { code: 'client_config_invalid' });
  if (config.rollout.invalid.length) log('warn', 'rollout config ignored entries', { code: 'rollout_invalid', count: config.rollout.invalid.length });
  return { config, store, auth, inference, log, intel, report };
}

export function depsFor(env: object, service: Service = 'api') {
  let byService = cache.get(env);
  if (!byService) {
    byService = new Map();
    cache.set(env, byService);
  }
  let deps = byService.get(service);
  if (!deps) {
    deps = build(rawEnv(env), service);
    byService.set(service, deps);
  }
  return deps;
}

type Execution = { waitUntil(promise: Promise<unknown>): void };

export function apiWorker() {
  let handler: ReturnType<typeof createApiHandler> | null = null;
  let forEnv: object | null = null;
  return {
    fetch(request: Request, env: object, execution?: Execution): Promise<Response> {
      if (!handler || forEnv !== env) {
        try {
          handler = createApiHandler(depsFor(env, 'api'));
        } catch (error) {
          return Promise.resolve(misconfigured(error));
        }
        forEnv = env;
      }
      return handler(request, execution).then((response) => { const flush = depsFor(env, 'api').report.flush(); if (execution) execution.waitUntil(flush); return response; });
    },
    /** Cron Trigger: drain durable jobs (Supabase Queues) every minute. */
    scheduled(_controller: unknown, env: object, execution: Execution): void {
      let deps;
      try {
        deps = depsFor(env, 'api');
      } catch (error) {
        misconfigured(error);
        return;
      }
      execution.waitUntil(drainJobs(deps, { budgetMs: 25_000, maxJobs: 200, concurrency: 4 }).catch((error: unknown) => {
        // Driver errors can contain SQL parameters. Log only a fixed incident code; the error tracker reads stack locations, never the message.
        deps.log('error', 'job drain failed', { code: 'job_drain_failed' }, error);
      }).finally(() => deps.report.flush()));
    },
  };
}

export function trackerWorker() {
  let handler: ReturnType<typeof createTrackerHandler> | null = null;
  let forEnv: object | null = null;
  return {
    fetch(request: Request, env: object, execution?: { waitUntil(promise: Promise<unknown>): void }): Promise<Response> {
      if (!handler || forEnv !== env) {
        try {
          const queue = (env as { TRACKING_EVENTS?: TrackingEventQueue }).TRACKING_EVENTS;
          handler = createTrackerHandler({ ...depsFor(env, 'tracker'), enqueueTrackingEvent: queue ? event => queue.send(event) : undefined });
        } catch (error) {
          return Promise.resolve(misconfigured(error));
        }
        forEnv = env;
      }
      const deps = depsFor(env, 'tracker');
      return handler(request, execution).then(
        (response) => { const flush = deps.report.flush(); if (execution) execution.waitUntil(flush); return response; },
        (error: unknown) => {
          // The runtime still turns this into a 500; record it first without its message or URL.
          deps.log('error', 'unhandled error', { route: request.method, code: 'unhandled_error' }, error);
          const flush = deps.report.flush();
          if (execution) execution.waitUntil(flush);
          throw error;
        },
      );
    },
    async queue(batch: TrackingQueueBatch, env: object): Promise<void> {
      const deps = depsFor(env, 'tracker');
      await consumeTrackingBatch(batch, deps.store.publicTrackerStore(), (level, fields) => deps.log(level, 'tracking ingestion', fields));
      await deps.report.flush();
    },
  };
}

/** Fail closed on bad configuration: the client learns nothing, the log says what is wrong. */
function misconfigured(error: unknown): Response {
  if (!(error instanceof ConfigError)) throw error;
  consoleLogger('error', 'configuration rejected', { code: error.message.slice(0, 500) });
  return new Response(JSON.stringify({ error: { code: 'internal', message: 'This PigeonBox server is not configured correctly.', retryable: true } }), {
    status: 503,
    headers: { 'Content-Type': 'application/json', 'Cache-Control': 'no-store' },
  });
}
