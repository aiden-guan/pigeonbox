import { test, expect } from './fixtures';
import { writeFile } from 'node:fs/promises';

test('MV3 worker boots; Local starts first and survives a failed Cloud', async ({ app }) => {
  app.api.fail = true;
  const page = await app.page('sidepanel');
  expect(app.worker.url()).toContain('/background.js');
  await expect(page.getByRole('button', { name: 'Inbox', exact: true })).toBeVisible();
  await expect(page.getByRole('button', { name: 'Cloud', exact: true })).toHaveCount(0);
  await page.getByRole('button', { name: 'Home', exact: true }).click();
  await expect(page.getByText('Needs your reply', { exact: true })).toBeVisible();
  await page.getByRole('button', { name: 'Inbox', exact: true }).click();
  await expect(page.getByRole('heading', { name: 'Nothing needs you here.' })).toBeVisible();
});
test('Cloud overview loads through the real worker/client and retains sections on partial failure', async ({ app }) => {
  app.api.partial = true;
  app.api.delay = 500;
  const page = await app.page('sidepanel', true);
  await expect(page.getByText('Loading prepared work…')).toBeVisible();
  await expect(page.getByText('Up to date', { exact: true })).toBeVisible();
  await expect(page.getByText('Reviewed 7 conversations', { exact: true })).toBeVisible();
  await expect(page.getByText('Briefing could not load.', { exact: false })).toBeVisible();
  await expect(page.getByText('Ready for you', { exact: true })).toBeVisible();
  app.api.partial = false;
  await page.getByRole('button', { name: 'Refresh', exact: true }).click();
  await expect(page.getByText('Your morning briefing', { exact: true })).toBeVisible();
  await page.screenshot({ path: 'test-results/cloud-overview.png' });
  await page.getByRole('button', { name: 'Open full briefing' }).click();
  await expect(page.getByText('Reply to Maya about pricing.')).toBeVisible();
  await page.screenshot({ path: 'test-results/cloud-overview-reader.png' });
});
test('Cloud disconnection offers Google setup; failure preserves the last loaded overview', async ({ app }) => {
  app.api.disconnected = true;
  const page = await app.page('sidepanel', true);
  await expect(page.getByRole('button', { name: 'Connect Google', exact: true })).toBeVisible();
  app.api.fail = true;
  await page.getByRole('button', { name: 'Refresh', exact: true }).click();
  await expect(page.getByText('Could not refresh. Showing the last loaded data.')).toBeVisible();
  await expect(page.getByText('Could not refresh', { exact: true })).toBeVisible();
  await expect(page.getByText('Reviewed 7 conversations')).toBeVisible();
});
test('Cloud Ask shows loading, a cited answer, account-bound sources and keeps the conversation', async ({ app }) => {
  const page = await app.page('sidepanel', true);
  await page.getByRole('button', { name: 'Ask', exact: true }).click();
  await page.getByRole('textbox', { name: 'Ask Pigeon', exact: true }).fill('What needs a reply?');
  await page.locator('form').getByRole('button', { name: 'Ask', exact: true }).click();
  await expect(page.getByText('Searching your mail…')).toBeVisible();
  // Progress streams in before the answer.
  await expect(page.locator('.pb-ask-steps li', { hasText: 'Searching Gmail: pricing' })).toBeVisible();
  await expect(page.locator('.pb-ask-steps li', { hasText: 'Reading "Pricing"' })).toBeVisible();
  await expect(page.locator('.pb-answer-text strong', { hasText: 'Pricing' })).toBeVisible();
  await expect(page.locator('.pb-ask-steps')).toHaveCount(0);
  expect(app.api.calls.filter((call) => call.route === '/v1/ask/stream')).toHaveLength(1);
  await expect(page.locator('.pb-answer-text button.pb-citation-ref')).toHaveText('[01]');
  // Sources start collapsed behind a toggle with a count.
  await expect(page.locator('.pb-answer-sources')).not.toHaveAttribute('open', '');
  await page.locator('.pb-answer-sources summary').click();
  await expect(page.getByRole('button', { name: /^Pricing/ })).toBeVisible();
  await expect(page.getByText('Only fixture mail was checked.')).toBeVisible();
  await page.getByRole('textbox', { name: 'Ask Pigeon', exact: true }).fill('And what else?');
  await page.locator('form').getByRole('button', { name: 'Ask', exact: true }).click();
  await expect(page.locator('.pb-ask-turn')).toHaveCount(2);
  await expect(page.locator('.gi-asked').first()).toHaveText('What needs a reply?');
  await expect(page.locator('.pb-answer-text')).toHaveCount(2);
  const followUp = app.api.calls.filter((call) => call.route === '/v1/ask/stream')[1]!;
  expect(followUp.body.history).toEqual([
    { role: 'user', content: 'What needs a reply?' },
    { role: 'assistant', content: 'Maya needs pricing.\n\nShe asked in the **Pricing** thread. ' },
  ]);
});
test('Cloud Ask falls back to a one-shot answer when Cloud cannot stream', async ({ app }) => {
  const page = await app.page('sidepanel', true);
  app.api.noStream = true;
  await page.getByRole('button', { name: 'Ask', exact: true }).click();
  await page.getByRole('textbox', { name: 'Ask Pigeon', exact: true }).fill('What needs a reply?');
  await page.locator('form').getByRole('button', { name: 'Ask', exact: true }).click();
  await expect(page.locator('.pb-answer-text strong', { hasText: 'Pricing' })).toBeVisible();
  expect(app.api.calls.map((call) => call.route)).toEqual(expect.arrayContaining(['/v1/ask/stream', '/v1/ask']));
});
test('Gmail SPA lifecycle mounts one companion, palette restores focus and ignores editors', async ({ app }) => {
  await app.page('sidepanel');
  const page = await app.gmail();
  await expect(page.locator('[data-gi-ui="workspace"]')).toHaveCount(1);
  await page.evaluate(() => {
    location.hash = '#sent/abc123';
  });
  await expect(page.locator('[data-gi-ui="workspace"]')).toHaveCount(1);
  await page.locator('[aria-label="Message Body"]').focus();
  await page.keyboard.press(process.platform === 'darwin' ? 'Meta+k' : 'Control+k');
  await expect(page.locator('[data-gi-ui="cmdk"]')).toHaveCount(0);
  await page.locator('[aria-label="Message Body"]').blur();
  await page.getByRole('heading', { name: 'Pricing', exact: true }).click();
  await page.keyboard.press(process.platform === 'darwin' ? 'Meta+k' : 'Control+k');
  const workspace = page.frameLocator('iframe[title="PigeonBox"]');
  await expect(workspace.getByRole('dialog')).toBeVisible();
  await workspace.getByRole('combobox', { name: 'Ask Pigeon or run a command' }).press('ArrowDown');
  await expect(workspace.getByRole('combobox', { name: 'Ask Pigeon or run a command' })).toHaveAttribute('aria-activedescendant', /command/);
  await workspace.getByRole('combobox', { name: 'Ask Pigeon or run a command' }).press('Escape');
  await expect(workspace.getByRole('dialog')).toHaveCount(0);
});
test('prepared variants render from the real Cloud transport; insert changes compose without sending', async ({
  app,
}) => {
  await app.page('sidepanel', true);
  const page = await app.gmail();
  const workspace = page.frameLocator('iframe[title="PigeonBox"]');
  await expect(workspace.getByText('Reply prepared', { exact: true }).first()).toBeVisible();
  await expect(workspace.getByText('Fill in [CONFIRM PRICE] before sending.')).toBeVisible();
  await workspace.getByRole('tab', { name: 'Shorter' }).click();
  await workspace.getByRole('button', { name: 'Use prepared reply', exact: true }).click();
  await expect(page.locator('[aria-label="Message Body"]')).toContainText('Hi Maya');
  expect(await page.locator('body').getAttribute('data-sent')).toBeNull();
});
test('side panel mode persists across reload and reduced motion stops decorative loops', async ({ app }) => {
  const page = await app.page('sidepanel', true);
  await page.getByRole('button', { name: 'Ask', exact: true }).click();
  await page.reload();
  await expect(page.getByRole('textbox', { name: 'Ask Pigeon', exact: true })).toBeVisible();
  await page.emulateMedia({ reducedMotion: 'reduce' });
  const animation = await page
    .locator('.gi-pigeon-frame')
    .first()
    .evaluate((node) => getComputedStyle(node).animationName);
  expect(animation).toBe('none');
});

test('side panel palette opens capability-aware tools and submits Cloud questions', async ({ app }) => {
  const page = await app.page('sidepanel', true);
  await page.locator('body').click({ position: { x: 4, y: 4 } });
  await page.keyboard.press(process.platform === 'darwin' ? 'Meta+k' : 'Control+k');
  await page.getByRole('combobox', { name: 'Ask Pigeon or run a command' }).fill('What needs a reply?');
  await page.keyboard.press('Enter');
  await expect(page.getByText('Maya needs pricing.', { exact: true })).toBeVisible();
  expect(app.api.calls.filter((call) => call.route.startsWith('/v1/ask')).length).toBeLessThanOrEqual(1);
});
test('Smart View previews explainable actions and saves only in Shadow Mode', async ({ app }) => {
  const page = await app.page('sidepanel', true);
  await page.locator('[data-command-launcher]').click();
  await page.getByRole('combobox', { name: 'Ask Pigeon or run a command' }).fill('Open Smart Views');
  await page.getByRole('combobox', { name: 'Ask Pigeon or run a command' }).press('Enter');
  await page.getByLabel('Describe the mail and what should happen').fill('Archive receipts');
  await page.getByRole('button', { name: 'Preview', exact: true }).click();
  await expect(page.getByText('PigeonBox understood: Receipts')).toBeVisible();
  await page.getByRole('button', { name: 'Save in Shadow Mode' }).click();
  await expect(page.getByText('Saved in Shadow Mode.', { exact: false })).toBeVisible();
  const save = app.api.calls.find((call) => call.route === '/v1/views/save');
  expect(save?.body.mode).toBe('shadow');
});
test('PDF upload uses authenticated worker transport and creates recipient-specific links without sending', async ({
  app,
}) => {
  const page = await app.page('sidepanel', true);
  await page.locator('[data-command-launcher]').click();
  await page.getByRole('combobox', { name: 'Ask Pigeon or run a command' }).fill('Open Documents');
  await page.getByRole('combobox', { name: 'Ask Pigeon or run a command' }).press('Enter');
  await page
    .getByLabel('Upload PDF')
    .setInputFiles({
      name: 'Proposal.pdf',
      mimeType: 'application/pdf',
      buffer: Buffer.from('%PDF-1.4\nsynthetic fixture\n%%EOF'),
    });
  await expect(page.getByText('Uploaded privately to Cloud.', { exact: false })).toBeVisible();
  await page.getByLabel('Recipient (optional)').fill('recipient@fixture.test');
  await page.getByRole('button', { name: 'Create tracked link' }).click();
  await expect(page.getByRole('button', { name: 'Insert into Gmail' })).toBeVisible();
  expect(app.api.calls.some((call) => call.route.endsWith('/content'))).toBe(true);
  const link = app.api.calls.find((call) => call.route === '/v1/documents/links/create');
  expect(link?.body.recipientEmail).toBe('recipient@fixture.test');
  expect(app.api.calls.some((call) => /send|approval/.test(call.route))).toBe(false);
});
test('tracking instruments the controlled composer, transforms only outbound HTML and filters sender opens', async ({
  app,
}) => {
  const page = await app.context.newPage();
  await page.goto(`chrome-extension://${app.id}/browser-fixture.html`);
  await expect(page.locator('body')).toHaveAttribute('data-tracking', 'MODIFIER_REGISTERED');
  await expect(page.locator('body')).toHaveAttribute('data-allocations', '1');
  expect(await page.locator('[aria-label="Message Body"]').innerHTML()).not.toContain('/open/');
  await expect(page.locator('#sent-state')).toBeEmpty();
  await page.getByRole('button', { name: 'Try sending placeholder' }).click();
  await expect(page.getByRole('button', { name: 'Placeholder send blocked' })).toBeVisible();
  await page.getByRole('button', { name: 'Send fixture' }).click();
  await expect(page.locator('body')).toHaveAttribute('data-outbound-pixel', 'true');
  await expect(page.locator('#sent-state')).toHaveText('Tracked send linked');
  await page.getByRole('button', { name: 'Inspect self and recipient opens' }).click();
  await expect(page.locator('#timeline')).toHaveText('1 likely open · 1 timeline event · sender suppressed true');
});
test('tracking badge sits inline, immediately left of Send, without covering native controls', async ({ app }) => {
  const page = await app.context.newPage();
  await page.goto(`chrome-extension://${app.id}/browser-fixture.html`);
  const badge = page.locator('#tracking-compose [data-gi-ui="track-toggle"]');
  await expect(badge).toHaveText('Tracking ready');
  for (const width of [800, 320]) {
    await page.setViewportSize({ width, height: 600 });
    const bounds = await page.evaluate(() => {
      const root = document.querySelector('#tracking-compose')!;
      const badge = root.querySelector('[data-gi-ui="track-toggle"]')!;
      const send = root.querySelector('[aria-label="Send"]')!;
      const b = badge.getBoundingClientRect(), s = send.getBoundingClientRect(), c = root.getBoundingClientRect();
      const clearOfNativeTools = Array.from(root.querySelectorAll('button:not([data-gi-ui])')).every((tool) => {
        const n = tool.getBoundingClientRect();
        return b.right <= n.left || b.left >= n.right || b.bottom <= n.top || b.top >= n.bottom;
      });
      return {
        beforeSend: send.previousElementSibling === badge,
        sameRowLeftOfSend: b.right <= s.left && Math.abs((b.top + b.bottom) / 2 - (s.top + s.bottom) / 2) <= 4,
        left: b.left - c.left,
        right: c.right - b.right,
        clearOfNativeTools,
      };
    });
    expect(bounds.beforeSend).toBe(true);
    expect(bounds.clearOfNativeTools).toBe(true);
    expect(bounds.sameRowLeftOfSend).toBe(true);
    expect(bounds.left).toBeGreaterThanOrEqual(0);
    expect(bounds.right).toBeGreaterThanOrEqual(0);
  }
});
test('Chrome permission boundary grants declared Gmail access and denies undeclared access on a direct gesture', async ({
  app,
}) => {
  const page = await app.page('workspace');
  await page.evaluate(() => {
    const button = document.createElement('button');
    button.textContent = 'Permission fixture';
    document.body.append(button);
    button.onclick = async () => {
      const granted = await chrome.permissions.request({ origins: ['https://mail.google.com/*'] });
      let denied = false;
      try {
        denied = !(await chrome.permissions.request({ permissions: ['history'] }));
      } catch {
        denied = true;
      }
      button.textContent = `Gmail granted ${granted} · undeclared denied ${denied}`;
    };
  });
  await page.getByRole('button', { name: 'Permission fixture' }).click();
  await expect(page.getByRole('button', { name: 'Gmail granted true · undeclared denied true' })).toBeVisible();
});

test('profiles synthetic Cloud overview, Ask, thread mount and SPA navigation without polling', async ({ app }) => {
  const timings: Record<string, number> = {};
  let start = Date.now(); const page = await app.page('sidepanel', true);
  await expect(page.getByText('Ready for you', { exact: true })).toBeVisible(); timings.overviewSetupToReadyMs = Date.now() - start;
  await page.getByRole('button', { name: 'Ask', exact: true }).click();
  await page.getByRole('textbox', { name: 'Ask Pigeon' }).fill('What needs a reply?');
  start = Date.now(); await page.locator('form').getByRole('button', { name: 'Ask', exact: true }).click();
  await expect(page.getByText('Maya needs pricing.', { exact: true })).toBeVisible(); timings.askIncluding300msFixtureMs = Date.now() - start;
  start = Date.now(); const gmail = await app.gmail();
  await expect(gmail.frameLocator('iframe[title="PigeonBox"]').getByText('Reply prepared', { exact: true }).first()).toBeVisible(); timings.gmailNavigationAndThreadMountMs = Date.now() - start;
  start = Date.now(); await gmail.evaluate(() => { location.hash = '#sent/abc123'; });
  await expect(gmail.locator('[data-gi-ui="workspace"]')).toHaveCount(1); timings.spaRouteAndCompanionCheckMs = Date.now() - start;
  expect(await page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth)).toBe(true);
  await writeFile(test.info().outputPath('fixture-performance.json'), JSON.stringify({ synthetic: true, timings }, null, 2));
  await test.info().attach('fixture-performance.json', { body: JSON.stringify({ synthetic: true, timings }, null, 2), contentType: 'application/json' });
});

test('Local Ask stays local and responds when Cloud is failing', async ({ app }) => {
  app.api.fail = true; const page = await app.page('sidepanel');
  await page.getByRole('button', { name: 'Ask', exact: true }).click();
  await expect(page.getByText('AI is off. Results are local matches.')).toBeVisible();
  await page.locator('form input').fill('Who needs a reply?');
  await page.locator('form').getByRole('button', { name: 'Send', exact: true }).click();
  await expect(page.getByText('Who needs a reply?', { exact: true })).toBeVisible();
  await expect(page.getByText('Looking through your mail…')).toHaveCount(0);
  expect(app.api.calls.some(call => call.route.startsWith('/v1/ask'))).toBe(false);
});
