import { test, expect } from './fixtures';
import { writeFile } from 'node:fs/promises';

function luminance(color: string) {
  const channels = color.match(/[\d.]+/g)!.slice(0, 3).map((value) => {
    const channel = Number(value) / 255;
    return channel <= .04045 ? channel / 12.92 : ((channel + .055) / 1.055) ** 2.4;
  });
  return channels[0] * .2126 + channels[1] * .7152 + channels[2] * .0722;
}
const contrast = (a: string, b: string) => (Math.max(luminance(a), luminance(b)) + .05) / (Math.min(luminance(a), luminance(b)) + .05);

test('semantic themes stay readable at compact widths and appearance survives reopening', async ({ app }) => {
  const page = await app.page('sidepanel', true);
  const appearance = async (label: string) => {
    await page.locator('[data-command-launcher]').click();
    await page.getByRole('combobox', { name: 'Ask Pigeon or run a command' }).fill(label);
    await page.getByRole('combobox', { name: 'Ask Pigeon or run a command' }).press('Enter');
  };
  await appearance('Switch to light appearance');
  for (const theme of ['light', 'dark'] as const) {
    if (theme === 'dark') await appearance('Switch to dark appearance');
    await expect(page.locator('html')).toHaveAttribute('data-pb-theme', theme);
    for (const width of [280, 320, 420, 680]) {
      await page.setViewportSize({ width, height: 850 });
      expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBe(true);
    }
    const colors = await page.evaluate(() => {
      const style = getComputedStyle(document.documentElement);
      const resolve = (token: string) => {
        const probe = document.createElement('span');
        probe.style.color = style.getPropertyValue(token); document.body.append(probe);
        const value = getComputedStyle(probe).color; probe.remove(); return value;
      };
      return { foreground: resolve('--pb-fg'), muted: resolve('--pb-fg-muted'), surface: resolve('--pb-surface'), raised: resolve('--pb-surface-raised'), accent: resolve('--pb-accent'), onAccent: resolve('--pb-on-accent') };
    });
    expect(contrast(colors.foreground, colors.surface)).toBeGreaterThanOrEqual(4.5);
    expect(contrast(colors.muted, colors.raised)).toBeGreaterThanOrEqual(4.5);
    expect(contrast(colors.accent, colors.onAccent)).toBeGreaterThanOrEqual(4.5);
    await page.setViewportSize({ width: 420, height: 850 });
    await page.evaluate(() => Promise.all(document.getAnimations().map((animation) => animation.finished.catch(() => undefined))));
    await page.screenshot({ path: `test-results/design-home-${theme}.png`, fullPage: true });
  }
  await page.reload();
  await expect(page.locator('html')).toHaveAttribute('data-pb-theme', 'dark');
  await page.locator('[data-command-launcher]').click();
  await page.getByRole('combobox').fill('Prepared drafts');
  await page.getByRole('combobox').press('Enter');
  await page.getByRole('button', { name: 'Review draft: Pricing' }).click();
  await expect(page.getByRole('textbox', { name: 'Draft' })).toBeVisible();
  await page.screenshot({ path: 'test-results/design-prepared-reply-dark.png', fullPage: true });
});

test('Pidgy and the shell remain one spatial object through interruption and reduced motion', async ({ app }) => {
  await app.page('workspace', true);
  const gmail = await app.gmail();
  await gmail.emulateMedia({ reducedMotion: 'no-preference', colorScheme: 'light' });
  const host = gmail.locator('[data-gi-ui="workspace"]');
  const shell = host.locator('.gi-shell');
  const bird = host.locator('.pidgy');
  await bird.evaluate((node) => { node.setAttribute('data-probe', 'same-node'); });
  await expect(gmail.frameLocator('iframe[title="PigeonBox"]').getByRole('navigation', { name: 'Workspace' })).toBeVisible();
  const workspace = gmail.frameLocator('iframe[title="PigeonBox"]');
  const appearance = async (label: string) => {
    await workspace.locator('[data-command-launcher]').click();
    await workspace.getByRole('combobox', { name: 'Ask Pigeon or run a command' }).fill(label);
    await workspace.getByRole('combobox', { name: 'Ask Pigeon or run a command' }).press('Enter');
  };
  await appearance('Switch to light appearance');
  await expect(host).toHaveAttribute('data-pb-theme','light');
  expect(await shell.evaluate((node) => getComputedStyle(node).backgroundColor)).toBe('rgb(255, 255, 255)');
  await appearance('Switch to dark appearance');
  await expect(host).toHaveAttribute('data-pb-theme','dark');
  expect(await shell.evaluate((node) => getComputedStyle(node).backgroundColor)).toBe('rgb(25, 27, 30)');
  await appearance('Match system appearance');
  await host.getByRole('button', { name: 'Collapse PigeonBox' }).click();
  await expect(host.getByRole('button', { name: 'Reopen PigeonBox' })).toBeVisible();
  await expect.poll(async () => Math.round((await shell.boundingBox())!.width)).toBe(144);
  const collapsed = await shell.boundingBox();
  // Observe actual renderer animations, including the content script's isolated
  // world. A main-world prototype spy cannot intercept that world, and a later
  // getAnimations() call can miss a transition that has already finished.
  const cdp = await app.context.newCDPSession(gmail);
  await cdp.send('Animation.enable');
  const handle = await cdp.send('Runtime.evaluate', { expression: 'document.querySelector("[data-gi-ui=workspace]").shadowRoot.querySelector(".gi-shell")' });
  const described = await cdp.send('DOM.describeNode', { objectId: handle.result.objectId });
  const animation: Array<{ id: string; source: { duration: number; iterations: number } }> = [];
  cdp.on('Animation.animationStarted', ({ animation: item }) => { if (item.source.backendNodeId === described.node.backendNodeId) animation.push(item); });
  await host.getByRole('button', { name: 'Reopen PigeonBox' }).click();
  await expect.poll(() => animation.length).toBeGreaterThan(0);
  const resolved = await cdp.send('Animation.resolveAnimation', { animationId: animation[0].id });
  const frames = await cdp.send('Runtime.callFunctionOn', { objectId: resolved.remoteObject.objectId, functionDeclaration: 'function() { return this.effect.getKeyframes(); }', returnByValue: true });
  expect(frames.result.value.some((frame: Keyframe) => String(frame.transform).includes('scale('))).toBe(true);
  expect(animation.every((item) => item.source.duration > 0 && item.source.duration <= 300 && item.source.iterations === 1)).toBe(true);
  await host.getByRole('button', { name: 'Collapse PigeonBox' }).click();
  await host.getByRole('button', { name: 'Reopen PigeonBox' }).click();
  await expect(bird).toHaveAttribute('data-probe', 'same-node');
  await gmail.waitForTimeout(500);
  expect(await shell.evaluate((node) => node.getAnimations().length)).toBe(0);
  const expanded = await shell.boundingBox();
  expect(expanded!.width).toBeGreaterThan(collapsed!.width);
  expect(Math.abs(expanded!.x + expanded!.width - collapsed!.x - collapsed!.width)).toBeLessThan(2);
  await gmail.screenshot({ path: 'test-results/design-gmail-unfolded.png' });
  await gmail.emulateMedia({ reducedMotion: 'reduce' });
  await host.getByRole('button', { name: 'Collapse PigeonBox' }).click();
  await host.getByRole('button', { name: 'Reopen PigeonBox' }).click();
  expect(await shell.evaluate((node) => node.getAnimations().length)).toBe(0);
  await gmail.screenshot({ path: 'test-results/design-gmail-reduced-motion.png' });
  await cdp.detach();
});


test('settled signatures leave Gmail idle and keep composing and resizing responsive', async ({ app }) => {
  await app.page('workspace', true);
  const gmail = await app.gmail();
  const host = gmail.locator('[data-gi-ui="workspace"]');
  const shell = host.locator('.gi-shell');
  const frame = gmail.frameLocator('iframe[title="PigeonBox"]');
  await expect(frame.getByRole('navigation', { name:'Workspace' })).toBeVisible();
  await gmail.waitForTimeout(900);
  const idleAnimations = await frame.locator('body').evaluate(() => document.getAnimations().filter((animation) => animation.playState === 'running').length);
  expect(idleAnimations).toBe(0);
  const profile = await app.context.newCDPSession(gmail);
  await profile.send('Performance.enable');
  const snapshot = async () => Object.fromEntries((await profile.send('Performance.getMetrics')).metrics.map((metric) => [metric.name, metric.value]));
  const before = await snapshot();
  await gmail.waitForTimeout(600);
  const after = await snapshot();
  const started = Date.now();
  await gmail.locator('[aria-label="Message Body"]').pressSequentially(' Edited without leaving Gmail.');
  await expect(gmail.locator('[aria-label="Message Body"]')).toContainText('Edited without leaving Gmail.');
  const typingMs = Date.now() - started;
  const header = host.locator('header');
  await header.press('Shift+ArrowLeft');
  for (const width of [900,1440]) {
    await gmail.setViewportSize({width,height:900});
    await expect.poll(async () => { const bounds = (await shell.boundingBox())!; return bounds.x >= 0 && bounds.x + bounds.width <= width; }).toBe(true);
    expect(await host.count()).toBe(1);
  }
  const result = { synthetic:true, idleAnimations, idleWindowMs:600, idleTaskMs:(after.TaskDuration-before.TaskDuration)*1000, idleScriptMs:(after.ScriptDuration-before.ScriptDuration)*1000, typingMs, heapBytes:after.JSHeapUsedSize };
  await writeFile(test.info().outputPath('design-performance.json'),JSON.stringify(result,null,2));
  await test.info().attach('design-performance.json',{body:JSON.stringify(result,null,2),contentType:'application/json'});
  await profile.detach();
});
