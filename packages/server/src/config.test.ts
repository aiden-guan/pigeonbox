import { describe, expect, it } from 'vitest';
import { ConfigError, loadConfig } from './config.js';
import { apiWorker } from './deps.js';

const production = {
  ENVIRONMENT: 'production',
  AUTH_PROVIDER: 'supabase',
  DATA_STORE: 'supabase',
  SUPABASE_URL: 'https://project.supabase.co',
  SUPABASE_ANON_KEY: 'anon',
  SUPABASE_SERVICE_ROLE_KEY: 'service',
  CLOUD_AI_PROVIDER: 'cloudflare',
  CLOUD_AI_BASE_URL: 'https://gateway.ai.cloudflare.com/v1/acct/gw/compat',
  CLOUD_AI_API_KEY: 'key',
  CLOUD_AI_INPUT_COST_PER_1K_MICROS: '100',
  CLOUD_AI_OUTPUT_COST_PER_1K_MICROS: '500',
  IP_HASH_SALT: 'salt',
  PUBLIC_APP_URL: 'https://cloud.example.com',
  ALLOWED_EMAILS: 'ada@example.com,@team.example',
};

describe('config', () => {
  it('runs in development with nothing but a dev auth secret', () => {
    const config = loadConfig({ DEV_AUTH_SECRET: 'dev' });
    expect(config).toMatchObject({ environment: 'development', dataStore: 'memory', ai: { provider: 'mock' }, auth: { provider: 'dev' } });
  });

  it('accepts a complete production configuration', () => {
    expect(loadConfig(production).production).toBe(true);
  });

  it('lowercases the access list and lets development default to anyone', () => {
    expect(loadConfig({ ...production, ALLOWED_EMAILS: 'Ada@Example.com, @Team.example' }).allowedEmails).toEqual(['ada@example.com', '@team.example']);
    expect(loadConfig({ DEV_AUTH_SECRET: 'dev' }).allowedEmails).toEqual(['*']);
  });

  it.each([
    ['mock AI', { CLOUD_AI_PROVIDER: 'mock' }],
    ['dev auth', { AUTH_PROVIDER: 'dev', DEV_AUTH_SECRET: 'x' }],
    ['memory store', { DATA_STORE: 'memory' }],
    ['no access list', { ALLOWED_EMAILS: '' }],
    ['a missing IP salt', { IP_HASH_SALT: '' }],
    ['a non-HTTPS app URL', { PUBLIC_APP_URL: 'http://cloud.example.com' }],
    ['a provider without credentials', { CLOUD_AI_API_KEY: '' }],
    ['a monthly budget without AI prices', { CLOUD_AI_MONTHLY_BUDGET_MICROS: '2000000', CLOUD_AI_INPUT_COST_PER_1K_MICROS: '' }],
  ])('refuses production with %s', (_label, override) => {
    expect(() => loadConfig({ ...production, ...override })).toThrow(ConfigError);
  });

  it('lets the tracker run in production without AI or site settings', () => {
    const { CLOUD_AI_PROVIDER: _ai, CLOUD_AI_BASE_URL: _url, CLOUD_AI_API_KEY: _key, PUBLIC_APP_URL: _app, ...tracker } = production;
    expect(loadConfig(tracker, 'tracker').production).toBe(true);
    expect(() => loadConfig(tracker, 'api')).toThrow(ConfigError);
  });

  it('never includes secret values in error messages', () => {
    try {
      loadConfig({ ...production, CLOUD_AI_PROVIDER: 'mock', SUPABASE_SERVICE_ROLE_KEY: 'super-secret-service-role' });
    } catch (error) {
      expect(String(error)).not.toContain('super-secret-service-role');
    }
  });

  it('a misconfigured Worker answers 503 without details', async () => {
    const response = await apiWorker().fetch(new Request('https://api.test/v1/health'), { ...production, CLOUD_AI_PROVIDER: 'mock', STRIPE_SECRET_KEY: 'sk_test_should_not_appear' });
    expect(response.status).toBe(503);
    const text = await response.text();
    expect(text).not.toContain('CLOUD_AI_PROVIDER');
    expect(text).not.toContain('sk_test');
  });
});
