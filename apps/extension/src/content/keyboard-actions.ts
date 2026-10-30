/**
 * What each keyboard shortcut does in Gmail. List view gets a PigeonBox cursor
 * (j/k move it, Enter opens, triage keys act on its row); thread view acts on
 * the open conversation through Gmail's own toolbar buttons.
 */
import { findSearchBox, findThreadRows, findVisibleControl, isOpenThreadRoute, type SelectorKey } from '@pigeonbox/gmail';
import { knownAppearance } from '../ui/appearance';
import { ensureSurface, SURFACE_CSS } from './shell/surface';
import { press } from './compose/compose-extras';
import { GO_TO_HASH, displayKeys, shortcutGroups, type ShortcutId } from './keyboard';

export type ShortcutDeps = {
  /** Existing PigeonBox commands (verified archive, categories, AI, reminders). */
  runCommand: (id: 'archive' | 'summarize' | 'draft' | 'remind' | 'mark_respond' | 'mark_waiting' | 'mark_fyi') => Promise<void>;
  toast: (message: string) => void;
  openSnippets: (target: Element | null) => Promise<boolean>;
  openSendLater: (target: Element | null) => Promise<boolean>;
};

const CURSOR_ATTR = 'data-pb-cursor';
let cursorIndex = 0;
let cursorStyle: HTMLStyleElement | null = null;

function inThread(): boolean {
  return isOpenThreadRoute(location.hash);
}

function ensureCursorStyle(): void {
  if (cursorStyle?.isConnected) return;
  cursorStyle = document.createElement('style');
  cursorStyle.setAttribute('data-gi-ui', 'cursor-style');
  cursorStyle.textContent = `[${CURSOR_ATTR}]{box-shadow:inset 3px 0 0 #2563eb !important;background-color:rgba(37,99,235,.06) !important;}`;
  document.head.append(cursorStyle);
}

function rows(): HTMLElement[] {
  return findThreadRows(document).filter((row) => row.getClientRects().length > 0);
}

/** The row under the cursor, keeping the cursor on the same index when Gmail redraws the list. */
export function cursorRow(): HTMLElement | null {
  const list = rows();
  if (!list.length) return null;
  const marked = list.findIndex((row) => row.hasAttribute(CURSOR_ATTR));
  if (marked >= 0) cursorIndex = marked;
  cursorIndex = Math.max(0, Math.min(cursorIndex, list.length - 1));
  return list[cursorIndex] ?? null;
}

export function moveCursor(delta: number): HTMLElement | null {
  const list = rows();
  if (!list.length) return null;
  ensureCursorStyle();
  const current = cursorRow();
  const hadCursor = Boolean(current?.hasAttribute(CURSOR_ATTR));
  for (const row of list) row.removeAttribute(CURSOR_ATTR);
  // The first j or k only shows the cursor where it is.
  cursorIndex = hadCursor ? Math.max(0, Math.min(list.length - 1, cursorIndex + delta)) : cursorIndex;
  const row = list[cursorIndex]!;
  row.setAttribute(CURSOR_ATTR, '1');
  row.scrollIntoView({ block: 'nearest' });
  return row;
}

function click(key: SelectorKey, root: ParentNode = document): boolean {
  const control = findVisibleControl(key, root);
  if (!control) return false;
  press(control);
  return true;
}

/** Select the cursor row (when nothing is selected yet) so Gmail's list toolbar acts on it. */
async function selectCursorRowIfNeeded(): Promise<boolean> {
  const row = cursorRow();
  if (!row) return false;
  const anySelected = rows().some((item) => findVisibleControl('rowCheckbox', item)?.getAttribute('aria-checked') === 'true');
  if (anySelected) return true;
  const box = findVisibleControl('rowCheckbox', row);
  if (!box) return false;
  press(box);
  await new Promise((resolve) => setTimeout(resolve, 60));
  return true;
}

/** Run a Gmail toolbar action on the open thread, or on the cursor row in a list. */
async function toolbar(key: SelectorKey, missing: string): Promise<void> {
  if (!inThread() && !(await selectCursorRowIfNeeded())) {
    throw new Error('Press j to pick a conversation first.');
  }
  if (!click(key)) throw new Error(missing);
}

export async function performShortcut(id: ShortcutId, event: KeyboardEvent, deps: ShortcutDeps): Promise<void> {
  const go = GO_TO_HASH[id];
  if (go) {
    location.hash = go;
    cursorIndex = 0;
    return;
  }
  try {
    switch (id) {
      case 'help': toggleShortcutHelp(); return;
      case 'next':
        if (inThread()) { if (!click('olderButton')) deps.toast('This is the last conversation.'); }
        else moveCursor(1);
        return;
      case 'previous':
        if (inThread()) { if (!click('newerButton')) deps.toast('This is the first conversation.'); }
        else moveCursor(-1);
        return;
      case 'open': {
        if (inThread()) return;
        const row = cursorRow();
        if (row?.hasAttribute(CURSOR_ATTR)) press(row);
        return;
      }
      case 'back':
        if (inThread() && !click('backButton')) history.back();
        return;
      case 'search': {
        const box = findSearchBox(document);
        box?.focus();
        box?.select();
        return;
      }
      case 'compose': if (!click('composeButton')) deps.toast('Could not open a new email.'); return;
      case 'reply': if (!inThread() || !click('replyButton')) deps.toast('Open a conversation to reply.'); return;
      case 'reply_all': if (!inThread() || !click('replyAllButton')) deps.toast('Reply all is not available here.'); return;
      case 'forward': if (!inThread() || !click('forwardButton')) deps.toast('Open a conversation to forward it.'); return;
      case 'archive':
        if (inThread()) await deps.runCommand('archive');
        else await toolbar('archiveButton', 'Could not archive.');
        return;
      case 'trash': await toolbar('deleteButton', 'Could not move to Trash.'); return;
      case 'star': {
        if (!inThread()) await selectCursorRowIfNeeded();
        const scope = inThread() ? document : cursorRow() ?? document;
        if (!click('unstarButton', scope) && !click('starButton', scope)) deps.toast('Could not star.');
        return;
      }
      case 'mark_unread': await toolbar('markUnreadButton', 'Could not mark unread.'); return;
      case 'mark_read': await toolbar('markReadButton', 'Could not mark read.'); return;
      case 'select': {
        const row = cursorRow();
        const box = row ? findVisibleControl('rowCheckbox', row) : null;
        if (box) press(box);
        return;
      }
      case 'snooze': await toolbar('snoozeButton', 'Snooze is not available here.'); return;
      case 'label': await toolbar('labelsButton', 'Labels are not available here.'); return;
      case 'move': await toolbar('moveToButton', 'Move to is not available here.'); return;
      case 'undo': if (!click('undoLink')) deps.toast('Nothing to undo.'); return;
      case 'remind': case 'summarize': case 'draft': case 'mark_respond': case 'mark_waiting': case 'mark_fyi':
        if (!inThread()) {
          const row = cursorRow();
          if (!row?.hasAttribute(CURSOR_ATTR)) { deps.toast('Open a conversation first.'); return; }
          press(row);
          await new Promise((resolve) => setTimeout(resolve, 600));
        }
        await deps.runCommand(id);
        return;
      case 'send_later':
        if (!(await deps.openSendLater(event.target as Element | null))) deps.toast('Gmail’s Schedule send is not available in this compose.');
        return;
      case 'snippets':
        await deps.openSnippets(event.target as Element | null);
        return;
      default:
        return;
    }
  } catch (error) {
    deps.toast(error instanceof Error ? error.message : 'That did not work.');
  }
}

let helpHost: HTMLElement | null = null;

/** The `?` cheat sheet. Escape, `?` or a click outside closes it. */
export function toggleShortcutHelp(): void {
  if (helpHost?.isConnected) { closeShortcutHelp(); return; }
  ensureSurface();
  const mac = /Mac|iPhone|iPad/.test(navigator.platform);
  const host = document.createElement('div');
  host.setAttribute('data-gi-ui', 'shortcuts');
  host.dataset.pbTheme = knownAppearance();
  host.style.cssText = 'position:fixed;top:0;left:0;width:0;height:0;z-index:2147483646;';
  const shadow = host.attachShadow({ mode: 'open' });
  const style = document.createElement('style');
  style.textContent = `${SURFACE_CSS}
.pb-keys-backdrop{position:fixed;top:0;left:0;width:100vw;height:100vh;display:flex;align-items:center;justify-content:center;background:rgba(0,0,0,.28)}
.pb-keys{width:min(760px,calc(100vw - 32px));max-height:calc(100vh - 64px);overflow:auto;padding:20px 24px;background:var(--pb-surface-raised);color:var(--pb-fg);border:1px solid var(--pb-surface-inset);border-radius:var(--pb-radius);font:13px/1.4 ui-sans-serif,system-ui,sans-serif}
.pb-keys h2{margin:0 0 4px;font-size:16px;font-weight:600}.pb-keys p{margin:0 0 16px;color:var(--pb-fg-muted)}
.pb-keys-grid{display:grid;grid-template-columns:repeat(auto-fit,minmax(210px,1fr));gap:16px 24px}
.pb-keys h3{margin:0 0 6px;font-size:11px;text-transform:uppercase;letter-spacing:.06em;color:var(--pb-fg-muted)}
.pb-keys dl{margin:0;display:grid;grid-template-columns:1fr auto;gap:4px 12px}.pb-keys dd{margin:0}
.pb-keys kbd{font:11px ui-monospace,monospace;padding:1px 6px;border:1px solid var(--pb-surface-inset);border-radius:4px;background:var(--pb-surface-inset);white-space:nowrap}`;
  const panel = document.createElement('div');
  panel.className = 'pb-keys';
  panel.setAttribute('role', 'dialog');
  panel.setAttribute('aria-label', 'PigeonBox keyboard shortcuts');
  const heading = Object.assign(document.createElement('h2'), { textContent: 'Keyboard shortcuts' });
  const sub = Object.assign(document.createElement('p'), { textContent: `${mac ? '⌘' : 'Ctrl'} K opens every command. Turn shortcuts off in PigeonBox Settings → Inbox.` });
  const grid = document.createElement('div');
  grid.className = 'pb-keys-grid';
  for (const { group, items } of shortcutGroups()) {
    const section = document.createElement('section');
    section.append(Object.assign(document.createElement('h3'), { textContent: group }));
    const list = document.createElement('dl');
    for (const item of items) {
      const kbd = Object.assign(document.createElement('kbd'), { textContent: displayKeys(item.keys, mac) });
      const dd = document.createElement('dd');
      dd.append(kbd);
      list.append(Object.assign(document.createElement('dt'), { textContent: item.label }), dd);
    }
    section.append(list);
    grid.append(section);
  }
  panel.append(heading, sub, grid);
  const backdrop = document.createElement('div');
  backdrop.className = 'pb-keys-backdrop';
  backdrop.append(panel);
  shadow.append(style, backdrop);
  backdrop.addEventListener('mousedown', (event) => { if (!event.composedPath().includes(panel)) closeShortcutHelp(); });
  document.documentElement.append(host);
  helpHost = host;
}

export function closeShortcutHelp(): boolean {
  if (!helpHost?.isConnected) return false;
  helpHost.remove();
  helpHost = null;
  return true;
}
