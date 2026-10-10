/**
 * @vitest-environment jsdom
 */
import { describe, expect, it, vi } from 'vitest';
import { DomFallbackAdapter } from './DomFallbackAdapter.js';
import { InboxSdkAdapter, type InboxSdkLike } from './InboxSdkAdapter.js';
import { CompositeGmailAdapter } from './index.js';
import { readMessageBody, resolveMessageId, resolveThreadId } from './thread-id.js';
import type { MailboxEvent } from './types.js';

function sdk(handlers: { rows: Array<(row: unknown) => void>; threads: number; compose: number; routes: number }): InboxSdkLike {
  return {
    Router: { handleAllRoutes() { handlers.routes += 1; } },
    Conversations: { registerThreadViewHandler() { handlers.threads += 1; } },
    Compose: { registerComposeViewHandler() { handlers.compose += 1; } },
    Lists: {
      registerThreadRowViewHandler(cb) {
        handlers.rows.push(cb);
      },
    },
  };
}

describe('adapter lifecycle', () => {
  it('starts once and does not register InboxSDK twice', async () => {
    const handlers = { rows: [] as Array<(row: unknown) => void>, threads: 0, compose: 0, routes: 0 };
    const adapter = new CompositeGmailAdapter();
    expect(adapter.bindInboxSdk(sdk(handlers))).toBe(true);
    await adapter.start(() => undefined);
    await adapter.start(() => undefined);
    expect(adapter.getActiveIntegration()).toBe('inboxsdk');
    expect(handlers.rows).toHaveLength(1);
    expect(handlers.threads).toBe(1);
  });

  it('selects DOM only when InboxSDK was not bound before start', async () => {
    const adapter = new CompositeGmailAdapter({ debounceMs: 0 });
    await adapter.start(() => undefined);
    expect(adapter.getActiveIntegration()).toBe('dom');
    expect(adapter.bindInboxSdk(sdk({ rows: [], threads: 0, compose: 0, routes: 0 }))).toBe(false);
    expect(adapter.getActiveIntegration()).toBe('dom');
    await adapter.stop();
  });

  it('resolves async thread ids', async () => {
    expect(await resolveThreadId({ getThreadID: () => 'sync-id' })).toBe('sync-id');
    expect(await resolveThreadId({ getThreadIDAsync: async () => 'async-id' })).toBe('async-id');
    expect(await resolveThreadId({ getThreadID: () => Promise.resolve('promised') })).toBe('promised');
    let syncCalls = 0;
    expect(await resolveThreadId({
      getThreadID: () => {
        syncCalls += 1;
        return 'sync';
      },
      getThreadIDAsync: async () => 'async-preferred',
    })).toBe('async-preferred');
    expect(syncCalls).toBe(0);
    expect(await resolveThreadId({ getThreadID: () => null, getThreadIDAsync: async () => null })).toBeNull();
  });

  it('resolves message ids safely without calling getMessageID on unloaded messages', async () => {
    // Unloaded message should return null without invoking getMessageID (which would throw)
    let syncCalled = false;
    const unloadedMessage = {
      isLoaded: () => false,
      getMessageID: () => {
        syncCalled = true;
        throw new Error('tried to get message id before message is loaded');
      },
    };
    expect(await resolveMessageId(unloadedMessage)).toBeNull();
    expect(syncCalled).toBe(false);

    // Loaded message with getMessageIDAsync should prefer async
    let syncCalls = 0;
    const loadedMessage = {
      isLoaded: () => true,
      getMessageID: () => {
        syncCalls += 1;
        return 'sync-msg-id';
      },
      getMessageIDAsync: async () => 'async-msg-id',
    };
    expect(await resolveMessageId(loadedMessage)).toBe('async-msg-id');
    expect(syncCalls).toBe(0);

    // Fallback to sync when getMessageIDAsync is not present
    expect(await resolveMessageId({ isLoaded: () => true, getMessageID: () => 'legacy-msg' })).toBe('legacy-msg');

    // Throws inside getMessageID are gracefully swallowed
    expect(await resolveMessageId({
      isLoaded: () => true,
      getMessageID: () => {
        throw new Error('unexpected DOM failure');
      },
    })).toBeNull();
  });

  it('emits a row when the thread id arrives asynchronously', async () => {
    const events: MailboxEvent[] = [];
    const adapter = new InboxSdkAdapter('', { rowDebounceMs: 0 });
    adapter.bindSdk({
      Router: { handleAllRoutes() {} },
      Conversations: { registerThreadViewHandler() {} },
      Compose: { registerComposeViewHandler() {} },
      Lists: {
        registerThreadRowViewHandler(cb) {
          cb({ getThreadIDAsync: () => Promise.resolve('thread-async'), getSubject: () => 'Subject' });
        },
      },
    });
    await adapter.start((event) => events.push(event));
    await vi.waitFor(() => expect(events.some((event) => event.type === 'VISIBLE_ROWS_CHANGED')).toBe(true));
    const rows = events.find((event) => event.type === 'VISIBLE_ROWS_CHANGED');
    expect(rows && rows.type === 'VISIBLE_ROWS_CHANGED' ? rows.rows[0]?.threadId : '').toBe('thread-async');
    expect(events.some((event) => event.type === 'MESSAGE_ARRIVED')).toBe(false);
  });

  it('maps thread views containing unloaded message views safely and updates when messages load', async () => {
    const events: MailboxEvent[] = [];
    let threadHandler: ((tv: unknown) => void) | undefined;
    let messageHandler: ((mv: unknown) => void) | undefined;
    const adapter = new InboxSdkAdapter('', { rowDebounceMs: 0 });

    let message1Loaded = false;
    const mockMessage1 = {
      isLoaded: () => message1Loaded,
      getMessageID: () => {
        if (!message1Loaded) throw new Error('tried to get message id before message is loaded');
        return 'msg-1';
      },
      getMessageIDAsync: async () => {
        if (!message1Loaded) throw new Error('tried to get message id before message is loaded');
        return 'msg-1';
      },
      getSender: () => {
        if (!message1Loaded) throw new Error('not loaded');
        return { name: 'Alice', emailAddress: 'alice@example.com' };
      },
      getRecipientEmailAddresses: () => (message1Loaded ? ['me@example.com'] : []),
      getBodyElement: () => (message1Loaded ? ({ textContent: 'Hello world' } as HTMLElement) : null),
      getThreadView: () => mockThreadView,
    };

    const mockMessage2 = {
      isLoaded: () => true,
      getMessageIDAsync: async () => 'msg-2',
      getSender: () => ({ name: 'Bob', emailAddress: 'bob@example.com' }),
      getRecipientEmailAddresses: () => ['alice@example.com'],
      getBodyElement: () => ({ textContent: 'Reply from Bob' } as HTMLElement),
      getThreadView: () => mockThreadView,
    };

    const mockThreadView = {
      getThreadIDAsync: async () => 'thread-xyz',
      getSubject: () => 'Test conversation',
      getMessageViewsAll: () => [mockMessage1, mockMessage2],
    };

    adapter.bindSdk({
      Router: { handleAllRoutes() {} },
      Conversations: {
        registerThreadViewHandler(cb) {
          threadHandler = cb as (tv: unknown) => void;
        },
        registerMessageViewHandler(cb) {
          messageHandler = cb as (mv: unknown) => void;
        },
      },
      Compose: { registerComposeViewHandler() {} },
      Lists: { registerThreadRowViewHandler() {} },
    });

    await adapter.start((event) => events.push(event));
    expect(threadHandler).toBeDefined();

    // Trigger THREAD_OPENED while message 1 is unloaded
    threadHandler!(mockThreadView);
    await vi.waitFor(() => expect(events.some((e) => e.type === 'THREAD_OPENED')).toBe(true));

    const opened = events.find((e) => e.type === 'THREAD_OPENED');
    expect(opened && opened.type === 'THREAD_OPENED').toBe(true);
    if (opened && opened.type === 'THREAD_OPENED') {
      expect(opened.thread.threadId).toBe('thread-xyz');
      expect(opened.thread.messages).toHaveLength(2);
      // Unloaded message receives safe fallback ID and empty body without throwing
      expect(opened.thread.messages[0]?.messageId).toBe('thread-xyz-msg-0');
      expect(opened.thread.messages[0]?.bodyText).toBe('');
      // Loaded message has resolved async ID and body
      expect(opened.thread.messages[1]?.messageId).toBe('msg-2');
      expect(opened.thread.messages[1]?.bodyText).toBe('Reply from Bob');
    }

    // Now message 1 loads (e.g. expanded by user in Gmail)
    message1Loaded = true;
    messageHandler!(mockMessage1);
    await vi.waitFor(() => expect(events.some((e) => e.type === 'THREAD_DATA_UPDATED')).toBe(true));

    const updated = events.find((e) => e.type === 'THREAD_DATA_UPDATED');
    expect(updated && updated.type === 'THREAD_DATA_UPDATED').toBe(true);
    if (updated && updated.type === 'THREAD_DATA_UPDATED') {
      expect(updated.thread.messages[0]?.messageId).toBe('msg-1');
      expect(updated.thread.messages[0]?.bodyText).toBe('Hello world');
      expect(updated.thread.messages[0]?.sender.email).toBe('alice@example.com');
    }
  });

  it('does not stack observers when start is repeated, and stop disconnects', async () => {
    let observers = 0;
    const Original = globalThis.MutationObserver;
    class Counting extends Original {
      constructor(callback: MutationCallback) {
        super(callback);
        observers += 1;
      }
    }
    vi.stubGlobal('MutationObserver', Counting);
    const adapter = new DomFallbackAdapter({ debounceMs: 0 });
    await adapter.start(() => undefined);
    await adapter.start(() => undefined);
    expect(observers).toBe(1);
    await adapter.stop();
    expect(adapter.isStarted()).toBe(false);
    vi.stubGlobal('MutationObserver', Original);
  });

  it('clears currentThread on destroy even when thread ID is a Promise (async thread ID)', async () => {
    let threadHandler: ((tv: unknown) => void) | undefined;
    const adapter = new InboxSdkAdapter('', { rowDebounceMs: 0 });

    let destroyCb: (() => void) | undefined;
    const mockThreadView = {
      // In real InboxSDK, getThreadID can return a Promise, or getThreadIDAsync is used
      getThreadID: () => Promise.resolve('thread-async-destroy'),
      getSubject: () => 'Async thread test',
      getMessageViewsAll: () => [],
      on: (event: string, cb: () => void) => {
        if (event === 'destroy') destroyCb = cb;
      },
    };

    adapter.bindSdk({
      Router: { handleAllRoutes() {} },
      Conversations: {
        registerThreadViewHandler(cb) {
          threadHandler = cb as (tv: unknown) => void;
        },
      },
      Compose: { registerComposeViewHandler() {} },
      Lists: { registerThreadRowViewHandler() {} },
    });

    await adapter.start(() => undefined);
    threadHandler!(mockThreadView);

    await vi.waitFor(async () => {
      const current = await adapter.getCurrentThread();
      expect(current.thread?.threadId).toBe('thread-async-destroy');
    });

    // Thread is destroyed
    expect(destroyCb).toBeDefined();
    destroyCb!();

    await vi.waitFor(async () => {
      const current = await adapter.getCurrentThread();
      expect(current.thread).toBeUndefined();
    });
  });

  it('clears currentThread when route changes away from thread', async () => {
    let routeHandler: ((rv: { getRouteType?: () => string }) => void) | undefined;
    let threadHandler: ((tv: unknown) => void) | undefined;
    const adapter = new InboxSdkAdapter('', { rowDebounceMs: 0 });

    const mockThreadView = {
      getThreadID: () => 'thread-route-test',
      getSubject: () => 'Route thread test',
      getMessageViewsAll: () => [],
      on: () => {},
    };

    adapter.bindSdk({
      Router: {
        handleAllRoutes(cb) {
          routeHandler = cb;
        },
      },
      Conversations: {
        registerThreadViewHandler(cb) {
          threadHandler = cb as (tv: unknown) => void;
        },
      },
      Compose: { registerComposeViewHandler() {} },
      Lists: { registerThreadRowViewHandler() {} },
    });

    await adapter.start(() => undefined);
    threadHandler!(mockThreadView);

    await vi.waitFor(async () => {
      const current = await adapter.getCurrentThread();
      expect(current.thread?.threadId).toBe('thread-route-test');
    });

    // User navigates back to inbox list
    routeHandler!({ getRouteType: () => 'inbox' });

    const current = await adapter.getCurrentThread();
    expect(current.thread).toBeUndefined();
  });

  it('properly awaits async Router.goto in openThread, navigateToSearch, and navigateToInbox', async () => {
    const adapter = new InboxSdkAdapter('', { rowDebounceMs: 0 });
    const visited: string[] = [];

    adapter.bindSdk({
      Router: {
        handleAllRoutes() {},
        goto: async (path: string) => {
          await new Promise((resolve) => setTimeout(resolve, 10));
          visited.push(path);
        },
      },
      Conversations: { registerThreadViewHandler() {} },
      Compose: { registerComposeViewHandler() {} },
      Lists: { registerThreadRowViewHandler() {} },
    });

    await adapter.start(() => undefined);

    const openRes = await adapter.openThread('thread-123');
    expect(openRes.success).toBe(true);
    expect(visited).toContain('#inbox/thread-123');

    const searchRes = await adapter.navigateToSearch('has:attachment');
    expect(searchRes.success).toBe(true);
    expect(visited).toContain('#search/has%3Aattachment');

    const inboxRes = await adapter.navigateToInbox();
    expect(inboxRes.success).toBe(true);
    expect(visited).toContain('#inbox');
  });

  it('registers each InboxSDK handler exactly once across repeated starts, stops, and restarts', async () => {
    const counts = {
      routes: 0,
      threads: 0,
      messages: 0,
      compose: 0,
      rows: 0,
    };
    const mockSdk: InboxSdkLike = {
      Router: {
        handleAllRoutes: () => { counts.routes += 1; },
      },
      Conversations: {
        registerThreadViewHandler: () => { counts.threads += 1; },
        registerMessageViewHandler: () => { counts.messages += 1; },
      },
      Compose: {
        registerComposeViewHandler: () => { counts.compose += 1; },
      },
      Lists: {
        registerThreadRowViewHandler: () => { counts.rows += 1; },
      },
    };

    const adapter = new InboxSdkAdapter('app-test');
    adapter.bindSdk(mockSdk);

    // Initial start
    await adapter.start(() => undefined);
    expect(counts.routes).toBe(1);
    expect(counts.threads).toBe(1);
    expect(counts.messages).toBe(1);
    expect(counts.compose).toBe(1);
    expect(counts.rows).toBe(1);

    // Repeated start without stop
    await adapter.start(() => undefined);
    expect(counts.routes).toBe(1);
    expect(counts.threads).toBe(1);
    expect(counts.messages).toBe(1);
    expect(counts.compose).toBe(1);
    expect(counts.rows).toBe(1);

    // Stop and restart
    await adapter.stop();
    await adapter.start(() => undefined);
    expect(counts.routes).toBe(1);
    expect(counts.threads).toBe(1);
    expect(counts.messages).toBe(1);
    expect(counts.compose).toBe(1);
    expect(counts.rows).toBe(1);

    // Another adapter binding the same SDK (e.g. extension reload in same page)
    const secondAdapter = new CompositeGmailAdapter();
    expect(secondAdapter.bindInboxSdk(mockSdk)).toBe(true);
    await secondAdapter.start(() => undefined);
    expect(counts.routes).toBe(1);
    expect(counts.threads).toBe(1);
    expect(counts.messages).toBe(1);
    expect(counts.compose).toBe(1);
    expect(counts.rows).toBe(1);
  });

  it('invokes raw-view hooks from single registrations and across restart', async () => {
    let threadCb: ((tv: unknown) => void) | undefined;
    let messageCb: ((mv: unknown) => void) | undefined;
    let composeCb: ((cv: unknown) => void) | undefined;
    let rowCb: ((rv: unknown) => void) | undefined;

    const mockSdk: InboxSdkLike = {
      Router: { handleAllRoutes: () => {} },
      Conversations: {
        registerThreadViewHandler: (cb) => { threadCb = cb as any; },
        registerMessageViewHandler: (cb) => { messageCb = cb as any; },
      },
      Compose: {
        registerComposeViewHandler: (cb) => { composeCb = cb as any; },
      },
      Lists: {
        registerThreadRowViewHandler: (cb) => { rowCb = cb as any; },
      },
    };

    const hookCalls: string[] = [];
    const adapter = new InboxSdkAdapter('app-test', {
      rowDebounceMs: 0,
      hooks: {
        onThreadView: () => { hookCalls.push('thread'); },
        onMessageView: () => { hookCalls.push('message'); },
        onComposeView: () => { hookCalls.push('compose'); },
        onThreadRowView: () => { hookCalls.push('row'); },
      },
    });
    adapter.bindSdk(mockSdk);

    const events: MailboxEvent[] = [];
    await adapter.start((e) => events.push(e));

    expect(threadCb).toBeDefined();
    expect(messageCb).toBeDefined();
    expect(composeCb).toBeDefined();
    expect(rowCb).toBeDefined();

    const mockTv = {
      getThreadIDAsync: async () => 't-1',
      getSubject: () => 'Subj 1',
      getMessageViewsAll: () => [],
      on: () => {},
    };
    const mockMv = {
      isLoaded: () => true,
      getMessageIDAsync: async () => 'm-1',
      getThreadView: () => mockTv,
      on: () => {},
    };
    const mockCv = {
      getElement: () => document.createElement('div'),
      getThreadIDAsync: async () => 't-1',
      on: () => {},
    };
    const mockRv = {
      getThreadIDAsync: async () => 't-1',
      getSubject: () => 'Row 1',
    };

    threadCb!(mockTv);
    messageCb!(mockMv);
    composeCb!(mockCv);
    rowCb!(mockRv);

    expect(hookCalls).toContain('thread');
    expect(hookCalls).toContain('message');
    expect(hookCalls).toContain('compose');
    expect(hookCalls).toContain('row');

    // Test restart: update hooks and verify they fire without registering new handlers
    hookCalls.length = 0;
    await adapter.stop();
    adapter.setHooks({
      onThreadView: () => { hookCalls.push('thread-v2'); },
      onComposeView: () => { hookCalls.push('compose-v2'); },
    });
    await adapter.start(() => undefined);

    threadCb!(mockTv);
    composeCb!(mockCv);

    expect(hookCalls).toEqual(['thread-v2', 'compose-v2']);
  });
});

describe('Gmail message DOM readiness', () => {
  it('avoids SDK error-logging getters until the message id and body actually exist', async () => {
    const element = document.createElement('div'); document.body.append(element);
    const getMessageIDAsync = vi.fn(async () => 'abc123');
    const getBodyElement = vi.fn(() => { throw new Error('SDK logs selector miss'); });
    const view = { getElement: () => element, isLoaded: () => true, getMessageIDAsync, getBodyElement };
    expect(await resolveMessageId(view)).toBeNull();
    expect(readMessageBody(view)).toBeNull();
    expect(getMessageIDAsync).not.toHaveBeenCalled(); expect(getBodyElement).not.toHaveBeenCalled();
    const missing = { ...view, getElement: () => null };
    expect(await resolveMessageId(missing)).toBeNull(); expect(readMessageBody(missing)).toBeNull();
    expect(getMessageIDAsync).not.toHaveBeenCalled(); expect(getBodyElement).not.toHaveBeenCalled();
    element.innerHTML = '<div data-legacy-message-id="abc123"><div class="a3s">A rendered message</div></div>';
    expect(await resolveMessageId(view)).toBe('abc123');
    expect(readMessageBody(view)?.textContent).toBe('A rendered message');
    element.remove();
    expect(await resolveMessageId(view)).toBeNull(); expect(readMessageBody(view)).toBeNull();
    expect(getMessageIDAsync).toHaveBeenCalledTimes(1); expect(getBodyElement).not.toHaveBeenCalled();
  });
  it('preserves the legacy message-body id fallback', async () => {
    const element = document.createElement('div'); element.innerHTML = '<div class="ii gt mabc123">Legacy body</div>'; document.body.append(element);
    const view = { getElement: () => element, isLoaded: () => true, getMessageIDAsync: vi.fn(async () => 'abc123') };
    expect(await resolveMessageId(view)).toBe('abc123'); element.remove();
  });
});
