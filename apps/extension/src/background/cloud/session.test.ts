import { describe, expect, it, vi } from 'vitest';
import { CloudSessionManager, type CloudSessionDeps } from './session';

const API = 'https://api.example.com';
const REDIRECT = 'https://abcdefghijklmnop.chromiumapp.org/cloud';

function memoryArea() {
  const data = new Map<string, unknown>();
  return {
    data,
    async get(keys: string | string[]) {
      const out: Record<string, unknown> = {};
      for (const key of Array.isArray(keys) ? keys : [keys]) if (data.has(key)) out[key] = structuredClone(data.get(key));
      return out;
    },
    async set(items: Record<string, unknown>) {
      for (const [key, value] of Object.entries(items)) data.set(key, structuredClone(value));
    },
    async remove(keys: string | string[]) {
      for (const key of Array.isArray(keys) ? keys : [keys]) data.delete(key);
    },
  };
}

function session(overrides: { expiresAt?: number; access?: string; refresh?: string } = {}) {
  return {
    accessToken: overrides.access ?? 'access_token_aaaaaaaa',
    refreshToken: overrides.refresh ?? 'refresh_token_bbbbbbb',
    expiresAt: overrides.expiresAt ?? 2_000_000_000,
    user: { id: 'user-1', email: 'ada@example.com' },
  };
}

function json(body: unknown, status = 200) {
  return new Response(JSON.stringify(body), { status });
}

function setup(fetchImpl: (url: string, init: RequestInit) => Promise<Response>, launch?: (url: string) => Promise<string | undefined>) {
  const local = memoryArea();
  const sessionArea = memoryArea();
  const fetchMock = vi.fn(async (url: RequestInfo | URL, init?: RequestInit) => fetchImpl(String(url), init ?? {}));
  let now = 1_700_000_000_000;
  const deps: CloudSessionDeps = {
    local,
    session: sessionArea,
    redirectUrl: () => REDIRECT,
    launchAuthFlow:
      launch ??
      (async (url) => {
        const state = new URL(url).searchParams.get('state');
        return `${REDIRECT}?code=auth_code_123&state=${state}`;
      }),
    fetch: fetchMock as unknown as typeof fetch,
    clientName: 'extension/test',
    now: () => now,
  };
  return { manager: new CloudSessionManager(deps), local, sessionArea, fetchMock, advance: (ms: number) => (now += ms) };
}

describe('CloudSessionManager', () => {
  it('signs in with PKCE and stores only the refresh token persistently', async () => {
    let authorizeUrl = '';
    const { manager, local, sessionArea } = setup(
      async (url, init) => {
        expect(url).toBe(`${API}/v1/auth/token`);
        const body = JSON.parse(String(init.body));
        expect(body.code).toBe('auth_code_123');
        expect(body.redirectUri).toBe(REDIRECT);
        expect(body.codeVerifier.length).toBeGreaterThanOrEqual(43);
        return json(session());
      },
      async (url) => {
        authorizeUrl = url;
        const state = new URL(url).searchParams.get('state');
        return `${REDIRECT}?code=auth_code_123&state=${state}`;
      },
    );
    const user = await manager.signIn(API);
    expect(user.email).toBe('ada@example.com');
    expect(new URL(authorizeUrl).searchParams.get('code_challenge_method')).toBe('S256');
    const persisted = local.data.get('cloudSession') as Record<string, unknown>;
    expect(persisted).toEqual({ apiBaseUrl: API, refreshToken: 'refresh_token_bbbbbbb', user: { id: 'user-1', email: 'ada@example.com' } });
    expect(JSON.stringify(persisted)).not.toContain('access_token');
    expect(sessionArea.data.get('cloudAccess')).toMatchObject({ accessToken: 'access_token_aaaaaaaa' });
  });

  it('creates a dashboard code without copying tokens or rotating the extension session', async () => {
    const input = { redirectUri: 'https://usepigeonbox.com/dashboard', codeChallenge: 'c'.repeat(43), state: 's'.repeat(24) };
    const { manager, local } = setup(async (url, init) => {
      if (url.endsWith('/auth/token')) return json(session());
      expect(url).toBe(`${API}/v1/auth/link`);
      expect(init.credentials).toBe('omit');
      expect((init.headers as Record<string, string>).Authorization).toBe('Bearer access_token_aaaaaaaa');
      expect(JSON.parse(String(init.body))).toEqual({ redirect_uri: input.redirectUri, code_challenge: input.codeChallenge, code_challenge_method: 'S256', state: input.state });
      return json({ code: 'single-use-dashboard-code', state: input.state });
    });
    await manager.signIn(API);
    const saved = structuredClone(local.data.get('cloudSession'));
    expect(await manager.dashboardCode(API, input)).toEqual({ code: 'single-use-dashboard-code', state: input.state });
    expect(local.data.get('cloudSession')).toEqual(saved);
    await expect(manager.dashboardCode('https://other.example', input)).rejects.toMatchObject({ code: 'signed_out' });
  });

  it('refreshes an expired account once before creating a dashboard code', async () => {
    const input = { redirectUri: 'https://usepigeonbox.com/dashboard', codeChallenge: 'c'.repeat(43), state: 's'.repeat(24) };
    let links = 0;
    const { manager } = setup(async (url, init) => {
      if (url.endsWith('/auth/token')) return json(session());
      if (url.endsWith('/auth/refresh')) return json(session({ access: 'new_access_token_aaaa', refresh: 'new_refresh_token_bbbb' }));
      if (++links === 1) return json({ error: { message: 'expired' } }, 401);
      expect((init.headers as Record<string, string>).Authorization).toBe('Bearer new_access_token_aaaa');
      return json({ code: 'single-use-dashboard-code', state: input.state });
    });
    await manager.signIn(API);
    expect(await manager.dashboardCode(API, input)).toEqual({ code: 'single-use-dashboard-code', state: input.state });
    expect(links).toBe(2);
  });

  it('rejects a mismatched dashboard state without clearing the account', async () => {
    const { manager } = setup(async (url) => url.endsWith('/auth/token') ? json(session()) : json({ code: 'single-use-dashboard-code', state: 'wrong-state' }));
    await manager.signIn(API);
    await expect(manager.dashboardCode(API, { redirectUri: 'https://usepigeonbox.com/dashboard', codeChallenge: 'c'.repeat(43), state: 's'.repeat(24) })).rejects.toMatchObject({ code: 'invalid_response' });
    expect(await manager.currentUser(API)).toEqual(session().user);
  });

  it('rejects a sign-in response with the wrong state', async () => {
    const { manager, fetchMock } = setup(async () => json(session()), async () => `${REDIRECT}?code=abc12345&state=forged-state-value`);
    await expect(manager.signIn(API)).rejects.toMatchObject({ code: 'invalid_response' });
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it('rejects a callback path that merely starts with the expected path', async () => {
    const { manager, fetchMock } = setup(async () => json(session()), async (url) => {
      const state = new URL(url).searchParams.get('state');
      return `${REDIRECT}-other?code=abc12345&state=${state}`;
    });
    await expect(manager.signIn(API)).rejects.toMatchObject({ code: 'invalid_response' });
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it('refreshes an expiring access token once for concurrent callers', async () => {
    let refreshes = 0;
    const { manager, advance } = setup(async (url) => {
      if (url.endsWith('/v1/auth/token')) return json(session({ expiresAt: 1_700_000_100 }));
      refreshes += 1;
      return json(session({ access: 'access_token_refreshed', refresh: 'refresh_token_rotated', expiresAt: 1_700_010_000 }));
    });
    await manager.signIn(API);
    advance(90_000);
    const provider = manager.tokenProvider(API);
    const tokens = await Promise.all([provider.get(), provider.get(), provider.get()]);
    expect(tokens).toEqual(['access_token_refreshed', 'access_token_refreshed', 'access_token_refreshed']);
    expect(refreshes).toBe(1);
    expect((await manager.readSession())?.refreshToken).toBe('refresh_token_rotated');
  });

  it('ends the session when the server rejects the refresh token', async () => {
    const { manager, local } = setup(async (url) => {
      if (url.endsWith('/v1/auth/token')) return json(session({ expiresAt: 1 }));
      return json({ error: { code: 'invalid_token', message: 'revoked', retryable: false } }, 401);
    });
    await manager.signIn(API);
    expect(await manager.tokenProvider(API).get()).toBeNull();
    expect(local.data.has('cloudSession')).toBe(false);
  });

  it('keeps the session when the refresh request is rejected as malformed', async () => {
    const { manager, local } = setup(async (url) => {
      if (url.endsWith('/v1/auth/token')) return json(session({ expiresAt: 1 }));
      return json({ error: { code: 'invalid_request', message: 'bad', retryable: false } }, 400);
    });
    await manager.signIn(API);
    await expect(manager.tokenProvider(API).get()).rejects.toMatchObject({ code: 'invalid_request' });
    expect(local.data.has('cloudSession')).toBe(true);
  });

  it('retries with a newer refresh token instead of signing out when the old one was already rotated', async () => {
    let calls = 0;
    const { manager, local } = setup(async (url, init) => {
      if (url.endsWith('/v1/auth/token')) return json(session({ expiresAt: 1 }));
      calls += 1;
      if (calls === 1) {
        // Another refresh finished first and stored a rotated token.
        const stored = local.data.get('cloudSession') as { refreshToken: string };
        local.data.set('cloudSession', { ...stored, refreshToken: 'refresh_token_rotated' });
        return json({ error: { code: 'invalid_token', message: 'used', retryable: false } }, 401);
      }
      expect(String(init?.body)).toContain('refresh_token_rotated');
      return json(session({ access: 'access_token_refreshed', refresh: 'refresh_token_next', expiresAt: 1_700_010_000 }));
    });
    await manager.signIn(API);
    expect(await manager.tokenProvider(API).get()).toBe('access_token_refreshed');
    expect((await manager.readSession())?.refreshToken).toBe('refresh_token_next');
  });

  it('keeps the session when refresh fails because the network is down', async () => {
    const { manager, local } = setup(async (url) => {
      if (url.endsWith('/v1/auth/token')) return json(session({ expiresAt: 1 }));
      throw new TypeError('Failed to fetch');
    });
    await manager.signIn(API);
    await expect(manager.tokenProvider(API).get()).rejects.toMatchObject({ code: 'network' });
    expect(local.data.has('cloudSession')).toBe(true);
  });

  it('never sends a token to a different API origin', async () => {
    const { manager } = setup(async () => json(session()));
    await manager.signIn(API);
    expect(await manager.tokenProvider('https://evil.example.com').get()).toBeNull();
    expect(await manager.currentUser('https://evil.example.com')).toBeNull();
  });

  it('signs out locally even when the server is unreachable', async () => {
    const { manager, local, sessionArea } = setup(async (url) => {
      if (url.endsWith('/v1/auth/token')) return json(session());
      throw new TypeError('offline');
    });
    await manager.signIn(API);
    await manager.signOut();
    expect(local.data.size).toBe(0);
    expect(sessionArea.data.size).toBe(0);
  });
});
