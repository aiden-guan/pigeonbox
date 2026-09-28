/**
 * @vitest-environment jsdom
 */
import { DEFAULT_SETTINGS, toPublicSettings, type ExtensionSettings } from '@pigeonbox/shared';
import { describe, expect, it, vi } from 'vitest';
import {
  attachSdkComposeTracking,
  DRAFT_READY_TIMEOUT_MS,
  getComposeSession,
  listComposeSessions,
  resetComposeSessionsForTests,
  type ComposeTrackingDeps,
} from './compose-tracking';
import { GmailComposeSendHarness } from './gmail-send-harness';
import { decidePresending, createTrackingSession } from './tracking-session';

const settings: ExtensionSettings = {
  ...DEFAULT_SETTINGS,
  trackingEnabled: true,
  trackOpens: true,
  trackLinks: true,
  trackerBaseUrl: 'https://track.example',
  personalApiToken: 'token',
};

function deps(overrides: Partial<ComposeTrackingDeps> = {}): ComposeTrackingDeps & { created: number; sent: Array<{ trackingId: string }>; cancelled: string[] } {
  const state = { created: 0, sent: [] as Array<{ trackingId: string }>, cancelled: [] as string[] };
  const api: ComposeTrackingDeps & typeof state = {
    ...state,
    getSettings: () => settings,
    refreshSettings: async () => undefined,
    createTracked: async () => {
      api.created += 1;
      const id = `trk_${api.created}`;
      return {
        tracking_id: id,
        pixel_url: `https://track.example/open/${id}`,
        status: 'PENDING',
        created_at: '2026-09-23T12:00:00.000Z',
        sent_at: null,
        rewritten_links: [],
      };
    },
    markSent: (patch) => {
      api.sent.push(patch);
    },
    cancelTracked: (trackingId) => {
      api.cancelled.push(trackingId);
    },
    syncLinks: () => undefined,
    ...overrides,
  };
  return api;
}

describe('compose tracking sessions', () => {
  it('waits for a recipient and allocates one tracker', async () => {
    resetComposeSessionsForTests();
    const gmail = new GmailComposeSendHarness('new');
    const tracking = deps();
    const id = attachSdkComposeTracking(gmail.view(), tracking);
    await vi.waitFor(() => expect(getComposeSession(id)?.state).toBe('WAITING_FOR_RECIPIENTS'));
    expect(tracking.created).toBe(0);
    gmail.recipients = [{ emailAddress: 'a@b.com' }];
    gmail.emit('recipientsChanged');
    await vi.waitFor(() => expect(getComposeSession(id)?.trackingId).toBe('trk_1'));
    gmail.subject = 'Changed';
    gmail.emit('subjectChanged');
    gmail.emit('recipientsChanged');
    await vi.waitFor(() => expect(tracking.created).toBe(1));
    expect(getComposeSession(id)?.state).toBe('WAITING_FOR_DRAFT');
  });

  it('keeps reply, forward, and a second compose on separate trackers', async () => {
    resetComposeSessionsForTests();
    const reply = new GmailComposeSendHarness('reply');
    const forward = new GmailComposeSendHarness('forward');
    reply.recipients = [{ emailAddress: 'a@b.com' }];
    forward.recipients = [{ emailAddress: 'c@d.com' }];
    reply.setDraftId('draft-reply');
    forward.setDraftId('draft-forward');
    const tracking = deps();
    const replyId = attachSdkComposeTracking(reply.view(), tracking);
    const forwardId = attachSdkComposeTracking(forward.view(), tracking);
    await vi.waitFor(() => expect(getComposeSession(replyId)?.modifierRegistered).toBe(true));
    await vi.waitFor(() => expect(getComposeSession(forwardId)?.modifierRegistered).toBe(true));
    expect(getComposeSession(replyId)?.kind).toBe('reply');
    expect(getComposeSession(forwardId)?.kind).toBe('forward');
    expect(getComposeSession(replyId)?.trackingId).not.toBe(getComposeSession(forwardId)?.trackingId);
    expect(listComposeSessions()).toHaveLength(2);
    const replySend = await reply.deliverSend('<p>Reply <a href="https://example.com/a">a</a></p>');
    const forwardSend = await forward.deliverSend('<p>FYI <a href="https://example.com/b">b</a></p>');
    expect(replySend.body).toContain(`/open/${getComposeSession(replyId)?.trackingId}`);
    expect(forwardSend.body).toContain(`/open/${getComposeSession(forwardId)?.trackingId}`);
    expect(replySend.body).not.toContain(`/open/${getComposeSession(forwardId)?.trackingId}`);
    expect(forwardSend.body).not.toContain(`/open/${getComposeSession(replyId)?.trackingId}`);
  });

  it('drops the session when the compose is discarded', async () => {
    resetComposeSessionsForTests();
    const gmail = new GmailComposeSendHarness();
    gmail.recipients = [{ emailAddress: 'a@b.com' }];
    const tracking = deps();
    const id = attachSdkComposeTracking(gmail.view(), tracking);
    await vi.waitFor(() => expect(getComposeSession(id)?.trackingId).toBe('trk_1'));
    gmail.emit('destroy');
    expect(getComposeSession(id)).toBeUndefined();
    expect(tracking.cancelled).toEqual(['trk_1']);
  });

  it('does not mark the modifier registered when Gmail has no draft id', async () => {
    resetComposeSessionsForTests();
    const gmail = new GmailComposeSendHarness();
    gmail.recipients = [{ emailAddress: 'a@b.com' }];
    gmail.failNextRegistrations(1);
    gmail.setDraftId('draft-1');
    const id = attachSdkComposeTracking(gmail.view(), deps());
    await vi.waitFor(() => expect(getComposeSession(id)?.trackingId).toBe('trk_1'));
    expect(getComposeSession(id)?.modifierRegistered).toBe(false);
    expect(gmail.modifierCount()).toBe(0);
    gmail.emit('draftSaved');
    await vi.waitFor(() => expect(getComposeSession(id)?.modifierRegistered).toBe(true));
    expect(getComposeSession(id)?.gmailDraftId).toBe('draft-1');
  });
});

describe('gmail send interception', () => {
  it('injects the tracking pixel into the final outbound Gmail send payload', async () => {
    resetComposeSessionsForTests();
    const gmail = new GmailComposeSendHarness();
    gmail.subject = 'Tracking proof 9f3a';
    gmail.recipients = [{ emailAddress: 'person@example.com' }];
    gmail.cc = [{ emailAddress: 'other@example.com' }];
    gmail.setDraftId('msg-a:draft_9f3a');
    const body = gmail.view().getBodyElement();
    const before = body?.innerHTML || '';
    const tracking = deps();
    const id = attachSdkComposeTracking(gmail.view(), tracking);
    await vi.waitFor(() => expect(getComposeSession(id)?.modifierRegistered).toBe(true));
    expect(body?.innerHTML).toBe(before);
    expect(document.documentElement.innerHTML).not.toContain('/open/trk_');

    let cancelled = false;
    gmail.emit('presending', {
      cancel: () => {
        cancelled = true;
      },
    });
    expect(cancelled).toBe(false);

    const outbound = '<div>Hello <a href="https://example.com/docs">docs</a><img src="https://cdn.example/a.png"></div>';
    const payload = await gmail.deliverSend(outbound, false);
    expect(payload.invoked).toBe(true);
    expect(payload.body).toContain('https://track.example/open/trk_1');
    expect(payload.body.match(/\/open\/trk_1/g)).toHaveLength(1);
    expect(payload.body).toContain('https://track.example/c/');
    expect(payload.body).not.toContain('href="https://example.com/docs"');
    expect(payload.body).toContain('https://cdn.example/a.png');
    expect(payload.body).toContain('Hello');
    expect(body?.innerHTML).toBe(before);
    expect(getComposeSession(id)?.modifierInvocationCount).toBe(1);
    expect(getComposeSession(id)?.modifierSawPixel).toBe(true);

    const again = await gmail.deliverSend(payload.body, false);
    expect(again.body.match(/\/open\/trk_1/g)).toHaveLength(1);

    gmail.emit('sent', {
      getMessageID: async () => 'msg-f:sent-1',
      getThreadID: async () => 'thread-f:thread-1',
    });
    await vi.waitFor(() => expect(tracking.sent).toHaveLength(1));
    expect(tracking.sent[0]).toMatchObject({
      trackingId: 'trk_1',
      status: 'SENT',
      gmail_message_id: 'sent-1',
      gmail_thread_id: 'thread-1',
      recipients: ['person@example.com', 'other@example.com'],
    });
    expect(tracking.sent[0]?.sent_at).toEqual(expect.any(String));
  });

  it('leaves a true plain-text body unchanged', async () => {
    resetComposeSessionsForTests();
    const gmail = new GmailComposeSendHarness();
    gmail.recipients = [{ emailAddress: 'a@b.com' }];
    gmail.setDraftId('draft-plain');
    const id = attachSdkComposeTracking(gmail.view(), deps());
    await vi.waitFor(() => expect(getComposeSession(id)?.modifierRegistered).toBe(true));
    const payload = await gmail.deliverSend('Hi <there>', true);
    expect(payload.invoked).toBe(true);
    expect(payload.body).toBe('Hi <there>');
    expect(payload.body).not.toContain('/open/');
    expect(getComposeSession(id)?.lastError).toMatch(/Plain-text/);
  });

  it('registers after the draft appears and does not cancel a ready send', async () => {
    resetComposeSessionsForTests();
    const gmail = new GmailComposeSendHarness();
    gmail.recipients = [{ emailAddress: 'a@b.com' }];
    const id = attachSdkComposeTracking(gmail.view(), deps());
    await vi.waitFor(() => expect(getComposeSession(id)?.trackingId).toBe('trk_1'));
    expect(getComposeSession(id)?.modifierRegistered).toBe(false);
    const early = await gmail.deliverSend('<p>Hi</p>');
    expect(early.invoked).toBe(false);
    expect(early.body).toBe('<p>Hi</p>');
    gmail.setDraftId('draft-later');
    gmail.emit('draftSaved');
    await vi.waitFor(() => expect(getComposeSession(id)?.modifierRegistered).toBe(true));
    const payload = await gmail.deliverSend('<p>Hi</p>');
    expect(payload.invoked).toBe(true);
    expect(payload.body).toContain('/open/trk_1');
  });

  it('cancels send once to bind the modifier, then lets the retried send through', async () => {
    resetComposeSessionsForTests();
    const gmail = new GmailComposeSendHarness();
    gmail.recipients = [{ emailAddress: 'a@b.com' }];
    const id = attachSdkComposeTracking(gmail.view(), deps());
    await vi.waitFor(() => expect(getComposeSession(id)?.trackingId).toBe('trk_1'));
    const cancels: boolean[] = [];
    gmail.emit('presending', {
      cancel: () => {
        cancels.push(true);
      },
    });
    expect(cancels).toEqual([true]);
    expect(gmail.sendCalls).toBe(0);
    gmail.setDraftId('draft-recover');
    await vi.waitFor(() => expect(gmail.sendCalls).toBe(1));
    expect(getComposeSession(id)?.modifierRegistered).toBe(true);
    expect(cancels).toEqual([true]);
    const payload = await gmail.deliverSend('<p>Recovered</p>');
    expect(payload.body).toContain('/open/trk_1');
  });

  it('sends without a pixel when the draft id never appears', async () => {
    resetComposeSessionsForTests();
    vi.useFakeTimers();
    try {
      const gmail = new GmailComposeSendHarness();
      gmail.recipients = [{ emailAddress: 'a@b.com' }];
      const id = attachSdkComposeTracking(gmail.view(), deps());
      await vi.advanceTimersByTimeAsync(0);
      expect(getComposeSession(id)?.trackingId).toBe('trk_1');
      gmail.emit('presending', { cancel: () => undefined });
      await vi.advanceTimersByTimeAsync(DRAFT_READY_TIMEOUT_MS + 50);
      expect(gmail.sendCalls).toBe(1);
      expect(getComposeSession(id)?.modifierRegistered).toBe(false);
      expect(getComposeSession(id)?.lastError).toMatch(/without a pixel/);
      const payload = await gmail.deliverSend('<p>Untracked</p>');
      expect(payload.invoked).toBe(false);
      expect(payload.body).toBe('<p>Untracked</p>');
    } finally {
      vi.useRealTimers();
      resetComposeSessionsForTests();
    }
  });

  it('does not rebind the modifier when the draft id changes after registration', async () => {
    resetComposeSessionsForTests();
    const gmail = new GmailComposeSendHarness();
    gmail.recipients = [{ emailAddress: 'a@b.com' }];
    gmail.setDraftId('draft-first');
    const id = attachSdkComposeTracking(gmail.view(), deps());
    await vi.waitFor(() => expect(getComposeSession(id)?.modifierRegistered).toBe(true));
    expect(gmail.modifierCount()).toBe(1);
    gmail.setDraftId('draft-second');
    gmail.emit('draftSaved');
    await vi.waitFor(() => expect(getComposeSession(id)?.lastError).toMatch(/Draft id changed/));
    expect(gmail.modifierCount()).toBe(1);
    expect(getComposeSession(id)?.gmailDraftId).toBe('draft-first');
    const payload = await gmail.deliverSend('<p>Moved</p>');
    expect(payload.invoked).toBe(false);
    expect(payload.body).toBe('<p>Moved</p>');
  });

  it('does not loop when presending recovery calls send', () => {
    const session = createTrackingSession({
      composeSessionId: 'c1',
      kind: 'new',
      trackOpens: true,
      trackLinks: true,
    });
    expect(decidePresending(session, true)).toBe('recover');
    session.sendRecoveryAttempted = true;
    expect(decidePresending(session, true)).toBe('allow');
    session.sendRecoveryAttempted = false;
    session.modifierRegistered = true;
    session.trackingId = 'trk_1';
    session.pixelUrl = 'https://track.example/open/trk_1';
    expect(decidePresending(session, true)).toBe('allow');
  });

  it('works with PublicExtensionSettings without secrets exposed', async () => {
    resetComposeSessionsForTests();
    const gmail = new GmailComposeSendHarness('new');
    const fullSettings: ExtensionSettings = {
      ...DEFAULT_SETTINGS,
      trackingEnabled: true,
      trackOpens: true,
      trackLinks: true,
      trackerBaseUrl: 'https://track.example',
      personalApiToken: 'super-secret-token',
      aiApiKey: 'super-secret-ai-key',
    };
    const publicSettings = toPublicSettings(fullSettings);
    // Ensure secrets are not present
    expect((publicSettings as Record<string, unknown>).personalApiToken).toBeUndefined();
    expect((publicSettings as Record<string, unknown>).aiApiKey).toBeUndefined();
    expect(publicSettings.hasPersonalApiToken).toBe(true);

    const tracking = deps({
      getSettings: () => publicSettings,
    });
    const id = attachSdkComposeTracking(gmail.view(), tracking);
    gmail.recipients = [{ emailAddress: 'recipient@example.com' }];
    gmail.emit('recipientsChanged');
    await vi.waitFor(() => expect(getComposeSession(id)?.trackingId).toBe('trk_1'));
    expect(tracking.created).toBe(1);
  });
});
