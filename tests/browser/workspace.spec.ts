import { test, expect } from './fixtures';

const shortcut = process.platform === 'darwin' ? 'Meta+k' : 'Control+k';
test('floating workspace preserves bounds, geometry, navigation and keyboard control across Gmail routes', async ({ app }) => {
  const setup = await app.page('workspace'); const gmail = await app.gmail();
  const host = gmail.locator('[data-gi-ui="workspace"]'); const shell = host.locator('.gi-shell');
  const workspace = gmail.frameLocator('iframe[title="PigeonBox"]');
  await expect(shell).toBeVisible(); await expect(workspace.getByRole('navigation', { name: 'Workspace' })).toBeVisible();
  const header = host.locator('header'); await header.focus(); await header.press('ArrowLeft'); await header.press('Shift+ArrowLeft');
  const first = await shell.boundingBox();
  await workspace.getByRole('button', { name: 'Ask', exact: true }).click();
  await workspace.getByRole('textbox', { name: 'Ask about mail on this computer' }).fill('Unfinished question');
  await host.getByRole('button', { name: 'Collapse PigeonBox' }).click();
  await expect(host.getByRole('button', { name: 'Reopen PigeonBox' })).toBeVisible();
  await host.getByRole('button', { name: 'Reopen PigeonBox' }).click();
  await expect(workspace.getByRole('textbox', { name: 'Ask about mail on this computer' })).toHaveValue('Unfinished question');
  await gmail.evaluate(() => { location.hash = '#sent'; }); await gmail.evaluate(() => { location.hash = '#inbox/abc123'; });
  await expect(host).toHaveCount(1); const next = await shell.boundingBox();
  expect(Math.abs(first!.width - next!.width)).toBeLessThan(2); expect(Math.abs(first!.x - next!.x)).toBeLessThan(2);
  await gmail.setViewportSize({ width: 340, height: 500 });
  await expect.poll(async () => { const box = await shell.boundingBox(); return box!.x >= 0 && box!.y >= 0 && box!.x + box!.width <= 341 && box!.y + box!.height <= 501; }).toBe(true);
  await gmail.emulateMedia({ reducedMotion: 'reduce' });
  expect(await shell.evaluate((element) => getComputedStyle(element).animationName)).toBe('none');
  await setup.evaluate(() => chrome.runtime.sendMessage({ type: 'OPEN_PIGEONBOX_WORKSPACE' }));
  await expect(shell).toBeVisible();
  await gmail.screenshot({ path: 'test-results/workspace-gmail-narrow.png' });
});

test('float and dock render one workspace and preserve unfinished input in trusted session storage', async ({ app }) => {
  await app.page('workspace'); const gmail = await app.gmail(); const frame = gmail.frameLocator('iframe[title="PigeonBox"]');
  await frame.getByRole('button', { name: 'Ask', exact: true }).click();
  await frame.getByRole('textbox', { name: 'Ask about mail on this computer' }).fill('Question before docking');
  // Exercise the genuine click gesture for Chrome's native sidePanel.open.
  await frame.getByRole('button', { name: 'Dock to side' }).click();
  await expect.poll(async () => (await app.worker.evaluate(async () => (await chrome.storage.local.get('workspaceState')).workspaceState.display))).toBe('dock');
  await expect(gmail.locator('[data-gi-ui="workspace"]')).toBeHidden();
  const dock = await app.context.newPage(); await dock.goto(`chrome-extension://${app.id}/sidepanel.html`);
  await expect(dock.getByRole('textbox', { name: 'Ask about mail on this computer' })).toHaveValue('Question before docking');
  await dock.evaluate(() => chrome.runtime.sendMessage({ type: 'WORKSPACE_DISPLAY', display: 'float', open: true }));
  await expect(gmail.locator('[data-gi-ui="workspace"]')).toBeVisible();
  await expect(frame.getByRole('textbox', { name: 'Ask about mail on this computer' })).toHaveValue('Question before docking');
  expect(await dock.locator('.pb-panel').count()).toBe(0);
});

test('current conversation follows Gmail, Ask carries account-bound context, and explicit tasks stay traceable', async ({ app }) => {
  await app.page('workspace', true); const gmail = await app.gmail(); const frame = gmail.frameLocator('iframe[title="PigeonBox"]');
  await expect(frame.getByRole('region', { name: 'Current conversation' })).toContainText('Pricing');
  await frame.getByRole('button', { name: 'Ask', exact: true }).click();
  await frame.getByRole('textbox', { name: 'Ask Pigeon', exact: true }).fill('Summarize this thread');
  await frame.locator('form').getByRole('button', { name: 'Ask', exact: true }).click();
  await expect(frame.getByText('Maya needs pricing.', { exact: true })).toBeVisible();
  expect(app.api.calls.find((call) => call.route === '/v1/ask')?.body).toMatchObject({ threadId: 'abc123', mailbox: 'owner@fixture.test' });
  await frame.getByRole('textbox', { name: 'Ask Pigeon', exact: true }).fill('Add this to my tasks');
  await frame.locator('form').getByRole('button', { name: 'Ask', exact: true }).click();
  await expect(frame.getByText('Task saved: Pricing. The source email is attached.')).toBeVisible();
  await frame.getByRole('button', { name: 'Home', exact: true }).click();
  await expect(frame.getByRole('checkbox', { name: 'Complete Pricing' })).toBeVisible();
  await frame.getByRole('checkbox', { name: 'Complete Pricing' }).check();
  await expect(frame.getByRole('checkbox', { name: 'Complete Pricing' })).toBeChecked();
  expect(app.api.calls.find((call) => call.route === '/v1/tasks' && call.body?.title)?.body).toMatchObject({ title: 'Pricing', threadId: 'abc123', mailbox: 'owner@fixture.test' });
  await gmail.evaluate(() => { location.hash = '#inbox'; document.querySelector('[data-thread-perm-id]')?.remove(); });
  await expect(frame.getByRole('region', { name: 'Current conversation' })).toHaveCount(0);
});

test('workspace command discovery remains keyboard accessible and restores focus', async ({ app }) => {
  const page = await app.page('workspace', true);
  const launcher = page.locator('[data-command-launcher]'); await launcher.focus(); await page.keyboard.press(shortcut);
  await expect(page.getByRole('combobox', { name: 'Ask Pigeon or run a command' })).toBeFocused();
  await page.getByRole('combobox', { name: 'Ask Pigeon or run a command' }).fill('Open approvals'); await page.getByRole('combobox', { name: 'Ask Pigeon or run a command' }).press('Enter');
  await expect(page.getByRole('heading', { name: 'Approvals', exact: true })).toBeVisible();
  await expect(page.getByRole('button', { name: 'Cloud', exact: true })).toHaveCount(0);
  expect(await page.evaluate(async () => chrome.runtime.getManifest().action?.default_popup)).toBeUndefined();
  await launcher.click(); await page.getByRole('combobox', { name: 'Ask Pigeon or run a command' }).press('Escape'); await expect(launcher).toBeFocused();
});
