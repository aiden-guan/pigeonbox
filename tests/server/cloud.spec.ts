import { test, expect, type Page } from './fixtures';

async function signIn(page: Page) {
  await page.goto('/dashboard');
  await page.getByRole('button', { name: 'Sign in', exact: true }).click();
  await page.getByLabel('Email').fill('ada@work.test');
  await page.getByRole('button', { name: /sign in/i }).click();
  await expect(page.getByRole('heading', { level: 1, name: 'Your PigeonBox', exact: true })).toBeVisible();
  await expect(page.getByRole('heading', { name: 'How your mail is moving', exact: true })).toBeVisible();
  await expect(page.getByRole('heading', { name: 'Focus Queue', exact: true })).toHaveCount(0);
  if (!(await page.getByRole('button', { name: 'Open sections' }).isVisible())) await page.locator('#cp-nav details').evaluate((el) => { (el as HTMLDetailsElement).open = true; });
}

test('Memory keeps one page about you, pages per person, provenance, corrections and forgetting', async ({ page },testInfo) => {
  await signIn(page);
  await page.locator('#cp-nav').getByRole('link', { name: 'Memory', exact: true }).click();
  await expect(page.getByRole('heading', { level: 1, name: 'What Pidgy remembers', exact: true })).toBeVisible();
  // Told to two people, remembered once, on the owner's page with an overview.
  const index = page.getByRole('navigation', { name: 'Memory pages' });
  await expect(index.getByRole('button', { name: /^You/ })).toHaveAttribute('aria-current', 'page');
  await expect(page.getByText('Freshman at UC Berkeley studying business and data science.', { exact: true })).toHaveCount(1);
  await expect(page.locator('.fact-group[open]')).toHaveCount(0);
  await page.locator('.fact-group > summary').filter({hasText:'School'}).click();
  await expect(page.getByText(/^From 2 emails/)).toBeVisible();
  await expect(page.locator('.bp-summary')).toContainText('Multifactor');
  await page.evaluate(() => window.scrollTo(0,0));
  await page.screenshot({path: testInfo.outputPath('memory-desktop.png'),fullPage: true});
  await page.setViewportSize({width: 390,height: 844});
  await expect(page.locator('#cp-side')).not.toBeInViewport();
  await page.evaluate(() => window.scrollTo(0,0));
  expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBe(true);
  await page.screenshot({path: testInfo.outputPath('memory-mobile.png'),fullPage: true});
  await page.setViewportSize({width: 1280,height: 720});
  await index.getByRole('button', { name: /^Professor Smith/ }).click();
  await expect(page.getByRole('heading', { level: 2, name: 'Professor Smith', exact: true })).toBeVisible();
  await page.locator('.fact-group > summary').filter({hasText:'School'}).click();
  await expect(page.getByText('Midterm 2 covers through Chapter 8. Calculators are not allowed.', { exact: true })).toBeVisible();
  await expect(page.getByLabel('Correct this fact')).not.toBeVisible();
  await page.getByText(/^From 1 email/).click();
  const source = page.getByRole('link', { name: 'Midterm 2 Logistics (opens Gmail)', exact: true });
  await expect(source).toBeVisible();
  await expect(source).toHaveAttribute('href', /authuser=ada%40work\.test#all\//);
  await page.getByRole('button', { name: 'Edit', exact: true }).click();
  await page.getByLabel('Correct this fact').fill('Professor Smith confirmed the exam covers through Chapter 9.');
  await page.getByRole('button', { name: 'Save', exact: true }).click();
  await expect(page.getByText(/^Your wording/)).toBeVisible();
  // Search spans every page.
  await page.getByLabel('Find a page or search facts').fill('exam');
  await page.getByLabel('Find a page or search facts').press('Enter');
  await expect(page.getByRole('heading', { level: 2, name: '“exam”' })).toBeVisible();
  await page.getByRole('switch', { name: 'Learn useful personal context', exact: true }).click();
  await expect(page.getByRole('switch', { name: 'Learn useful personal context', exact: true })).not.toBeChecked();
  await expect(page.getByText(/Fast Recall is off/)).toBeVisible();
  // Real-time Pidgy checks: off by default, separate from learning, saved to the server.
  const realtime = page.getByRole('switch', { name: /^Real-time Pidgy checks/ });
  await expect(realtime).not.toBeChecked();
  await expect(page.getByText(/processed ephemerally and is not saved as a memory/)).toBeVisible();
  await realtime.click();
  await expect(page.getByText('Real-time Pidgy checks are on.', { exact: true })).toBeVisible();
  await page.reload();
  await expect(page.getByRole('switch', { name: /^Real-time Pidgy checks/ })).toBeChecked();
  await expect(page.getByRole('switch', { name: 'Learn useful personal context', exact: true })).not.toBeChecked();
  await page.getByRole('navigation', { name: 'Memory pages' }).getByRole('button', { name: /^Professor Smith/ }).click();
  await page.locator('.fact-group > summary').filter({hasText:'School'}).click();
  await expect(page.getByText('Professor Smith confirmed the exam covers through Chapter 9.', { exact: true })).toBeVisible();
  await page.getByRole('button', { name: 'Forget', exact: true }).click();
  await expect(page.getByText('Forgotten. Gmail is unchanged.', { exact: true })).toBeVisible();
  await page.reload();
  await expect(page.getByRole('navigation', { name: 'Memory pages' }).getByRole('button', { name: /^Professor Smith/ })).toHaveCount(0);
});

test('signed out, real dev PKCE sign-in, seeded Overview and navigation', async ({ page }) => {
  await page.goto('/dashboard');
  await expect(page.getByRole('heading', { name: 'Sign in', exact: true })).toBeVisible();
  await signIn(page);
  await expect(page.locator('#cp-nav').getByRole('link', { name: 'Account & server', exact: true })).toBeVisible();
  // No plans on a self-hosted server: nothing to buy, subscribe to or upgrade.
  expect(await page.locator('body').innerText()).not.toMatch(/billing|subscription|upgrade|\bPro\b/i);
  await expect(page.getByRole('link', { name: 'Browser Focus fixture (opens Gmail)', exact: true })).toHaveCount(0);
  for (const section of ['Account & server', 'Connected accounts', 'Approvals', 'Smart Views', 'Automations', 'Contacts', 'Audit & activity', 'Sync & routines', 'Privacy & data', 'API & MCP']) {
    await page.locator('#cp-nav').getByRole('link', { name: section === 'Approvals' ? /^Approvals/ : section, exact: section !== 'Approvals' }).click();
    await expect(page.locator('#view .masthead .mh-path')).toContainText(`/ ${section}`);
    await expect(page.locator('#cp-nav a[aria-current="page"]')).toContainText(section);
    await expect(page.locator('#view .notice-bad')).toHaveCount(0);
    await expect(page.locator('#view .loading')).toHaveCount(0);
  }
});

test('approval edit and placeholder gate, rejection sends nothing', async ({ page, request }) => {
  await signIn(page);
  const before = await (await request.get('/__fixture/stats')).json();
  await page.locator('#cp-nav').getByRole('link', { name: /^Approvals/ }).click();
  await page.getByLabel('Message body').fill('The amount is [CONFIRM PRICE].');
  await page.getByRole('button', { name: 'Approve', exact: true }).click();
  await expect(page.getByText(/Fill in \[CONFIRM PRICE\] before approving/).first()).toBeVisible();
  await page.getByLabel('Message body').fill('Thanks, Lee. I will review the pilot.');
  await page.getByRole('button', { name: 'Reject', exact: true }).click();
  await expect(page.getByText('Rejected. Nothing was done.', { exact: true })).toBeVisible();
  expect(await (await request.get('/__fixture/stats')).json()).toEqual(before);
  await page.getByRole('tab', { name: 'Decided', exact: true }).click();
  await expect(page.getByLabel('Message body')).toBeVisible();
  await expect(page.getByLabel('Message body')).toHaveAttribute('readonly', '');
});

test('Ask Pigeon retrieves seeded mail with valid citations and honest coverage', async ({ page }) => {
  await signIn(page);
  // Ask Pigeon is currently an extension/API surface, without a control-plane
  // form. Exercise the same authenticated browser session and real router.
  const answer = await page.evaluate(async () => {
    const { api } = await import('/lib/session.js');
    return api('/v1/ask', { method: 'POST', body: { query: 'What did Maya ask about slides?' } });
  });
  expect(answer.sources.length).toBeGreaterThan(0);
  expect(answer.answer).toContain('Browser Focus fixture');
  const sourceIds = new Set(answer.sources.map((source: { id: string }) => source.id));
  for (const claim of answer.claims) for (const id of claim.sourceIds) expect(sourceIds.has(id)).toBe(true);
  expect(answer.coverage.note).toBeTruthy();
});

test('automation create, update, and delete through real backend', async ({ page }) => {
  await signIn(page);
  await page.locator('#cp-nav').getByRole('link', { name: 'Automations', exact: true }).click();
  await page.getByLabel('Describe the automation').fill('When a recruiter emails me, label it Recruiting and archive it');
  await page.getByRole('button', { name: 'Preview', exact: true }).click();
  await page.getByLabel('Name', { exact: true }).fill('Browser regression automation');
  await page.getByRole('button', { name: 'Save in Shadow Mode' }).click();
  await expect(page.getByRole('heading', { name: 'Browser regression automation', exact: true })).toBeVisible();
  await page.getByRole('button', { name: 'Pause', exact: true }).click();
  await expect(page.getByRole('button', { name: 'Resume', exact: true })).toBeVisible();
  await page.getByRole('button', { name: 'Delete…', exact: true }).click();
  await page.getByRole('dialog').getByRole('button', { name: 'Delete', exact: true }).click();
  await expect(page.getByRole('heading', { name: 'New automation', exact: true })).toBeVisible();
  await expect(page.getByRole('button', { name: /Browser regression automation/ })).toHaveCount(0);
});

test('preferences persist after reload and privacy inventory loads', async ({ page }) => {
  await signIn(page);
  await page.locator('#cp-nav').getByRole('link', { name: 'Sync & routines', exact: true }).click();
  const zone = page.getByRole('combobox', { name: 'Time zone', exact: true });
  await zone.click();
  await zone.fill('los ang');
  await expect(page.getByRole('option')).toHaveCount(1);
  await page.keyboard.press('Enter');
  await expect(zone).toHaveValue('America/Los Angeles');
  await page.getByRole('button', { name: 'Save preferences' }).click();
  await expect(page.getByText('Preferences saved.', { exact: true })).toBeVisible();
  await page.reload();
  await expect(zone).toHaveValue('America/Los Angeles');
  // Text that is not a zone puts the saved choice back.
  await zone.fill('nowhere');
  await expect(page.getByText('No time zone matches.', { exact: true })).toBeVisible();
  await zone.press('Escape');
  await expect(zone).toHaveValue('America/Los Angeles');
  await page.locator('#cp-nav').getByRole('link', { name: 'Privacy & data', exact: true }).click();
  await expect(page.getByRole('heading', { name: 'What is stored', exact: true })).toBeVisible();
  await expect(page.getByRole('table')).toBeVisible();
});

test('a time zone nobody chose starts from the browser time zone', async ({ browser }) => {
  const context = await browser.newContext({ timezoneId: 'Europe/Berlin' });
  const page = await context.newPage();
  await signIn(page);
  await page.locator('#cp-nav').getByRole('link', { name: 'Sync & routines', exact: true }).click();
  // UTC is the server default, so it reads as never chosen.
  const zone = page.getByRole('combobox', { name: 'Time zone', exact: true });
  await zone.fill('UTC');
  await page.getByRole('option', { name: /^UTC/ }).click();
  await page.getByRole('button', { name: 'Save preferences' }).click();
  await expect(page.getByText('Preferences saved.', { exact: true })).toBeVisible();
  await page.reload();
  await expect(zone).toHaveValue('Europe/Berlin');
  await expect(page.getByText('Detected from this browser. Save preferences to use it.', { exact: true })).toBeVisible();
  await context.close();
});

test('leaving a page with unsaved changes asks first', async ({ page }) => {
  await signIn(page);
  const nav = page.locator('#cp-nav');
  await nav.getByRole('link', { name: 'Sync & routines', exact: true }).click();
  await page.getByLabel('Day starts', { exact: true }).fill('08:00');
  await nav.getByRole('link', { name: 'Privacy & data', exact: true }).click();
  const dialog = page.getByRole('dialog');
  await expect(dialog.getByRole('heading', { name: 'Leave without saving?' })).toBeVisible();
  await dialog.getByRole('button', { name: 'Cancel' }).click();
  await expect(page).toHaveURL(/#preferences$/);
  await expect(page.getByLabel('Day starts', { exact: true })).toHaveValue('08:00');
  // Reloading the browser tab gets the browser's own prompt.
  const prompt = page.waitForEvent('dialog');
  void page.reload().catch(() => {});
  expect((await prompt).type()).toBe('beforeunload');
  await (await prompt).dismiss();
  // Saved changes leave without asking.
  await page.getByRole('button', { name: 'Save preferences' }).click();
  await expect(page.getByText('Preferences saved.', { exact: true })).toBeVisible();
  await nav.getByRole('link', { name: 'Privacy & data', exact: true }).click();
  await expect(page.getByRole('heading', { name: 'What is stored', exact: true })).toBeVisible();
  // Searching is not an unsaved change.
  await nav.getByRole('link', { name: 'Contacts', exact: true }).click();
  await page.getByRole('searchbox', { name: 'Search contacts' }).fill('ada');
  await nav.getByRole('link', { name: 'Privacy & data', exact: true }).click();
  await expect(page.getByRole('heading', { name: 'What is stored', exact: true })).toBeVisible();
});

test('mobile drawer navigates and closes without horizontal overflow', async ({ page }) => {
  await page.setViewportSize({ width: 390, height: 844 });
  await signIn(page);
  await page.getByRole('button', { name: 'Open sections' }).click();
  await expect(page.getByRole('button', { name: 'Open sections' })).toHaveAttribute('aria-expanded', 'true');
  await page.locator('#cp-nav').getByRole('link', { name: 'Connected accounts', exact: true }).click();
  await expect(page.getByRole('heading', { level: 1, name: 'Mail routes', exact: true })).toBeVisible();
  await expect(page.getByRole('button', { name: 'Open sections' })).toHaveAttribute('aria-expanded', 'false');
  expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBe(true);
});

test('API outage is shown, and transient refresh failure preserves session', async ({ page }) => {
  await signIn(page);
  await page.route('**/v1/control/overview', route => route.fulfill({ status: 503, json: { error: { code: 'unavailable', message: 'Test Focus unavailable' } } }));
  await page.reload();
  await expect(page.getByText('Test Focus unavailable', { exact: true })).toBeVisible();
  await expect(page.getByRole('heading', { name: 'How your mail is moving', exact: true })).toHaveCount(0);
  await expect(page.getByRole('button', { name: 'Try again' })).toBeVisible();
  await page.unroute('**/v1/control/overview');
  await page.route('**/v1/connections', route => route.fulfill({ status: 503, json: { error: { code: 'unavailable', message: 'Test service unavailable' } } }));
  await page.locator('#cp-nav').getByRole('link', { name: 'Connected accounts', exact: true }).click();
  await expect(page.getByText('Test service unavailable', { exact: true })).toBeVisible();
  await expect(page.getByRole('button', { name: 'Try again' })).toBeVisible();
  await page.unroute('**/v1/connections');
  await page.route('**/v1/me', route => route.fulfill({ status: 401, json: { error: { code: 'invalid_token' } } }));
  await page.route('**/v1/auth/refresh', route => route.fulfill({ status: 503, json: { error: { code: 'unavailable', message: 'Test refresh unavailable' } } }));
  await page.reload();
  await expect(page.getByText('Test refresh unavailable', { exact: true })).toBeVisible();
  expect(await page.evaluate(() => Boolean(localStorage.getItem('pigeonbox.session')))).toBe(true);
  await page.unroute('**/v1/auth/refresh');
  await page.route('**/v1/auth/refresh', route => route.fulfill({ status: 401, json: { error: { code: 'invalid_token', message: 'Session expired' } } }));
  await page.reload();
  await expect(page.getByRole('heading', { name: 'Sign in', exact: true })).toBeVisible();
  expect(await page.evaluate(() => localStorage.getItem('pigeonbox.session'))).toBeNull();
});

test('concurrent unauthorized requests share one real refresh', async ({ page }) => {
  await signIn(page);
  let refreshes = 0;
  await page.route('**/v1/auth/refresh', async route => { refreshes++; await route.continue(); });
  await page.route('**/v1/me', async route => {
    const response = await route.fetch();
    await route.fulfill({ response });
  });
  const result = await page.evaluate(async () => {
    const session = await import('/lib/session.js');
    const old = session.readSession();
    session.writeSession({ ...old, accessToken: 'expired-test-token' });
    return Promise.allSettled([session.api('/v1/me'), session.api('/v1/capabilities')]).then(results => results.map(r => r.status));
  });
  expect(result).toEqual(['fulfilled', 'fulfilled']);
  expect(refreshes).toBe(1);
});

test('Engagement reports counted detections and never a human open rate', async ({ page }) => {
  await signIn(page);
  await page.locator('#cp-nav').getByRole('link', { name: 'Audit & activity', exact: true }).click();
  await page.getByRole('tab', { name: 'Engagement', exact: true }).click();
  const stats = page.locator('.stats');
  await expect(stats.getByText('Tracked emails', { exact: true })).toBeVisible();
  await expect(stats.locator('.stat', { hasText: 'Open detections' }).locator('.stat-value')).toHaveText('2');
  await expect(stats.locator('.stat', { hasText: 'Emails with an open' }).locator('.stat-value')).toHaveText('1');
  await expect(stats.locator('.stat', { hasText: 'Link clicks' }).locator('.stat-value')).toHaveText('1');
  await expect(stats.locator('.stat', { hasText: 'Median time to first open' }).locator('.stat-value')).toHaveText('15 min');
  await expect(page.locator('#view')).toContainText('not that someone read it');
  await expect(page.locator('#view')).not.toContainText(/likely human/i);
});

test('Overview and Connected accounts show derived health in plain words, and old hashes still land', async ({ page }) => {
  await signIn(page);
  const health = page.locator('.ov-health');
  await expect(health).toBeVisible();
  await expect(health.locator('h2')).toHaveText(/^(Everything is up to date|PigeonBox is catching up|Some background work is delayed|Mail may be out of date|Calendar may be out of date|Reconnect Google|Sync is paused|Mail sync has stopped)$/);
  await expect(health.getByText('Mail', { exact: true })).toBeVisible();
  await expect(health.getByText('Background work', { exact: true })).toBeVisible();
  // Internal reason codes never reach the page.
  expect(await page.locator('#view').innerText()).not.toMatch(/mail_[a-z_]+|analysis_[a-z_]+/);
  await health.getByRole('link', { name: /Details/ }).click();
  await expect(page.locator('#view .masthead .mh-path')).toContainText('/ Connected accounts');
  await expect(page.getByText('Mail health', { exact: true }).first()).toBeVisible();
  // Local-mode and legacy hashes resolve to their server pages.
  await page.goto('/dashboard#general');
  await expect(page).toHaveURL(/#overview$/);
  await page.goto('/dashboard#advanced');
  await expect(page).toHaveURL(/#inbox$/);
});
