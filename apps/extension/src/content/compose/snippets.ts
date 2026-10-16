/**
 * Snippets: saved text the person inserts while writing, with variables filled
 * from the compose. Two ways in:
 * - type `;name` and press Tab, or
 * - ⌘/Ctrl ; opens a picker at the caret.
 * Text goes in with insertText, so Gmail's own undo removes it.
 */
import { knownAppearance } from '../../ui/appearance';
import { ensureSurface, SURFACE_CSS } from '../shell/surface';

export type Snippet = { id: string; name: string; body: string };

export type SnippetVariables = {
  firstName: string;
  lastName: string;
  name: string;
  email: string;
  myName: string;
};

/** Snippet names: what follows the `;`. */
export const SNIPPET_NAME = /^[a-z0-9][a-z0-9_-]{0,31}$/;

export const SNIPPET_VARIABLES = ['{first_name}', '{last_name}', '{name}', '{email}', '{my_name}', '{date}'] as const;

/** Variables for the first To recipient. A missing name falls back to the address's local part. */
export function variablesFor(recipient: { name?: string | null; emailAddress?: string | null } | null, myName: string): SnippetVariables {
  const email = recipient?.emailAddress?.trim() ?? '';
  const display = recipient?.name?.trim() || '';
  const fallback = email.split('@')[0]?.split(/[._-]/)[0] ?? '';
  const parts = display ? display.split(/\s+/) : [];
  const capitalize = (word: string) => (word ? word[0]!.toUpperCase() + word.slice(1) : '');
  return {
    firstName: parts[0] || capitalize(fallback),
    lastName: parts.length > 1 ? parts[parts.length - 1]! : '',
    name: display || capitalize(fallback),
    email,
    myName,
  };
}

/** Fill `{first_name}` and friends. Unknown braces are left as typed. */
export function fillSnippet(body: string, vars: SnippetVariables, now = new Date()): string {
  const values: Record<string, string> = {
    first_name: vars.firstName,
    last_name: vars.lastName,
    name: vars.name,
    email: vars.email,
    my_name: vars.myName,
    date: now.toLocaleDateString(undefined, { month: 'long', day: 'numeric' }),
  };
  return body.replace(/\{(first_name|last_name|name|email|my_name|date)\}/g, (_match, key: string) => values[key] ?? '');
}

/** The `;name` right before the caret in this text, if it names a snippet. */
export function triggerBefore(textBeforeCaret: string, snippets: readonly Snippet[]): { snippet: Snippet; length: number } | null {
  const match = /(?:^|\s);([a-z0-9][a-z0-9_-]{0,31})$/i.exec(textBeforeCaret);
  if (!match) return null;
  const name = match[1]!.toLowerCase();
  const snippet = snippets.find((item) => item.name === name);
  return snippet ? { snippet, length: name.length + 1 } : null;
}

/** Snippets matching a picker query, best first: name prefix, then name, then body. */
export function searchSnippets(snippets: readonly Snippet[], query: string): Snippet[] {
  const q = query.trim().toLowerCase().replace(/^;/, '');
  if (!q) return [...snippets];
  const rank = (item: Snippet) => item.name.startsWith(q) ? 0 : item.name.includes(q) ? 1 : item.body.toLowerCase().includes(q) ? 2 : 3;
  return snippets.filter((item) => rank(item) < 3).sort((a, b) => rank(a) - rank(b) || a.name.localeCompare(b.name));
}

/** Insert text at the current selection inside an editable body, keeping Gmail's undo history. */
export function insertAtSelection(text: string): boolean {
  return document.execCommand('insertText', false, text);
}

/**
 * Handle Tab after `;name` in a compose body. Returns true when it expanded a
 * snippet (the caller then stops the event so Gmail and Pidgy don't also act).
 */
export function expandTriggerAtCaret(body: HTMLElement, snippets: readonly Snippet[], vars: SnippetVariables): boolean {
  const selection = document.getSelection();
  if (!selection || selection.rangeCount === 0 || !selection.isCollapsed) return false;
  const range = selection.getRangeAt(0);
  if (!body.contains(range.startContainer) || range.startContainer.nodeType !== Node.TEXT_NODE) return false;
  const node = range.startContainer as Text;
  const before = (node.nodeValue ?? '').slice(0, range.startOffset);
  const found = triggerBefore(before, snippets);
  if (!found) return false;
  const replace = document.createRange();
  replace.setStart(node, range.startOffset - found.length);
  replace.setEnd(node, range.startOffset);
  selection.removeAllRanges();
  selection.addRange(replace);
  return insertAtSelection(fillSnippet(found.snippet.body, vars));
}

let closePicker: (() => void) | undefined;

/**
 * The ⌘/Ctrl ; picker: a small list near the caret. Enter inserts, arrows move,
 * Escape closes. The caret position is restored before inserting.
 */
export function openSnippetPicker(body: HTMLElement, snippets: readonly Snippet[], vars: SnippetVariables, onEmpty: () => void): void {
  closePicker?.();
  const selection = document.getSelection();
  const saved = selection && selection.rangeCount && body.contains(selection.getRangeAt(0).startContainer) ? selection.getRangeAt(0).cloneRange() : null;
  if (!snippets.length) {
    onEmpty();
    return;
  }
  ensureSurface();
  const rect = saved?.getBoundingClientRect();
  const anchor = rect && (rect.top || rect.left) ? rect : body.getBoundingClientRect();
  const host = document.createElement('div');
  host.setAttribute('data-gi-ui', 'snippets');
  host.dataset.pbTheme = knownAppearance();
  const top = Math.min(window.innerHeight - 280, anchor.bottom + 6);
  const left = Math.min(window.innerWidth - 340, Math.max(8, anchor.left));
  host.style.cssText = `position:fixed;top:${Math.max(8, top)}px;left:${left}px;z-index:2147483646;`;
  const shadow = host.attachShadow({ mode: 'open' });
  const style = document.createElement('style');
  style.textContent = `${SURFACE_CSS}
.pb-snip{width:320px;max-height:264px;display:flex;flex-direction:column;background:var(--pb-surface-raised);color:var(--pb-fg);border:1px solid var(--pb-surface-inset);border-radius:var(--pb-radius-xs);font:13px/1.35 ui-sans-serif,system-ui,sans-serif;overflow:hidden}
.pb-snip input{all:unset;padding:8px 10px;border-bottom:1px solid var(--pb-surface-inset);font:inherit}
.pb-snip ul{list-style:none;margin:0;padding:4px;overflow:auto}
.pb-snip li{padding:6px 8px;border-radius:4px;cursor:pointer}
.pb-snip li[aria-selected="true"]{background:var(--pb-accent-soft)}
.pb-snip b{font-weight:600}.pb-snip small{display:block;color:var(--pb-fg-muted);white-space:nowrap;overflow:hidden;text-overflow:ellipsis}`;
  const box = document.createElement('div');
  box.className = 'pb-snip';
  const input = document.createElement('input');
  input.placeholder = 'Search snippets';
  input.setAttribute('aria-label', 'Search snippets');
  const list = document.createElement('ul');
  list.setAttribute('role', 'listbox');
  box.append(input, list);
  shadow.append(style, box);
  document.documentElement.append(host);

  let results = [...snippets];
  let active = 0;
  const render = () => {
    list.replaceChildren(...results.map((item, index) => {
      const li = document.createElement('li');
      li.setAttribute('role', 'option');
      li.setAttribute('aria-selected', String(index === active));
      const name = document.createElement('b');
      name.textContent = `;${item.name}`;
      const preview = document.createElement('small');
      preview.textContent = item.body.replace(/\s+/g, ' ');
      li.append(name, preview);
      li.onmousedown = (event) => { event.preventDefault(); choose(item); };
      return li;
    }));
  };
  const close = () => { host.remove(); document.removeEventListener('mousedown', outside, true); if (closePicker === close) closePicker = undefined; };
  const choose = (item: Snippet) => {
    close();
    body.focus();
    if (saved) {
      const sel = document.getSelection();
      sel?.removeAllRanges();
      sel?.addRange(saved);
    }
    insertAtSelection(fillSnippet(item.body, vars));
  };
  const outside = (event: MouseEvent) => { if (!event.composedPath().includes(host)) close(); };
  input.oninput = () => { results = searchSnippets(snippets, input.value); active = 0; render(); };
  input.onkeydown = (event) => {
    if (event.key === 'ArrowDown') { active = Math.min(results.length - 1, active + 1); render(); event.preventDefault(); }
    else if (event.key === 'ArrowUp') { active = Math.max(0, active - 1); render(); event.preventDefault(); }
    else if (event.key === 'Enter') { if (results[active]) choose(results[active]!); event.preventDefault(); }
    else if (event.key === 'Escape') { close(); body.focus(); event.preventDefault(); }
    event.stopPropagation();
  };
  document.addEventListener('mousedown', outside, true);
  closePicker = close;
  render();
  input.focus();
}
