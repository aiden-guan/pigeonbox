import { test, expect } from './fixtures';

test('appearance wheel resists a small scroll and still switches in both directions', async ({ app }) => {
  const page = await app.page('onboarding');
  await page.emulateMedia({ reducedMotion: 'reduce' });
  await page.reload();
  const slider = page.getByRole('slider', { name: 'Appearance' });
  await expect(slider).toHaveAttribute('aria-valuetext', 'light mode');
  await page.mouse.wheel(0, 50);
  await page.waitForTimeout(250);
  await expect(slider).toHaveAttribute('aria-valuetext', 'light mode');
  await page.mouse.wheel(0, 70);
  await expect(page.locator('html')).toHaveAttribute('data-pb-theme', 'dark');
  await expect(slider).toHaveAttribute('aria-valuetext', 'night mode');
  await page.mouse.wheel(0, -70);
  await expect(page.locator('html')).toHaveAttribute('data-pb-theme', 'light');
  await expect(slider).toHaveAttribute('aria-valuetext', 'light mode');
});

test('dotted sky holds its theme during the opening reel and accepts an early choice', async ({ app }, testInfo) => {
  const page = await app.page('onboarding');
  const errors: string[] = [];
  page.on('pageerror', error => errors.push(error.message));
  await page.waitForTimeout(1200);
  expect(await page.locator('.ob-theme').evaluate(el => getComputedStyle(el).getPropertyValue('--t').trim())).toBe('0.0000');
  await page.waitForTimeout(1900);
  await expect(page.getByRole('slider', { name: 'Appearance' })).toHaveAttribute('aria-valuetext', 'light mode');

  await page.reload();
  const slider = page.getByRole('slider', { name: 'Appearance' });
  await slider.press('ArrowDown');
  await expect(page.locator('html')).toHaveAttribute('data-pb-theme', 'dark');

  const frameTiming = await page.evaluate(async () => {
    const gaps: number[] = [];
    let last = await new Promise<number>(resolve => requestAnimationFrame(resolve));
    for (let i = 0; i < 120; i++) {
      const now = await new Promise<number>(resolve => requestAnimationFrame(resolve));
      gaps.push(now - last);
      last = now;
    }
    const sorted = [...gaps].sort((a, b) => a - b);
    return { samples: gaps.length, medianMs: sorted[60], p95Ms: sorted[114], over50Ms: gaps.filter(n => n > 50).length };
  });
  await testInfo.attach('sky-frame-timing', { body: JSON.stringify(frameTiming), contentType: 'application/json' });
  console.log('Onboarding sky frame timing:', JSON.stringify(frameTiming));
  // Keep timing as diagnostic evidence: virtual CI renderers have a different
  // frame cadence. Gate the animation properties, rather than runner hardware.
  const animatedProperties = await page.locator('.ob-sky-art, .ob-sky-orb').evaluateAll(elements =>
    [...new Set(elements.flatMap(el => el.getAnimations({ subtree: true }).flatMap(animation =>
      (animation.effect as KeyframeEffect).getKeyframes().flatMap(keyframe => Object.keys(keyframe)),
    )))].filter(key => !['offset', 'computedOffset', 'easing', 'composite'].includes(key)),
  );
  expect(animatedProperties.sort()).toEqual(['opacity', 'transform']);
  await page.waitForTimeout(3000);
  await expect(slider).toHaveAttribute('aria-valuetext', 'night mode');
  expect(await page.locator('.ob-sky-day').evaluate(el => Number(getComputedStyle(el).opacity))).toBe(0);
  expect(await page.locator('.ob-sky-night').evaluate(el => Number(getComputedStyle(el).opacity))).toBe(1);

  // Reverse before the previous spring has finished, then settle on the final choice.
  await slider.press('ArrowUp');
  await page.waitForTimeout(100);
  await slider.press('ArrowDown');
  await expect(slider).toHaveAttribute('aria-valuetext', 'night mode');
  await expect(page.locator('html')).toHaveAttribute('data-pb-theme', 'dark');

  // Inspect the same coordinated UFO cycle at two moments, including a rendered beam.
  const pose = async (time: number) => page.evaluate(time => {
    for (const a of document.getAnimations()) {
      const target = (a.effect as KeyframeEffect)?.target;
      if (target instanceof Element && target.closest('.ob-sky-art, .ob-sky-orb')) { a.pause(); a.currentTime = time; }
    }
    const person = document.querySelector('.ob-sky-passenger')!;
    const beam = document.querySelector('.ob-sky-beam')!;
    const style = getComputedStyle(person);
    return { y: new DOMMatrix(style.transform).m42, opacity: Number(style.opacity), beam: Number(getComputedStyle(beam).opacity) };
  }, time);
  const lower = await pose(5200);
  const upper = await pose(8500);
  expect(lower.opacity).toBeGreaterThan(.7);
  expect(upper.opacity).toBeGreaterThan(.7);
  expect(upper.y).toBeLessThan(lower.y - 40);
  expect(upper.beam).toBeGreaterThan(.9);
  await pose(6400);
  await page.screenshot({ path: 'test-results/onboarding-sky-night.png' });
  expect(errors).toEqual([]);
});

test('day and night artwork, text and continuation fit narrow and short windows', async ({ app }) => {
  const page = await app.page('onboarding');
  await page.emulateMedia({ reducedMotion: 'reduce' });
  await page.reload();
  await expect.poll(() => page.locator('.ob-theme-actions').evaluate(el => Number(getComputedStyle(el).opacity))).toBe(1);
  await expect.poll(() => page.locator('.ob-sky-orb').evaluate(el => Number(getComputedStyle(el).opacity))).toBe(1);
  for (const viewport of [{ width: 1440, height: 900 }, { width: 768, height: 800 }, { width: 390, height: 844 }, { width: 320, height: 568 }, { width: 568, height: 320 }]) {
    await page.setViewportSize(viewport);
    for (const mode of ['light', 'night']) {
      const slider = page.getByRole('slider', { name: 'Appearance' });
      if (await slider.getAttribute('aria-valuetext') !== `${mode} mode`) await slider.press('ArrowDown');
      await expect(slider).toHaveAttribute('aria-valuetext', `${mode} mode`);
      const bounds = await page.locator('.ob-sky-orb, .ob-theme-line, .ob-theme-actions').evaluateAll(elements => elements.map(el => {
        const r = el.getBoundingClientRect();
        return { left: r.left, top: r.top, right: r.right, bottom: r.bottom };
      }));
      for (const r of bounds) {
        expect(r.left).toBeGreaterThanOrEqual(0);
        expect(r.top).toBeGreaterThanOrEqual(0);
        expect(r.right).toBeLessThanOrEqual(viewport.width);
        expect(r.bottom).toBeLessThanOrEqual(viewport.height);
      }
      expect(bounds[0].bottom).toBeLessThanOrEqual(bounds[1].top);
      expect(bounds[1].bottom).toBeLessThanOrEqual(bounds[2].top);
      const scenery = await page.locator(`.ob-sky-${mode === 'light' ? 'day' : 'night'} .ob-sky-sprite`).evaluateAll(elements => elements.map(el => {
        const r = el.getBoundingClientRect();
        return { x: r.left + r.width / 2, y: r.top + r.height / 2 };
      }));
      expect(scenery.some(p => p.x < viewport.width * .3)).toBe(true);
      expect(scenery.some(p => p.x > viewport.width * .7)).toBe(true);
      expect(scenery.some(p => p.y > viewport.height * .75)).toBe(true);
      if (viewport.width === 1440 || viewport.width === 320) await page.screenshot({ path: `test-results/onboarding-sky-${mode}-${viewport.width}.png` });
    }
  }
  const animations = await page.locator('.ob-sky-art').evaluate(el => el.getAnimations({ subtree: true }).filter(a => a.playState === 'running' && a.effect?.getTiming().iterations === Infinity).length);
  expect(animations).toBe(0);
  await page.getByRole('button', { name: 'That’s me' }).click();
  await expect(page.getByRole('button', { name: /On this computer/ })).toBeVisible();
  await expect(page.locator('.ob-sky-art')).toHaveCount(0);
});
