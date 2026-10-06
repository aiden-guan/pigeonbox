import { test } from 'node:test';
import assert from 'node:assert/strict';
import { RELEASE_CLOUD_ENV, releaseBuildEnv, validateReleaseConfig } from './release-config.mjs';

test('release overrides missing or developer Cloud endpoints and experimental flags', () => {
  for (const inherited of [{}, { VITE_PIGEONBOX_CLOUD_API_URL: 'http://localhost:8787', VITE_PIGEONBOX_CLOUD_TRACKER_URL: 'https://dev.example', VITE_PIGEONBOX_CLOUD_TRACKER_PREVIOUS_URLS: 'https://old-dev.example', VITE_PIGEONBOX_EXPERIMENTAL: 'true' }]) {
    const env = releaseBuildEnv(inherited, '/staging/extension');
    for (const [name, value] of Object.entries(RELEASE_CLOUD_ENV)) assert.equal(env[name], value);
    assert.equal(env.PIGEONBOX_RELEASE, '1');
    assert.equal(env.VITE_PIGEONBOX_EXPERIMENTAL, 'false');
    assert.equal(env.PIGEONBOX_OUT_DIR, '/staging/extension');
  }
});

test('existing Local-only output cannot be repackaged as the canonical release', () => {
  assert.equal(validateReleaseConfig([{ name: 'background.js', data: Buffer.from('const api="";') }]).length, 2);
});

test('production URLs must be in executable bundles, not just documentation', () => {
  const data = Buffer.from(Object.values(RELEASE_CLOUD_ENV).join(' '));
  assert.equal(validateReleaseConfig([{ name: 'README.txt', data }]).length, 2);
  assert.deepEqual(validateReleaseConfig([{ name: 'background.js', data }]), []);
});
