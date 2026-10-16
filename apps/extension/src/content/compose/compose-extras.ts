/**
 * Compose additions that are not tracking: the Free "Sent with PigeonBox"
 * footer, "Remind me if no reply", Send later and snippets. Each compose is
 * registered so keyboard chords and the menu beside Send act on the compose
 * the person is in.
 */
import { findComposeBody, findVisibleControl } from '@pigeonbox/gmail';
import { SENT_WITH_URL, normalizeGmailId } from '@pigeonbox/tracking';
import type { SdkComposeView } from '../tracking/compose-tracking';
import { expandTriggerAtCaret, openSnippetPicker, variablesFor, type Snippet, type SnippetVariables } from './snippets';

type Recipient = { name?: string | null; emailAddress?: string | null };
type View = SdkComposeView & {
  getToRecipients?: () => Recipient[];
  getBodyElement?: () => HTMLElement | null;
};

export type ComposeExtrasDeps = {
  /** Free plan: the compose gets the footer. Read when the compose opens. */
  isFree: () => boolean;
  myName: () => string;
  snippets: () => Promise<Snippet[]>;
  /** Set a reminder that clears when someone replies. */
  remind: (threadId: string, businessDays: number) => Promise<{ ok: boolean; dueAt?: number; reason?: string }>;
  reminderBusinessDays: () => number;
  toast: (message: string) => void;
  /** Product counters (content-free), e.g. footer kept or removed. */
  count?: (event: 'footer_added' | 'footer_removed' | 'footer_sent' | 'snippet_used' | 'send_later_opened' | 'remind_on_send') => void;
};

type Entry = { view: View; remindDays: number | null; deps: ComposeExtrasDeps };
const entries = new WeakMap<HTMLElement, Entry>();
const attached = new WeakSet<object>();

export const FOOTER_ATTR = 'data-pigeonbox-footer';

/**
 * Append "Sent with PigeonBox" after the person's text and signature, above any
 * quoted history. Returns false when the compose already has one (a reopened
 * draft) or already holds the person's words (a saved draft they wrote).
 */
export function insertSentWithFooter(body: HTMLElement): boolean {
  if (body.querySelector(`[${FOOTER_ATTR}]`)) return false;
  if ([...body.querySelectorAll('a')].some((anchor) => anchor.href.includes('utm_campaign=sent_with'))) return false;
  const footer = document.createElement('div');
  footer.setAttribute(FOOTER_ATTR, '1');
  footer.style.cssText = 'color:#80868b;font-size:12px;';
  const link = document.createElement('a');
  link.href = SENT_WITH_URL;
  link.textContent = 'PigeonBox';
  link.target = '_blank';
  link.rel = 'noopener';
  footer.append('Sent with ', link);
  const spacer = document.createElement('div');
  spacer.append(document.createElement('br'));
  spacer.setAttribute(FOOTER_ATTR, 'spacer');
  const quote = body.querySelector('.gmail_quote, .gmail_quote_container, .gmail_extra');
  const parent = quote && quote.parentElement === body ? quote : null;
  body.insertBefore(spacer, parent);
  body.insertBefore(footer, parent);
  return true;
}

export function hasFooter(body: HTMLElement): boolean {
  return Boolean(body.querySelector(`[${FOOTER_ATTR}="1"]`));
}

function ownText(body: HTMLElement): string {
  const skip = '.gmail_quote, .gmail_quote_container, blockquote, .gmail_signature, [data-smartmail="gmail_signature"], .gmail_extra, [data-gi-ui], [' + FOOTER_ATTR + ']';
  let text = '';
  const walker = document.createTreeWalker(body, NodeFilter.SHOW_TEXT, {
    acceptNode: (node) => (node.parentElement?.closest(skip) ? NodeFilter.FILTER_REJECT : NodeFilter.FILTER_ACCEPT),
  });
  for (let node = walker.nextNode(); node; node = walker.nextNode()) text += node.nodeValue ?? '';
  return text.trim();
}

function bodyOf(view: View): HTMLElement | null {
  return view.getBodyElement?.() ?? (view.getElement?.() ? findComposeBody(view.getElement!()!) : null);
}

function variables(entry: Entry): SnippetVariables {
  const first = entry.view.getToRecipients?.()?.[0] ?? null;
  return variablesFor(first, entry.deps.myName());
}

export function attachComposeExtras(view: View, deps: ComposeExtrasDeps): void {
  if (attached.has(view)) return;
  attached.add(view);
  const element = view.getElement?.();
  if (!element) return;
  const entry: Entry = { view, remindDays: null, deps };
  entries.set(element, entry);

  // Footer: Free only, once, and never into a draft the person already wrote.
  window.setTimeout(() => {
    const body = bodyOf(view);
    if (!body || !body.isConnected || !deps.isFree() || ownText(body)) return;
    if (insertSentWithFooter(body)) deps.count?.('footer_added');
  }, 250);

  const body = bodyOf(view);
  // ;name + Tab expands a snippet. Capture phase so Pidgy's own Tab handling never sees it.
  body?.addEventListener('keydown', (event) => {
    if (event.key !== 'Tab' || event.shiftKey || event.metaKey || event.ctrlKey || event.altKey) return;
    const target = bodyOf(view);
    if (!target || !snippetCache.length) return;
    if (expandTriggerAtCaret(target, snippetCache, variables(entry))) {
      event.preventDefault();
      event.stopImmediatePropagation();
      deps.count?.('snippet_used');
    }
  }, true);
  void deps.snippets().then((snippets) => { snippetCache = snippets; });

  view.on?.('presending', () => {
    const current = bodyOf(view);
    if (!current || !deps.isFree()) return;
    // Counted once per send: kept the footer, or removed it.
    deps.count?.(hasFooter(current) ? 'footer_sent' : 'footer_removed');
  });
  view.on?.('sent', (event?: { getThreadID?: () => Promise<string>; getThreadIDAsync?: () => Promise<string> }) => {
    const days = entry.remindDays;
    if (days === null) return;
    const read = event?.getThreadIDAsync ?? event?.getThreadID;
    if (!read) return;
    void read.call(event).then(async (raw) => {
      const threadId = normalizeGmailId(raw);
      if (!threadId) return;
      const result = await deps.remind(threadId, days);
      deps.toast(result.ok && result.dueAt
        ? `PigeonBox will remind you on ${new Date(result.dueAt).toLocaleDateString(undefined, { weekday: 'short', month: 'short', day: 'numeric' })} if nobody replies.`
        : result.reason || 'Could not set the reminder.');
    }).catch(() => undefined);
  });
  view.on?.('destroy', () => entries.delete(element));
}

/** Snippets last loaded for any compose; refreshed on every compose open and picker. */
let snippetCache: Snippet[] = [];

export function setSnippetCache(snippets: Snippet[]): void {
  snippetCache = snippets;
}

function entryFor(target: Element | null): Entry | null {
  for (let el: Element | null = target; el; el = el.parentElement) {
    const entry = entries.get(el as HTMLElement);
    if (entry) return entry;
  }
  return null;
}

/** ⌘/Ctrl ; in a compose. */
export async function openSnippetsFor(target: Element | null): Promise<boolean> {
  const entry = entryFor(target);
  const body = entry ? bodyOf(entry.view) : null;
  if (!entry || !body) return false;
  const snippets = await entry.deps.snippets();
  snippetCache = snippets;
  openSnippetPicker(body, snippets, variables(entry), () => entry.deps.toast('No snippets yet. Add them in PigeonBox Settings → Snippets.'));
  return true;
}

/** Toggle "remind me if no reply" for the compose holding `target`. */
export function toggleRemindFor(target: Element | null): boolean {
  const entry = entryFor(target);
  if (!entry) return false;
  entry.remindDays = entry.remindDays === null ? entry.deps.reminderBusinessDays() : null;
  if (entry.remindDays !== null) entry.deps.count?.('remind_on_send');
  entry.deps.toast(entry.remindDays === null
    ? 'Reminder off for this email.'
    : `If nobody replies in ${entry.remindDays} business day${entry.remindDays === 1 ? '' : 's'}, PigeonBox will remind you.`);
  return true;
}

export function remindDaysFor(compose: Element): number | null {
  return entryFor(compose)?.remindDays ?? null;
}

/**
 * Open Gmail's Schedule send for this compose: the arrow beside Send, then
 * "Schedule send". Gmail's own dialog picks the time.
 */
export async function openSendLater(target: Element | null): Promise<boolean> {
  const entry = entryFor(target);
  const root = entry?.view.getElement?.() ?? null;
  if (!entry || !root) return false;
  const arrow = findVisibleControl('sendOptionsButton', root);
  if (!arrow) return false;
  press(arrow);
  for (let waited = 0; waited < 1500; waited += 100) {
    await new Promise((resolve) => setTimeout(resolve, 100));
    const item = findVisibleControl('scheduleSendItem');
    if (item) {
      press(item);
      entry.deps.count?.('send_later_opened');
      return true;
    }
  }
  return false;
}

/** Gmail's menus and toolbar buttons act on mouse down/up, not only click. */
export function press(element: HTMLElement): void {
  const options = { bubbles: true, cancelable: true, view: window };
  element.dispatchEvent(new MouseEvent('mousedown', options));
  element.dispatchEvent(new MouseEvent('mouseup', options));
  element.dispatchEvent(new MouseEvent('click', options));
}

/** Extra rows for the tracking menu beside Send. */
export function composeMenuRows(compose: HTMLElement): Array<{ label: string; checked?: boolean; run: () => void }> {
  const entry = entryFor(compose);
  if (!entry) return [];
  return [
    { label: 'Remind me if no reply', checked: entry.remindDays !== null, run: () => { toggleRemindFor(compose); } },
    { label: 'Send later…', run: () => { void openSendLater(compose).then((ok) => { if (!ok) entry.deps.toast('Gmail’s Schedule send is not available in this compose.'); }); } },
    { label: 'Insert snippet…', run: () => { void openSnippetsFor(bodyOf(entry.view) ?? compose); } },
  ];
}
