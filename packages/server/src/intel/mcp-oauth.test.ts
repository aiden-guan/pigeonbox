import { SignJWT } from 'jose';
import { describe, expect, it } from 'vitest';
import { SupabaseAuthProvider } from '../auth.js';
import { API } from '../testing.js';
import { connectedUser, createIntelHarness } from '../testing/intel-harness.js';

const CLIENT = '11111111-1111-4111-8111-111111111111';
const AUTHORIZATION = '22222222-2222-4222-8222-222222222222';
const SECRET = 'oauth-test-signing-key-0123456789';
const RESOURCE = `${API}/v1/mcp`;

async function setup() {
  const h = await createIntelHarness({ env: { TRACKER_BASE_URL: 'https://t.test' } });
  const user = await connectedUser(h, 'ada@work.test', ['mail_read', 'send']);
  // Managed OAuth is replaced with signed fixtures; real sessions and grants still use the API and RLS.
  h.config.auth.mcpOAuthEnabled = true;
  h.config.supabase.jwtSecret = SECRET;
  h.config.supabase.anonKey = 'publishable-test';
  const auth = new SupabaseAuthProvider(h.config);
  h.deps.auth.verifyMcpAccessToken = auth.verifyMcpAccessToken.bind(auth);
  const requests: Array<{ path: string; method: string }> = [];
  let redirectOnly = false;
  h.google.external = async (request) => {
    const url = new URL(request.url);
    expect(url.origin).toBe('https://supabase.test');
    expect(request.headers.get('apikey')).toBe('publishable-test');
    expect(request.headers.get('Authorization')).toBe(`Bearer ${user.token}`);
    requests.push({ path: url.pathname, method: request.method });
    if (url.pathname.endsWith('/consent')) return Response.json({ redirect_url: `https://chatgpt.com/connector/oauth/callback?code=fixture&state=fixture` });
    if (url.pathname.endsWith('/oauth/grants')) return new Response(null, { status: 204 });
    if (redirectOnly) return Response.json({ redirect_url: 'https://chatgpt.com/connector/oauth/callback?code=fixture' });
    return Response.json({ authorization_id: AUTHORIZATION, client: { id: CLIENT, name: 'ChatGPT' }, user: { id: user.userId }, scope: 'openid', redirect_uri: 'https://chatgpt.com/connector/oauth/callback' });
  };
  async function jwt(overrides: Record<string, unknown> = {}, key = SECRET) {
    return new SignJWT({ role: 'pigeonbox_mcp', client_id: CLIENT, ...overrides })
      .setProtectedHeader({ alg: 'HS256' }).setIssuer('https://supabase.test/auth/v1').setSubject(user.userId)
      .setAudience(RESOURCE).setIssuedAt().setExpirationTime('5m').sign(new TextEncoder().encode(key));
  }
  async function rpc(token: string, method = 'tools/list', params?: Record<string, unknown>) {
    return h.api(new Request(RESOURCE, { method: 'POST', headers: { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' }, body: JSON.stringify({ jsonrpc: '2.0', id: 1, method, params }) }));
  }
  const approve = (scopes = ['read', 'write']) => h.route('controlMcpOAuthDecide', user.token, { authorizationId: AUTHORIZATION, decision: 'approve', scopes });
  return { h, user, auth, requests, jwt, rpc, approve, setRedirectOnly: () => { redirectOnly = true; } };
}

describe('managed MCP OAuth', () => {
  it('publishes resource discovery and an OAuth challenge, while leaving disabled servers token-only', async () => {
    const { h, rpc } = await setup();
    const metadata = await h.call('/.well-known/oauth-protected-resource/v1/mcp');
    expect(await metadata.json()).toMatchObject({ resource: RESOURCE, authorization_servers: ['https://supabase.test/auth/v1'], scopes_supported: ['openid'] });
    const denied = await rpc('not-a-token');
    expect(denied.status).toBe(401);
    expect(denied.headers.get('WWW-Authenticate')).toContain('resource_metadata="https://api.test/.well-known/oauth-protected-resource/v1/mcp"');
    h.config.auth.mcpOAuthEnabled = false;
    expect((await h.call('/.well-known/oauth-protected-resource')).status).toBe(404);
    expect((await rpc('not-a-token')).headers.get('WWW-Authenticate')).not.toContain('resource_metadata');
  });

  it('requires owner consent, binds the grant to the verified client, and revokes access immediately', async () => {
    const { h, user, auth, requests, jwt, rpc, approve } = await setup();
    const access = await jwt();
    expect((await rpc(access)).status).toBe(401);
    const details = await h.route('controlMcpOAuthDetails', user.token, { authorizationId: AUTHORIZATION });
    expect(details).toMatchObject({ clientName: 'ChatGPT', clientId: CLIENT, identityScopes: 'openid' });
    expect(await approve()).toMatchObject({ redirectUrl: expect.stringContaining('https://chatgpt.com/') });
    const listed = await rpc(access);
    expect(listed.status).toBe(200);
    const data = await listed.json() as { result: { tools: Array<{ name: string; securitySchemes: unknown }> } };
    expect(data.result.tools.find(t => t.name === 'request_send')?.securitySchemes).toEqual([{ type: 'oauth2', scopes: ['openid'] }]);
    const send = await rpc(access, 'tools/call', { name: 'request_send', arguments: { to: ['lee@work.test'], subject: 'Hello', body: 'Hi Lee', idempotency_key: 'oauth-send-0001' } });
    expect(await send.json()).toMatchObject({ result: { isError: false, structuredContent: { decision: 'approval_required' } } });
    expect(h.google.account('ada@work.test').sent).toHaveLength(0);
    await expect(auth.verifyAccessToken(access)).rejects.toThrow();
    const bypass = await h.call('/v1/approvals/decide', { token: access, body: { id: AUTHORIZATION, decision: 'approve', idempotencyKey: 'bypass-approval-01' } });
    expect(bypass.status).toBe(401);
    const grants = await h.route<{ tokens: Array<{ id: string; prefix: string }> }>('controlTokens', user.token);
    expect(grants.tokens).toHaveLength(1);
    expect(grants.tokens[0]!.prefix).toBe('oauth');
    expect(JSON.stringify(await h.sql('select * from public.mcp_clients'))).not.toContain(access);
    await h.route('controlTokenRevoke', user.token, { id: grants.tokens[0]!.id });
    expect((await rpc(access)).status).toBe(401);
    expect(requests.some(r => r.method === 'DELETE' && r.path.endsWith('/user/oauth/grants'))).toBe(true);
  });

  it('enforces live application scopes and owner isolation independently of OIDC identity scopes', async () => {
    const { h, jwt, rpc, approve } = await setup();
    await approve(['read']);
    const access = await jwt();
    const denied = await rpc(access, 'tools/call', { name: 'request_send', arguments: { to: ['lee@work.test'], subject: 'Hello', body: 'Hi Lee', idempotency_key: 'read-only-send-01' } });
    expect(await denied.json()).toMatchObject({ result: { isError: true } });
    const other = await connectedUser(h, 'bob@work.test');
    const bob = await new SignJWT({ role: 'pigeonbox_mcp', client_id: CLIENT }).setProtectedHeader({ alg: 'HS256' }).setIssuer('https://supabase.test/auth/v1').setSubject(other.userId).setAudience(RESOURCE).setIssuedAt().setExpirationTime('5m').sign(new TextEncoder().encode(SECRET));
    expect((await rpc(bob)).status).toBe(401);
  });

  it('rejects expired, forged, wrong-client, wrong-role and wrong-audience tokens', async () => {
    const { jwt, rpc, approve, user } = await setup();
    await approve();
    const variants = [await jwt({}, 'forged-signature-01234567890123456789'), await jwt({ client_id: AUTHORIZATION }), await jwt({ role: 'authenticated' }), await jwt({ client_id: null })];
    for (const audience of ['authenticated', 'https://another.test/v1/mcp']) variants.push(await new SignJWT({ role: 'pigeonbox_mcp', client_id: CLIENT }).setProtectedHeader({ alg: 'HS256' }).setIssuer('https://supabase.test/auth/v1').setSubject(user.userId).setAudience(audience).setExpirationTime('5m').sign(new TextEncoder().encode(SECRET)));
    variants.push(await new SignJWT({ role: 'pigeonbox_mcp', client_id: CLIENT }).setProtectedHeader({ alg: 'HS256' }).setIssuer('https://supabase.test/auth/v1').setSubject(user.userId).setAudience(RESOURCE).setExpirationTime(1).sign(new TextEncoder().encode(SECRET)));
    for (const token of variants) expect((await rpc(token)).status).toBe(401);
  });

  it('denial creates no grant, API tokens cannot consent, and existing consents are not escalated', async () => {
    const { h, user, jwt, rpc, approve, setRedirectOnly } = await setup();
    await h.route('controlMcpOAuthDecide', user.token, { authorizationId: AUTHORIZATION, decision: 'deny', scopes: ['read'] });
    expect((await rpc(await jwt())).status).toBe(401);
    const writer = await h.route<{ token: string }>('controlTokenCreate', user.token, { name: 'Agent', scopes: ['read', 'write'] });
    expect((await h.call('/v1/control/mcp/oauth/decide', { token: writer.token, body: { authorizationId: AUTHORIZATION, decision: 'approve', scopes: ['read', 'write'] } })).status).toBe(403);
    await approve(['read']);
    setRedirectOnly();
    await approve(['read', 'write']);
    expect((await h.sql<{ scopes: string[] }>(`select scopes from public.mcp_clients where kind = 'oauth'`))[0]!.scopes).toEqual(['read']);
  });

  it('the Auth hook binds the resource and strips Data API privileges without changing person sessions', async () => {
    const { h } = await setup();
    await h.sql(`insert into app.mcp_oauth_settings (resource) values ($1)`, [RESOURCE]);
    const claims = { sub: 'fixture-user', aud: 'authenticated', role: 'authenticated', client_id: CLIENT, user_metadata: { role: 'service_role' } };
    const result = await h.pg.transaction(async tx => {
      await tx.exec('set local role supabase_auth_admin');
      return (await tx.query<{ hook: { claims: Record<string, unknown> } }>('select public.pigeonbox_mcp_access_token_hook($1::jsonb) as hook', [{ claims }])).rows[0]!.hook.claims;
    });
    expect(result).toMatchObject({ aud: RESOURCE, role: 'pigeonbox_mcp', client_id: CLIENT });
    const person = { sub: 'fixture-user', aud: 'authenticated', role: 'authenticated' };
    expect((await h.sql<{ hook: unknown }>('select public.pigeonbox_mcp_access_token_hook($1::jsonb) as hook', [{ claims: person }]))[0]!.hook).toEqual({ claims: person });
    await expect(h.pg.transaction(async tx => { await tx.exec('set local role authenticated'); await tx.query('select public.pigeonbox_mcp_access_token_hook($1::jsonb)', [{ claims }]); })).rejects.toThrow(/permission/);
  });
});
