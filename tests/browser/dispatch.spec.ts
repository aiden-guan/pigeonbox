import { test, expect } from './fixtures';
import type { Page } from '@playwright/test';

/** Explicitly synthetic mail, written only to the test fixture's disposable profile. */
async function seedDispatch(page: Page, count = 8) {
  await page.evaluate(async (size) => {
    const db = await new Promise<IDBDatabase>((resolve, reject) => {
      const request = indexedDB.open('gi_mailbox_v1');
      request.onsuccess = () => resolve(request.result);
      request.onerror = () => reject(request.error);
    });
    const tx = db.transaction(['threads', 'thread_summaries', 'search_documents'], 'readwrite');
    const names = ['Maya Chen', 'Priya Shah', 'Northwind team', 'The dispatch'];
    for (let index = 0; index < size; index++) {
      const id = `abc${index}`;
      const category = ['RESPOND', 'WAITING', 'FYI', 'WAITING'][index % 4];
      const subject = index === 0 ? 'Final review on the launch note' : index === 4 ? 'Budget for the next sprint' : `Dispatch fixture ${index + 1}: a longer subject with enough words to test truncation`;
      const at = new Date(Date.UTC(2026, 9, 1, 16, 42 - index)).toISOString();
      tx.objectStore('threads').put({ threadId: id, accountId: 'fixture', subject, participants: [], latestSender: { name: names[index % 4], email: 'sender@fixture.test' }, latestTimestamp: at, messageCount: 2, snippet: 'Review requested before Friday.', route: 'inbox', lastIndexedAt: Date.now(), contentFingerprint: id, classification: category, priority: index === 0 ? 'HIGH' : 'NORMAL', archivedLocally: false, requiresResponse: category === 'RESPOND', awaitingResponse: category === 'WAITING', virtualLabels: [] });
      tx.objectStore('thread_summaries').put({ threadId: id, fingerprint: id, source: 'model', aiStatus: 'success', createdAt: Date.now(), summary: { oneLine: 'Two edits are needed before Friday’s 10:00 review.', keyPoints: ['Final launch review'], actionItems: ['Soften the opening', 'Replace the screenshot'], dates: ['Friday · 10:00 AM'], decisions: [], unansweredQuestions: [], commitments: [] } });
      tx.objectStore('search_documents').put({ id, threadId: id, text: `${subject} Maya review Friday launch`, subject, senders: names[index % 4], recipients: 'owner@fixture.test', labels: category, timestamp: at, fingerprint: id });
    }
    await new Promise<void>((resolve, reject) => { tx.oncomplete = () => resolve(); tx.onerror = () => reject(tx.error); });
    db.close();
  }, count);
  await page.reload();
}

test('Dispatch popup: launcher morph, focus, category geometry, brief and responsive widths', async ({ app }) => {
  const page = await app.page('popup');
  const errors: string[] = [];
  page.on('pageerror', (error) => errors.push(error.message));
  await seedDispatch(page);
  await expect(page.getByRole('button', { name: 'Read brief: Final review on the launch note' })).toBeVisible();
  await expect(page.locator('.pb-overview-count strong')).toHaveText('8');
  await page.setViewportSize({ width: 448, height: 700 });
  await page.waitForTimeout(450);
  await page.screenshot({ path: 'test-results/dispatch-popup-448.png' });
  const launcher = page.locator('[data-command-launcher]');
  const origin = await launcher.boundingBox();
  await launcher.focus();
  await page.keyboard.press(process.platform === 'darwin' ? 'Meta+k' : 'Control+k');
  await expect(page.getByRole('dialog')).toBeVisible();
  const dialog = await page.getByRole('dialog').boundingBox();
  expect(Math.abs(dialog!.x - origin!.x)).toBeLessThan(2);
  expect(Math.abs(dialog!.y - origin!.y)).toBeLessThan(2);
  await expect(page.getByRole('combobox')).toBeFocused();
  await page.keyboard.press('ArrowDown');
  await page.keyboard.press('ArrowDown');
  await page.waitForTimeout(450);
  await page.screenshot({ path: 'test-results/dispatch-command.png' });
  await page.keyboard.press('Tab');
  await expect(page.getByRole('button', { name: 'Close commands' })).toBeFocused();
  await page.keyboard.press('Escape');
  await expect(page.getByRole('dialog')).toHaveCount(0);
  await expect(launcher).toBeFocused();
  for (const category of ['Waiting', 'FYI', 'Follow-ups', 'Respond']) {
    await page.getByRole('button', { name: new RegExp(`^${category}`) }).first().click();
    await page.waitForTimeout(450); // Normal-speed capture after authored choreography settles.
    await expect(page.locator('.pb-dispatch-categories button[aria-pressed="true"]')).toContainText(category);
  }
  const thread = page.getByRole('button', { name: 'Read brief: Final review on the launch note' });
  await thread.click();
  await expect(page.getByRole('region', { name: 'Pidgy Brief' })).toContainText('Two edits');
  await page.waitForTimeout(450);
  await page.screenshot({ path: 'test-results/dispatch-popup-brief.png' });
  await page.getByRole('button', { name: '← RESPOND' }).click();
  await expect(thread).toBeFocused();
  await page.waitForTimeout(450);
  for (const width of [320, 360, 380, 448]) {
    await page.setViewportSize({ width, height: 700 });
    await page.addStyleTag({ content: `html:has(body.gi-popup),body.gi-popup,body.gi-popup #root{width:${width}px}` });
    expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBe(true);
    await page.locator('.gi-popup-app').evaluate((node) => { node.scrollTop = 0; window.scrollTo(0, 0); });
    await page.waitForTimeout(100);
    await page.screenshot({ path: `test-results/dispatch-popup-${width}.png` });
  }
  await page.emulateMedia({ reducedMotion: 'reduce' });
  await launcher.click();
  expect(await page.getByRole('dialog').evaluate((node) => node.getAnimations().length)).toBe(0);
  await page.keyboard.press('Escape');
  await expect(page.getByRole('dialog')).toHaveCount(0);
  expect(errors).toEqual([]);
});

test('Dispatch side panel: positional mail, intelligence sources, Cloud and narrow layouts', async ({ app }) => {
  const page = await app.page('sidepanel');
  const errors: string[] = [];
  page.on('pageerror', (error) => errors.push(error.message));
  await seedDispatch(page);
  await expect(page.getByRole('button', { name: 'Read brief: Final review on the launch note' })).toBeVisible();
  for (const width of [320, 400, 480, 640]) {
    await page.setViewportSize({ width, height: 900 });
    expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBe(true);
    await page.waitForTimeout(400);
    await page.screenshot({ path: `test-results/dispatch-sidepanel-${width}.png` });
  }
  await page.getByRole('button', { name: 'Read brief: Final review on the launch note' }).click();
  await expect(page.getByRole('region', { name: 'Pidgy Brief' })).toContainText('Replace the screenshot');
  await page.waitForTimeout(450);
  await page.screenshot({ path: 'test-results/dispatch-panel-brief.png' });
  await page.keyboard.press('Escape');
  await page.getByRole('button', { name: 'Ask', exact: true }).click();
  await page.getByRole('textbox', { name: 'Ask about mail on this computer' }).fill('Maya launch review');
  await page.locator('form').getByRole('button', { name: 'Send', exact: true }).click();
  await expect(page.getByText('Sources', { exact: true })).toBeVisible();
  await page.waitForTimeout(400);
  await page.screenshot({ path: 'test-results/dispatch-local-ask.png' });
  const cloud = await app.page('sidepanel', true);
  cloud.on('pageerror', (error) => errors.push(error.message));
  await expect(cloud.getByText('Threads analyzed', { exact: true })).toBeVisible();
  await cloud.waitForTimeout(450);
  await cloud.screenshot({ path: 'test-results/dispatch-cloud.png' });
  await cloud.getByRole('button', { name: 'Ask', exact: true }).click();
  await cloud.getByRole('textbox', { name: 'Ask Pigeon', exact: true }).fill('What needs a reply?');
  await cloud.locator('form').getByRole('button', { name: 'Ask', exact: true }).click();
  await expect(cloud.getByText('Maya needs pricing.', { exact: true })).toBeVisible();
  await cloud.waitForTimeout(400);
  await cloud.screenshot({ path: 'test-results/dispatch-cloud-ask.png' });
  const preferences = await app.page('settings', true);
  await preferences.getByRole('button', { name: /Run on this computer instead/ }).click();
  await expect(preferences.locator('#run-mode .gi-choice').first()).toHaveAttribute('aria-pressed', 'true');
  await preferences.getByRole('button', { name: /^PigeonBox Cloud/ }).click();
  await preferences.getByRole('checkbox', { name: /I understand that email content/ }).check();
  await preferences.getByRole('button', { name: 'Use PigeonBox Cloud', exact: true }).click();
  await expect(preferences.locator('#run-mode .gi-choice').nth(1)).toHaveAttribute('aria-pressed', 'true');
  await preferences.waitForTimeout(450);
  await preferences.screenshot({ path: 'test-results/dispatch-mode-cloud.png' });
  expect(errors).toEqual([]);
});

test('Dispatch preferences, onboarding and isolated Gmail companion', async ({ app }) => {
  const page = await app.page('settings');
  const errors: string[] = [];
  page.on('pageerror', (error) => errors.push(error.message));
  await page.screenshot({ path: 'test-results/dispatch-settings.png', fullPage: true });
  await page.getByRole('link', { name: 'Tracking', exact: true }).click();
  await expect(page.locator('#tracking')).toBeInViewport();
  await page.setViewportSize({ width: 360, height: 900 });
  expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBe(true);
  await page.screenshot({ path: 'test-results/dispatch-settings-360.png' });
  const onboarding = await app.page('onboarding');
  onboarding.on('pageerror', (error) => errors.push(error.message));
  await onboarding.getByRole('button', { name: 'Continue', exact: true }).click();
  await onboarding.waitForTimeout(400);
  await onboarding.screenshot({ path: 'test-results/dispatch-onboarding-mode.png' });
  await onboarding.getByRole('button', { name: /Start with inbox rules/ }).click();
  await onboarding.getByRole('button', { name: 'Continue', exact: true }).click();
  await onboarding.getByRole('button', { name: /Skip for now/ }).click();
  await expect(onboarding.getByText('Ready for Gmail.', { exact: true })).toBeVisible();
  const gmail = await app.gmail();
  gmail.on('pageerror', (error) => errors.push(error.message));
  await expect(gmail.locator('[data-gi-ui="thread-panel"]')).toHaveCount(1);
  await gmail.waitForTimeout(700);
  await gmail.screenshot({ path: 'test-results/dispatch-gmail.png' });
  await gmail.setViewportSize({ width: 760, height: 800 });
  await gmail.screenshot({ path: 'test-results/dispatch-gmail-760.png' });
  expect(errors).toEqual([]);
});

test('Dispatch zero and large index, connected Gmail and meaningful system activity', async ({ app }) => {
  const page = await app.page('popup');
  await page.setViewportSize({ width: 448, height: 700 });
  await expect(page.locator('.pb-overview-count strong')).toHaveText('0');
  await page.screenshot({ path: 'test-results/dispatch-popup-zero.png' });
  const gmail = await app.gmail();
  await expect(gmail.locator('[data-gi-ui="thread-panel"]')).toHaveCount(1);
  await seedDispatch(page, 347);
  await expect(page.locator('[data-connection="gmail"]')).toContainText('Connected');
  const count = Number((await page.locator('.pb-overview-count strong').innerText()).replaceAll(',', ''));
  expect(count).toBeGreaterThanOrEqual(347);
  await page.waitForTimeout(450);
  await page.screenshot({ path: 'test-results/dispatch-popup-large-connected.png' });
  await page.locator('[data-command-launcher]').click();
  await page.waitForTimeout(450);
  await page.getByRole('combobox').fill('Find important emails');
  await page.keyboard.press('Enter');
  // The command uses the original sidePanel.open user gesture and closes the popup.
  await expect.poll(() => page.isClosed()).toBe(true);
});
