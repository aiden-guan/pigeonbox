/**
 * @vitest-environment jsdom
 */
import { act } from 'react';
import { createRoot } from 'react-dom/client';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { DEFAULT_SETTINGS } from '@pigeonbox/shared';
import { INITIAL_PRODUCT_STATE, type ProductState } from '../ui/product-state';
import { SettingsApp } from './SettingsApp';

(globalThis as unknown as { IS_REACT_ACT_ENVIRONMENT: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

const CLOUD_READY: ProductState = {
  ...INITIAL_PRODUCT_STATE,
  runMode: 'cloud',
  cloudAvailable: true,
  cloudConsentAt: '2026-09-01T00:00:00Z',
  cloud: { status: 'ready', email: 'owner@fixture.test', capabilities: ['cloud_mail_sync'] },
  capabilities: ['ask_inbox', 'cloud_mail_sync'],
  aiDestination: 'pigeonbox_cloud',
  cloudOrigins: ['https://cloud.fixture.test/*'],
};

describe('Settings navigation and server gating', () => {
  let container: HTMLDivElement;
  let root: ReturnType<typeof createRoot>;
  let product: ProductState;
  let sendMessage: ReturnType<typeof vi.fn>;

  beforeEach(() => {
    container = document.createElement('div');
    document.body.appendChild(container);
    root = createRoot(container);
    product = INITIAL_PRODUCT_STATE;
    sendMessage = vi.fn((message: { type: string }, callback?: (value: unknown) => void) => {
      if (message.type === 'GET_SETTINGS') callback?.({ settings: { ...DEFAULT_SETTINGS } });
      else if (message.type === 'GET_PRODUCT_STATE') callback?.(product);
      else if (message.type === 'CHECK_TRACKER') callback?.({ status: 'missing' });
    });
    (globalThis as unknown as { chrome: unknown }).chrome = {
      runtime: { id: 'test-extension-id', sendMessage, getURL: (path: string) => `chrome-extension://test-id/${path}`, getManifest: () => ({ version: '0.5.0' }) },
      permissions: { request: vi.fn() },
      tabs: { create: vi.fn() },
    };
    vi.spyOn(globalThis, 'fetch').mockResolvedValue({ ok: false } as Response);
  });

  afterEach(async () => {
    await act(async () => root.unmount());
    container.remove();
    vi.restoreAllMocks();
  });

  async function render() {
    await act(async () => root.render(<SettingsApp />));
    await act(async () => undefined);
  }
  const navTargets = () => [...container.querySelectorAll<HTMLAnchorElement>('.gi-settings-nav a')].map((link) => link.hash.slice(1));
  const buttonNamed = (name: string) => [...container.querySelectorAll('button')].find((button) => button.textContent?.trim() === name);

  it('Local lists only rendered sections, in page order, with no server account controls', async () => {
    await render();
    expect(navTargets()).toEqual(['pigeonbox', 'ai', 'inbox', 'tracking', 'snippets', 'personalization', 'privacy', 'updates', 'advanced']);
    const rendered = [...container.querySelectorAll('section[id]')].map((section) => section.id);
    for (const id of navTargets().filter((id) => id !== 'advanced')) expect(rendered).toContain(id);
    // Sections appear in the same order as the navigation.
    expect(rendered.filter((id) => navTargets().includes(id))).toEqual(navTargets().filter((id) => id !== 'advanced'));
    expect(container.querySelector('#cloud')).toBeNull();
    expect(container.querySelector('#memory')).toBeNull();
    expect(buttonNamed('Manage on your server ↗')).toBeUndefined();
    expect(buttonNamed('Manage server data and retention ↗')).toBeUndefined();
    // Without a configured server there is no server mode to pick, only a quiet pointer to self-hosting.
    expect(container.querySelectorAll('#run-mode .gi-choice')).toHaveLength(2);
    expect(container.textContent).not.toContain('Your PigeonBox server');
    const guide = [...container.querySelectorAll<HTMLAnchorElement>('a')].find((link) => link.textContent === 'Run your own server ↗');
    expect(guide?.href).toBe('https://github.com/aiden-guan/pigeonbox/blob/main/docs/self-hosting.md');
    expect(container.innerHTML).not.toMatch(/workers\.dev/);
    expect(container.textContent).not.toMatch(/\bPro\b|\bFree\b|upgrade|waitlist|Sent with PigeonBox|subscri/i);
  });

  it('Advanced offers the PigeonBox server URL', async () => {
    const originalScrollIntoView = Object.getOwnPropertyDescriptor(Element.prototype, 'scrollIntoView');
    Object.defineProperty(Element.prototype, 'scrollIntoView', { configurable: true, value: vi.fn() });
    try {
      await render();
      await act(async () => {
        buttonNamed('Advanced')!.click();
        await new Promise<void>((resolve) => requestAnimationFrame(() => resolve()));
      });
      const field = [...container.querySelectorAll('label')].find((label) => label.textContent?.startsWith('PigeonBox server URL'));
      expect(field?.querySelector('input')).not.toBeNull();
    } finally {
      if (originalScrollIntoView) Object.defineProperty(Element.prototype, 'scrollIntoView', originalScrollIntoView);
      else Reflect.deleteProperty(Element.prototype, 'scrollIntoView');
    }
  });

  it('the Advanced link reveals the collapsed section instead of pointing at nothing', async () => {
    const originalScrollIntoView = Object.getOwnPropertyDescriptor(Element.prototype, 'scrollIntoView');
    const scrollIntoView = vi.fn();
    Object.defineProperty(Element.prototype, 'scrollIntoView', { configurable: true, value: scrollIntoView });
    try {
      await render();
      expect(container.querySelector('#advanced')).toBeNull();
      const advanced = [...container.querySelectorAll<HTMLAnchorElement>('.gi-settings-nav a')].find((link) => link.hash === '#advanced')!;
      await act(async () => {
        advanced.click();
        await new Promise<void>((resolve) => requestAnimationFrame(() => resolve()));
      });
      expect(container.querySelector('#advanced')).not.toBeNull();
      expect(scrollIntoView).toHaveBeenCalled();
    } finally {
      if (originalScrollIntoView) Object.defineProperty(Element.prototype, 'scrollIntoView', originalScrollIntoView);
      else Reflect.deleteProperty(Element.prototype, 'scrollIntoView');
    }
  });

  it('a stored server mode without a configured server exposes no account controls', async () => {
    product = { ...CLOUD_READY, cloudAvailable: false };
    await render();
    expect(navTargets()).not.toContain('cloud');
    expect(navTargets()).not.toContain('memory');
    expect(buttonNamed('Manage on your server ↗')).toBeUndefined();
    expect(buttonNamed('Manage server data and retention ↗')).toBeUndefined();
  });

  it('a configured, signed-in server shows server sections and one account action routed through the worker', async () => {
    product = CLOUD_READY;
    await render();
    expect(navTargets()).toEqual(['pigeonbox', 'inbox', 'tracking', 'snippets', 'cloud', 'personalization', 'privacy', 'updates', 'advanced']);
    expect(container.querySelector('#cloud')).not.toBeNull();
    expect(container.querySelector('#memory')).toBeNull();
    expect(buttonNamed('Manage billing')).toBeUndefined();
    expect(buttonNamed('Switch to this computer')).toBeDefined();
    expect(container.querySelector('#run-mode')?.textContent).toContain('Your PigeonBox server');
    expect(container.querySelector('#privacy')?.textContent).toContain('Your PigeonBox serverOnly when PigeonBox runs on your server.');
    const manage = buttonNamed('Manage on your server ↗');
    expect(manage).toBeDefined();
    await act(async () => manage!.click());
    expect(sendMessage).toHaveBeenCalledWith({ type: 'CLOUD_OPEN', section: 'overview' });
  });

  it('explains where data goes and keeps privacy controls working', async () => {
    await render();
    const privacy = container.querySelector('#privacy')!;
    expect(privacy.textContent).toContain('On this computer');
    expect(privacy.textContent).toContain('AI provider');
    expect(privacy.textContent).not.toContain('Your PigeonBox server');
    expect(privacy.textContent).toContain('PigeonBox sends no product analytics.');
    expect(privacy.querySelector('input[type="checkbox"]')).toBeNull();
    const confirm = vi.spyOn(window, 'confirm').mockReturnValue(true);
    await act(async () => buttonNamed('Clear local mail index')!.click());
    expect(confirm).toHaveBeenCalled();
    expect(sendMessage).toHaveBeenCalledWith({ type: 'CLEAR_INDEX' });
    expect(container.querySelector('#ai')?.textContent).toContain('AI is off. Nothing is sent to an AI provider.');
  });
});
