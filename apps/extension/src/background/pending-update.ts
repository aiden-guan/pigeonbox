/**
 * Chrome Web Store updates, installed while nobody is looking at Gmail.
 *
 * Chrome downloads a store update by itself but installs it only once the
 * service worker goes idle, and an open Gmail keeps PigeonBox busy, so an
 * update can wait until the browser restarts. When Chrome says one is ready,
 * PigeonBox restarts into it as soon as no Gmail tab is on screen or has a
 * compose open and no PigeonBox page is open.
 *
 * Chrome does not give already-open tabs the new content script, so after any
 * version change Gmail tabs out of sight are refreshed, and a visible one gets
 * a notice that refreshes it when clicked or once it is hidden with no compose.
 */
import { SELECTORS } from '@pigeonbox/gmail';
import { GMAIL_RELOAD_AFTER_RESTART_KEY } from '../reload-extension';

const PENDING_UPDATE_KEY = 'pbPendingUpdate';
export const COMPOSE_SELECTOR = SELECTORS.composeBody.join(', ');

export type GmailTabState = { composing: boolean; visible: boolean };
export type NoticeTheme = 'light' | 'dark' | 'system';
type GmailTab = { id?: number; status?: string; discarded?: boolean };

export type PendingUpdateDeps = {
  currentVersion: () => string;
  readPending: () => Promise<string | null>;
  writePending: (version: string | null) => Promise<void>;
  gmailTabs: () => Promise<GmailTab[]>;
  /** null when the tab cannot be scripted (still loading, an error page). */
  inspect: (tabId: number) => Promise<GmailTabState | null>;
  extensionPagesOpen: () => Promise<boolean>;
  restart: () => void;
  developerReloadPending: () => Promise<boolean>;
  theme: () => Promise<NoticeTheme>;
  reloadTab: (tabId: number) => Promise<void>;
  showNotice: (tabId: number, theme: NoticeTheme) => Promise<void>;
};

/** Runs inside the Gmail page, so it may not use anything from this module. */
export function readGmailTabState(composeSelector: string): GmailTabState {
  return { composing: Boolean(document.querySelector(composeSelector)), visible: document.visibilityState === 'visible' };
}

/** Runs inside the Gmail page, so it may not use anything from this module. */
export function showGmailUpdateNotice(composeSelector: string, theme: NoticeTheme): void {
  document.querySelector('[data-pb-update-notice]')?.remove();
  const dark = theme === 'dark' || (theme === 'system' && window.matchMedia('(prefers-color-scheme: dark)').matches);
  const c = dark
    ? { surface: '#191b1e', border: '#2e3237', fg: '#ebe7de', muted: '#8b9199', accent: '#e48a65' }
    : { surface: '#ffffff', border: '#dce2df', fg: '#253039', muted: '#64717b', accent: '#9a4b2e' };
  const host = document.createElement('div');
  host.setAttribute('data-pb-update-notice', '');
  host.style.cssText = 'position:fixed;left:0;right:0;bottom:24px;z-index:2147483646;display:flex;justify-content:center;pointer-events:none;';
  const shadow = host.attachShadow({ mode: 'open' });
  const style = document.createElement('style');
  style.textContent = `
    .notice { pointer-events: auto; display: flex; align-items: center; gap: 4px; max-width: min(460px, calc(100vw - 32px));
      padding: 4px 4px 4px 12px; border-radius: 4px; background: ${c.surface}; color: ${c.fg}; border: 1px solid ${c.border};
      font: 13px/1.35 ui-sans-serif, system-ui, sans-serif; }
    .text { padding-right: 8px; }
    button { min-height: 32px; border: 0; border-radius: 6px; background: transparent; font: inherit; cursor: pointer; }
    button:focus-visible { outline: 2px solid ${c.accent}; outline-offset: 1px; }
    .reload { padding: 0 8px; color: ${c.accent}; font-weight: 600; }
    .reload:active { transform: translateY(1px); }
    .dismiss { width: 32px; padding: 0; color: ${c.muted}; font-size: 16px; line-height: 1; }
  `;
  const notice = document.createElement('div');
  notice.className = 'notice';
  notice.setAttribute('role', 'status');
  const text = document.createElement('span');
  text.className = 'text';
  text.textContent = 'PigeonBox was updated. Reload Gmail to keep using it.';
  const reload = document.createElement('button');
  reload.type = 'button';
  reload.className = 'reload';
  reload.textContent = 'Reload';
  reload.onclick = () => window.location.reload();
  const dismiss = document.createElement('button');
  dismiss.type = 'button';
  dismiss.className = 'dismiss';
  dismiss.setAttribute('aria-label', 'Dismiss');
  dismiss.textContent = '×';
  // Dismissing hides the notice only; the page still refreshes once it is out of sight.
  dismiss.onclick = () => host.remove();
  notice.append(text, reload, dismiss);
  shadow.append(style, notice);
  document.documentElement.append(host);
  document.addEventListener('visibilitychange', () => {
    if (document.visibilityState === 'hidden' && !document.querySelector(composeSelector)) window.location.reload();
  });
}

const defaults: PendingUpdateDeps = {
  currentVersion: () => chrome.runtime.getManifest().version,
  readPending: async () => {
    const value = (await chrome.storage.session.get(PENDING_UPDATE_KEY))[PENDING_UPDATE_KEY];
    return typeof value === 'string' ? value : null;
  },
  writePending: (version) =>
    version ? chrome.storage.session.set({ [PENDING_UPDATE_KEY]: version }) : chrome.storage.session.remove(PENDING_UPDATE_KEY),
  gmailTabs: () => chrome.tabs.query({ url: 'https://mail.google.com/*' }),
  inspect: async (tabId) => {
    try {
      const [injection] = await chrome.scripting.executeScript({ target: { tabId }, func: readGmailTabState, args: [COMPOSE_SELECTOR] });
      return (injection?.result as GmailTabState | undefined) ?? null;
    } catch {
      return null;
    }
  },
  extensionPagesOpen: async () => {
    const { ContextType } = chrome.runtime;
    const contexts = await chrome.runtime.getContexts({ contextTypes: [ContextType.TAB, ContextType.SIDE_PANEL, ContextType.POPUP] });
    // PigeonBox frames inside Gmail are covered by the Gmail checks; a top-level page would close on restart.
    return contexts.some((context) => context.contextType !== ContextType.TAB || context.frameId === 0);
  },
  restart: () => chrome.runtime.reload(),
  developerReloadPending: async () => (await chrome.storage.local.get(GMAIL_RELOAD_AFTER_RESTART_KEY))[GMAIL_RELOAD_AFTER_RESTART_KEY] === true,
  theme: async () => {
    const value = (await chrome.storage.local.get('pigeonboxAppearance')).pigeonboxAppearance;
    return value === 'dark' || value === 'system' ? value : 'light';
  },
  reloadTab: (tabId) => chrome.tabs.reload(tabId),
  showNotice: async (tabId, theme) => {
    await chrome.scripting.executeScript({ target: { tabId }, func: showGmailUpdateNotice, args: [COMPOSE_SELECTOR, theme] });
  },
};

/** Remember Chrome's downloaded update, then install it now if that is safe. */
export async function noteUpdateAvailable(version: string, deps: PendingUpdateDeps = defaults): Promise<'none' | 'waiting' | 'restarting'> {
  await deps.writePending(version);
  return applyPendingUpdateIfQuiet(deps);
}

/** Restart into a downloaded update unless someone is using Gmail or a PigeonBox page. */
export async function applyPendingUpdateIfQuiet(deps: PendingUpdateDeps = defaults): Promise<'none' | 'waiting' | 'restarting'> {
  const pending = await deps.readPending();
  if (!pending) return 'none';
  if (pending === deps.currentVersion()) {
    await deps.writePending(null);
    return 'none';
  }
  if (await deps.extensionPagesOpen()) return 'waiting';
  for (const tab of await deps.gmailTabs()) {
    if (tab.id == null || tab.discarded) continue;
    const state = await deps.inspect(tab.id);
    if (state?.composing || state?.visible) return 'waiting';
  }
  console.info(`[gi] restarting into PigeonBox ${pending}`);
  deps.restart();
  return 'restarting';
}

/** After a version change, bring open Gmail tabs onto the new content script. */
export async function refreshGmailAfterUpdate(deps: PendingUpdateDeps = defaults): Promise<{ reloaded: number; noticed: number }> {
  const result = { reloaded: 0, noticed: 0 };
  // A developer reload refreshes every Gmail tab on its own.
  if (await deps.developerReloadPending()) return result;
  const theme = await deps.theme();
  for (const tab of await deps.gmailTabs()) {
    if (tab.id == null || tab.discarded || tab.status !== 'complete') continue;
    const state = await deps.inspect(tab.id);
    if (!state) continue;
    try {
      if (!state.visible && !state.composing) {
        await deps.reloadTab(tab.id);
        result.reloaded += 1;
      } else {
        await deps.showNotice(tab.id, theme);
        result.noticed += 1;
      }
    } catch {
      /* The tab closed or navigated away meanwhile. */
    }
  }
  return result;
}
