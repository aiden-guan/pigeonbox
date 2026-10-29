import { z } from 'zod';
import { one } from '../db/sql.js';
import { ApiError } from '../http.js';
import { randomToken, sha256Hex } from '../platform/crypto.js';
import type { RequestContext, User } from '../routes/types.js';
import { recordAudit } from './audit.js';
import type { Scope } from './api-tokens.js';

export function mcpResource(ctx: Pick<RequestContext, 'deps'>): string {
  return new URL('/v1/mcp', ctx.deps.config.apiBaseUrl!).href;
}

export function mcpResourceMetadata(ctx: RequestContext) {
  if (!ctx.deps.config.auth.mcpOAuthEnabled) throw new ApiError('not_found', 'MCP OAuth is not enabled.');
  return { resource: mcpResource(ctx), authorization_servers: [`${ctx.deps.config.supabase.url!.replace(/\/+$/, '')}/auth/v1`], scopes_supported: ['openid'], bearer_methods_supported: ['header'], resource_name: 'PigeonBox' };
}

/** Managed Supabase endpoints, always authenticated by the person’s session. */
async function provider(ctx: RequestContext, token: string, path: string, method = 'GET', body?: unknown): Promise<unknown> {
  if (!ctx.deps.config.auth.mcpOAuthEnabled) throw new ApiError('not_configured', 'MCP OAuth is not enabled.');
  let response: Response;
  try {
    response = await ctx.intel().fetch(`${ctx.deps.config.supabase.url!.replace(/\/+$/, '')}/auth/v1${path}`, {
      method, headers: { apikey: ctx.deps.config.supabase.anonKey!, Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' },
      body: body === undefined ? undefined : JSON.stringify(body), signal: AbortSignal.timeout(15_000), redirect: 'error',
    });
  } catch { throw new ApiError('not_configured', 'The OAuth authorization service is unavailable.'); }
  if (!response.ok) throw new ApiError('conflict', 'This authorization request is unavailable or has expired. Start the connection again.');
  if (method === 'DELETE') return {};
  return response.json();
}

const Details = z.object({ authorization_id: z.string().uuid(), client: z.object({ id: z.string().uuid(), name: z.string().max(300) }), user: z.object({ id: z.string().uuid() }), scope: z.string().max(1000), redirect_uri: z.string().url().max(4000) });
const Redirect = z.object({ redirect_url: z.string().url().max(6000) });

function redirectResult(value: unknown) {
  const parsed = Redirect.safeParse(value);
  if (!parsed.success) throw new ApiError('conflict', 'The authorization service returned an invalid response.');
  const url = new URL(parsed.data.redirect_url);
  if (url.username || url.password || (url.protocol !== 'https:' && !(url.protocol === 'http:' && ['localhost', '127.0.0.1', '[::1]'].includes(url.hostname)))) throw new ApiError('conflict', 'Invalid OAuth callback.');
  return { redirectUrl: url.href };
}

export async function oauthDetails(ctx: RequestContext, user: User, authorizationId: string) {
  if (user.via !== 'session') throw new ApiError('forbidden', 'Only the person can connect an AI client.');
  const raw = await provider(ctx, user.token, `/oauth/authorizations/${authorizationId}`);
  if (Redirect.safeParse(raw).success) return redirectResult(raw);
  const parsed = Details.safeParse(raw);
  if (!parsed.success || parsed.data.user.id !== user.userId || parsed.data.authorization_id !== authorizationId) throw new ApiError('conflict', 'The authorization request could not be verified.');
  return { authorizationId, clientId: parsed.data.client.id, clientName: parsed.data.client.name, identityScopes: parsed.data.scope, redirectUri: parsed.data.redirect_uri };
}

export async function oauthDecide(ctx: RequestContext, user: User, input: { authorizationId: string; decision: 'approve' | 'deny'; scopes: Scope[] }) {
  const details = await oauthDetails(ctx, user, input.authorizationId);
  if ('redirectUrl' in details) return details;
  const raw = await provider(ctx, user.token, `/oauth/authorizations/${input.authorizationId}/consent`, 'POST', { action: input.decision });
  const result = redirectResult(raw);
  if (input.decision === 'approve') {
    const scopes = [...new Set(input.scopes)];
    await ctx.intel().db.asUser(user.userId, async (tx) => {
      const row = await one<{ id: string }>(tx,
        `insert into public.mcp_clients (user_id, name, kind, oauth_client_id, token_prefix, token_hash, scopes)
         values ($1::uuid, $2, 'oauth', $3::uuid, 'oauth', $4, $5::text[])
         on conflict (user_id, oauth_client_id) where kind = 'oauth'
         do update set name = excluded.name, scopes = excluded.scopes, revoked_at = null, expires_at = null returning id`,
        [user.userId, details.clientName.slice(0, 120), details.clientId, await sha256Hex(randomToken(32)), scopes]);
      await recordAudit(tx, { userId: user.userId, actor: { type: 'user', id: user.userId, name: 'You' }, action: 'connect_mcp_oauth', tier: 0,
        target: { kind: 'api_token', id: row!.id, title: details.clientName }, summary: `Connected MCP client (${scopes.join(', ')})`, policy: { decision: 'allowed', reason: 'User consent' } });
    });
  }
  return result;
}

export async function resolveOAuthClient(ctx: RequestContext, token: string): Promise<{ clientId: string; userId: string; scopes: Scope[] } | null> {
  if (!ctx.deps.config.auth.mcpOAuthEnabled || !ctx.deps.auth.verifyMcpAccessToken || token.length > 16_000) return null;
  let identity;
  try { identity = await ctx.deps.auth.verifyMcpAccessToken(token, mcpResource(ctx)); }
  catch { return null; }
  const row = await ctx.intel().db.asUser(identity.userId, (tx) => one<{ id: string; scopes: Scope[] }>(tx,
    `update public.mcp_clients set last_used_at = now() where kind = 'oauth' and oauth_client_id = $1::uuid and revoked_at is null and (expires_at is null or expires_at > now()) returning id, scopes`, [identity.oauthClientId]));
  return row ? { clientId: row.id, userId: identity.userId, scopes: row.scopes } : null;
}

/** Local revocation is committed first, so a provider outage cannot preserve MCP access. */
export async function revokeOAuthProviderGrant(ctx: RequestContext, user: User, grantId: string) {
  const row = await ctx.intel().db.asUser(user.userId, (tx) => one<{ oauth_client_id: string | null }>(tx, `select oauth_client_id from public.mcp_clients where id = $1::uuid`, [grantId]));
  if (!row?.oauth_client_id) return;
  try { await provider(ctx, user.token, `/user/oauth/grants?client_id=${encodeURIComponent(row.oauth_client_id)}`, 'DELETE'); }
  catch { throw new ApiError('not_configured', 'Disconnected from PigeonBox. The assistant’s sign-in could not be cleared yet; revoke again to finish.'); }
}
