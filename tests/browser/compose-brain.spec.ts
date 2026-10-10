import { expect, test } from './fixtures';
import type { Page } from '@playwright/test';

const checks = (calls: Array<{ route: string; body: Record<string, unknown> }>) => calls.filter((call) => call.route === '/v1/compose/check');

async function markedPoint(page: Page, index = 0) {
  const point = await page.evaluate((rangeIndex) => {
    const registry = (CSS as unknown as { highlights: Map<string, Iterable<Range>> }).highlights;
    const range = Array.from(registry.get('pigeonbox-advisory') ?? [])[rangeIndex];
    if (!range) return null;
    const rect = range.getBoundingClientRect();
    return { x: rect.left + Math.max(1, rect.width / 2), y: rect.top + rect.height / 2 };
  }, index);
  if (!point) throw new Error(`Advisory range ${index} was not rendered`);
  return point;
}

async function clickMarkedText(page: Page, index = 0) {
  const point = await markedPoint(page, index);
  await page.mouse.click(point.x, point.y);
}

test('the screenshot calendar denial gets an inline warning before a recipient or subject is added', async ({ app }) => {
  app.api.composeChecks = true;
  app.api.composeAmbient = true;
  await (await app.page('settings', true)).close();
  const page = await app.context.newPage();
  await page.goto(`chrome-extension://${app.id}/brain-fixture.html?empty-compose`);
  const body = page.locator('#brain-compose [aria-label="Message Body"]');
  await body.click();
  await page.keyboard.type('i dont have any meetings left today\n\n--\nAiden Guan');
  const notice = page.locator('[data-gi-ui="brain-notice"]');
  const reference = notice.locator('.pb-reference');
  await expect(reference).toHaveAttribute('data-category', 'Schedule');
  await expect(reference).toHaveCSS('opacity', '0');
  await expect(notice.getByRole('dialog', { name: 'Smart suggestion' })).toBeHidden();
  expect(checks(app.api.calls)).toHaveLength(1);
  expect(checks(app.api.calls)[0]!.body).toMatchObject({ claim: 'i dont have any meetings left today', hint: 'existence', recipientEmails: [], subject: '' });
  expect(JSON.stringify(checks(app.api.calls))).not.toContain('Aiden Guan');
  await clickMarkedText(page);
  await expect(notice).toContainText('You have Meeting with Alex from 12–12:30 PM today.');
  await expect(notice.getByRole('button', { name: 'View source' })).toBeVisible();
  await expect(notice.getByRole('button', { name: /Fix/ })).toHaveCount(0);
  await expect(body).toContainText('i dont have any meetings left today');
});

test('real-time Pidgy check: prose stays local, a busy-calendar claim gets one quiet notice, closing cleans up', async ({ app }) => {
  app.api.composeChecks = true;
  await (await app.page('settings', true)).close();
  const page = await app.context.newPage();
  await page.goto(`chrome-extension://${app.id}/brain-fixture.html`);
  await expect(page.locator('body')).toHaveAttribute('data-brain-checks', '1');
  const body = page.locator('#brain-compose [aria-label="Message Body"]');
  const notice = page.locator('[data-gi-ui="brain-notice"]');

  // Ordinary prose: no Brain request of any kind.
  const preferenceReads = () => app.api.calls.filter((call) => call.route === '/v1/preferences').length;
  const readsBefore = preferenceReads();
  await body.click();
  await page.keyboard.type('Thanks for the notes on the deck, really helpful.');
  await page.waitForTimeout(1_800);
  expect(checks(app.api.calls)).toHaveLength(0);
  expect(preferenceReads()).toBe(readsBefore);

  // An availability claim while the (mocked, calendar-backed) Cloud says busy: the time gets a quiet mark, no card.
  await page.keyboard.type(" I'm free tomorrow at 3.");
  const reference = notice.locator('.pb-reference');
  await expect(reference).toHaveAttribute('data-category', 'Schedule');
  await expect(reference).toHaveCSS('opacity', '0');
  const popover = notice.getByRole('dialog', { name: 'Smart suggestion' });
  await expect(popover).toBeHidden();
  expect(await page.evaluate(() => (CSS as unknown as { highlights: Map<string, unknown> }).highlights.has('pigeonbox-advisory'))).toBe(true);
  // The body did not grow and nothing was written into Gmail's editor.
  expect(await body.evaluate((node) => node.querySelectorAll('[data-gi-ui]').length)).toBe(0);
  await clickMarkedText(page);
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
  await page.locator('#brain-compose [aria-label="Message Body"]').click();
  await page.keyboard.type("I'm free tomorrow at 3.");
  await page.waitForTimeout(2_000);
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
  await expect(notice.locator('.pb-reference')).toHaveAttribute('data-category', 'Schedule');
  // Not presented: Tab is not taken.
  const tabbed = await body.evaluate((node) => {
    const event = new KeyboardEvent('keydown', { key: 'Tab', bubbles: true, cancelable: true });
    node.dispatchEvent(event);
    return event.defaultPrevented;
  });
  expect(tabbed).toBe(false);
  await clickMarkedText(page);
  await expect(notice.getByRole('dialog', { name: 'Smart suggestion' })).toBeVisible();
  await page.keyboard.press('Tab');
  await expect(body).toHaveText("Hi Alex. I'm free tomorrow at 4:30. Talk soon");
  await expect(notice).toHaveCount(0, { timeout: 4_000 });
  // The edit is a normal one: Gmail's undo takes it back.
  await page.keyboard.press(process.platform === 'darwin' ? 'Meta+z' : 'Control+z');
  await expect(body).toHaveText("Hi Alex. I'm free tomorrow at 3. Talk soon");
  // Typing elsewhere after Escape: the dismissed advice does not return.
  await expect(notice.locator('.pb-reference')).toHaveAttribute('data-category', 'Schedule', { timeout: 8_000 });
  await notice.locator('.pb-reference').focus();
  await page.keyboard.press('Enter');
  await page.keyboard.press('Escape');
  await expect(notice).toHaveCount(0);
  await page.keyboard.type(' Cheers.');
  await page.waitForTimeout(1_500);
  await expect(notice).toHaveCount(0);
});

test('ambient Brain underlines the exact self-context phrase and keeps the advisory closed until requested', async ({ app }) => {
  app.api.composeChecks=true; app.api.composeAmbient=true;
  await (await app.page('settings',true)).close();
  const page=await app.context.newPage();await page.goto(`chrome-extension://${app.id}/brain-fixture.html`);
  const body=page.locator('#brain-compose [aria-label="Message Body"]');
  await body.click();await page.keyboard.type("i don't think i have any upcoming hackathons");
  const notice=page.locator('[data-gi-ui="brain-notice"]');await expect(notice.locator('.pb-reference')).toHaveAttribute('data-category', 'Context');
  await expect(notice.getByRole('dialog',{name:'Smart suggestion'})).toBeHidden();
  const selected=await page.evaluate(()=>{
    const registry=(CSS as unknown as {highlights:Map<string,Iterable<Range>>}).highlights;
    return Array.from(registry.get('pigeonbox-advisory') ?? []).map(range=>range.toString());
  });
  expect(selected).toEqual(['any upcoming hackathons']);
  expect(checks(app.api.calls)).toHaveLength(1);
  expect(checks(app.api.calls)[0]!.body).toMatchObject({claim:"i don't think i have any upcoming hackathons",hint:'existence'});
  await clickMarkedText(page);await expect(notice).toContainText('You have CalHacks Oct 23–25.');
  await expect(notice.getByRole('button',{name:'View source'})).toBeVisible();
  await expect(notice.getByRole('button',{name:/Fix/})).toHaveCount(0);
  expect(await body.evaluate(node=>node.querySelectorAll('[data-gi-ui]').length)).toBe(0);
});

test('multiple compose findings stay attached to their own text and open one card at a time', async ({ app }) => {
  app.api.composeChecks = true; app.api.composeAmbient = true;
  await (await app.page('settings', true)).close();
  const page = await app.context.newPage(); await page.goto(`chrome-extension://${app.id}/brain-fixture.html?empty-compose`);
  const body = page.locator('#brain-compose [aria-label="Message Body"]');
  await body.click();
  await page.keyboard.type("I don't have any meetings left today. I don't think I have any upcoming hackathons.");

  const hosts = page.locator('[data-gi-ui="brain-notice"]');
  await expect(hosts).toHaveCount(2, { timeout: 18_000 });
  await expect.poll(() => hosts.evaluateAll(items => items.map(item => (item.shadowRoot!.querySelector('.pb-reference') as HTMLButtonElement).dataset.category).sort())).toEqual(['Context', 'Schedule']);
  await expect.poll(() => checks(app.api.calls).length).toBe(2);
  const rangeTexts = await page.evaluate(() => Array.from(((CSS as unknown as { highlights: Map<string, Iterable<Range>> }).highlights).get('pigeonbox-advisory') ?? []).map(range => range.toString()));
  expect(rangeTexts).toHaveLength(2);

  const labels = await hosts.evaluateAll(items => items.map(item => (item.shadowRoot!.querySelector('.pb-reference') as HTMLButtonElement).dataset.category));
  const scheduleIndex = labels.indexOf('Schedule');
  const contextIndex = labels.indexOf('Context');
  const schedule = hosts.nth(scheduleIndex);
  const context = hosts.nth(contextIndex);
  await schedule.locator('.pb-reference').focus();
  await page.keyboard.press('Enter');
  await expect(schedule.locator('.pb-pop')).toHaveAttribute('data-shown', '');
  await expect(schedule).toContainText('Meeting with Alex');
  await expect(page.locator('[data-gi-ui="brain-notice"] .pb-pop[data-shown]')).toHaveCount(1);

  await context.locator('.pb-reference').focus();
  await page.keyboard.press('Enter');
  await expect(context.locator('.pb-pop')).toHaveAttribute('data-shown', '');
  await expect(context).toContainText('CalHacks Oct 23–25');
  await expect(page.locator('[data-gi-ui="brain-notice"] .pb-pop[data-shown]')).toHaveCount(1);

  const reference = context.locator('.pb-reference');
  const light = await reference.evaluate(element => getComputedStyle(element).color);
  await context.evaluate(element => { (element as HTMLElement).dataset.pbTheme = 'dark'; });
  const dark = await reference.evaluate(element => getComputedStyle(element).color);
  expect(dark).not.toBe(light);
  await context.evaluate(element => { (element as HTMLElement).dataset.pbTheme = 'light'; });

  // A live resize reflows the clause and repositions its contextual marker.
  await context.locator('.pb-reference').click();
  const positions = () => hosts.evaluateAll(items => items.map(item => {
    const button = item.shadowRoot!.querySelector<HTMLButtonElement>('.pb-reference')!;
    const rect = button.getBoundingClientRect();
    return { category: button.dataset.category, hidden: button.hidden, left: rect.left, top: rect.top };
  }));
  const beforeResize = await positions();
  await page.locator('#brain-compose').evaluate(element => { (element as HTMLElement).style.width = '360px'; });
  await expect.poll(async () => {
    const after = await positions();
    return after.every(item => !item.hidden) && after.some(item => Math.abs(item.top - beforeResize.find(previous => previous.category === item.category)!.top) > 4);
  }).toBe(true);

  // Scrolling the Gmail message area hides an off-screen marker and brings it
  // back beside its original claim when that text re-enters the viewport.
  await body.evaluate(node => {
    for (let index = 0; index < 24; index += 1) node.append(document.createElement('br'));
    node.dispatchEvent(new Event('input', { bubbles: true }));
  });
  await expect.poll(async () => (await positions()).every(item => !item.hidden)).toBe(true);
  await page.locator('.M9').evaluate(node => { (node as HTMLElement).scrollTop = 96; });
  await expect.poll(async () => (await positions()).every(item => item.hidden)).toBe(true);
  await page.locator('.M9').evaluate(node => { (node as HTMLElement).scrollTop = 0; });
  await expect.poll(async () => (await positions()).some(item => !item.hidden)).toBe(true);
});


test('smart autofill stays outside the editor, Tab inserts one undoable suffix, and Escape dismisses', async ({ app }, testInfo) => {
  app.api.composeChecks = false;
  app.api.composeCompletion = ' where I made 35k in revenue.';
  await (await app.page('settings', true)).close();
  const page = await app.context.newPage(); await page.goto(`chrome-extension://${app.id}/brain-fixture.html?empty-compose`);
  const body = page.locator('#brain-compose [aria-label="Message Body"]');
  // Gmail's line box is taller than its text bounds. Positioning the whole
  // overlay at a caret rect's top puts its glyphs below the writer's glyphs.
  await body.evaluate(node => { (node as HTMLElement).style.font = '13px/20px Arial'; });
  await body.click(); await page.keyboard.type('I used to have a paid community');
  const ghost = page.locator('[data-gi-ui="brain-completion"]');
  await expect(ghost.getByRole('button', {name:'Accept smart autofill'})).toBeVisible();
  await expect(ghost).toContainText('where I made 35k in revenue.');
  await expect(body).toHaveText('I used to have a paid community');
  expect(await body.locator('[data-gi-ui]').count()).toBe(0);
  expect(checks(app.api.calls)).toHaveLength(1);
  expect(checks(app.api.calls)[0]!.body).toMatchObject({includeCompletion:true,claim:'I used to have a paid community'});
  const geometry = await page.evaluate(() => {
    const shadow = document.querySelector('[data-gi-ui="brain-completion"]')!.shadowRoot!;
    const ghost = shadow.querySelector('.ghost')!.getBoundingClientRect();
    const editorNode = document.querySelector('#brain-compose [aria-label="Message Body"]')!;
    const editor = editorNode.getBoundingClientRect();
    const typed = document.createRange(); typed.selectNodeContents(editorNode);
    const suggested = document.createRange(); suggested.selectNodeContents(shadow.querySelector('.suffix')!);
    const typedBounds = typed.getBoundingClientRect(), suggestedBounds = suggested.getBoundingClientRect();
    return {within:ghost.right<=editor.right+1 && ghost.top>=editor.top, caretAtEnd:document.getSelection()?.isCollapsed,
      baselineDelta:Math.abs(suggestedBounds.bottom-typedBounds.bottom)};
  });
  expect(geometry.within).toBe(true); expect(geometry.caretAtEnd).toBe(true);
  expect(geometry.baselineDelta).toBeLessThanOrEqual(0.5);
  await page.locator('#brain-compose').screenshot({ path: testInfo.outputPath('pidgy-smart-compose.png') });
  await page.keyboard.press('Tab');
  await expect(body).toHaveText('I used to have a paid community where I made 35k in revenue.');
  await expect(ghost).toHaveCount(0);
  await page.keyboard.press(process.platform==='darwin'?'Meta+z':'Control+z');
  await expect(body).toHaveText('I used to have a paid community');
  await expect(ghost.getByRole('button',{name:'Accept smart autofill'})).toBeVisible();
  await page.keyboard.press('Escape'); await expect(ghost).toHaveCount(0);
  await page.keyboard.type(' '); await page.waitForTimeout(1200); await expect(ghost).toHaveCount(0);
  await page.getByRole('button',{name:'Close compose'}).click();
  await expect(page.locator('body')).toHaveAttribute('data-brain-checks','0');
});

test('a changed prefix invalidates delayed autofill and selected text keeps normal Tab behavior', async ({app}) => {
  app.api.composeChecks = true; app.api.composeCompletion=' where I made 35k in revenue.'; app.api.composeDelayMs=700;
  await (await app.page('settings',true)).close();
  const page=await app.context.newPage(); await page.goto(`chrome-extension://${app.id}/brain-fixture.html`);
  const body=page.locator('#brain-compose [aria-label="Message Body"]');
  await body.click(); await page.keyboard.type('I used to have a paid community');
  await page.waitForTimeout(1000); await page.keyboard.type(' but closed it.');
  await page.waitForTimeout(1700);
  await expect(page.locator('[data-gi-ui="brain-completion"]')).toHaveCount(0);
  await page.keyboard.press(process.platform==='darwin'?'Meta+a':'Control+a');
  const intercepted=await body.evaluate(node=>{const event=new KeyboardEvent('keydown',{key:'Tab',bubbles:true,cancelable:true});node.dispatchEvent(event);return event.defaultPrevented;});
  expect(intercepted).toBe(false);
});

test('autofill shares the caret text baseline and font inside a formatted Gmail span', async ({app}) => {
  app.api.composeChecks = false; app.api.composeCompletion = ' that generated $35k in revenue.';
  await (await app.page('settings',true)).close();
  const page = await app.context.newPage(); await page.goto(`chrome-extension://${app.id}/brain-fixture.html?empty-compose`);
  const body = page.locator('#brain-compose [aria-label="Message Body"]');
  await body.evaluate(node => {
    const span = document.createElement('span'); span.textContent = 'I ran a paid';
    span.style.font = 'italic 700 18px/30px Georgia'; span.style.letterSpacing = '0.3px';
    node.replaceChildren(span); (node as HTMLElement).focus();
    const range = document.createRange(); range.selectNodeContents(span); range.collapse(false);
    const selection = document.getSelection()!; selection.removeAllRanges(); selection.addRange(range);
  });
  await page.keyboard.type(' community');
  const ghost = page.locator('[data-gi-ui="brain-completion"]');
  await expect(ghost.getByRole('button',{name:'Accept smart autofill'})).toBeVisible();
  const geometry = await page.evaluate(() => {
    const original = document.querySelector('#brain-compose [aria-label="Message Body"] span')!;
    const suffix = document.querySelector('[data-gi-ui="brain-completion"]')!.shadowRoot!.querySelector('.suffix')!;
    const typed = document.createRange(); typed.selectNodeContents(original);
    const suggested = document.createRange(); suggested.selectNodeContents(suffix);
    const before = getComputedStyle(original), after = getComputedStyle(suffix);
    const typography = (style: CSSStyleDeclaration) => ({family:style.fontFamily,size:style.fontSize,weight:style.fontWeight,style:style.fontStyle,spacing:style.letterSpacing});
    return { delta:Math.abs(typed.getBoundingClientRect().bottom-suggested.getBoundingClientRect().bottom),
      original:typography(before), suggestion:typography(after) };
  });
  expect(geometry.delta).toBeLessThanOrEqual(0.5); expect(geometry.suggestion).toEqual(geometry.original);
});


test('delayed autofill keeps the untyped suffix when the writer continues its exact beginning', async ({ app }) => {
  app.api.composeChecks = false; app.api.composeCompletion = ' where I made 35k in revenue.';
  app.api.composeDelayMs = 1_000;
  await (await app.page('settings', true)).close();
  const page = await app.context.newPage(); await page.goto(`chrome-extension://${app.id}/brain-fixture.html?empty-compose`);
  const body = page.locator('#brain-compose [aria-label="Message Body"]');
  await body.click(); await page.keyboard.type('I used to have a paid community');
  await expect.poll(() => checks(app.api.calls).length).toBe(1);
  await page.keyboard.type(' where I made');
  const ghost = page.locator('[data-gi-ui="brain-completion"]');
  await expect(ghost.getByRole('button', { name: 'Accept smart autofill' })).toBeVisible();
  await expect(ghost).toContainText('35k in revenue.');
  await expect(body).toHaveText('I used to have a paid community where I made');
  await page.keyboard.press('Tab');
  await expect(body).toHaveText('I used to have a paid community where I made 35k in revenue.');
  expect(checks(app.api.calls)).toHaveLength(1);
});


test('ordinary request autofill needs no saved fact and preserves Tab, undo and dismissal', async ({ app }, testInfo) => {
  app.api.composeChecks = false; app.api.composeCompletion = ' the latest version when you have a chance?'; app.api.composeCompletionKind = 'writing';
  await (await app.page('settings', true)).close();
  const page = await app.context.newPage(); await page.goto(`chrome-extension://${app.id}/brain-fixture.html?empty-compose`);
  const body = page.locator('#brain-compose [aria-label="Message Body"]');
  await body.click(); await page.keyboard.type('Could you please send me');
  const ghost = page.locator('[data-gi-ui="brain-completion"]');
  await expect(ghost.getByRole('button', { name: 'Accept smart autofill' })).toBeVisible();
  await expect(ghost.locator('.source, img, .gi-pigeon')).toHaveCount(0);
  await expect(body).toHaveText('Could you please send me');
  const tracking = page.locator('#brain-compose [data-gi-ui="track-toggle"]');
  await expect(tracking).toHaveText('Tracking on');
  // Reminder cleanup must not remove the tracking badge's existing ring.
  expect(await tracking.evaluate(node => getComputedStyle(node, '::before').content)).toBe('""');
  await tracking.click(); await expect(page.locator('[data-gi-ui="track-menu"]')).toBeVisible(); await tracking.click();
  await body.click(); await page.keyboard.press('End');
  await body.evaluate(node => node.dispatchEvent(new Event('input', { bubbles: true })));
  await expect(ghost).toBeVisible();
  await page.locator('#brain-compose').screenshot({ path: testInfo.outputPath('clean-autofill.png') });
  await page.keyboard.press('Tab'); await expect(body).toHaveText('Could you please send me the latest version when you have a chance?');
  await page.keyboard.press(process.platform === 'darwin' ? 'Meta+z' : 'Control+z'); await expect(body).toHaveText('Could you please send me');
  await expect(ghost).toBeVisible(); await page.keyboard.press('Escape'); await expect(ghost).toHaveCount(0);
});

test('writing suggestion is keyboard reachable, uses a quiet issue icon, and applies an undoable edit', async ({ app }, testInfo) => {
  const claim = 'I just wanted to ask if you could send the proposal in order to review it before Friday.';
  const text = 'I wanted to ask if you could send the proposal to review it before Friday.';
  app.api.composeChecks = true; app.api.composeWriting = text;
  await (await app.page('settings', true)).close();
  const page = await app.context.newPage(); await page.goto(`chrome-extension://${app.id}/brain-fixture.html?empty-compose`);
  const body = page.locator('#brain-compose [aria-label="Message Body"]'); await body.click(); await page.keyboard.type(claim);
  await expect.poll(() => checks(app.api.calls).length).toBe(1);
  const notice = page.locator('[data-gi-ui="brain-notice"]'); const reference = notice.getByRole('button', { name: /Wording:/ });
  await expect(reference).toHaveAttribute('tabindex', '0'); await expect(reference.locator('svg')).toHaveCount(1);
  await reference.focus(); await page.keyboard.press('Enter');
  await expect(notice.getByRole('dialog', { name: 'Smart suggestion' })).toBeVisible();
  await expect(notice.locator('img, .gi-pigeon')).toHaveCount(0); await expect(notice.getByRole('button', { name: 'View source' })).toHaveCount(0);
    const overlaps = await page.evaluate(() => {
    const pop = document.querySelector('[data-gi-ui="brain-notice"]')!.shadowRoot!.querySelector('.pb-pop')!.getBoundingClientRect();
    return Array.from(document.querySelectorAll('#brain-compose button, #brain-compose [data-gi-ui="track-toggle"]')).filter(control => {
      const box = control.getBoundingClientRect();
      return box.width && box.height && !(pop.right <= box.left || pop.left >= box.right || pop.bottom <= box.top || pop.top >= box.bottom);
    }).length;
  });
  expect(overlaps).toBe(0);
  await page.locator('body').screenshot({ path: testInfo.outputPath('clean-smart-suggestion.png') });
  await notice.getByRole('button', { name: /Fix/ }).click(); await expect(body).toHaveText(text);
  await page.keyboard.press(process.platform === 'darwin' ? 'Meta+z' : 'Control+z'); await expect(body).toHaveText(claim);
});


test('autofill undo preserves a freshly typed prefix without intervening focus changes', async ({ app }) => {
  app.api.composeChecks = false; app.api.composeCompletion = ' the details?'; app.api.composeCompletionKind = 'writing';
  await (await app.page('settings', true)).close();
  const page = await app.context.newPage(); await page.goto(`chrome-extension://${app.id}/brain-fixture.html?empty-compose`);
  const body = page.locator('#brain-compose [aria-label="Message Body"]');
  await body.click(); await page.keyboard.type('Could you please send me');
  const ghost = page.locator('[data-gi-ui="brain-completion"]');
  await expect(ghost.getByRole('button', { name: 'Accept smart autofill' })).toBeVisible();
  await page.keyboard.press('Tab');
  await expect(body).toHaveText('Could you please send me the details?');
  await page.keyboard.press(process.platform === 'darwin' ? 'Meta+z' : 'Control+z');
  await expect(body).toHaveText('Could you please send me');
});
