import { knownAppearance } from '../../ui/appearance';
import type { NoticeSource } from './brain-notice';

export type CompletionView = { text: string; sources: NoticeSource[]; kind?: 'grounded' | 'writing' };
export type CompletionHandle = { remove: () => void; isVisible: () => boolean };

/** Separate overlay: ghost text never enters Gmail's editor or saved draft. */
export function renderCompletion(body: HTMLElement, view: CompletionView, actions: {
  range: () => Range | null; accept: () => void; source: (source: NoticeSource) => void;
}): CompletionHandle {
  const host = document.createElement('div');
  host.dataset.giUi = 'brain-completion';
  host.dataset.pbTheme = knownAppearance();
  const owner = body.closest('[data-gi-compose-id]')?.getAttribute('data-gi-compose-id');
  if (owner) host.dataset.giCompose = owner;
  const shadow = host.attachShadow({ mode: 'open' });
  const style = document.createElement('style');
  style.textContent = `
    :host { all: initial; position: fixed; z-index: 2147482999; pointer-events: none; }
    :host([hidden]) { display: none; }
    .ghost { display: flex; align-items: baseline; gap: 6px; min-width: 0; pointer-events: auto; }
    button { font: inherit; letter-spacing: inherit; word-spacing: inherit; border: 0; margin: 0; padding: 0; background: transparent; cursor: pointer; }
    .suffix { color: #747474; opacity: .85; overflow: hidden; text-overflow: ellipsis; white-space: pre; text-align: left; flex: 0 1 auto; min-width: 0; }
    .key { font: 10px/1.3 system-ui; border: 0; border-radius: 3px; padding: 1px 3px; opacity: .65; color: #686868; flex-shrink: 0; }
    .source { font: 11px/1.3 system-ui; color: #747474; flex-shrink: 0; }
    :host([data-pb-theme="dark"]) .suffix, :host([data-pb-theme="dark"]) .key, :host([data-pb-theme="dark"]) .source { color: #b6b6b6; }
    @media (prefers-color-scheme: dark) { :host([data-pb-theme="system"]) button { color: #b6b6b6; } }
    button:focus-visible { outline: 2px solid #d9764f; outline-offset: 2px; }
    .sr-only { position: absolute; width: 1px; height: 1px; overflow: hidden; clip-path: inset(50%); }
  `;
  const ghost = document.createElement('div');
  ghost.className = 'ghost';
  const suffix = document.createElement('button');
  suffix.type = 'button'; suffix.className = 'suffix'; suffix.textContent = view.text;
  suffix.setAttribute('aria-label', `Insert suggestion: ${view.text.trim()}`);
  suffix.title = view.text.trim();
  const key = document.createElement('button');
  key.type = 'button'; key.className = 'key'; key.textContent = 'Tab'; key.setAttribute('aria-label', 'Accept smart autofill');
  for (const button of [suffix, key]) {
    button.addEventListener('mousedown', event => event.preventDefault());
    button.addEventListener('click', actions.accept);
  }
  ghost.append(suffix, key);
  const source = view.sources[0];
  if (source) {
    const link = document.createElement('button');
    link.type = 'button'; link.className = 'source'; link.textContent = 'Source';
    link.title = view.sources.map(item => item.title).join('\n');
    link.setAttribute('aria-label', `View autofill source: ${source.title}`);
    link.addEventListener('mousedown', event => event.preventDefault());
    link.addEventListener('click', () => actions.source(source));
    ghost.append(link);
  }
  const announce = document.createElement('span');
  announce.className = 'sr-only'; announce.setAttribute('role', 'status'); announce.setAttribute('aria-live', 'polite');
  shadow.append(style, ghost, announce);
  document.body.append(host);
  announce.textContent = `Suggestion: ${view.text.trim()}. Press Tab to accept or Escape to dismiss.`;
  let removed = false, frame = 0;
  const place = () => {
    frame = 0;
    if (removed) return;
    const range = actions.range();
    const rect = range?.getBoundingClientRect?.();
    const bounds = body.getBoundingClientRect();
    if (!rect || rect.bottom < 0 || rect.top > innerHeight || rect.left < bounds.left || rect.left > bounds.right - 60) {
      host.hidden = true;
      return;
    }
    const caretNode = range!.startContainer;
    const caretElement = caretNode.nodeType === Node.TEXT_NODE ? caretNode.parentElement : caretNode as Element;
    const computed = getComputedStyle(caretElement && body.contains(caretElement) ? caretElement : body);
    host.hidden = false;
    host.style.font = computed.font;
    host.style.lineHeight = computed.lineHeight;
    host.style.letterSpacing = computed.letterSpacing;
    host.style.wordSpacing = computed.wordSpacing;
    host.style.left = `${rect.left}px`;
    host.style.top = `${rect.top}px`;
    host.style.maxWidth = `${Math.max(0, Math.min(bounds.right, innerWidth - 8) - rect.left - 4)}px`;
    ghost.style.maxWidth = host.style.maxWidth;
    // A caret rect describes the text bounds, while the button starts a whole
    // line box (including its leading). Align the actual suffix glyph bounds,
    // preserving Gmail's font and rich-text formatting at the caret.
    const glyphs = document.createRange();
    glyphs.selectNodeContents(suffix);
    const glyphRect = glyphs.getBoundingClientRect();
    if (glyphRect.height > 0 && Number.isFinite(glyphRect.bottom)) {
      host.style.top = `${rect.top + rect.bottom - glyphRect.bottom}px`;
    }
  };
  const schedule = () => { if (!frame) frame = requestAnimationFrame(place); };
  window.addEventListener('scroll', schedule, { capture: true, passive: true });
  window.addEventListener('resize', schedule, { passive: true });
  const resize = typeof ResizeObserver === 'function' ? new ResizeObserver(schedule) : null;
  resize?.observe(body);
  place();
  return { isVisible: () => !removed && host.isConnected && !host.hidden, remove: () => {
    if (removed) return;
    removed = true;
    cancelAnimationFrame(frame);
    window.removeEventListener('scroll', schedule, true);
    window.removeEventListener('resize', schedule);
    resize?.disconnect(); host.remove();
  } };
}
