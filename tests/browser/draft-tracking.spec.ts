import { test, expect } from './fixtures';

test('Gmail draft rows never inherit badges from a sent email with the same thread or subject', async ({ app }) => {
  const setup = await app.page('workspace');
  const trackingId = 'trk_draft_badge';
  const sentAt = new Date(Date.now() - 3_600_000).toISOString();
  const openedAt = new Date(Date.now() - 60_000).toISOString();
  app.api.tracker = {
    email: {
      tracking_id: trackingId, status: 'SENT', subject: 'Proposal', sender: 'owner@fixture.test',
      recipients: ['maya@fixture.test'], gmail_thread_id: 'abc123', gmail_message_id: 'abcd',
      sent_at: sentAt, created_at: sentAt, open_count: 2, click_count: 0,
      first_opened_at: openedAt, last_opened_at: openedAt,
    },
    events: [], holdClaims: false, release: () => undefined,
  };
  await setup.evaluate(async ({ baseUrl, trackingId, sentAt, openedAt }) => {
    const current = await chrome.runtime.sendMessage({ type: 'GET_SETTINGS' });
    await chrome.runtime.sendMessage({ type: 'SAVE_SETTINGS', settings: {
      ...current.settings, trackingEnabled: true, localOnly: true, trackerBaseUrl: baseUrl, personalApiToken: 'synthetic-tracker-only',
    } });
    await chrome.storage.local.set({ trackedEmails: [{
      trackingId, issuer: `local:${baseUrl}`, status: 'SENT', subject: 'Proposal', sender: 'owner@fixture.test',
      recipients: ['maya@fixture.test'], gmailThreadId: 'abc123', gmailMessageId: 'abcd',
      sentAt, createdAt: sentAt, openCount: 2, clickCount: 0, firstOpenedAt: openedAt, lastOpenedAt: openedAt,
    }] });
  }, { baseUrl: app.api.baseUrl, trackingId, sentAt, openedAt });
  await app.context.route('https://mail.google.com/**', (route) => route.fulfill({ contentType: 'text/html', body: `
    <!doctype html><html><body>
      <a href="https://accounts.google.com/" aria-label="Google Account: Owner (owner@fixture.test)">Owner</a>
      <div role="main"><h2>Conversations</h2><table><tbody>
        <tr id="draft-thread" class="zA" data-legacy-thread-id="abc123"><td class="yX"><div class="yW"><span class="yP boq">Draft</span></div></td><td><span class="bog">Proposal</span></td></tr>
        <tr id="draft-subject" class="zA" data-legacy-thread-id="def456"><td class="yX"><div class="yW"><span class="yP boq">Brouillon</span></div></td><td><span class="bog">Proposal</span></td></tr>
        <tr id="sent-message" class="zA" data-legacy-thread-id="abc123"><td class="yX"><div class="yW"><span email="maya@fixture.test">Maya</span></div></td><td><span class="bog">Proposal</span></td></tr>
      </tbody></table></div>
    </body></html>` }));
  const gmail = await app.context.newPage();
  await gmail.goto('https://mail.google.com/mail/u/0/#drafts');
  // The sent row proves the real content script has loaded its cache and painted.
  await expect(gmail.locator('#sent-message .gi-track-btn')).toHaveAttribute('data-state', 'opened');
  await expect(gmail.locator('#draft-thread .gi-track-slot, #draft-subject .gi-track-slot')).toHaveCount(0);
  await expect(gmail.locator('h2 + .gi-track-slot')).toHaveCount(0);
  await expect(gmail.locator('[data-gi-tracking-id]')).toHaveCount(1);
});
