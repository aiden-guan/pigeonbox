/**
 * The one compact Pidgy advisory a compose window can show for a real-time
 * check. Rendered in a shadow root right under the message body, in flow, so
 * it never covers Send, formatting, the tracking badge or the document action.
 * Every string is set as text; nothing from Cloud is parsed as HTML.
 */
import { SURFACE_CSS } from '../shell/surface';

export type NoticeSource = { kind: string; title: string; at?: string; gmailThreadId?: string; url?: string };
export type NoticeView = {
  severity: 'info' | 'warning';
  message: string;
  /** Shown only when the controller can apply it safely. */
  suggestion: string | null;
  /** The first source with somewhere to go, if any. */
  source: NoticeSource | null;
};
export type NoticeActions = { onSource: () => void; onSuggest: () => void; onDismiss: () => void };
export type NoticeHandle = { host: HTMLElement; remove: (animate?: boolean) => void };

const NOTICE_CSS = `
:host { all: initial; display: block; width: auto; max-width: 100%; position: sticky; bottom: 4px; z-index: 2; margin: 8px 0 4px; }
.pb-brain {
  box-sizing: border-box;
  display: grid;
  grid-template-columns: auto minmax(0, 1fr);
  gap: var(--pb-space-3);
  align-items: start;
  max-width: 520px;
  padding: var(--pb-space-2) var(--pb-space-3);
  border: 1px solid var(--pb-border);
  border-left: 2px solid var(--pb-warning-color);
  border-radius: var(--pb-radius);
  background: var(--pb-surface-raised);
  color: var(--pb-fg);
  box-shadow: var(--pb-shadow-low);
  font: var(--pb-size-secondary)/var(--pb-leading-ui) var(--pb-sans);
  letter-spacing: var(--pb-tracking-body);
  opacity: 0;
  transform: translateY(4px);
  transition: opacity var(--pb-motion-standard) var(--pb-ease), transform var(--pb-motion-standard) var(--pb-ease);
}
.pb-brain[data-severity="info"] { border-left-color: var(--pb-tracking); }
.pb-brain[data-shown] { opacity: 1; transform: none; }
.pb-brain[data-leaving] { opacity: 0; transform: translateY(2px); transition-duration: var(--pb-motion-quick); }
.pb-brain .gi-pigeon { font-size: 26px; margin-top: 1px; }
.pb-brain-copy { display: grid; gap: 2px; min-width: 0; }
.pb-brain-title { margin: 0; color: var(--pb-fg-muted); font: var(--pb-weight-strong) var(--pb-size-meta)/1.3 var(--pb-sans); letter-spacing: var(--pb-tracking-label); }
.pb-brain-message { margin: 0; color: var(--pb-fg); overflow-wrap: anywhere; }
.pb-brain-suggestion { margin: 0; color: var(--pb-fg-secondary); font-size: var(--pb-size-label); white-space: nowrap; overflow: hidden; text-overflow: ellipsis; }
.pb-brain-actions { display: flex; flex-wrap: wrap; gap: var(--pb-space-1) var(--pb-space-3); margin-top: var(--pb-space-1); }
.pb-brain-actions button {
  appearance: none;
  border: 0;
  padding: 2px 0;
  background: transparent;
  color: var(--pb-fg-secondary);
  font: var(--pb-weight-strong) var(--pb-size-label)/1.3 var(--pb-sans);
  cursor: pointer;
  border-radius: var(--pb-radius-xs);
}
.pb-brain-actions button[data-action="suggest"] { color: var(--pb-accent); }
.pb-brain-actions button:hover { color: var(--pb-fg); text-decoration: underline; text-underline-offset: 2px; }
.pb-brain-actions button:focus-visible { outline: 2px solid var(--pb-border-focus); outline-offset: 2px; }
@media (prefers-reduced-motion: reduce) { .pb-brain, .pb-brain[data-leaving] { transform: none; transition: opacity var(--pb-motion-quick) linear; } }
`;

function pidgy(state: 'warning' | 'active'): HTMLSpanElement {
  const span = document.createElement('span');
  span.className = 'gi-pigeon';
  span.dataset.state = state;
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
  // Rows of the sprite grid: idle, indexing, drafting, opened, error (the warning pose).
  frame.style.backgroundPosition = `0 ${-(state === 'warning' ? 4 : 3) * 0.8}em`;
  span.append(frame);
  return span;
}

function action(label: string, name: string, run: () => void, title?: string): HTMLButtonElement {
  const button = document.createElement('button');
  button.type = 'button';
  button.textContent = label;
  button.dataset.action = name;
  if (title) button.title = title;
  // Mouse clicks keep the caret in the message; keyboard users still tab here.
  button.addEventListener('mousedown', (event) => event.preventDefault());
  button.addEventListener('click', (event) => {
    event.preventDefault();
    event.stopPropagation();
    run();
  });
  return button;
}

/** Show the advisory right after `anchor` (the message body). */
export function renderNotice(anchor: HTMLElement, view: NoticeView, actions: NoticeActions): NoticeHandle {
  const host = document.createElement('div');
  host.setAttribute('data-gi-ui', 'brain-notice');
  const shadow = host.attachShadow({ mode: 'open' });
  const style = document.createElement('style');
  style.textContent = `${SURFACE_CSS}\n${NOTICE_CSS}`;
  const card = document.createElement('div');
  card.className = 'pb-brain';
  card.dataset.severity = view.severity;
  card.setAttribute('role', 'status');
  card.setAttribute('aria-live', 'polite');
  const copy = document.createElement('div');
  copy.className = 'pb-brain-copy';
  const title = document.createElement('p');
  title.className = 'pb-brain-title';
  title.textContent = 'Pidgy noticed something';
  const message = document.createElement('p');
  message.className = 'pb-brain-message';
  message.textContent = view.message;
  copy.append(title, message);
  if (view.suggestion) {
    const suggestion = document.createElement('p');
    suggestion.className = 'pb-brain-suggestion';
    suggestion.textContent = `Suggestion: “${view.suggestion}”`;
    copy.append(suggestion);
  }
  const buttons = document.createElement('div');
  buttons.className = 'pb-brain-actions';
  if (view.source) buttons.append(action('View source', 'source', actions.onSource, view.source.title));
  if (view.suggestion) buttons.append(action('Use suggestion', 'suggest', actions.onSuggest, view.suggestion));
  buttons.append(action('Dismiss', 'dismiss', actions.onDismiss));
  copy.append(buttons);
  card.append(pidgy(view.severity === 'warning' ? 'warning' : 'active'), copy);
  card.addEventListener('keydown', (event) => {
    if (event.key !== 'Escape') return;
    event.stopPropagation();
    actions.onDismiss();
  });
  shadow.append(style, card);
  anchor.insertAdjacentElement('afterend', host);
  (window.requestAnimationFrame ?? ((run: () => void) => window.setTimeout(run, 0)))(() => card.setAttribute('data-shown', ''));
  let removed = false;
  return {
    host,
    remove: (animate = true) => {
      if (removed) return;
      removed = true;
      if (!animate || !host.isConnected) {
        host.remove();
        return;
      }
      card.setAttribute('data-leaving', '');
      window.setTimeout(() => host.remove(), 140);
    },
  };
}
