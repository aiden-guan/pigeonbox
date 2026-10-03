import { createHash } from 'node:crypto';
import { orbSvg } from '../../apps/extension/src/ui/orb-markup';
import { test, expect } from './fixtures';

test('Loading orb stays alive through a long request, stops on completion, and respects reduced motion', async ({ app }) => {
  const page = await app.page('sidepanel', true);
  await page.getByRole('button', { name: 'Ask', exact: true }).click();
  app.api.askDelay = 3500;
  await page.getByRole('textbox', { name: 'Ask Pigeon', exact: true }).fill('What needs a reply?');
  await page.locator('form').getByRole('button', { name: 'Ask', exact: true }).click();
  const status = page.getByRole('status').filter({ hasText:'Reviewing your mail…' });
  const orb = status.locator('.gi-orb');
  await expect(orb).toHaveAttribute('data-visible', 'true');
  await page.waitForTimeout(800); // The old finite field had already settled here.
  const before = await orb.evaluate(node => node.getAnimations({ subtree:true }).filter(a => a.effect?.getTiming().iterations === Infinity).map(a => Number(a.currentTime)));
  expect(before.length).toBeGreaterThan(0);
  await page.waitForTimeout(120);
  const after = await orb.evaluate(node => node.getAnimations({ subtree:true }).filter(a => a.effect?.getTiming().iterations === Infinity).map(a => Number(a.currentTime)));
  expect(after[0]).toBeGreaterThan(before[0]);
  await page.screenshot({ path:'test-results/orb-cloud-loading.png' });
  await orb.evaluate(node => { (node as HTMLElement).style.transform = 'translateX(-1000px)'; });
  await expect(orb).toHaveAttribute('data-visible', 'false');
  await expect.poll(() => orb.evaluate(node => node.getAnimations({ subtree:true }).every(a => a.playState === 'paused' && !a.pending))).toBe(true);
  const paused = await orb.evaluate(node => node.getAnimations({ subtree:true }).map(a => a.currentTime));
  await page.waitForTimeout(120);
  expect(await orb.evaluate(node => node.getAnimations({ subtree:true }).map(a => a.currentTime))).toEqual(paused);
  await orb.evaluate(node => { (node as HTMLElement).style.transform = ''; });
  await expect(orb).toHaveAttribute('data-visible', 'true');
  await expect.poll(() => orb.evaluate(node => node.getAnimations({ subtree:true }).every(a => a.playState === 'running'))).toBe(true);
  await page.emulateMedia({ reducedMotion:'reduce' });
  await expect(status).toBeVisible();
  expect(await orb.evaluate(node => node.getAnimations({ subtree:true }).length)).toBe(0);
  await page.emulateMedia({ reducedMotion:'no-preference' });
  expect(await orb.evaluate(node => node.getAnimations({ subtree:true }).length)).toBeGreaterThan(0);
  await expect(page.getByText('Maya needs pricing.', { exact:true })).toBeVisible();
  await expect(status).toHaveCount(0);
});

// A speed-only variation fails this test: silhouettes must differ with motion off.
test('Work states have distinct static silhouettes and animate only their visible artwork', async ({ app }) => {
  const page = await app.page('sidepanel');
  const states = ['analyzing', 'searching', 'listening', 'connecting', 'drafting', 'resolving'];
  await page.evaluate(({ artwork, states }) => {
    const gallery = document.createElement('section');
    gallery.id = 'motion-comparison-fixture';
    gallery.style.cssText = 'position:fixed;inset:0;z-index:999;background:var(--pb-surface);display:flex;align-content:flex-start;flex-wrap:wrap;gap:12px;padding:24px';
    for (const state of states) {
      const orb = document.createElement('span');
      orb.className = 'gi-orb';
      orb.style.fontSize = '64px';
      orb.dataset.state = state;
      orb.dataset.visible = 'true';
      orb.innerHTML = artwork;
      gallery.append(orb);
    }
    document.body.append(gallery);
  }, { artwork:orbSvg(), states });
  const motionNames = [];
  for (const state of states) {
    const orb = page.locator(`#motion-comparison-fixture [data-state="${state}"]`);
    const visibleLayers = await orb.evaluate(node => [...node.querySelectorAll('.gi-orb-shape')].filter(layer => Number(getComputedStyle(layer).opacity) > .99).length);
    expect(visibleLayers).toBe(1);
    const names = await orb.evaluate(node => node.getAnimations({ subtree:true }).filter(animation => 'animationName' in animation).map(animation => {
      const target = (animation.effect as KeyframeEffect).target as Element;
      const layer = target.closest('.gi-orb-shape');
      if (!layer || Number(getComputedStyle(layer).opacity) < .99) throw new Error('Hidden orb artwork is animating: ' + JSON.stringify({ state:(node as HTMLElement).dataset.state, name:(animation as CSSAnimation).animationName, target:target.outerHTML, layer:layer?.getAttribute('class'), opacity:layer ? getComputedStyle(layer).opacity : null }));
      return (animation as CSSAnimation).animationName;
    }));
    motionNames.push([...new Set(names)].sort().join(','));
  }
  expect(new Set(motionNames).size).toBe(states.length);
  await page.emulateMedia({ reducedMotion:'reduce' });
  const silhouettes = [];
  for (const state of states) {
    const orb = page.locator(`#motion-comparison-fixture [data-state="${state}"]`);
    expect(await orb.evaluate(node => node.getAnimations({ subtree:true }).length)).toBe(0);
    silhouettes.push(createHash('sha256').update(await orb.screenshot()).digest('hex'));
  }
  expect(new Set(silhouettes).size).toBe(states.length);
  await page.screenshot({ path:'test-results/orb-state-comparison.png' });
});
