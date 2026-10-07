/**
 * The inline Pidgy advisory for a real-time check: the words in question get a
 * quiet peach underline, a small dot sits at their end, and a compact popover
 * explains on demand ("You have Math 52 from 2–3 PM tomorrow." / "You're free
 * at 3:30 PM.") with Fix and View source.
 *
 * Nothing is written into Gmail's editor. The underline is a CSS Custom
 * Highlight over a live Range, and the dot and popover live in one shadow
 * root on <body> positioned from the Range's rects, so Gmail's contenteditable
 * DOM, undo history and draft saving are untouched. Where highlights are not
 * supported, or the words cannot be located exactly, there is no mark and the
 * popover anchors to the compose's corner instead.
 *
 * Keyboard: while the popover is presented and the caret is in the message,
 * Tab applies Fix and Escape dismisses. Tab is never taken otherwise. From the
 * compose status (keyboard reachable), the popover opens with focus inside it.
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
export type NoticeHandle = {
  host: HTMLElement;
  /** Present the popover; `focus` moves keyboard focus into it (from the compose status). */
  open: (focus?: boolean) => void;
  close: () => void;
  isOpen: () => boolean;
  /** The words changed underneath: keep the advice, drop the one-click fix. */
  dropFix: () => void;
  remove: (animate?: boolean) => void;
};

/** Name of the shared highlight; one registry entry holds every compose's marked words. */
export const ADVISORY_HIGHLIGHT = 'pigeonbox-advisory';
const marked = new Set<Range>();

type HighlightCtor = new (...ranges: Range[]) => unknown;
function highlights(): { set: (name: string, value: unknown) => void; delete: (name: string) => void } | null {
  const css = (globalThis as { CSS?: { highlights?: { set: (name: string, value: unknown) => void; delete: (name: string) => void } } }).CSS;
  return typeof (globalThis as { Highlight?: HighlightCtor }).Highlight === 'function' && css?.highlights ? css.highlights : null;
}

function syncHighlight(): void {
  const registry = highlights();
  if (!registry) return;
  if (!marked.size) return registry.delete(ADVISORY_HIGHLIGHT);
  const Highlight = (globalThis as unknown as { Highlight: HighlightCtor }).Highlight;
  registry.set(ADVISORY_HIGHLIGHT, new Highlight(...marked));
}

/** The underline style lives in the page once; it only ever matches PigeonBox's named highlight. */
function ensureHighlightStyle(): void {
  if (document.getElementById('gi-advisory-style')) return;
  const style = document.createElement('style');
  style.id = 'gi-advisory-style';
  style.textContent = `::highlight(${ADVISORY_HIGHLIGHT}) { background-color: rgba(217, 118, 79, .13); text-decoration: underline wavy rgba(217, 118, 79, .9); text-decoration-thickness: 1px; text-underline-offset: 3px; }`;
  document.documentElement.append(style);
}

const ADVISORY_CSS = `
:host { all: initial; position: fixed; inset: 0 auto auto 0; width: 0; height: 0; z-index: 2147483000; }
.pb-dot {
  position: fixed;
  box-sizing: border-box;
  display: grid;
  place-items: center;
  width: 18px;
  height: 18px;
  margin: 0;
  padding: 0;
  border: 0;
  border-radius: var(--pb-radius-pill);
  background: transparent;
  cursor: pointer;
}
.pb-dot::before { content: ''; width: 7px; height: 7px; border-radius: 50%; background: var(--pb-accent); box-shadow: 0 0 0 2px var(--pb-surface-raised); transition: transform var(--pb-motion-quick) var(--pb-ease); }
.pb-dot[data-severity="info"]::before { background: var(--pb-tracking); }
.pb-dot:hover::before, .pb-dot[aria-expanded="true"]::before { transform: scale(1.25); }
.pb-dot:focus-visible { outline: 2px solid var(--pb-border-focus); outline-offset: 0; }
.pb-dot[hidden], .pb-pop[hidden] { display: none; }
/* Only where CSS highlights are unsupported: the same quiet underline, drawn beside the text, never in it. */
.pb-line { position: fixed; height: 0; border-bottom: 1.5px dotted rgba(217, 118, 79, .9); pointer-events: none; }
.pb-pop {
  position: fixed;
  box-sizing: border-box;
  display: grid;
  grid-template-columns: auto minmax(0, 1fr);
  gap: var(--pb-space-2);
  align-items: start;
  width: max-content;
  max-width: min(340px, calc(100vw - 16px));
  padding: var(--pb-space-2) var(--pb-space-3) var(--pb-space-2) var(--pb-space-2);
  border: 1px solid var(--pb-border);
  border-radius: var(--pb-radius);
  background: var(--pb-surface-raised);
  color: var(--pb-fg);
  box-shadow: var(--pb-shadow-menu);
  font: var(--pb-size-secondary)/var(--pb-leading-ui) var(--pb-sans);
  letter-spacing: var(--pb-tracking-body);
  opacity: 0;
  transform: translateY(2px);
  transition: opacity var(--pb-motion-quick) var(--pb-ease), transform var(--pb-motion-quick) var(--pb-ease);
}
.pb-pop[data-shown] { opacity: 1; transform: none; }
.pb-pop .gi-pigeon { font-size: 20px; margin-top: 1px; }
.pb-copy { display: grid; gap: 2px; min-width: 0; }
.pb-title { margin: 0; color: var(--pb-fg); font-weight: var(--pb-weight-strong); overflow-wrap: anywhere; }
.pb-detail { margin: 0; color: var(--pb-fg-secondary); overflow-wrap: anywhere; }
.pb-actions { display: flex; flex-wrap: wrap; align-items: center; gap: var(--pb-space-1) var(--pb-space-3); margin-top: var(--pb-space-1); }
.pb-actions button {
  appearance: none;
  display: inline-flex;
  align-items: center;
  gap: 6px;
  border: 0;
  padding: 2px 0;
  background: transparent;
  color: var(--pb-fg-secondary);
  font: var(--pb-weight-strong) var(--pb-size-label)/1.3 var(--pb-sans);
  cursor: pointer;
  border-radius: var(--pb-radius-xs);
}
.pb-actions button[data-action="suggest"] { color: var(--pb-accent); }
.pb-actions button:hover { color: var(--pb-fg); }
.pb-actions button[data-action="suggest"]:hover { color: var(--pb-accent); text-decoration: underline; text-underline-offset: 2px; }
.pb-actions button:focus-visible, .pb-close:focus-visible { outline: 2px solid var(--pb-border-focus); outline-offset: 2px; }
.pb-actions kbd { padding: 0 4px; border: 1px solid var(--pb-border); border-radius: var(--pb-radius-xs); color: var(--pb-fg-muted); font: var(--pb-size-meta)/1.4 var(--pb-sans); }
.pb-close {
  position: absolute;
  top: 4px;
  right: 4px;
  width: 20px;
  height: 20px;
  padding: 0;
  border: 0;
  border-radius: var(--pb-radius-xs);
  background: transparent;
  color: var(--pb-fg-muted);
  font: 14px/1 var(--pb-sans);
  cursor: pointer;
}
.pb-close:hover { color: var(--pb-fg); background: var(--pb-surface-inset); }
.pb-pop:has(.pb-close) .pb-copy { padding-right: 18px; }
@media (prefers-reduced-motion: reduce) { .pb-pop { transform: none; transition: opacity var(--pb-motion-quick) linear; } .pb-dot::before { transition: none; } }
`;

function pidgy(): HTMLSpanElement {
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
  // Rows of the sprite grid: idle, indexing, drafting, opened, error (the warning pose).
  frame.style.backgroundPosition = `0 ${-4 * 0.8}em`;
  span.append(frame);
  return span;
}

function action(label: string, name: string, run: () => void, title?: string): HTMLButtonElement {
  const button = document.createElement('button');
  button.type = 'button';
  button.textContent = label;
  button.dataset.action = name;
  if (title) button.title = title;
  // Mouse clicks keep the caret in the message; keyboard users still reach these.
  button.addEventListener('mousedown', (event) => event.preventDefault());
  button.addEventListener('click', (event) => {
    event.preventDefault();
    event.stopPropagation();
    run();
  });
  return button;
}

/** "You have Math 52 from 2–3 PM tomorrow. You're free at 3:30 PM." → headline and detail. */
export function splitMessage(message: string): { title: string; detail: string } {
  const text = message.replace(/\s+/g, ' ').trim();
  const match = text.match(/^(.+?[.!?])\s+(\S.*)$/);
  // "p.m." and similar never end the headline.
  if (!match || /\b(?:a|p)\.m\.$|\b(?:e\.g|i\.e|vs|dr|mr|mrs|ms)\.$/i.test(match[1]!)) return { title: text, detail: '' };
  return { title: match[1]!, detail: match[2]! };
}

function scrollParent(element: HTMLElement): HTMLElement | null {
  for (let node = element.parentElement; node && node !== document.body; node = node.parentElement) {
    const { overflowY } = getComputedStyle(node);
    if (/(auto|scroll|hidden)/.test(overflowY)) return node;
  }
  return null;
}

/**
 * Show the advisory for the words `range` covers in `body` (null: no exact
 * words, anchor to `fallbackAnchor`, else the compose's corner).
 */
export function renderNotice(
  body: HTMLElement,
  range: Range | null,
  view: NoticeView,
  actions: NoticeActions,
  fallbackAnchor: () => HTMLElement | null = () => null,
): NoticeHandle {
  ensureHighlightStyle();
  const host = document.createElement('div');
  host.setAttribute('data-gi-ui', 'brain-notice');
  const owner = body.closest<HTMLElement>('[data-gi-compose-id]')?.getAttribute('data-gi-compose-id');
  if (owner) host.setAttribute('data-gi-compose', owner);
  const shadow = host.attachShadow({ mode: 'open' });
  const style = document.createElement('style');
  style.textContent = `${SURFACE_CSS}\n${ADVISORY_CSS}`;
  const { title: titleText, detail: detailText } = splitMessage(view.message);
  const popId = `pb-advisory-${Math.random().toString(36).slice(2, 9)}`;

  const dot = document.createElement('button');
  dot.type = 'button';
  dot.className = 'pb-dot';
  dot.dataset.severity = view.severity;
  dot.tabIndex = -1;
  dot.setAttribute('aria-label', `Pidgy: ${titleText}`);
  dot.setAttribute('aria-haspopup', 'dialog');
  dot.setAttribute('aria-expanded', 'false');
  dot.setAttribute('aria-controls', popId);
  dot.hidden = true;
  dot.addEventListener('mousedown', (event) => event.preventDefault());
  dot.addEventListener('click', (event) => {
    event.preventDefault();
    event.stopPropagation();
    if (isOpen()) close();
    else open(false);
  });

  const pop = document.createElement('div');
  pop.className = 'pb-pop';
  pop.id = popId;
  pop.dataset.severity = view.severity;
  pop.setAttribute('role', 'dialog');
  pop.setAttribute('aria-label', 'Pidgy');
  pop.hidden = true;
  const copy = document.createElement('div');
  copy.className = 'pb-copy';
  const title = document.createElement('p');
  title.className = 'pb-title';
  title.id = `${popId}-title`;
  title.textContent = titleText;
  copy.append(title);
  pop.setAttribute('aria-describedby', title.id);
  if (detailText) {
    const detail = document.createElement('p');
    detail.className = 'pb-detail';
    detail.textContent = detailText;
    copy.append(detail);
  }
  const buttons = document.createElement('div');
  buttons.className = 'pb-actions';
  let fix: HTMLButtonElement | null = null;
  if (view.suggestion) {
    fix = action('Fix', 'suggest', actions.onSuggest, `Change it to “${view.suggestion}”`);
    fix.setAttribute('aria-keyshortcuts', 'Tab');
    const kbd = document.createElement('kbd');
    kbd.textContent = 'Tab';
    kbd.setAttribute('aria-hidden', 'true');
    fix.append(kbd);
    buttons.append(fix);
  }
  if (view.source) buttons.append(action('View source', 'source', actions.onSource, view.source.title));
  if (buttons.childElementCount) copy.append(buttons);
  const dismiss = action('×', 'dismiss', actions.onDismiss);
  dismiss.className = 'pb-close';
  dismiss.setAttribute('aria-label', 'Dismiss');
  dismiss.setAttribute('aria-keyshortcuts', 'Escape');
  pop.append(pidgy(), copy, dismiss);
  pop.addEventListener('keydown', (event) => {
    if (event.key !== 'Escape') return;
    event.preventDefault();
    event.stopPropagation();
    actions.onDismiss();
  });
  const lines = document.createElement('div');
  lines.setAttribute('aria-hidden', 'true');
  shadow.append(style, lines, dot, pop);
  document.body.append(host);

  const live = range && !range.collapsed ? range : null;
  if (live) {
    marked.add(live);
    syncHighlight();
  }
  const clipper = scrollParent(body);
  let frame = 0;
  let removed = false;

  /** The marked words' line boxes, when they are inside the visible message area. */
  function visibleRects(): DOMRect[] {
    if (!live || typeof live.getClientRects !== 'function') return [];
    const bounds = (clipper ?? body).getBoundingClientRect();
    return Array.from(live.getClientRects()).filter((rect) => (rect.width || rect.height) && rect.bottom >= bounds.top && rect.top <= bounds.bottom && rect.right >= bounds.left && rect.left <= bounds.right);
  }

  function drawUnderline() {
    if (!live || highlights()) return;
    const rects = visibleRects();
    while (lines.childElementCount > rects.length) lines.lastElementChild!.remove();
    rects.forEach((rect, index) => {
      const line = (lines.children[index] as HTMLElement | undefined) ?? lines.appendChild(Object.assign(document.createElement('div'), { className: 'pb-line' }));
      line.style.left = `${Math.round(rect.left)}px`;
      line.style.top = `${Math.round(rect.bottom)}px`;
      line.style.width = `${Math.round(rect.width)}px`;
    });
  }

  function anchorRect(): DOMRect | null {
    if (live) {
      if (typeof live.getClientRects !== 'function') return null;
      const rects = Array.from(live.getClientRects()).filter((rect) => rect.width || rect.height);
      const last = rects.at(-1);
      if (!last) return null;
      // Hidden when the words are scrolled out of the message area.
      const bounds = (clipper ?? body).getBoundingClientRect();
      if (last.bottom < bounds.top || last.top > bounds.bottom || last.right < bounds.left || last.left > bounds.right) return null;
      return last;
    }
    const fallback = fallbackAnchor();
    return fallback?.isConnected ? fallback.getBoundingClientRect() : null;
  }

  function place() {
    frame = 0;
    if (removed) return;
    drawUnderline();
    let rect = anchorRect();
    // No exact words and no compose status to point from: the dot sits in the message's corner instead.
    const corner = !live && !fallbackAnchor()?.isConnected ? (clipper ?? body).getBoundingClientRect() : null;
    const dotAt = live ? rect : corner;
    dot.hidden = !dotAt || (!dotAt.width && !dotAt.height);
    if (live && rect) {
      dot.style.left = `${Math.round(rect.right - 2)}px`;
      dot.style.top = `${Math.round(rect.top - 11)}px`;
    } else if (corner) {
      dot.style.left = `${Math.round(corner.right - 24)}px`;
      dot.style.top = `${Math.round(corner.bottom - 24)}px`;
      rect = dot.getBoundingClientRect();
    }
    if (pop.hidden) return;
    if (!rect) return close();
    const width = pop.offsetWidth;
    const height = pop.offsetHeight;
    const bounds = (clipper ?? body).getBoundingClientRect();
    const left = Math.min(Math.max(8, live ? rect.left : rect.right - width), window.innerWidth - width - 8);
    // Below the words while that stays inside the message area; otherwise above them.
    let top = rect.bottom + 6;
    if (!live || top + height > Math.min(window.innerHeight - 8, bounds.bottom + height / 2)) top = rect.top - height - 6;
    if (top < 8) top = rect.bottom + 6;
    pop.style.left = `${Math.round(left)}px`;
    pop.style.top = `${Math.round(top)}px`;
  }
  const schedule = () => {
    if (!frame && !removed) frame = (window.requestAnimationFrame ?? ((run: FrameRequestCallback) => window.setTimeout(run, 0)))(place);
  };

  function isOpen() {
    return !pop.hidden;
  }
  function open(focus = false) {
    if (removed) return;
    pop.hidden = false;
    dot.setAttribute('aria-expanded', 'true');
    place();
    (window.requestAnimationFrame ?? ((run: () => void) => window.setTimeout(run, 0)))(() => pop.setAttribute('data-shown', ''));
    if (focus) (pop.querySelector<HTMLButtonElement>('.pb-actions button') ?? dismiss).focus({ preventScroll: true });
  }
  function close() {
    if (pop.hidden) return;
    const hadFocus = shadow.activeElement !== null;
    pop.hidden = true;
    pop.removeAttribute('data-shown');
    dot.setAttribute('aria-expanded', 'false');
    if (hadFocus) body.focus({ preventScroll: true });
  }

  // While presented, and only then: Tab applies Fix, Escape dismisses. Typing simply hides the popover.
  const onKey = (event: KeyboardEvent) => {
    if (!isOpen() || event.isComposing) return;
    if (event.key === 'Escape') {
      event.preventDefault();
      event.stopPropagation();
      actions.onDismiss();
    } else if (event.key === 'Tab' && !event.shiftKey && !event.altKey && !event.ctrlKey && !event.metaKey && fix?.isConnected) {
      event.preventDefault();
      event.stopPropagation();
      actions.onSuggest();
    }
  };
  const onInput = () => {
    close();
    schedule();
  };
  // Clicking into the marked words presents the advice; clicking elsewhere puts it away.
  const onClick = () => {
    const selection = document.getSelection();
    const node = selection?.focusNode;
    const offset = selection?.focusOffset ?? 0;
    const atEdge = live && node && ((node === live.startContainer && offset === live.startOffset) || (node === live.endContainer && offset === live.endOffset));
    if (live && node && selection.isCollapsed && !atEdge && live.isPointInRange(node, offset)) open(false);
    else close();
  };
  const onOutside = (event: PointerEvent) => {
    if (!isOpen()) return;
    const path = event.composedPath();
    if (!path.includes(host) && !path.includes(body)) close();
  };
  body.addEventListener('keydown', onKey, true);
  body.addEventListener('input', onInput, { passive: true });
  body.addEventListener('click', onClick);
  document.addEventListener('pointerdown', onOutside, true);
  window.addEventListener('scroll', schedule, { capture: true, passive: true });
  window.addEventListener('resize', schedule, { passive: true });
  const resize = typeof ResizeObserver === 'function' ? new ResizeObserver(schedule) : null;
  resize?.observe(body);
  place();

  return {
    host,
    open,
    close,
    isOpen,
    dropFix: () => {
      fix?.remove();
      fix = null;
      if (!buttons.childElementCount) buttons.remove();
    },
    remove: (animate = true) => {
      if (removed) return;
      removed = true;
      if (frame) (window.cancelAnimationFrame ?? window.clearTimeout)(frame);
      body.removeEventListener('keydown', onKey, true);
      body.removeEventListener('input', onInput);
      body.removeEventListener('click', onClick);
      document.removeEventListener('pointerdown', onOutside, true);
      window.removeEventListener('scroll', schedule, true);
      window.removeEventListener('resize', schedule);
      resize?.disconnect();
      if (live) {
        marked.delete(live);
        syncHighlight();
      }
      const hadFocus = shadow.activeElement !== null;
      if (!animate || pop.hidden || !host.isConnected) host.remove();
      else {
        pop.removeAttribute('data-shown');
        window.setTimeout(() => host.remove(), 120);
      }
      if (hadFocus && body.isConnected) body.focus({ preventScroll: true });
    },
  };
}
