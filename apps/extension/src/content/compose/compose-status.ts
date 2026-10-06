/**
 * The one ambient Pidgy in a compose window while real-time checks are on: a
 * small sprite in Send's row, left of the tracking badge (which stays
 * immediately left of Send). No text and no toolbar of its own.
 *
 *   idle       resting Pidgy, muted
 *   checking   one short sprite step (none with reduced motion)
 *   clear      a brief green dot after a check found nothing, then idle again
 *   attention  a peach dot while an advisory is active; clicking opens it
 *
 * Rendered in a shadow root so Gmail's styles and PigeonBox's cannot mix.
 */
import { findSendButton, SELECTORS } from '@pigeonbox/gmail';
import { SURFACE_CSS } from '../shell/surface';

export type ComposeStatusState = 'idle' | 'checking' | 'clear' | 'attention';
export type ComposeStatusHandle = {
  host: HTMLElement;
  set: (state: ComposeStatusState, label?: string) => void;
  state: () => ComposeStatusState;
  remove: () => void;
};

/** How long the quiet "nothing found" confirmation stays before Pidgy rests again. */
export const CLEAR_MS = 1_400;

const STATUS_CSS = `
:host { all: initial; display: inline-flex !important; align-items: center; vertical-align: middle; margin: 0 6px 0 0; }
.pb-status {
  box-sizing: border-box;
  display: inline-grid;
  place-items: center;
  width: 28px;
  height: 28px;
  padding: 0;
  border: 0;
  border-radius: var(--pb-radius-pill);
  background: transparent;
  color: var(--pb-fg-muted);
  font-size: 20px;
  line-height: 1;
  opacity: .62;
  transition: opacity var(--pb-motion-standard) var(--pb-ease), background-color var(--pb-motion-quick) var(--pb-ease);
}
.pb-status[data-state="checking"], .pb-status[data-state="clear"] { opacity: .9; }
.pb-status[data-state="attention"] { opacity: 1; cursor: pointer; }
button.pb-status:hover { background: var(--pb-accent-soft); }
button.pb-status:focus-visible { outline: 2px solid var(--pb-border-focus); outline-offset: 1px; }
.pb-status .gi-pigeon::after { transition: transform var(--pb-motion-standard) var(--pb-ease-spring); }
.pb-status[data-state="clear"] .gi-pigeon::after { content: ''; position: absolute; right: -1px; bottom: 0; width: 5px; height: 5px; border-radius: 50%; background: var(--pb-success); }
.pb-status[data-state="attention"] .gi-pigeon::after { content: ''; position: absolute; right: -2px; bottom: -1px; width: 7px; height: 7px; border-radius: 50%; background: var(--pb-accent); box-shadow: 0 0 0 2px var(--pb-surface-raised); }
.pb-live { position: absolute; width: 1px; height: 1px; overflow: hidden; clip: rect(0 0 0 0); white-space: nowrap; }
@media (prefers-reduced-motion: reduce) { .pb-status, .pb-status .gi-pigeon::after { transition: none; } }
`;

const LABEL: Record<ComposeStatusState, string> = {
  idle: 'Pidgy checks times and promises as you write',
  checking: 'Pidgy is checking',
  clear: 'Pidgy found nothing to flag',
  attention: 'Pidgy flagged something. Open it',
};

/** Rows of pigeon-sprites.webp: idle, indexing, drafting, opened, error (the warning pose). */
function sprite(row: number): HTMLSpanElement {
  const span = document.createElement('span');
  span.className = 'gi-pigeon';
  span.setAttribute('aria-hidden', 'true');
  const frame = document.createElement('span');
  frame.className = 'gi-pigeon-frame';
  let url = '/brand/pigeon-sprites.webp';
  try {
    url = chrome.runtime.getURL('brand/pigeon-sprites.webp');
  } catch {
    /* Tests and pages outside the extension. */
  }
  frame.style.backgroundImage = `url("${url}")`;
  frame.style.backgroundPosition = `0 ${-row * 0.8}em`;
  span.append(frame);
  return span;
}

/** Mount the status in `compose`, re-placing it when Gmail rebuilds the toolbar. */
export function mountComposeStatus(compose: HTMLElement, onOpen: () => void): ComposeStatusHandle {
  const host = document.createElement('span');
  host.setAttribute('data-gi-ui', 'pidgy-status');
  const shadow = host.attachShadow({ mode: 'open' });
  const style = document.createElement('style');
  style.textContent = `${SURFACE_CSS}\n${STATUS_CSS}`;
  const live = document.createElement('span');
  live.className = 'pb-live';
  live.setAttribute('role', 'status');
  live.setAttribute('aria-live', 'polite');
  let state: ComposeStatusState = 'idle';
  let control: HTMLElement = document.createElement('span');
  let clearTimer: number | undefined;

  const render = (label?: string) => {
    // Only the attention state is actionable; the others are quiet images, not empty buttons.
    const next = state === 'attention' ? document.createElement('button') : document.createElement('span');
    next.className = 'pb-status';
    next.dataset.state = state;
    const name = state === 'attention' && label ? `Pidgy: ${label}. Open` : LABEL[state];
    next.title = state === 'attention' && label ? label : LABEL[state];
    if (next instanceof HTMLButtonElement) {
      next.type = 'button';
      next.setAttribute('aria-label', name);
      next.setAttribute('aria-haspopup', 'dialog');
      next.addEventListener('mousedown', (event) => event.preventDefault());
      next.addEventListener('click', (event) => {
        event.preventDefault();
        event.stopPropagation();
        onOpen();
      });
    } else {
      next.setAttribute('role', 'img');
      next.setAttribute('aria-label', name);
    }
    next.append(sprite(state === 'attention' ? 4 : state === 'checking' ? 1 : 0));
    const pigeon = next.firstElementChild as HTMLElement;
    pigeon.dataset.state = state === 'checking' ? 'indexing' : 'idle';
    control.replaceWith(next);
    control = next;
  };

  shadow.append(style, control, live);
  render();

  const place = () => {
    // Left of PigeonBox's tracking badge when it is there, otherwise left of Send itself.
    const anchor = compose.querySelector<HTMLElement>('[data-gi-ui="track-toggle"]') ?? findSendButton(compose) ?? compose.querySelector<HTMLElement>(SELECTORS.sendButton.join(','));
    const parent = anchor?.parentElement;
    if (!anchor || !parent) {
      host.remove();
      return;
    }
    if (host.parentElement !== parent || host.nextElementSibling !== anchor) parent.insertBefore(host, anchor);
  };
  const observer = new MutationObserver(place);
  observer.observe(compose, { childList: true, subtree: true });
  place();

  return {
    host,
    state: () => state,
    set: (next, label) => {
      window.clearTimeout(clearTimer);
      if (next === 'attention' && state !== 'attention') live.textContent = label ? `Pidgy: ${label}` : 'Pidgy flagged something in this message.';
      if (next !== 'attention' && state === 'attention') live.textContent = '';
      state = next;
      render(label);
      if (next === 'clear') clearTimer = window.setTimeout(() => {
        if (state !== 'clear') return;
        state = 'idle';
        render();
      }, CLEAR_MS);
    },
    remove: () => {
      window.clearTimeout(clearTimer);
      observer.disconnect();
      host.remove();
    },
  };
}
