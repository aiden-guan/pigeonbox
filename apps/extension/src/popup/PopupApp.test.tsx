/**
 * @vitest-environment jsdom
 */
import { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { INITIAL_PRODUCT_STATE } from '../ui/product-state';
import { PopupApp } from './PopupApp';

type DiagnosticFixture = {
  gmailTab?: string;
  runMode?: 'local' | 'cloud';
  indexedThreads?: number;
  currentThreadId?: string | null;
  ai?: { status?: string; provider?: string; model?: string; mode?: string; configurationStatus?: string };
  tracking?: string;
};

describe('PigeonBox popup', () => {
  let host: HTMLDivElement;
  let root: Root;
  let sendMessage: ReturnType<typeof vi.fn>;
  let closeWindow: ReturnType<typeof vi.spyOn>;

  (globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

  beforeEach(() => {
    host = document.createElement('div');
    document.body.append(host);
    root = createRoot(host);
    closeWindow = vi.spyOn(window, 'close').mockImplementation(() => undefined);
  });

  afterEach(async () => {
    await act(async () => root.unmount());
    host.remove();
    delete (globalThis as { chrome?: unknown }).chrome;
    vi.restoreAllMocks();
  });

  function installChrome(
    diag: DiagnosticFixture,
    options: { offscreen?: boolean; onDeviceStatus?: { qwenReady?: boolean; chromeAvailability?: string } } = {},
  ) {
    sendMessage = vi.fn((message: Record<string, unknown>, callback?: (response: unknown) => void) => {
      const response = message.type === 'GET_PRODUCT_STATE'
        ? INITIAL_PRODUCT_STATE
        : message.type === 'RUN_DIAGNOSTICS'
          ? diag
          : message.type === 'ON_DEVICE_STATUS'
            ? options.onDeviceStatus
          : message.type === 'FOCUS_SIDEPANEL'
            ? { ok: true }
            : undefined;
      callback?.(response);
      return Promise.resolve(response);
    });

    (globalThis as { chrome?: unknown }).chrome = {
      runtime: {
        id: 'pigeonbox-test',
        lastError: undefined,
        sendMessage,
        getURL: (path: string) => `chrome-extension://pigeonbox-test/${path}`,
        ContextType: { OFFSCREEN_DOCUMENT: 'OFFSCREEN_DOCUMENT' },
        getContexts: vi.fn().mockResolvedValue(options.offscreen ? [{}] : []),
        openOptionsPage: vi.fn(),
      },
      storage: {
        session: {
          get: vi.fn().mockResolvedValue({}),
          set: vi.fn().mockResolvedValue(undefined),
        },
      },
      tabs: {
        query: vi.fn().mockResolvedValue([{ id: 7, windowId: 4, url: 'https://mail.google.com/mail/u/0/#inbox' }]),
        create: vi.fn().mockResolvedValue({ id: 8 }),
        sendMessage: vi.fn().mockResolvedValue({ ok: true }),
      },
      sidePanel: { open: vi.fn().mockResolvedValue(undefined) },
    };
  }

  it('uses real inbox index data and keeps extension reload out of the popup', async () => {
    installChrome({
      gmailTab: 'connected',
      runMode: 'local',
      indexedThreads: 37,
      ai: { status: 'disabled', provider: 'openai' },
      tracking: 'healthy',
    });

    await act(async () => root.render(<PopupApp />));

    expect(host.textContent).toContain('37');
    expect(host.textContent).toContain('threads indexed');
    expect(host.textContent).toContain('Connected');
    expect(host.textContent).not.toContain('12 unread');
    expect(host.textContent).not.toContain('Reload extension');
    expect(host.querySelector('[aria-label="Open Settings"]')).toBeInstanceOf(HTMLButtonElement);
  });

  it('opens the command palette with the keyboard and runs the selected command', async () => {
    installChrome({
      gmailTab: 'connected',
      runMode: 'local',
      indexedThreads: 0,
      ai: { status: 'disabled', provider: 'openai' },
      tracking: 'healthy',
    });

    await act(async () => root.render(<PopupApp />));
    const isMac = navigator.platform.toLowerCase().includes('mac');
    await act(async () => {
      window.dispatchEvent(new KeyboardEvent('keydown', {
        key: 'k',
        bubbles: true,
        cancelable: true,
        ctrlKey: !isMac,
        metaKey: isMac,
      }));
    });

    const dialog = host.querySelector('[role="dialog"]');
    const input = host.querySelector('input[aria-label="Ask Pigeon or run a command"]') as HTMLInputElement;
    expect(dialog).toBeTruthy();
    expect(document.activeElement).toBe(input);

    await act(async () => {
      input.dispatchEvent(new KeyboardEvent('keydown', { key: 'ArrowDown', bubbles: true, cancelable: true }));
    });
    await act(async () => {
      input.dispatchEvent(new KeyboardEvent('keydown', { key: 'Enter', bubbles: true, cancelable: true }));
      await new Promise((resolve) => setTimeout(resolve, 0));
    });

    expect((globalThis as { chrome: any }).chrome.storage.session.set).toHaveBeenCalledWith({
      panelState: expect.objectContaining({ mode: 'ask', splitCategory: 'RESPOND' }),
    });
    expect(sendMessage).not.toHaveBeenCalledWith(
      expect.objectContaining({ type: 'FOCUS_SIDEPANEL' }),
      expect.anything(),
    );
    expect((globalThis as { chrome: any }).chrome.sidePanel.open).toHaveBeenCalledWith({ windowId: 4 });
    expect((globalThis as { chrome: any }).chrome.sidePanel.open).toHaveBeenCalledOnce();
    expect(closeWindow).toHaveBeenCalledOnce();
  });

  it('opens Gmail and Settings from their buttons', async () => {
    installChrome({
      gmailTab: 'disconnected',
      runMode: 'local',
      indexedThreads: 0,
      ai: { status: 'disabled', provider: 'openai' },
      tracking: 'disabled',
    });

    await act(async () => root.render(<PopupApp />));
    await act(async () => {
      host.querySelector('.pb-primary')?.dispatchEvent(new MouseEvent('click', { bubbles: true }));
      await new Promise((resolve) => setTimeout(resolve, 0));
    });
    await act(async () => {
      host.querySelector('[aria-label="Open Settings"]')?.dispatchEvent(new MouseEvent('click', { bubbles: true }));
      await new Promise((resolve) => setTimeout(resolve, 0));
    });

    const chromeApi = (globalThis as { chrome: any }).chrome;
    expect(chromeApi.tabs.create).toHaveBeenCalledWith({ url: 'https://mail.google.com/' });
    expect(chromeApi.runtime.openOptionsPage).toHaveBeenCalledOnce();
    expect(closeWindow).toHaveBeenCalledTimes(2);
  });

  it('shows disconnected and unavailable services without inventing inbox statistics', async () => {
    installChrome({
      gmailTab: 'unavailable',
      runMode: 'local',
      indexedThreads: 0,
      ai: { status: 'error', provider: 'local', model: 'qwen3-0.6b' },
      tracking: 'unreachable',
    });

    await act(async () => root.render(<PopupApp />));

    expect(host.textContent).toContain('Gmail not connected');
    expect(host.textContent).toContain('Unavailable');
    expect(host.textContent).toContain('0');
    expect(host.textContent).not.toContain('4 important');
    expect(host.textContent).not.toContain('Local AI Ready');
  });

  it('does not call a configured local provider ready before its model is loaded', async () => {
    installChrome({
      gmailTab: 'connected',
      runMode: 'local',
      indexedThreads: 12,
      ai: { status: 'ready', provider: 'local', model: 'qwen3-0.6b' },
      tracking: 'healthy',
    });

    await act(async () => {
      root.render(<PopupApp />);
      await new Promise((resolve) => setTimeout(resolve, 0));
    });

    const aiStatus = host.querySelector('[data-connection="ai"]')?.textContent;
    expect(aiStatus).toContain('Model idle');
    expect(aiStatus).not.toContain('Ready');
  });

  it('shows local AI ready only after the offscreen model runtime confirms it', async () => {
    installChrome({
      gmailTab: 'connected',
      runMode: 'local',
      indexedThreads: 12,
      ai: { status: 'ready', provider: 'local', model: 'qwen3-0.6b' },
      tracking: 'healthy',
    }, { offscreen: true, onDeviceStatus: { qwenReady: true } });

    await act(async () => {
      root.render(<PopupApp />);
      await new Promise((resolve) => setTimeout(resolve, 0));
    });

    expect(host.querySelector('[data-connection="ai"]')?.textContent).toContain('Ready');
  });
});
