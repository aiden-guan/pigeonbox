import { handleTrackerRequest, type QueuedTrackingEvent } from '@pigeonbox/tracker';
import { authenticate, type AuthProvider } from './auth.js';
import type { Config } from './config.js';
import { getEntitlements, hasCapability } from './entitlements.js';
import { ApiError, type Logger } from './http.js';
import type { CloudStore } from './store/types.js';

export type TrackerDeps = { config: Config; store: CloudStore; auth: AuthProvider; log: Logger; enqueueTrackingEvent?: (event: QueuedTrackingEvent) => Promise<void> };

/** The tracker protocol reports errors as `{ error: string }`. */
function trackerError(code: string, status: number): Response {
  return new Response(JSON.stringify({ error: code }), {
    status,
    headers: { 'Content-Type': 'application/json', 'Cache-Control': 'no-store', 'X-Content-Type-Options': 'nosniff', 'Referrer-Policy': 'no-referrer' },
  });
}

/**
 * Hosted tracker. The request handling is the public self-host tracker's
 * (`handleTrackerRequest`), so protocol v3 behavior is identical. Differences:
 * management routes take an access token from this server, require the
 * `cloud_tracking` capability, and see only that account's records.
 * `/open/:id` and `/c/:id` stay public; IDs are random and carry no mailbox data.
 */
export function createTrackerHandler(deps: TrackerDeps) {
  return async (request: Request, execution?: { waitUntil(promise: Promise<unknown>): void }): Promise<Response> => {
    const started = Date.now();
    const response = await handleTrackerRequest(request, {
      publicStore: deps.store.publicTrackerStore(),
      ipSalt: deps.config.ipHashSalt,
      enqueueEvent: deps.enqueueTrackingEvent,
      // Pixel and click bookkeeping runs after the response, so mail clients and
      // recipients never wait on Postgres. Public routes never check entitlements,
      // so already-sent mail keeps working if an account loses access.
      defer: execution ? (task) => execution.waitUntil(task) : undefined,
      authorize: async (req) => {
        try {
          const user = await authenticate(req, deps.auth);
          const entitlements = await getEntitlements(user.userId, deps.store, deps.config);
          if (!hasCapability(entitlements, 'cloud_tracking')) return trackerError('entitlement_required', 402);
          // Only creating a tracked email needs the owner row; reads and updates find their own rows or nothing.
          if (req.method === 'POST' && new URL(req.url).pathname === '/api/emails') await deps.store.ensureProfile(user.userId, user.email);
          return { store: deps.store.trackerStoreFor(user.userId) };
        } catch (error) {
          if (error instanceof ApiError) return trackerError('unauthorized', 401);
          throw error;
        }
      },
    });
    const path = new URL(request.url).pathname;
    // Pixel and click hits are logged by route shape only; IDs are not needed for operations.
    const route = path.startsWith('/open/') ? '/open/:id' : path.startsWith('/c/') ? '/c/:id' : path.replace(/\/(trk|evt)_[\w-]+/g, '/:id');
    deps.log('info', 'tracker request', { route: `${request.method} ${route}`, status: response.status, latencyMs: Date.now() - started });
    return response;
  };
}
