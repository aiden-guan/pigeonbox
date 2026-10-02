import { test, expect } from './fixtures';

/**
 * Cloud Home, Drafts and draft review through the real worker, client and
 * contract-validated fixture responses.
 */

test('healthy mail with queued AI review never reads as syncing', async ({ app }) => {
  app.api.syncMode = 'analyzing';
  const page = await app.page('sidepanel', true);
  const status = page.locator('.pb-status [role="status"]');
  await expect(status).toContainText('Mail up to date');
  await expect(status).toContainText('Reviewing 12 new conversations');
  await expect(page.getByText(/syncing/i)).toHaveCount(0);
  await expect(page.locator('.pb-status')).toHaveAttribute('data-tone', 'ok');
});

test('reauthorization is an attention state with a route to fix it', async ({ app }) => {
  app.api.syncMode = 'reauth';
  const page = await app.page('sidepanel', true);
  await expect(page.locator('.pb-status [role="status"]')).toContainText('Reconnect your Google account');
  await expect(page.getByRole('button', { name: 'Reconnect', exact: true })).toBeVisible();
});

test('Home puts current work first and collapses zero activity', async ({ app }) => {
  app.api.quiet = true;
  const page = await app.page('sidepanel', true);
  await expect(page.getByRole('heading', { name: 'Ready for you' })).toBeVisible();
  await expect(page.getByText('Nothing new since your last visit.')).toHaveCount(0);
  const order = await page.locator('.pb-home-kicker').allTextContents();
  expect(order).toContain('Ready for you');
  expect(order).not.toContain('While you were away');
  await expect(page.getByText(/threads analyzed/i)).toHaveCount(0);
  const item = page.locator('.pb-ready-item').first();
  await expect(item).toContainText('Maya');
  await expect(item).toContainText('Reply prepared');
  await expect(item).toContainText('Deadline passed');
  await expect(item.getByRole('button', { name: 'Review draft: Pricing' })).toBeVisible();
  await expect(page.getByRole('button', { name: /1 approval waiting/ })).toBeVisible();
  await page.screenshot({ path: 'test-results/cloud-home.png', fullPage: true });
});

test('a prepared draft is reachable from Ready for you, Prepared for you and Drafts, and placement is accurate', async ({ app }) => {
  const page = await app.page('sidepanel', true);
  // Ready for you → review, keyboard only.
  await page.getByRole('button', { name: 'Review draft: Pricing' }).focus();
  await page.keyboard.press('Enter');
  await expect(page.getByRole('heading', { name: 'Maya' })).toBeFocused();
  await expect(page.getByText('Maya asks for pricing.')).toBeVisible();
  await expect(page.getByText('Prepared in PigeonBox. Not in Gmail yet.')).toBeVisible();
  // A placeholder blocks the unsafe path.
  await expect(page.getByRole('button', { name: 'Add to Gmail', exact: true })).toBeDisabled();
  await page.getByRole('button', { name: '[CONFIRM PRICE]' }).click();
  await page.keyboard.type('$4,800');
  await page.screenshot({ path: 'test-results/cloud-draft-review.png', fullPage: true });
  await page.getByRole('button', { name: 'Add to Gmail', exact: true }).click();
  await expect(page.getByText('Added to your Gmail Drafts. Nothing was sent.')).toBeVisible();
  await expect(page.getByText('In your Gmail Drafts folder. Nothing is sent automatically.')).toBeVisible();
  await expect(page.getByRole('button', { name: 'Open in Gmail', exact: true })).toBeVisible();
  const place = app.api.calls.find((call) => call.route === '/v1/drafts/place');
  expect(place?.body).toMatchObject({ draftId: '00000000-0000-4000-8000-000000000002', body: 'The price is $4,800.' });
  expect(app.api.calls.some((call) => /send|approvals\/decide/.test(call.route))).toBe(false);

  // Back home: Prepared for you leads to the Drafts filters.
  await page.getByRole('button', { name: '← Home' }).click();
  await page.getByRole('button', { name: /draft in Gmail/ }).click();
  await expect(page.getByRole('tab', { name: /In Gmail/ })).toHaveAttribute('aria-selected', 'true');
  await expect(page.locator('.pb-draft')).toHaveCount(2);
  await expect(page.locator('.pb-draft').filter({ hasText: 'Pricing' }).locator('.pb-state')).toHaveText('In Gmail');

  // Needs update → Update draft uses draftPrepare.
  await page.getByRole('tab', { name: /Needs update/ }).click();
  const stale = page.locator('.pb-draft').filter({ hasText: 'Workshop notes' });
  await expect(stale.locator('.pb-state')).toHaveText('Needs update');
  await stale.getByRole('button', { name: 'Review draft: Workshop notes' }).click();
  await page.getByRole('button', { name: 'Update draft', exact: true }).click();
  await expect(page.getByText('Draft updated from the latest messages.')).toBeVisible();
  expect(app.api.calls.find((call) => call.route === '/v1/drafts/prepare')?.body).toMatchObject({ threadId: 'ghi789', kind: 'reply' });
  await page.screenshot({ path: 'test-results/cloud-drafts.png', fullPage: true });
});

for (const [label, width] of [['narrow', 320], ['normal', 400], ['widened', 960]] as const) {
  test(`Cloud Home and Drafts fit a ${label} side panel`, async ({ app }) => {
    const page = await app.page('sidepanel', true);
    await page.setViewportSize({ width, height: 900 });
    await expect(page.getByRole('heading', { name: 'Ready for you' })).toBeVisible();
    const fits = () => page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth);
    expect(await fits()).toBe(true);
    await expect(page.getByRole('button', { name: 'Review draft: Pricing' })).toBeInViewport();
    const ready = await page.locator('[aria-labelledby="pb-ready-title"]').boundingBox();
    const prepared = await page.locator('[aria-labelledby="pb-prepared-title"]').boundingBox();
    if (width >= 720) expect(prepared!.x).toBeGreaterThan(ready!.x + ready!.width - 1);
    else expect(prepared!.y).toBeGreaterThan(ready!.y);
    await page.screenshot({ path: `test-results/cloud-home-${label}.png`, fullPage: true });
    await page.locator('[data-command-launcher]').click();
    await page.getByRole('combobox').fill('Prepared drafts');
    await page.getByRole('combobox').press('Enter');
    await expect(page.locator('.pb-draft').first()).toBeVisible();
    expect(await fits()).toBe(true);
    await page.screenshot({ path: `test-results/cloud-drafts-${label}.png`, fullPage: true });
  });
}

test('status announcements and reduced motion', async ({ app }) => {
  const page = await app.page('sidepanel', true);
  await expect(page.locator('.pb-status [role="status"]')).toHaveAttribute('aria-live', 'polite');
  await expect(page.locator('.pb-status-title')).toHaveText('Up to date');
  await page.emulateMedia({ reducedMotion: 'reduce' });
  const animation = await page.locator('.pb-home-section').first().evaluate((node) => getComputedStyle(node).animationName);
  expect(animation).toBe('none');
});
