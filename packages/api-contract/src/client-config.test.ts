import { describe, expect, it } from 'vitest';
import {
  CLIENT_CONFIG_BOUNDS,
  ClientConfigSchema,
  DEFAULT_CLIENT_CONFIG,
  clientCompatibility,
  compareClientVersions,
  extensionVersionFromClientHeader,
  resolveClientConfig,
} from './client-config';
import { ROUTES } from './routes';

const response = (config: unknown, extra: Record<string, unknown> = {}) => ({ schema: 1, revision: 'r1', config, ...extra });

describe('remote client config', () => {
  it('is a public, unauthenticated GET route', () => {
    expect(ROUTES.clientConfig).toMatchObject({ method: 'GET', path: '/v1/client/config', auth: 'none' });
  });

  it('resolves an empty config to the built-in defaults', () => {
    expect(resolveClientConfig(response({}))).toEqual({ ...DEFAULT_CLIENT_CONFIG, revision: 'r1' });
    expect(resolveClientConfig(response(undefined))).toEqual({ ...DEFAULT_CLIENT_CONFIG, revision: 'r1' });
  });

  it('rejects malformed responses and unsupported schema versions as a whole', () => {
    for (const bad of [null, 'x', 42, [], {}, { schema: 2, revision: 'r', config: {} }, { schema: '1', revision: 'r' }, { schema: 1 }, { schema: 1, revision: 'has spaces' }, { schema: 1, revision: 'x'.repeat(65) }]) {
      expect(resolveClientConfig(bad)).toBeNull();
    }
  });

  it('keeps valid fields when another field is malformed', () => {
    const config = resolveClientConfig(response({ compose: { idleMs: 'fast', cooldownMs: 4_000 }, notifications: 'often' }))!;
    expect(config.compose.idleMs).toBe(DEFAULT_CLIENT_CONFIG.compose.idleMs);
    expect(config.compose.cooldownMs).toBe(4_000);
    expect(config.notifications.pollMinutes).toBe(DEFAULT_CLIENT_CONFIG.notifications.pollMinutes);
  });

  it('ignores out-of-bounds timing instead of clamping it', () => {
    const [min, max] = CLIENT_CONFIG_BOUNDS.composeIdleMs;
    expect(resolveClientConfig(response({ compose: { idleMs: min - 1 } }))!.compose.idleMs).toBe(450);
    expect(resolveClientConfig(response({ compose: { idleMs: max + 1 } }))!.compose.idleMs).toBe(450);
    expect(resolveClientConfig(response({ compose: { idleMs: min } }))!.compose.idleMs).toBe(min);
    expect(resolveClientConfig(response({ compose: { idleMs: 450.5 } }))!.compose.idleMs).toBe(450);
    expect(resolveClientConfig(response({ notifications: { pollMinutes: 1 } }))!.notifications.pollMinutes).toBe(2);
    expect(resolveClientConfig(response({ notifications: { pollMinutes: 31 } }))!.notifications.pollMinutes).toBe(2);
    expect(resolveClientConfig(response({}, { ttlSeconds: 5 }))!.ttlSeconds).toBe(DEFAULT_CLIENT_CONFIG.ttlSeconds);
  });

  it('drops unknown fields, features and kinds, and never carries URLs, code or text', () => {
    const config = resolveClientConfig(response({
      apiUrl: 'https://evil.example',
      script: 'alert(1)',
      permissions: ['tabs'],
      disabledFeatures: ['compose_checks', 'everything', 'compose_checks'],
      compose: { disabledKinds: ['helpful_context', 'new_future_kind'], html: '<b>' },
      notice: { code: 'maintenance', message: 'Click https://evil.example' },
    }))!;
    expect(config.disabledFeatures).toEqual(['compose_checks']);
    expect(config.compose.disabledKinds).toEqual(['helpful_context']);
    expect(config.notice).toEqual({ code: 'maintenance' });
    const text = JSON.stringify(config);
    expect(text).not.toMatch(/evil|alert|tabs|<b>|apiUrl|script|permissions/);
  });

  it('rejects unknown notice codes', () => {
    expect(resolveClientConfig(response({ notice: { code: 'free_text' } }))!.notice).toBeNull();
  });

  it('validates authored config strictly on the server side', () => {
    expect(ClientConfigSchema.safeParse({ compose: { idleMs: 450 }, disabledFeatures: ['prepared_drafts'] }).success).toBe(true);
    expect(ClientConfigSchema.safeParse({ compose: { idleMs: 10 } }).success).toBe(false);
    expect(ClientConfigSchema.safeParse({ apiUrl: 'https://x' }).success).toBe(false);
    expect(ClientConfigSchema.safeParse({ notice: { code: 'maintenance', message: 'hi' } }).success).toBe(false);
    expect(ClientConfigSchema.safeParse({ compatibility: { minimumVersion: 'latest' } }).success).toBe(false);
  });

  it('classifies installed versions against the minimums', () => {
    const compat = { minimumVersion: '0.6.0', recommendedVersion: '0.6.2' };
    expect(clientCompatibility('0.5.8', compat)).toBe('update_required');
    expect(clientCompatibility('0.6.0', compat)).toBe('update_recommended');
    expect(clientCompatibility('0.6.2', compat)).toBe('compatible');
    expect(clientCompatibility('0.10.0', compat)).toBe('compatible');
    expect(clientCompatibility('dev', compat)).toBe('compatible');
    expect(clientCompatibility('0.5.8', {})).toBe('compatible');
    expect(compareClientVersions('0.10.0', '0.9.9')).toBeGreaterThan(0);
    expect(compareClientVersions('v1.0.0', '1.0.0')).toBeNull();
  });

  it('reads the extension version from the client header only in its exact form', () => {
    expect(extensionVersionFromClientHeader('extension/0.6.0')).toBe('0.6.0');
    expect(extensionVersionFromClientHeader('extension/dev')).toBeNull();
    expect(extensionVersionFromClientHeader('web/1.0.0')).toBeNull();
    expect(extensionVersionFromClientHeader(null)).toBeNull();
  });
});
