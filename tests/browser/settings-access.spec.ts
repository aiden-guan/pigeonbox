import { test, expect } from './fixtures';
import type { BrowserContext, Page } from '@playwright/test';

// With a PigeonBox server configured, Settings live on its dashboard (<server>/dashboard). The
// fixture server is on loopback, which source builds let message the extension; it serves a
// stand-in that says HELLO like the real one.
const DASHBOARD = /\/dashboard\?ext=[a-p]{32}#general$/;
const settingsTabs = (context: BrowserContext) => context.pages().filter((page) => page.url().includes('/dashboard?ext='));
async function opensSettings(context: BrowserContext, action: () => Promise<void>): Promise<Page> {
  const opened = context.waitForEvent('page');
  await action();
  const page = await opened;
  await expect(page).toHaveURL(DASHBOARD);
  await expect(page.locator('body[data-hello="1"]')).toHaveCount(1);
  return page;
}

test('the floating Gmail workspace opens Settings from its gear without disturbing the workspace', async ({ app }) => {
  await app.page('workspace');
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
  await frame.getByRole('button', { name: 'Chat', exact: true }).click();
  await frame.getByRole('textbox', { name: 'Message Pigeon about mail on this computer' }).fill('Unfinished question');
  await expect.poll(async () => (await app.worker.evaluate(async () => (await chrome.storage.local.get('workspaceState')).workspaceState))).toMatchObject({ mode: 'ask', splitCategory: 'FYI' });
  const before = await app.worker.evaluate(async () => (await chrome.storage.local.get('workspaceState')).workspaceState);
  const geometry = await shell.boundingBox();

  const settings = await opensSettings(app.context, () => gear.click());
  expect(settingsTabs(app.context)).toHaveLength(1);

  // Keyboard activation reuses the open Settings tab instead of adding another.
  await app.worker.evaluate(() => {
    const update = chrome.tabs.update.bind(chrome.tabs) as (...args: unknown[]) => Promise<unknown>;
    chrome.tabs.update = (async (...args: unknown[]) => {
      const { fixtureTabUpdates = 0 } = await chrome.storage.session.get('fixtureTabUpdates');
      await chrome.storage.session.set({ fixtureTabUpdates: Number(fixtureTabUpdates) + 1 });
      return update(...args);
    }) as typeof chrome.tabs.update;
  });
  await gmail.bringToFront();
  await gear.focus();
  await expect(gear).toBeFocused();
  await gear.press('Enter');
  await expect.poll(async () => (await app.worker.evaluate(() => chrome.storage.session.get('fixtureTabUpdates'))).fixtureTabUpdates).toBe(1);
  await expect(settings).toHaveURL(DASHBOARD);
  expect(settingsTabs(app.context)).toHaveLength(1);
  // Opening Settings records nothing: PigeonBox keeps no product analytics.
  expect(await app.worker.evaluate(() => chrome.storage.local.get(['productEventCounts', 'productAnalyticsInstallId']))).toEqual({});

  expect(await app.worker.evaluate(async () => (await chrome.storage.local.get('workspaceState')).workspaceState)).toEqual(before);
  await expect(shell).toBeVisible();
  await expect(host).toHaveAttribute('data-open', 'true');
  await expect(host).toHaveAttribute('data-display', 'float');
  const after = await shell.boundingBox();
  expect(Math.abs(after!.x - geometry!.x)).toBeLessThan(2); expect(Math.abs(after!.width - geometry!.width)).toBeLessThan(2);
  await expect(frame.getByRole('textbox', { name: 'Message Pigeon about mail on this computer' })).toHaveValue('Unfinished question');
  await expect(frame.getByRole('button', { name: 'Chat', exact: true })).toHaveAttribute('data-active', 'true');
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

test('a workspace running on the server opens Settings on that server’s dashboard', async ({ app }) => {
  const panel = await app.page('sidepanel', true);
  await expect(panel.locator('.pb-mode-label')).toHaveText('Server');
  const settings = await opensSettings(app.context, () => panel.getByRole('button', { name: 'Open PigeonBox Settings' }).click());
  expect(settings.url().startsWith(`${new URL(app.api.baseUrl).origin}/dashboard?ext=${app.id}`)).toBe(true);
});

test('the command palette still opens Settings', async ({ app }) => {
  const page = await app.page('workspace');
  await page.locator('[data-command-launcher]').click();
  const input = page.getByRole('combobox', { name: 'Message Pigeon or run a command' });
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

test('without a PigeonBox server, Settings open inside the extension and offer no server mode', async ({ app }) => {
  const panel = await app.page('sidepanel');
  await panel.evaluate(() => chrome.runtime.sendMessage({ type: 'SAVE_SETTINGS', settings: { runMode: 'local', cloudApiUrl: '' } }));
  const state = await panel.evaluate(() => chrome.runtime.sendMessage({ type: 'GET_PRODUCT_STATE' }));
  test.skip(state.cloudAvailable, 'Requires a build without a server (no VITE_PIGEONBOX_CLOUD_API_URL), such as the unzipped release.');
  expect(state).toMatchObject({ cloudAvailable: false, dashboardAvailable: false, cloudOrigins: [] });
  await panel.reload();
  await expect(panel.locator('.pb-mode-label')).toHaveText('Local');
  const opened = app.context.waitForEvent('page');
  await panel.getByRole('button', { name: 'Open PigeonBox Settings' }).click();
  const settings = await opened;
  await expect(settings).toHaveURL(`chrome-extension://${app.id}/settings.html?here`);
  await expect(settings.getByRole('heading', { name: 'Settings.' })).toBeVisible();
  await expect(settings.locator('#run-mode .gi-choice')).toHaveCount(2);
  await expect(settings.getByRole('link', { name: 'Run your own server ↗' })).toHaveAttribute('href', 'https://github.com/aiden-guan/pigeonbox/blob/main/docs/self-hosting.md');
  await expect(settings.getByText(/waitlist|upgrade|Sent with PigeonBox/i)).toHaveCount(0);
  // Server pages have nowhere to open, and say how to add a server.
  expect(await settings.evaluate(() => chrome.runtime.sendMessage({ type: 'CLOUD_OPEN', section: 'documents' }))).toMatchObject({ ok: false, code: 'not_configured' });
  expect(await settings.evaluate(() => chrome.runtime.sendMessage({ type: 'SET_RUN_MODE', mode: 'cloud', consent: true }))).toMatchObject({ ok: false, reason: expect.stringContaining('No PigeonBox server is configured') });
  expect(app.api.calls.some((call) => /auth|checkout|billing|events/.test(call.route))).toBe(false);
});
