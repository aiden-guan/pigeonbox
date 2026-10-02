/**
 * @vitest-environment jsdom
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { InboxSdkLike } from '@pigeonbox/gmail';
import { CompositeGmailAdapter } from '@pigeonbox/gmail';
import { mountSdkUi } from './index';

beforeEach(() => vi.stubGlobal('chrome', { runtime: { id: 'fixture', sendMessage: vi.fn((_message, callback) => { callback?.({}); return Promise.resolve({}); }), getURL: (path: string) => `chrome-extension://fixture/${path}` } }));
afterEach(() => vi.unstubAllGlobals());
describe('InboxSDK UI and handler integration', () => {
  it('mountSdkUi() no longer registers handlers or NavMenu items directly on sdk', () => {
    const mockSdk = {
      Lists: {
        registerThreadRowViewHandler: vi.fn(),
      },
      Conversations: {
        registerThreadViewHandler: vi.fn(),
        registerMessageViewHandler: vi.fn(),
      },
      Compose: {
        registerComposeViewHandler: vi.fn(),
      },
      NavMenu: {
        addNavItem: vi.fn(),
      },
    };

    const mockAdapter = {
      setHooks: vi.fn(),
    };

    mountSdkUi(mockSdk as unknown as InboxSdkLike, mockAdapter as any);

    // Verify mountSdkUi did NOT call any registration on sdk directly
    expect(mockSdk.Lists.registerThreadRowViewHandler).not.toHaveBeenCalled();
    expect(mockSdk.Conversations.registerThreadViewHandler).not.toHaveBeenCalled();
    expect(mockSdk.Conversations.registerMessageViewHandler).not.toHaveBeenCalled();
    expect(mockSdk.Compose.registerComposeViewHandler).not.toHaveBeenCalled();
    expect(mockSdk.NavMenu.addNavItem).not.toHaveBeenCalled();

    // Verify hooks were provided to adapter
    expect(mockAdapter.setHooks).toHaveBeenCalledWith({
      onThreadRowView: expect.any(Function),
      onThreadView: expect.any(Function),
      onMessageView: expect.any(Function),
      onComposeView: expect.any(Function),
    });
  });

  it('end-to-end: InboxSdkAdapter is the single owner and registers each handler exactly once', async () => {
    const registrations = {
      rows: 0,
      threads: 0,
      messages: 0,
      compose: 0,
      navItems: 0,
    };

    let threadCb: ((tv: any) => void) | undefined;
    let messageCb: ((mv: any) => void) | undefined;
    let composeCb: ((cv: any) => void) | undefined;
    let rowCb: ((rv: any) => void) | undefined;

    const mockSdk = {
      Router: { handleAllRoutes: vi.fn() },
      Lists: {
        registerThreadRowViewHandler: vi.fn((cb) => {
          registrations.rows += 1;
          rowCb = cb;
        }),
      },
      Conversations: {
        registerThreadViewHandler: vi.fn((cb) => {
          registrations.threads += 1;
          threadCb = cb;
        }),
        registerMessageViewHandler: vi.fn((cb) => {
          registrations.messages += 1;
          messageCb = cb;
        }),
      },
      Compose: {
        registerComposeViewHandler: vi.fn((cb) => {
          registrations.compose += 1;
          composeCb = cb;
        }),
      },
      NavMenu: {
        addNavItem: vi.fn(() => {
          registrations.navItems += 1;
        }),
      },
    };

    const adapter = new CompositeGmailAdapter();
    expect(adapter.bindInboxSdk(mockSdk as unknown as InboxSdkLike)).toBe(true);

    // Calling mountSdkUi before start does not register on SDK
    mountSdkUi(mockSdk as unknown as InboxSdkLike, adapter);
    expect(registrations.rows).toBe(0);
    expect(registrations.threads).toBe(0);
    expect(registrations.messages).toBe(0);
    expect(registrations.compose).toBe(0);
    expect(registrations.navItems).toBe(0);

    // Start adapter -> exactly 1 registration per handler, 0 NavMenu items
    await adapter.start(() => undefined);
    expect(registrations.rows).toBe(1);
    expect(registrations.threads).toBe(1);
    expect(registrations.messages).toBe(1);
    expect(registrations.compose).toBe(1);
    expect(registrations.navItems).toBe(0);

    // Repeated start does not stack handlers
    await adapter.start(() => undefined);
    expect(registrations.rows).toBe(1);
    expect(registrations.threads).toBe(1);
    expect(registrations.messages).toBe(1);
    expect(registrations.compose).toBe(1);

    // Stop and restart does not stack handlers
    await adapter.stop();
    await adapter.start(() => undefined);
    expect(registrations.rows).toBe(1);
    expect(registrations.threads).toBe(1);
    expect(registrations.messages).toBe(1);
    expect(registrations.compose).toBe(1);

    // Verify hooks execute on view events
    expect(threadCb).toBeDefined();
    const addSidebarContentPanel = vi.fn();
    const destroyCbs: (() => void)[] = [];
    const mockThreadView = {
      getThreadID: () => 'thread-reg-1',
      getSubject: () => 'Test Subject',
      getMessageViewsAll: () => [],
      addSidebarContentPanel,
      on: vi.fn((event, cb) => {
        if (event === 'destroy') destroyCbs.push(cb);
      }),
    };

    threadCb!(mockThreadView);
    await vi.waitFor(() => {
      expect(addSidebarContentPanel).not.toHaveBeenCalled();
      expect(document.getElementById('gi-thread-panel')).toBeNull();
      expect(chrome.runtime.sendMessage).toHaveBeenCalledWith(expect.objectContaining({ type: 'SET_WORKSPACE_CONTEXT' }), expect.any(Function));
    });

    destroyCbs.forEach((cb) => cb());
    await vi.waitFor(() => {
      expect(document.getElementById('gi-thread-panel')).toBeNull();
      expect(chrome.runtime.sendMessage).toHaveBeenCalledWith(expect.objectContaining({ type: 'SET_WORKSPACE_CONTEXT', context: null }), expect.any(Function));
    });

    // Row view sets thread id attribute
    expect(rowCb).toBeDefined();
    const rowElement = document.createElement('tr');
    rowElement.className = 'zA';
    document.body.appendChild(rowElement);

    const mockRowView = {
      getThreadIDAsync: async () => 'thread-row-abc',
      getElement: () => rowElement,
    };
    rowCb!(mockRowView);
    await vi.waitFor(() => {
      expect(rowElement.getAttribute('data-gi-thread-id')).toBe('thread-row-abc');
    });
    // Compose view invokes compose tracking hook
    expect(composeCb).toBeDefined();
    const mockComposeView = {
      on: vi.fn(),
      getElement: () => document.createElement('div'),
      getThreadIDAsync: async () => 'thread-compose-1',
      registerRequestModifier: vi.fn(),
    };
    composeCb!(mockComposeView);
    // Compose view tracking listener attached
    expect(mockComposeView.on).toHaveBeenCalledWith('presending', expect.any(Function));

    // Message view invokes sender self-view logic safely
    expect(messageCb).toBeDefined();
    const mockMessageView = {
      isLoaded: () => true,
      getMessageIDAsync: async () => 'msg-self-view-1',
      getSender: () => ({ emailAddress: 'sender@example.com', name: 'Sender' }),
      getBodyElement: () => document.createElement('div'),
      on: vi.fn(),
    };
    expect(() => messageCb!(mockMessageView)).not.toThrow();

    // Verify NavMenu error scenario: if NavMenu were called, it would throw "should not happen",
    // but mountSdkUi completely avoids NavMenu
    const brokenNavMenuSdk = {
      ...mockSdk,
      NavMenu: {
        addNavItem: () => {
          throw new Error('should not happen');
        },
      },
    };
    expect(() => mountSdkUi(brokenNavMenuSdk as unknown as InboxSdkLike, adapter)).not.toThrow();
    rowElement.remove();
  });
});
