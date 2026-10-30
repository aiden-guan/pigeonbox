import type { AuthorizeQuery, CloudSession } from '@pigeonbox/api-contract';
import { EncryptJWT, SignJWT, createRemoteJWKSet, jwtDecrypt, jwtVerify, type JWTPayload } from 'jose';
import type { Config } from './config.js';
import { ApiError } from './http.js';

export type Identity = { userId: string; email: string | null };
/** A session from a sign-in code. */
export type SignInSession = CloudSession;

/**
 * Identity provider behind `/v1/auth/*`. The extension and web app never talk
 * to it directly; the API brokers PKCE so no provider key ships to clients and
 * the provider can change without an extension release.
 */
export interface AuthProvider {
  readonly kind: 'supabase' | 'dev';
  verifyAccessToken(token: string): Promise<Identity>;
  /** Resource-bound OAuth tokens are restricted to MCP, never treated as owner sessions. */
  verifyMcpAccessToken?(token: string, resource: string): Promise<Identity & { oauthClientId: string }>;
  authorizeRedirect(query: AuthorizeQuery): Promise<Response>;
  exchangeCode(code: string, codeVerifier: string, redirectUri: string): Promise<SignInSession>;
  /** A PKCE-bound, one-use code for an independent session, using the verified account. */
  linkCode(identity: Identity, query: AuthorizeQuery): Promise<string>;
  refresh(refreshToken: string): Promise<CloudSession>;
  signOut(accessToken: string, refreshToken?: string): Promise<void>;
  deleteUser(userId: string): Promise<void>;
  /** Extra routes a provider serves (the dev sign-in form). */
  handle?(request: Request, url: URL): Promise<Response | null>;
}

/**
 * Where sign-in may return to: the Chrome identity redirect of an allowed
 * extension ID, or `/auth/callback` on an allowed web origin. Anything else is
 * refused, which closes the open-redirect and code-interception paths.
 */
const WEB_CALLBACK_PATHS: ReadonlySet<string> = new Set(['/dashboard', '/app']);

export function isAllowedRedirect(uri: string, config: Pick<Config, 'allowedExtensionIds' | 'allowedWebOrigins'>): boolean {
  let url: URL;
  try {
    url = new URL(uri);
  } catch {
    return false;
  }
  if (url.username || url.password || url.hash) return false;
  const extension = url.hostname.match(/^([a-p]{32})\.chromiumapp\.org$/);
  if (url.protocol === 'https:' && extension && !url.port) return config.allowedExtensionIds.includes(extension[1]!);
  // The website's sign-in callback, or the Cloud web app completing its own sign-in.
  return config.allowedWebOrigins.includes(url.origin) && WEB_CALLBACK_PATHS.has(url.pathname) && !url.search;
}

function withQuery(uri: string, params: Record<string, string>): string {
  const url = new URL(uri);
  for (const [key, value] of Object.entries(params)) url.searchParams.set(key, value);
  return url.toString();
}

function redirect(location: string): Response {
  return new Response(null, { status: 302, headers: { Location: location, 'Cache-Control': 'no-store', 'Referrer-Policy': 'no-referrer' } });
}

function identityFrom(payload: JWTPayload): Identity {
  if (typeof payload.sub !== 'string' || !/^[0-9a-f-]{36}$/i.test(payload.sub)) throw new ApiError('invalid_token', 'The access token has no valid subject.');
  return { userId: payload.sub.toLowerCase(), email: typeof payload.email === 'string' ? payload.email : null };
}

// ---------------------------------------------------------------------------
// Supabase Auth
// ---------------------------------------------------------------------------

type SupabaseTokenResponse = {
  access_token?: string;
  refresh_token?: string;
  expires_at?: number;
  expires_in?: number;
  user?: { id?: string; email?: string | null; created_at?: string };
};

const jwksCache = new Map<string, ReturnType<typeof createRemoteJWKSet>>();

export class SupabaseAuthProvider implements AuthProvider {
  readonly kind = 'supabase' as const;
  private readonly url: string;

  constructor(
    private readonly config: Config,
    private readonly fetchImpl: typeof fetch = (input, init) => fetch(input, init),
  ) {
    this.url = config.supabase.url!.replace(/\/+$/, '');
  }

  private async verifyPayload(token: string, audience: string): Promise<JWTPayload> {
    const issuer = `${this.url}/auth/v1`;
    try {
      if (this.config.supabase.jwtSecret) {
        const { payload } = await jwtVerify(token, new TextEncoder().encode(this.config.supabase.jwtSecret), {
          issuer,
          audience,
          algorithms: ['HS256'],
        });
        return payload;
      }
      const jwksUrl = `${issuer}/.well-known/jwks.json`;
      let jwks = jwksCache.get(jwksUrl);
      if (!jwks) {
        jwks = createRemoteJWKSet(new URL(jwksUrl));
        jwksCache.set(jwksUrl, jwks);
      }
      const { payload } = await jwtVerify(token, jwks, { issuer, audience, algorithms: ['ES256', 'RS256'] });
      return payload;
    } catch (error) {
      if (error instanceof ApiError) throw error;
      throw new ApiError('invalid_token', 'The access token is invalid or expired.');
    }
  }

  async verifyAccessToken(token: string): Promise<Identity> {
    const payload = await this.verifyPayload(token, 'authenticated');
    if (payload.client_id != null) throw new ApiError('invalid_token', 'OAuth clients must use the scoped MCP endpoint.');
    return identityFrom(payload);
  }

  async verifyMcpAccessToken(token: string, resource: string): Promise<Identity & { oauthClientId: string }> {
    const payload = await this.verifyPayload(token, resource);
    if (payload.role !== 'pigeonbox_mcp' || typeof payload.client_id !== 'string' || !/^[0-9a-f-]{36}$/i.test(payload.client_id)) {
      throw new ApiError('invalid_token', 'This is not a PigeonBox MCP access token.');
    }
    return { ...identityFrom(payload), oauthClientId: payload.client_id.toLowerCase() };
  }

  async authorizeRedirect(query: AuthorizeQuery): Promise<Response> {
    const target = new URL(`${this.url}/auth/v1/authorize`);
    target.searchParams.set('provider', this.config.auth.oauthProvider);
    // Supabase does not round-trip our `state`, so it rides on the redirect URI.
    target.searchParams.set('redirect_to', withQuery(query.redirect_uri, { state: query.state }));
    target.searchParams.set('code_challenge', query.code_challenge);
    target.searchParams.set('code_challenge_method', 's256');
    return redirect(target.toString());
  }

  private async token(grant: 'pkce' | 'refresh_token', body: Record<string, string>): Promise<SignInSession> {
    let response: Response;
    try {
      response = await this.fetchImpl(`${this.url}/auth/v1/token?grant_type=${grant}`, {
        method: 'POST',
        headers: { apikey: this.config.supabase.anonKey!, 'Content-Type': 'application/json' },
        body: JSON.stringify(body),
      });
    } catch {
      throw new ApiError('internal', 'The sign-in service is unreachable.');
    }
    if (response.status >= 500) throw new ApiError('internal', 'The sign-in service failed.');
    if (response.status === 429) throw new ApiError('rate_limited', 'The sign-in service is busy. Try again shortly.');
    if (!response.ok) throw new ApiError('invalid_token', grant === 'pkce' ? 'The sign-in code is invalid or expired.' : 'The session has ended. Sign in again.');
    const data = (await response.json()) as SupabaseTokenResponse;
    if (!data.access_token || !data.refresh_token || !data.user?.id) throw new ApiError('internal', 'The sign-in service returned an incomplete session.');
    return {
      accessToken: data.access_token,
      refreshToken: data.refresh_token,
      expiresAt: data.expires_at ?? Math.floor(Date.now() / 1000) + (data.expires_in ?? 3600),
      user: { id: data.user.id, email: data.user.email ?? null },
    };
  }

  private async linkKey() {
    const key = this.config.supabase.serviceRoleKey;
    if (!key) throw new ApiError('not_configured', 'Account connection is not configured.');
    return new Uint8Array(await crypto.subtle.digest('SHA-256', new TextEncoder().encode(`pigeonbox-link:${this.url}:${key}`)));
  }

  async linkCode(identity: Identity, query: AuthorizeQuery): Promise<string> {
    const key = await this.linkKey();
    // Read the current auth user first; a stale email claim must never create another user.
    const headers = { apikey: this.config.supabase.serviceRoleKey!, Authorization: `Bearer ${this.config.supabase.serviceRoleKey!}`, 'Content-Type': 'application/json' };
    const current = await this.fetchImpl(`${this.url}/auth/v1/admin/users/${identity.userId}`, { headers });
    if (!current.ok) throw new ApiError('invalid_token', 'Your PigeonBox account could not be verified. Sign in again.');
    const user = await current.json() as { id?: string; email?: string; email_confirmed_at?: string };
    if (user.id !== identity.userId || !user.email || !user.email_confirmed_at) throw new ApiError('invalid_token', 'Your PigeonBox account email must be verified.');
    // generate_link sends no email. /verify consumes the provider token once and
    // creates a separate refresh token for the extension and dashboard.
    const response = await this.fetchImpl(`${this.url}/auth/v1/admin/generate_link`, {
      method: 'POST', headers, body: JSON.stringify({ type: 'magiclink', email: user.email }),
    });
    if (!response.ok) throw new ApiError('internal', 'Could not connect your PigeonBox account. Try again.');
    const data = await response.json() as { id?: string; hashed_token?: string };
    if (data.id !== identity.userId || !data.hashed_token || data.hashed_token.length > 128) throw new ApiError('internal', 'Account connection returned an invalid code.');
    // Compact fields keep the encrypted code inside the existing 512-byte public contract.
    return `pbl_${await new EncryptJWT({ h: data.hashed_token, c: query.code_challenge, r: await sha256Base64Url(query.redirect_uri) })
      .setProtectedHeader({ alg: 'dir', enc: 'A256GCM' }).setSubject(identity.userId).setAudience('pb-link').setExpirationTime('60s').encrypt(key)}`;
  }

  async exchangeCode(code: string, codeVerifier: string, redirectUri: string) {
    if (!code.startsWith('pbl_')) return this.token('pkce', { auth_code: code, code_verifier: codeVerifier });
    let payload: JWTPayload;
    try {
      ({ payload } = await jwtDecrypt(code.slice(4), await this.linkKey(), { audience: 'pb-link', keyManagementAlgorithms: ['dir'], contentEncryptionAlgorithms: ['A256GCM'] }));
    } catch {
      throw new ApiError('invalid_token', 'Account connection expired or could not be verified. Try again.');
    }
    if (payload.c !== await sha256Base64Url(codeVerifier) || payload.r !== await sha256Base64Url(redirectUri) || typeof payload.h !== 'string' || typeof payload.sub !== 'string') {
      throw new ApiError('invalid_token', 'Account connection could not be verified.');
    }
    const response = await this.fetchImpl(`${this.url}/auth/v1/verify`, {
      method: 'POST', headers: { apikey: this.config.supabase.anonKey!, 'Content-Type': 'application/json' },
      body: JSON.stringify({ type: 'magiclink', token_hash: payload.h }),
    });
    if (!response.ok) throw new ApiError(response.status >= 500 ? 'internal' : 'invalid_token', 'Account connection failed or expired. Try again.');
    const data = await response.json() as SupabaseTokenResponse;
    if (!data.access_token || !data.refresh_token || data.user?.id !== payload.sub) throw new ApiError('internal', 'Account connection returned an invalid session.');
    return { accessToken: data.access_token, refreshToken: data.refresh_token, expiresAt: data.expires_at ?? Math.floor(Date.now() / 1000) + (data.expires_in ?? 3600), user: { id: data.user.id, email: data.user.email ?? null } };
  }

  refresh(refreshToken: string) {
    return this.token('refresh_token', { refresh_token: refreshToken });
  }

  async signOut(accessToken: string) {
    await this.fetchImpl(`${this.url}/auth/v1/logout?scope=local`, {
      method: 'POST',
      headers: { apikey: this.config.supabase.anonKey!, Authorization: `Bearer ${accessToken}` },
    }).catch(() => undefined);
  }

  async deleteUser(userId: string) {
    const key = this.config.supabase.serviceRoleKey;
    if (!key) throw new ApiError('not_configured', 'Account deletion is not configured.');
    const response = await this.fetchImpl(`${this.url}/auth/v1/admin/users/${encodeURIComponent(userId)}`, {
      method: 'DELETE',
      headers: { apikey: key, Authorization: `Bearer ${key}` },
    });
    if (!response.ok && response.status !== 404) throw new ApiError('internal', 'Could not delete the account.');
  }
}

// ---------------------------------------------------------------------------
// Development auth: a local sign-in form. Refused in production by config.
// ---------------------------------------------------------------------------

type PendingCode = { challenge: string; redirectUri: string; email: string; expiresAt: number };

const DEV_ISSUER = 'pigeonbox-dev';

async function sha256Base64Url(value: string): Promise<string> {
  const digest = new Uint8Array(await crypto.subtle.digest('SHA-256', new TextEncoder().encode(value)));
  let binary = '';
  for (const byte of digest) binary += String.fromCharCode(byte);
  return btoa(binary).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
}

/** A stable UUID for a development email address. */
export async function devUserId(email: string): Promise<string> {
  const digest = new Uint8Array(await crypto.subtle.digest('SHA-256', new TextEncoder().encode(`pigeonbox-dev:${email.toLowerCase()}`)));
  const hex = [...digest.slice(0, 16)].map((byte) => byte.toString(16).padStart(2, '0')).join('');
  return `${hex.slice(0, 8)}-${hex.slice(8, 12)}-4${hex.slice(13, 16)}-8${hex.slice(17, 20)}-${hex.slice(20, 32)}`;
}

function escapeHtml(value: string): string {
  return value.replace(/[&<>"']/g, (char) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[char]!);
}

export class DevAuthProvider implements AuthProvider {
  readonly kind = 'dev' as const;
  private readonly secret: Uint8Array;
  private readonly codes = new Map<string, PendingCode>();
  private readonly refreshTokens = new Map<string, { email: string }>();

  constructor(private readonly config: Config) {
    this.secret = new TextEncoder().encode(config.auth.devSecret!);
  }

  async verifyAccessToken(token: string): Promise<Identity> {
    try {
      const { payload } = await jwtVerify(token, this.secret, { issuer: DEV_ISSUER, audience: 'authenticated', algorithms: ['HS256'] });
      return identityFrom(payload);
    } catch (error) {
      if (error instanceof ApiError) throw error;
      throw new ApiError('invalid_token', 'The access token is invalid or expired.');
    }
  }

  /** Development sign-in: a form asking for any email address. */
  async authorizeRedirect(query: AuthorizeQuery): Promise<Response> {
    const hidden = (name: string, value: string) => `<input type="hidden" name="${name}" value="${escapeHtml(value)}">`;
    const html = `<!doctype html><html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1">
<title>PigeonBox server · development sign-in</title>
<style>body{font:15px system-ui;background:#161512;color:#efe9df;display:grid;place-items:center;min-height:100vh;margin:0}
form{background:#211f1b;padding:28px;border-radius:18px;width:min(360px,90vw)}input{width:100%;box-sizing:border-box;padding:10px;border-radius:10px;border:1px solid #444;background:#111;color:#eee;margin:12px 0}
button{padding:10px 16px;border:0;border-radius:999px;background:#dda77a;color:#1b1712;font-weight:600}small{color:#aaa}</style></head>
<body><form method="GET" action="/v1/auth/dev/approve"><h1 style="font-size:18px;margin:0 0 6px">Development sign-in</h1>
<small>This server runs with AUTH_PROVIDER=dev. Any email address signs in. Never enabled in production.</small>
<input name="email" type="email" aria-label="Email" required autofocus placeholder="you@example.com">
${hidden('redirect_uri', query.redirect_uri)}${hidden('code_challenge', query.code_challenge)}${hidden('state', query.state)}
<button type="submit">Sign in</button></form></body></html>`;
    return new Response(html, { status: 200, headers: { 'Content-Type': 'text/html; charset=utf-8', 'Cache-Control': 'no-store', 'Content-Security-Policy': "default-src 'none'; style-src 'unsafe-inline'; form-action 'self'" } });
  }

  async handle(request: Request, url: URL): Promise<Response | null> {
    if (request.method !== 'GET' || url.pathname !== '/v1/auth/dev/approve') return null;
    const email = (url.searchParams.get('email') || '').trim().toLowerCase();
    const redirectUri = url.searchParams.get('redirect_uri') || '';
    const challenge = url.searchParams.get('code_challenge') || '';
    const state = url.searchParams.get('state') || '';
    if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email) || !/^[A-Za-z0-9_-]{43,128}$/.test(challenge) || state.length < 16) {
      throw new ApiError('invalid_request', 'The sign-in request is incomplete.');
    }
    if (!isAllowedRedirect(redirectUri, this.config)) throw new ApiError('forbidden', 'That redirect address is not allowed.');
    const code = crypto.randomUUID().replace(/-/g, '');
    this.codes.set(code, { challenge, redirectUri, email, expiresAt: Date.now() + 5 * 60_000 });
    return redirect(withQuery(redirectUri, { code, state }));
  }

  private async session(email: string): Promise<CloudSession> {
    const userId = await devUserId(email);
    const expiresAt = Math.floor(Date.now() / 1000) + 3600;
    const accessToken = await new SignJWT({ email })
      .setProtectedHeader({ alg: 'HS256' })
      .setSubject(userId)
      .setIssuer(DEV_ISSUER)
      .setAudience('authenticated')
      .setIssuedAt()
      .setExpirationTime(expiresAt)
      .sign(this.secret);
    const refreshToken = `dev_rt_${crypto.randomUUID().replace(/-/g, '')}`;
    this.refreshTokens.set(refreshToken, { email });
    return { accessToken, refreshToken, expiresAt, user: { id: userId, email } };
  }

  async exchangeCode(code: string, codeVerifier: string, redirectUri: string): Promise<SignInSession> {
    const pending = this.codes.get(code);
    this.codes.delete(code);
    if (!pending || pending.expiresAt < Date.now() || pending.redirectUri !== redirectUri) {
      throw new ApiError('invalid_token', 'The sign-in code is invalid or expired.');
    }
    if ((await sha256Base64Url(codeVerifier)) !== pending.challenge) throw new ApiError('invalid_token', 'The sign-in code could not be verified.');
    return this.session(pending.email);
  }

  async linkCode(identity: Identity, query: AuthorizeQuery): Promise<string> {
    if (!identity.email || await devUserId(identity.email) !== identity.userId) throw new ApiError('invalid_token', 'Account connection could not be verified.');
    const code = crypto.randomUUID().replace(/-/g, '');
    this.codes.set(code, { challenge: query.code_challenge, redirectUri: query.redirect_uri, email: identity.email, expiresAt: Date.now() + 60_000 });
    return code;
  }

  async refresh(refreshToken: string): Promise<CloudSession> {
    const known = this.refreshTokens.get(refreshToken);
    if (!known) throw new ApiError('invalid_token', 'The session has ended. Sign in again.');
    this.refreshTokens.delete(refreshToken);
    return this.session(known.email);
  }

  async signOut(_accessToken: string, refreshToken?: string) {
    if (refreshToken) this.refreshTokens.delete(refreshToken);
  }

  async deleteUser() {
    /* Development users exist only as tokens. */
  }
}

export function createAuthProvider(config: Config, fetchImpl?: typeof fetch): AuthProvider {
  const provider = config.auth.provider === 'supabase' ? new SupabaseAuthProvider(config, fetchImpl) : new DevAuthProvider(config);
  return config.allowedEmails.includes('*') ? provider : restrictTo(provider, config.allowedEmails);
}

/**
 * ALLOWED_EMAILS entries are addresses (`ada@example.com`) or whole domains
 * (`@example.com`); `*` allows anyone who can sign in with the identity provider.
 */
export function isAllowedEmail(email: string | null, allowed: readonly string[]): boolean {
  if (allowed.includes('*')) return true;
  const address = email?.trim().toLowerCase();
  if (!address) return false;
  return allowed.some((entry) => (entry.startsWith('@') ? address.endsWith(entry) : address === entry));
}

const NOT_ALLOWED = 'This account is not allowed on this PigeonBox server. Ask the server owner to add your address to ALLOWED_EMAILS.';

/**
 * Checks every identity the provider verifies against the access list, so a
 * person who is not on it can neither finish signing in nor use a token they
 * already hold. The identity provider may still create their account.
 */
function restrictTo(provider: AuthProvider, allowed: readonly string[]): AuthProvider {
  const allow = <T extends { email: string | null }>(identity: T): T => {
    if (!isAllowedEmail(identity.email, allowed)) throw new ApiError('forbidden', NOT_ALLOWED);
    return identity;
  };
  const mcp = provider.verifyMcpAccessToken?.bind(provider);
  const handle = provider.handle?.bind(provider);
  return {
    kind: provider.kind,
    verifyAccessToken: async (token) => allow(await provider.verifyAccessToken(token)),
    ...(mcp ? { verifyMcpAccessToken: async (token: string, resource: string) => allow(await mcp(token, resource)) } : {}),
    authorizeRedirect: (query) => provider.authorizeRedirect(query),
    exchangeCode: async (code, codeVerifier, redirectUri) => {
      const session = await provider.exchangeCode(code, codeVerifier, redirectUri);
      allow(session.user);
      return session;
    },
    linkCode: (identity, query) => provider.linkCode(allow(identity), query),
    refresh: async (refreshToken) => {
      const session = await provider.refresh(refreshToken);
      allow(session.user);
      return session;
    },
    signOut: (accessToken, refreshToken) => provider.signOut(accessToken, refreshToken),
    deleteUser: (userId) => provider.deleteUser(userId),
    ...(handle ? { handle } : {}),
  };
}

/** Pull the bearer token and verify it. */
export async function authenticate(request: Request, auth: AuthProvider): Promise<Identity & { token: string }> {
  const header = request.headers.get('Authorization') || '';
  if (!header.startsWith('Bearer ')) throw new ApiError('unauthenticated', 'Sign in to your PigeonBox server.');
  const token = header.slice(7).trim();
  if (!token) throw new ApiError('unauthenticated', 'Sign in to your PigeonBox server.');
  return { ...(await auth.verifyAccessToken(token)), token };
}
