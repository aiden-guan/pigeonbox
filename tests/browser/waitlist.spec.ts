import { test, expect } from './fixtures';

test('unavailable Cloud opens the waitlist from onboarding, Settings and commands without changing Local', async ({ app }) => {
  await app.context.route('https://usepigeonbox.com/waitlist**', route => route.fulfill({ contentType: 'text/html', body: '<h1>Cloud waitlist</h1>' }));
  const page = await app.context.newPage();
  await page.goto(`chrome-extension://${app.id}/settings.html`);
  await page.evaluate(async () => {
    await chrome.runtime.sendMessage({ type: 'SAVE_SETTINGS', settings: { runMode: 'local', cloudApiUrl: '', aiMode: 'disabled' } });
  });
  const initial = await page.evaluate(() => chrome.runtime.sendMessage({ type: 'GET_PRODUCT_STATE' }));
  test.skip(initial.cloudAvailable, 'Requires an unconfigured Local build; configured beta behavior is covered by the Cloud suite.');
  await page.goto(`chrome-extension://${app.id}/onboarding.html`);
  await page.getByRole('button', { name: 'Continue', exact: true }).click();
  const onboarding = app.context.waitForEvent('page');
  await page.getByRole('button', { name: 'With Cloud capabilities', exact: false }).click();
  const waitlist = await onboarding;
  await expect(waitlist).toHaveURL('https://usepigeonbox.com/waitlist?source=extension');
  await expect(page.getByRole('heading', { name: 'How should PigeonBox work?' })).toBeVisible();
  await waitlist.close();
  await page.goto(`chrome-extension://${app.id}/settings.html`);
  const settings = app.context.waitForEvent('page');
  await page.getByRole('button', { name: 'PigeonBox Cloud', exact: false }).first().click();
  const settingsWaitlist = await settings;
  await expect(settingsWaitlist).toHaveURL('https://usepigeonbox.com/waitlist?source=extension');
  await settingsWaitlist.close();
  const command = app.context.waitForEvent('page');
  await page.evaluate(() => chrome.runtime.sendMessage({ type: 'CLOUD_OPEN', section: 'documents' }));
  const commandWaitlist = await command;
  await expect(commandWaitlist).toHaveURL('https://usepigeonbox.com/waitlist?source=extension');
  const state = await page.evaluate(() => chrome.runtime.sendMessage({ type: 'GET_PRODUCT_STATE' }));
  expect(state.state?.runMode ?? state.runMode).toBe('local');
  expect(app.api.calls.some(call => /auth|checkout/.test(call.route))).toBe(false);
});
