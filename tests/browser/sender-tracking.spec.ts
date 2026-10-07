import { test, expect } from './fixtures';

test('the packaged Gmail script protects old sender pixels and opens owned links without a click request', async ({ app }) => {
  const setup = await app.page('workspace');
  const trackingId = 'trk_old_sender';
  const old = new Date(Date.now() - 3_600_000).toISOString();
  const destination = 'https://example.com/sender-fixture';
  app.api.tracker = { senderLink: { clickId: 'clk_sender', destination }, email: { tracking_id: trackingId, sender: 'owner@fixture.test', recipients: ['maya@fixture.test'], subject: 'Pricing', gmail_thread_id: 'abc123', gmail_message_id: 'abcd', status: 'SENT', sent_at: old, created_at: old, open_count: 0, click_count: 0 }, events: [], holdClaims: false, release: () => undefined };
  await setup.evaluate(async ({ baseUrl, trackingId, old }) => {
    const current = await chrome.runtime.sendMessage({ type: 'GET_SETTINGS' });
    await chrome.runtime.sendMessage({ type: 'SAVE_SETTINGS', settings: { ...current.settings, trackingEnabled: true, trackerBaseUrl: baseUrl, personalApiToken: 'synthetic-tracker-only' } });
    await chrome.storage.local.set({ trackedEmails: [{ trackingId, issuer: `local:${baseUrl}`, status: 'SENT', sender: 'owner@fixture.test', recipients: ['maya@fixture.test'], subject: 'Pricing', gmailThreadId: 'abc123', gmailMessageId: 'abcd', sentAt: old, createdAt: old, openCount: 0, clickCount: 0, firstOpenedAt: null, lastOpenedAt: null }] });
  }, { baseUrl: app.api.baseUrl, trackingId, old });
  const proxy = 'https://ci3.googleusercontent.com/proxy/sender-fixture';
  await app.context.route(`${proxy}*`, (route) => route.fulfill({ contentType: 'image/gif', body: Buffer.from('R0lGODlhAQABAIAAAAAAAP///yH5BAEAAAAALAAAAAABAAEAAAIBRAA7', 'base64') }));
  await app.context.route(destination, (route) => route.fulfill({ contentType: 'text/html', body: '<h1>Original destination</h1>' }));
  await app.context.route('https://mail.google.com/**', (route) => route.fulfill({ contentType: 'text/html', body: `<html><body><a href="https://accounts.google.com/" aria-label="Google Account: Owner (owner@fixture.test)">Owner</a><div role="main" data-thread-perm-id="abc123"><h2 class="hP">Pricing</h2><div data-legacy-message-id="abcd"><span email="owner@fixture.test">me</span><div class="a3s">The scope is attached.<img id="own-pixel" src="${proxy}#${app.api.baseUrl}/open/${trackingId}" width="1" height="1"><blockquote><a id="own-link" target="_blank" href="${app.api.baseUrl}/c/clk_sender">Scope</a></blockquote></div></div></div></body></html>` }));
  const gmail = await app.gmail();
  await expect(gmail.locator('#own-pixel')).toHaveAttribute('src', /^data:image/);
  await expect(gmail.locator('#own-link')).toHaveAttribute('href', destination);
  await expect.poll(() => app.api.calls.some((call) => call.route.endsWith('/self-view') && call.body.pixelRender === true)).toBe(true);
  // Wait past the real 25-second claim TTL. Page clocks do not control the
  // extension's isolated content-script world. Unit tests also cover an hour.
  await gmail.waitForTimeout(26_000);
  await gmail.locator('#own-pixel').evaluate((image, src) => image.setAttribute('src', src), `${proxy}?late=1#${app.api.baseUrl}/open/${trackingId}`);
  await expect(gmail.locator('#own-pixel')).toHaveAttribute('src', /^data:image/);
  await expect.poll(() => app.api.calls.filter((call) => call.route.endsWith('/self-view') && call.body.pixelRender === true).length).toBeGreaterThan(1);
  const [opened] = await Promise.all([app.context.waitForEvent('page'), gmail.locator('#own-link').click()]);
  await expect(opened).toHaveURL(destination);
  expect(app.api.calls.filter((call) => call.route.startsWith('/c/'))).toEqual([]);
});
