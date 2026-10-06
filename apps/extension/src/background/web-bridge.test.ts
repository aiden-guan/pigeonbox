import { describe, expect, it, vi } from 'vitest';
import { DEFAULT_SETTINGS, type ExtensionSettings } from '@pigeonbox/shared';
import { editablePatch, handleWebMessage, isDashboardSender, type WebBridgeDeps } from './web-bridge';

const DASHBOARD = { origin: 'https://usepigeonbox.com', url: 'https://usepigeonbox.com/dashboard' };

function deps(overrides: Partial<WebBridgeDeps> = {}) {
  let settings: ExtensionSettings = { ...DEFAULT_SETTINGS, aiApiKey: 'sk-secret', personalApiToken: 'tok-secret', cloudApiUrl: '' };
  const store = new Map<string, unknown>();
  const productMessage = vi.fn(async (message: Record<string, unknown>) => ({ ok: true, echoed: message }));
  const exchangeLinkedCode = vi.fn(async () => ({ id: 'u1', email: 'a@example.com' }));
  const value: WebBridgeDeps = {
    extensionId: 'abcdefghijklmnopabcdefghijklmnop',
    version: '0.6.0',
    storeInstall: async () => true,
    allowLoopback: false,
    settings: () => settings,
    saveSettings: async (partial) => (settings = { ...settings, ...partial }),
    productState: async () => ({ runMode: settings.runMode }),
    productMessage,
    apiBaseUrl: () => 'https://api.example.com',
    exchangeLinkedCode,
    afterSignIn: async () => undefined,
    agentRules: async () => [],
    saveAgentRules: async () => undefined,
    analytics: { get: async () => false, set: async () => undefined },
    action: async () => null,
    noteDashboardTab: async () => undefined,
    hasOrigins: async () => false,
    openGrant: vi.fn(async () => undefined),
    session: {
      get: async (key) => ({ [key]: store.get(key) }),
      set: async (items) => void Object.entries(items).forEach(([key, item]) => store.set(key, item)),
      remove: async (key) => void store.delete(key),
    },
    ...overrides,
  };
  return { deps: value, productMessage, exchangeLinkedCode, current: () => settings };
}

describe('dashboard bridge', () => {
  it('answers only the dashboard origins', async () => {
    const { deps: d } = deps();
    expect(isDashboardSender(DASHBOARD, d)).toBe(true);
    expect(isDashboardSender({ origin: 'https://evil.example' }, d)).toBe(false);
    expect(isDashboardSender({ origin: 'http://127.0.0.1:8788' }, d)).toBe(false);
    expect(isDashboardSender({ origin: 'http://127.0.0.1:8788' }, { ...d, allowLoopback: true })).toBe(true);
    // The Cloud API serves its own copy of the dashboard.
    expect(isDashboardSender({ origin: 'https://api.example.com' }, d)).toBe(true);
    expect(await handleWebMessage({ type: 'HELLO' }, { origin: 'https://evil.example' }, d)).toMatchObject({ ok: false, code: 'forbidden' });
  });

  it('never returns secrets or the developer API override', async () => {
    const { deps: d } = deps();
    const reply = (await handleWebMessage({ type: 'GET_SETTINGS' }, DASHBOARD, d)) as { settings: Record<string, unknown> };
    expect(JSON.stringify(reply)).not.toContain('secret');
    expect(reply.settings).toMatchObject({ hasAiApiKey: true, hasPersonalApiToken: true });
    expect(reply.settings).not.toHaveProperty('cloudApiUrl');
  });

  it('saves only editable settings; run mode and the Cloud API stay out of reach', async () => {
    expect(editablePatch({ runMode: 'cloud', cloudConsentAt: 'x', cloudApiUrl: 'https://evil.example', autoArchive: true, aiApiKey: 42 })).toEqual({ autoArchive: true });
    const { deps: d, current } = deps();
    await handleWebMessage({ type: 'SAVE_SETTINGS', settings: { runMode: 'cloud', trackOpens: false } }, DASHBOARD, d);
    expect(current().runMode).toBe('local');
    expect(current().trackOpens).toBe(false);
  });

  it('reports the Chrome access a saved tracker needs', async () => {
    const { deps: d } = deps();
    const reply = await handleWebMessage({ type: 'SAVE_SETTINGS', settings: { trackerBaseUrl: 'https://track.example' } }, DASHBOARD, d);
    expect(reply).toMatchObject({ ok: true, missingOrigins: expect.arrayContaining(['https://track.example/*']) });
  });

  it('switches to Cloud only with consent from the page', async () => {
    const { deps: d, productMessage } = deps();
    await handleWebMessage({ type: 'SET_RUN_MODE', mode: 'cloud' }, DASHBOARD, d);
    expect(productMessage).toHaveBeenLastCalledWith({ type: 'SET_RUN_MODE', mode: 'cloud', consent: false });
    await handleWebMessage({ type: 'SET_RUN_MODE', mode: 'cloud', consent: true }, DASHBOARD, d);
    expect(productMessage).toHaveBeenLastCalledWith({ type: 'SET_RUN_MODE', mode: 'cloud', consent: true });
  });

  it('links Cloud with PKCE: the page carries the code, the worker keeps the verifier', async () => {
    const { deps: d, exchangeLinkedCode } = deps();
    const begin = (await handleWebMessage({ type: 'LINK_BEGIN', redirectUri: 'https://usepigeonbox.com/dashboard' }, DASHBOARD, d)) as { codeChallenge: string; state: string };
    expect(begin.codeChallenge).toMatch(/^[A-Za-z0-9_-]{43}$/);
    expect(JSON.stringify(begin)).not.toContain('verifier');

    expect(await handleWebMessage({ type: 'LINK_COMPLETE', code: 'c', state: 'wrong' }, DASHBOARD, d)).toMatchObject({ ok: false });
    // A failed attempt does not consume the pending link.
    const done = await handleWebMessage({ type: 'LINK_COMPLETE', code: 'the-code', state: begin.state }, DASHBOARD, d);
    expect(done).toMatchObject({ ok: true, user: { email: 'a@example.com' } });
    expect(exchangeLinkedCode).toHaveBeenCalledWith('https://api.example.com', expect.objectContaining({ code: 'the-code', redirectUri: 'https://usepigeonbox.com/dashboard', codeVerifier: expect.any(String) }));
    // Single use.
    expect(await handleWebMessage({ type: 'LINK_COMPLETE', code: 'the-code', state: begin.state }, DASHBOARD, d)).toMatchObject({ ok: false });
  });

  it('refuses a sign-in return address on another origin or path', async () => {
    const { deps: d } = deps();
    for (const redirectUri of ['https://evil.example/dashboard', 'https://usepigeonbox.com/other', 'https://usepigeonbox.com/dashboard?x=1']) {
      expect(await handleWebMessage({ type: 'LINK_BEGIN', redirectUri }, DASHBOARD, d)).toMatchObject({ ok: false });
    }
  });

  it('opens its own window for Chrome access and accepts only plain origins', async () => {
    const openGrant = vi.fn(async () => undefined);
    const { deps: d } = deps({ openGrant });
    expect(await handleWebMessage({ type: 'GRANT', origins: ['<all_urls>', 'https://*/*'] }, DASHBOARD, d)).toMatchObject({ ok: false });
    await handleWebMessage({ type: 'GRANT', origins: ['https://track.example/*'] }, DASHBOARD, d);
    expect(openGrant).toHaveBeenCalledWith(['https://track.example/*']);
  });
});
