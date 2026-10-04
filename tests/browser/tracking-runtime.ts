import { attachPlaceholderGuard } from '../../apps/extension/src/content/shell/placeholder-guard';
import { DEFAULT_SETTINGS } from '../../packages/shared/src/index';
import {
  attachSdkComposeTracking,
  getComposeSession,
} from '../../apps/extension/src/content/tracking/compose-tracking';
import { GmailComposeSendHarness } from '../../apps/extension/src/content/tracking/gmail-send-harness';
import { decideTrackedOpen, deriveTrackingStats, deriveTrackingTimeline } from '../../packages/tracking/src/lifecycle';

// Real compose/tracking code, with a controlled InboxSDK and transport boundary.
const compose = new GmailComposeSendHarness('reply');
compose.recipients = [{ emailAddress: 'recipient@fixture.test' }];
compose.threadId = 'abc123';
compose.setDraftId('abc999');
compose.element.id = 'tracking-compose';
compose.element.style.cssText = 'box-sizing:border-box;width:520px;max-width:100%;padding:8px;background:white;';
const bodyRoot = document.createElement('div');
bodyRoot.className = 'M9';
bodyRoot.append(compose.view().getBodyElement()!);
compose.element.prepend(bodyRoot);
const nativeSend = compose.element.querySelector<HTMLElement>('[data-tooltip="Send"]')!;
const toolbar = document.createElement('table');
toolbar.style.width = '100%';
toolbar.innerHTML = '<tbody><tr><td><div role="group" style="display:inline-flex;white-space:nowrap;align-items:center"><button aria-label="Send" style="height:36px">Send</button><button aria-label="Schedule send" style="height:36px">▾</button></div></td><td style="width:100%"><button data-native-tool aria-label="Attach file" style="height:36px">⌁</button></td></tr></tbody>';
nativeSend.remove();
compose.element.append(toolbar);
document.body.append(compose.element);
const sent = document.createElement('output');
sent.id = 'sent-state';
document.body.append(sent);
let allocations = 0;
const sessionId = attachSdkComposeTracking({ ...compose.view(), addStatusBar: ({ height }) => {
  const el = document.createElement('div');
  el.style.height = `${height}px`;
  toolbar.insertAdjacentElement('afterend', el);
  return { el, destroy: () => el.remove() };
} }, {
  getSettings: () => ({
    ...DEFAULT_SETTINGS,
    trackingEnabled: true,
    trackOpens: true,
    trackLinks: true,
    trackerBaseUrl: 'https://track.fixture.test',
    personalApiToken: 'synthetic',
  }),
  refreshSettings: async () => undefined,
  createTracked: async () => {
    allocations++;
    return {
      tracking_id: 'trk_fixture',
      pixel_url: 'https://track.fixture.test/open/trk_fixture',
      status: 'PENDING',
      created_at: new Date().toISOString(),
      sent_at: null,
      rewritten_links: [],
    };
  },
  markSent: () => {
    sent.textContent = 'Tracked send linked';
  },
  cancelTracked: () => undefined,
  registerLinks: async () => true,
  reportDiagnostics: (session) => {
    document.body.dataset.tracking = session.state;
    document.body.dataset.allocations = String(allocations);
  },
});
const send = document.createElement('button');
send.textContent = 'Send fixture';
document.body.append(send);
send.onclick = async () => {
  if (!getComposeSession(sessionId)?.modifierRegistered) return;
  compose.emit('presending', {
    cancel: () => {
      throw new Error('Registered send should proceed');
    },
  });
  const outbound = await compose.deliverSend('<p>Hello</p><a href="https://example.test/quote">Quote</a>');
  document.body.dataset.outboundPixel = String(outbound.invoked && outbound.body.includes('/open/trk_fixture'));
  compose.emit('sent', { getMessageID: async () => 'abc111', getThreadID: async () => 'abc123' });
};
const inspect = document.createElement('button');
inspect.textContent = 'Inspect self and recipient opens';
document.body.append(inspect);
inspect.onclick = () => {
  const sentAt = Date.now() - 60000;
  const proxy = 'Mozilla/5.0 AppleWebKit/537.36 GoogleImageProxy';
  const self = decideTrackedOpen({ eventTs: sentAt + 30000, sentAt, userAgent: proxy, proxySuppression: 'consume' });
  const recipient = decideTrackedOpen({ eventTs: sentAt + 40000, sentAt, userAgent: proxy, proxySuppression: 'none' });
  const events = [
    {
      type: 'OPEN',
      timestamp: new Date(sentAt + 30000).toISOString(),
      classification: self.classification,
      userAgent: proxy,
    },
    {
      type: 'OPEN',
      timestamp: new Date(sentAt + 40000).toISOString(),
      classification: recipient.classification,
      userAgent: proxy,
    },
  ];
  const output = document.createElement('output');
  output.id = 'timeline';
  output.textContent = `${deriveTrackingStats(events).openCount} likely open · ${deriveTrackingTimeline(events).length} timeline event · sender suppressed ${!self.countsAsOpen}`;
  document.body.append(output);
};

const placeholder = new GmailComposeSendHarness('reply');
placeholder.view().getBodyElement()!.textContent = 'The price is [CONFIRM PRICE].';
attachPlaceholderGuard(placeholder.view(), () => false);
const check = document.createElement('button'); check.textContent = 'Try sending placeholder'; document.body.append(check);
check.onclick = () => { let blocked = false; placeholder.emit('presending', { cancel: () => { blocked = true; } }); check.textContent = blocked ? 'Placeholder send blocked' : 'Placeholder escaped'; };
