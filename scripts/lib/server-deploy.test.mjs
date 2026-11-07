import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, writeFileSync, readFileSync, existsSync, rmSync, statSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { spawnSync } from 'node:child_process';
import { parseEnv, validateServerEnv, httpsOrigin, loadSecrets, apiVars, apiSecrets, trackerSecrets, authRedirects } from '../server/deploy.mjs';

const env = {
  ALLOWED_EMAILS: 'owner@example.test', SUPABASE_URL: 'https://project.supabase.co',
  SUPABASE_ANON_KEY: 'test-anon', SUPABASE_SERVICE_ROLE_KEY: 'test-service',
  DATABASE_URL: 'postgresql://postgres:password@localhost:6543/postgres',
  CLOUD_AI_BASE_URL: 'https://ai.example.test/v1', CLOUD_AI_API_KEY: 'test-ai',
  CLOUD_AI_PRIMARY_MODEL: 'gpt-4.1-mini', CLOUD_AI_EMBED_MODEL: 'text-embedding-3-small',
};
const urls = { api: 'https://api.example.test', tracker: 'https://tracker.example.test' };
const extension = 'a'.repeat(32);
const secrets = { DATA_ENCRYPTION_KEYS: `k1:${Buffer.alloc(32, 1).toString('base64')}`, IP_HASH_SALT: 'test-salt', INTERNAL_JOB_SECRET: 'test-job-secret' };

test('env parsing preserves quoted credentials and accepts inline comments without executing shell syntax', () => {
  assert.deepEqual(parseEnv(`export CLOUD_AI_API_KEY="value # literal" # comment\r\nWORKERS_PAID=true # paid plan\nTOKEN='$(command)'\n`), {
    CLOUD_AI_API_KEY: 'value # literal', WORKERS_PAID: 'true', TOKEN: '$(command)',
  });
  for (const text of ['INVALID LINE', 'KEY="unclosed', 'KEY=a\nKEY=b']) assert.throws(() => parseEnv(text));
});

test('configuration rejects incomplete optional groups, placeholders and invalid destinations before deployment', () => {
  assert.equal(validateServerEnv(env), env);
  for (const patch of [
    { ALLOWED_EMAILS: 'you@example.com' }, { CLOUD_AI_API_KEY: '' },
    { GOOGLE_PUBSUB_TOPIC: 'projects/test/topics/mail' }, { TRACKER_QUEUE: 'yes' },
    { API_URL: 'https://api.example.test/dashboard' }, { EXTRA_EXTENSION_IDS: 'invalid' },
  ]) assert.throws(() => validateServerEnv({ ...env, ...patch }));
  assert.equal(httpsOrigin('CLOUD_AI_BASE_URL', env.CLOUD_AI_BASE_URL), 'https://ai.example.test');
  assert.throws(() => httpsOrigin('CLOUD_AI_BASE_URL', 'https://user:password@ai.example.test/v1'));
});

test('redeploying reuses private secrets and refuses to replace missing or incomplete keys', () => {
  const dir = mkdtempSync(join(tmpdir(), 'pigeonbox-server-test-'));
  const secretFile = join(dir, 'server-secrets.json'), stateFile = join(dir, 'server.json');
  try {
    const first = loadSecrets(secretFile, stateFile, true);
    assert.equal(statSync(secretFile).mode & 0o777, 0o600);
    assert.deepEqual(loadSecrets(secretFile, stateFile, true), first);
    writeFileSync(stateFile, '{}');
    rmSync(secretFile);
    assert.throws(() => loadSecrets(secretFile, stateFile, true), /Restore/);
    assert.equal(existsSync(secretFile), false);
    writeFileSync(secretFile, JSON.stringify({ IP_HASH_SALT: 'existing' }));
    const before = readFileSync(secretFile, 'utf8');
    assert.throws(() => loadSecrets(secretFile, stateFile, true), /incomplete/);
    assert.equal(readFileSync(secretFile, 'utf8'), before);
  } finally { rmSync(dir, { recursive: true, force: true }); }
});

test('dry run does not persist generated encryption keys', () => {
  const dir = mkdtempSync(join(tmpdir(), 'pigeonbox-server-test-'));
  try {
    const file = join(dir, 'secrets.json');
    assert.ok(loadSecrets(file, join(dir, 'state.json'), false).DATA_ENCRYPTION_KEYS);
    assert.equal(existsSync(file), false);
  } finally { rmSync(dir, { recursive: true, force: true }); }
});

test('Supabase redirects include every allowed extension and preserve the API callback', () => {
  const second = 'b'.repeat(32);
  assert.deepEqual(authRedirects({ EXTRA_EXTENSION_IDS: `${second}, ${extension}` }, urls, extension), [
    `https://${extension}.chromiumapp.org/**`, `https://${second}.chromiumapp.org/**`, `${urls.api}/**`,
  ]);
});

test('preflight checks real production configuration without printing credentials', () => {
  function validate(patch = {}) {
    const settings = { ...env, ...patch };
    return spawnSync(process.execPath, ['--import', 'tsx', 'scripts/server/validate-config.mts'], {
      encoding: 'utf8', input: JSON.stringify({
        api: { ...apiVars(settings, urls, extension), ...apiSecrets(settings, secrets), DATABASE_URL: settings.DATABASE_URL },
        tracker: { ENVIRONMENT: 'production', AUTH_PROVIDER: 'supabase', DATA_STORE: 'supabase', SUPABASE_URL: settings.SUPABASE_URL, ALLOWED_EMAILS: settings.ALLOWED_EMAILS, ...trackerSecrets(settings, secrets) },
      }),
    });
  }
  const good = validate();
  assert.equal(good.status, 0, good.stderr);
  for (const patch of [{ CLOUD_AI_PROVIDER: 'mock' }, { CLOUD_AI_MONTHLY_BUDGET_MICROS: '2000000' }, { WEB_SEARCH_PROVIDER: 'brave' }]) {
    const failed = validate(patch);
    assert.equal(failed.status, 1);
    assert.ok(!failed.stderr.includes(env.CLOUD_AI_API_KEY));
    assert.ok(!failed.stderr.includes(env.SUPABASE_SERVICE_ROLE_KEY));
  }
});
