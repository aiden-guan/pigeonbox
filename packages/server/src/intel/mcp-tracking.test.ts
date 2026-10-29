import { describe, expect, it, vi } from 'vitest';
import { base64UrlToBytes, parseRawMessage } from '../google/mime.js';
import { API } from '../testing.js';
import { connectedUser, createIntelHarness, deliverAndSync, type IntelHarness } from '../testing/intel-harness.js';
import { createTrackerHandler } from '../tracker.js';
import { SupabaseCloudStore } from '../store/supabase.js';
import { postgrestFetch } from '../testing/postgrest.js';
import { createIntelDeps } from './context.js';
import { prepareTrackedSend } from './mcp-tracking.js';

async function setup(tracker = 'https://t.test') {
  const h = await createIntelHarness({ env: { TRACKER_BASE_URL: tracker } });
  const user = await connectedUser(h, 'ada@work.test', ['mail_read', 'send']);
  const writer = await h.route<{ token: string }>('controlTokenCreate', user.token, { name: 'Claude', scopes: ['read', 'write'] });
  return { h, user, writer };
}

async function call(h: IntelHarness, token: string, name: string, args: Record<string, unknown>) {
  const response = await h.api(new Request(`${API}/v1/mcp`, { method: 'POST', headers: { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' }, body: JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'tools/call', params: { name, arguments: args } }) }));
  expect(response.status).toBe(200);
  return ((await response.json()) as { result: { isError: boolean; structuredContent: Record<string, any>; content: Array<{ text: string }> } }).result;
}

function htmlPart(raw: string) {
  const mime = new TextDecoder().decode(base64UrlToBytes(raw));
  expect(mime).toContain('multipart/alternative');
  const boundary = mime.match(/boundary="([^"]+)"/)![1]!;
  const part = mime.split(`--${boundary}`).find(p => p.includes('Content-Type: text/html'))!;
  return new TextDecoder().decode(Uint8Array.from(atob(part.split('\r\n\r\n')[1]!.replace(/\s+/g, '')), c => c.charCodeAt(0)));
}

const message = { to: ['lee@client.test'], subject: 'A useful tool', body: 'Hi Lee,\nSee https://example.com/demo?a=1&b=2.\nThanks!', idempotency_key: 'cold-email-00001' };

describe('MCP tracked sending', () => {
  it('reuses prepared links on retry against production uniqueness constraints', async () => {
    const { h, user } = await setup();
    const store = new SupabaseCloudStore('https://db.test', 'test-service-role', postgrestFetch(h.pg));
    const deps = createIntelDeps({ config: h.config, db: h.db, box: h.box, google: h.deps.intel!.google,
      inference: h.deps.inference, store, log: h.deps.log, now: h.now, fetch: h.deps.intel!.fetch, storage: h.storage });
    const input = { userId: user.userId, approvalId: crypto.randomUUID(), sender: 'ada@work.test',
      recipients: ['lee@client.test'], subject: 'Retry', body: 'See https://example.com/report', tracking: { opens: true, links: true } };
    const first = await prepareTrackedSend(deps, input);
    expect(await prepareTrackedSend(deps, input)).toEqual(first);
    expect(await h.sql(`select click_id from public.tracked_links where tracking_id = $1`, [first!.trackingId])).toHaveLength(1);
    expect(h.google.account('ada@work.test').sent).toHaveLength(0);
  });
  it('sends the edited, approved MIME with a pixel and links, links the receipt, and measures real tracker requests', async () => {
    const { h, user, writer } = await setup();
    const requested = await call(h, writer.token, 'request_send', message);
    const approvalId = requested.structuredContent.approvalId;
    expect(requested.structuredContent).toMatchObject({ decision: 'approval_required', tracking: { opens: true, links: true } });
    expect(h.google.account('ada@work.test').sent).toHaveLength(0);
    expect(await h.store.trackerStoreFor(user.userId).listEmails(10)).toHaveLength(0);
    const edited = 'Hi Lee <script>alert("x")</script>\nPlease see https://example.com/new?a=1&b=2.\n你好 👋';
    await h.route('approvalDecide', user.token, { id: approvalId, decision: 'approve', edits: { body: edited }, idempotencyKey: 'approve-tracked-001' });
    await h.drain();
    const sent = h.google.account('ada@work.test').sent;
    expect(sent).toHaveLength(1);
    expect(parseRawMessage(sent[0]!).body).toBe(edited);
    const html = htmlPart(sent[0]!);
    expect(html).toContain('&lt;script&gt;');
    expect(html).not.toContain('<script>');
    expect(html).toContain('你好 👋');
    expect(html.match(/<img\b/g)).toHaveLength(1);
    expect(html).not.toContain('/demo');
    const status = (await call(h, writer.token, 'get_send_status', { approval_id: approvalId })).structuredContent;
    expect(status).toMatchObject({ status: 'executed', trackingStatus: 'SENT' });
    expect(status.gmailMessageId).toBeTruthy();
    expect(status.gmailThreadId).toBeTruthy();
    expect(html).toContain(`/open/${status.trackingId}`);
    const href = html.match(/href="(https:\/\/t.test\/c\/[^"]+)"/)![1]!;
    const store = h.store.trackerStoreFor(user.userId);
    await store.updateEmail(status.trackingId, { sent_at: new Date(Date.now() - 600_000).toISOString() });
    const tracker = createTrackerHandler({ config: h.config, store: h.store, auth: h.deps.auth, log: h.deps.log });
    const headers = { 'User-Agent': 'Mozilla/5.0 AppleWebKit/537.36 Chrome/130 Safari/537.36', 'CF-Connecting-IP': '203.0.113.9' };
    const pixel = await tracker(new Request(`https://t.test/open/${status.trackingId}`, { headers }));
    expect(pixel.headers.get('Content-Type')).toContain('image/gif');
    const click = await tracker(new Request(href, { headers }));
    expect(click.headers.get('Location')).toBe('https://example.com/new?a=1&b=2');
    const activity = (await call(h, writer.token, 'get_tracked_email', { tracking_id: status.trackingId })).structuredContent;
    expect(activity).toMatchObject({ status: 'SENT', opens: 1, clicks: 1 });
    expect(activity.events).toHaveLength(2);
    expect(JSON.stringify(activity)).not.toMatch(/user_agent|ip_hash|203\.0\.113/);
    // Reading activity never makes another public tracking hit.
    await call(h, writer.token, 'get_tracked_email', { tracking_id: status.trackingId });
    expect(await store.listEvents(status.trackingId)).toHaveLength(2);
    await call(h, writer.token, 'request_send', { ...message, body: 'retry must not change approved text' });
    await h.drain();
    expect(sent).toHaveLength(1);
    expect(await store.listEmails(10)).toHaveLength(1);
  });

  it.each(['reject', 'expire'] as const)('never allocates tracking or sends when an approval is %s', async (decision) => {
    const { h, user, writer } = await setup();
    const { approvalId } = (await call(h, writer.token, 'request_send', message)).structuredContent;
    if (decision === 'reject') await h.route('approvalDecide', user.token, { id: approvalId, decision: 'reject', idempotencyKey: 'reject-tracked-01' });
    else await h.sql(`update public.approvals set expires_at = now() - interval '1 minute' where id = $1`, [approvalId]);
    await h.drain();
    expect(h.google.account('ada@work.test').sent).toHaveLength(0);
    expect(await h.store.trackerStoreFor(user.userId).listEmails(10)).toHaveLength(0);
  });

  it('refuses missing configuration and allows an explicit untracked send', async () => {
    const { h, user, writer } = await setup('');
    expect((await call(h, writer.token, 'request_send', message)).isError).toBe(true);
    expect(await h.sql('select id from public.approvals')).toHaveLength(0);
    const { approvalId } = (await call(h, writer.token, 'request_send', { ...message, track_opens: false, track_links: false })).structuredContent;
    await h.route('approvalDecide', user.token, { id: approvalId, decision: 'approve', idempotencyKey: 'untracked-approve' });
    await h.drain();
    const raw = h.google.account('ada@work.test').sent[0]!;
    expect(parseRawMessage(raw).body).toBe(message.body);
    expect(new TextDecoder().decode(base64UrlToBytes(raw))).not.toContain('multipart/alternative');
    expect(await h.store.trackerStoreFor(user.userId).listEmails(10)).toHaveLength(0);
  });

  it('handles click-only tracking without a pixel and leaves unsubscribe links alone', async () => {
    const { h, user, writer } = await setup();
    const body = 'See https://example.com/path_(test). Unsubscribe: https://example.com/unsubscribe?id=123';
    const { approvalId } = (await call(h, writer.token, 'request_send', { ...message, body, track_opens: false })).structuredContent;
    await h.route('approvalDecide', user.token, { id: approvalId, decision: 'approve', idempotencyKey: 'click-only-approve' });
    await h.drain();
    const html = htmlPart(h.google.account('ada@work.test').sent[0]!);
    expect(html).not.toContain('<img');
    expect(html).toContain('https://t.test/c/clk_');
    expect(html).toContain('href="https://example.com/unsubscribe?id=123"');
    expect(parseRawMessage(h.google.account('ada@work.test').sent[0]!).body).toBe(body);
  });

  it('keeps send receipts and engagement private between users', async () => {
    const { h, user, writer } = await setup();
    const { approvalId } = (await call(h, writer.token, 'request_send', message)).structuredContent;
    await h.route('approvalDecide', user.token, { id: approvalId, decision: 'approve', idempotencyKey: 'owner-approve-001' });
    await h.drain();
    const { trackingId } = (await call(h, writer.token, 'get_send_status', { approval_id: approvalId })).structuredContent;
    const bob = await connectedUser(h, 'bob@other.test');
    const reader = await h.route<{ token: string }>('controlTokenCreate', bob.token, { name: 'Bob', scopes: ['read'] });
    expect((await call(h, reader.token, 'get_send_status', { approval_id: approvalId })).isError).toBe(true);
    expect((await call(h, reader.token, 'get_tracked_email', { tracking_id: trackingId })).isError).toBe(true);
  });

  it('recovers tracker bookkeeping without sending again after Gmail succeeds', async () => {
    const { h, user, writer } = await setup();
    const { approvalId } = (await call(h, writer.token, 'request_send', message)).structuredContent;
    const store = h.store.trackerStoreFor(user.userId);
    const update = store.updateEmail.bind(store);
    let fail = true;
    vi.spyOn(store, 'updateEmail').mockImplementation(async (id, patch) => {
      if (patch.status === 'SENT' && fail) { fail = false; throw new Error('Temporary tracker failure'); }
      return update(id, patch);
    });
    await h.route('approvalDecide', user.token, { id: approvalId, decision: 'approve', idempotencyKey: 'recover-approve-01' });
    await h.drain();
    h.advance(3_600_000);
    await h.drain();
    expect(h.google.account('ada@work.test').sent).toHaveLength(1);
    expect((await call(h, writer.token, 'get_send_status', { approval_id: approvalId })).structuredContent).toMatchObject({ status: 'executed', trackingStatus: 'SENT' });
  });

  it('reports uncertain delivery and never resends after Gmail accepts but its response is lost', async () => {
    const { h, user, writer } = await setup();
    const original = h.deps.intel!.fetch;
    h.deps.intel!.fetch = async (input, init) => {
      const response = await original(input, init);
      if (String(input).endsWith('/messages/send')) throw new Error('Response lost after acceptance');
      return response;
    };
    const { approvalId } = (await call(h, writer.token, 'request_send', message)).structuredContent;
    await h.route('approvalDecide', user.token, { id: approvalId, decision: 'approve', idempotencyKey: 'uncertain-approve' });
    await h.drain();
    expect(h.google.account('ada@work.test').sent).toHaveLength(1);
    expect((await call(h, writer.token, 'get_send_status', { approval_id: approvalId })).structuredContent).toMatchObject({ deliveryStatus: 'unconfirmed', trackingStatus: 'PENDING', gmailMessageId: null });
    await call(h, writer.token, 'request_send', message);
    await h.drain();
    expect(h.google.account('ada@work.test').sent).toHaveLength(1);
  });

  it('stops visibly before sending if tracking configuration disappears after approval', async () => {
    const { h, user, writer } = await setup();
    const { approvalId } = (await call(h, writer.token, 'request_send', message)).structuredContent;
    await h.route('approvalDecide', user.token, { id: approvalId, decision: 'approve', idempotencyKey: 'missing-config-approve' });
    h.config.intel.trackerBaseUrl = undefined;
    await h.drain();
    expect(h.google.account('ada@work.test').sent).toHaveLength(0);
    expect((await call(h, writer.token, 'get_send_status', { approval_id: approvalId })).structuredContent).toMatchObject({ status: 'failed', result: { code: 'not_configured' } });
  });

  it('preserves Gmail reply headers and requires a sender when several mailboxes are connected', async () => {
    const { h, user, writer } = await setup();
    const { threadId } = await deliverAndSync(h, 'ada@work.test', { from: 'lee@client.test', to: ['ada@work.test'], subject: message.subject, body: 'Tell me more.' });
    const parent = (await h.sql<{ rfc822_message_id: string }>('select rfc822_message_id from public.message_metadata order by internal_date desc limit 1'))[0];
    const { approvalId } = (await call(h, writer.token, 'request_send', { ...message, thread_id: threadId })).structuredContent;
    await h.route('approvalDecide', user.token, { id: approvalId, decision: 'approve', idempotencyKey: 'reply-approve-001' });
    await h.drain();
    const parsed = parseRawMessage(h.google.account('ada@work.test').sent[0]!);
    expect(parsed.headers['in-reply-to']).toBe(parent?.rfc822_message_id);
    expect(parsed.headers.references).toBe(parent?.rfc822_message_id);
    h.google.addAccount('other@work.test');
    await h.connect(user.token, 'other@work.test', ['mail_read', 'send']);
    const denied = await call(h, writer.token, 'request_send', { ...message, idempotency_key: 'ambiguous-sender-01' });
    expect(denied.isError).toBe(true);
    expect(denied.content[0]!.text).toContain('mailbox');
  });
});
