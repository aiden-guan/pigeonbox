import { attachPlaceholderGuard } from '../../apps/extension/src/content/shell/placeholder-guard';
import { DEFAULT_SETTINGS } from '../../packages/shared/src/index';
import { attachSdkComposeTracking } from '../../apps/extension/src/content/tracking/compose-tracking';
import { GmailComposeSendHarness } from '../../apps/extension/src/content/tracking/gmail-send-harness';
import { activeBrainChecks, attachComposeBrainChecks, type BrainCheckReply } from '../../apps/extension/src/content/compose/brain-checks';

// Real compose code (tracking, placeholder guard, real-time Pidgy checks) on one controlled
// InboxSDK compose. Checks go through the real extension worker and Cloud client to the fixture API.
const compose = new GmailComposeSendHarness('new');
const emptyCompose = new URL(location.href).searchParams.has('empty-compose');
compose.recipients = emptyCompose ? [] : [{ emailAddress: 'alex@fixture.test' }];
compose.subject = emptyCompose ? '' : 'Coffee';
compose.setDraftId('abc777');
compose.element.id = 'brain-compose';
compose.element.style.cssText = 'box-sizing:border-box;width:560px;max-width:100%;padding:8px;background:white;border:1px solid #ddd;';
const body = compose.view().getBodyElement()!;
body.setAttribute('contenteditable', 'true');
body.setAttribute('role', 'textbox');
body.style.cssText = 'min-height:120px;outline:none;font:14px Arial';
body.innerHTML = '';
const scroller = document.createElement('div');
scroller.className = 'M9';
scroller.style.cssText = 'max-height:260px;overflow:auto';
scroller.append(body);
compose.element.prepend(scroller);
compose.element.querySelector('[data-tooltip="Send"]')!.remove();
const toolbar = document.createElement('table');
toolbar.style.width = '100%';
toolbar.innerHTML = '<tbody><tr><td><div role="group" style="display:inline-flex;white-space:nowrap;align-items:center"><button aria-label="Send" style="height:36px">Send</button></div></td><td style="width:100%"><button data-native-tool aria-label="Formatting options" style="height:36px">A</button></td></tr></tbody>';
compose.element.append(toolbar);
document.body.append(compose.element);

attachSdkComposeTracking(compose.view(), {
  getSettings: () => ({ ...DEFAULT_SETTINGS, trackingEnabled: true, trackOpens: true, trackLinks: true, trackerBaseUrl: 'https://track.fixture.test', personalApiToken: 'synthetic' }),
  refreshSettings: async () => undefined,
  createTracked: async () => ({ tracking_id: 'trk_brain', pixel_url: 'https://track.fixture.test/open/trk_brain', status: 'PENDING', created_at: new Date().toISOString(), sent_at: null, rewritten_links: [] }),
  markSent: () => undefined,
  cancelTracked: () => undefined,
  registerLinks: async () => true,
  reportDiagnostics: (session) => {
    document.body.dataset.tracking = session.state;
  },
});
attachPlaceholderGuard(compose.view(), () => false);
attachComposeBrainChecks(compose.view(), {
  available: () => true,
  check: (check) => chrome.runtime.sendMessage({ type: 'CLOUD_COMPOSE_CHECK', check }) as Promise<BrainCheckReply | undefined>,
  mailbox: () => 'owner@fixture.test',
});
document.body.dataset.brainChecks = String(activeBrainChecks());

const close = document.createElement('button');
close.textContent = 'Close compose';
document.body.append(close);
// Gmail fires destroy when a compose closes. The element stays here so the test can prove listeners are gone.
close.onclick = () => {
  compose.emit('destroy');
  document.body.dataset.brainChecks = String(activeBrainChecks());
};
const placeholder = document.createElement('button');
placeholder.textContent = 'Try sending placeholder';
document.body.append(placeholder);
placeholder.onclick = () => {
  const before = body.innerHTML;
  body.textContent = 'The price is [CONFIRM PRICE].';
  let blocked = false;
  compose.emit('presending', { cancel: () => { blocked = true; } });
  body.innerHTML = before;
  placeholder.textContent = blocked ? 'Placeholder send blocked' : 'Placeholder escaped';
};
