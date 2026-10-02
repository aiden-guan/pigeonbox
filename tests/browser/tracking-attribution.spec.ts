import { test, expect } from './fixtures';

test('own sent reload never publishes the proxy count, timeline or alert before canonical reconciliation', async ({ app }) => {
  const page = await app.page('workspace');
  const trackingId = 'trk_reload_race'; const old = new Date(Date.now() - 86_400_000).toISOString();
  app.api.tracker = { email: { tracking_id: trackingId, sender: 'owner@fixture.test', recipients: ['maya@fixture.test'], subject: 'Pricing', gmail_thread_id: 'abc123', gmail_message_id: 'abcd', status: 'SENT', sent_at: old, created_at: old, open_count: 0, click_count: 0, first_opened_at: null, last_opened_at: null }, events: [], holdClaims: true, release: () => undefined };
  await page.evaluate(async ({ baseUrl, trackingId, old }) => {
    const current = await chrome.runtime.sendMessage({ type: 'GET_SETTINGS' });
    await chrome.runtime.sendMessage({ type: 'SAVE_SETTINGS', settings: { ...current.settings, trackingEnabled: true, desktopNotifications: true, trackerBaseUrl: baseUrl, personalApiToken: 'synthetic-tracker-only' } });
    await chrome.storage.local.set({ trackedEmails: [{ trackingId, issuer: `local:${baseUrl}`, status: 'SENT', sender: 'owner@fixture.test', recipients: ['maya@fixture.test'], subject: 'Pricing', gmailThreadId: 'abc123', gmailMessageId: 'abcd', sentAt: old, createdAt: old, openCount: 0, clickCount: 0, firstOpenedAt: null, lastOpenedAt: null }] });
    (window as unknown as { visibleCounts: number[] }).visibleCounts = [];
    chrome.storage.onChanged.addListener((changes, area) => { if (area === 'local' && changes.trackedEmails) (window as unknown as { visibleCounts: number[] }).visibleCounts.push(changes.trackedEmails.newValue[0]?.openCount || 0); });
    await chrome.runtime.sendMessage({ type: 'TRACKING_POLL' });
  }, { baseUrl: app.api.baseUrl, trackingId, old });
  const gmail = await app.gmail();
  // Model Gmail's HTTPS image proxy rather than requesting an insecure loopback
  // image from Gmail (which Chrome correctly blocks as private-network access).
  const proxy = 'https://ci3.googleusercontent.com/proxy/pigeonbox-fixture';
  await app.context.route(`${proxy}*`, async (route) => {
    const response = await app.context.request.get(`${app.api.baseUrl}/open/${trackingId}`);
    await route.fulfill({ response });
  });
  await app.context.route('https://mail.google.com/**', (route) => route.fulfill({ contentType: 'text/html', body: `<html><body><a href="https://accounts.google.com/" aria-label="Google Account: Owner (owner@fixture.test)">Owner</a><div role="main" data-thread-perm-id="abc123"><h2 class="hP">Pricing</h2><div data-legacy-message-id="abcd"><span email="owner@fixture.test">me</span><div class="a3s">The scope is attached.<img src="${proxy}#${app.api.baseUrl}/open/${trackingId}" width="1" height="1"></div></div></div></body></html>` }));
  await gmail.reload();
  await expect.poll(() => app.api.calls.some((call) => call.route.endsWith('/self-view') && call.body?.source === 'PAGE_RELOAD')).toBe(true);
  // The server has already counted the proxy. The extension exposes only settled facts.
  await expect.poll(() => app.api.tracker!.email.open_count).toBe(1);
  await page.evaluate(() => chrome.runtime.sendMessage({ type: 'TRACKING_POLL' }));
  const pending = await page.evaluate(async (id) => ({ emails: await chrome.runtime.sendMessage({ type: 'GET_TRACKED_EMAILS' }), activity: await chrome.runtime.sendMessage({ type: 'GET_TRACKING_TIMELINE', trackingId: id }), history: (await chrome.storage.local.get('trackingNotificationHistory')).trackingNotificationHistory, alerts: await chrome.notifications.getAll() }), trackingId);
  expect(pending.emails.emails[0].openCount).toBe(0); expect(pending.activity.timeline).toEqual([]);
  expect(JSON.stringify(pending.history)).not.toContain('own-reload-proxy'); expect(Object.keys(pending.alerts)).toEqual([]);
  app.api.tracker.release();
  await expect.poll(async () => (await page.evaluate(async () => (await chrome.storage.session.get('trackingAttribution')).trackingAttribution)).pending.length).toBe(0);
  await page.evaluate(() => chrome.runtime.sendMessage({ type: 'TRACKING_POLL' }));
  expect(await page.evaluate(() => (window as unknown as { visibleCounts: number[] }).visibleCounts)).not.toContain(1);
  // A real browser open immediately afterward is published and alerts once.
  const timestamp = new Date().toISOString();
  app.api.tracker.events.push({ id: 'recipient-after-self', tracking_id: trackingId, type: 'OPEN', timestamp, user_agent: 'Mozilla/5.0 (Macintosh) AppleWebKit/537.36 Chrome/130 Safari/537.36', classification: 'RECIPIENT_LIKELY' });
  app.api.tracker.email.open_count = 1; app.api.tracker.email.first_opened_at = timestamp; app.api.tracker.email.last_opened_at = timestamp;
  await page.evaluate(() => chrome.runtime.sendMessage({ type: 'TRACKING_POLL' }));
  const settled = await page.evaluate(async (id) => ({ emails: await chrome.runtime.sendMessage({ type: 'GET_TRACKED_EMAILS' }), activity: await chrome.runtime.sendMessage({ type: 'GET_TRACKING_TIMELINE', trackingId: id }), history: (await chrome.storage.local.get('trackingNotificationHistory')).trackingNotificationHistory }), trackingId);
  expect(settled.emails.emails[0].openCount).toBe(1); expect(settled.activity.timeline).toHaveLength(1); expect(JSON.stringify(settled.history)).toContain('recipient-after-self');
});
