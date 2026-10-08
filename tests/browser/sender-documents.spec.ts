import { expect, test } from './fixtures';

test('Gmail uses fresh owner previews after a delayed click and preserves recipient and composer links', async ({ app }) => {
  test.setTimeout(75_000);
  await app.page('workspace', true);
  const token = 'x'.repeat(32), recipient = 'y'.repeat(32);
  const own = `${app.api.baseUrl}/d/${token}`, received = `${app.api.baseUrl}/d/${recipient}`;
  app.api.documentPreviews = { [token]: `${own}#preview=first_proof` };
  await app.context.route(`${app.api.baseUrl}/d/**`, route => route.fulfill({ contentType: 'text/html', body: '<h1>Document viewer</h1>' }));
  await app.context.route('https://mail.google.com/**', route => route.fulfill({ contentType: 'text/html', body: `<html><body><a href="https://accounts.google.com" aria-label="Google Account: Owner (owner@fixture.test)">Owner</a><div role="main" data-thread-perm-id="abc123"><h2 class="hP">Proposal</h2><div data-legacy-message-id="abcd"><span email="owner@fixture.test">me</span><div class="a3s">Proposal <a id="own" target="_blank" href="https://www.google.com/url?q=${encodeURIComponent(own)}">Open proposal</a><a id="recipient" target="_blank" href="${received}">Received document</a></div></div><div contenteditable="true" role="textbox" aria-label="Message Body"><a id="draft" href="${own}">Draft proposal</a></div></div></body></html>` }));
  const gmail = await app.gmail();
  await expect.poll(() => app.api.calls.filter(c => c.route === '/v1/threads/intel').length).toBeGreaterThan(0);
  const open = async (selector: string) => {
    const result = app.context.waitForEvent('page');
    await gmail.locator(selector).click();
    const page = await result; await page.waitForLoadState(); return page;
  };
  let opened = await open('#own'); await expect(opened).toHaveURL(`${own}#preview=first_proof`); await opened.close();
  await gmail.waitForTimeout(26_000); // past the existing email sender-claim TTL
  app.api.documentPreviews[token] = `${own}#preview=second_proof`;
  opened = await open('#own'); await expect(opened).toHaveURL(`${own}#preview=second_proof`); await opened.close();
  expect(app.api.calls.filter(c => c.route === '/v1/documents/preview' && c.body.token === token)).toHaveLength(2);
  opened = await open('#recipient'); await expect(opened).toHaveURL(received); await opened.close();
  await expect(gmail.locator('#draft')).toHaveAttribute('href', own);
  await expect(gmail.locator('#own')).toHaveAttribute('href', 'https://www.google.com/url?q=' + encodeURIComponent(own));
});

test('an email-tracked document refreshes its cached sender preview without recording an email click', async ({ app }) => {
  const setup = await app.page('workspace', true);
  await setup.evaluate(async baseUrl => {
    await chrome.runtime.sendMessage({ type: 'SET_RUN_MODE', mode: 'local' });
    const current = await chrome.runtime.sendMessage({ type: 'GET_SETTINGS' });
    await chrome.runtime.sendMessage({ type: 'SAVE_SETTINGS', settings: { ...current.settings, trackingEnabled: true, trackerBaseUrl: baseUrl, personalApiToken: 'synthetic-tracker-only' } });
  }, app.api.baseUrl);
  const token = 'z'.repeat(32), own = `${app.api.baseUrl}/d/${token}`;
  app.api.documentPreviews = { [token]: `${own}#preview=old_proof` };
  const old = new Date(Date.now() - 3_600_000).toISOString();
  app.api.tracker = { senderLink: { clickId: 'clk_document_sender', destination: own }, email: { tracking_id: 'trk_document_sender', sender: 'owner@fixture.test', recipients: ['maya@fixture.test'], subject: 'Proposal', gmail_thread_id: 'abc123', gmail_message_id: 'abcd', status: 'SENT', sent_at: old, created_at: old, open_count: 0, click_count: 0 }, events: [], holdClaims: false, release: () => undefined };
  await app.context.route(`${app.api.baseUrl}/d/**`, route => route.fulfill({ contentType: 'text/html', body: '<h1>Document viewer</h1>' }));
  await app.context.route('https://mail.google.com/**', route => route.fulfill({ contentType: 'text/html', body: `<html><body><a href="https://accounts.google.com" aria-label="Google Account: Owner (owner@fixture.test)">Owner</a><div role="main" data-thread-perm-id="abc123"><h2 class="hP">Proposal</h2><div data-legacy-message-id="abcd"><span email="owner@fixture.test">me</span><div class="a3s"><a id="wrapped" target="_blank" href="${app.api.baseUrl}/c/clk_document_sender">Tracked proposal</a></div></div></div></body></html>` }));
  const gmail = await app.gmail();
  await expect(gmail.locator('#wrapped')).toHaveAttribute('href', `${own}#preview=old_proof`);
  app.api.documentPreviews[token] = `${own}#preview=fresh_proof`;
  const [opened] = await Promise.all([app.context.waitForEvent('page'), gmail.locator('#wrapped').click()]);
  await expect(opened).toHaveURL(`${own}#preview=fresh_proof`);
  expect(app.api.calls.filter(c => c.route === '/v1/documents/preview' && c.body.token === token)).toHaveLength(2);
  expect(app.api.calls.filter(c => c.route.startsWith('/c/'))).toEqual([]);
  expect(app.api.tracker.email.click_count).toBe(0);
  await opened.close();
});
