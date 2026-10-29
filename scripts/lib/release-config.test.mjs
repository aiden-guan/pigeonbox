import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { pathToFileURL } from 'node:url';
import { undocumentedPermissions, validateManifest, validateReleaseManifest } from './extension-package.mjs';
import { RELEASE_CLOUD_ENV, configuredServerEndpoints, releaseBuildEnv, validateReleaseConfig } from './release-config.mjs';

const SERVER = 'https://pigeonbox-api.example.workers.dev';
const TRACKER = 'https://pigeonbox-tracker.example.workers.dev';

test('release builds blank every server endpoint, whatever the shell or .env set', () => {
  for (const value of Object.values(RELEASE_CLOUD_ENV)) assert.equal(value, '');
  for (const inherited of [{}, { VITE_PIGEONBOX_CLOUD_API_URL: SERVER, VITE_PIGEONBOX_CLOUD_TRACKER_URL: TRACKER, VITE_PIGEONBOX_CLOUD_TRACKER_PREVIOUS_URLS: 'https://old.example', VITE_PIGEONBOX_EXPERIMENTAL: 'true' }]) {
    const env = releaseBuildEnv(inherited, '/staging/extension');
    for (const [name, value] of Object.entries(RELEASE_CLOUD_ENV)) assert.equal(env[name], value);
    assert.equal(env.PIGEONBOX_RELEASE, '1');
    assert.equal(env.VITE_PIGEONBOX_EXPERIMENTAL, 'false');
    assert.equal(env.PIGEONBOX_OUT_DIR, '/staging/extension');
  }
});

test('a clean release passes', () => {
  assert.deepEqual(validateReleaseConfig([{ name: 'background.js', data: Buffer.from('const api="";fetch("https://api.github.com/repos/aiden-guan/pigeonbox/releases")') }], [SERVER, TRACKER]), []);
});

test('a release that carries a configured server endpoint is rejected, in code or in the manifest', () => {
  assert.equal(validateReleaseConfig([{ name: 'background.js', data: Buffer.from(`const api="${SERVER}";`) }], [SERVER, TRACKER]).length, 1);
  assert.equal(validateReleaseConfig([{ name: 'manifest.json', data: Buffer.from(JSON.stringify({ externally_connectable: { matches: [`${SERVER}/*`] } })) }], [SERVER]).length, 1);
  assert.equal(validateReleaseConfig([{ name: 'assets/config.js', data: Buffer.from(`"${SERVER}","${TRACKER}"`) }], [SERVER, TRACKER]).length, 2);
  // Documentation that mentions a URL is not executable configuration.
  assert.deepEqual(validateReleaseConfig([{ name: 'README.txt', data: Buffer.from(SERVER) }], [SERVER]), []);
});

test('loopback and development URLs never reach a release', () => {
  assert.deepEqual(validateReleaseConfig([{ name: 'background.js', data: Buffer.from('fetch("http://127.0.0.1:5199/rebuild")') }], []), ['release contains the development rebuild helper URL (not a release build)']);
  assert.equal(validateReleaseConfig([{ name: 'background.js', data: Buffer.from('const api="http://127.0.0.1:8788";') }], []).length, 1);
  assert.equal(validateReleaseConfig([{ name: 'background.js', data: Buffer.from('const api="http://localhost:9999";') }], ['http://localhost:9999']).length, 1);
  // Ollama's local default is a feature of the release, not a server endpoint.
  assert.deepEqual(validateReleaseConfig([{ name: 'background.js', data: Buffer.from('const ollama="http://127.0.0.1:11434";') }], []), []);
});

test('server endpoints are collected from the shell and the extension .env files', () => {
  const dir = mkdtempSync(join(tmpdir(), 'pigeonbox-release-env-'));
  try {
    const file = join(dir, '.env.local');
    writeFileSync(file, `# comment\nVITE_PIGEONBOX_CLOUD_API_URL="${SERVER}/"\nVITE_PIGEONBOX_CLOUD_TRACKER_PREVIOUS_URLS=${TRACKER}, https://old.example\nPIGEONBOX_EXTENSION_KEY=abc\n`);
    const endpoints = configuredServerEndpoints({ VITE_PIGEONBOX_CLOUD_TRACKER_URL: 'http://127.0.0.1:8789', HOME: '/home/someone' }, [pathToFileURL(file), pathToFileURL(join(dir, 'missing'))]);
    assert.deepEqual(endpoints.sort(), ['http://127.0.0.1:8789', 'https://old.example', SERVER, TRACKER].sort());
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('a release manifest lets no website message the extension', () => {
  assert.deepEqual(validateReleaseManifest({}), []);
  assert.equal(validateReleaseManifest({ externally_connectable: { matches: [`${SERVER}/*`] } }).length, 1);
  assert.equal(validateReleaseManifest({ externally_connectable: { matches: ['http://127.0.0.1/*'] } }).length, 1);
  const source = JSON.parse(readFileSync(new URL('../../apps/extension/manifest.json', import.meta.url), 'utf8'));
  assert.deepEqual(validateReleaseManifest(source), []);
});

test('the packaged Gmail toolbar icon remains accessible from Gmail', () => {
  const manifest = JSON.parse(readFileSync(new URL('../../apps/extension/manifest.json', import.meta.url), 'utf8'));
  const iconError = 'Gmail toolbar icon icons/icon16.png must be web accessible to Gmail';
  assert.equal(validateManifest(manifest, new Set()).includes(iconError), false);
  for (const entry of manifest.web_accessible_resources) entry.resources = entry.resources.filter(resource => resource !== 'icons/icon16.png');
  assert.equal(validateManifest(manifest, new Set()).includes(iconError), true);
});

test('every manifest permission has a written justification', () => {
  const manifest = JSON.parse(readFileSync(new URL('../../apps/extension/manifest.json', import.meta.url), 'utf8'));
  const doc = readFileSync(new URL('../../docs/chrome-web-store.md', import.meta.url), 'utf8');
  assert.deepEqual(undocumentedPermissions(manifest, doc), []);
  assert.deepEqual(undocumentedPermissions({ ...manifest, permissions: [...manifest.permissions, 'tabs'] }, doc), ['manifest permission tabs has no justification in docs/chrome-web-store.md']);
});
