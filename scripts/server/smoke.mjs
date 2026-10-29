#!/usr/bin/env node
/**
 * Read-only checks against your deployed PigeonBox server. `npm run server:deploy`
 * runs it after deploying; run it again any time with `npm run server:smoke`.
 * URLs come from the environment, else from `.local/server.json` (written by deploy).
 * Set PIGEONBOX_TEST_ACCESS_TOKEN to also check signed-in routes.
 */
import assert from 'node:assert/strict';
import { existsSync, readFileSync } from 'node:fs';
import { HealthResponseSchema, VersionResponseSchema, MeResponseSchema, CapabilitiesResponseSchema, ConnectionsResponseSchema } from '../../packages/api-contract/src/index.ts';

const deployed = existsSync(new URL('../../.local/server.json', import.meta.url)) ? JSON.parse(readFileSync(new URL('../../.local/server.json', import.meta.url), 'utf8')) : {};
const api = process.env.PIGEONBOX_API_URL ?? deployed.apiUrl;
const tracker = process.env.PIGEONBOX_TRACKER_URL ?? deployed.trackerUrl;
if (!api || !tracker) {
  console.error('Set PIGEONBOX_API_URL and PIGEONBOX_TRACKER_URL, or deploy with `npm run server:deploy` first.');
  process.exit(2);
}
const app = process.env.PIGEONBOX_APP_URL ?? api;
const expectedVersion = process.env.PIGEONBOX_EXPECT_VERSION ?? JSON.parse(readFileSync(new URL('../../package.json', import.meta.url))).version;
const expectedCommit = process.env.PIGEONBOX_EXPECT_COMMIT ?? deployed.commit;
let failures = 0;
async function check(label, fn) {
  try { await fn(); console.log(`PASS ${label}`); }
  catch { failures++; console.error(`FAIL ${label}`); }
}
async function request(base, path, token) {
  const target = new URL(path, base);
  assert.equal(target.protocol, 'https:');
  assert.equal(target.username + target.password + target.search, '');
  // Never forward a credential through a redirect or to a separate origin.
  const response = await fetch(target, { redirect: 'manual', signal: AbortSignal.timeout(20_000), headers: {
    'x-pigeonbox-protocol': '1', ...(token ? { Authorization: `Bearer ${token}` } : {}),
  } });
  assert.equal(response.status, 200);
  return response;
}
await check('API health schema and security headers', async () => {
  const r = await request(api, '/v1/health');
  assert.equal(r.headers.get('x-content-type-options'), 'nosniff');
  assert.equal(r.headers.get('referrer-policy'), 'no-referrer');
  assert.match(r.headers.get('cache-control') ?? '', /no-store/);
  assert.ok(r.headers.get('x-request-id'));
  const health = HealthResponseSchema.parse(await r.json());
  assert.equal(health.service, 'api');
  assert.ok(Number.isFinite(Date.parse(health.time)));
});
await check('API version, protocol and production provenance', async () => {
  const data = await (await request(api, '/v1/version')).json();
  const version = VersionResponseSchema.parse(data);
  assert.equal(version.version, expectedVersion);
  assert.ok(version.protocol.supported.includes(1));
  assert.equal(data.environment, 'production');
  if (expectedCommit) assert.equal(data.commit, expectedCommit);
  console.log(`BUILD ${version.version} ${data.commit} ${data.environment}`);
});
await check('Tracker health and protocol compatibility', async () => {
  const data = await (await request(tracker, '/health')).json();
  assert.equal(data.ok, true);
  assert.equal(data.protocolVersion, 3);
});
for (const path of ['/dashboard']) await check(`Static ${path}`, async () => {
  const r = await request(app, path);
  assert.match(r.headers.get('content-type') ?? '', /text\/html/);
  assert.match(await r.text(), /<html[\s>]/i);
  assert.match(r.headers.get('x-robots-tag') ?? '', /noindex/);
});
await check('Root opens the dashboard', async () => {
  const response = await fetch(new URL('/', app), { redirect: 'manual', signal: AbortSignal.timeout(20_000) });
  assert.ok([301, 302].includes(response.status));
  assert.equal(new URL(response.headers.get('location') ?? '', app).pathname, '/dashboard');
});
if (process.env.PIGEONBOX_TEST_ACCESS_TOKEN) {
  for (const [path, schema] of [['/v1/me', MeResponseSchema], ['/v1/capabilities', CapabilitiesResponseSchema], ['/v1/connections', ConnectionsResponseSchema]]) {
    await check(`Authenticated ${path}`, async () => schema.parse(await (await request(api, path, process.env.PIGEONBOX_TEST_ACCESS_TOKEN)).json()));
  }
} else console.log('BLOCKED authenticated smoke: PIGEONBOX_TEST_ACCESS_TOKEN not supplied');
process.exitCode = failures ? 1 : 0;
