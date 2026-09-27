import { describe, expect, it, vi } from 'vitest';
import { CloudSessionManager, type CloudSessionDeps } from './cloud-session';

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
