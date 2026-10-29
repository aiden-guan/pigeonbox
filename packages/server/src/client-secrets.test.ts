import { readdirSync, readFileSync, statSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { THREAD, createHarness } from './testing.js';

const ROOT = join(__dirname, '..', '..', '..');
const SERVER_SECRETS = [
  'SUPABASE_SERVICE_ROLE_KEY',
  'SUPABASE_JWT_SECRET',
  'CLOUD_AI_API_KEY',
  'CLOUD_AI_GATEWAY_TOKEN',
  'DEV_AUTH_SECRET',
  'IP_HASH_SALT',
];

function files(dir: string): string[] {
  return readdirSync(dir).flatMap((name: string) => {
    const path = join(dir, name);
    return statSync(path).isDirectory() ? files(path) : [path];
  });
}

describe('secrets never reach clients', () => {
  it('client code (dashboard, extension client and contract) names no server secret', () => {
    const clientFiles = [...files(join(ROOT, 'apps/web/public')), ...files(join(ROOT, 'packages/cloud-client/src')), ...files(join(ROOT, 'packages/api-contract/src'))];
    expect(clientFiles.length).toBeGreaterThan(5);
    for (const file of clientFiles.filter((path) => /\.(js|ts|html|css|json)$/.test(path))) {
      const text = readFileSync(file, 'utf8');
      for (const name of SERVER_SECRETS) expect(text.includes(name), `${file} mentions ${name}`).toBe(false);
      expect(text).not.toMatch(/\b(?:sk|rk)_(?:live|test)_[A-Za-z0-9]{8,}|whsec_[A-Za-z0-9]{8,}|service_role/);
    }
  });

  it('API responses and errors never contain configured secret values', async () => {
    const secrets = {
      DEV_AUTH_SECRET: 'dev-secret-value-that-must-not-leak-123',
      IP_HASH_SALT: 'salt-value-that-must-not-leak',
    };
    const h = createHarness({ env: secrets });
    const session = await h.signIn('ada@example.com');
    const responses = await Promise.all([
      h.call('/v1/health'),
      h.call('/v1/version'),
      h.call('/v1/me', { token: session.accessToken }),
      h.call('/v1/account/entitlements', { token: session.accessToken }),
      h.call('/v1/ai/summarize', { token: session.accessToken, body: { input: THREAD } }),
      h.call('/v1/me', { token: 'forged' }),
      h.call('/v1/account/delete', { token: session.accessToken, body: {} }),
      h.trackerCall('/health'),
    ]);
    const bodies = (await Promise.all(responses.map((response) => response.text()))).join('\n') + JSON.stringify(h.logs);
    for (const value of Object.values(secrets)) expect(bodies).not.toContain(value);
  });
});
