/**
 * Prepared replies, placed where the reply is written.
 *
 * When the person opens Gmail's reply composer on a thread PigeonBox Cloud has
 * a ready reply for, the reply is put in that composer through the existing
 * insertion path (at the top, keeping Gmail's signature and quoted history),
 * and Gmail's composer becomes the only place it is edited. Strictly:
 *
 * - only into a reply composer for the open thread whose own text is empty
 *   when it opens and still empty right before inserting;
 * - only a draft that is `ready` (not stale, not already in Gmail as a draft,
 *   not edited, sent, discarded or failed);
 * - each prepared version at most once per page, so closing and reopening a
 *   reply or editing it never brings the text back;
 * - never while PigeonBox itself is opening a reply (an explicit "Use reply").
 *
 * Nothing here sends, schedules or saves anything beyond what Gmail does for
 * any typed text. Every decision is local; the only request is the read-only
 * thread state the thread card already uses.
 */
import type { CloudDraft, ThreadIntel } from '@pigeonbox/api-contract';
import { readComposeText } from './brain-checks';

export type PreparedReply = { draftId: string; variantId: string; body: string };

/** How long an explicit "Use reply" holds the thread so the composer it opens is not also auto-filled. */
const CLAIM_MS = 15_000;
/** A composer that opens and is typed into within this window is the person's, not PigeonBox's. */
export const AUTOFILL_WINDOW_MS = 6_000;

const claims = new Map<string, number>();
const used = new Set<string>();
/** What PigeonBox put in a composer body, so later actions can tell it apart from the person's own words. */
const placed = new WeakMap<HTMLElement, string>();

const bare = (id: string | null | undefined) => (id ?? '').trim().replace(/^#/, '').replace(/^(?:thread-f:|thread-a:)/i, '');
const normalize = (text: string) => text.replace(/\u00a0/g, ' ').replace(/\s+/g, ' ').trim();

export function resetPreparedRepliesForTests(): void {
  claims.clear();
  used.clear();
}

/** The reply PigeonBox may place for this thread, or null. */
export function preparedReply(intel: Pick<ThreadIntel, 'draft'> | null | undefined, variantIndex = 0): PreparedReply | null {
  const draft: CloudDraft | null | undefined = intel?.draft;
  if (!draft || draft.status !== 'ready' || !draft.variants.length) return null;
  const variant = draft.variants[Math.min(Math.max(0, variantIndex), draft.variants.length - 1)]!;
  return variant.body.trim() ? { draftId: draft.id, variantId: variant.id, body: variant.body } : null;
}

/** An explicit "Use reply" is about to open a composer for this thread. */
export function claimThread(threadId: string, now = Date.now()): void {
  claims.set(bare(threadId), now + CLAIM_MS);
}

export function releaseThread(threadId: string): void {
  claims.delete(bare(threadId));
}

function claimed(threadId: string, now: number): boolean {
  const until = claims.get(bare(threadId));
  if (until === undefined) return false;
  if (until > now) return true;
  claims.delete(bare(threadId));
  return false;
}

/** Nothing the person wrote: empty apart from Gmail's quoted history, signature and blank lines. */
export function composerIsEmpty(body: HTMLElement): boolean {
  return !readComposeText(body, null).text.trim();
}

/** The composer holds exactly what PigeonBox put there, unedited. */
export function holdsUneditedPrepared(body: HTMLElement): boolean {
  const text = placed.get(body);
  return Boolean(text) && normalize(readComposeText(body, null).text) === normalize(text!);
}

export function rememberPlaced(body: HTMLElement, text: string, key?: string): void {
  placed.set(body, text);
  if (key) used.add(key);
}

export function forgetPlaced(body: HTMLElement): void {
  placed.delete(body);
}

/**
 * Select what the person wrote (not the signature or quoted history) so the
 * next insertText replaces exactly it. False when there is nothing to select.
 */
export function selectOwnText(body: HTMLElement): boolean {
  const walker = document.createTreeWalker(body, NodeFilter.SHOW_TEXT, {
    acceptNode: (node) => {
      const skipped = node.parentElement?.closest('.gmail_quote, .gmail_quote_container, blockquote, .gmail_signature, [data-smartmail="gmail_signature"], .gmail_extra');
      return skipped && body.contains(skipped) ? NodeFilter.FILTER_REJECT : NodeFilter.FILTER_ACCEPT;
    },
  });
  let first: Text | null = null;
  let last: Text | null = null;
  for (let node = walker.nextNode(); node; node = walker.nextNode()) {
    if (!(node.nodeValue ?? '').trim()) continue;
    first ??= node as Text;
    last = node as Text;
  }
  if (!first || !last) return false;
  const range = document.createRange();
  range.setStart(first, 0);
  range.setEnd(last, last.nodeValue?.length ?? 0);
  body.focus({ preventScroll: true });
  const selection = document.getSelection();
  selection?.removeAllRanges();
  selection?.addRange(range);
  return true;
}

/** Take back an unedited prepared reply (the toast's Undo). Edited text is never touched. */
export function removePrepared(body: HTMLElement): boolean {
  if (!holdsUneditedPrepared(body) || !selectOwnText(body)) return false;
  let removed = false;
  try {
    removed = document.execCommand('delete');
  } catch {
    removed = false;
  }
  if (removed) forgetPlaced(body);
  return removed;
}

type ReplyView = {
  isReply?: () => boolean;
  getBodyElement?: () => HTMLElement | null;
  on?: (event: string, handler: (...args: unknown[]) => void) => void;
};

export type AutofillDeps = {
  /** Cloud mode with thread state available; false in Local mode (nothing is asked). */
  available: () => boolean;
  /** The thread open in Gmail, as the thread card knows it. */
  currentThreadId: () => string | null;
  /** The compose's own thread id when Gmail reports one. */
  composeThreadId: () => Promise<string | null>;
  intel: (threadId: string) => Promise<ThreadIntel | null>;
  /** The version the person last picked in the PigeonBox panel for this draft, if any (ids only). */
  preferredVariant?: (draftId: string) => Promise<string | null>;
  insert: (body: HTMLElement, text: string) => Promise<boolean>;
  /** After a successful fill: e.g. a quiet toast with Undo. */
  onFilled?: (body: HTMLElement) => void;
  now?: () => number;
};

/**
 * Fill a newly opened reply composer with the prepared reply when every rule
 * above holds. Resolves to what happened, for diagnostics and tests.
 */
export async function autofillPreparedReply(view: ReplyView, deps: AutofillDeps, openedAt?: number): Promise<'filled' | 'skipped'> {
  const clock = deps.now ?? (() => Date.now());
  const opened = openedAt ?? clock();
  if (!deps.available() || view.isReply?.() !== true) return 'skipped';
  const threadId = deps.currentThreadId();
  if (!threadId || claimed(threadId, opened)) return 'skipped';
  const body = view.getBodyElement?.() ?? null;
  // Gmail restored a saved draft, or the person already started: theirs.
  if (!body || !composerIsEmpty(body)) return 'skipped';
  let typed = false;
  let closed = false;
  const onInput = () => {
    typed = true;
  };
  body.addEventListener('input', onInput, { passive: true });
  view.on?.('destroy', () => {
    closed = true;
  });
  try {
    const own = await deps.composeThreadId().catch(() => null);
    if (own && bare(own) !== bare(threadId)) return 'skipped';
    const intel = await deps.intel(threadId).catch(() => null);
    const chosen = intel?.draft && deps.preferredVariant ? await deps.preferredVariant(intel.draft.id).catch(() => null) : null;
    const index = chosen ? Math.max(0, intel!.draft!.variants.findIndex((variant) => variant.id === chosen)) : 0;
    const prepared = preparedReply(intel, index);
    if (!prepared) return 'skipped';
    const key = `${prepared.draftId}:${prepared.variantId}`;
    // Re-check everything right before touching the editor.
    if (used.has(key) || closed || typed || !body.isConnected || !composerIsEmpty(body) || clock() - opened > AUTOFILL_WINDOW_MS || claimed(threadId, clock()) || bare(deps.currentThreadId()) !== bare(threadId)) return 'skipped';
    used.add(key);
    body.removeEventListener('input', onInput);
    if (!(await deps.insert(body, prepared.body))) return 'skipped';
    rememberPlaced(body, prepared.body, key);
    deps.onFilled?.(body);
    return 'filled';
  } finally {
    body.removeEventListener('input', onInput);
  }
}

