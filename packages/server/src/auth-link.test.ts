import { afterEach, describe, expect, it, vi } from 'vitest';
import { createPkcePair } from '@pigeonbox/cloud-client';
import { TokenExchangeRequestSchema, type AuthorizeQuery, type CloudSession } from '@pigeonbox/api-contract';
import { SupabaseAuthProvider } from './auth.js';
import { loadConfig } from './config.js';
import { createHarness, testEnv } from './testing.js';

const ID = 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa';
const email = 'paid@example.com';
const redirectUri = 'https://app.test/dashboard';
const state = 'state-0123456789abcdef';
const queryFor = (challenge: string): AuthorizeQuery => ({ redirect_uri: redirectUri, code_challenge: challenge, code_challenge_method: 'S256', state });

afterEach(() => vi.useRealTimers());

function supabaseFixture(options: { generatedId?: string; sessionId?: string; confirmed?: boolean; currentEmail?: string } = {}) {
  let consumed = false;
  const calls: Array<{ url: string; body: Record<string, string> }> = [];
  const provider = new SupabaseAuthProvider(loadConfig(testEnv({ AUTH_PROVIDER: 'supabase', SUPABASE_URL: 'https://supabase.test', SUPABASE_ANON_KEY: 'anon', SUPABASE_SERVICE_ROLE_KEY: 'server-secret', DATA_STORE: 'memory' })), async (input, init) => {
    const url = String(input);
    const body = JSON.parse(String(init?.body ?? '{}'));
    calls.push({ url, body });
    if (url.endsWith(`/admin/users/${ID}`)) return Response.json({ id: ID, email: options.currentEmail ?? email, email_confirmed_at: options.confirmed === false ? null : '2026-01-01T00:00:00Z' });
    if (url.endsWith('/admin/generate_link')) return Response.json({ id: options.generatedId ?? ID, hashed_token: 'h'.repeat(64) });
    if (url.endsWith('/verify')) {
      if (consumed) return Response.json({ error: 'expired' }, { status: 403 });
      consumed = true;
      expect(body).toEqual({ type: 'magiclink', token_hash: 'h'.repeat(64) });
      return Response.json({ access_token: 'separate-extension-access-token', refresh_token: 'separate-extension-refresh-token', expires_in: 3600, user: { id: options.sessionId ?? ID, email } });
    }
    throw new Error('Unexpected provider request');
  });
  return { provider, calls };
}

describe('authenticated account handoff', () => {
  it('links the verified account with a one-use PKCE code and independent refresh token', async () => {
    const h = createHarness();
    const web = await h.signIn(email);
    const pair = await createPkcePair();
    const response = await h.call('/v1/auth/link', { token: web.accessToken, headers: { Origin: 'https://app.test' }, body: queryFor(pair.challenge) });
    expect(response.status).toBe(200);
    const { code, state: returnedState } = await response.json() as { code: string; state: string };
    expect(returnedState).toBe(state);
    const exchange = { code, codeVerifier: pair.verifier, redirectUri };
    const linked = await h.call('/v1/auth/token', { body: exchange });
    expect(linked.status).toBe(200);
    const extension = await linked.json() as CloudSession;
    expect(extension.user).toEqual(web.user);
    expect(extension.refreshToken).not.toBe(web.refreshToken);
    expect((await h.call('/v1/auth/token', { body: exchange })).status).toBe(401);
    expect((await h.call('/v1/auth/refresh', { body: { refreshToken: web.refreshToken } })).status).toBe(200);
    expect((await h.call('/v1/auth/refresh', { body: { refreshToken: extension.refreshToken } })).status).toBe(200);
  });

  it('rejects signed-out, foreign-origin and foreign-redirect handoffs', async () => {
    const h = createHarness();
    const web = await h.signIn(email);
    const body = queryFor((await createPkcePair()).challenge);
    expect((await h.call('/v1/auth/link', { body, headers: { Origin: 'https://app.test' } })).status).toBe(401);
    for (const origin of [undefined, 'https://evil.test', 'chrome-extension://bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb']) {
      expect((await h.call('/v1/auth/link', { token: web.accessToken, body, headers: origin ? { Origin: origin } : {} })).status).toBe(403);
    }
    for (const uri of ['https://evil.test/dashboard', 'https://app.test/dashboard?next=evil', 'https://app.test/app', 'https://app.test/dashboard#cloud']) {
      expect((await h.call('/v1/auth/link', { token: web.accessToken, body: { ...body, redirect_uri: uri }, headers: { Origin: 'https://app.test' } })).status).toBe(403);
    }
  });

  it('allows the known extension to create an independent dashboard session', async () => {
    const h = createHarness();
    const extension = await h.signIn(email);
    const pair = await createPkcePair();
    const response = await h.call('/v1/auth/link', { token: extension.accessToken, headers: { Origin: 'chrome-extension://abcdefghijklmnopabcdefghijklmnop' }, body: queryFor(pair.challenge) });
    expect(response.status).toBe(200);
    const { code } = await response.json() as { code: string };
    const dashboard = await h.call('/v1/auth/token', { body: { code, codeVerifier: pair.verifier, redirectUri } });
    expect(dashboard.status).toBe(200);
    const session = await dashboard.json() as CloudSession;
    expect(session.user).toEqual(extension.user);
    expect(session.refreshToken).not.toBe(extension.refreshToken);
    expect((await h.call('/v1/auth/refresh', { body: { refreshToken: extension.refreshToken } })).status).toBe(200);
  });

  it('production codes hide the provider token, fit the installed extension contract, and consume once', async () => {
    const { provider, calls } = supabaseFixture();
    const pair = await createPkcePair();
    const code = await provider.linkCode({ userId: ID, email }, queryFor(pair.challenge));
    expect(TokenExchangeRequestSchema.safeParse({ code, codeVerifier: pair.verifier, redirectUri }).success).toBe(true);
    expect(code).not.toContain('h'.repeat(64));
    await expect(provider.exchangeCode(code, 'w'.repeat(48), redirectUri)).rejects.toMatchObject({ code: 'invalid_token' });
    await expect(provider.exchangeCode(code, pair.verifier, 'https://evil.test/dashboard')).rejects.toMatchObject({ code: 'invalid_token' });
    expect(calls.filter((call) => call.url.endsWith('/verify'))).toHaveLength(0);
    const linked = await provider.exchangeCode(code, pair.verifier, redirectUri);
    expect(linked.refreshToken).toBe('separate-extension-refresh-token');
    await expect(provider.exchangeCode(code, pair.verifier, redirectUri)).rejects.toMatchObject({ code: 'invalid_token' });
  });

  it('rejects tampered and expired codes before calling the provider', async () => {
    const { provider, calls } = supabaseFixture();
    const pair = await createPkcePair();
    const code = await provider.linkCode({ userId: ID, email }, queryFor(pair.challenge));
    await expect(provider.exchangeCode(code.slice(0, -12) + 'tamperedtext', pair.verifier, redirectUri)).rejects.toMatchObject({ code: 'invalid_token' });
    vi.useFakeTimers();
    vi.setSystemTime(Date.now() + 61_000);
    await expect(provider.exchangeCode(code, pair.verifier, redirectUri)).rejects.toMatchObject({ code: 'invalid_token' });
    expect(calls.filter((call) => call.url.endsWith('/verify'))).toHaveLength(0);
  });

  it('uses the current verified email and rejects wrong users and unverified accounts', async () => {
    const pair = await createPkcePair();
    const current = supabaseFixture({ currentEmail: 'updated@example.com' });
    await current.provider.linkCode({ userId: ID, email: 'stale@example.com' }, queryFor(pair.challenge));
    expect(current.calls.find((call) => call.url.endsWith('/generate_link'))?.body.email).toBe('updated@example.com');
    for (const options of [{ generatedId: 'different-user' }, { confirmed: false }]) {
      const { provider } = supabaseFixture(options);
      await expect(provider.linkCode({ userId: ID, email }, queryFor(pair.challenge))).rejects.toBeTruthy();
    }
    const wrong = supabaseFixture({ sessionId: 'different-user' });
    const code = await wrong.provider.linkCode({ userId: ID, email }, queryFor(pair.challenge));
    await expect(wrong.provider.exchangeCode(code, pair.verifier, redirectUri)).rejects.toMatchObject({ code: 'internal' });
  });
});
