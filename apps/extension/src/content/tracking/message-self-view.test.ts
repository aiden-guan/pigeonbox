/**
 * @vitest-environment jsdom
 */
import { describe, expect, it, vi } from 'vitest';
import type { TrackedEmailSummary } from '@pigeonbox/tracking';
import { buildSelfViewEventId, createMessageSelfViewHandler, type InboxSdkMessageViewLike } from './message-self-view';

type MockMessageViewOptions = {
  id?: string;
  loaded?: boolean;
  state?: 'EXPANDED' | 'COLLAPSED' | 'HIDDEN';
  threadId?: string;
  bodyHtml?: string;
};

function createMockMessageView(opts: MockMessageViewOptions = {}): InboxSdkMessageViewLike & {
  emit: (event: string, payload?: any) => void;
  setState: (next: 'EXPANDED' | 'COLLAPSED' | 'HIDDEN') => void;
  setLoaded: (loaded: boolean) => void;
} {
  let isLoaded = opts.loaded ?? true;
  let viewState = opts.state ?? 'COLLAPSED';
  const listeners = new Map<string, Array<(payload?: any) => void>>();

  const mv: InboxSdkMessageViewLike & {
    emit: (event: string, payload?: any) => void;
    setState: (next: 'EXPANDED' | 'COLLAPSED' | 'HIDDEN') => void;
    setLoaded: (loaded: boolean) => void;
  } = {
    isLoaded: () => isLoaded,
    getViewState: () => viewState,
    getMessageIDAsync: async () => {
      if (!isLoaded) throw new Error('tried to get message id before message is loaded');
      return opts.id || 'msg-1';
    },
    getMessageID: () => {
      if (!isLoaded) throw new Error('tried to get message id before message is loaded');
      return opts.id || 'msg-1';
    },
    getBodyElement: () => {
      if (opts.bodyHtml == null) return null;
      const body = document.createElement('div');
      body.innerHTML = opts.bodyHtml;
      return body;
    },
    getThreadView: () => ({
      getThreadIDAsync: async () => opts.threadId || 'thread-1',
      getThreadID: () => opts.threadId || 'thread-1',
    }),
    on: (event, cb) => {
      const list = listeners.get(event) || [];
      list.push(cb);
      listeners.set(event, list);
    },
    emit: (event, payload) => {
      listeners.get(event)?.forEach((cb) => cb(payload));
    },
    setState: (next) => {
      const old = viewState;
      viewState = next;
      mv.emit('viewStateChange', { newViewState: next, oldViewState: old, messageView: mv });
    },
    setLoaded: (loaded) => {
      isLoaded = loaded;
      if (loaded) mv.emit('load', { messageView: mv });
    },
    destroyed: false,
  };

  return mv;
}

const trackedEmailA: TrackedEmailSummary = {
  trackingId: 'trk_A',
  subject: 'Message A',
  sender: 'me@example.com',
  recipients: ['alice@example.com'],
  gmailThreadId: 'thread_X',
  gmailMessageId: 'abc123',
  sentAt: '2026-09-24T10:00:00.000Z',
  firstOpenedAt: null,
  lastOpenedAt: null,
  openCount: 0,
  clickCount: 0,
  notifyIfNoReply: false,
};

const trackedEmailB: TrackedEmailSummary = {
  trackingId: 'trk_B',
  subject: 'Message B',
  sender: 'me@example.com',
  recipients: ['alice@example.com'],
  gmailThreadId: 'thread_X',
  gmailMessageId: 'def456',
  sentAt: '2026-09-24T12:00:00.000Z',
  firstOpenedAt: null,
  lastOpenedAt: null,
  openCount: 0,
  clickCount: 0,
  notifyIfNoReply: false,
};

describe('InboxSDK MessageView view-state and self-view integration', () => {
  // Case A: MessageView already loaded, state = COLLAPSED -> handler registers -> no SELF_VIEW -> viewStateChange to EXPANDED -> SELF_VIEW
  it('Case A: already loaded COLLAPSED does not fire SELF_VIEW until viewStateChange to EXPANDED', async () => {
    const onSelfView = vi.fn();
    const handler = createMessageSelfViewHandler({
      getEmails: () => [trackedEmailA],
      onSelfView,
    });

    const mv = createMockMessageView({ id: 'abc123', loaded: true, state: 'COLLAPSED' });
    handler.handleMessageView(mv);

    // Initial registration while COLLAPSED must not emit SELF_VIEW
    await vi.waitFor(() => expect(onSelfView).not.toHaveBeenCalled());

    // User expands the message view
    mv.setState('EXPANDED');

    await vi.waitFor(() => expect(onSelfView).toHaveBeenCalledTimes(1));
    expect(onSelfView).toHaveBeenCalledWith('trk_A', 'thread-1', 'abc123', expect.any(Number), 'MESSAGE_EXPANDED');
  });

  // Case B: MessageView already loaded, state = EXPANDED -> handler registers -> SELF_VIEW emitted immediately
  it('Case B: already loaded EXPANDED emits SELF_VIEW immediately on registration', async () => {
    const onSelfView = vi.fn();
    const handler = createMessageSelfViewHandler({
      getEmails: () => [trackedEmailA],
      onSelfView,
    });

    const mv = createMockMessageView({ id: 'abc123', loaded: true, state: 'EXPANDED' });
    handler.handleMessageView(mv);

    await vi.waitFor(() => expect(onSelfView).toHaveBeenCalledTimes(1));
    expect(onSelfView).toHaveBeenCalledWith('trk_A', 'thread-1', 'abc123', expect.any(Number), 'MESSAGE_EXPANDED');
  });

  // Case C: MessageView initially unloaded + COLLAPSED -> load fires -> still COLLAPSED -> no SELF_VIEW -> later EXPANDED -> SELF_VIEW
  it('Case C: unloaded + COLLAPSED does not fire on load while COLLAPSED, fires when later EXPANDED', async () => {
    const onSelfView = vi.fn();
    const handler = createMessageSelfViewHandler({
      getEmails: () => [trackedEmailA],
      onSelfView,
    });

    const mv = createMockMessageView({ id: 'abc123', loaded: false, state: 'COLLAPSED' });
    handler.handleMessageView(mv);

    // Initial: no call
    expect(onSelfView).not.toHaveBeenCalled();

    // Load event fires while still collapsed
    mv.setLoaded(true);
    await vi.waitFor(() => expect(onSelfView).not.toHaveBeenCalled());

    // Later expanded
    mv.setState('EXPANDED');
    await vi.waitFor(() => expect(onSelfView).toHaveBeenCalledTimes(1));
    expect(onSelfView).toHaveBeenCalledWith('trk_A', 'thread-1', 'abc123', expect.any(Number), 'MESSAGE_EXPANDED');
  });

  // Case D: MessageView initially unloaded + EXPANDED -> load fires -> resolve ID -> SELF_VIEW
  it('Case D: unloaded + EXPANDED waits for load event then resolves ID and emits SELF_VIEW', async () => {
    const onSelfView = vi.fn();
    const handler = createMessageSelfViewHandler({
      getEmails: () => [trackedEmailA],
      onSelfView,
    });

    const mv = createMockMessageView({ id: 'abc123', loaded: false, state: 'EXPANDED' });
    handler.handleMessageView(mv);

    // Initially unloaded -> resolveMessageId returns null -> no emission yet
    expect(onSelfView).not.toHaveBeenCalled();

    // Now message finishes loading
    mv.setLoaded(true);
    await vi.waitFor(() => expect(onSelfView).toHaveBeenCalledTimes(1));
    expect(onSelfView).toHaveBeenCalledWith('trk_A', 'thread-1', 'abc123', expect.any(Number), 'MESSAGE_LOAD');
  });

  // ID Normalization tests: msg-a:, msg-f:, #msg-a:
  it('normalizes InboxSDK message ID prefixes (msg-a:, msg-f:, #msg-a:) against stored tracked ID', async () => {
    // 1. stored = "abc123", view = "msg-a:abc123"
    {
      const onSelfView = vi.fn();
      const handler = createMessageSelfViewHandler({
        getEmails: () => [trackedEmailA],
        onSelfView,
      });
      const mv = createMockMessageView({ id: 'msg-a:abc123', loaded: true, state: 'EXPANDED' });
      handler.handleMessageView(mv);
      await vi.waitFor(() => expect(onSelfView).toHaveBeenCalledWith('trk_A', 'thread-1', 'abc123', expect.any(Number), 'MESSAGE_EXPANDED'));
    }

    // 2. stored = "abc123", view = "msg-f:abc123"
    {
      const onSelfView = vi.fn();
      const handler = createMessageSelfViewHandler({
        getEmails: () => [trackedEmailA],
        onSelfView,
      });
      const mv = createMockMessageView({ id: 'msg-f:abc123', loaded: true, state: 'EXPANDED' });
      handler.handleMessageView(mv);
      await vi.waitFor(() => expect(onSelfView).toHaveBeenCalledWith('trk_A', 'thread-1', 'abc123', expect.any(Number), 'MESSAGE_EXPANDED'));
    }

    // 3. stored = "abc123", view = "#msg-a:abc123"
    {
      const onSelfView = vi.fn();
      const handler = createMessageSelfViewHandler({
        getEmails: () => [trackedEmailA],
        onSelfView,
      });
      const mv = createMockMessageView({ id: '#msg-a:abc123', loaded: true, state: 'EXPANDED' });
      handler.handleMessageView(mv);
      await vi.waitFor(() => expect(onSelfView).toHaveBeenCalledWith('trk_A', 'thread-1', 'abc123', expect.any(Number), 'MESSAGE_EXPANDED'));
    }
  });

  // Section 24: Cache Race Test
  it('handles tracked-email cache arriving after MessageView registration', async () => {
    let emails: TrackedEmailSummary[] = [];
    const onSelfView = vi.fn();
    const handler = createMessageSelfViewHandler({
      getEmails: () => emails,
      onSelfView,
    });

    const mv = createMockMessageView({ id: 'msg-a:abc123', loaded: true, state: 'EXPANDED' });
    handler.handleMessageView(mv);

    // Wait for initial async registration inspection to settle
    await new Promise((resolve) => setTimeout(resolve, 20));

    // No match initially because cache was empty
    expect(onSelfView).not.toHaveBeenCalled();

    // Later tracked-email cache arrives from background
    emails = [trackedEmailA];
    await handler.reinspectActive();

    expect(onSelfView).toHaveBeenCalledTimes(1);
    expect(onSelfView).toHaveBeenCalledWith('trk_A', 'thread-1', 'abc123', expect.any(Number), 'CACHE_REINSPECTION');
  });

  // Section 5: Mandatory Regression Test
  it('Priority 1 Regression Test: cache refresh while message remains expanded does NOT fabricate a new SELF_VIEW', async () => {
    const onSelfView = vi.fn();
    const emails = [trackedEmailA];
    const handler = createMessageSelfViewHandler({
      getEmails: () => emails,
      onSelfView,
    });

    const mv = createMockMessageView({ id: 'msg-a:abc123', loaded: true, state: 'EXPANDED' });
    // T = 0: sender expands message
    const t0 = 1000;
    vi.setSystemTime(t0);
    handler.handleMessageView(mv);

    await vi.waitFor(() => expect(onSelfView).toHaveBeenCalledTimes(1));
    expect(onSelfView).toHaveBeenCalledWith('trk_A', 'thread-1', 'abc123', t0, 'MESSAGE_EXPANDED');

    // Message remains expanded.
    // T = 60s: recipient legitimately opens at T = 60s
    const t60 = t0 + 60_000;
    vi.setSystemTime(t60);

    // Cache refresh runs at T=60
    await handler.reinspectActive();

    // EXPECTED: NO new SELF_VIEW at T=60!
    expect(onSelfView).toHaveBeenCalledTimes(1);

    vi.useRealTimers();
  });

  it('late cache arrival preserves original expansion timestamp T=0 instead of T=60', async () => {
    let emails: TrackedEmailSummary[] = [];
    const onSelfView = vi.fn();
    const handler = createMessageSelfViewHandler({
      getEmails: () => emails,
      onSelfView,
    });

    const mv = createMockMessageView({ id: 'msg-a:abc123', loaded: true, state: 'EXPANDED' });
    const t0 = 1000;
    vi.setSystemTime(t0);
    handler.handleMessageView(mv);

    await new Promise((resolve) => setTimeout(resolve, 20));
    expect(onSelfView).not.toHaveBeenCalled();

    // Cache arrives at T=60s
    const t60 = t0 + 60_000;
    vi.setSystemTime(t60);
    emails = [trackedEmailA];
    await handler.reinspectActive();

    expect(onSelfView).toHaveBeenCalledTimes(1);
    // MUST have original expandedAt (t0), NOT t60!
    expect(onSelfView).toHaveBeenCalledWith('trk_A', 'thread-1', 'abc123', t0, 'CACHE_REINSPECTION');

    vi.useRealTimers();
  });

  // Section 29: Multiple tracked messages in same thread remain isolated
  it('isolates multiple tracked messages in the same Gmail thread by message ID', async () => {
    const onSelfView = vi.fn();
    const handler = createMessageSelfViewHandler({
      getEmails: () => [trackedEmailA, trackedEmailB],
      onSelfView,
    });

    // Message A is expanded in thread X
    const mvA = createMockMessageView({ id: 'msg-a:abc123', loaded: true, state: 'EXPANDED', threadId: 'thread_X' });
    // Message B is collapsed in thread X
    const mvB = createMockMessageView({ id: 'msg-f:def456', loaded: true, state: 'COLLAPSED', threadId: 'thread_X' });

    handler.handleMessageView(mvA);
    handler.handleMessageView(mvB);

    await vi.waitFor(() => expect(onSelfView).toHaveBeenCalledTimes(1));
    // ONLY trk_A is emitted! trk_B is NOT emitted!
    expect(onSelfView).toHaveBeenCalledWith('trk_A', 'thread_X', 'abc123', expect.any(Number), 'MESSAGE_EXPANDED');

    // Now sender expands Message B
    mvB.setState('EXPANDED');
    await vi.waitFor(() => expect(onSelfView).toHaveBeenCalledTimes(2));
    // Message B emits its own SELF_VIEW
    expect(onSelfView).toHaveBeenLastCalledWith('trk_B', 'thread_X', 'def456', expect.any(Number), 'MESSAGE_EXPANDED');
  });

  // Re-firing with distinct loadedAt on delayed load
  it('fires MESSAGE_EXPANDED at T0 and MESSAGE_LOAD at T+9s with fresh loadedAt timestamp', async () => {
    const onSelfView = vi.fn();
    const handler = createMessageSelfViewHandler({
      getEmails: () => [trackedEmailA],
      onSelfView,
    });

    const mv = createMockMessageView({ id: 'msg-a:abc123', loaded: true, state: 'COLLAPSED' });
    handler.handleMessageView(mv);

    // T = 1000: expanded
    const t0 = 1000;
    vi.setSystemTime(t0);
    mv.setState('EXPANDED');

    await vi.waitFor(() => expect(onSelfView).toHaveBeenCalledTimes(1));
    expect(onSelfView).toHaveBeenCalledWith('trk_A', 'thread-1', 'abc123', t0, 'MESSAGE_EXPANDED');

    // T = 10000 (T+9s): message body finishes streaming / loading
    const tLoad = t0 + 9000;
    vi.setSystemTime(tLoad);
    mv.emit('load', { messageView: mv });

    await vi.waitFor(() => expect(onSelfView).toHaveBeenCalledTimes(2));
    // Must capture fresh loadedAt (tLoad), NEVER reusing expandedAt (t0)
    expect(onSelfView).toHaveBeenLastCalledWith('trk_A', 'thread-1', 'abc123', tLoad, 'MESSAGE_LOAD');

    vi.useRealTimers();
  });

  // MessageView destruction cleans up active set
  it('removes destroyed MessageViews from active registry', async () => {
    let emails: TrackedEmailSummary[] = [];
    const onSelfView = vi.fn();
    const handler = createMessageSelfViewHandler({
      getEmails: () => emails,
      onSelfView,
    });

    const mv = createMockMessageView({ id: 'msg-a:abc123', loaded: true, state: 'EXPANDED' });
    handler.handleMessageView(mv);
    expect(handler.getActiveCount()).toBe(1);

    // Destroy view
    mv.destroyed = true;
    mv.emit('destroy');
    expect(handler.getActiveCount()).toBe(0);

    // Reinspect does not call onSelfView for destroyed view
    emails = [trackedEmailA];
    await handler.reinspectActive();
    expect(onSelfView).not.toHaveBeenCalled();
  });

  it('notifies onCollapsed when view state transitions from EXPANDED to COLLAPSED', async () => {
    const onSelfView = vi.fn();
    const onCollapsed = vi.fn();
    const handler = createMessageSelfViewHandler({
      getEmails: () => [trackedEmailA],
      onSelfView,
      onCollapsed,
    });

    const mv = createMockMessageView({ id: 'msg-a:abc123', loaded: true, state: 'COLLAPSED' });
    handler.handleMessageView(mv);

    // Expand message
    mv.setState('EXPANDED');
    await vi.waitFor(() => expect(onSelfView).toHaveBeenCalledTimes(1));

    // Collapse message
    mv.setState('COLLAPSED');
    expect(onCollapsed).toHaveBeenCalledTimes(1);
    expect(onCollapsed).toHaveBeenCalledWith('trk_A', 'abc123');
  });

  it('resolves a changed Gmail message id from the pixel in the message body and reconciles it', async () => {
    const onSelfView = vi.fn();
    const onReconcile = vi.fn();
    const handler = createMessageSelfViewHandler({
      getEmails: () => [trackedEmailA],
      getTrackerBaseUrl: () => 'https://track.example',
      onSelfView,
      onReconcile,
    });
    const mv = createMockMessageView({
      id: 'def456',
      loaded: true,
      state: 'EXPANDED',
      threadId: 'thread_X',
      bodyHtml:
        '<img src="https://ci3.googleusercontent.com/proxy#https://track.example/open/trk_A" width="1" height="1">',
    });
    handler.handleMessageView(mv);
    await vi.waitFor(() => expect(onSelfView).toHaveBeenCalledTimes(1));
    expect(onReconcile).toHaveBeenCalledWith('trk_A', 'thread_X', 'def456');
    expect(onSelfView).toHaveBeenCalledWith('trk_A', 'thread_X', 'def456', expect.any(Number), 'MESSAGE_EXPANDED');
  });

  it('resolves a tracked message from the body pixel when the stored Gmail message id is null', async () => {
    const onSelfView = vi.fn();
    const onReconcile = vi.fn();
    const handler = createMessageSelfViewHandler({
      getEmails: () => [{ ...trackedEmailA, gmailMessageId: null }],
      getTrackerBaseUrl: () => 'https://track.example',
      onSelfView,
      onReconcile,
    });
    const mv = createMockMessageView({
      id: 'fresh_id',
      loaded: true,
      state: 'EXPANDED',
      bodyHtml: '<img data-src="https://track.example/open/trk_A.gif">',
      threadId: 'thread_X',
    });
    handler.handleMessageView(mv);
    await vi.waitFor(() => expect(onSelfView).toHaveBeenCalledWith('trk_A', 'thread_X', 'fresh_id', expect.any(Number), 'MESSAGE_EXPANDED'));
    expect(onReconcile).toHaveBeenCalledWith('trk_A', 'thread_X', 'fresh_id');
  });

  it('uses each message body pixel when one thread contains two tracked messages', async () => {
    const onSelfView = vi.fn();
    const handler = createMessageSelfViewHandler({
      getEmails: () => [trackedEmailA, trackedEmailB],
      getTrackerBaseUrl: () => 'https://track.example',
      onSelfView,
    });
    const mvA = createMockMessageView({
      id: 'not_stored_a',
      loaded: true,
      state: 'EXPANDED',
      threadId: 'thread_X',
      bodyHtml: '<img src="https://track.example/open/trk_A">',
    });
    const mvB = createMockMessageView({
      id: 'not_stored_b',
      loaded: true,
      state: 'EXPANDED',
      threadId: 'thread_X',
      bodyHtml: '<img src="https://track.example/open/trk_B">',
    });
    handler.handleMessageView(mvA);
    handler.handleMessageView(mvB);
    await vi.waitFor(() => expect(onSelfView).toHaveBeenCalledTimes(2));
    expect(onSelfView).toHaveBeenNthCalledWith(1, 'trk_A', 'thread_X', 'not_stored_a', expect.any(Number), 'MESSAGE_EXPANDED');
    expect(onSelfView).toHaveBeenNthCalledWith(2, 'trk_B', 'thread_X', 'not_stored_b', expect.any(Number), 'MESSAGE_EXPANDED');
  });

  it('does not guess when the Gmail id changed and the body has no tracking pixel', async () => {
    const onSelfView = vi.fn();
    const onDiagnostic = vi.fn();
    const handler = createMessageSelfViewHandler({
      getEmails: () => [trackedEmailA, trackedEmailB],
      onSelfView,
      onDiagnostic,
    });
    const mv = createMockMessageView({
      id: 'brand_new',
      loaded: true,
      state: 'EXPANDED',
      threadId: 'thread_X',
      bodyHtml: '<p>No pixel here</p>',
    });
    handler.handleMessageView(mv);
    await vi.waitFor(() => expect(onDiagnostic).toHaveBeenCalled());
    expect(onSelfView).not.toHaveBeenCalled();
  });

  it('recovers the only recent tracked send in a thread when its Gmail message id was never stored', async () => {
    const onSelfView = vi.fn();
    const onReconcile = vi.fn();
    const handler = createMessageSelfViewHandler({
      getEmails: () => [{ ...trackedEmailA, gmailMessageId: null, sentAt: new Date().toISOString() }],
      onSelfView,
      onReconcile,
    });
    const mv = createMockMessageView({
      id: 'late_id',
      loaded: true,
      state: 'EXPANDED',
      threadId: 'thread_X',
      bodyHtml: '<p>Images are still loading</p>',
    });
    handler.handleMessageView(mv);
    await vi.waitFor(() => expect(onSelfView).toHaveBeenCalledWith('trk_A', 'thread_X', 'late_id', expect.any(Number), 'MESSAGE_EXPANDED'));
    expect(onReconcile).toHaveBeenCalledWith('trk_A', 'thread_X', 'late_id');
  });

  it('emits one PAGE_RELOAD for an initially expanded tracked pixel after a document reload', async () => {
    const navigationStartedAt = 1_758_000_000_000;
    const onSelfView = vi.fn();
    const handler = createMessageSelfViewHandler({
      getEmails: () => [trackedEmailA],
      getTrackerBaseUrl: () => 'https://track.example',
      pageReload: { navigationStartedAt },
      onSelfView,
    });
    const mv = createMockMessageView({
      id: 'abc123',
      loaded: true,
      state: 'EXPANDED',
      threadId: 'thread_X',
      bodyHtml: '<img src="https://track.example/open/trk_A">',
    });
    handler.handleMessageView(mv);
    await vi.waitFor(() =>
      expect(onSelfView).toHaveBeenCalledWith('trk_A', 'thread_X', 'abc123', navigationStartedAt, 'PAGE_RELOAD'),
    );
    await handler.reinspectActive();
    mv.setState('COLLAPSED');
    mv.setState('EXPANDED');
    await vi.waitFor(() => expect(onSelfView.mock.calls.filter((call) => call[4] === 'MESSAGE_EXPANDED').length).toBeGreaterThan(0));
    expect(onSelfView.mock.calls.filter((call) => call[4] === 'PAGE_RELOAD')).toHaveLength(1);
    expect(buildSelfViewEventId('trk_A', 'abc123', 'PAGE_RELOAD', navigationStartedAt)).toBe(
      `sv_trk_A_PAGE_RELOAD_${navigationStartedAt}`,
    );
    expect(buildSelfViewEventId('trk_A', 'other', 'PAGE_RELOAD', navigationStartedAt)).toBe(
      `sv_trk_A_PAGE_RELOAD_${navigationStartedAt}`,
    );
  });

  it('emits PAGE_RELOAD when Gmail has proxied away the pixel URL but the saved message id matches', async () => {
    const navigationStartedAt = 1_758_000_000_000;
    const onSelfView = vi.fn();
    const handler = createMessageSelfViewHandler({
      getEmails: () => [trackedEmailA],
      getTrackerBaseUrl: () => 'https://track.example',
      pageReload: { navigationStartedAt },
      onSelfView,
    });
    const mv = createMockMessageView({
      id: 'abc123',
      loaded: true,
      state: 'EXPANDED',
      threadId: 'thread_X',
      bodyHtml: '<img src="https://ci3.googleusercontent.com/proxy/cached-image">',
    });
    handler.handleMessageView(mv);
    await vi.waitFor(() =>
      expect(onSelfView).toHaveBeenCalledWith('trk_A', 'thread_X', 'abc123', navigationStartedAt, 'PAGE_RELOAD'),
    );
    expect(onSelfView.mock.calls.filter((call) => call[4] === 'PAGE_RELOAD')).toHaveLength(1);
  });

  it('does not emit PAGE_RELOAD for a message expanded after the reload', async () => {
    const onSelfView = vi.fn();
    const handler = createMessageSelfViewHandler({
      getEmails: () => [trackedEmailA],
      getTrackerBaseUrl: () => 'https://track.example',
      pageReload: { navigationStartedAt: 1_758_000_000_000 },
      onSelfView,
    });
    const mv = createMockMessageView({
      id: 'abc123',
      loaded: true,
      state: 'COLLAPSED',
      threadId: 'thread_X',
      bodyHtml: '<img src="https://track.example/open/trk_A">',
    });
    handler.handleMessageView(mv);
    mv.setState('EXPANDED');
    await vi.waitFor(() => expect(onSelfView).toHaveBeenCalledWith('trk_A', 'thread_X', 'abc123', expect.any(Number), 'MESSAGE_EXPANDED'));
    expect(onSelfView.mock.calls.some((call) => call[4] === 'PAGE_RELOAD')).toBe(false);
  });

  it('emits PAGE_RELOAD when the embedded pixel appears after the reloaded message loads', async () => {
    const navigationStartedAt = 1_758_000_000_000;
    let html = '';
    const onSelfView = vi.fn();
    const handler = createMessageSelfViewHandler({
      getEmails: () => [trackedEmailA],
      getTrackerBaseUrl: () => 'https://track.example',
      pageReload: { navigationStartedAt },
      onSelfView,
    });
    const mv = createMockMessageView({
      id: 'abc123',
      loaded: true,
      state: 'EXPANDED',
      threadId: 'thread_X',
    });
    mv.getBodyElement = () => {
      if (!html) return null;
      const body = document.createElement('div');
      body.innerHTML = html;
      return body;
    };
    handler.handleMessageView(mv);
    await vi.waitFor(() =>
      expect(onSelfView).toHaveBeenCalledWith('trk_A', 'thread_X', 'abc123', expect.any(Number), 'MESSAGE_EXPANDED'),
    );
    expect(onSelfView.mock.calls.filter((call) => call[4] === 'PAGE_RELOAD')).toHaveLength(1);
    html = '<img src="https://track.example/open/trk_A">';
    mv.emit('load');
    await vi.waitFor(() =>
      expect(onSelfView).toHaveBeenCalledWith('trk_A', 'thread_X', 'abc123', navigationStartedAt, 'PAGE_RELOAD'),
    );
    expect(onSelfView.mock.calls.filter((call) => call[4] === 'PAGE_RELOAD')).toHaveLength(1);
  });
});
