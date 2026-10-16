/**
 * ALL direct Gmail DOM selectors live here only.
 * Prefer InboxSDK semantics and accessibility attributes over brittle CSS classes.
 * Selectors are ordered by stability preference.
 */
export const SELECTORS = {
  /** Thread list rows. The id often lives on an inner span, not the row class. */
  threadRow: [
    'tr.zA',
    'tr[data-legacy-thread-id]',
    'tr:has(span[data-thread-id])',
    '[role="row"]:has(span[data-thread-id])',
    'div[role="main"] tr[jscontroller]',
    'div[role="listitem"][data-legacy-thread-id]',
    'div.zA',
    '[role="main"] [role="row"]',
    '[role="grid"] [role="row"]',
    '[role="list"] [role="listitem"]',
  ],
  threadRowSubject: ['span[data-thread-id]', '.bog', '.bqe', '[data-legacy-thread-id] span[email]', '.y6 span'],
  threadRowSnippet: ['.y2', '.Zt'],
  threadRowSender: ['.yW span[email]', '.yP', '.zF', 'span[email]', '[data-hovercard-id]'],
  /** Gmail's Draft marker in the sender cell, independent of the UI language. */
  threadRowDraft: ['.yW .boq'],
  threadIdAttr: ['data-legacy-thread-id', 'data-thread-perm-id', 'data-thread-id'],
  messageIdAttr: ['data-legacy-message-id', 'data-message-id'],
  openThread: ['div[role="main"] h2.hP', 'h2[data-thread-perm-id]', '[data-legacy-thread-id].nH'],
  conversationHeading: ['h2.hP', 'h2[data-legacy-thread-id]', 'h2[data-thread-perm-id]'],
  messageBody: [
    '.a3s.aiL',
    '.a3s',
    'div[data-message-id] .a3s',
    '[role="listitem"] .ii',
    '[data-message-id] div[dir="ltr"]',
    '[data-legacy-message-id] div[dir="ltr"]',
    '.ii.gt div[dir]',
  ],
  composeRoot: [
    'div[role="dialog"][aria-label*="compose" i]',
    'div[role="region"][aria-label*="compose" i]',
    'div[role="region"][aria-label*="reply" i]',
    '.M9',
    'div.AD',
    'form[method="POST"].bAs',
    'div[role="region"].ip',
    'div.ip.iq',
  ],
  composeBody: ['div[aria-label="Message Body"]', 'div[g_editable="true"]', '.Am.Al.editable'],
  composeTo: ['textarea[name="to"]', 'input[name="to"]', '[aria-label="To recipients"]'],
  composeSubject: ['input[name="subjectbox"]', 'input[aria-label="Subject"]'],
  archiveButton: [
    'div[aria-label="Archive"]',
    'div[data-tooltip="Archive"]',
    'div[aria-label*="Archive" i]',
  ],
  markReadButton: ['div[aria-label="Mark as read"]', 'div[data-tooltip="Mark as read"]'],
  markUnreadButton: ['div[aria-label="Mark as unread"]', 'div[data-tooltip="Mark as unread"]'],
  starButton: ['div[aria-label="Not starred"]', 'span[aria-label="Not starred"]', '.T-KT'],
  replyButton: [
    'div[aria-label="Reply"]',
    'div[data-tooltip="Reply"]',
    'span[role="link"][aria-label="Reply"]',
    '[role="button"][aria-label*="Reply" i]',
    '[role="link"][aria-label*="Reply" i]',
    'div[aria-label*="Reply" i]',
    'span[aria-label*="Reply" i]',
    'button[aria-label*="Reply" i]',
    '[data-tooltip*="Reply" i]',
    '.ams.bkH',
    'span.ams',
    'div.bkH',
  ],
  searchBox: ['input[aria-label="Search mail"]', 'input[name="q"]', 'form[role="search"] input'],
  /** Toolbar and menu controls the keyboard layer clicks. English labels first, then Gmail's tooltips. */
  replyAllButton: ['[role="button"][aria-label="Reply all"]', '[data-tooltip="Reply all"]', 'span[role="link"][aria-label="Reply all"]'],
  forwardButton: ['[role="button"][aria-label="Forward"]', '[data-tooltip="Forward"]', 'span[role="link"][aria-label="Forward"]'],
  deleteButton: ['div[aria-label="Delete"]', 'div[data-tooltip="Delete"]'],
  snoozeButton: ['div[aria-label="Snooze"]', 'div[data-tooltip="Snooze"]'],
  labelsButton: ['div[aria-label="Labels"]', 'div[data-tooltip="Labels"]'],
  moveToButton: ['div[aria-label="Move to"]', 'div[data-tooltip="Move to"]'],
  unstarButton: ['div[aria-label="Starred"]', 'span[aria-label="Starred"]'],
  olderButton: ['div[aria-label="Older"]', 'div[data-tooltip="Older"]'],
  newerButton: ['div[aria-label="Newer"]', 'div[data-tooltip="Newer"]'],
  backButton: ['div[aria-label^="Back to"]', 'div[data-tooltip^="Back to"]'],
  composeButton: ['div[gh="cm"]', '[role="button"][aria-label="Compose"]'],
  undoLink: ['#link_undo', 'span[role="link"][id="link_undo"]', '[role="alert"] [role="link"]'],
  rowCheckbox: ['div[role="checkbox"]', 'td.oZ-x3 div[role="checkbox"]'],
  /** Gmail's "More send options" arrow beside Send, which opens Schedule send. */
  sendOptionsButton: ['[aria-label="More send options"]', '[data-tooltip="More send options"]'],
  scheduleSendItem: ['[role="menuitem"][aria-label*="Schedule send" i]', '[role="menuitem"]:has([data-tooltip*="Schedule send" i])', 'div[role="menu"] [role="menuitem"]'],
  inboxNav: ['a[aria-label="Inbox"]', 'a[href*="#inbox"]'],
  sendButton: ['[data-tooltip="Send"]', '[aria-label="Send"]', '[aria-label^="Send "]'],
  notice: ['[role="alert"]', '.bAq', '.vh'],
  main: ['div[role="main"]'],
  unsubscribeLink: ['a[href*="unsubscribe" i]', 'a[aria-label*="Unsubscribe" i]'],
  injectedUiMark: '[data-gi-ui="1"]',
} as const;

export type SelectorKey = keyof typeof SELECTORS;

function safeQuery(root: ParentNode, sel: string): Element | null {
  try {
    return root.querySelector(sel);
  } catch {
    return null;
  }
}

function safeQueryAll(root: ParentNode, sel: string): Element[] {
  try {
    return [...root.querySelectorAll(sel)];
  } catch {
    return [];
  }
}

function shadowRoots(root: ParentNode, depth = 0): ShadowRoot[] {
  if (depth > 3 || !root.querySelectorAll) return [];
  const roots: ShadowRoot[] = [];
  for (const el of root.querySelectorAll('*')) {
    if (!el.shadowRoot) continue;
    roots.push(el.shadowRoot);
    roots.push(...shadowRoots(el.shadowRoot, depth + 1));
  }
  return roots;
}

export function queryFirst(root: ParentNode, keys: readonly string[]): Element | null {
  for (const sel of keys) {
    const el = safeQuery(root, sel);
    if (el) return el;
  }
  for (const shadow of shadowRoots(root)) {
    for (const sel of keys) {
      const el = safeQuery(shadow, sel);
      if (el) return el;
    }
  }
  return null;
}

export function queryAll(root: ParentNode, keys: readonly string[]): Element[] {
  for (const sel of keys) {
    const list = safeQueryAll(root, sel);
    if (list.length) return list;
  }
  for (const shadow of shadowRoots(root)) {
    for (const sel of keys) {
      const list = safeQueryAll(shadow, sel);
      if (list.length) return list;
    }
  }
  return [];
}

export function readAttr(el: Element, attrs: readonly string[]): string | undefined {
  for (const a of attrs) {
    const v = el.getAttribute(a);
    if (v) return v;
  }
  // walk up a few levels for thread id
  let cur: Element | null = el;
  for (let i = 0; i < 6 && cur; i++) {
    for (const a of attrs) {
      const v = cur.getAttribute(a);
      if (v) return v;
    }
    cur = cur.parentElement;
  }
  return undefined;
}

export function findMain(root: ParentNode = document): HTMLElement | null {
  return queryFirst(root, SELECTORS.main) as HTMLElement | null;
}

export function findThreadRows(root: ParentNode = document): HTMLElement[] {
  const found = collectMailRows(root);
  if (found.length) return found;
  for (const shadow of shadowRoots(root)) {
    const nested = collectMailRows(shadow);
    if (nested.length) return nested;
  }
  return checkboxRows(root);
}

function collectMailRows(root: ParentNode): HTMLElement[] {
  const found = new Set<HTMLElement>();
  for (const sel of SELECTORS.threadRow) {
    for (const el of safeQueryAll(root, sel)) {
      if (el instanceof HTMLElement && looksLikeMailRow(el)) addRow(found, el);
    }
  }
  return [...found];
}

/** A list row, not a message header or a toolbar. */
function looksLikeMailRow(el: HTMLElement): boolean {
  if (el.closest('[data-gi-ui], .gi-track-card, .gi-track-slot')) return false;
  if (el.matches('tr.zA, div.zA, [data-legacy-thread-id], [data-thread-perm-id]')) return true;
  if (el.querySelector('span[data-thread-id], [data-legacy-thread-id], [data-thread-perm-id]')) return true;
  const role = el.getAttribute('role');
  if ((role === 'row' || role === 'listitem') && el.querySelector('[email], [data-hovercard-id]')) return true;
  return Boolean(el.querySelector('[role="checkbox"]') && el.querySelector('[email], [data-hovercard-id]'));
}

function addRow(found: Set<HTMLElement>, el: HTMLElement): void {
  for (const existing of found) {
    if (existing === el || existing.contains(el)) return;
    if (el.contains(existing)) found.delete(existing);
  }
  found.add(el);
}

function checkboxRows(root: ParentNode): HTMLElement[] {
  const scope = findMain(root) || root;
  if (!scope.querySelectorAll) return [];
  const found = new Set<HTMLElement>();
  for (const box of scope.querySelectorAll('[role="checkbox"]')) {
    const row = box.closest('tr, [role="row"], [role="listitem"]');
    if (!(row instanceof HTMLElement) || !looksLikeMailRow(row)) continue;
    addRow(found, row);
  }
  return [...found];
}

const LIST_HEADS = new Set([
  'inbox',
  'sent',
  'drafts',
  'starred',
  'snoozed',
  'spam',
  'trash',
  'imp',
  'all',
  'chats',
  'scheduled',
]);

/** `#sent/id` and `#inbox/id` are conversations. `#sent` is the list. */
export function isOpenThreadRoute(hash: string): boolean {
  const parts = hash.replace(/^#/, '').split('?')[0].split('/').filter(Boolean);
  if (parts.length < 2) return false;
  const head = parts[0].toLowerCase();
  if (head === 'search' || head === 'label' || head === 'category' || head === 'advanced-search') {
    return parts.length >= 3;
  }
  if (LIST_HEADS.has(head)) return true;
  return parts.length >= 2;
}

export function threadIdFromLocation(hash = typeof location !== 'undefined' ? location.hash : ''): string | undefined {
  if (!isOpenThreadRoute(hash)) return undefined;
  const parts = hash.replace(/^#/, '').split('?')[0].split('/').filter(Boolean);
  const raw = parts[parts.length - 1] || '';
  try {
    return decodeURIComponent(raw) || undefined;
  } catch {
    return raw || undefined;
  }
}

/** Visible message text when Gmail no longer uses the `.a3s` body class. */
export function findMessageBodies(root: ParentNode = document): HTMLElement[] {
  const known = queryAll(root, SELECTORS.messageBody).filter((el): el is HTMLElement => el instanceof HTMLElement);
  const readable = known.filter((el) => Boolean(messageText(el)));
  if (readable.length) return readable;
  const scope = findMain(root) || root;
  if (!scope.querySelectorAll) return [];
  const blocks = [...scope.querySelectorAll('[data-message-id], [data-legacy-message-id], [role="listitem"]')].filter(
    (el): el is HTMLElement => el instanceof HTMLElement && Boolean(messageText(el)) && !el.querySelector('h2'),
  );
  return blocks;
}

export function messageText(el: Element): string {
  const clone = el.cloneNode(true) as HTMLElement;
  clone.querySelectorAll('[data-gi-ui], .gi-track-slot, .gi-track-btn, .gi-cat-chip, #gi-thread-panel').forEach((node) => node.remove());
  const direct = clone.textContent?.replace(/\s+/g, ' ').trim() || '';
  const framed = readFrameText(el);
  if (framed.length > direct.length) return framed;
  return direct || framed;
}

/** Promotional mail often keeps the body in a same-origin frame. */
function readFrameText(el: Element): string {
  const frames = el instanceof HTMLIFrameElement ? [el] : [...el.querySelectorAll('iframe')];
  const parts: string[] = [];
  for (const frame of frames) {
    if (!(frame instanceof HTMLIFrameElement)) continue;
    let raw = '';
    try {
      raw = frame.contentDocument?.body?.textContent || '';
    } catch {
      raw = '';
    }
    const text = raw.replace(/\s+/g, ' ').trim();
    if (text) parts.push(text);
  }
  return parts.join(' ');
}

export function findComposeRoot(root: ParentNode = document): HTMLElement | null {
  return queryFirst(root, SELECTORS.composeRoot) as HTMLElement | null;
}

export function findComposeBody(root: ParentNode = document): HTMLElement | null {
  const compose = findComposeRoot(root) || root;
  return findComposeBodies(compose)[0] || null;
}

export function findComposeBodies(root: ParentNode = document): HTMLElement[] {
  const bodies = SELECTORS.composeBody.flatMap((selector) => safeQueryAll(root, selector));
  if (typeof Element !== 'undefined' && root instanceof Element && SELECTORS.composeBody.some((selector) => {
    try {
      return root.matches(selector);
    } catch {
      return false;
    }
  })) {
    bodies.unshift(root);
  }
  return [...new Set(bodies)] as HTMLElement[];
}

export function findSendButton(root: ParentNode = document): HTMLElement | null {
  const scope = findComposeRoot(root) || root;
  return queryFirst(scope, SELECTORS.sendButton) as HTMLElement | null;
}

export function findArchiveButton(root: ParentNode = document): HTMLElement | null {
  return queryFirst(root, SELECTORS.archiveButton) as HTMLElement | null;
}

/** The first rendered (visible) element matching a selector key, so a hidden toolbar copy is never clicked. */
export function findVisibleControl(key: SelectorKey, root: ParentNode = document): HTMLElement | null {
  const selectors = SELECTORS[key];
  if (typeof selectors === 'string') return null;
  for (const element of queryAll(root, selectors)) {
    if (!(element instanceof HTMLElement)) continue;
    if (element.closest(SELECTORS.injectedUiMark)) continue;
    if (element.getClientRects().length === 0) continue;
    return element;
  }
  return null;
}

export function findSearchBox(root: ParentNode = document): HTMLInputElement | null {
  const el = queryFirst(root, SELECTORS.searchBox);
  return el instanceof HTMLInputElement ? el : null;
}

export function findNotice(root: ParentNode = document): string | null {
  const el = queryFirst(root, SELECTORS.notice);
  const text = el?.textContent?.replace(/\s+/g, ' ').trim();
  return text || null;
}

export function getThreadIdFromElement(el: Element | null): string | undefined {
  if (!el) return undefined;
  return readAttr(el, SELECTORS.threadIdAttr);
}

/** Thread id on the row, or on the subject span inside it. */
export function getThreadIdFromRow(row: Element): string | undefined {
  const own = directThreadAttr(row);
  if (own) return own;
  const nested = row.querySelector('[data-legacy-thread-id], [data-thread-perm-id], [data-thread-id]');
  return nested ? directThreadAttr(nested) : undefined;
}

function directThreadAttr(el: Element): string | undefined {
  for (const attr of SELECTORS.threadIdAttr) {
    const value = el.getAttribute(attr);
    if (value) return value;
  }
  return undefined;
}

export function selectorDiagnostics(root: ParentNode = document): Array<{ key: string; found: boolean }> {
  const checks: Array<[string, () => boolean]> = [
    ['threadRow', () => findThreadRows(root).length > 0],
    ['compose', () => Boolean(findComposeRoot(root))],
    ['composeBody', () => Boolean(findComposeBody(root))],
    ['sendButton', () => Boolean(findSendButton(root))],
    ['archiveButton', () => Boolean(findArchiveButton(root))],
    ['searchBox', () => Boolean(findSearchBox(root))],
    ['openThread', () => Boolean(queryFirst(root, SELECTORS.openThread))],
  ];
  return checks.map(([key, found]) => ({ key, found: found() }));
}

const loggedMisses = new Set<string>();

export function logSelectorMiss(capability: string, keys: readonly string[]): void {
  const hash = typeof location !== 'undefined' ? location.hash : '';
  if (isOpenThreadRoute(hash)) return;
  if (typeof document !== 'undefined' && queryFirst(document, SELECTORS.openThread)) return;
  const route = hash.split('?')[0];
  const key = `${capability}:${route}`;
  if (loggedMisses.has(key)) return;
  const main = typeof document !== 'undefined' ? document.querySelector('[role="main"]') : null;
  const listReady = Boolean(main?.querySelector('table, [role="grid"], [role="list"]'));
  if (!listReady) return;
  loggedMisses.add(key);
  console.warn(`[gi/gmail] selector miss for ${capability}:`, keys.slice(0, 4).join(', '));
}
