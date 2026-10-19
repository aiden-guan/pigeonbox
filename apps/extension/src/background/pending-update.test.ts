/** @vitest-environment jsdom */
import { afterEach, describe, expect, it, vi } from 'vitest';
import {
  COMPOSE_SELECTOR,
  applyPendingUpdateIfQuiet,
  noteUpdateAvailable,
  readGmailTabState,
  refreshGmailAfterUpdate,
  showGmailUpdateNotice,
  type GmailTabState,
  type PendingUpdateDeps,
} from './pending-update';

type Tab = { id?: number; status?: string; discarded?: boolean; state?: GmailTabState | null };

function deps(tabs: Tab[], overrides: Partial<PendingUpdateDeps> = {}) {
  let pending: string | null = null;
  const d = {
    currentVersion: () => '0.8.3',
    readPending: vi.fn(async () => pending),
    writePending: vi.fn(async (version: string | null) => { pending = version; }),
    gmailTabs: vi.fn(async () => tabs.map(({ state: _state, ...tab }) => ({ status: 'complete', ...tab }))),
    inspect: vi.fn(async (tabId: number) => tabs.find((tab) => tab.id === tabId)?.state ?? null),
    extensionPagesOpen: vi.fn(async () => false),
    restart: vi.fn(),
    developerReloadPending: vi.fn(async () => false),
    theme: vi.fn(async () => 'light' as const),
    reloadTab: vi.fn(async () => undefined),
    showNotice: vi.fn(async () => undefined),
    ...overrides,
  };
  return d;
}

const quiet = { composing: false, visible: false };

describe('installing a downloaded store update', () => {
  it('restarts right away when no Gmail tab is on screen or composing', async () => {
    const d = deps([{ id: 1, state: quiet }, { id: 2, state: quiet }]);
    expect(await noteUpdateAvailable('0.8.4', d)).toBe('restarting');
    expect(d.writePending).toHaveBeenCalledWith('0.8.4');
    expect(d.restart).toHaveBeenCalledOnce();
  });

  it('waits while Gmail is on screen, a compose is open, or a PigeonBox page is open', async () => {
    for (const d of [
      deps([{ id: 1, state: quiet }, { id: 2, state: { composing: false, visible: true } }]),
      deps([{ id: 1, state: { composing: true, visible: false } }]),
      deps([{ id: 1, state: quiet }], { extensionPagesOpen: vi.fn(async () => true) }),
    ]) {
      expect(await noteUpdateAvailable('0.8.4', d)).toBe('waiting');
      expect(d.restart).not.toHaveBeenCalled();
    }
  });

  it('retries later and restarts once Gmail is out of sight', async () => {
    const tabs: Tab[] = [{ id: 1, state: { composing: false, visible: true } }];
    const d = deps(tabs);
    expect(await noteUpdateAvailable('0.8.4', d)).toBe('waiting');
    tabs[0].state = quiet;
    expect(await applyPendingUpdateIfQuiet(d)).toBe('restarting');
    expect(d.restart).toHaveBeenCalledOnce();
  });

  it('ignores discarded tabs and tabs it cannot inspect', async () => {
    const d = deps([{ id: 1, discarded: true, state: { composing: true, visible: true } }, { id: 2, state: null }]);
    expect(await noteUpdateAvailable('0.8.4', d)).toBe('restarting');
    expect(d.inspect).not.toHaveBeenCalledWith(1);
  });

  it('does nothing without a downloaded update, and forgets one that is already running', async () => {
    const d = deps([{ id: 1, state: quiet }]);
    expect(await applyPendingUpdateIfQuiet(d)).toBe('none');
    await d.writePending('0.8.3');
    expect(await applyPendingUpdateIfQuiet(d)).toBe('none');
    expect(await d.readPending()).toBeNull();
    expect(d.restart).not.toHaveBeenCalled();
  });
});

describe('Gmail tabs after an update', () => {
  it('refreshes tabs out of sight and asks the visible or composing ones', async () => {
    const d = deps([
      { id: 1, state: quiet },
      { id: 2, state: { composing: false, visible: true } },
      { id: 3, state: { composing: true, visible: false } },
    ], { theme: vi.fn(async () => 'dark' as const) });
    expect(await refreshGmailAfterUpdate(d)).toEqual({ reloaded: 1, noticed: 2 });
    expect(d.reloadTab).toHaveBeenCalledWith(1);
    expect(d.showNotice).toHaveBeenCalledWith(2, 'dark');
    expect(d.showNotice).toHaveBeenCalledWith(3, 'dark');
  });

  it('leaves loading, discarded and unreachable tabs alone', async () => {
    const d = deps([{ id: 1, status: 'loading', state: quiet }, { id: 2, discarded: true, state: quiet }, { id: 3, state: null }]);
    expect(await refreshGmailAfterUpdate(d)).toEqual({ reloaded: 0, noticed: 0 });
    expect(d.reloadTab).not.toHaveBeenCalled();
  });

  it('leaves a developer reload to refresh Gmail itself', async () => {
    const d = deps([{ id: 1, state: quiet }], { developerReloadPending: vi.fn(async () => true) });
    expect(await refreshGmailAfterUpdate(d)).toEqual({ reloaded: 0, noticed: 0 });
    expect(d.inspect).not.toHaveBeenCalled();
  });
});

describe('in the Gmail page', () => {
  afterEach(() => {
    document.querySelector('[data-pb-update-notice]')?.remove();
    document.body.innerHTML = '';
    Reflect.deleteProperty(document, 'visibilityState');
    vi.restoreAllMocks();
  });

  function setVisibility(value: 'visible' | 'hidden') {
    Object.defineProperty(document, 'visibilityState', { configurable: true, get: () => value });
    document.dispatchEvent(new Event('visibilitychange'));
  }

  it('reports an open compose and whether the page is on screen', () => {
    expect(readGmailTabState(COMPOSE_SELECTOR)).toEqual({ composing: false, visible: true });
    document.body.innerHTML = '<div g_editable="true" contenteditable="true"></div>';
    setVisibility('hidden');
    expect(readGmailTabState(COMPOSE_SELECTOR)).toEqual({ composing: true, visible: false });
  });

  it('shows one notice with Reload and Dismiss', () => {
    showGmailUpdateNotice(COMPOSE_SELECTOR, 'light');
    showGmailUpdateNotice(COMPOSE_SELECTOR, 'light');
    const hosts = document.querySelectorAll('[data-pb-update-notice]');
    expect(hosts).toHaveLength(1);
    const root = hosts[0].shadowRoot!;
    expect(root.querySelector('[role="status"]')?.textContent).toContain('PigeonBox was updated. Reload Gmail to keep using it.');
    expect(root.querySelector('.reload')?.textContent).toBe('Reload');
    (root.querySelector('[aria-label="Dismiss"]') as HTMLButtonElement).click();
    expect(document.querySelector('[data-pb-update-notice]')).toBeNull();
  });

  it('follows the system theme when asked to', () => {
    vi.stubGlobal('matchMedia', vi.fn(() => ({ matches: true })));
    showGmailUpdateNotice(COMPOSE_SELECTOR, 'system');
    const css = document.querySelector('[data-pb-update-notice]')!.shadowRoot!.querySelector('style')!.textContent!;
    expect(css).toContain('#191b1e');
    vi.unstubAllGlobals();
  });

  it('refreshes once the page is hidden, but never over an open compose', () => {
    // jsdom cannot navigate; it reports each reload attempt as a "not implemented" error.
    const virtualConsole = (globalThis as unknown as { jsdom: { virtualConsole: NodeJS.EventEmitter } }).jsdom.virtualConsole;
    let navigations = 0;
    const onError = (error: Error) => { if (error.message.includes('navigation')) navigations += 1; };
    virtualConsole.on('jsdomError', onError);
    try {
      showGmailUpdateNotice(COMPOSE_SELECTOR, 'light');
      document.body.innerHTML = '<div g_editable="true" contenteditable="true"></div>';
      setVisibility('hidden');
      expect(navigations).toBe(0);
      setVisibility('visible');
      document.body.innerHTML = '';
      setVisibility('hidden');
      expect(navigations).toBeGreaterThan(0);
    } finally {
      virtualConsole.off('jsdomError', onError);
    }
  });
});
