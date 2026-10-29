import { chromium, test, expect } from '@playwright/test';
import { mkdtemp, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';

// Run directly against the extracted ZIP, without build-browser-fixture.mjs.
// No fixture pages, developer host permissions, or backend credentials are added.
test('a release ships without a PigeonBox server: it runs on this computer and no website can message it', async () => {
  const extension = process.env.PIGEONBOX_BROWSER_EXTENSION_PATH;
  test.skip(!extension, 'Requires the extracted production ZIP.');
  const version = JSON.parse(await readFile('package.json', 'utf8')).version;
  const manifest = JSON.parse(await readFile(path.join(extension!, 'manifest.json'), 'utf8'));
  expect(manifest).not.toHaveProperty('externally_connectable');
  const profile = await mkdtemp(path.join(tmpdir(), 'pigeonbox-release-'));
  const context = await chromium.launchPersistentContext(profile, {
    channel: 'chromium', headless: true,
    args: [`--disable-extensions-except=${extension}`, `--load-extension=${extension}`],
  });
  try {
    const worker = context.serviceWorkers()[0] ?? await context.waitForEvent('serviceworker');
    const id = worker.url().split('/')[2];
    expect(await worker.evaluate(() => chrome.runtime.getManifest().version)).toBe(version);

    const page = await context.newPage();
    await page.goto(`chrome-extension://${id}/settings.html?here`);
    const send = (message: Record<string, unknown>) => page.evaluate((message) => chrome.runtime.sendMessage(message), message);
    expect(await send({ type: 'GET_PRODUCT_STATE' })).toMatchObject({
      runMode: 'local', cloudAvailable: false, dashboardAvailable: false, cloudConsentAt: null, experimental: false, cloudOrigins: [],
      cloud: { status: 'not_configured', capabilities: [] },
    });
    // Without a server there is nothing to switch to, and nothing changes.
    expect(await send({ type: 'SET_RUN_MODE', mode: 'cloud', consent: true })).toMatchObject({ ok: false, reason: expect.stringContaining('No PigeonBox server is configured') });
    expect(await send({ type: 'GET_PRODUCT_STATE' })).toMatchObject({ runMode: 'local', cloudConsentAt: null });
    // Settings open inside the extension, not on a website.
    expect(await send({ type: 'GET_DASHBOARD_URL', section: 'general' })).toMatchObject({ ok: true, url: null });
    await expect(page.getByRole('heading', { name: 'Settings.' })).toBeVisible();

    // No web page can reach the extension at all.
    await context.route('https://site.example/**', (route) => route.fulfill({ contentType: 'text/html', body: '<!doctype html><title>Some site</title>' }));
    const site = await context.newPage();
    await site.goto('https://site.example/dashboard');
    expect(await site.evaluate(() => typeof (globalThis as { chrome?: { runtime?: { sendMessage?: unknown } } }).chrome?.runtime?.sendMessage)).toBe('undefined');
  } finally {
    await context.close();
    await rm(profile, { recursive: true, force: true });
  }
});
