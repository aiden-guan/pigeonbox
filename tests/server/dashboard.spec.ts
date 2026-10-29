import { test, expect, type Page } from './fixtures';

async function signIn(page: Page, hash = '', email = 'ada@work.test') {
  await page.goto(`/dashboard${hash}`);
  await page.getByRole('button', { name: 'Sign in', exact: true }).click();
  await page.getByLabel('Email').fill(email);
  await page.getByRole('button', { name: /sign in/i }).click();
  await expect(page.locator('#view .page')).toBeVisible();
}

test('Overview status and route come only from real state, and a broken route is called out', async ({ page }) => {
  await signIn(page);
  // Derived server health leads when no connection needs a person.
  await expect(page.locator('.dispatch-status')).toContainText(/Everything is up to date|PigeonBox is catching up/);
  await expect(page.locator('#cp-status')).toContainText(/clear/i);
  // The same account, as Google stops accepting PigeonBox's access.
  await page.route('**/v1/connections', async (route) => {
    const response = await route.fetch();
    const data = await response.json();
    data.accounts = data.accounts.map((account: { status: string; sync: Record<string, unknown> }) => ({ ...account, status: 'needs_reauth', sync: { ...account.sync, phase: 'needs_reauth' } }));
    await route.fulfill({ response, json: data });
  });
  await page.reload();
  await expect(page.locator('.dispatch-status')).toContainText('1 route needs attention');
  await expect(page.locator('.notice-bad')).toContainText('Reconnect needed');
  await expect(page.locator('.route-stop[data-state="bad"]')).toContainText('Needs attention');
  await expect(page.locator('canvas.ov-art')).toHaveAttribute('data-tone', 'attention');
  await expect(page.locator('#cp-status')).toContainText('1 route needs attention');
});

// What servedCapabilities() grants with DATABASE_URL but without the Google settings.
const DATABASE_ONLY = ['cloud_ai', 'cloud_tracking', 'ask_inbox', 'cloud_team', 'cloud_mcp'];

test('a server without the Google settings locks those sections and names the settings that turn them on', async ({ page }) => {
  await page.route('**/v1/capabilities', (route) => route.fulfill({ json: { capabilities: DATABASE_ONLY } }));
  await signIn(page, '#automations');
  await expect(page.getByRole('heading', { name: 'Automations isn’t set up on this server.' })).toBeVisible();
  await expect(page.locator('#view')).toContainText('need the Google settings and DATABASE_URL on this server');
  await expect(page.locator('#view')).not.toContainText(/subscri|upgrade|billing/i);
  await expect(page.locator('#view').getByRole('link', { name: 'Account & server', exact: true })).toHaveAttribute('href', '#account');
  await expect(page.locator('#cp-nav a[data-section="automations"]')).toHaveAttribute('data-locked', '');
  await expect(page.locator('#cp-nav a[data-section="automations"]')).toHaveAttribute('title', 'Not set up on this server');
  await expect(page.locator('#cp-nav a[data-section="memory"]')).not.toHaveAttribute('data-locked', '');
  await expect(page.locator('#cp-nav a[data-section="team"]')).not.toHaveAttribute('data-locked', '');
});

test('Account & server shows the account, what the server offers and the setting each missing feature needs', async ({ page }) => {
  await page.route('**/v1/account/entitlements', async (route) => {
    const response = await route.fetch();
    const data = await response.json();
    await route.fulfill({ response, json: { ...data, capabilities: data.capabilities.filter((capability: string) => capability !== 'cloud_documents') } });
  });
  await signIn(page, '#account');
  await expect(page.getByRole('heading', { level: 1, name: 'Your server', exact: true })).toBeVisible();
  await expect(page.locator('#view .masthead .mh-path')).toContainText('/ Account & server');
  const host = new URL(page.url()).host;
  await expect(page.locator('.receipt')).toContainText(host);
  await expect(page.locator('.receipt')).toContainText('ada@work.test');
  const offered = page.locator('section', { has: page.getByRole('heading', { name: 'What this server offers' }) });
  await expect(offered.getByText('Always-on mail sync', { exact: true })).toBeVisible();
  await expect(offered.getByText('Tracked documents', { exact: true })).toHaveCount(0);
  const off = page.locator('section', { has: page.getByRole('heading', { name: 'Not set up on this server' }) });
  await expect(off).toContainText('Tracked documents');
  await expect(off).toContainText('DOCUMENTS_BUCKET');
  await expect(page.getByRole('button', { name: 'Delete account…' })).toBeVisible();
  await expect(page.locator('#cp-host')).toHaveText(host);
  expect(await page.locator('body').innerText()).not.toMatch(/billing|subscription|upgrade|\bPro\b|\bFree\b/i);
});

test('an account the server no longer allows can sign out from the error', async ({ page }) => {
  await signIn(page);
  const message = 'This account is not allowed on this PigeonBox server. Ask the server owner to add your address to ALLOWED_EMAILS.';
  await page.route('**/v1/me', (route) => route.fulfill({ status: 403, json: { error: { code: 'forbidden', message } } }));
  await page.reload();
  await expect(page.getByText(message, { exact: true })).toBeVisible();
  await page.getByRole('button', { name: 'Sign out', exact: true }).last().click();
  await expect(page.getByRole('heading', { name: 'Sign in', exact: true })).toBeVisible();
  expect(await page.evaluate(() => localStorage.getItem('pigeonbox.session'))).toBeNull();
});

test('rail, tabs and dialogs work from the keyboard', async ({ page }) => {
  await signIn(page, '#activity');
  await expect(page.locator('#cp-nav a[aria-current="page"]')).toHaveText('Audit & activity');
  await expect(page.locator('.cp-nav-marker')).toHaveClass(/is-on/);
  const first = page.getByRole('tab').first();
  await first.focus();
  await page.keyboard.press('ArrowRight');
  await expect(page.getByRole('tab').nth(1)).toBeFocused();
  await expect(page.getByRole('tab').nth(1)).toHaveAttribute('aria-selected', 'true');
  await page.keyboard.press('End');
  await expect(page.getByRole('tab', { name: 'Audit log' })).toHaveAttribute('aria-selected', 'true');
  await page.locator('#cp-nav').getByRole('link', { name: 'Account & server', exact: true }).click();
  const remove = page.getByRole('button', { name: 'Delete account…' });
  await remove.focus();
  await page.keyboard.press('Enter');
  await expect(page.getByRole('dialog')).toBeVisible();
  await page.keyboard.press('Escape');
  await expect(page.getByRole('dialog')).toHaveCount(0);
  await expect(remove).toBeFocused();
});

test('reduced motion keeps every state readable without decorative motion', async ({ page }) => {
  await page.emulateMedia({ reducedMotion: 'reduce' });
  await signIn(page);
  await expect(page.locator('.dispatch-status .pidgy')).toHaveCSS('animation-name', 'none');
  await expect(page.locator('canvas.ov-art')).toHaveAttribute('data-mounted', '1');
  await page.locator('#cp-nav').getByRole('link', { name: 'Privacy & data', exact: true }).click();
  await expect(page.getByRole('heading', { level: 1, name: 'What your server keeps' })).toBeVisible();
  expect(await page.locator('.mh-rule').evaluate((node) => getComputedStyle(node).animationName)).toBe('none');
});

test('returning from Google marks the route once, with a note that says what happened', async ({ page }) => {
  await signIn(page);
  await page.goto('/dashboard?connected=1');
  await expect(page.getByRole('heading', { level: 1, name: 'Mail routes' })).toBeVisible();
  await expect(page.getByText('Connected. PigeonBox is doing the first sync now; this page updates as it goes.')).toBeVisible();
  await expect(page.locator('.route-card .celebration')).toHaveCount(1);
  await expect(page.locator('.route-card .celebration')).toHaveCount(0, { timeout: 6_000 });
  expect(new URL(page.url()).search).toBe('');
});

test('long addresses and mobile layouts never scroll sideways', async ({ page }) => {
  const long = 'a.very.long.mailbox.name.for.testing.wrapping.behaviour@an-unusually-long-subdomain.example-company.test';
  await page.route('**/v1/connections', async (route) => {
    const response = await route.fetch();
    const data = await response.json();
    data.accounts = data.accounts.map((account: object) => ({ ...account, email: long }));
    await route.fulfill({ response, json: data });
  });
  await page.setViewportSize({ width: 390, height: 844 });
  await signIn(page, '#connections');
  await expect(page.getByRole('heading', { name: long })).toBeVisible();
  for (const hash of ['#connections', '#overview', '#account', '#activity', '#approvals']) {
    await page.evaluate((target) => (location.hash = target), hash);
    await expect(page.locator('#view .loading')).toHaveCount(0);
    expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBe(true);
  }
});

for (const marker of ['?', '#']) {
  test(`signup-disabled callback in ${marker === '?' ? 'query' : 'fragment'} says the server takes no new accounts without exposing provider details`, async ({ page }) => {
    await page.goto(`/dashboard${marker}error=access_denied&error_code=signup_disabled&error_description=PRIVATE_PROVIDER_CANARY`);
    const notice = page.locator('#view .notice');
    await expect(notice.getByText('This server isn’t taking new accounts', { exact: true })).toBeVisible();
    await expect(notice).toContainText('ask whoever runs the server for access');
    // Nowhere else to send people: there is no hosted service to join.
    await expect(notice.getByRole('link')).toHaveCount(0);
    await expect(page.getByRole('button', { name: 'Sign in', exact: true })).toBeVisible();
    expect(await page.locator('body').innerText()).not.toContain('PRIVATE_PROVIDER_CANARY');
    expect(new URL(page.url()).search).toBe('');
    expect(new URL(page.url()).hash).toBe('');
  });
}

test('cancelled sign-in has a recoverable notice and cleans callback details', async ({ page }) => {
  await page.goto('/dashboard?error=access_denied&error_description=PRIVATE_PROVIDER_CANARY&state=PRIVATE_STATE_CANARY');
  await expect(page.getByText('Sign-in was not completed', { exact: true })).toBeVisible();
  await expect(page.getByRole('button', { name: 'Sign in', exact: true })).toBeVisible();
  expect(await page.locator('body').innerText()).not.toContain('PRIVATE_PROVIDER_CANARY');
  expect(new URL(page.url()).search).toBe('');
});

test('Mailing lists: one click leaves a list, and lists without one-click get their last step', async ({ page }) => {
  await signIn(page, '#subscriptions');
  const subscribed = page.locator('section', { has: page.getByRole('heading', { name: 'Subscribed' }) });
  await expect(subscribed.getByText('Shop News')).toBeVisible();
  await subscribed.locator('li', { hasText: 'Shop News' }).getByRole('button', { name: 'Unsubscribe' }).click();
  await expect(page.locator('.toast')).toContainText('Unsubscribed from Shop News');
  await page.getByRole('button', { name: 'Select all' }).click();
  await page.getByRole('button', { name: 'Unsubscribe from 2 lists' }).click();
  await expect(page.getByText('No other mailing lists.')).toBeVisible();
  const left = page.locator('section', { has: page.getByRole('heading', { name: 'Unsubscribed' }) });
  await expect(left.getByRole('link', { name: 'Open unsubscribe page' })).toHaveAttribute('href', 'https://medium.test/settings/email');
  await expect(left.getByRole('link', { name: 'Send unsubscribe email' })).toHaveAttribute('href', /mail\.google\.com\/mail\/.*to=leave%40running\.test/);
  await expect(left.locator('li', { hasText: 'Shop News' })).toContainText('Unsubscribed');
});

test('memory groups start closed and natural-language asks and updates stay in place', async ({page}, testInfo) => {
  await signIn(page, '#memory');
  await expect(page.locator('.fact-group[open]')).toHaveCount(0);
  const work = page.locator('.fact-group > summary').filter({hasText:'Work & plans'});
  await expect(work).toBeVisible();
  await work.click();
  await expect(page.getByText('Built PigeonBox, an AI email copilot.', {exact:true})).toBeVisible();
  const input = page.getByLabel('Ask or update memory');
  await input.fill('What do you remember about me?');
  await input.press('Enter');
  await expect(page.locator('.memory-answer')).toContainText('Berkeley');
  await input.fill('Remember: I prefer concise replies and no em dashes.');
  await page.getByRole('button', {name:'Send',exact:true}).click();
  await expect(page.locator('.memory-answer')).toContainText('Remembered:');
  await expect(page.locator('.fact-group[open]')).toHaveCount(1);
  await page.locator('.fact-group > summary').filter({hasText:'Preferences'}).click();
  await expect(page.locator('.brain-page').getByText('I prefer concise replies and no em dashes.',{exact:true})).toBeVisible();
  await page.emulateMedia({ reducedMotion: 'reduce' });
  for (const width of [1280,390]) {
    await page.setViewportSize({width,height:844});
    if (width < 800) await expect(page.locator('#cp-side')).not.toBeInViewport();
    expect(await page.evaluate(()=>document.documentElement.scrollWidth <= innerWidth)).toBe(true);
    await page.evaluate(() => window.scrollTo(0, 0));
    await expect(page.locator('#view')).not.toHaveClass(/is-entering|is-settling|is-leaving/);
    await page.screenshot({path:testInfo.outputPath(`memory-chat-${width}.png`),fullPage:true});
  }
});

test('smart autofill saves independently from real-time checks', async ({ page }) => {
  await signIn(page, '#memory', 'smart-compose@work.test');
  const autofill = page.getByRole('switch', { name: /^Smart autofill/ });
  const checks = page.getByRole('switch', { name: /^Real-time Pidgy checks/ });
  await expect(autofill).not.toBeChecked();
  const checksBefore = await checks.isChecked();
  await autofill.check();
  await expect(page.getByText('Smart autofill is on.', { exact: true })).toBeVisible();
  expect(await checks.isChecked()).toBe(checksBefore);
  await page.reload();
  await expect(autofill).toBeChecked();
  expect(await checks.isChecked()).toBe(checksBefore);
  await autofill.uncheck();
  await expect(page.getByText('Smart autofill is off.', { exact: true })).toBeVisible();
});

test('saving the first memory and forgetting the last keeps the confirmation visible', async ({ page }) => {
  await signIn(page, '#memory', 'first-memory@work.test');
  await expect(page.getByRole('heading', { name: 'Nothing remembered yet' })).toBeVisible();
  const input = page.getByLabel('Ask or update memory');
  await input.fill('Remember: I prefer concise replies and no em dashes.');
  await input.press('Enter');
  await expect(page.locator('.memory-answer')).toContainText('Remembered:');
  await expect(page.locator('.brain-page').getByRole('heading', { name: 'You', exact: true })).toBeVisible();
  await input.fill('Update: I prefer detailed technical explanations.');
  await input.press('Enter');
  await expect(page.locator('.memory-answer')).toContainText('Updated memory:');
  await input.fill('Forget my writing preference.');
  await input.press('Enter');
  await expect(page.locator('.memory-answer')).toContainText('Forgotten:');
  await expect(page.getByRole('heading', { name: 'Nothing remembered yet' })).toBeVisible();
});

test('editing and forgetting memory refreshes the overview and active search without losing the page', async ({ page }) => {
  await signIn(page, '#memory');
  await page.locator('.fact-group > summary').filter({ hasText: 'Work & plans' }).click();
  const fact = page.locator('.brain-page .fact').filter({ hasText: 'Built PigeonBox, an AI email copilot.' });
  await fact.getByRole('button', { name: 'Edit', exact: true }).click();
  const correction = 'Built PigeonBox to make the everyday email routine easier.';
  await fact.getByLabel('Correct this fact').fill(correction);
  await fact.getByRole('button', { name: 'Save', exact: true }).click();
  await expect(page.locator('.brain-page .bp-summary')).toHaveCount(0);
  await expect(page.locator('.brain-page').getByText(correction, { exact: true })).toBeVisible();
  await page.getByLabel('Find a page or search facts').fill('PigeonBox');
  await page.getByLabel('Find a page or search facts').press('Enter');
  const found = page.locator('.brain-page .fact').filter({ hasText: correction });
  await expect(found).toBeVisible();
  await found.getByRole('button', { name: 'Forget', exact: true }).click();
  await expect(page.locator('.brain-page').getByRole('heading', { name: '“PigeonBox”' })).toBeVisible();
  await expect(page.locator('.brain-page').getByText(correction, { exact: true })).toHaveCount(0);
});

test('memory pages reveal additional facts instead of silently stopping at a fixed cap', async ({ page }) => {
  let sample: Record<string, unknown> | undefined;
  await page.route('**/v1/memory/list', async route => {
    const response = await route.fetch();
    const data = await response.json();
    sample ??= data.memories[0];
    if (!sample) return route.fulfill({ response });
    const cursor = Number(route.request().postDataJSON().cursor ?? 0);
    data.memories = Array.from({ length: cursor ? 1 : 50 }, (_, i) => ({ ...sample, id: `00000000-0000-4000-8000-${String(cursor + i + 1).padStart(12, '0')}`, text: `Remembered detail number ${cursor + i + 1}.` }));
    data.nextCursor = cursor ? null : '50';
    await route.fulfill({ response, json: data });
  });
  await signIn(page, '#memory');
  await expect(page.locator('.brain-page .fact')).toHaveCount(50);
  await page.getByRole('button', { name: 'Load more memories', exact: true }).click();
  await expect(page.locator('.brain-page .fact')).toHaveCount(51);
  await expect(page.getByRole('button', { name: 'Load more memories', exact: true })).toHaveCount(0);
});

test('a failed memory question preserves the input for a successful retry', async ({ page }) => {
  await signIn(page, '#memory', 'retry-memory@work.test');
  await page.route('**/v1/memory/chat', route => route.fulfill({ status: 503, json: { error: { code: 'internal', message: 'Memory is temporarily unavailable.', retryable: true } } }));
  const composer = page.getByLabel('Ask or update memory');
  await composer.fill('What do you remember about me?');
  await composer.press('Enter');
  await expect(page.locator('.memory-response')).toContainText('temporarily unavailable');
  await expect(composer).toHaveValue('What do you remember about me?');
  await page.unroute('**/v1/memory/chat');
  await composer.press('Enter');
  await expect(page.locator('.memory-answer')).toBeVisible();
  await expect(composer).toHaveValue('');
});

test('Correspondents shows open promises, completed delivery evidence and preserves list filters', async ({ page }, testInfo) => {
  await signIn(page, '#contacts');
  const radar = page.locator('.contacts-radar');
  await expect(radar).toContainText('budget spreadsheet');
  await expect(radar).not.toContainText('promised something');
  await page.getByLabel('Search contacts').fill('Bangee');
  await expect(page.locator('.selectable > li')).toHaveCount(1);
  const person = page.locator('.selectable').getByRole('button', { name: /Bangee K Lee/ });
  await person.scrollIntoViewIfNeeded();
  const scroll = await page.evaluate(() => window.scrollY);
  await person.click();
  const owed = page.locator('section', { has: page.getByRole('heading', { name: 'You owe them', exact: true }) });
  await expect(owed).toContainText('budget spreadsheet');
  await expect(owed).not.toContainText('proposal PDF');
  const completed = page.locator('.contact-completed');
  await expect(completed).toContainText('proposal PDF');
  await expect(completed.getByRole('link', { name: /view evidence/ })).toHaveAttribute('href', /authuser=ada%40work\.test/);
  await expect(page.locator('.timeline').getByRole('link', { name: 'View email' }).first()).toHaveAttribute('href', /authuser=ada%40work\.test/);
  await page.getByRole('button', { name: '← Correspondents', exact: true }).click();
  await expect(page.getByLabel('Search contacts')).toHaveValue('Bangee');
  await expect.poll(() => page.evaluate(() => window.scrollY)).toBeGreaterThanOrEqual(scroll - 2);
  await page.locator('.selectable').getByRole('button', { name: /Bangee K Lee/ }).click();
  await expect(page.locator('.contact-completed')).toBeVisible();
  await page.emulateMedia({ reducedMotion: 'reduce' });
  for (const width of [1280, 390]) {
    await page.setViewportSize({ width, height: 844 });
    if (width < 800) await expect(page.locator('#cp-side')).not.toBeInViewport();
    expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBe(true);
    await page.evaluate(() => window.scrollTo(0, 0));
    await expect(page.locator('#view')).not.toHaveClass(/is-entering|is-settling|is-leaving/);
    await page.screenshot({ path: testInfo.outputPath(`correspondents-${width}.png`), fullPage: true });
  }
});
