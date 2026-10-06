import { expect, test } from './fixtures';

const checks = (calls: Array<{ route: string; body: Record<string, unknown> }>) => calls.filter((call) => call.route === '/v1/compose/check');

test('real-time Pidgy check: prose stays local, a busy-calendar claim gets one quiet notice, closing cleans up', async ({ app }) => {
  app.api.composeChecks = true;
  await (await app.page('settings', true)).close();
  const page = await app.context.newPage();
  await page.goto(`chrome-extension://${app.id}/brain-fixture.html`);
  await expect(page.locator('body')).toHaveAttribute('data-brain-checks', '1');
  const body = page.locator('#brain-compose [aria-label="Message Body"]');
  const notice = page.locator('[data-gi-ui="brain-notice"]');
  const status = page.locator('#brain-compose [data-gi-ui="pidgy-status"] .pb-status');

  // Ordinary prose: no Brain request of any kind.
  const preferenceReads = () => app.api.calls.filter((call) => call.route === '/v1/preferences').length;
  const readsBefore = preferenceReads();
  await body.click();
  await page.keyboard.type('Thanks for the notes on the deck, really helpful.');
  await page.waitForTimeout(1_800);
  expect(checks(app.api.calls)).toHaveLength(0);
  expect(preferenceReads()).toBe(readsBefore);

  // Pidgy is present and quiet; prose never changed it.
  await expect(status).toHaveAttribute('data-state', 'idle');

  // An availability claim while the (mocked, calendar-backed) Cloud says busy: the time gets a quiet mark, no card.
  await page.keyboard.type(" I'm free tomorrow at 3.");
  await expect(status).toHaveAttribute('data-state', 'attention');
  const dot = notice.locator('.pb-dot');
  await expect(dot).toBeVisible();
  const popover = notice.getByRole('dialog', { name: 'Pidgy' });
  await expect(popover).toBeHidden();
  expect(await page.evaluate(() => (CSS as unknown as { highlights: Map<string, unknown> }).highlights.has('pigeonbox-advisory'))).toBe(true);
  // The body did not grow and nothing was written into Gmail's editor.
  expect(await body.evaluate((node) => node.querySelectorAll('[data-gi-ui]').length)).toBe(0);
  await dot.click();
  await expect(popover).toBeVisible();
  await expect(popover).toContainText('You have Math 52 from 2–4 PM tomorrow.');
  await expect(popover.getByRole('button', { name: 'View source' })).toBeVisible();
  await expect(popover.getByRole('button', { name: /Fix/ })).toBeVisible();
  const sent = checks(app.api.calls);
  expect(sent).toHaveLength(1);
  expect(sent[0]!.body).toMatchObject({ claim: "I'm free tomorrow at 3.", hint: 'availability', recipientEmails: ['alex@fixture.test'] });
  expect(JSON.stringify(sent[0]!.body)).not.toContain('Thanks for the notes');

  // The popover covers none of Gmail's controls or the tracking badge.
  const overlaps = await page.evaluate(() => {
    const host = document.querySelector('[data-gi-ui="brain-notice"]')!.shadowRoot!.querySelector('.pb-pop')!.getBoundingClientRect();
    return Array.from(document.querySelectorAll('#brain-compose button')).filter((control) => {
      const box = control.getBoundingClientRect();
      return !(host.right <= box.left || host.left >= box.right || host.bottom <= box.top || host.top >= box.bottom);
    }).length;
  });
  expect(overlaps).toBe(0);

  // Change the sentence: the stale advice goes away.
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
  // The composer asked (with no draft text) whether checks are on; they are not, so Pidgy never appears.
  await expect.poll(() => app.api.calls.filter((call) => call.route === '/v1/preferences').length).toBeGreaterThan(0);
  await page.locator('#brain-compose [aria-label="Message Body"]').click();
  await page.keyboard.type("I'm free tomorrow at 3.");
  await page.waitForTimeout(2_000);
  await expect(page.locator('#brain-compose [data-gi-ui="pidgy-status"]')).toHaveCount(0);
  expect(checks(app.api.calls)).toHaveLength(0);
  await expect(page.locator('#brain-compose [data-gi-ui="brain-notice"]')).toHaveCount(0);
});

test('real-time Pidgy check: Tab applies the fix to just the time while presented, Escape dismisses, Tab is otherwise Gmail\'s', async ({ app }) => {
  app.api.composeChecks = true;
  await (await app.page('settings', true)).close();
  const page = await app.context.newPage();
  await page.goto(`chrome-extension://${app.id}/brain-fixture.html`);
  const body = page.locator('#brain-compose [aria-label="Message Body"]');
  const notice = page.locator('[data-gi-ui="brain-notice"]');
  await body.click();
  await page.keyboard.type("Hi Alex. I'm free tomorrow at 3. Talk soon");
  await expect(notice.locator('.pb-dot')).toBeVisible();
  // Not presented: Tab is not taken.
  const tabbed = await body.evaluate((node) => {
    const event = new KeyboardEvent('keydown', { key: 'Tab', bubbles: true, cancelable: true });
    node.dispatchEvent(event);
    return event.defaultPrevented;
  });
  expect(tabbed).toBe(false);
  await notice.locator('.pb-dot').click();
  await expect(notice.getByRole('dialog', { name: 'Pidgy' })).toBeVisible();
  await page.keyboard.press('Tab');
  await expect(body).toHaveText("Hi Alex. I'm free tomorrow at 4:30. Talk soon");
  await expect(notice).toHaveCount(0, { timeout: 4_000 });
  // The edit is a normal one: Gmail's undo takes it back.
  await page.keyboard.press(process.platform === 'darwin' ? 'Meta+z' : 'Control+z');
  await expect(body).toHaveText("Hi Alex. I'm free tomorrow at 3. Talk soon");
  // Typing elsewhere after Escape: the dismissed advice does not return.
  await expect(notice.locator('.pb-dot')).toBeVisible({ timeout: 8_000 });
  await notice.locator('.pb-dot').click();
  await page.keyboard.press('Escape');
  await expect(notice).toHaveCount(0);
  await page.keyboard.type(' Cheers.');
  await page.waitForTimeout(1_500);
  await expect(notice).toHaveCount(0);
});
