import { test, expect } from './fixtures';

test('Inbox restores sent tracking and keeps its selected view through navigation and docking', async ({ app }) => {
  const page = await app.page('workspace');
  await app.worker.evaluate(async () => {
    await chrome.storage.local.set({ trackedEmails: [{ trackingId: 'sent-fixture', status: 'SENT', subject: 'Sent proposal', sender: 'owner@fixture.test', recipients: ['Maya'], gmailThreadId: 'abc123', gmailMessageId: null, sentAt: new Date().toISOString(), openCount: 2, clickCount: 1, firstOpenedAt: null, lastOpenedAt: null, notifyIfNoReply: false }] });
  });
  await page.getByRole('navigation', { name: 'Workspace' }).getByRole('button', { name: 'Inbox', exact: true }).click();
  await page.getByRole('button', { name: 'Sent & tracking', exact: true }).click();
  await expect(page.getByText('Sent proposal', { exact: true })).toBeVisible();
  await expect(page.getByText('Opened 2×', { exact: true })).toBeVisible();
  await expect(page.getByText('1 click', { exact: true })).toBeVisible();
  await page.getByRole('button', { name: 'Home', exact: true }).click();
  await page.getByRole('button', { name: 'Inbox', exact: true }).click();
  await expect(page.getByRole('button', { name: 'Sent & tracking', exact: true })).toHaveAttribute('aria-pressed', 'true');
  await page.evaluate(() => chrome.runtime.sendMessage({ type: 'WORKSPACE_DISPLAY', display: 'dock', open: true }));
  const dock = await app.context.newPage(); await dock.goto(`chrome-extension://${app.id}/sidepanel.html`);
  await expect(dock.getByRole('button', { name: 'Sent & tracking', exact: true })).toHaveAttribute('aria-pressed', 'true');
  for (const width of [320, 420, 800]) {
    await dock.setViewportSize({ width, height: 800 });
    expect(await dock.locator('.pb-panel').evaluate((node) => node.scrollWidth <= node.clientWidth)).toBe(true);
    const inbox = await dock.getByRole('button', { name: 'Inbox', exact: true }).boundingBox();
    const settings = await dock.getByRole('button', { name: 'Open PigeonBox Settings', exact: true }).boundingBox();
    expect(inbox!.x + inbox!.width).toBeLessThan(settings!.x);
    await dock.screenshot({ path: `test-results/inbox-sent-${width}.png` });
  }
});

test('View engagement reveals visible details inside the selected email at side-panel width', async ({ app }) => {
  app.api.engagement = true;
  const page = await app.page('sidepanel', true);
  await page.setViewportSize({ width: 320, height: 800 });
  await page.getByRole('button', { name: 'Inbox', exact: true }).click();
  await page.getByRole('button', { name: 'Waiting', exact: true }).click();
  const row = page.locator('.gi-shadow-decision').filter({ hasText: 'Waiting on pricing' });
  await row.getByRole('button', { name: 'View engagement', exact: true }).click();
  await expect(row.getByRole('region', { name: 'Engagement details' })).toBeVisible();
  await expect(row.getByText('A recipient open was observed.', { exact: true })).toBeVisible();
  await expect(row.getByRole('button', { name: 'Hide engagement', exact: true })).toHaveAttribute('aria-expanded', 'true');
  expect(app.api.calls.find((call) => call.route === '/v1/signals/thread')?.body).toMatchObject({ threadId: 'abc123', accountId: '00000000-0000-4000-8000-000000000001' });
  expect(app.api.calls.some((call) => call.route === '/v1/audit' || call.route === '/v1/automations/runs')).toBe(false);
  expect(await page.locator('.pb-panel').evaluate((node) => node.scrollWidth <= node.clientWidth)).toBe(true);
  await page.screenshot({ path: 'test-results/inbox-engagement-320.png' });
});
