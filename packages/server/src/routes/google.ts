import { ApiError, json } from '../http.js';
import { completeConnection } from '../intel/connections.js';
import { parsePushBody, PushAuthError, verifyPushRequest } from '../google/pubsub.js';
import { handlePushNotification } from '../intel/sync.js';
import type { RequestContext } from './types.js';

function redirect(location: string): Response {
  return new Response(null, { status: 302, headers: { Location: location, 'Cache-Control': 'no-store', 'Referrer-Policy': 'no-referrer' } });
}

/**
 * Where the browser lands after Google consent: the extension's confirmation
 * page on the API Worker, or the Cloud dashboard at the public app URL (the
 * website hosts it in production). Never a URL from the request.
 */
function landing(ctx: RequestContext, returnTo: 'extension' | 'web', params: Record<string, string>): string {
  const { apiBaseUrl, publicAppUrl } = ctx.deps.config;
  const base = (returnTo === 'web' ? publicAppUrl ?? apiBaseUrl : apiBaseUrl) ?? ctx.url.origin;
  // The control plane routes sections by hash (static hosting, deep-linkable).
  const url = new URL(returnTo === 'extension' ? '/connected' : '/dashboard#connections', base);
  for (const [key, value] of Object.entries(params)) url.searchParams.set(key, value);
  return url.toString();
}

/** GET /v1/connections/google/callback?code&state (or ?error=access_denied&state). */
export async function handleGoogleCallback(ctx: RequestContext): Promise<Response> {
  const code = ctx.url.searchParams.get('code') ?? '';
  const state = ctx.url.searchParams.get('state') ?? '';
  const error = ctx.url.searchParams.get('error');
  if (error) {
    const safe = /^[a-z_]{1,40}$/.test(error) ? error : 'denied';
    return redirect(landing(ctx, 'web', { error: safe }));
  }
  if (!/^[A-Za-z0-9_-]{20,200}$/.test(state) || code.length < 8 || code.length > 2_000) {
    return redirect(landing(ctx, 'web', { error: 'invalid_request' }));
  }
  try {
    const outcome = await completeConnection(ctx.intel(), { code, state });
    return redirect(landing(ctx, outcome.returnTo, { connected: '1', ...(outcome.missing.length ? { missing: outcome.missing.join(',') } : {}) }));
  } catch (caught) {
    const code = caught instanceof ApiError ? caught.code : 'internal';
    ctx.deps.log('warn', 'google connection failed', { requestId: ctx.requestId, code });
    return redirect(landing(ctx, 'web', { error: code }));
  }
}

/**
 * POST /v1/google/push. Verify the Google-signed OIDC token, then route the
 * notification. Always acknowledges verified pushes quickly (Pub/Sub retries
 * non-2xx); the sync itself is a durable job.
 */
export async function handleGooglePush(ctx: RequestContext): Promise<Response> {
  const google = ctx.deps.intel?.google;
  if (!google) throw new ApiError('not_configured', 'Not configured.');
  try {
    await verifyPushRequest(ctx.request, {
      audience: google.pubsub.audience,
      serviceAccountEmail: google.pubsub.serviceAccount,
      keys: ctx.deps.intel?.pushKeys,
      jwksUrl: google.endpoints.jwks,
    });
  } catch (error) {
    ctx.deps.log('warn', 'push rejected', { requestId: ctx.requestId, code: error instanceof PushAuthError ? error.code : 'invalid' });
    return json({ error: { code: 'unauthenticated', message: 'Unauthorized.', retryable: false } }, 401, ctx.requestId);
  }
  let notification;
  try {
    const text = await ctx.request.text();
    if (text.length > 20_000) throw new Error('too large');
    notification = parsePushBody(JSON.parse(text));
  } catch {
    // Malformed but authenticated: acknowledge so Pub/Sub does not redeliver it forever.
    ctx.deps.log('warn', 'push body rejected', { requestId: ctx.requestId, code: 'malformed' });
    return new Response(null, { status: 204 });
  }
  const queued = await handlePushNotification(ctx.intel(), notification);
  ctx.deps.log('info', 'gmail push', { requestId: ctx.requestId, count: queued });
  // The minute Cron Trigger owns execution. HTTP waitUntil has only a short
  // post-response lifetime and can abandon a claimed recovery/analysis job.
  return new Response(null, { status: 204 });
}
