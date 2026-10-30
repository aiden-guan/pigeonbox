import { test, expect } from './fixtures';

test('Correspondence themes preserve readable controls and adapt across desktop and mobile', async ({ page }, testInfo) => {
  await page.goto('/dashboard');
  await page.getByRole('button',{name:'Sign in',exact:true}).click();
  await page.getByLabel('Email').fill('ada@work.test');
  await page.getByRole('button',{name:/sign in/i}).click();
  await expect(page.getByRole('heading',{level:1,name:'Your PigeonBox',exact:true})).toBeVisible();
  for (const theme of ['light','dark'] as const) {
    await page.emulateMedia({colorScheme:theme});
    for (const width of [320,390,900,1280]) {
      await page.setViewportSize({width,height:844});
      expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBe(true);
    }
    const colors=await page.locator('.cp').evaluate((node) => ({color:getComputedStyle(node).color,surface:getComputedStyle(document.body).backgroundColor}));
    expect(colors.color).not.toBe(colors.surface);
    await page.screenshot({path:testInfo.outputPath(`design-server-account-${theme}.png`),fullPage:true});
  }
  await page.setViewportSize({width:390,height:844});
  await page.emulateMedia({reducedMotion:'reduce'});
  await page.getByRole('button',{name:'Open sections'}).click();
  await page.locator('#cp-nav').getByRole('link',{name:'Connected accounts',exact:true}).click();
  await expect(page.getByRole('heading',{level:1,name:'Mail routes',exact:true})).toBeInViewport();
  expect(await page.locator('.cp-side').evaluate((node) => getComputedStyle(node).transitionDuration)).toBe('0s');
  await page.screenshot({path:testInfo.outputPath('design-server-account-mobile.png'),fullPage:true});
});
