import { test, expect, type Page } from './fixtures';

async function pull(page: Page, distance: number) {
  const box = await page.locator('#cp-theme').boundingBox();
  if (!box) throw new Error('Lamp is missing');
  const x = box.x + box.width / 2;
  const y = box.y + 42;
  await page.mouse.move(x, y);
  await page.mouse.down();
  await page.mouse.move(x, y + distance, { steps: 8 });
}

test('pull switches once on release, springs home and persists after reload', async ({ page }) => {
  await page.goto('/dashboard');
  const lamp = page.getByRole('button', { name: 'Dark mode', exact: true });
  await expect(lamp).toHaveAttribute('aria-pressed', 'false');
  await pull(page, 54);
  await expect(lamp).toHaveAttribute('data-armed', '');
  await expect(page.locator('html')).toHaveAttribute('data-pb-theme', 'light');
  await page.mouse.up();
  await expect(lamp).toHaveAttribute('aria-pressed', 'true');
  await expect(lamp.locator('.cp-lamp-drop')).toHaveCSS('transform', 'matrix(1, 0, 0, 1, 0, 0)');
  await expect(lamp.locator('.cp-lamp-swing')).toHaveCSS('transform', 'matrix(1, 0, 0, 1, 0, 0)');
  await page.reload();
  await expect(lamp).toHaveAttribute('aria-pressed', 'true');
  await expect(page.locator('html')).toHaveAttribute('data-pb-theme', 'dark');
});

test('short pulls and cancelled gestures leave the theme unchanged', async ({ page }) => {
  await page.goto('/dashboard');
  await pull(page, 9);
  await page.mouse.up();
  await expect(page.locator('html')).toHaveAttribute('data-pb-theme', 'light');
  await pull(page, 54);
  await page.locator('#cp-theme').dispatchEvent('pointercancel', { pointerId: 1 });
  await page.mouse.up();
  await expect(page.locator('#cp-theme')).not.toHaveAttribute('data-dragging', '');
  await expect(page.locator('html')).toHaveAttribute('data-pb-theme', 'light');
});

test('clicks can interrupt the return, and keyboard activation is immediate', async ({ page }) => {
  await page.goto('/dashboard');
  const lamp = page.locator('#cp-theme');
  await lamp.click({ position: { x: 22, y: 42 } });
  await expect(lamp).toHaveAttribute('aria-pressed', 'true');
  await lamp.click({ position: { x: 22, y: 42 } });
  await expect(lamp).toHaveAttribute('aria-pressed', 'false');
  await lamp.focus();
  await page.keyboard.press('Enter');
  await expect(lamp).toHaveAttribute('aria-pressed', 'true');
  await expect(lamp.locator('.cp-lamp-drop')).toHaveCSS('transform', 'matrix(1, 0, 0, 1, 0, 0)');
  await page.keyboard.press('Space');
  await expect(lamp).toHaveAttribute('aria-pressed', 'false');
});

test('reduced motion supports mouse, touch and keyboard without movement', async ({ page, browser }) => {
  await page.emulateMedia({ reducedMotion: 'reduce' });
  await page.goto('/dashboard');
  const lamp = page.locator('#cp-theme');
  await lamp.click();
  await expect(lamp).toHaveAttribute('aria-pressed', 'true');
  await expect(lamp.locator('.cp-lamp-drop')).toHaveCSS('transform', 'none');
  await lamp.focus();
  await page.keyboard.press('Space');
  await expect(lamp).toHaveAttribute('aria-pressed', 'false');
  const context = await browser.newContext({ viewport: { width: 390, height: 844 }, hasTouch: true, isMobile: true, reducedMotion: 'reduce' });
  const mobile = await context.newPage();
  await mobile.goto(page.url());
  await mobile.getByRole('button', { name: 'Sign in', exact: true }).click();
  await mobile.getByLabel('Email').fill('ada@work.test');
  await mobile.getByRole('button', { name: /sign in/i }).click();
  await expect(mobile.locator('#view .page')).toBeVisible();
  await mobile.getByRole('button', { name: 'Open sections' }).click();
  await mobile.locator('#cp-theme').tap();
  await expect(mobile.locator('#cp-theme')).toHaveAttribute('aria-pressed', 'true');
  await expect(mobile.locator('.cp-lamp-drop')).toHaveCSS('transform', 'none');
  expect(await mobile.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBe(true);
  await context.close();
});

test('old system preferences follow the OS until an explicit choice, and tabs stay in sync', async ({ page }) => {
  await page.emulateMedia({ colorScheme: 'dark' });
  await page.addInitScript(() => localStorage.setItem('pigeonboxAppearance', 'system'));
  await page.goto('/dashboard');
  const lamp = page.locator('#cp-theme');
  await expect(lamp).toHaveAttribute('aria-pressed', 'true');
  await page.emulateMedia({ colorScheme: 'light' });
  await expect(lamp).toHaveAttribute('aria-pressed', 'false');
  const other = await page.context().newPage();
  await other.goto(page.url());
  await lamp.click();
  await expect(other.locator('#cp-theme')).toHaveAttribute('aria-pressed', 'true');
  await other.evaluate(() => localStorage.removeItem('pigeonboxAppearance'));
  await expect(lamp).toHaveAttribute('aria-pressed', 'false');
  await other.close();
});
