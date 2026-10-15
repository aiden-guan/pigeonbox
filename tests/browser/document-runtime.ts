import { attachDocumentAction, documentActionForCompose } from '../../apps/extension/src/content/compose/documents';
import { installSentStatus } from '../../apps/extension/src/content/tracking/sent-status';
import type { SdkComposeView } from '../../apps/extension/src/content/tracking/compose-tracking';

document.body.style.cssText = 'padding:40px;font:14px Arial;background:#f6f5f2;';
document.body.innerHTML = '<main role="main" data-thread-perm-id="abc123"><h2 class="hP">Proposal</h2><section id="compose" style="background:white;max-width:560px;padding:24px"><div contenteditable="true" aria-label="Message Body" style="min-height:140px">Here is the proposal.</div></section></main>';
const compose = document.getElementById('compose')!;
const body = compose.querySelector<HTMLElement>('[contenteditable]')!;
const events = new Map<string, (event?: any) => void>();
const view: SdkComposeView = {
  getElement: () => compose,
  getBodyElement: () => body,
  on: (event, callback) => { events.set(event, callback); },
};
attachDocumentAction(view, () => true);
// Stands in for "Track PDF…" in the tracking menu beside Send.
const trackPdf = Object.assign(document.createElement('button'), { textContent: 'Track PDF' });
trackPdf.addEventListener('click', () => documentActionForCompose(compose)?.());
compose.append(trackPdf);
const send = Object.assign(document.createElement('button'), { textContent: 'Simulate Gmail send' });
send.addEventListener('click', () => {
  let canceled = false;
  events.get('presending')?.({ cancel: () => { canceled = true; } });
  if (canceled) return;
  events.get('sent')?.({ getThreadID: async () => 'abc123' });
  document.body.dataset.sent = 'true';
});
compose.append(send);
installSentStatus({
  emails: [{ trackingId: 'trk_pdf', subject: 'Proposal', sender: 'owner@fixture.test', recipients: ['maya@fixture.test'], gmailThreadId: 'abc123', gmailMessageId: 'abcd', sentAt: '2026-10-01T12:00:00.000Z', firstOpenedAt: null, lastOpenedAt: null, openCount: 0, clickCount: 0, notifyIfNoReply: false }],
  onNotify: () => undefined,
  loadDocumentActivity: async threadId => {
    const reply = await chrome.runtime.sendMessage({ type: 'CLOUD_DOCUMENT_ACTIVITY', threadId });
    return (reply?.events ?? []).map((event: { type: string; at: string; explanation: string }) => ({ type: event.type === 'document_view' ? 'DOCUMENT_VIEW' as const : 'DOCUMENT_DOWNLOAD' as const, timestamp: event.at, detail: event.explanation }));
  },
});
