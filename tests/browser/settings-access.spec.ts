import { test, expect } from './fixtures';
import type { BrowserContext, Page } from '@playwright/test';

const settingsTabs = (context: BrowserContext) => context.pages().filter((page) => page.url().endsWith('/settings.html'));
async function opensSettings(context: BrowserContext, action: () => Promise<void>): Promise<Page> {
  const opened = context.waitForEvent('page');
  await action();
  const page = await opened;
  await expect(page).toHaveURL(/\/settings\.html$/);
  await expect(page.getByRole('heading', { name: 'Settings.' })).toBeVisible();
  return page;
}

test('the floating Gmail workspace opens Settings from its gear without disturbing the workspace', async ({ app }) => {
  await app.page('workspace');
  await app.worker.evaluate(() => chrome.storage.local.set({ productAnalyticsEnabled: true, productEventCounts: {} }));
  const gmail = await app.gmail();
  const host = gmail.locator('[data-gi-ui="workspace"]');
  const shell = host.locator('.gi-shell');
  const frame = gmail.frameLocator('iframe[title="PigeonBox"]');
  const gear = frame.getByRole('button', { name: 'Open PigeonBox Settings' });
  await expect(gear).toBeVisible();
  await expect(gear).toHaveAttribute('title', 'Open PigeonBox Settings');
  await expect(frame.locator('.pb-mode-label')).toHaveText('Local');
  // Appearance, Settings, dock: the gear sits with the existing window controls.
  expect(await frame.locator('.pb-window-controls button').evaluateAll((buttons) => buttons.map((button) => button.getAttribute('aria-label')))).toEqual([
    expect.stringMatching(/^Appearance/), 'Open PigeonBox Settings', 'Dock to side',
  ]);
  const box = await gear.boundingBox();
  expect(box!.width).toBeGreaterThanOrEqual(24); expect(box!.height).toBeGreaterThanOrEqual(24);

  await frame.getByRole('button', { name: 'Inbox', exact: true }).click();
  await frame.getByRole('combobox', { name: 'Inbox category' }).selectOption('FYI');
  await frame.getByRole('button', { name: 'Ask', exact: true }).click();
  await frame.getByRole('textbox', { name: 'Ask about mail on this computer' }).fill('Unfinished question');
  await expect.poll(async () => (await app.worker.evaluate(async () => (await chrome.storage.local.get('workspaceState')).workspaceState))).toMatchObject({ mode: 'ask', splitCategory: 'FYI' });
  const before = await app.worker.evaluate(async () => (await chrome.storage.local.get('workspaceState')).workspaceState);
  const geometry = await shell.boundingBox();

  const settings = await opensSettings(app.context, () => gear.click());
  expect(settingsTabs(app.context)).toHaveLength(1);
  await expect.poll(async () => (await app.worker.evaluate(async () => (await chrome.storage.local.get('productEventCounts')).productEventCounts))?.settings_opened).toBe(1);

  // Keyboard activation reuses the open Settings tab instead of adding another.
  await gmail.bringToFront();
  await gear.focus();
  await expect(gear).toBeFocused();
  await gear.press('Enter');
  await expect.poll(async () => (await app.worker.evaluate(async () => (await chrome.storage.local.get('productEventCounts')).productEventCounts))?.settings_opened).toBe(2);
  expect(settingsTabs(app.context)).toHaveLength(1);

  expect(await app.worker.evaluate(async () => (await chrome.storage.local.get('workspaceState')).workspaceState)).toEqual(before);
  await expect(shell).toBeVisible();
  await expect(host).toHaveAttribute('data-open', 'true');
  await expect(host).toHaveAttribute('data-display', 'float');
  const after = await shell.boundingBox();
  expect(Math.abs(after!.x - geometry!.x)).toBeLessThan(2); expect(Math.abs(after!.width - geometry!.width)).toBeLessThan(2);
  await expect(frame.getByRole('textbox', { name: 'Ask about mail on this computer' })).toHaveValue('Unfinished question');
  await expect(frame.getByRole('button', { name: 'Ask', exact: true })).toHaveAttribute('data-active', 'true');
  await settings.close();
});

test('the docked side panel exposes Settings with the dock control', async ({ app }) => {
  const panel = await app.page('sidepanel');
  const gear = panel.getByRole('button', { name: 'Open PigeonBox Settings' });
  await expect(gear).toBeVisible();
  await expect(panel.getByRole('button', { name: 'Float in Gmail' })).toBeVisible();
  const settings = await opensSettings(app.context, () => gear.click());
  await expect(panel.getByRole('navigation', { name: 'Workspace' })).toBeVisible();
  await panel.setViewportSize({ width: 320, height: 700 });
  await expect(gear).toBeInViewport();
  await panel.emulateMedia({ colorScheme: 'dark', reducedMotion: 'reduce' });
  await expect(gear).toBeVisible();
  await settings.close();
});

test('an enabled Cloud workspace keeps Settings and the account action derives from the configured Cloud API', async ({ app }) => {
  const panel = await app.page('sidepanel', true);
  await expect(panel.locator('.pb-mode-label')).toHaveText('Cloud');
  const settings = await opensSettings(app.context, () => panel.getByRole('button', { name: 'Open PigeonBox Settings' }).click());
  await expect(settings.getByRole('navigation', { name: 'Settings sections' }).getByRole('link', { name: 'Memory' })).toBeVisible();
  await expect(settings.getByRole('button', { name: 'Manage billing' })).toBeVisible();
  const account = app.context.waitForEvent('page');
  await settings.getByRole('button', { name: 'Manage Cloud account ↗' }).click();
  await expect(await account).toHaveURL(`${new URL(app.api.baseUrl).origin}/app#overview`);
});

test('the command palette still opens Settings', async ({ app }) => {
  const page = await app.page('workspace');
  await page.locator('[data-command-launcher]').click();
  const input = page.getByRole('combobox', { name: 'Ask Pigeon or run a command' });
  await input.fill('Settings');
  const settings = await opensSettings(app.context, () => input.press('Enter'));
  await settings.close();
});

test('Settings stays usable at a narrow width and links only to visible sections', async ({ app }) => {
  const page = await app.page('workspace');
  await page.goto(`chrome-extension://${app.id}/settings.html`);
  await page.setViewportSize({ width: 360, height: 760 });
  const nav = page.getByRole('navigation', { name: 'Settings sections' });
  await expect(nav).toBeVisible();
  expect(await page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth + 1)).toBe(true);
  for (const href of await nav.getByRole('link').evaluateAll((links) => links.map((link) => (link as HTMLAnchorElement).hash)))
    if (href !== '#advanced') await expect(page.locator(href)).toHaveCount(1);
  await nav.getByRole('link', { name: 'Tracking' }).click();
  await expect(page.locator('#tracking')).toBeInViewport();
  await nav.getByRole('link', { name: 'Advanced' }).click();
  await expect(page.locator('#advanced')).toBeInViewport();
  const trackOpens = page.getByRole('switch', { name: 'Track opens' });
  const was = await trackOpens.getAttribute('aria-checked');
  await trackOpens.click();
  await expect(trackOpens).toHaveAttribute('aria-checked', was === 'true' ? 'false' : 'true');
});

test('a public Local build keeps Settings one click away and shows Cloud only as a waitlist', async ({ app }) => {
  const panel = await app.page('sidepanel');
  await panel.evaluate(() => chrome.runtime.sendMessage({ type: 'SAVE_SETTINGS', settings: { runMode: 'local', cloudApiUrl: '' } }));
  const state = await panel.evaluate(() => chrome.runtime.sendMessage({ type: 'GET_PRODUCT_STATE' }));
  test.skip(state.cloudAvailable, 'Requires an unconfigured Local build (PIGEONBOX_BROWSER_EXTENSION_PATH=/path/to/unzipped-release).');
  await panel.reload();
  await expect(panel.locator('.pb-mode-label')).toHaveText('Local');
  const settings = await opensSettings(app.context, () => panel.getByRole('button', { name: 'Open PigeonBox Settings' }).click());
  await expect(settings.getByRole('button', { name: /PigeonBox Cloud.*Join waitlist ↗/ })).toBeVisible();
  for (const name of ['Manage Cloud account ↗', 'Manage Cloud data and retention ↗', 'Manage billing', 'Sign in', 'Subscribe'])
    await expect(settings.getByRole('button', { name, exact: true })).toHaveCount(0);
  const nav = settings.getByRole('navigation', { name: 'Settings sections' });
  await expect(nav.getByRole('link', { name: 'Cloud / Sync' })).toHaveCount(0);
  await expect(nav.getByRole('link', { name: 'Memory' })).toHaveCount(0);
  expect(await settings.content()).not.toMatch(/workers\.dev|\/app#/);
  expect(app.api.calls.some((call) => /auth|checkout|billing/.test(call.route))).toBe(false);
});
