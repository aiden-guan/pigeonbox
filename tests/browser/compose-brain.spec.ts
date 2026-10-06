import { expect, test } from './fixtures';

const checks = (calls: Array<{ route: string; body: Record<string, unknown> }>) => calls.filter((call) => call.route === '/v1/compose/check');

test('real-time Pidgy check: prose stays local, a busy-calendar claim gets one quiet notice, closing cleans up', async ({ app }) => {
  app.api.composeChecks = true;
  await (await app.page('settings', true)).close();
  const page = await app.context.newPage();
  await page.goto(`chrome-extension://${app.id}/brain-fixture.html`);
  await expect(page.locator('body')).toHaveAttribute('data-brain-checks', '1');
  const body = page.locator('#brain-compose [aria-label="Message Body"]');
  const notice = page.locator('#brain-compose [data-gi-ui="brain-notice"]');

  // Ordinary prose: no Brain request of any kind.
  const preferenceReads = () => app.api.calls.filter((call) => call.route === '/v1/preferences').length;
  const readsBefore = preferenceReads();
  await body.click();
  await page.keyboard.type('Thanks for the notes on the deck, really helpful.');
  await page.waitForTimeout(1_800);
  expect(checks(app.api.calls)).toHaveLength(0);
  expect(preferenceReads()).toBe(readsBefore);

  // An availability claim while the (mocked, calendar-backed) Cloud says busy.
  await page.keyboard.type(" I'm free tomorrow at 3.");
  await expect(notice).toBeVisible();
  await expect(notice.getByRole('status')).toContainText('Pidgy noticed something');
  await expect(notice).toContainText('You have Math 52 from 2–4 PM tomorrow.');
  await expect(notice.getByRole('button', { name: 'View source' })).toBeVisible();
  await expect(notice.getByRole('button', { name: 'Use suggestion' })).toBeVisible();
  const sent = checks(app.api.calls);
  expect(sent).toHaveLength(1);
  expect(sent[0]!.body).toMatchObject({ claim: "I'm free tomorrow at 3.", hint: 'availability', recipientEmails: ['alex@fixture.test'] });
  expect(JSON.stringify(sent[0]!.body)).not.toContain('Thanks for the notes');

  // The notice sits under the body and covers none of Gmail's controls or the tracking badge.
  const overlaps = await page.evaluate(() => {
    const host = document.querySelector('#brain-compose [data-gi-ui="brain-notice"]')!.getBoundingClientRect();
    return Array.from(document.querySelectorAll('#brain-compose button')).filter((control) => {
      const box = control.getBoundingClientRect();
      return !(host.right <= box.left || host.left >= box.right || host.bottom <= box.top || host.top >= box.bottom);
    }).length;
  });
  expect(overlaps).toBe(0);

  // Change the sentence: the stale notice goes away.
  await page.keyboard.press('Backspace');
  await page.keyboard.press('Backspace');
  await page.keyboard.type('5.');
  await expect(notice).toHaveCount(0, { timeout: 8_000 });

  // Tracking and the placeholder guard still work in the same compose.
  await expect(page.locator('#brain-compose [data-gi-ui="track-toggle"]')).toHaveText('Tracking ready');
  await expect(page.locator('body')).toHaveAttribute('data-tracking', 'MODIFIER_REGISTERED');
  await page.getByRole('button', { name: 'Try sending placeholder' }).click();
  await expect(page.getByRole('button', { name: 'Placeholder send blocked' })).toBeVisible();

  // Close: controller, listeners and UI are gone; typing afterwards sends nothing.
  await page.keyboard.type(' Also free tomorrow at 3 works for me.');
  await page.getByRole('button', { name: 'Close compose' }).click();
  await expect(page.locator('body')).toHaveAttribute('data-brain-checks', '0');
  const before = checks(app.api.calls).length;
  await body.click();
  await page.keyboard.type(" Wednesday at 11 works for me. I'm free tomorrow at 3 again.");
  await page.waitForTimeout(4_500);
  expect(checks(app.api.calls)).toHaveLength(before);
  await expect(notice).toHaveCount(0);
});

test('real-time Pidgy check: with the preference off, the clause never leaves the extension', async ({ app }) => {
  app.api.composeChecks = false;
  await (await app.page('settings', true)).close();
  const page = await app.context.newPage();
  await page.goto(`chrome-extension://${app.id}/brain-fixture.html`);
  const reads = () => app.api.calls.filter((call) => call.route === '/v1/preferences').length;
  const before = reads();
  await page.locator('#brain-compose [aria-label="Message Body"]').click();
  await page.keyboard.type("I'm free tomorrow at 3.");
  await expect.poll(reads).toBeGreaterThan(before);
  await page.waitForTimeout(1_000);
  expect(checks(app.api.calls)).toHaveLength(0);
  await expect(page.locator('#brain-compose [data-gi-ui="brain-notice"]')).toHaveCount(0);
});
