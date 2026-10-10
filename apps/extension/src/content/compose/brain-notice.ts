/**
 * The inline smart suggestion for a real-time check: the words in question get a
 * quiet peach underline, and a small issue label appears beside the clause on hover
 * or keyboard focus. A compact popover
 * explains on demand ("You have Math 52 from 2–3 PM tomorrow." / "You're free
 * at 3:30 PM.") with Fix and View source.
 *
 * Nothing is written into Gmail's editor. The underline is a CSS Custom
 * Highlight over a live Range, and the issue label and popover live in one shadow
 * root on <body> positioned from the Range's rects, so Gmail's contenteditable
 * DOM, undo history and draft saving are untouched. Where highlights are not
 * supported, or the words cannot be located exactly, there is no mark and the
 * popover anchors to the compose's corner instead.
 *
 * Keyboard: the issue label is focusable; while its popover is presented and the caret is in the message,
 * Tab applies Fix and Escape dismisses. Tab is never taken otherwise. From the
 * compose status (keyboard reachable), the popover opens with focus inside it.
 * Every string is set as text; nothing from Cloud is parsed as HTML.
 */
import { SURFACE_CSS } from '../shell/surface';
import { knownAppearance } from '../../ui/appearance';

export type NoticeSource = { kind: string; title: string; at?: string; gmailThreadId?: string; url?: string };
export type NoticeView = {
  kind?: string;
  severity: 'info' | 'warning';
  message: string;
  /** Shown only when the controller can apply it safely. */
  suggestion: string | null;
  preview?: string;
  /** The first source with somewhere to go, if any. */
  source: NoticeSource | null;
};
export type NoticeActions = { onSource: () => void; onSuggest: () => void; onDismiss: () => void };
export type NoticeHandle = {
  host: HTMLElement;
  /** Present the popover; `focus` moves keyboard focus into it from the issue marker. */
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
let closeCurrentPopover: (() => void) | null = null;

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
  style.textContent = `::highlight(${ADVISORY_HIGHLIGHT}) { text-decoration: underline dotted rgba(217, 118, 79, .9); text-decoration-thickness: 1px; text-underline-offset: 3px; }`;
  document.documentElement.append(style);
}

const ADVISORY_CSS = `
:host { all: initial; position: fixed; inset: 0 auto auto 0; width: 0; height: 0; z-index: 2147483000; }
.pb-reference {
  position: fixed; box-sizing: border-box; display: grid; place-items: center;
  width: 20px; height: 20px; margin: 0; padding: 2px;
  border: 0; border-radius: var(--pb-radius-xs); background: transparent;
  color: var(--pb-fg-muted); cursor: pointer; opacity: 0; pointer-events: none;
  transition: opacity var(--pb-motion-quick) linear;
}
.pb-reference[data-severity="warning"] { color: var(--pb-warning-color); }
.pb-reference[data-severity="info"] { color: var(--pb-tracking); }
.pb-reference[data-active], .pb-reference[data-open], .pb-reference:focus-visible { opacity: 1; pointer-events: auto; }
.pb-reference:hover { color: var(--pb-fg); background: var(--pb-surface-inset); }
.pb-reference:focus-visible { outline: 2px solid var(--pb-border-focus); outline-offset: 3px; }
.pb-reference svg { display: block; width: 14px; height: 14px; fill: none; stroke: currentColor; stroke-width: 1.35; stroke-linecap: round; stroke-linejoin: round; }
.pb-reference[hidden], .pb-pop[hidden] { display: none; }
/* Only where CSS highlights are unsupported: the same quiet underline, drawn beside the text, never in it. */
.pb-line { position: fixed; height: 0; border-bottom: 1.5px dotted rgba(217, 118, 79, .9); pointer-events: none; }
.pb-pop {
  position: fixed;
  box-sizing: border-box;
  display: grid;
  grid-template-columns: minmax(0, 1fr);
  gap: var(--pb-space-2);
  align-items: start;
  width: max-content;
  max-width: min(340px, calc(100vw - 16px));
  padding: 12px 14px;
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
.pb-pop[data-keyboard] { transition: none; }

.pb-copy { display: grid; gap: 2px; min-width: 0; }
.pb-kind { color: var(--pb-fg-muted); font: 500 var(--pb-size-meta)/1.2 var(--pb-sans); letter-spacing: var(--pb-tracking-label); }
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
@media (prefers-reduced-motion: reduce) { .pb-pop { transform: none; transition: opacity var(--pb-motion-quick) linear; }  }
`;

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

/** A plain issue label, derived from the finding rather than the system that found it. */
export function noticeCategory(kind: string | undefined): string {
  const value = (kind ?? '').toLowerCase();
  if (/(calendar|availability|schedul|date|time)/.test(value)) return 'Schedule';
  if (/(commit|promise|deadline)/.test(value)) return 'Promise';
  if (/(attachment|file)/.test(value)) return 'File';
  if (/(contact|recipient|relationship)/.test(value)) return 'Contact';
  if (/(thread|contradict|previous|history|email)/.test(value)) return 'Earlier mail';
  if (/(writing|wording|style)/.test(value)) return 'Wording';
  if (/(fact|personal|profile|memory|context|overlook|helpful)/.test(value)) return 'Context';
  return 'Context';
}

function issueIcon(kind: string | undefined): SVGSVGElement {
  const value = (kind ?? '').toLowerCase();
  const icon = /(calendar|availability|schedul|date|time)/.test(value) ? 'schedule'
    : /(commit|promise|deadline)/.test(value) ? 'promise'
    : /(attachment|file)/.test(value) ? 'file'
    : /(contact|recipient|relationship)/.test(value) ? 'contact'
    : /(thread|contradict|previous|history|email)/.test(value) ? 'mail'
    : /(writing|wording|style)/.test(value) ? 'wording' : 'context';
  const drawings: Record<string, string[]> = {
    schedule: ['M4 2.5v2', 'M12 2.5v2', 'M3 5.5h10v8H3z', 'M5 8h2v2H5z'],
    promise: ['M3 3h10v10H3z', 'M5 8l2 2 4-4'],
    file: ['M4 2.5h5l3 3v8H4z', 'M9 2.5v3h3', 'M6 8h4', 'M6 10h4'],
    contact: ['M8 8a2.25 2.25 0 1 0 0-4.5A2.25 2.25 0 0 0 8 8Z', 'M3.5 13c.4-2.3 2-3.5 4.5-3.5s4.1 1.2 4.5 3.5'],
    mail: ['M2.5 3.5h11v8h-6l-3.5 2v-2H2.5z', 'M5 6h6', 'M5 8.5h4'],
    wording: ['M3 4h9', 'M3 7h7', 'M3 10h4', 'M8.5 11.5l3-3 1.5 1.5-3 3H8.5z'],
    context: ['M3 2.5h10v11H3z', 'M5 5h6', 'M5 7.5h4', 'M5 10h3'],
  };
  const svg = document.createElementNS('http://www.w3.org/2000/svg', 'svg');
  svg.setAttribute('viewBox', '0 0 16 16');
  svg.setAttribute('aria-hidden', 'true');
  for (const pathData of drawings[icon]!) {
    const path = document.createElementNS('http://www.w3.org/2000/svg', 'path');
    path.setAttribute('d', pathData);
    svg.append(path);
  }
  return svg;
}

export type NoticeLayout = {
  fallbackAnchor?: () => HTMLElement | null;
  /** The full clause anchors the label and popover; `range` remains the precise underline. */
  anchorRange?: Range | null;
};

/**
 * Show the advisory for the words `range` covers in `body` (null: no exact
 * words, anchor to `fallbackAnchor`, else the compose's corner).
 */
export function renderNotice(
  body: HTMLElement,
  range: Range | null,
  view: NoticeView,
  actions: NoticeActions,
  layout: NoticeLayout = {},
): NoticeHandle {
  ensureHighlightStyle();
  const host = document.createElement('div');
  host.setAttribute('data-gi-ui', 'brain-notice');
  host.dataset.pbTheme = knownAppearance();
  const owner = body.closest<HTMLElement>('[data-gi-compose-id]')?.getAttribute('data-gi-compose-id');
  if (owner) host.setAttribute('data-gi-compose', owner);
  const shadow = host.attachShadow({ mode: 'open' });
  const style = document.createElement('style');
  style.textContent = `${SURFACE_CSS}\n${ADVISORY_CSS}`;
  const { title: titleText, detail: detailText } = splitMessage(view.message);
  const category = noticeCategory(view.kind);
  const popId = `pb-advisory-${Math.random().toString(36).slice(2, 9)}`;

  const reference = document.createElement('button');
  reference.type = 'button';
  reference.className = 'pb-reference';
  reference.dataset.category = category;
  reference.append(issueIcon(view.kind));
  reference.dataset.severity = view.severity;
  reference.tabIndex = 0;
  reference.setAttribute('aria-label', `${category}: ${titleText}`);
  reference.setAttribute('aria-haspopup', 'dialog');
  reference.setAttribute('aria-expanded', 'false');
  reference.title = view.message;
  reference.setAttribute('aria-controls', popId);
  reference.hidden = true;
  reference.addEventListener('focus', () => reference.setAttribute('data-active', ''));
  reference.addEventListener('blur', () => {
    if (!isOpen()) reference.removeAttribute('data-active');
  });
  reference.addEventListener('mousedown', (event) => event.preventDefault());
  reference.addEventListener('click', (event) => {
    event.preventDefault();
    event.stopPropagation();
    if (isOpen()) close();
    else open(event.detail === 0);
  });

  const pop = document.createElement('div');
  pop.className = 'pb-pop';
  pop.id = popId;
  pop.dataset.severity = view.severity;
  pop.setAttribute('role', 'dialog');
  pop.setAttribute('aria-label', 'Smart suggestion');
  pop.hidden = true;
  const copy = document.createElement('div');
  copy.className = 'pb-copy';
  const kind = document.createElement('span');
  kind.className = 'pb-kind';
  kind.textContent = category;
  const title = document.createElement('p');
  title.className = 'pb-title';
  title.id = `${popId}-title`;
  title.textContent = titleText;
  copy.append(kind, title);
  pop.setAttribute('aria-describedby', title.id);
  if (view.preview || detailText) {
    const detail = document.createElement('p');
    detail.className = 'pb-detail';
    detail.textContent = view.preview || detailText;
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
  pop.append(copy, dismiss);
  pop.addEventListener('keydown', (event) => {
    if (event.key !== 'Escape') return;
    event.preventDefault();
    event.stopPropagation();
    actions.onDismiss();
  });
  const lines = document.createElement('div');
  lines.setAttribute('aria-hidden', 'true');
  shadow.append(style, lines, reference, pop);
  document.body.append(host);

  const live = range && !range.collapsed ? range : null;
  const anchored = layout.anchorRange && !layout.anchorRange.collapsed ? layout.anchorRange : live;
  if (live) {
    marked.add(live);
    syncHighlight();
  }
  const clipper = scrollParent(body);
  let frame = 0;
  let removed = false;

  /** The marked words' line boxes, when they are inside the visible message area. */
  function visibleRangeRects(target: Range | null): DOMRect[] {
    if (!target || typeof target.getClientRects !== 'function') return [];
    const bounds = (clipper ?? body).getBoundingClientRect();
    return Array.from(target.getClientRects()).filter((rect) => (rect.width || rect.height) && rect.bottom >= bounds.top && rect.top <= bounds.bottom && rect.right >= bounds.left && rect.left <= bounds.right);
  }

  function visibleRects(): DOMRect[] { return visibleRangeRects(live); }

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
    if (anchored) return visibleRangeRects(anchored).at(-1) ?? null;
    const fallback = layout.fallbackAnchor?.() ?? null;
    return fallback?.isConnected ? fallback.getBoundingClientRect() : null;
  }

  function intersects(a: DOMRect | { left: number; top: number; right: number; bottom: number }, b: DOMRect | { left: number; top: number; right: number; bottom: number }): boolean {
    return a.left < b.right && a.right > b.left && a.top < b.bottom && a.bottom > b.top;
  }

  /** Don't let the hover label cover Gmail prose or another active issue label. */
  function textOrReferenceAt(box: { left: number; top: number; right: number; bottom: number }): boolean {
    const walker = document.createTreeWalker(body, NodeFilter.SHOW_TEXT, {
      acceptNode(node) {
        return node.parentElement?.closest('.gmail_quote, .gmail_quote_container, blockquote, .gmail_signature, [data-smartmail="gmail_signature"], [data-gi-ui]')
          ? NodeFilter.FILTER_REJECT : NodeFilter.FILTER_ACCEPT;
      },
    });
    for (let node = walker.nextNode(); node; node = walker.nextNode()) {
      const text = document.createRange();
      text.selectNodeContents(node);
      if (Array.from(text.getClientRects()).some((rect) => intersects(box, rect))) return true;
    }
    if (owner) {
      for (const item of document.querySelectorAll<HTMLElement>('[data-gi-ui="brain-notice"]')) {
        if (item === host || item.getAttribute('data-gi-compose') !== owner) continue;
        const other = item.shadowRoot?.querySelector<HTMLElement>('.pb-reference');
        if (!other || other.hidden || (!other.hasAttribute('data-active') && !other.hasAttribute('data-open'))) continue;
        if (intersects(box, other.getBoundingClientRect())) return true;
      }
    }
    return false;
  }

  function placeReference(rect: DOMRect, bounds: DOMRect): void {
    reference.hidden = false;
    const width = reference.offsetWidth;
    const height = reference.offsetHeight;
    const top = Math.round(rect.top + (rect.height - height) / 2);
    const candidates = [
      { left: rect.right + 5, top },
      { left: rect.left - width - 5, top },
      // At the bottom edge of a scroller, the centered position may be clipped
      // by a couple of pixels. Align to the text baseline while staying beside it.
      { left: rect.right + 5, top: rect.bottom - height },
      { left: rect.left - width - 5, top: rect.bottom - height },
      // A long clause can fill Gmail's line to its inset. In that case, keep
      // the marker attached to the same line, just below its final words.
      { left: Math.min(rect.right - width, bounds.right - width - 4), top: rect.bottom + 2 },
      { left: bounds.right - width - 4, top },
      { left: rect.right + 5, top: rect.bottom + 2 },
    ];
    const at = candidates.find((point) => {
      const box = { left: point.left, top: point.top, right: point.left + width, bottom: point.top + height };
      return point.left >= Math.max(4, bounds.left) && box.right <= Math.min(innerWidth - 4, bounds.right) &&
        point.top >= Math.max(4, bounds.top) && box.bottom <= Math.min(innerHeight - 4, bounds.bottom) && !textOrReferenceAt(box);
    });
    if (!at) {
      reference.hidden = true;
      return;
    }
    reference.hidden = false;
    reference.style.left = `${Math.round(at.left)}px`;
    reference.style.top = `${Math.round(at.top)}px`;
  }

  function place() {
    frame = 0;
    if (removed) return;
    drawUnderline();
    let rect = anchorRect();
    const fallback = layout.fallbackAnchor?.() ?? null;
    // With no exact text range, keep one small issue label in the compose's lower corner.
    const corner = !anchored && !fallback?.isConnected ? (clipper ?? body).getBoundingClientRect() : null;
    if (corner) rect = corner;
    reference.hidden = !rect || (!rect.width && !rect.height);
    if (anchored && rect) {
      placeReference(rect, (clipper ?? body).getBoundingClientRect());
    } else if (corner) {
      reference.hidden = false;
      reference.setAttribute('data-active', '');
      reference.style.left = `${Math.round(corner.right - reference.offsetWidth - 8)}px`;
      reference.style.top = `${Math.round(corner.bottom - 24)}px`;
    } else if (rect) {
      reference.hidden = false;
      reference.setAttribute('data-active', '');
      reference.style.left = `${Math.round(rect.right - reference.offsetWidth - 8)}px`;
      reference.style.top = `${Math.round(rect.bottom - 24)}px`;
    }
    if (pop.hidden) return;
    if (!rect) return close();
    const width = pop.offsetWidth;
    const height = pop.offsetHeight;
    const compose = body.closest<HTMLElement>('[data-gi-compose-id]');
    const left = Math.min(Math.max(8, anchored ? rect.left : rect.right - width), window.innerWidth - width - 8);
    const controls = Array.from(compose?.querySelectorAll<HTMLElement>('button, [role="button"], input, textarea, [data-gi-ui="track-toggle"]') ?? [])
      .filter(element => !body.contains(element)).map(element => element.getBoundingClientRect()).filter(box => box.width && box.height);
    const placements = [
      { left, top: anchored ? rect.bottom + 6 : rect.top - height - 6 },
      { left, top: rect.top - height - 6 },
      { left: rect.right + 8, top: rect.top },
      { left: rect.left - width - 8, top: rect.top },
      { left, top: (compose?.getBoundingClientRect().bottom ?? rect.bottom) + 8 },
    ];
    // A short editor may have no space below the words. Use the side or the
    // area below the compose rather than covering Send, tracking or formatting.
    const at = placements.find(point => point.left >= 8 && point.top >= 8 && point.left + width <= innerWidth - 8 && point.top + height <= innerHeight - 8 &&
      controls.every(box => point.left + width <= box.left || point.left >= box.right || point.top + height <= box.top || point.top >= box.bottom));
    if (!at) return close();
    pop.style.left = `${Math.round(at.left)}px`;
    pop.style.top = `${Math.round(at.top)}px`;
  }
  const schedule = () => {
    if (!frame && !removed) frame = (window.requestAnimationFrame ?? ((run: FrameRequestCallback) => window.setTimeout(run, 0)))(place);
  };
  clipper?.addEventListener('scroll', schedule, { passive: true });

  function isOpen() {
    return !pop.hidden;
  }
  function open(focus = false) {
    if (removed) return;
    if (closeCurrentPopover && closeCurrentPopover !== close) closeCurrentPopover();
    closeCurrentPopover = close;
    pop.hidden = false;
    pop.toggleAttribute('data-keyboard', focus);
    reference.setAttribute('aria-expanded', 'true');
    reference.setAttribute('data-open', '');
    reference.setAttribute('data-active', '');
    place();
    if (pop.hidden) return;
    (window.requestAnimationFrame ?? ((run: () => void) => window.setTimeout(run, 0)))(() => pop.setAttribute('data-shown', ''));
    if (focus) (pop.querySelector<HTMLButtonElement>('.pb-actions button') ?? dismiss).focus({ preventScroll: true });
  }
  function close() {
    if (closeCurrentPopover === close) closeCurrentPopover = null;
    reference.setAttribute('aria-expanded', 'false');
    reference.removeAttribute('data-open');
    if (pop.hidden) return;
    const hadFocus = shadow.activeElement !== null;
    pop.hidden = true;
    pop.removeAttribute('data-shown');
    if (shadow.activeElement === reference) reference.removeAttribute('data-active');
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
    reference.removeAttribute('data-active');
    schedule();
  };
  const onPointerMove = (event: PointerEvent) => {
    const overHost = event.composedPath().includes(host);
    const overText = visibleRects().some((rect) => event.clientX >= rect.left && event.clientX <= rect.right && event.clientY >= rect.top && event.clientY <= rect.bottom);
    if (overHost || overText || isOpen()) reference.setAttribute('data-active', '');
    else reference.removeAttribute('data-active');
  };
  const onSelection = () => {
    const selection = document.getSelection();
    const focusNode = selection?.focusNode;
    const inMark = Boolean(live && selection?.isCollapsed && focusNode && live.isPointInRange(focusNode, selection!.focusOffset));
    if (inMark || isOpen() || shadow.activeElement === reference || !live) reference.setAttribute('data-active', '');
    else reference.removeAttribute('data-active');
  };
  // Clicking into the marked words presents the advice; clicking elsewhere puts it away.
  const onClick = (event: MouseEvent) => {
    const selection = document.getSelection();
    const node = selection?.focusNode;
    const offset = selection?.focusOffset ?? 0;
    const atEdge = live && node && ((node === live.startContainer && offset === live.startOffset) || (node === live.endContainer && offset === live.endOffset));
    const pointerInMark = selection?.isCollapsed !== false && visibleRects().some((rect) => event.clientX >= rect.left && event.clientX <= rect.right && event.clientY >= rect.top && event.clientY <= rect.bottom);
    if (live && (pointerInMark || (node && selection?.isCollapsed && !atEdge && live.isPointInRange(node, offset)))) open(false);
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
  document.addEventListener('pointermove', onPointerMove, { passive: true });
  document.addEventListener('selectionchange', onSelection);
  window.addEventListener('scroll', schedule, { capture: true, passive: true });
  window.addEventListener('resize', schedule, { passive: true });
  const resize = typeof ResizeObserver === 'function' ? new ResizeObserver(schedule) : null;
  resize?.observe(body);
  const compose = body.closest<HTMLElement>('[data-gi-compose-id]');
  if (compose && compose !== body) resize?.observe(compose);
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
      document.removeEventListener('pointermove', onPointerMove);
      document.removeEventListener('selectionchange', onSelection);
      clipper?.removeEventListener('scroll', schedule);
      window.removeEventListener('scroll', schedule, true);
      window.removeEventListener('resize', schedule);
      resize?.disconnect();
      const hadFocus = shadow.activeElement !== null;
      if (closeCurrentPopover === close) close();
      if (live) {
        marked.delete(live);
        syncHighlight();
      }
      if (!animate || pop.hidden || !host.isConnected) host.remove();
      else {
        pop.removeAttribute('data-shown');
        window.setTimeout(() => host.remove(), 120);
      }
      if (hadFocus && body.isConnected) body.focus({ preventScroll: true });
    },
  };
}
