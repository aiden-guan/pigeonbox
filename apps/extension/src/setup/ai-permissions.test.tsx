/**
 * @vitest-environment jsdom
 */
import { act } from 'react';
import { createRoot } from 'react-dom/client';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { DEFAULT_SETTINGS, getProviderRequiredOrigin } from '@pigeonbox/shared';
import { AiConnect } from './AiConnect';
import { SettingsApp } from '../settings/SettingsApp';

(globalThis as unknown as { IS_REACT_ACT_ENVIRONMENT: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

describe('ai permissions', () => {
  let container: HTMLDivElement;
  let root: ReturnType<typeof createRoot>;
  let requestMock: ReturnType<typeof vi.fn>;
  let containsMock: ReturnType<typeof vi.fn>;
  let sendMessageMock: ReturnType<typeof vi.fn>;

  beforeEach(() => {
    container = document.createElement('div');
    document.body.appendChild(container);
    root = createRoot(container);

    requestMock = vi.fn();
    containsMock = vi.fn();
    sendMessageMock = vi.fn((_msg, cb) => {
      if (typeof cb === 'function') cb({ signedIn: false });
    });

    (globalThis as unknown as { chrome: unknown }).chrome = {
      runtime: {
        id: 'test-extension-id',
        sendMessage: sendMessageMock,
        onMessage: {
          addListener: vi.fn(),
          removeListener: vi.fn(),
        },
        lastError: undefined,
      },
      permissions: {
        request: requestMock,
        contains: containsMock,
      },
    };
  });

  afterEach(async () => {
    await act(async () => {
      root.unmount();
    });
    container.remove();
    vi.clearAllMocks();
  });

  it('determines the correct required origin for each provider', () => {
    expect(getProviderRequiredOrigin('openai')).toBe('https://api.openai.com/*');
    expect(getProviderRequiredOrigin('ollama')).toBe('http://127.0.0.1:11434/*');
    expect(getProviderRequiredOrigin('ollama', 'http://localhost:11434/v1')).toBe('http://localhost:11434/*');
    expect(getProviderRequiredOrigin('openai-compatible', 'https://api.groq.com/openai/v1')).toBe('https://api.groq.com/*');
    expect(getProviderRequiredOrigin('openai-compatible', 'not-a-valid-url')).toBeNull();
    expect(getProviderRequiredOrigin('chatgpt')).toBeNull();
    expect(getProviderRequiredOrigin('chrome')).toBeNull();
  });

  it('surfaces an error and does not activate provider when permission is denied', async () => {
    requestMock.mockResolvedValue(false);
    const onPatch = vi.fn();

    await act(async () => {
      root.render(<AiConnect settings={DEFAULT_SETTINGS} onPatch={onPatch} />);
    });

    // Expand the "API key or Ollama" section
    const toggleButton = Array.from(container.querySelectorAll('button')).find((btn) =>
      btn.textContent?.includes('API key or Ollama'),
    );
    expect(toggleButton).toBeTruthy();
    await act(async () => {
      toggleButton!.click();
    });

    // Click "Use this connection" for default OpenAI provider
    const useConnButton = Array.from(container.querySelectorAll('button')).find((btn) =>
      btn.textContent?.includes('Use this connection'),
    );
    expect(useConnButton).toBeTruthy();

    await act(async () => {
      useConnButton!.click();
    });

    expect(requestMock).toHaveBeenCalledWith({
      origins: ['https://api.openai.com/*'],
    });
    expect(onPatch).not.toHaveBeenCalled();
    expect(container.textContent).toContain(
      'Host permission for https://api.openai.com/* was not granted. Please approve to connect.',
    );
  });

  it('activates provider and updates settings when permission is granted', async () => {
    requestMock.mockResolvedValue(true);
    const onPatch = vi.fn();

    await act(async () => {
      root.render(<AiConnect settings={DEFAULT_SETTINGS} onPatch={onPatch} />);
    });

    const toggleButton = Array.from(container.querySelectorAll('button')).find((btn) =>
      btn.textContent?.includes('API key or Ollama'),
    );
    await act(async () => {
      toggleButton!.click();
    });

    const useConnButton = Array.from(container.querySelectorAll('button')).find((btn) =>
      btn.textContent?.includes('Use this connection'),
    );
    await act(async () => {
      useConnButton!.click();
    });

    expect(requestMock).toHaveBeenCalledWith({
      origins: ['https://api.openai.com/*'],
    });
    expect(onPatch).toHaveBeenCalledWith(
      expect.objectContaining({
        aiMode: 'remote',
        aiProvider: 'openai',
      }),
    );
    expect(container.textContent).not.toContain('Host permission for');
  });

  it('requests correct origin for ollama and prevents activation on denial', async () => {
    requestMock.mockResolvedValue(false);
    const onPatch = vi.fn();

    await act(async () => {
      root.render(<AiConnect settings={DEFAULT_SETTINGS} onPatch={onPatch} />);
    });

    const toggleButton = Array.from(container.querySelectorAll('button')).find((btn) =>
      btn.textContent?.includes('API key or Ollama'),
    );
    await act(async () => {
      toggleButton!.click();
    });

    // Change provider to ollama
    const select = container.querySelector('select');
    expect(select).toBeTruthy();
    await act(async () => {
      select!.value = 'ollama';
      select!.dispatchEvent(new Event('change', { bubbles: true }));
    });

    const useConnButton = Array.from(container.querySelectorAll('button')).find((btn) =>
      btn.textContent?.includes('Use this connection'),
    );
    await act(async () => {
      useConnButton!.click();
    });

    expect(requestMock).toHaveBeenCalledWith({
      origins: ['http://127.0.0.1:11434/*'],
    });
    expect(onPatch).not.toHaveBeenCalled();
    expect(container.textContent).toContain(
      'Host permission for http://127.0.0.1:11434/* was not granted. Please approve to connect.',
    );
  });

  it('verifies chrome.permissions.contains checks host permission status', async () => {
    containsMock.mockImplementation(async ({ origins }: { origins: string[] }) => {
      return origins.includes('https://api.openai.com/*');
    });

    const hasOpenAi = await chrome.permissions.contains({ origins: ['https://api.openai.com/*'] });
    const hasOllama = await chrome.permissions.contains({ origins: ['http://127.0.0.1:11434/*'] });

    expect(hasOpenAi).toBe(true);
    expect(hasOllama).toBe(false);
  });

  it('requests host permissions for both active tracker and AI origins when saving in SettingsApp', async () => {
    requestMock.mockImplementation((_opts, cb) => {
      if (typeof cb === 'function') cb(true);
      return Promise.resolve(true);
    });
    sendMessageMock.mockImplementation((msg, cb) => {
      if (msg.type === 'GET_SETTINGS') {
        if (typeof cb === 'function') {
          cb({
            settings: {
              ...DEFAULT_SETTINGS,
              trackerBaseUrl: 'https://custom-tracker.com',
              aiMode: 'remote',
              aiProvider: 'ollama',
              aiEndpoint: 'http://127.0.0.1:11434',
            },
          });
        }
      } else if (msg.type === 'SAVE_SETTINGS') {
        if (typeof cb === 'function') cb({ settings: msg.settings });
      } else if (msg.type === 'CHECK_TRACKER') {
        if (typeof cb === 'function') cb({ status: 'healthy' });
      }
    });

    await act(async () => {
      root.render(<SettingsApp />);
    });

    const saveButton = Array.from(container.querySelectorAll('button')).find((btn) =>
      btn.textContent?.trim() === 'Save',
    );
    expect(saveButton).toBeTruthy();

    await act(async () => {
      saveButton!.click();
    });

    expect(requestMock).toHaveBeenCalledWith(
      expect.objectContaining({
        origins: expect.arrayContaining([
          'https://custom-tracker.com/*',
          'http://127.0.0.1:11434/*',
        ]),
      }),
      expect.any(Function),
    );
  });
});
