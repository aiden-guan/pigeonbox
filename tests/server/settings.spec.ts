import { test, expect, type Page } from './fixtures';
import { resolve } from 'node:path';

const FAKE_EXTENSION = resolve('tests/server/fake-extension.js');
const INSTALL_URL = 'https://github.com/aiden-guan/pigeonbox#install';
const CONSENT = 'I understand that email content is sent to my PigeonBox server for processing.';
const EXT = 'abcdefghijklmnopabcdefghijklmnop';

let fixtureClient = 0;
test.beforeEach(async ({ page }, testInfo) => {
  // The loopback harness preserves headers. Repeated runs restart workers,
  // so both worker and browser identity must isolate the auth-rate bucket.
  await page.setExtraHTTPHeaders({ 'CF-Connecting-IP': `198.18.${testInfo.workerIndex % 256}.${++fixtureClient}` });
});

async function withExtension(page: Page) {
  await page.addInitScript({ path: FAKE_EXTENSION });
}

async function devSignIn(page: Page) {
  await page.getByLabel('Email').fill('ada@work.test');
  await page.getByRole('button', { name: /sign in/i }).click();
}

const extensionState = (page: Page) => page.evaluate(() => (window as unknown as { __fakeExtension: { read: () => Record<string, unknown> } }).__fakeExtension.read());

test('without the extension, the dashboard shows the server pages and how to install PigeonBox', async ({ page }) => {
  await page.goto('/dashboard');
  await expect(page.locator('#cp-mode')).toContainText('isn’t installed in this browser, or needs an update');
  // PigeonBox is installed from the open-source repository: no store listing, no fixed extension IDs.
  await expect(page.locator('#cp-mode').getByRole('link', { name: /How to install PigeonBox/ })).toHaveAttribute('href', INSTALL_URL);
  await expect(page.getByRole('heading', { name: 'Sign in', exact: true })).toBeVisible();
  await expect(page.locator('a[href*="chromewebstore.google.com"]')).toHaveCount(0);
});

test('Local mode shows only Local settings, needs no account, and saves to the extension', async ({ page }) => {
  await withExtension(page);
  await page.goto(`/dashboard?ext=${EXT}`);
  await expect(page.locator('.cp-badge')).toHaveText('Local');
  await expect(page.getByRole('button', { name: /^Local/ })).toHaveAttribute('aria-pressed', 'true');
  await expect(page.getByRole('heading', { level: 1, name: 'How PigeonBox runs' })).toBeVisible();
  // Server pages are not in the Local rail.
  await expect(page.locator('#cp-nav')).not.toContainText('Account & server');
  await expect(page.locator('#cp-nav')).not.toContainText('Connected accounts');
  expect(page.url()).not.toContain('ext=');
  // The page remembers the extension ID it was opened with; there is no built-in list of IDs.
  expect(await page.evaluate(() => localStorage.getItem('pigeonbox.extension'))).toBe(EXT);

  await page.locator('#cp-nav').getByRole('link', { name: 'Inbox & drafts' }).click();
  await page.getByRole('switch', { name: /Auto archive|Archive low-priority/ }).check();
  await expect.poll(async () => ((await extensionState(page)).settings as { autoArchive: boolean }).autoArchive).toBe(true);

  await page.locator('#cp-nav').getByRole('link', { name: 'Email tracking' }).click();
  await page.getByLabel('Tracker address').fill('https://track.example');
  await page.getByLabel('Personal API token').fill('tok_123');
  await page.getByRole('button', { name: 'Save tracker' }).click();
  await expect(page.getByText('Tracker saved.')).toBeVisible();
  // The token is never shown again.
  await expect(page.getByLabel('Personal API token')).toHaveValue('');
  await expect(page.getByLabel('Personal API token')).toHaveAttribute('placeholder', /Saved/);

  // A server page link lands on the closest Local page, and the remembered ID still finds the extension.
  await page.goto('/dashboard#connections');
  await expect(page).toHaveURL(/#cloud$/);
  await expect(page.getByRole('heading', { level: 1, name: 'Use your PigeonBox server' })).toBeVisible();
});

test('settings saved on the dashboard follow the account into a reinstalled extension', async ({ page }) => {
  await withExtension(page);
  await page.goto(`/dashboard?ext=${EXT}`);
  await page.getByRole('button', { name: /^Server/ }).click();
  await page.getByRole('button', { name: 'Sign in', exact: true }).click();
  await devSignIn(page);
  await expect(page.getByText('Signed in as ada@work.test.', { exact: true })).toBeVisible();
  // Signing in starts the account's copy from this install.
  await expect.poll(async () => (await extensionState(page)).settingsSync).toMatchObject({ userId: expect.any(String) });

  await page.goto('/dashboard#inbox');
  await page.getByRole('switch', { name: /Auto archive|Archive low-priority/ }).check();
  await expect.poll(async () => ((await extensionState(page)).settings as { autoArchive: boolean }).autoArchive).toBe(true);
  await page.goto('/dashboard#advanced');
  await page.getByLabel('Rules').fill('Archive receipts');
  await page.getByRole('button', { name: 'Save rules' }).click();
  await expect(page.getByText('1 rule saved.')).toBeVisible();

  // Reinstalling wipes the extension's storage; the dashboard puts the settings back.
  await page.evaluate(() => (window as unknown as { __fakeExtension: { reset: () => void } }).__fakeExtension.reset());
  await page.reload();
  await expect(page.getByText('Your settings were restored from your PigeonBox account.', { exact: false })).toBeVisible();
  const restored = await extensionState(page) as { settings: { autoArchive: boolean; hasAiApiKey: boolean }; rules: string[]; settingsSync: unknown };
  expect(restored.settings.autoArchive).toBe(true);
  expect(restored.rules).toEqual(['Archive receipts']);
  expect(restored.settingsSync).toMatchObject({ userId: expect.any(String) });

  // Nothing is restored again once the extension matches the account.
  await page.reload();
  await expect(page.locator('#cp-nav')).toBeVisible();
  await expect(page.getByText('Your settings were restored', { exact: false })).toHaveCount(0);
});

test('server setup signs in once, asks for consent and connects the browser automatically', async ({ page }, testInfo) => {
  await withExtension(page);
  await page.emulateMedia({ colorScheme: 'dark', reducedMotion: 'reduce' });
  let logins = 0;
  page.on('request', (request) => { if (new URL(request.url()).pathname === '/v1/auth/authorize') logins += 1; });
  await page.goto(`/dashboard?ext=${EXT}`);
  await page.getByRole('button', { name: /^Server/ }).click();
  await expect(page.getByRole('heading', { level: 1, name: 'Use your PigeonBox server' })).toBeVisible();
  await expect(page.getByText('Sign in to create or open your account on this PigeonBox server.', { exact: true })).toBeVisible();
  await expect(page.getByRole('button', { name: 'Turn on server mode', exact: true })).toHaveCount(0);
  await page.getByRole('button', { name: 'Sign in', exact: true }).click();
  await devSignIn(page);
  await expect(page.getByText('Signed in as ada@work.test.', { exact: true })).toBeVisible();
  // Nothing to buy: signing in leads straight to consent.
  await expect(page.getByRole('button', { name: /Subscribe|Upgrade/ })).toHaveCount(0);
  await expect(page.locator('#view')).not.toContainText(/subscri|billing|\bPro\b/i);
  await page.getByRole('button', { name: 'Turn on server mode', exact: true }).click();
  await expect(page.getByText('Tick the box to agree first.')).toBeVisible();
  expect(((await extensionState(page)) as { runMode: string }).runMode).toBe('local');
  await page.setViewportSize({ width: 390, height: 844 });
  await expect(page.locator('#cp-side')).not.toBeInViewport();
  const box = await page.getByRole('checkbox', { name: /I understand that email content/ }).boundingBox();
  expect(box?.x).toBeGreaterThanOrEqual(0);
  expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBe(true);
  await page.screenshot({ path: testInfo.outputPath('cloud-consent-mobile.png'), fullPage: true });
  await page.setViewportSize({ width: 1280, height: 900 });
  await page.screenshot({ path: testInfo.outputPath('cloud-consent-desktop.png'), fullPage: true });
  await page.getByRole('checkbox', { name: CONSENT }).check();
  await page.getByRole('button', { name: 'Turn on server mode', exact: true }).click();
  await expect(page.getByRole('heading', { level: 1, name: 'Mail routes' })).toBeVisible();
  await expect(page.locator('.cp-badge')).toHaveText('Server');
  expect(logins).toBe(1);
  const state = (await extensionState(page)) as { runMode: string; log: string[] };
  expect(state.runMode).toBe('cloud');
  expect(state.log).toContain('LINK_COMPLETE');
  await expect(page.locator('#cp-nav')).toContainText('Account & server');
  await page.goto('/dashboard?setup=cloud');
  await expect(page.getByRole('heading', { level: 1, name: 'Mail routes' })).toBeVisible();
  await expect(page.getByRole('heading', { name: 'PigeonBox runs on your server', exact: true })).toHaveCount(0);
  await page.getByRole('button', { name: /^Local/ }).click();
  await page.getByRole('button', { name: 'Switch to Local' }).click();
  await expect(page.getByRole('heading', { level: 1, name: 'How PigeonBox runs' })).toBeVisible();
  await expect(page.getByRole('heading', { name: 'Your server account is ready' })).toBeVisible();
  // Selecting the server again lands straight at consent, and reuses the existing link.
  await page.getByRole('button', { name: /^Server/ }).click();
  await expect(page.getByRole('checkbox', { name: /I understand that email content/ })).toBeVisible();
  await expect(page.getByRole('button', { name: 'Sign in', exact: true })).toHaveCount(0);
  expect(logins).toBe(1);
});

test('an account this server gives no features cannot turn on server mode, and is told what to ask for', async ({ page }) => {
  await withExtension(page);
  await page.route('**/v1/capabilities', (route) => route.fulfill({ json: { capabilities: [] } }));
  await page.goto(`/dashboard?ext=${EXT}#cloud`);
  await page.getByRole('button', { name: 'Sign in', exact: true }).click();
  await devSignIn(page);
  await expect(page.getByText('This server gives your account no features. Ask whoever runs it to add your address to ALLOWED_EMAILS.').first()).toBeVisible();
  await page.getByRole('checkbox', { name: CONSENT }).check();
  await page.getByRole('button', { name: 'Turn on server mode', exact: true }).click();
  await expect(page.locator('.toast-error')).toContainText('ALLOWED_EMAILS');
  const state = await extensionState(page) as { runMode: string; log: string[] };
  expect(state.runMode).toBe('local');
  expect(state.log).not.toContain('LINK_BEGIN');
  // Once the server allows the account, setup continues without another sign-in.
  await page.unroute('**/v1/capabilities');
  await page.reload();
  await page.getByRole('checkbox', { name: CONSENT }).check();
  await page.getByRole('button', { name: 'Turn on server mode', exact: true }).click();
  await expect(page.locator('.cp-badge')).toHaveText('Server');
});

test('without the extension, setup signs in first, then points to the install instructions', async ({ page }) => {
  await page.goto('/dashboard#cloud');
  await expect(page.getByRole('heading', { level: 1, name: 'Use your PigeonBox server' })).toBeVisible();
  await page.getByRole('button', { name: 'Sign in', exact: true }).click();
  await devSignIn(page);
  await expect(page.getByRole('heading', { name: 'Install PigeonBox', exact: true })).toBeVisible();
  await expect(page.locator('#view').getByRole('link', { name: /How to install PigeonBox/ })).toHaveAttribute('href', INSTALL_URL);
  await expect(page.getByRole('checkbox', { name: /I understand that email content/ })).toHaveCount(0);
});

async function signedInSetup(page: Page) {
  await withExtension(page);
  await page.goto(`/dashboard?ext=${EXT}#cloud`);
  await page.getByRole('button', { name: 'Sign in', exact: true }).click();
  await devSignIn(page);
  await expect(page.getByRole('button', { name: 'Turn on server mode', exact: true })).toBeVisible();
}

async function patchExtension(page: Page, patch: Record<string, unknown>) {
  await page.evaluate((next) => {
    const fake = (window as unknown as { __fakeExtension: { read: () => Record<string, unknown>; write: (state: unknown) => void } }).__fakeExtension;
    fake.write({ ...fake.read(), ...next });
  }, patch);
  await page.reload();
}

test('server mode grants server access before redeeming the account connection', async ({ page }) => {
  await signedInSetup(page);
  await patchExtension(page, { cloudOrigins: ['https://api.example.test/*'], granted: false });
  await page.getByRole('checkbox', { name: /I understand that email content/ }).check();
  await page.getByRole('button', { name: 'Turn on server mode', exact: true }).click();
  await expect(page.locator('.cp-badge')).toHaveText('Server');
  const { log } = await extensionState(page) as { log: string[] };
  expect(log.indexOf('GRANT')).toBeLessThan(log.indexOf('LINK_BEGIN'));
  expect(log.indexOf('LINK_COMPLETE')).toBeLessThan(log.indexOf('SET_RUN_MODE'));
});

test('denied server access leaves Local running and never attempts to authenticate the browser', async ({ page }) => {
  await signedInSetup(page);
  await patchExtension(page, { cloudOrigins: ['https://api.example.test/*'], granted: false });
  await page.evaluate(() => { (window as unknown as { __fakeDenyGrant: boolean }).__fakeDenyGrant = true; });
  await page.clock.install();
  await page.getByRole('checkbox', { name: /I understand that email content/ }).check();
  await page.getByRole('button', { name: 'Turn on server mode', exact: true }).click();
  await expect(page.getByText('Click Allow in the PigeonBox window so this browser can reach your server.')).toBeVisible();
  // Move through the bounded permission wait, allowing message callbacks to settle each round.
  for (let attempt = 0; attempt < 60; attempt += 1) await page.clock.runFor(1_020);
  await expect(page.getByText('Access to your server was not allowed. Click Turn on server mode to try again.')).toBeVisible();
  const state = await extensionState(page) as { runMode: string; log: string[] };
  expect(state.runMode).toBe('local');
  expect(state.log).not.toContain('LINK_BEGIN');
  expect(state.log).not.toContain('SET_RUN_MODE');
});

test('handoff failures are retryable without another login or switching modes', async ({ page }) => {
  await signedInSetup(page);
  let logins = 0;
  page.on('request', (request) => { if (new URL(request.url()).pathname === '/v1/auth/authorize') logins += 1; });
  const saved = await page.evaluate(() => localStorage.getItem('pigeonbox.session'));
  await page.route('**/v1/auth/link', (route) => route.fulfill({ status: 503, json: { error: { code: 'unavailable', message: 'Account connection is temporarily unavailable.' } } }));
  await page.getByRole('checkbox', { name: /I understand that email content/ }).check();
  await page.getByRole('button', { name: 'Turn on server mode', exact: true }).click();
  await expect(page.getByText('Account connection is temporarily unavailable.')).toBeVisible();
  expect(((await extensionState(page)) as { runMode: string }).runMode).toBe('local');
  expect(await page.evaluate(() => localStorage.getItem('pigeonbox.session'))).toBe(saved);
  await page.unroute('**/v1/auth/link');
  await page.getByRole('button', { name: 'Turn on server mode', exact: true }).click();
  await expect(page.locator('.cp-badge')).toHaveText('Server');
  expect(logins).toBe(0);
});

test('an account outage preserves the saved login and shows retry instead of sign-in', async ({ page }) => {
  await signedInSetup(page);
  const saved = await page.evaluate(() => localStorage.getItem('pigeonbox.session'));
  await page.route('**/v1/me', (route) => route.fulfill({ status: 503, json: { error: { code: 'unavailable' } } }));
  await page.reload();
  await expect(page.getByRole('button', { name: 'Retry account connection' })).toBeVisible();
  await expect(page.getByRole('button', { name: 'Sign in', exact: true })).toHaveCount(0);
  expect(await page.evaluate(() => localStorage.getItem('pigeonbox.session'))).toBe(saved);
  await page.unroute('**/v1/me');
  await page.getByRole('button', { name: 'Retry account connection' }).click();
  await expect(page.getByRole('checkbox', { name: /I understand that email content/ })).toBeVisible();
});

test('a different browser account requires consent and switches to the dashboard account', async ({ page }) => {
  await signedInSetup(page);
  await patchExtension(page, { cloud: { status: 'ready', email: 'other@example.test', capabilities: ['cloud_ai', 'cloud_mail_sync'] } });
  await page.evaluate(() => localStorage.setItem('pigeonbox.cloudSetup', JSON.stringify({ consent: true, userId: 'different-user', at: Date.now() })));
  await page.reload();
  await expect(page.getByRole('checkbox', { name: /I understand that email content/ })).not.toBeChecked();
  await expect(page.getByText(/PigeonBox in this browser is connected to this server as other@example.test/)).toBeVisible();
  expect(((await extensionState(page)) as { runMode: string }).runMode).toBe('local');
  await page.getByRole('checkbox', { name: /I understand that email content/ }).check();
  await page.getByRole('button', { name: 'Turn on server mode', exact: true }).click();
  await expect(page.locator('.cp-badge')).toHaveText('Server');
  expect(((await extensionState(page)) as { cloud: { email: string } }).cloud.email).toBe('ada@work.test');
});

async function leaveOnlyExtensionAccount(page: Page) {
  await signedInSetup(page);
  await page.getByRole('checkbox', { name: /I understand that email content/ }).check();
  await page.getByRole('button', { name: 'Turn on server mode', exact: true }).click();
  await expect(page.locator('.cp-badge')).toHaveText('Server');
  await page.getByRole('button', { name: /^Local/ }).click();
  await page.getByRole('button', { name: 'Switch to Local' }).click();
  await expect(page.locator('.cp-badge')).toHaveText('Local');
  await page.evaluate(() => localStorage.removeItem('pigeonbox.session'));
}

test('a connected extension opens server setup signed in, directly at consent, without another sign-in', async ({ page }) => {
  await leaveOnlyExtensionAccount(page);
  let logins = 0;
  page.on('request', (request) => { if (new URL(request.url()).pathname === '/v1/auth/authorize') logins += 1; });
  const extensionSession = (await extensionState(page)).accountSession as { refreshToken: string };
  await page.goto('/dashboard?setup=cloud');
  await expect(page.getByRole('checkbox', { name: /I understand that email content/ })).toBeVisible();
  await expect(page.getByRole('button', { name: 'Sign in', exact: true })).toHaveCount(0);
  const dashboardSession = await page.evaluate(() => JSON.parse(localStorage.getItem('pigeonbox.session') || 'null'));
  expect(dashboardSession.refreshToken).not.toBe(extensionSession.refreshToken);
  expect(logins).toBe(0);
  expect(((await extensionState(page)) as { runMode: string }).runMode).toBe('local');
  await page.getByRole('checkbox', { name: /I understand that email content/ }).check();
  await page.getByRole('button', { name: 'Turn on server mode', exact: true }).click();
  await expect(page.locator('.cp-badge')).toHaveText('Server');
  expect(logins).toBe(0);
});

test('a failed extension account handoff offers retry and preserves the extension account', async ({ page }) => {
  await leaveOnlyExtensionAccount(page);
  const extensionSession = (await extensionState(page)).accountSession;
  await page.route('**/v1/auth/link', (route) => route.fulfill({ status: 503, json: { error: { code: 'unavailable', message: 'Account connection is temporarily unavailable.' } } }));
  await page.goto('/dashboard?setup=cloud');
  await expect(page.getByRole('button', { name: 'Retry account connection' })).toBeVisible();
  await expect(page.getByRole('button', { name: 'Sign in', exact: true })).toHaveCount(0);
  expect((await extensionState(page)).accountSession).toEqual(extensionSession);
  await page.unroute('**/v1/auth/link');
  await page.getByRole('button', { name: 'Retry account connection' }).click();
  await expect(page.getByRole('checkbox', { name: /I understand that email content/ })).toBeVisible();
});

test('explicit dashboard sign-out stays signed out even while the extension has an account', async ({ page }) => {
  await leaveOnlyExtensionAccount(page);
  await page.goto('/dashboard?setup=cloud');
  await expect(page.getByRole('checkbox', { name: /I understand that email content/ })).toBeVisible();
  await Promise.all([
    page.waitForEvent('domcontentloaded'),
    page.getByRole('button', { name: 'Sign out', exact: true }).click(),
  ]);
  await expect(page).toHaveURL(/\/dashboard#general$/);
  await page.goto('/dashboard#cloud');
  await expect(page.getByRole('button', { name: 'Sign in', exact: true })).toBeVisible();
  expect(await page.evaluate(() => localStorage.getItem('pigeonbox.session'))).toBe(null);
});


test('a different dashboard account can reuse the extension account without another sign-in', async ({ page }) => {
  await leaveOnlyExtensionAccount(page);
  await page.goto('/dashboard?setup=cloud');
  await expect(page.getByRole('checkbox', { name: /I understand that email content/ })).toBeVisible();
  await page.evaluate(async () => {
    const { startSignIn } = await import('/lib/session.js');
    // Schedule navigation after Playwright receives the evaluation result.
    setTimeout(() => { void startSignIn(null, '#cloud'); }, 0);
  });
  await page.getByLabel('Email').fill('other@example.test');
  await page.getByRole('button', { name: /sign in/i }).click();
  await expect(page.getByRole('button', { name: 'Continue as ada@work.test' })).toBeVisible();
  let logins = 0;
  page.on('request', (request) => { if (new URL(request.url()).pathname === '/v1/auth/authorize') logins += 1; });
  await page.getByRole('button', { name: 'Continue as ada@work.test' }).click();
  await expect(page.getByText('Signed in as ada@work.test.', { exact: true })).toBeVisible();
  await expect(page.getByRole('checkbox', { name: /I understand that email content/ })).toBeVisible();
  expect(logins).toBe(0);
});
