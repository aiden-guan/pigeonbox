/**
 * Real-time Pidgy checks for one Gmail compose window.
 *
 * Quiet by design: typing only (re)starts an idle timer. After the user pauses,
 * the controller reads the message body once, finds the clause that changed,
 * and runs the cheap local gate (@pigeonbox/shared classifyComposeClaim). Most
 * pauses end there with no message to the worker. A clause that passes is sent
 * to the extension worker (never to Cloud directly), which decides whether it
 * may leave the extension at all.
 *
 * Each compose has its own state, timers, request generation, cache and
 * notice; nothing is shared between windows and nothing is written to storage.
 * Tracking, the placeholder guard and sending are untouched: this module never
 * listens to presending or sending.
 */
import { boundClaim, classifyComposeClaim, normalizeClaim, splitComposeClauses, stripQuotedHistory, type ComposeClaimKind } from '@pigeonbox/shared';
import type { SdkComposeView } from '../tracking/compose-tracking';
import { renderNotice, type NoticeHandle, type NoticeSource } from './brain-notice';

/** Typing must settle this long before anything is read. */
export const BRAIN_IDLE_MS = 900;
/** At most one remote check per compose in this window. */
export const BRAIN_COOLDOWN_MS = 2_800;
/** Answers (including "nothing to say") are reused this long for the same clause and context. */
export const BRAIN_CACHE_MS = 5 * 60_000;
/** After the worker reports checks are off, this compose stops asking for a while. */
export const BRAIN_DISABLED_BACKOFF_MS = 60_000;
/** After a failed check, wait before trying again. */
export const BRAIN_FAILURE_BACKOFF_MS = 15_000;

export type BrainCheckRequest = {
  claim: string;
  subject: string;
  recipientEmails: string[];
  threadId?: string;
  mailbox?: string;
  hint: ComposeClaimKind;
};
export type BrainCheckReply =
  | { ok: true; status: 'none' | 'disabled' }
  | { ok: true; status: 'notice'; notice: { kind: string; severity: 'info' | 'warning'; message: string; suggestedText?: string; sources: NoticeSource[] } };

export type ComposeBrainDeps = {
  /** Cheap and synchronous: false in Local mode, so nothing is even handed to the worker. */
  available: () => boolean;
  /** Hand one bounded clause to the extension worker. Resolves undefined when the worker is unreachable. */
  check: (request: BrainCheckRequest) => Promise<BrainCheckReply | undefined>;
  mailbox?: () => string | null;
  openSource?: (source: NoticeSource, mailbox: string | null) => void;
  now?: () => number;
};

type View = SdkComposeView & { getBodyElement?: () => HTMLElement | null };
type Candidate = { claim: string; norm: string; hint: ComposeClaimKind };
type ShownNotice = { norm: string; claim: string; generation: number; suggestion: string | null; handle: NoticeHandle };

const controllers = new Map<string, { destroy: () => void }>();

/** Live controllers, for diagnostics and tests. */
export function activeBrainChecks(): number {
  return controllers.size;
}

export function resetBrainChecksForTests(): void {
  for (const controller of [...controllers.values()]) controller.destroy();
  controllers.clear();
}

const SKIP = '.gmail_quote, .gmail_quote_container, blockquote, .gmail_signature, [data-smartmail="gmail_signature"], .gmail_extra, .yj6qo, .adL, [data-gi-ui]';
const BLOCK = /^(?:DIV|P|LI|UL|OL|H[1-6]|TR|TABLE|SECTION|ARTICLE|PRE)$/;

/**
 * Plain text of what the user wrote in this body: quoted history, signatures
 * and PigeonBox's own UI are skipped. `caret` is the text offset of the
 * selection focus when it is inside the body.
 */
export function readComposeText(body: HTMLElement, selection: Selection | null = typeof document !== 'undefined' ? document.getSelection() : null): { text: string; caret: number | null } {
  let out = '';
  let caret: number | null = null;
  const focus = selection?.focusNode ?? null;
  const walk = (node: Node) => {
    if (node.nodeType === Node.TEXT_NODE) {
      if (node === focus) caret = out.length + Math.min(selection!.focusOffset, node.nodeValue?.length ?? 0);
      out += (node.nodeValue ?? '').replace(/\u00a0/g, ' ');
      return;
    }
    if (node.nodeType !== Node.ELEMENT_NODE) return;
    const element = node as Element;
    if (element !== body && element.matches(SKIP)) return;
    if (element === focus) caret = out.length;
    if (element.tagName === 'BR') {
      out += '\n';
      return;
    }
    const block = BLOCK.test(element.tagName);
    if (block && out && !out.endsWith('\n')) out += '\n';
    for (const child of Array.from(element.childNodes)) walk(child);
    if (block && !out.endsWith('\n')) out += '\n';
  };
  walk(body);
  const text = stripQuotedHistory(out);
  return { text, caret: caret !== null && caret <= text.length ? caret : null };
}

/** Clauses with their offsets in `text`. */
function locateClauses(text: string): Array<{ text: string; norm: string; start: number; end: number }> {
  let from = 0;
  return splitComposeClauses(text).map((clause) => {
    const start = Math.max(0, text.indexOf(clause, from));
    from = start + clause.length;
    return { text: clause, norm: normalizeClaim(clause), start, end: from };
  });
}

function recipientsOf(view: View): string[] {
  const all = [...(view.getToRecipients?.() ?? []), ...(view.getCcRecipients?.() ?? []), ...(view.getBccRecipients?.() ?? [])];
  return [
    ...new Set(
      all
        .map((recipient) => (recipient.emailAddress || recipient.email || '').trim().toLowerCase())
        .filter((email) => /^[^\s@<>]{1,200}@[^\s@<>]{1,200}\.[^\s@<>]{1,60}$/.test(email)),
    ),
  ].slice(0, 20);
}

function composeId(view: View): string {
  const element = view.getElement?.() ?? null;
  if (!element) return `compose-${Math.random().toString(36).slice(2, 10)}`;
  const existing = element.getAttribute('data-gi-compose-id');
  if (existing) return existing;
  const id = element.id || `compose-${Math.random().toString(36).slice(2, 10)}`;
  element.setAttribute('data-gi-compose-id', id);
  return id;
}

/** A Gmail thread or Google Calendar link for a source; nothing else is ever opened. */
export function sourceHref(source: NoticeSource, mailbox: string | null): string | null {
  if (source.gmailThreadId && /^[A-Za-z0-9_-]{1,64}$/.test(source.gmailThreadId))
    return `https://mail.google.com/mail/?authuser=${encodeURIComponent(mailbox || '0')}#all/${encodeURIComponent(source.gmailThreadId)}`;
  if (!source.url) return null;
  try {
    const url = new URL(source.url);
    const calendar = url.protocol === 'https:' && (url.hostname === 'calendar.google.com' || (url.hostname === 'www.google.com' && url.pathname.startsWith('/calendar/')));
    return calendar && !url.username && !url.password ? url.href : null;
  } catch {
    return null;
  }
}

function defaultOpenSource(source: NoticeSource, mailbox: string | null): void {
  const href = sourceHref(source, mailbox);
  if (href) window.open(href, '_blank', 'noopener,noreferrer');
}

/** Text nodes of the body the user wrote (not quotes, signatures or PigeonBox UI). */
function ownTextNodes(body: HTMLElement): Text[] {
  const nodes: Text[] = [];
  const walker = document.createTreeWalker(body, NodeFilter.SHOW_TEXT, {
    acceptNode: (node) => {
      const skipped = node.parentElement?.closest(SKIP);
      return skipped && skipped !== body && body.contains(skipped) ? NodeFilter.FILTER_REJECT : NodeFilter.FILTER_ACCEPT;
    },
  });
  for (let node = walker.nextNode(); node; node = walker.nextNode()) nodes.push(node as Text);
  return nodes;
}

/** The single text node holding `claim` once, when the claim appears exactly once in what the user wrote. */
function uniqueClaimLocation(body: HTMLElement, claim: string): { node: Text; index: number } | null {
  const { text } = readComposeText(body, null);
  const first = text.indexOf(claim);
  if (first < 0 || text.indexOf(claim, first + 1) >= 0) return null;
  for (const node of ownTextNodes(body)) {
    const value = (node.nodeValue ?? '').replace(/\u00a0/g, ' ');
    const index = value.indexOf(claim);
    if (index >= 0) return { node, index };
  }
  return null;
}

/** Replace exactly the checked clause, keeping the rest of the message and leaving the caret after it. */
export function replaceClaim(body: HTMLElement, claim: string, replacement: string): boolean {
  const found = uniqueClaimLocation(body, claim);
  if (!found) return false;
  const range = document.createRange();
  range.setStart(found.node, found.index);
  range.setEnd(found.node, found.index + claim.length);
  const selection = document.getSelection();
  body.focus({ preventScroll: true });
  selection?.removeAllRanges();
  selection?.addRange(range);
  // insertText keeps Gmail's undo history and fires the input events its draft saving listens to.
  let inserted = false;
  try {
    inserted = document.execCommand('insertText', false, replacement);
  } catch {
    inserted = false;
  }
  if (!inserted || !(body.textContent ?? '').replace(/\u00a0/g, ' ').includes(replacement)) {
    const value = found.node.nodeValue ?? '';
    if (value.slice(found.index, found.index + claim.length).replace(/\u00a0/g, ' ') !== claim) return false;
    found.node.nodeValue = value.slice(0, found.index) + replacement + value.slice(found.index + claim.length);
    const after = document.createRange();
    after.setStart(found.node, found.index + replacement.length);
    after.collapse(true);
    selection?.removeAllRanges();
    selection?.addRange(after);
    body.dispatchEvent(new Event('input', { bubbles: true }));
  }
  return true;
}

/**
 * Attach real-time checks to one InboxSDK compose view. Returns the compose
 * id, or null when the compose has no body to watch.
 */
export function attachComposeBrainChecks(view: View, deps: ComposeBrainDeps): string | null {
  const id = composeId(view);
  if (controllers.has(id)) return id;
  const clock = deps.now ?? (() => Date.now());
  let body: HTMLElement | null = null;
  let observer: MutationObserver | null = null;
  let idleTimer: number | undefined;
  let retryTimer: number | undefined;
  let destroyed = false;
  let detailsChanged = false;
  /** Normalized clauses already looked at; only new or edited ones are candidates. */
  let seen = new Set<string>();
  let pending: Candidate | null = null;
  let lastChecked: Candidate | null = null;
  let generation = 0;
  let inflight: { key: string; generation: number } | null = null;
  let cooldownUntil = 0;
  let pausedUntil = 0;
  let notice: ShownNotice | null = null;
  const cache = new Map<string, { reply: BrainCheckReply; at: number; candidate: Candidate }>();
  const dismissed = new Set<string>();

  const onInput = () => schedule();
  const bind = () => {
    const next = view.getBodyElement?.() ?? null;
    if (next === body && next?.isConnected) return;
    body?.removeEventListener('input', onInput);
    observer?.disconnect();
    body = next;
    if (!body) return;
    body.addEventListener('input', onInput, { passive: true });
    // Only to notice Gmail swapping the body element out; typing never triggers this.
    if (body.parentElement) {
      observer = new MutationObserver(() => {
        if (body && !body.isConnected) bind();
      });
      observer.observe(body.parentElement, { childList: true });
    }
    // What is already there (a reopened draft, Gmail's quoted reply) was not just typed.
    seen = new Set(locateClauses(readComposeText(body, null).text).map((clause) => clause.norm));
  };

  function schedule(details = false) {
    if (destroyed) return;
    detailsChanged ||= details;
    window.clearTimeout(idleTimer);
    idleTimer = window.setTimeout(evaluate, BRAIN_IDLE_MS);
  }

  function hideNotice(animate = true) {
    notice?.handle.remove(animate);
    notice = null;
  }

  function evaluate() {
    idleTimer = undefined;
    if (destroyed || !deps.available()) return;
    if (!body?.isConnected) bind();
    if (!body) return;
    const recheck = detailsChanged;
    detailsChanged = false;
    const { text, caret } = readComposeText(body);
    const clauses = locateClauses(text);
    const present = new Set(clauses.map((clause) => clause.norm));
    if (notice && !present.has(notice.norm)) hideNotice();
    let candidate: Candidate | null = null;
    const fresh = clauses.filter((clause) => !seen.has(clause.norm));
    seen = present;
    // Nearest the caret first: that is what the user just wrote.
    const ordered = caret === null ? [...fresh].reverse() : [...fresh].sort((a, b) => distance(a, caret) - distance(b, caret));
    for (const clause of ordered) {
      const hint = classifyComposeClaim(clause.text);
      if (!hint) continue;
      candidate = { claim: boundClaim(clause.text), norm: clause.norm, hint };
      break;
    }
    // Recipients or subject changed: the last checked clause may mean something else now.
    if (!candidate && recheck && lastChecked && present.has(lastChecked.norm)) candidate = lastChecked;
    if (!candidate) {
      if (!notice) resurface(present);
      return;
    }
    pending = candidate;
    dispatch();
  }

  function request(candidate: Candidate): BrainCheckRequest {
    const threadId = typeof view.getThreadID === 'function' ? view.getThreadID() : null;
    const mailbox = deps.mailbox?.() ?? view.getFromContact?.()?.emailAddress ?? null;
    return {
      claim: candidate.claim,
      subject: (view.getSubject?.() ?? '').slice(0, 998),
      recipientEmails: recipientsOf(view),
      ...(typeof threadId === 'string' && /^#?[A-Za-z0-9:_-]{1,64}$/.test(threadId) ? { threadId } : {}),
      ...(mailbox && /^[^\s@<>]{1,200}@[^\s@<>]{1,200}$/.test(mailbox) ? { mailbox } : {}),
      hint: candidate.hint,
    };
  }

  function cacheKey(check: BrainCheckRequest): string {
    // Calendar answers do not depend on the subject; Brain answers can.
    const subject = check.hint === 'availability' || check.hint === 'scheduling' ? '' : normalizeClaim(check.subject);
    return JSON.stringify([normalizeClaim(check.claim), subject, [...check.recipientEmails].sort(), check.threadId ?? '', check.mailbox ?? '']);
  }

  function dispatch() {
    window.clearTimeout(retryTimer);
    retryTimer = undefined;
    const candidate = pending;
    if (!candidate || destroyed) return;
    const now = clock();
    if (now < pausedUntil || dismissed.has(candidate.norm)) {
      pending = null;
      return;
    }
    // Held back by the cooldown: only send it if the words are still in the message.
    if (!body || !locateClauses(readComposeText(body, null).text).some((clause) => clause.norm === candidate.norm)) {
      pending = null;
      return;
    }
    const check = request(candidate);
    const key = cacheKey(check);
    const cached = cache.get(key);
    if (cached && now - cached.at < BRAIN_CACHE_MS) {
      pending = null;
      lastChecked = candidate;
      apply(cached.reply, candidate, generation);
      return;
    }
    if (inflight?.key === key) {
      pending = null;
      return;
    }
    if (now < cooldownUntil) {
      retryTimer = window.setTimeout(dispatch, cooldownUntil - now);
      return;
    }
    pending = null;
    lastChecked = candidate;
    const mine = ++generation;
    inflight = { key, generation: mine };
    cooldownUntil = now + BRAIN_COOLDOWN_MS;
    void deps
      .check(check)
      .catch(() => undefined)
      .then((reply) => {
        if (inflight?.generation === mine) inflight = null;
        if (destroyed) return;
        if (!reply) {
          cooldownUntil = Math.max(cooldownUntil, clock() + BRAIN_FAILURE_BACKOFF_MS);
          return;
        }
        if (reply.status === 'disabled') {
          pausedUntil = clock() + BRAIN_DISABLED_BACKOFF_MS;
          hideNotice();
          return;
        }
        cache.set(key, { reply, at: clock(), candidate });
        if (cache.size > 50) cache.delete(cache.keys().next().value!);
        // A newer check was sent while this one was out: its answer wins.
        if (mine !== generation) return;
        apply(reply, candidate, mine);
      });
  }

  /** The newest notice's words were deleted: an earlier answered conflict that is still in the message comes back. */
  function resurface(present: Set<string>) {
    const now = clock();
    for (const [key, entry] of [...cache.entries()].reverse()) {
      if (entry.reply.status !== 'notice' || now - entry.at >= BRAIN_CACHE_MS) continue;
      if (!present.has(entry.candidate.norm) || dismissed.has(entry.candidate.norm) || cacheKey(request(entry.candidate)) !== key) continue;
      apply(entry.reply, entry.candidate, generation);
      return;
    }
  }

  function apply(reply: BrainCheckReply, candidate: Candidate, answered: number) {
    if (destroyed || !body) return;
    // The clause may have been deleted or edited while Cloud was answering.
    const present = new Set(locateClauses(readComposeText(body, null).text).map((clause) => clause.norm));
    if (!present.has(candidate.norm)) return;
    if (reply.status !== 'notice') {
      if (notice?.norm === candidate.norm) hideNotice();
      return;
    }
    if (dismissed.has(candidate.norm)) return;
    hideNotice(false);
    const mailbox = deps.mailbox?.() ?? null;
    const source = reply.notice.sources.find((item) => sourceHref(item, mailbox)) ?? null;
    const suggestion = reply.notice.suggestedText && reply.notice.suggestedText !== candidate.claim && uniqueClaimLocation(body, candidate.claim) ? reply.notice.suggestedText : null;
    const shown: ShownNotice = {
      norm: candidate.norm,
      claim: candidate.claim,
      generation: answered,
      suggestion,
      handle: renderNotice(
        body,
        { severity: reply.notice.severity, message: reply.notice.message, suggestion, source },
        {
          onSource: () => source && (deps.openSource ?? defaultOpenSource)(source, mailbox),
          onSuggest: () => applySuggestion(shown),
          onDismiss: () => {
            dismissed.add(shown.norm);
            if (notice === shown) hideNotice();
            body?.focus({ preventScroll: true });
          },
        },
      ),
    };
    notice = shown;
  }

  function applySuggestion(shown: ShownNotice) {
    // Only for the newest answer, and only while the checked words are still there exactly once.
    if (notice !== shown || !shown.suggestion || shown.generation !== generation || !body) return;
    if (!replaceClaim(body, shown.claim, shown.suggestion)) {
      // Something changed underneath: leave the advice, drop the one-click fix.
      shown.handle.host.shadowRoot?.querySelector('[data-action="suggest"]')?.remove();
      shown.suggestion = null;
      return;
    }
    hideNotice();
    seen.add(normalizeClaim(shown.suggestion));
  }

  function destroy() {
    if (destroyed) return;
    destroyed = true;
    window.clearTimeout(idleTimer);
    window.clearTimeout(retryTimer);
    body?.removeEventListener('input', onInput);
    observer?.disconnect();
    hideNotice(false);
    cache.clear();
    dismissed.clear();
    seen.clear();
    pending = null;
    lastChecked = null;
    body = null;
    controllers.delete(id);
  }

  bind();
  controllers.set(id, { destroy });
  view.on?.('recipientsChanged', () => schedule(true));
  view.on?.('subjectChanged', () => schedule(true));
  view.on?.('destroy', destroy);
  return id;
}

function distance(clause: { start: number; end: number }, caret: number): number {
  if (caret >= clause.start && caret <= clause.end) return 0;
  return Math.min(Math.abs(caret - clause.start), Math.abs(caret - clause.end));
}
