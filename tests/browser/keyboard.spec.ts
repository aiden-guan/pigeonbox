import { test, expect } from './fixtures';

test('Keyboard shortcuts: cheat sheet, go-to sequences, typing guard and the off switch', async ({ app }) => {
  const page = await app.gmail();
  await expect(page.locator('[data-gi-ui="workspace"]')).toHaveCount(1);
  await page.locator('h2.hP').click();

  // ? opens the cheat sheet; Escape closes it.
  await page.keyboard.press('Shift+?');
  const sheet = page.getByRole('dialog', { name: 'PigeonBox keyboard shortcuts' });
  await expect(sheet).toBeVisible();
  await expect(sheet.getByText('Remind me if no reply', { exact: true })).toBeVisible();
  await page.screenshot({ path: 'test-results/keyboard-cheat-sheet.png' });
  await page.keyboard.press('Escape');
  await expect(sheet).toHaveCount(0);

  // g then t goes to Sent.
  await page.keyboard.press('g');
  await page.keyboard.press('t');
  await expect.poll(() => page.evaluate(() => location.hash)).toBe('#sent');

  // Typing in a compose never triggers single-key shortcuts.
  await page.locator('[aria-label="Message Body"]').focus();
  await page.keyboard.press('Shift+?');
  await expect(sheet).toHaveCount(0);

  // Turning shortcuts off in Settings stops them in open Gmail tabs.
  const settingsPage = await app.context.newPage();
  await settingsPage.goto(`chrome-extension://${app.id}/settings.html?here`);
  await settingsPage.evaluate(() => chrome.runtime.sendMessage({ type: 'SAVE_SETTINGS', settings: { keyboardShortcuts: false } }));
  await page.bringToFront();
  await page.locator('h2.hP').click();
  await page.waitForTimeout(300);
  await page.keyboard.press('Shift+?');
  await expect(sheet).toHaveCount(0);
});
