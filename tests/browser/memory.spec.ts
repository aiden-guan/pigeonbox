import { test, expect } from './fixtures';

test('memory works in the Gmail workspace through the real worker bridge', async ({ app }, testInfo) => {
  const page = await app.page('workspace', true);
  await page.getByRole('button', { name: 'Memory', exact: true }).click();
  await expect(page.getByRole('heading', { name: /Less repeating/ })).toBeVisible();
  await expect(page.locator('.pb-memory-group[open]')).toHaveCount(0);
  const composer = page.getByLabel('Ask or update memory');
  await composer.fill('What do you remember about my writing?'); await composer.press('Enter');
  await expect(page.getByRole('region', { name: 'Memory answer' })).toContainText('concise replies');
  expect(app.api.calls.some(call => call.route === '/v1/memory/chat')).toBe(true);
  await composer.fill('Remember: I prefer thoughtful technical replies.'); await composer.press('Enter');
  await expect(page.getByRole('region', { name: 'Memory answer' })).toContainText('Remembered:');
  await page.locator('.pb-memory-group > summary').filter({ hasText: 'Preferences' }).click();
  const saved = page.locator('.pb-memory-fact').filter({ hasText: 'I prefer thoughtful technical replies.' });
  await expect(saved).toBeVisible();
  await saved.getByRole('button', { name: 'Edit', exact: true }).click();
  await saved.getByLabel('Correct this fact').fill('I prefer detailed technical replies.');
  await page.getByRole('button', { name: 'Save correction', exact: true }).click();
  await expect(page.locator('.pb-memory-notice')).toContainText('Correction saved');
  await expect(page.locator('.pb-memory-fact').filter({ hasText: 'I prefer detailed technical replies.' })).toBeVisible();
  for (const width of [420, 320]) {
    await page.setViewportSize({ width, height: 844 });
    expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBe(true);
    await page.screenshot({ path: testInfo.outputPath(`memory-workspace-${width}.png`), fullPage: true });
  }
  await page.getByRole('button', { name: 'Open Ask Pigeon command palette' }).click();
  const command = page.getByRole('combobox', { name: 'Ask Pigeon or run a command' });
  await command.fill('Switch to dark appearance'); await command.press('Enter');
  await page.setViewportSize({ width: 420, height: 844 });
  await page.screenshot({ path: testInfo.outputPath('memory-workspace-dark.png'), fullPage: true });
  // An existing synthetic Gmail tab lets Playwright intercept the Chrome-tab navigation.
  const gmail = await app.context.newPage();
  await gmail.goto('https://mail.google.com/mail/u/0/#inbox/abc123');
  await page.bringToFront();
  await page.locator('.pb-memory-fact').filter({ hasText: 'I prefer concise replies.' }).getByText('Sources & freshness', { exact: true }).click();
  await page.locator('.pb-memory-fact').filter({ hasText: 'I prefer concise replies.' }).getByRole('button', { name: 'Pricing', exact: true }).click();
  await expect(gmail).toHaveURL('https://mail.google.com/mail/?authuser=owner%40fixture.test#all/abc123');
  await page.bringToFront();
  await page.emulateMedia({ reducedMotion: 'reduce' });
  await page.locator('.pb-memory-fact').filter({ hasText: 'I prefer detailed technical replies.' }).getByRole('button', { name: 'Forget', exact: true }).click();
  await expect(page.locator('.pb-memory-notice')).toContainText('Forgotten');
  await expect(page.locator('.pb-memory-fact').filter({ hasText: 'I prefer detailed technical replies.' })).toHaveCount(0);
  await composer.fill('Remember: I prefer careful reasoning.');
  await page.getByRole('button', { name: 'Home', exact: true }).click();
  await expect(composer).not.toBeVisible();
  await page.getByRole('button', { name: 'Memory', exact: true }).click();
  await expect(composer).toHaveValue('Remember: I prefer careful reasoning.');
  await page.reload();
  await expect(page.getByRole('heading', { name: /Less repeating/ })).toBeVisible();
});

test('Local workspace keeps Cloud memory behind the capability boundary', async ({ app }) => {
  const page = await app.page('workspace');
  await expect(page.getByRole('button', { name: 'Memory', exact: true })).toHaveCount(0);
  expect(app.api.calls.some(call => call.route.startsWith('/v1/memory/'))).toBe(false);
});
