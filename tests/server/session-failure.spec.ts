import { test, expect, type Page } from './fixtures';

async function signIn(page: Page) {
  await page.goto('/dashboard');
  await page.getByRole('button', { name: 'Sign in', exact: true }).click();
  await page.getByLabel('Email').fill('ada@work.test');
  await page.getByRole('button', { name: /sign in/i }).click();
  await expect(page.getByRole('heading', { level: 1, name: 'Your PigeonBox', exact: true })).toBeVisible();
}

async function sessionUnchanged(page: Page, before: string | null) {
  expect(await page.evaluate((saved) => localStorage.getItem('pigeonbox.session') === saved, before)).toBe(true);
}

for (const fault of [
  { name: 'non-JSON profile', path: '**/v1/me', body: '<html>UPSTREAM_PRIVATE_CANARY</html>' },
  { name: 'incomplete profile', path: '**/v1/me', body: '{}' },
  { name: 'invalid capability list', path: '**/v1/capabilities', body: '{"capabilities":{}}' },
]) {
  test(`malformed successful ${fault.name} shows recovery and preserves the session`, async ({ page }) => {
    const errors: string[] = [];
    page.on('pageerror', (error) => errors.push(error.message));
    await signIn(page);
    const saved = await page.evaluate(() => localStorage.getItem('pigeonbox.session'));
    await page.route(fault.path, (route) => route.fulfill({ status: 200, contentType: 'application/json', body: fault.body }));
    await page.reload();
    await expect(page.getByText('Your PigeonBox server returned an invalid response. Try again.', { exact: true })).toBeVisible();
    await expect(page.getByRole('button', { name: 'Reload', exact: true })).toBeVisible();
    await expect(page.locator('#view .loading-page')).toHaveCount(0);
    expect(await page.locator('#view').innerText()).not.toContain('UPSTREAM_PRIVATE_CANARY');
    await sessionUnchanged(page, saved);
    expect(errors).toEqual([]);
    await page.unroute(fault.path);
    await page.getByRole('button', { name: 'Reload', exact: true }).click();
    await expect(page.getByRole('heading', { level: 1, name: 'Your PigeonBox', exact: true })).toBeVisible();
  });
}

test('an unresponsive API request stops loading after its deadline and can recover', async ({ page }) => {
  const errors: string[] = [];
  page.on('pageerror', (error) => errors.push(error.message));
  await signIn(page);
  const saved = await page.evaluate(() => localStorage.getItem('pigeonbox.session'));
  await page.clock.install();
  let started!: () => void;
  const requested = new Promise<void>((resolve) => { started = resolve; });
  await page.route('**/v1/me', () => { started(); });
  await page.reload({ waitUntil: 'domcontentloaded' });
  await requested;
  await page.clock.fastForward(30_001);
  await expect(page.getByText('Your PigeonBox server took too long to respond. Try again.', { exact: true })).toBeVisible();
  await expect(page.locator('#view .loading-page')).toHaveCount(0);
  await sessionUnchanged(page, saved);
  expect(errors).toEqual([]);
  await page.unroute('**/v1/me');
  await page.getByRole('button', { name: 'Reload', exact: true }).click();
  await expect(page.getByRole('heading', { level: 1, name: 'Your PigeonBox', exact: true })).toBeVisible();
});

test('malformed refresh success cannot replace or erase a valid session', async ({ page }) => {
  await signIn(page);
  const saved = await page.evaluate(() => localStorage.getItem('pigeonbox.session'));
  await page.route('**/v1/me', (route) => route.fulfill({ status: 401, json: { error: { code: 'invalid_token' } } }));
  await page.route('**/v1/auth/refresh', (route) => route.fulfill({ status: 200, json: {} }));
  await page.reload();
  await expect(page.getByText('Your PigeonBox server returned an invalid response. Try again.', { exact: true })).toBeVisible();
  await sessionUnchanged(page, saved);
  await expect(page.getByRole('button', { name: 'Reload', exact: true })).toBeVisible();
});

test('an unresponsive refresh preserves the session and leaves a recoverable state', async ({ page }) => {
  await signIn(page);
  const saved = await page.evaluate(() => localStorage.getItem('pigeonbox.session'));
  await page.clock.install();
  await page.route('**/v1/me', (route) => route.fulfill({ status: 401, json: { error: { code: 'invalid_token' } } }));
  let started!: () => void;
  const requested = new Promise<void>((resolve) => { started = resolve; });
  await page.route('**/v1/auth/refresh', () => { started(); });
  await page.reload({ waitUntil: 'domcontentloaded' });
  await requested;
  await page.clock.fastForward(30_001);
  await expect(page.getByText('Your PigeonBox server took too long to respond. Try again.', { exact: true })).toBeVisible();
  await sessionUnchanged(page, saved);
  await expect(page.locator('#view .loading-page')).toHaveCount(0);
  await expect(page.getByRole('button', { name: 'Reload', exact: true })).toBeVisible();
});

test('an unresponsive document upload rejects once and preserves the session', async ({ page }) => {
  await signIn(page);
  const saved = await page.evaluate(() => localStorage.getItem('pigeonbox.session'));
  await page.clock.install();
  let started!: () => void;
  const requested = new Promise<void>((resolve) => { started = resolve; });
  let uploads = 0;
  await page.route('**/v1/documents/release-timeout-probe', () => { uploads += 1; started(); });
  const result = page.evaluate(async () => {
    const { upload } = await import('/lib/session.js');
    try {
      await upload('/v1/documents/release-timeout-probe', new File(['fixture'], 'fixture.pdf', { type: 'application/pdf' }));
      return { resolved: true };
    } catch (error) {
      return { code: error.code, message: error.message };
    }
  });
  await requested;
  await page.clock.fastForward(30_001);
  expect(await result).toEqual({ code: 'unavailable', message: 'Your PigeonBox server took too long to respond. Try again.' });
  expect(uploads).toBe(1);
  await sessionUnchanged(page, saved);
});
