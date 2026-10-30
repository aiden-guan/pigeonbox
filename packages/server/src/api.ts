import { personalDraftContext } from './intel/memory/draft-context.js';
import type { DraftRequest } from '@pigeonbox/api-contract';
import {
  AuthorizeQuerySchema,
  CLIENT_HEADER,
  GOOGLE_CONNECT_CALLBACK_PATH,
  PROTOCOL_HEADER,
  PROTOCOL_VERSION,
  ROUTES,
  isSupportedProtocol,
  type AiOperation,
  type PigeonBoxCapability,
  type RouteDef,
  type RouteName,
} from '@pigeonbox/api-contract';
import { runAiOperation, operationTimeoutSignal, type AiRequest } from './ai/runner.js';
import { InferenceError } from './ai/backends.js';
import { reasoningEffortFor } from './ai/policy.js';
import { authenticate, isAllowedRedirect } from './auth.js';
import type { SqlDatabase } from './db/sql.js';
import { getEntitlements, hasCapability } from './entitlements.js';
import { ApiError, corsHeaders, errorResponse, json, newRequestId, readJson, timingSafeEqual, withHeaders } from './http.js';
import { disconnectAll } from './intel/connections.js';
import { createIntelDeps, type IntelDeps } from './intel/context.js';
import { enforceLimits, estimateCostMicros, monthlyUsed, usageRecord } from './limits.js';
import { handleGoogleCallback, handleGooglePush } from './routes/google.js';
import { INTEL_HANDLERS } from './routes/intel.js';
import { drainJobs } from './routes/jobs.js';
import { ensureSqlProfile, forgetProfile } from './routes/profile.js';
import { toApiError } from './routes/errors.js';
import type { ApiDeps, Handler, RequestContext, WaitUntil } from './routes/types.js';
import { CONTROL_ROUTES, type ControlRouteName } from './control/contract.js';
import { resolveToken } from './intel/api-tokens.js';
import { CONTROL_HANDLERS, FEATURE_HANDLERS } from './routes/features.js';
import { handleDocumentUpload, handleDocumentViewer, handleMcp, handleUnsubscribe } from './routes/public.js';
import { mcpResourceMetadata } from './intel/mcp-oauth.js';
import { deleteAccountDocumentFiles } from './intel/documents.js';
import { TOKEN_ROUTE_SCOPES } from './routes/token-scopes.js';
import { VERSION_GATE_EXEMPT, belowMinimumVersion, clientConfigResponse } from './client-config.js';

export const SUPPORTED_PROTOCOLS = [PROTOCOL_VERSION] as const;

export type { ApiDeps } from './routes/types.js';

type Context = RequestContext;

/** What a capability-gated route says when the account lacks the capability. */
export const CAPABILITY_MESSAGES: Partial<Record<PigeonBoxCapability, string>> = {
  cloud_ai: 'AI on this server needs CLOUD_AI_* settings. Local AI keeps working without a server.',
  cloud_tracking: 'Tracking is not available for this account on this server.',
  cloud_mail_sync: 'Always-on sync needs the Google settings (GOOGLE_*) and DATABASE_URL on this server.',
  cloud_auto_drafts: 'Prepared drafts need the Google settings and DATABASE_URL on this server.',
  cloud_automations: 'Smart Views, automations and briefings need the Google settings and DATABASE_URL on this server.',
  cloud_calendar: 'Calendar features need the Google settings and DATABASE_URL on this server.',
  cloud_semantic_search: 'Ask Pigeon over synced mail needs the Google settings and DATABASE_URL on this server.',
  cloud_relationships: 'Relationship intelligence needs the Google settings and DATABASE_URL on this server.',
  cloud_documents: 'Tracked documents need DOCUMENTS_BUCKET and DATABASE_URL on this server.',
  cloud_team: 'Team features need DATABASE_URL on this server.',
  cloud_mcp: 'The developer API needs DATABASE_URL on this server.',
  cloud_sequences: 'Sequences need SEQUENCES_ENABLED and the Google settings on this server.',
};

/** Open the intelligence layer lazily for one request; the database closes when the request ends. */
function intelFactory(deps: ApiDeps, now: () => Date, opened: { db: SqlDatabase | null }) {
  let cached: IntelDeps | null = null;
  return () => {
    if (!deps.intel) throw new ApiError('not_configured', 'The always-on features are not configured on this server (DATABASE_URL and DATA_ENCRYPTION_KEYS).');
    if (!cached) {
      opened.db = deps.intel.database.open();
      cached = createIntelDeps({
        config: deps.config,
        db: opened.db,
        box: deps.intel.box,
        google: deps.intel.google,
        inference: deps.inference,
        store: deps.store,
        log: deps.log,
        now,
        fetch: deps.intel.fetch,
        storage: deps.intel.storage,
      });
    }
    return cached;
  };
}

type AnyRoute = RouteName | ControlRouteName;
const ALL_ROUTES: Record<AnyRoute, RouteDef> = { ...ROUTES, ...CONTROL_ROUTES };
const ROUTE_BY_KEY = new Map<string, [AnyRoute, RouteDef]>(
  (Object.entries(ALL_ROUTES) as Array<[AnyRoute, RouteDef]>).map(([name, route]) => [`${route.method} ${route.path}`, [name, route]]),
);
const KNOWN_PATHS = new Set<string>(Object.values(ALL_ROUTES).map((route) => route.path));

/** Per-IP limit on sign-in endpoints, against code and token guessing. */
const AUTH_PER_MINUTE = 30;

/**
 * The PigeonBox server API as a fetch handler. Workers call it with real
 * dependencies; tests call it with memory stores and mock inference.
 */
export function createApiHandler(deps: ApiDeps) {
  return async (request: Request, execution?: { waitUntil: WaitUntil }): Promise<Response> => {
    const requestId = newRequestId();
    const url = new URL(request.url);
    const started = Date.now();
    const cors = corsHeaders(request, { webOrigins: deps.config.allowedWebOrigins, extensionIds: deps.config.allowedExtensionIds });
    const now = deps.now?.() ?? new Date();
    const clock = () => deps.now?.() ?? new Date();
    const opened: { db: SqlDatabase | null } = { db: null };
    const pending: Promise<unknown>[] = [];
    // Everything handed to waitUntil, so the database closes only after it (a streamed answer keeps using it).
    const tracked: Promise<unknown>[] = [];
    const waitUntil: WaitUntil = (promise) => {
      const guarded = promise.catch(() => undefined);
      tracked.push(guarded);
      if (execution) execution.waitUntil(guarded);
      else pending.push(guarded);
    };
    const ctx: Context = { request, url, requestId, deps, now, intel: intelFactory(deps, clock, opened), waitUntil };
    let response: Response;
    try {
      response = await route(ctx, cors);
    } catch (error) {
      const mapped = toApiError(error);
      const apiError = mapped ?? new ApiError('internal', 'Something went wrong. Try again.');
      if (!mapped) deps.log('error', 'unhandled error', { requestId, route: routeShape(url.pathname), code: 'unhandled_error' }, error);
      response = errorResponse(apiError, requestId);
    }
    if (opened.db) {
      const db = opened.db;
      waitUntil(Promise.all([...tracked]).then(() => db.close()));
    }
    // Without a Worker execution context (tests, Node), finish background work before returning.
    if (!execution && pending.length) await Promise.all(pending);
    deps.log('info', 'request', { requestId, route: `${request.method} ${routeShape(url.pathname)}`, status: response.status, latencyMs: Date.now() - started });
    return withHeaders(response, cors);
  };
}

/** Log route shapes, not IDs or tokens in paths. */
function routeShape(path: string): string {
  if (path.startsWith('/d/')) return '/d/:token';
  if (path.startsWith('/u/')) return '/u/:token';
  if (/^\/v1\/documents\/[^/]+\/content$/.test(path)) return '/v1/documents/:id/content';
  const fixed = new Set<string>([...Object.values(ROUTES), ...Object.values(CONTROL_ROUTES)].map(route => route.path));
  for (const extra of ['/v1/google/push', '/internal/jobs/drain', '/v1/auth/authorize', '/v1/mcp', GOOGLE_CONNECT_CALLBACK_PATH]) fixed.add(extra);
  return fixed.has(path) ? path : '/:unknown';
}

async function route(ctx: Context, cors: Record<string, string> | null): Promise<Response> {
  const { request, url, requestId, deps } = ctx;
  const path = url.pathname.replace(/\/+$/, '') || '/';

  if (request.method === 'OPTIONS') {
    return cors ? new Response(null, { status: 204 }) : new Response(null, { status: 403 });
  }

  // Google redirects the browser here after consent for a Cloud connection.
  if (path === GOOGLE_CONNECT_CALLBACK_PATH && request.method === 'GET') {
    return handleGoogleCallback(ctx);
  }
  // Gmail push notifications via Pub/Sub (OIDC-authenticated by Google).
  if (path === '/v1/google/push' && request.method === 'POST') {
    return handleGooglePush(ctx);
  }
  // Optional trigger for Supabase Cron (pg_net) to drain the job queue. Shared secret, constant-time compare.
  if (path === '/internal/jobs/drain' && request.method === 'POST') {
    const secret = deps.config.internalJobSecret;
    const given = request.headers.get('x-pigeonbox-internal') ?? '';
    if (!secret || !given || !timingSafeEqual(given, secret)) throw new ApiError('forbidden', 'Forbidden.');
    const result = await drainJobs(deps, { budgetMs: 20_000, maxJobs: 100 });
    return json({ ok: true, ...result }, 200, requestId);
  }

  // Browser redirect that starts sign-in.
  if (path === '/v1/auth/authorize' && request.method === 'GET') {
    const query: Record<string, string> = {};
    url.searchParams.forEach((value, key) => {
      query[key] = value;
    });
    const parsed = AuthorizeQuerySchema.safeParse(query);
    if (!parsed.success) throw new ApiError('invalid_request', 'The sign-in request is incomplete.');
    if (!isAllowedRedirect(parsed.data.redirect_uri, deps.config)) throw new ApiError('forbidden', 'That redirect address is not allowed.');
    return deps.auth.authorizeRedirect(parsed.data);
  }
  const providerRoute = await deps.auth.handle?.(request, url);
  if (providerRoute) return providerRoute;

  if (['/.well-known/oauth-protected-resource', '/.well-known/oauth-protected-resource/v1/mcp'].includes(path) && request.method === 'GET') return json(mcpResourceMetadata(ctx), 200, ctx.requestId);
  // MCP server for AI agents (scoped API tokens or resource-bound OAuth tokens).
  if (path === '/v1/mcp') return handleMcp(ctx);
  // Binary PDF upload for tracked documents.
  const upload = path.match(/^\/v1\/documents\/([0-9a-f-]{36})\/content$/i);
  if (upload && request.method === 'PUT') return handleDocumentUpload(ctx, upload[1]!);
  // Public tracked-document viewer and one-click unsubscribe.
  if (path.startsWith('/d/')) return handleDocumentViewer(ctx, path.slice(3));
  if (path.startsWith('/u/')) return handleUnsubscribe(ctx, path.slice(3));

  const match = ROUTE_BY_KEY.get(`${request.method} ${path}`);
  if (!match) {
    if (KNOWN_PATHS.has(path)) throw new ApiError('method_not_allowed', 'Method not allowed.');
    throw new ApiError('not_found', 'Not found.');
  }
  const [name, def] = match;

  // Health, version and client config answer any client so an outdated extension can learn it is outdated.
  if (name !== 'health' && name !== 'version' && name !== 'clientConfig' && !isSupportedProtocol(request.headers.get(PROTOCOL_HEADER), SUPPORTED_PROTOCOLS)) {
    throw new ApiError('unsupported_protocol', 'This version of PigeonBox is not supported by this server. Update the extension.');
  }
  // CLIENT_CONFIG compatibility.minimumVersion: extensions below it may still sign out, forget and delete.
  const minimum = VERSION_GATE_EXEMPT.has(name) ? null : belowMinimumVersion(request.headers.get(CLIENT_HEADER), deps.config.clientConfig.minimumVersion);
  if (minimum) {
    throw new ApiError('unsupported_protocol', `This server needs PigeonBox ${minimum} or newer. Update the extension.`, { minimumVersion: minimum });
  }

  if (name === 'authToken' || name === 'authRefresh' || name === 'controlAuthLink') await limitAuth(ctx);

  const body = def.request ? await readJson(request, def.request) : undefined;
  const user = def.auth === 'user' ? await authenticateUser(ctx, name) : (null as unknown as Parameters<Handler>[2]);
  if (user && user.via === 'session') await deps.store.ensureProfile(user.userId, user.email);

  const capability = (def as RouteDef).capability;
  if (user?.via === 'api_token') {
    const entitlements = await getEntitlements(user.userId, deps.store, deps.config);
    if (!hasCapability(entitlements, 'cloud_mcp')) throw new ApiError('entitlement_required', CAPABILITY_MESSAGES.cloud_mcp!);
  }
  if (capability) {
    const entitlements = await getEntitlements(user.userId, deps.store, deps.config);
    if (!hasCapability(entitlements, capability)) {
      throw new ApiError('entitlement_required', CAPABILITY_MESSAGES[capability] ?? 'This server does not offer that feature.');
    }
  }

  const handler = HANDLERS[name];
  if (!handler) throw new ApiError('not_configured', 'This feature is not available on this server.');
  if (user && deps.intel && name !== 'accountDelete' && name !== 'controlAuthLink' && !(name in CORE_HANDLERS) && user.via === 'session') {
    await ensureSqlProfile(deps.intel.database, ctx.intel(), user, deps.config.auth.provider === 'dev' && !deps.config.production);
  }
  if (user && deps.intel && name === 'accountDelete') {
    await ensureSqlProfile(deps.intel.database, ctx.intel(), user, deps.config.auth.provider === 'dev' && !deps.config.production);
  }
  const result = await handler(ctx, body, user);
  // Streaming routes validate each event as they write it.
  if ((def as RouteDef).stream === 'ndjson' && result instanceof Response) return result;
  // Validate on the way out too: a server bug must not ship an off-contract response.
  const checked = def.response.safeParse(result);
  if (!checked.success) {
    // Field paths and issue codes only, never values, so the log names what broke without copying content.
    const detail = checked.error.issues.slice(0, 3).map((issue) => `${issue.path.join('.')}: ${issue.code}`).join('; ').slice(0, 300);
    deps.log('error', 'response failed contract validation', { requestId, route: path, detail });
    throw new ApiError(def.operation ? 'provider_invalid_response' : 'internal', 'The server produced an invalid response.');
  }
  // Short browser cache: a kill switch reaches extensions within the TTL plus this.
  if (name === 'clientConfig') return json(checked.data, 200, requestId, { 'Cache-Control': 'public, max-age=60', Vary: 'Origin' });
  // Additive operational metadata; older public clients ignore unknown fields.
  return json(name === 'version' ? { ...(checked.data as Record<string, unknown>), commit: deps.config.commit, environment: deps.config.environment } : checked.data, 200, requestId);
}

/**
 * A person's session (Supabase JWT), or a developer API token (`pbx_…`) for
 * the routes and scope listed in TOKEN_ROUTE_SCOPES.
 */
async function authenticateUser(ctx: Context, name: AnyRoute): Promise<Parameters<Handler>[2]> {
  const header = ctx.request.headers.get('Authorization') ?? '';
  const bearer = header.startsWith('Bearer ') ? header.slice(7).trim() : '';
  if (bearer.startsWith('pbx_')) {
    if (!ctx.deps.intel) throw new ApiError('invalid_token', 'API tokens are not available on this server.');
    const client = await resolveToken(ctx.intel(), bearer);
    if (!client) throw new ApiError('invalid_token', 'The API token is invalid, expired or revoked.');
    const needed = TOKEN_ROUTE_SCOPES[name as RouteName];
    if (!needed) throw new ApiError('forbidden', 'API tokens cannot use this route.');
    if (!client.scopes.includes(needed)) throw new ApiError('forbidden', `This API token needs the "${needed}" scope.`);
    return { userId: client.userId, email: null, token: '', via: 'api_token', scopes: client.scopes };
  }
  return { ...(await authenticate(ctx.request, ctx.deps.auth)), via: 'session' };
}

async function limitAuth(ctx: Context) {
  const ip = ctx.request.headers.get('CF-Connecting-IP') || 'unknown';
  const windowStart = new Date(Math.floor(ctx.now.getTime() / 60_000) * 60_000);
  const count = await ctx.deps.store.hitRateLimit(`auth:${ip}`, windowStart);
  if (count > AUTH_PER_MINUTE) throw new ApiError('rate_limited', 'Too many sign-in attempts. Wait a minute.', { retryAfter: 60 });
}

/**
 * The AI-operation pipeline: authenticate (done by the router) → resolve the
 * user → entitlement → limits and budget → rate limit → inference → usage →
 * validated response (done by the router).
 */
function aiHandler(operation: AiOperation): Handler {
  return async (ctx, body, user) => {
    const { deps, requestId, now } = ctx;
    const entitlements = await getEntitlements(user.userId, deps.store, deps.config);
    if (!hasCapability(entitlements, 'cloud_ai')) {
      throw new ApiError('entitlement_required', CAPABILITY_MESSAGES.cloud_ai!);
    }
    await enforceLimits(user.userId, entitlements, { store: deps.store, config: deps.config, now });

    const started = Date.now();
    const signal = operationTimeoutSignal(deps.config.ai.timeoutMs);
    try {
      const personal = (operation === 'draft' || operation === 'follow_up') && deps.intel
        ? await personalDraftContext(ctx.intel(),user.userId,(body as DraftRequest).input,requestId) : null;
      const run = await runAiOperation({ operation, body } as AiRequest, deps.inference, { requestId, signal },personal);
      const costMicros = estimateCostMicros(run.usage.inputTokens, run.usage.outputTokens, deps.config, run.usage.cachedInputTokens, run.serviceTier);
      await deps.store.recordUsage(
        usageRecord(
          {
            userId: user.userId,
            operation,
            provider: run.provider,
            model: run.model,
            status: 'ok',
            errorCode: null,
            latencyMs: Date.now() - started,
            inputTokens: run.usage.inputTokens,
            outputTokens: run.usage.outputTokens,
            estimatedCostMicros: costMicros,
            requestId,
          },
          now,
        ),
      );
      deps.log('info', 'ai operation', {
        requestId,
        userId: user.userId,
        operation,
        provider: run.provider,
        model: run.model ?? undefined,
        inputTokens: run.usage.inputTokens,
        outputTokens: run.usage.outputTokens,
        cachedTokens: run.usage.cachedInputTokens ?? 0,
        reasoningEffort: operation === 'embed' ? undefined : reasoningEffortFor(operation),
        serviceTier: 'standard',
        actualServiceTier: run.serviceTier,
        costMicros,
        latencyMs: Date.now() - started,
      });
      return {
        result: run.result,
        ...(personal ? { sources: personal.sources } : {}),
        usage: { inputTokens: run.usage.inputTokens, outputTokens: run.usage.outputTokens, totalTokens: run.usage.inputTokens + run.usage.outputTokens },
        ...(run.model ? { model: run.model } : {}),
        requestId,
      };
    } catch (error) {
      const code = error instanceof InferenceError ? error.code : 'provider_error';
      await deps.store
        .recordUsage(
          usageRecord(
            {
              userId: user.userId,
              operation,
              provider: deps.inference.name,
              model: null,
              status: 'error',
              errorCode: code,
              latencyMs: Date.now() - started,
              inputTokens: 0,
              outputTokens: 0,
              estimatedCostMicros: 0,
              requestId,
            },
            now,
          ),
        )
        .catch(() => undefined);
      const provider = error instanceof InferenceError ? error : null;
      deps.log('warn', 'ai operation failed', { requestId, userId: user.userId, operation, provider: deps.inference.name, code, serviceTier: 'standard', latencyMs: Date.now() - started, ...(provider?.status ? { status: provider.status } : {}), ...(provider?.detail ? { detail: provider.detail } : {}) });
      if (error instanceof InferenceError) throw new ApiError(error.code, error.message);
      throw error;
    }
  };
}

const CORE_HANDLERS: Partial<Record<RouteName, Handler>> = {
  health: async (ctx) => ({ ok: true, service: 'api', time: ctx.now.toISOString() }),
  clientConfig: async (ctx) => clientConfigResponse(ctx.deps.config.clientConfig),
  version: async (ctx) => ({ service: 'pigeonbox-api', version: ctx.deps.config.version, protocol: { current: PROTOCOL_VERSION, supported: [...SUPPORTED_PROTOCOLS] } }),

  authToken: async (ctx, body) => {
    const { code, codeVerifier, redirectUri } = body as { code: string; codeVerifier: string; redirectUri: string };
    if (!isAllowedRedirect(redirectUri, ctx.deps.config)) throw new ApiError('forbidden', 'That redirect address is not allowed.');
    const session = await ctx.deps.auth.exchangeCode(code, codeVerifier, redirectUri);
    await ctx.deps.store.ensureProfile(session.user.id, session.user.email);
    return session;
  },
  authRefresh: async (ctx, body) => ctx.deps.auth.refresh((body as { refreshToken: string }).refreshToken),
  authSignOut: async (ctx, body, user) => {
    await ctx.deps.auth.signOut(user.token, (body as { refreshToken?: string }).refreshToken);
    return { ok: true };
  },

  me: async (_ctx, _body, user) => ({ user: { id: user.userId, email: user.email } }),
  capabilities: async (ctx, _body, user) => {
    const entitlements = await getEntitlements(user.userId, ctx.deps.store, ctx.deps.config);
    return { capabilities: entitlements.capabilities };
  },
  entitlements: async (ctx, _body, user) => {
    const entitlements = await getEntitlements(user.userId, ctx.deps.store, ctx.deps.config);
    const usage = await ctx.deps.store.usageSummary(user.userId, ctx.now);
    return {
      capabilities: entitlements.capabilities,
      limits: entitlements.limits,
      usage: { aiRequestsToday: usage.requestsToday, aiTokensThisMonth: usage.tokensThisMonth, aiMonthlyUsed: monthlyUsed(usage, entitlements) },
    };
  },
  accountDelete: async (ctx, _body, user) => {
    if (ctx.deps.intel) {
      // Revoke Google grants and stop watches before the rows (and encrypted credentials) cascade away.
      const intel = ctx.intel();
      await disconnectAll(intel, user.userId);
      await deleteAccountDocumentFiles(intel, user.userId);
      await intel.db.system((tx) => tx.query('delete from public.profiles where id = $1::uuid', [user.userId]));
      forgetProfile(ctx.deps.intel.database, user.userId);
    }
    await ctx.deps.store.deleteUserData(user.userId);
    await ctx.deps.auth.deleteUser(user.userId);
    ctx.deps.log('info', 'account deleted', { requestId: ctx.requestId, userId: user.userId });
    return { ok: true };
  },

  classify: aiHandler('classify'),
  summarize: aiHandler('summarize'),
  draft: aiHandler('draft'),
  followUp: aiHandler('follow_up'),
  rewrite: aiHandler('rewrite'),
  ask: aiHandler('ask'),
  embed: aiHandler('embed'),
};

const HANDLERS: Partial<Record<AnyRoute, Handler>> = { ...CORE_HANDLERS, ...INTEL_HANDLERS, ...FEATURE_HANDLERS, ...CONTROL_HANDLERS };

/** Route names this server implements (for the contract-completeness test). */
export const HANDLED_ROUTES: ReadonlySet<string> = new Set(Object.keys(HANDLERS));
