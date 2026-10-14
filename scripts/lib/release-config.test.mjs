import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { undocumentedPermissions, validateManifest } from './extension-package.mjs';
import { RELEASE_CLOUD_ENV, releaseBuildEnv, validateReleaseConfig, validateReleaseEndpoints } from './release-config.mjs';

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


test('the packaged Gmail toolbar icon remains accessible from Gmail', () => {
  const manifest = JSON.parse(readFileSync(new URL('../../apps/extension/manifest.json', import.meta.url), 'utf8'));
  const iconError = 'Gmail toolbar icon icons/icon16.png must be web accessible to Gmail';
  assert.equal(validateManifest(manifest, new Set()).includes(iconError), false);
  for (const entry of manifest.web_accessible_resources) entry.resources = entry.resources.filter(resource => resource !== 'icons/icon16.png');
  assert.equal(validateManifest(manifest, new Set()).includes(iconError), true);
});

test('release endpoints are plain https origins on production hosts', () => {
  assert.deepEqual(validateReleaseEndpoints(), []);
  for (const bad of ['http://localhost:8787', 'https://127.0.0.1', 'https://api.example.com', 'https://pigeonbox-cloud-api.pigeonbox.workers.dev:8443', 'https://api.usepigeonbox.com/v1', 'https://user:pw@api.usepigeonbox.com']) {
    assert.equal(validateReleaseEndpoints({ VITE_PIGEONBOX_CLOUD_API_URL: bad }).length, 1, bad);
  }
  assert.deepEqual(validateReleaseEndpoints({ VITE_PIGEONBOX_CLOUD_API_URL: 'https://api.usepigeonbox.com', VITE_PIGEONBOX_CLOUD_TRACKER_PREVIOUS_URLS: 'https://pigeonbox-cloud-tracker.pigeonbox.workers.dev' }), []);
});

test('a source build cannot be packaged as a release', () => {
  const data = Buffer.from(`${Object.values(RELEASE_CLOUD_ENV).join(' ')} fetch("http://127.0.0.1:5199/rebuild")`);
  assert.deepEqual(validateReleaseConfig([{ name: 'background.js', data }]), ['release contains the development rebuild helper URL (not a release build)']);
});

test('every manifest permission has a written justification', () => {
  const manifest = JSON.parse(readFileSync(new URL('../../apps/extension/manifest.json', import.meta.url), 'utf8'));
  const doc = readFileSync(new URL('../../docs/chrome-web-store.md', import.meta.url), 'utf8');
  assert.deepEqual(undocumentedPermissions(manifest, doc), []);
  assert.deepEqual(undocumentedPermissions({ ...manifest, permissions: [...manifest.permissions, 'tabs'] }, doc), ['manifest permission tabs has no justification in docs/chrome-web-store.md']);
});
