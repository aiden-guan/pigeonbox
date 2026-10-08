import { test, expect } from './fixtures';

test('unavailable Cloud keeps onboarding on the waitlist and account commands on the dashboard without changing Local', async ({ app }) => {
  await app.context.route('https://usepigeonbox.com/waitlist**', route => route.fulfill({ contentType: 'text/html', body: '<h1>Cloud waitlist</h1>' }));
  const page = await app.context.newPage();
  await page.goto(`chrome-extension://${app.id}/settings.html?here`);
  await page.evaluate(async () => {
    await chrome.runtime.sendMessage({ type: 'SAVE_SETTINGS', settings: { runMode: 'local', cloudApiUrl: '', aiMode: 'disabled' } });
  });
  const initial = await page.evaluate(() => chrome.runtime.sendMessage({ type: 'GET_PRODUCT_STATE' }));
  test.skip(initial.cloudAvailable, 'Requires an unconfigured Local build; configured beta behavior is covered by the Cloud suite.');
  await page.goto(`chrome-extension://${app.id}/onboarding.html`);
  await page.getByRole('button', { name: /That’s me/ }).click();
  const onboarding = app.context.waitForEvent('page');
  await page.getByRole('button', { name: /PigeonBox Cloud/ }).click();
  const waitlist = await onboarding;
  await expect(waitlist).toHaveURL('https://usepigeonbox.com/waitlist?source=extension');
  await expect(page.getByRole('heading', { name: 'Let’s quiet your inbox.' })).toBeVisible();
  await waitlist.close();
  await page.goto(`chrome-extension://${app.id}/settings.html?here`);
  const settings = app.context.waitForEvent('page');
  await page.getByRole('button', { name: 'PigeonBox Cloud', exact: false }).first().click();
  const settingsWaitlist = await settings;
  await expect(settingsWaitlist).toHaveURL('https://usepigeonbox.com/waitlist?source=extension');
  await settingsWaitlist.close();
  // Record the requested URL before the live page can remove its query string.
  await app.worker.evaluate(() => {
    const createTab = chrome.tabs.create;
    chrome.tabs.create = (async (properties: chrome.tabs.CreateProperties) => {
      chrome.tabs.create = createTab;
      await chrome.storage.session.set({ fixtureOpenedDashboardUrl: properties.url });
      return createTab(properties);
    }) as typeof chrome.tabs.create;
  });
  const command = app.context.waitForEvent('page');
  await page.evaluate(() => chrome.runtime.sendMessage({ type: 'CLOUD_OPEN', section: 'documents' }));
  const commandDashboard = await command;
  const dashboardUrl = `https://usepigeonbox.com/dashboard?ext=${app.id}#documents`;
  expect(await app.worker.evaluate(async () => (await chrome.storage.session.get('fixtureOpenedDashboardUrl')).fixtureOpenedDashboardUrl)).toBe(dashboardUrl);
  // The extension-opened request can load the live site before routing attaches;
  // its scripts remove ?ext. Start a fresh document so routing catches HELLO.
  await commandDashboard.goto('about:blank');
  await commandDashboard.goto(dashboardUrl);
  await expect(commandDashboard).toHaveURL(dashboardUrl);
  await expect(commandDashboard.locator('body[data-hello="1"]')).toHaveCount(1);
  const state = await page.evaluate(() => chrome.runtime.sendMessage({ type: 'GET_PRODUCT_STATE' }));
  expect(state.state?.runMode ?? state.runMode).toBe('local');
  expect(app.api.calls.some(call => /auth|checkout/.test(call.route))).toBe(false);
});
