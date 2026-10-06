import { chromium, test, expect } from '@playwright/test';
import { mkdtemp, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';

// Run directly against the extracted ZIP, without build-browser-fixture.mjs.
// No fixture pages, developer host permissions, or backend credentials are added.
test('one release includes Local and Cloud while preserving consent and dashboard settings', async () => {
  const extension = process.env.PIGEONBOX_BROWSER_EXTENSION_PATH;
  test.skip(!extension, 'Requires the extracted production ZIP.');
  const version = JSON.parse(await readFile('package.json', 'utf8')).version;
  const profile = await mkdtemp(path.join(tmpdir(), 'pigeonbox-release-'));
  const context = await chromium.launchPersistentContext(profile, {
    channel: 'chromium', headless: true,
    args: [`--disable-extensions-except=${extension}`, `--load-extension=${extension}`],
  });
  try {
    const worker = context.serviceWorkers()[0] ?? await context.waitForEvent('serviceworker');
    const id = worker.url().split('/')[2];
    const page = await context.newPage();
    await context.route('https://usepigeonbox.com/dashboard**', (route) => route.fulfill({ contentType: 'text/html', body: '<!doctype html><title>PigeonBox dashboard</title>' }));
    await page.goto(`https://usepigeonbox.com/dashboard?ext=${id}`);
    const send = (message: Record<string, unknown>) => page.evaluate(({ id, message }) => chrome.runtime.sendMessage(id, message), { id, message });
    const hello = await send({ type: 'HELLO' });
    expect(hello).toMatchObject({ ok: true, version, apiBaseUrl: 'https://pigeonbox-cloud-api.pigeonbox.workers.dev', product: { runMode: 'local', cloudAvailable: true, cloudConsentAt: null, experimental: false } });
    expect(hello.product.cloudOrigins).toEqual(expect.arrayContaining(['https://pigeonbox-cloud-api.pigeonbox.workers.dev/*', 'https://pigeonbox-cloud-tracker.pigeonbox.workers.dev/*']));

    const before = await send({ type: 'GET_SETTINGS' });
    expect(before.settings).not.toHaveProperty('cloudApiUrl');
    expect(before.settings).not.toHaveProperty('aiApiKey');
    const autoSummarize = !before.settings.autoSummarize;
    expect(await send({ type: 'SAVE_SETTINGS', settings: { autoSummarize, cloudApiUrl: 'https://untrusted.example' } })).toMatchObject({ ok: true, settings: { autoSummarize } });
    await page.reload();
    expect(await send({ type: 'GET_SETTINGS' })).toMatchObject({ ok: true, settings: { autoSummarize }, product: { runMode: 'local' } });
    expect((await send({ type: 'HELLO' })).apiBaseUrl).toBe(hello.apiBaseUrl);

    expect(await send({ type: 'SET_RUN_MODE', mode: 'cloud' })).toMatchObject({ ok: false, reason: expect.stringContaining('agreement') });
    expect((await send({ type: 'HELLO' })).product).toMatchObject({ runMode: 'local', cloudConsentAt: null });
    const cloud = await send({ type: 'SET_RUN_MODE', mode: 'cloud', consent: true });
    expect(cloud).toMatchObject({ ok: true, state: { runMode: 'cloud', cloudAvailable: true, cloud: { status: 'signed_out', capabilities: [] } } });
    expect(cloud.state.cloudConsentAt).toEqual(expect.any(String));
    // Including the endpoints does not give an anonymous installation paid capabilities.
    expect(cloud.state.capabilities).not.toContain('cloud_ai');
    expect(await send({ type: 'SET_RUN_MODE', mode: 'local' })).toMatchObject({ ok: true, state: { runMode: 'local', cloudAvailable: true } });
  } finally {
    await context.close();
    await rm(profile, { recursive: true, force: true });
  }
});
