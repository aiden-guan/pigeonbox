import { describe, expect, it } from 'vitest';
import { ROUTES } from '@pigeonbox/api-contract';
import { MockInferenceBackend, type CloudInferenceBackend } from './ai/backends.js';
import { THREAD, VOICE, createHarness } from './testing.js';

async function body(response: Response) {
  return (await response.json()) as Record<string, any>;
}

describe('public endpoints', () => {
  it('health', async () => {
    const h = createHarness();
    const response = await h.call('/v1/health', { protocol: null });
    expect(response.status).toBe(200);
    expect(await body(response)).toMatchObject({ ok: true, service: 'api' });
    expect(response.headers.get('x-request-id')).toMatch(/^req_/);
    expect(response.headers.get('cache-control')).toBe('no-store');
  });

  it('version reports supported protocols even to outdated clients', async () => {
    const h = createHarness({ env: { SERVICE_COMMIT: 'a'.repeat(40), SERVICE_VERSION: '0.1.0' } });
    const response = await h.call('/v1/version', { protocol: '0' });
    expect(response.status).toBe(200);
    expect(await body(response)).toMatchObject({ service: 'pigeonbox-api', commit: 'a'.repeat(40), environment: 'test', protocol: { current: 1, supported: [1] } });
  });

  it('rejects unsupported or missing protocol versions on other routes', async () => {
    const h = createHarness();
    const session = await h.signIn('ada@example.com');
    const missing = await h.call('/v1/me', { token: session.accessToken, protocol: null });
    expect(missing.status).toBe(426);
    expect((await body(missing)).error.code).toBe('unsupported_protocol');
    expect((await h.call('/v1/me', { token: session.accessToken, protocol: '2' })).status).toBe(426);
  });

  it('serves the validated client config to any client, with a revision', async () => {
    const config = { compose: { idleMs: 600 }, disabledFeatures: ['compose_completion'], notice: { code: 'maintenance' } };
    const h = createHarness({ env: { CLIENT_CONFIG: JSON.stringify(config) } });
    const response = await h.call('/v1/client/config', { protocol: null });
    expect(response.status).toBe(200);
    expect(response.headers.get('cache-control')).toBe('public, max-age=60');
    const served = await body(response);
    expect(served).toMatchObject({ schema: 1, ttlSeconds: 900, config });
    expect(served.revision).toMatch(/^c1-[0-9a-f]{8}$/);
    // Same content, different key order: same revision.
    const reordered = createHarness({ env: { CLIENT_CONFIG: JSON.stringify({ notice: { code: 'maintenance' }, disabledFeatures: ['compose_completion'], compose: { idleMs: 600 } }) } });
    expect((await body(await reordered.call('/v1/client/config'))).revision).toBe(served.revision);
  });

  it('ignores a client config that breaks the schema as a whole', async () => {
    for (const bad of ['{not json', JSON.stringify({ compose: { idleMs: 5 } }), JSON.stringify({ apiBaseUrl: 'https://evil.example' }), JSON.stringify({ disabledFeatures: ['everything'] })]) {
      const h = createHarness({ env: { CLIENT_CONFIG: bad } });
      expect(h.config.clientConfig.invalid).toBe(true);
      expect((await body(await h.call('/v1/client/config'))).config).toEqual({});
    }
    expect(createHarness().config.clientConfig).toMatchObject({ invalid: false, minimumVersion: null, config: {} });
  });

  it('answers extensions below the minimum version with 426 and the minimum, except for exempt routes', async () => {
    const h = createHarness({ env: { CLIENT_CONFIG: JSON.stringify({ compatibility: { minimumVersion: '0.6.0' } }) } });
    const session = await h.signIn('ada@example.com');
    const old = await h.call('/v1/me', { token: session.accessToken, headers: { 'x-pigeonbox-client': 'extension/0.5.9' } });
    expect(old.status).toBe(426);
    expect((await body(old)).error).toMatchObject({ code: 'unsupported_protocol', minimumVersion: '0.6.0' });
    expect((await h.call('/v1/me', { token: session.accessToken, headers: { 'x-pigeonbox-client': 'extension/0.6.0' } })).status).toBe(200);
    // The dashboard, API tokens and unversioned clients are not gated.
    expect((await h.call('/v1/me', { token: session.accessToken, headers: { 'x-pigeonbox-client': 'web/0.2.0' } })).status).toBe(200);
    expect((await h.call('/v1/me', { token: session.accessToken })).status).toBe(200);
    // An outdated extension can still learn what to do, and still forget or delete.
    expect((await h.call('/v1/client/config', { headers: { 'x-pigeonbox-client': 'extension/0.5.9' } })).status).toBe(200);
    expect((await h.call('/v1/memory/purge', { token: session.accessToken, body: {}, headers: { 'x-pigeonbox-client': 'extension/0.5.9' } })).status).not.toBe(426);
  });

  it('404 and 405', async () => {
    const h = createHarness();
    expect((await h.call('/v1/nope')).status).toBe(404);
    expect((await h.call('/v1/ai/summarize', { method: 'GET' })).status).toBe(405);
  });
});

describe('authentication', () => {
  it('signs in with PKCE and serves /v1/me', async () => {
    const h = createHarness();
    const session = await h.signIn('ada@example.com');
    const me = await body(await h.call('/v1/me', { token: session.accessToken }));
    expect(me).toEqual({ user: { id: session.user.id, email: 'ada@example.com' } });
  });

  it('rejects unauthenticated requests', async () => {
    const h = createHarness();
    const response = await h.call('/v1/ai/summarize', { body: { input: THREAD } });
    expect(response.status).toBe(401);
    expect((await body(response)).error.code).toBe('unauthenticated');
  });

  it('rejects invalid and forged tokens', async () => {
    const h = createHarness();
    expect((await h.call('/v1/me', { token: 'not-a-jwt' })).status).toBe(401);
    // A token signed with a different secret.
    const other = createHarness({ env: { DEV_AUTH_SECRET: 'a-completely-different-secret-value-xyz' } });
    const foreign = await other.signIn('mallory@example.com');
    const response = await h.call('/v1/me', { token: foreign.accessToken });
    expect(response.status).toBe(401);
    expect((await body(response)).error.code).toBe('invalid_token');
  });

  it('refuses redirects outside the allowlist', async () => {
    const h = createHarness();
    const query = new URLSearchParams({
      redirect_uri: 'https://zzzzzzzzzzzzzzzzzzzzzzzzzzzzzzzz.chromiumapp.org/cloud',
      code_challenge: 'c'.repeat(43),
      code_challenge_method: 'S256',
      state: 's'.repeat(20),
    });
    expect((await h.api(new Request(`https://api.test/v1/auth/authorize?${query}`))).status).toBe(403);
    query.set('redirect_uri', 'https://evil.example/auth/callback');
    expect((await h.api(new Request(`https://api.test/v1/auth/authorize?${query}`))).status).toBe(403);
    // The Cloud web app may complete its own sign-in at exactly /dashboard (or the
    // older /app) on an allowed origin.
    for (const uri of ['https://app.test/dashboard', 'https://app.test/app']) {
      query.set('redirect_uri', uri);
      expect((await h.api(new Request(`https://api.test/v1/auth/authorize?${query}`))).status, uri).toBe(200);
    }
    for (const uri of ['https://app.test/app/', 'https://app.test/app?next=/x', 'https://app.test/apps', 'https://evil.example/app', 'https://app.test/dashboard/', 'https://evil.example/dashboard']) {
      query.set('redirect_uri', uri);
      expect((await h.api(new Request(`https://api.test/v1/auth/authorize?${query}`))).status, uri).toBe(403);
    }
  });

  it('rejects a code exchanged with the wrong verifier, and codes are single use', async () => {
    const h = createHarness();
    const query = new URLSearchParams({ redirect_uri: 'https://abcdefghijklmnopabcdefghijklmnop.chromiumapp.org/cloud', code_challenge: 'x'.repeat(43), code_challenge_method: 'S256', state: 's'.repeat(20), email: 'ada@example.com' });
    const approve = await h.api(new Request(`https://api.test/v1/auth/dev/approve?${query}`));
    const code = new URL(approve.headers.get('Location')!).searchParams.get('code');
    const exchange = () => h.call('/v1/auth/token', { body: { code, codeVerifier: 'v'.repeat(43), redirectUri: query.get('redirect_uri') } });
    expect((await exchange()).status).toBe(401);
    expect((await exchange()).status).toBe(401);
  });

  it('refreshes sessions and revokes on sign-out', async () => {
    const h = createHarness();
    const session = await h.signIn('ada@example.com');
    const refreshed = await body(await h.call('/v1/auth/refresh', { body: { refreshToken: session.refreshToken } }));
    expect(refreshed.accessToken).toBeTruthy();
    // Refresh tokens rotate.
    expect((await h.call('/v1/auth/refresh', { body: { refreshToken: session.refreshToken } })).status).toBe(401);
    await h.call('/v1/auth/signout', { token: refreshed.accessToken, body: { refreshToken: refreshed.refreshToken } });
    expect((await h.call('/v1/auth/refresh', { body: { refreshToken: refreshed.refreshToken } })).status).toBe(401);
  });

  it('never trusts a user id sent by the client', async () => {
    const h = createHarness();
    const ada = await h.signIn('ada@example.com');
    const bob = await h.signIn('bob@example.com');
    // Extra fields are not part of the contract; identity comes from the token only.
    const response = await h.call('/v1/me', { token: ada.accessToken, headers: { 'x-user-id': bob.user.id } });
    expect((await body(response)).user.id).toBe(ada.user.id);
  });
});

describe('access list', () => {
  it('lets only listed addresses and domains sign in', async () => {
    const h = createHarness({ env: { ALLOWED_EMAILS: 'ada@example.com,@team.test' } });
    expect((await h.signIn('Ada@Example.com')).user.email).toBe('ada@example.com');
    expect((await h.signIn('bob@team.test')).user.email).toBe('bob@team.test');
    await expect(h.signIn('mallory@example.com')).rejects.toThrow('token 403');
    await expect(h.signIn('eve@notteam.test')).rejects.toThrow('token 403');
  });

  it('refuses a token held by an address that is no longer listed', async () => {
    const open = createHarness();
    const session = await open.signIn('ada@example.com');
    const closed = createHarness({ env: { ALLOWED_EMAILS: 'bob@example.com' } });
    const response = await closed.call('/v1/me', { token: session.accessToken });
    expect(response.status).toBe(403);
    expect((await body(response)).error.message).toMatch(/ALLOWED_EMAILS/);
    expect((await closed.trackerCall('/api/emails', { token: session.accessToken })).status).toBe(401);
  });
});

describe('entitlements', () => {
  it('grants every capability the server is configured for, and no more', async () => {
    const h = createHarness();
    const s = await h.signIn('ada@example.com');
    expect(await body(await h.call('/v1/capabilities', { token: s.accessToken }))).toEqual({ capabilities: ['cloud_ai', 'cloud_tracking', 'ask_inbox'] });
    expect((await h.trackerCall('/api/emails', { token: s.accessToken })).status).toBe(200);
  });

  it('reports limits and usage', async () => {
    const h = createHarness();
    const s = await h.signIn('ada@example.com');
    await h.call('/v1/ai/summarize', { token: s.accessToken, body: { input: THREAD } });
    const ent = await body(await h.call('/v1/account/entitlements', { token: s.accessToken }));
    expect(ent.usage.aiRequestsToday).toBe(1);
    expect(ent.usage.aiTokensThisMonth).toBeGreaterThan(0);
    expect(ent.limits.aiRequestsPerDay).toBe(500);
  });
});

describe('AI operations', () => {
  async function entitled(options?: Parameters<typeof createHarness>[0]) {
    const h = createHarness(options);
    const s = await h.signIn('ada@example.com');
    return { h, token: s.accessToken, userId: s.user.id };
  }

  it('summarizes through the mock provider and validates the response', async () => {
    const { h, token } = await entitled();
    const response = await h.call('/v1/ai/summarize', { token, body: { input: THREAD } });
    expect(response.status).toBe(200);
    const data = await body(response);
    expect(data.result.oneLine).toMatch(/Mock summary/);
    expect(data.usage.totalTokens).toBeGreaterThan(0);
    expect(data.model).toBe('mock-small');
    expect(data.requestId).toBe(response.headers.get('x-request-id'));
  });

  it('runs every AI operation through the same pipeline', async () => {
    const { h, token } = await entitled();
    const calls: Array<[string, unknown]> = [
      ['/v1/ai/classify', { input: { subject: 'Hi', snippet: 'x', bodyText: 'Can we meet?', latestSender: 'dana@example.com', direction: 'inbound' } }],
      ['/v1/ai/summarize', { input: THREAD }],
      ['/v1/ai/draft', { input: { ...THREAD, voice: VOICE, kind: 'reply' } }],
      ['/v1/ai/follow-up', { input: { ...THREAD, voice: VOICE, kind: 'follow_up' } }],
      ['/v1/ai/rewrite', { input: { text: 'make this better', mode: 'improve' } }],
      ['/v1/ai/ask', { input: { query: 'When is the review?', contextChunks: [{ threadId: 't1', subject: 'Review', text: 'Friday' }], coverageNote: 'All mail' } }],
      ['/v1/ai/embed', { texts: ['one', 'two'] }],
    ];
    for (const [path, payload] of calls) {
      const response = await h.call(path, { token, body: payload });
      expect(response.status, path).toBe(200);
      const route = Object.values(ROUTES).find((r) => r.path === path)!;
      expect(route.response.safeParse(await body(response)).success, path).toBe(true);
    }
    const draft = await body(await h.call('/v1/ai/draft', { token, body: { input: { ...THREAD, voice: VOICE, kind: 'reply' } } }));
    expect(draft.result.body).toMatch(/Thanks,\nAda$/);
  });

  it('rejects requests that do not match the contract', async () => {
    const { h, token } = await entitled();
    const empty = await h.call('/v1/ai/summarize', { token, body: { input: { subject: 'x', messages: [] } } });
    expect(empty.status).toBe(400);
    expect((await body(empty)).error.message).not.toContain('Could you send');
    const huge = await h.call('/v1/ai/rewrite', { token, body: { input: { text: 'x'.repeat(30_000), mode: 'improve' } } });
    expect(huge.status).toBe(400);
    const broken = await h.api(new Request('https://api.test/v1/ai/rewrite', { method: 'POST', headers: { 'x-pigeonbox-protocol': '1', Authorization: `Bearer ${token}` }, body: '{not json' }));
    expect(broken.status).toBe(400);
  });

  it('rejects AI for accounts without an entitlement', async () => {
    const h = createHarness();
    const s = await h.signIn('ada@example.com');
    // Taken off the access list after signing in: a session check refuses the token
    // outright (see 'access list'); entitlements are the second line, e.g. for API tokens.
    h.config.allowedEmails.splice(0, Infinity, 'bob@example.com');
    const response = await h.call('/v1/ai/summarize', { token: s.accessToken, body: { input: THREAD } });
    expect(response.status).toBe(402);
    expect((await body(response)).error).toMatchObject({ code: 'entitlement_required', retryable: false });
    expect(h.store.usageRows()).toHaveLength(0);
  });

  it('maps provider 429, 500 and timeouts to contract errors', async () => {
    const { h, token } = await entitled();
    const cases: Array<[string, number, string]> = [
      ['[[mock:429]]', 503, 'provider_rate_limited'],
      ['[[mock:500]]', 502, 'provider_error'],
      ['[[mock:timeout]]', 504, 'provider_timeout'],
      ['[[mock:garbage]]', 502, 'provider_invalid_response'],
    ];
    for (const [marker, status, code] of cases) {
      const response = await h.call('/v1/ai/summarize', {
        token,
        body: { input: { subject: 's', messages: [{ sender: 'a@example.com', bodyText: `hello ${marker}`, timestamp: '' }] } },
      });
      expect(response.status, marker).toBe(status);
      const error = (await body(response)).error;
      expect(error.code, marker).toBe(code);
      expect(error.message).not.toContain('hello');
    }
    const failures = h.store.usageRows().filter((row) => row.status === 'error');
    expect(failures.map((row) => row.errorCode)).toEqual(['provider_rate_limited', 'provider_error', 'provider_timeout', 'provider_invalid_response']);
  });

  it('meters usage without storing or logging email content', async () => {
    const { h, token, userId } = await entitled();
    const secret = 'Confidential merger details for Project Nightingale';
    await h.call('/v1/ai/summarize', { token, body: { input: { subject: secret, messages: [{ sender: 'ceo@example.com', bodyText: secret, timestamp: '' }] } } });
    const [row] = h.store.usageRows();
    expect(row).toMatchObject({ userId, operation: 'summarize', provider: 'mock', model: 'mock-small', status: 'ok' });
    expect(row!.inputTokens).toBeGreaterThan(0);
    expect(JSON.stringify(h.store.usageRows())).not.toContain('Nightingale');
    expect(JSON.stringify(h.logs)).not.toContain('Nightingale');
    expect(JSON.stringify(h.logs)).not.toContain('ceo@example.com');
  });

  it('rate limits per user per minute', async () => {
    const { h, token } = await entitled({ env: { CLOUD_AI_RATE_LIMIT_PER_MINUTE: '2' } });
    const statuses = [];
    for (let i = 0; i < 3; i += 1) statuses.push((await h.call('/v1/ai/rewrite', { token, body: { input: { text: 'hi', mode: 'improve' } } })).status);
    expect(statuses).toEqual([200, 200, 429]);
    const limited = await h.call('/v1/ai/rewrite', { token, body: { input: { text: 'hi', mode: 'improve' } } });
    expect(limited.headers.get('retry-after')).toMatch(/^\d+$/);
    expect((await body(limited)).error.code).toBe('rate_limited');
  });

  it('enforces the daily request quota and the global budget', async () => {
    const quota = await entitled({ env: { CLOUD_AI_DAILY_REQUEST_LIMIT: '1' } });
    expect((await quota.h.call('/v1/ai/rewrite', { token: quota.token, body: { input: { text: 'hi', mode: 'improve' } } })).status).toBe(200);
    const over = await quota.h.call('/v1/ai/rewrite', { token: quota.token, body: { input: { text: 'hi', mode: 'improve' } } });
    expect((await body(over)).error.code).toBe('quota_exceeded');

    const budget = await entitled({ env: { CLOUD_AI_GLOBAL_DAILY_TOKEN_BUDGET: '1' } });
    await budget.h.call('/v1/ai/rewrite', { token: budget.token, body: { input: { text: 'hi', mode: 'improve' } } });
    const capped = await budget.h.call('/v1/ai/rewrite', { token: budget.token, body: { input: { text: 'hi', mode: 'improve' } } });
    expect((await body(capped)).error.code).toBe('provider_unavailable');
  });

  it('limits each month by estimated cost, and reports only the share used', async () => {
    // Mock calls are ~tens of tokens; at these prices one call costs well over the 1 micro-dollar budget.
    const prices = { CLOUD_AI_INPUT_COST_PER_1K_MICROS: '100', CLOUD_AI_OUTPUT_COST_PER_1K_MICROS: '500' };
    const spent = await entitled({ env: { ...prices, CLOUD_AI_MONTHLY_BUDGET_MICROS: '1' } });
    expect((await spent.h.call('/v1/ai/rewrite', { token: spent.token, body: { input: { text: 'hi', mode: 'improve' } } })).status).toBe(200);
    const over = await spent.h.call('/v1/ai/rewrite', { token: spent.token, body: { input: { text: 'hi', mode: 'improve' } } });
    expect((await body(over)).error.code).toBe('quota_exceeded');
    const ent = await body(await spent.h.call('/v1/account/entitlements', { token: spent.token }));
    expect(ent.usage.aiMonthlyUsed).toBe(1);
    expect(JSON.stringify(ent)).not.toMatch(/budget|micros|cost/i);

    const roomy = await entitled({ env: { ...prices, CLOUD_AI_MONTHLY_BUDGET_MICROS: '2000000' } });
    await roomy.h.call('/v1/ai/rewrite', { token: roomy.token, body: { input: { text: 'hi', mode: 'improve' } } });
    const share = (await body(await roomy.h.call('/v1/account/entitlements', { token: roomy.token }))).usage.aiMonthlyUsed;
    expect(share).toBeGreaterThan(0);
    expect(share).toBeLessThan(0.001);

    // No budget (the default): never limited by cost, and no share to report.
    const unbudgeted = await entitled({ env: prices });
    await unbudgeted.h.call('/v1/ai/rewrite', { token: unbudgeted.token, body: { input: { text: 'hi', mode: 'improve' } } });
    expect((await body(await unbudgeted.h.call('/v1/account/entitlements', { token: unbudgeted.token }))).usage.aiMonthlyUsed).toBe(0);
  });

  it('validates provider output before responding', async () => {
    // A backend that returns an embedding for a different number of inputs.
    const broken: CloudInferenceBackend = {
      name: 'broken',
      chat: (req, ctx) => new MockInferenceBackend().chat(req, ctx),
      embed: async () => ({ vectors: 'nope' as unknown as number[][], model: 'x', provider: 'broken', usage: { inputTokens: 1, outputTokens: 0 } }),
      health: async () => ({ ok: true, provider: 'broken', models: [] }),
    };
    const { h, token } = await entitled({ inference: broken });
    const response = await h.call('/v1/ai/embed', { token, body: { texts: ['a'] } });
    expect(response.status).toBe(502);
    expect((await body(response)).error.code).toBe('provider_invalid_response');
  });
});

describe('CORS', () => {
  it('accepts an unpacked ID when explicitly configured, while keeping unlisted IDs blocked', async () => {
    const id = 'cdefghijklmnopabcdefghijklmnopab';
    const origin = `chrome-extension://${id}`;
    const h = createHarness({ env: { ALLOWED_EXTENSION_IDS: id } });
    const preflight = await h.call('/v1/health', { method: 'OPTIONS', protocol: null, headers: { Origin: origin, 'Access-Control-Request-Method': 'GET' } });
    expect(preflight.status).toBe(204);
    expect(preflight.headers.get('access-control-allow-origin')).toBe(origin);
    const response = await h.call('/v1/health', { protocol: null, headers: { Origin: origin } });
    expect(response.status).toBe(200);
    expect(response.headers.get('access-control-allow-origin')).toBe(origin);
    expect((await h.call('/v1/me', { headers: { Origin: origin } })).status).toBe(401);
    const rejected = await h.call('/v1/health', { method: 'OPTIONS', protocol: null, headers: { Origin: 'chrome-extension://' + 'b'.repeat(32) } });
    expect(rejected.status).toBe(403);
    expect(rejected.headers.get('access-control-allow-origin')).toBeNull();
  });
  it('allows only configured origins, never a wildcard', async () => {
    const h = createHarness();
    const preflight = (origin: string) =>
      h.api(new Request('https://api.test/v1/me', { method: 'OPTIONS', headers: { Origin: origin, 'Access-Control-Request-Method': 'GET' } }));
    const web = await preflight('https://app.test');
    expect(web.status).toBe(204);
    expect(web.headers.get('access-control-allow-origin')).toBe('https://app.test');
    const extension = await preflight('chrome-extension://abcdefghijklmnopabcdefghijklmnop');
    expect(extension.headers.get('access-control-allow-origin')).toBe('chrome-extension://abcdefghijklmnopabcdefghijklmnop');
    const evil = await preflight('https://evil.example');
    expect(evil.status).toBe(403);
    expect(evil.headers.get('access-control-allow-origin')).toBeNull();
  });
});

describe('account deletion', () => {
  it('deletes the account data and requires explicit confirmation', async () => {
    const h = createHarness();
    const s = await h.signIn('ada@example.com');
    await h.call('/v1/ai/summarize', { token: s.accessToken, body: { input: THREAD } });
    expect((await h.call('/v1/account/delete', { token: s.accessToken, body: { confirm: 'yes' } })).status).toBe(400);
    expect((await h.call('/v1/account/delete', { token: s.accessToken, body: { confirm: 'delete my account' } })).status).toBe(200);
    expect(h.store.usageRows().filter((row) => row.userId === s.user.id)).toHaveLength(0);
    expect(await h.store.profileEmail(s.user.id)).toBeNull();
  });
});
