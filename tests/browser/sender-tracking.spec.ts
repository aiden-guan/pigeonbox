import { test, expect } from './fixtures';
import tracker from '../../workers/tracker/src/index';
import { resetMemoryStore } from '../../workers/tracker/src/store';

const PROXY_UA = 'Mozilla/5.0 (Windows NT 5.1; rv:11.0) Gecko Firefox/11.0 (via ggpht.com GoogleImageProxy)';
const GIF = Buffer.from('R0lGODlhAQABAIAAAAAAAP///yH5BAEAAAAALAAAAAABAAEAAAIBRAA7', 'base64');

test('a sender drafting a reply in their own tracked thread for over a minute never adds a recipient open', async ({ app }) => {
  test.setTimeout(180_000);
  resetMemoryStore();
  const env = { PERSONAL_API_TOKEN: 'synthetic-tracker-only' };
  const call = (path: string, init: RequestInit = {}) => tracker.fetch(new Request(`${app.api.baseUrl}${path}`, init), env);
  const authed = (path: string, init: RequestInit = {}) => call(path, { ...init, headers: { Authorization: `Bearer ${env.PERSONAL_API_TOKEN}`, 'Content-Type': 'application/json' } });
  app.api.forward = (request) => tracker.fetch(request, env);

  const created = await (await authed('/api/emails', { method: 'POST', body: JSON.stringify({ subject: 'Pricing', sender: 'owner@fixture.test', recipients: ['maya@fixture.test', 'li@fixture.test'], gmail_thread_id: 'abc123', gmail_message_id: 'abcd', links: [{ url: 'https://example.com/scope' }] }) })).json() as { tracking_id: string; rewritten_links: Array<{ tracked_url: string }> };
  const trackingId = created.tracking_id;
  const old = new Date(Date.now() - 3_600_000).toISOString();
  await authed(`/api/emails/${trackingId}`, { method: 'PATCH', body: JSON.stringify({ status: 'SENT', sent_at: old }) });
  const email = async () => (await (await authed(`/api/emails/${trackingId}`)).json()) as { open_count: number; click_count: number };
  const opens = async () => ((await (await authed(`/api/emails/${trackingId}/events`)).json()) as Array<{ type: string; classification: string }>).filter((event) => event.type === 'OPEN');

  const setup = await app.page('workspace');
  await setup.evaluate(async ({ baseUrl, trackingId, old }) => {
    const current = await chrome.runtime.sendMessage({ type: 'GET_SETTINGS' });
    await chrome.runtime.sendMessage({ type: 'SAVE_SETTINGS', settings: { ...current.settings, trackingEnabled: true, trackerBaseUrl: baseUrl, personalApiToken: 'synthetic-tracker-only' } });
    await chrome.storage.local.set({ trackedEmails: [{ trackingId, issuer: `local:${baseUrl}`, status: 'SENT', sender: 'owner@fixture.test', recipients: ['maya@fixture.test', 'li@fixture.test'], subject: 'Pricing', gmailThreadId: 'abc123', gmailMessageId: 'abcd', sentAt: old, createdAt: old, openCount: 0, clickCount: 0, firstOpenedAt: null, lastOpenedAt: null }] });
  }, { baseUrl: app.api.baseUrl, trackingId, old });

  // Gmail's image proxy: every fetch Chrome actually makes reaches the tracker as GoogleImageProxy.
  const proxy = 'https://ci3.googleusercontent.com/meips/sender-draft=s0-d-e1-ft';
  const pixel = (n: number) => `${proxy}?r=${n}#${app.api.baseUrl}/open/${trackingId}`;
  let proxyFetches = 0;
  await app.context.route(`${proxy}*`, async (route) => {
    proxyFetches += 1;
    await call(`/open/${trackingId}`, { headers: { 'User-Agent': PROXY_UA } });
    await route.fulfill({ contentType: 'image/gif', headers: { 'Cache-Control': 'no-store' }, body: GIF });
  });
  await app.context.route('https://example.com/scope', (route) => route.fulfill({ contentType: 'text/html', body: '<h1>Scope</h1>' }));
  const composer = `<div contenteditable="true" role="textbox" aria-label="Message Body"><div id="draft-text">Thanks Maya,</div><div class="gmail_quote"><div class="gmail_attr">On Mon, Owner wrote:</div><blockquote class="gmail_quote">The scope is attached.<img id="quoted-pixel" src="${pixel(1)}" width="1" height="1"></blockquote></div></div>`;
  await app.context.route('https://mail.google.com/**', (route) => route.fulfill({ contentType: 'text/html', body: `<html><body><a href="https://accounts.google.com/" aria-label="Google Account: Owner (owner@fixture.test)">Owner</a><div role="main" data-thread-perm-id="abc123"><h2 class="hP">Pricing</h2><div data-legacy-message-id="abcd"><span email="owner@fixture.test">me</span><div class="a3s">The scope is attached.<img id="own-pixel" src="${pixel(0)}" width="1" height="1"> <a id="own-link" target="_blank" href="${created.rewritten_links[0]!.tracked_url}">Scope</a></div></div><button id="reply" aria-label="Reply">Reply</button><div id="reply-slot"></div></div><template id="composer">${composer}</template><script>document.getElementById('reply').onclick = () => document.getElementById('reply-slot').append(document.getElementById('composer').content.cloneNode(true));</script></body></html>` }));

  // 1-2. The sender opens their own sent message.
  const gmail = await app.gmail();
  await expect(gmail.locator('#own-pixel')).toHaveAttribute('src', /^data:image/);
  // 3-4. Reply. The quoted history still carries the tracked pixel and stays untouched.
  await gmail.locator('#reply').click();
  const quoted = gmail.locator('[contenteditable] #quoted-pixel');
  await expect.poll(() => app.api.calls.filter((call) => call.route.endsWith('/self-view') && call.body.quotedRender === true).length).toBe(1);
  // 5-8. A minute of typing, autosaves that rebuild the quote, and Gmail restoring the sender copy's pixel.
  const started = Date.now();
  await gmail.locator('#draft-text').click();
  for (let step = 1; Date.now() - started < 61_000; step++) {
    await gmail.keyboard.type(` line ${step}`, { delay: 15 });
    if (step % 2 === 0) await gmail.keyboard.press('Enter');
    if (step % 4 === 0) await gmail.evaluate(() => { const quote = document.querySelector('[contenteditable] .gmail_quote')!; quote.replaceWith(quote.cloneNode(true)); });
    if (step % 7 === 0) await gmail.locator('#own-pixel').evaluate((image, src) => image.setAttribute('src', src), pixel(100 + step));
    await gmail.waitForTimeout(2_500);
  }
  const lastSenderRender = Date.now();
  await expect(gmail.locator('#own-pixel')).toHaveAttribute('src', /^data:image/);
  await expect(quoted).toHaveAttribute('src', pixel(1));
  expect(await gmail.locator('[contenteditable]').evaluate((editor) => editor.querySelectorAll('[data-pb-self-pixel-src]').length)).toBe(0);
  await expect(gmail.locator('[contenteditable]')).toContainText(/Thanks Maya, line 1 line 2[\s\S]*line 20/);
  const quotedClaims = app.api.calls.filter((call) => call.route.endsWith('/self-view') && call.body.quotedRender === true).length;
  expect(quotedClaims).toBeGreaterThan(5);
  expect(proxyFetches).toBeGreaterThan(0);

  // 9. Poll: every sender render was either prevented or attributed to the sender.
  await expect.poll(async () => (await opens()).every((event) => event.classification === 'SELF_LIKELY')).toBe(true);
  expect((await email()).open_count).toBe(0);
  await setup.evaluate(() => chrome.runtime.sendMessage({ type: 'TRACKING_POLL' }));
  expect(await setup.evaluate(async (id) => ((await chrome.storage.local.get('trackedEmails')).trackedEmails as Array<{ trackingId: string; openCount: number }>).find((row) => row.trackingId === id)?.openCount, trackingId)).toBe(0);

  // The sender opening a link from their own copy resolves it without recording a click.
  const [opened] = await Promise.all([app.context.waitForEvent('page'), gmail.locator('#own-link').click()]);
  await expect(opened).toHaveURL('https://example.com/scope');
  expect(app.api.calls.filter((call) => call.route.startsWith('/c/'))).toEqual([]);
  expect((await email()).click_count).toBe(0);

  // Both recipients opening through Gmail's proxy after the sender left are counted.
  await gmail.close();
  await setup.waitForTimeout(Math.max(0, lastSenderRender + 26_000 - Date.now()));
  await call(`/open/${trackingId}`, { headers: { 'User-Agent': PROXY_UA } });
  await setup.waitForTimeout(1_000);
  await call(`/open/${trackingId}`, { headers: { 'User-Agent': PROXY_UA } });
  expect((await email()).open_count).toBe(2);
});

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
