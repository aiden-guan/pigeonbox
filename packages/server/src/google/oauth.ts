import { createRemoteJWKSet, jwtVerify, type JWTVerifyGetKey } from 'jose';
import { GoogleApiError, googleErrorFrom, googleNetworkError } from './errors.js';

/**
 * Google OAuth 2.0 for Cloud connections: authorization code flow with a
 * confidential client plus PKCE, offline access for a refresh token, and
 * incremental authorization (`include_granted_scopes`). Only the server ever
 * holds tokens.
 */

export type GoogleEndpoints = {
  authorize: string;
  token: string;
  revoke: string;
  jwks: string;
  gmail: string;
  calendar: string;
};

export const GOOGLE_ENDPOINTS: GoogleEndpoints = {
  authorize: 'https://accounts.google.com/o/oauth2/v2/auth',
  token: 'https://oauth2.googleapis.com/token',
  revoke: 'https://oauth2.googleapis.com/revoke',
  jwks: 'https://www.googleapis.com/oauth2/v3/certs',
  gmail: 'https://gmail.googleapis.com/gmail/v1',
  calendar: 'https://www.googleapis.com/calendar/v3',
};

export const GOOGLE_ISSUERS = ['https://accounts.google.com', 'accounts.google.com'];

export type GoogleOAuthConfig = {
  clientId: string;
  clientSecret: string;
  redirectUri: string;
  endpoints?: Partial<GoogleEndpoints>;
};

export type GoogleTokenSet = {
  accessToken: string;
  refreshToken: string | null;
  expiresAt: number;
  scopes: string[];
  idToken: string | null;
};

export type GoogleIdentity = { sub: string; email: string; emailVerified: boolean; name: string | null };

const jwksCache = new Map<string, JWTVerifyGetKey>();

/** Google's signing keys, cached per isolate. Tests use a local key set instead. */
export function googleJwks(url: string): JWTVerifyGetKey {
  let existing = jwksCache.get(url);
  if (!existing) {
    existing = createRemoteJWKSet(new URL(url));
    jwksCache.set(url, existing);
  }
  return existing;
}

export class GoogleOAuth {
  readonly endpoints: GoogleEndpoints;

  constructor(
    private readonly config: GoogleOAuthConfig,
    private readonly fetchImpl: typeof fetch = (input, init) => fetch(input, init),
    private readonly keys?: JWTVerifyGetKey,
  ) {
    this.endpoints = { ...GOOGLE_ENDPOINTS, ...config.endpoints };
  }

  authorizationUrl(params: { scopes: string[]; state: string; codeChallenge: string; loginHint?: string; forceConsent: boolean }): string {
    const url = new URL(this.endpoints.authorize);
    url.searchParams.set('client_id', this.config.clientId);
    url.searchParams.set('redirect_uri', this.config.redirectUri);
    url.searchParams.set('response_type', 'code');
    url.searchParams.set('scope', params.scopes.join(' '));
    url.searchParams.set('access_type', 'offline');
    url.searchParams.set('include_granted_scopes', 'true');
    url.searchParams.set('state', params.state);
    url.searchParams.set('code_challenge', params.codeChallenge);
    url.searchParams.set('code_challenge_method', 'S256');
    // A refresh token is only issued with consent; ask for it on first connection and re-authorization.
    if (params.forceConsent) url.searchParams.set('prompt', 'consent');
    if (params.loginHint) url.searchParams.set('login_hint', params.loginHint);
    return url.toString();
  }

  private async tokenRequest(body: Record<string, string>): Promise<GoogleTokenSet> {
    let response: Response;
    try {
      response = await this.fetchImpl(this.endpoints.token, {
        method: 'POST',
        headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
        body: new URLSearchParams({ client_id: this.config.clientId, client_secret: this.config.clientSecret, ...body }).toString(),
        signal: AbortSignal.timeout(20_000),
      });
    } catch (error) {
      throw googleNetworkError(error);
    }
    if (!response.ok) throw await googleErrorFrom(response);
    const data = (await response.json()) as {
      access_token?: string;
      refresh_token?: string;
      expires_in?: number;
      scope?: string;
      id_token?: string;
    };
    if (!data.access_token) throw new GoogleApiError('invalid_response', response.status);
    return {
      accessToken: data.access_token,
      refreshToken: data.refresh_token ?? null,
      expiresAt: Date.now() + Math.max(60, data.expires_in ?? 3_600) * 1_000,
      scopes: (data.scope ?? '').split(/\s+/).filter(Boolean),
      idToken: data.id_token ?? null,
    };
  }

  exchangeCode(code: string, codeVerifier: string): Promise<GoogleTokenSet> {
    return this.tokenRequest({ grant_type: 'authorization_code', code, code_verifier: codeVerifier, redirect_uri: this.config.redirectUri });
  }

  refresh(refreshToken: string): Promise<GoogleTokenSet> {
    return this.tokenRequest({ grant_type: 'refresh_token', refresh_token: refreshToken });
  }

  /** Revoke a refresh token at Google. Revoking an already-revoked token is not an error. */
  async revoke(token: string): Promise<void> {
    let response: Response;
    try {
      response = await this.fetchImpl(this.endpoints.revoke, {
        method: 'POST',
        headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
        body: new URLSearchParams({ token }).toString(),
      });
    } catch {
      throw new GoogleApiError('network', 0);
    }
    if (!response.ok && response.status !== 400) throw await googleErrorFrom(response);
  }

  /** Verify the ID token from the token response (signature, issuer, audience, expiry). */
  async identity(idToken: string): Promise<GoogleIdentity> {
    let payload;
    try {
      ({ payload } = await jwtVerify(idToken, this.keys ?? googleJwks(this.endpoints.jwks), { issuer: GOOGLE_ISSUERS, audience: this.config.clientId }));
    } catch {
      throw new GoogleApiError('invalid_response', 0);
    }
    const email = typeof payload.email === 'string' ? payload.email : '';
    if (typeof payload.sub !== 'string' || !payload.sub || !email) throw new GoogleApiError('invalid_response', 0);
    return {
      sub: payload.sub,
      email,
      emailVerified: payload.email_verified === true || payload.email_verified === 'true',
      name: typeof payload.name === 'string' ? payload.name.slice(0, 200) : null,
    };
  }
}
