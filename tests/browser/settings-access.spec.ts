import { test, expect } from './fixtures';
import type { BrowserContext, Page } from '@playwright/test';

// Settings live on the PigeonBox dashboard; the fixture API serves a stand-in that says HELLO like the real one.
const DASHBOARD = /\/dashboard\?ext=[a-p]{32}#general$/;
const settingsTabs = (context: BrowserContext) => context.pages().filter((page) => page.url().includes('/dashboard?ext='));
async function opensSettings(context: BrowserContext, action: () => Promise<void>): Promise<Page> {
  const opened = context.waitForEvent('page');
  await action();
  const page = await opened;
  await expect(page).toHaveURL(DASHBOARD);
  // chrome.tabs.create starts the public navigation before Playwright attaches
  // routing to the new page. Reload once to serve the synthetic dashboard.
  if (page.url().startsWith('https://usepigeonbox.com/')) await page.reload();
  await expect(page.locator('body[data-hello="1"]')).toHaveCount(1);
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
  // Quiet chrome: Settings and dock only; appearance is a command and a Settings choice.
  expect(await frame.locator('.pb-window-controls button').evaluateAll((buttons) => buttons.map((button) => button.getAttribute('aria-label')))).toEqual([
    'Open PigeonBox Settings', 'Dock to side',
  ]);
  const box = await gear.boundingBox();
  expect(box!.width).toBeGreaterThanOrEqual(24); expect(box!.height).toBeGreaterThanOrEqual(24);

  await frame.getByRole('button', { name: 'Waiting & follow-ups →' }).click();
  await frame.getByRole('button', { name: 'Mail', exact: true }).click();
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

test('an enabled Cloud workspace opens Settings on the dashboard of its configured Cloud API', async ({ app }) => {
  const panel = await app.page('sidepanel', true);
  await expect(panel.locator('.pb-mode-label')).toHaveText('Cloud');
  const settings = await opensSettings(app.context, () => panel.getByRole('button', { name: 'Open PigeonBox Settings' }).click());
  expect(settings.url().startsWith(`${new URL(app.api.baseUrl).origin}/dashboard?ext=${app.id}`)).toBe(true);
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
  await page.goto(`chrome-extension://${app.id}/settings.html?here`);
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
  // A build without Cloud still opens the published dashboard, where Local settings live.
  expect(settings.url().startsWith(`https://usepigeonbox.com/dashboard?ext=${app.id}`)).toBe(true);
  expect(app.api.calls.some((call) => /auth|checkout|billing/.test(call.route))).toBe(false);
});
