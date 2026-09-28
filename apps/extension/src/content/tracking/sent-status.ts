import {
  describeTrackingStatus,
  matchTrackedEmail,
  normalizeGmailId,
  type TrackedEmailSummary,
  type TrackingRowQuery,
  type TrackingStatusCopy,
} from '@pigeonbox/tracking';
import { findThreadRows, threadIdFromLocation } from '@pigeonbox/gmail';
import { ensureSurface } from '../shell/surface';
import type { SelfViewSource } from './message-self-view';

export type SentStatusController = {
  setEmails(emails: TrackedEmailSummary[]): void;
  setTrackerBaseUrl(url: string): void;
  openThreadStatus(): TrackingStatusCopy | null;
  paint(): void;
  destroy(): void;
};

function threadRows(root: ParentNode): HTMLElement[] {
  try {
    return findThreadRows(root).filter((row) => !row.closest('[data-gi-ui="track-card"]'));
  } catch {
    return [];
  }
}

export function isThreadOpenInteractionTarget(target: EventTarget | null, row: Element): boolean {
  if (!(target instanceof Element)) return false;
  if (!row.contains(target)) return false;

  // Exclude tracking UI
  if (target.closest('.gi-track-btn, .gi-track-slot, .gi-track-card, .gi-track-backdrop, [data-gi-ui]')) {
    return false;
  }

  // Exclude checkboxes
  if (target.closest('input[type="checkbox"], [role="checkbox"], .oZ-jc, .T-Jo')) {
    return false;
  }

  // Exclude stars
  if (target.closest('.T-KT, [aria-label*="Star" i], [data-tooltip*="Star" i]')) {
    return false;
  }

  // Exclude row menus, toolbar actions, hover quick action buttons
  if (
    target.closest(
      '.bq9, [role="menu"], [role="menuitem"], [data-tooltip*="Snooze" i], [data-tooltip*="Delete" i], [data-tooltip*="Archive" i], [data-tooltip*="Mark as" i]',
    )
  ) {
    return false;
  }

  // Exclude buttons / action links that don't open the thread
  const btn = target.closest('button, [role="button"]');
  if (btn && btn !== row) {
    return false;
  }

  const anchor = target.closest('a');
  if (anchor && (anchor.getAttribute('href')?.startsWith('#label') || anchor.hasAttribute('download'))) {
    return false;
  }

  // Exclude category / label chips
  if (target.closest('.ar, .gi-cat-chip, [data-label-id]')) {
    return false;
  }

  return true;
}

export function installSentStatus(opts: {
  emails?: TrackedEmailSummary[];
  trackerBaseUrl?: string;
  onNotify: (trackingId: string, enabled: boolean) => void;
  onStatus?: () => void;
  onLink?: (trackingId: string, gmailThreadId: string) => void;
  onSelfView?: (
    trackingId: string,
    gmailThreadId?: string | null,
    gmailMessageId?: string | null,
    observedAt?: number,
    source?: SelfViewSource,
  ) => void;
}): SentStatusController {
  let emails = opts.emails || [];
  let trackerBaseUrl = opts.trackerBaseUrl || '';
  let observer: MutationObserver | null = null;
  let timer: ReturnType<typeof setTimeout> | null = null;
  let statusSignature = '';
  const recentSelfViews = new Map<string, { observedAt: number; source: SelfViewSource }>();
  ensureStyles();
  setTrackerBaseAttribute(trackerBaseUrl);

  const reportSelfView = (
    trackingId: string,
    gmailThreadId?: string | null,
    gmailMessageId?: string | null,
    observedAt = Date.now(),
    source: SelfViewSource = 'ROW_INTERACTION',
  ) => {
    const normMsg = normalizeGmailId(gmailMessageId);
    const key = normMsg ? `${trackingId}:${normMsg}` : trackingId;
    const last = recentSelfViews.get(key);
    if (!last || observedAt - last.observedAt > 10_000) {
      recentSelfViews.set(key, { observedAt, source });
      opts.onSelfView?.(trackingId, gmailThreadId, gmailMessageId, observedAt, source);
    }
  };

  const paint = () => {
    paintRows(document, emails, trackerBaseUrl, opts.onNotify, reportSelfView);
    paintConversation(document, emails, trackerBaseUrl, opts.onNotify, opts.onLink);
    refreshOpenCard(emails, trackerBaseUrl);
    const next = statusSignatureFor(document, emails, trackerBaseUrl);
    if (next !== statusSignature) {
      statusSignature = next;
      opts.onStatus?.();
    }
  };
  const schedule = () => {
    if (timer) clearTimeout(timer);
    timer = setTimeout(paint, 120);
  };

  if (document.body) {
    observer = new MutationObserver((mutations) => {
      const own = mutations.every((mutation) => {
        const node = mutation.target instanceof Element ? mutation.target : mutation.target.parentElement;
        return Boolean(node?.closest('.gi-track-slot, .gi-track-card, .gi-track-backdrop, #gi-track-style'));
      });
      if (!own) schedule();
    });
    observer.observe(document.body, { childList: true, subtree: true });
    paint();
  }

  return {
    setEmails(next) {
      emails = next;
      paint();
    },
    setTrackerBaseUrl(url) {
      trackerBaseUrl = url;
      setTrackerBaseAttribute(url);
      paint();
    },
    openThreadStatus() {
      const match = matchConversation(document, emails);
      return match ? describeTrackingStatus(match, { trackerBaseUrl }) : null;
    },
    paint,
    destroy() {
      observer?.disconnect();
      if (timer) clearTimeout(timer);
      closeCard();
    },
  };
}

function collectMessageIds(row: Element): string[] {
  const ids = new Set<string>();
  const attrs = ['data-legacy-message-id', 'data-message-id', 'data-legacy-last-message-id'];
  const nodes = [row, ...row.querySelectorAll(attrs.map((a) => `[${a}]`).join(','))];
  for (const node of nodes) {
    for (const attr of attrs) {
      const value = node.getAttribute(attr);
      if (value) ids.add(value);
    }
  }
  return [...ids];
}

export function readRowQuery(row: Element): TrackingRowQuery {
  const threadIds = collectThreadIds(row);
  const messageIds = collectMessageIds(row);
  const subject = readSubject(row);
  const emails = new Set<string>();
  row.querySelectorAll('[email], [data-hovercard-id]').forEach((node) => {
    const email = node.getAttribute('email') || node.getAttribute('data-hovercard-id') || '';
    if (email.includes('@')) emails.add(email);
  });
  return {
    threadIds,
    messageId: messageIds[0] || null,
    messageIds,
    subject,
    emails: [...emails],
  };
}

export function paintRows(
  root: ParentNode,
  emails: TrackedEmailSummary[],
  trackerBaseUrl: string,
  onNotify: (trackingId: string, enabled: boolean) => void,
  onSelfView?: (
    trackingId: string,
    gmailThreadId?: string | null,
    gmailMessageId?: string | null,
    observedAt?: number,
    source?: SelfViewSource,
  ) => void,
): void {
  ensureStyles();
  threadRows(root).forEach((row) => {
    if (row.closest('[data-gi-ui="track-card"]')) return;
    const match = matchTrackedEmail(readRowQuery(row), emails);
    const existing = row.querySelector('.gi-track-slot');
    if (!match) {
      existing?.remove();
      if (row.dataset.giTracked) delete row.dataset.giTracked;
      delete row.dataset.giTrackingId;
      delete row.dataset.giTrackingThreadId;
      delete row.dataset.giTrackingMessageId;
      return;
    }
    const slot = placeRowSlot(row, existing instanceof HTMLElement ? existing : null);
    renderSlot(slot, match, trackerBaseUrl, onNotify, false, statusColor(row, match.openCount > 0 || match.clickCount > 0));
    row.dataset.giTracked = match.openCount > 0 || match.clickCount > 0 ? 'opened' : 'pending';
    row.dataset.giTrackingId = match.trackingId;
    row.dataset.giTrackingThreadId = match.gmailThreadId || '';
    row.dataset.giTrackingMessageId = match.gmailMessageId || '';

    if (!row.dataset.giSelfBound) {
      row.dataset.giSelfBound = 'true';
      const handleEarlyInteraction = (e: Event) => {
        if (!isThreadOpenInteractionTarget(e.target, row)) return;
        const currentTrackingId = row.dataset.giTrackingId;
        if (!currentTrackingId) return;
        const currentThreadId = row.dataset.giTrackingThreadId || null;
        const currentMessageId = row.dataset.giTrackingMessageId || null;
        const observedAt = Date.now();
        onSelfView?.(currentTrackingId, currentThreadId, currentMessageId, observedAt, 'ROW_INTERACTION');
      };
      row.addEventListener('pointerdown', handleEarlyInteraction, { capture: true });
      row.addEventListener('click', handleEarlyInteraction);
    }
  });
}

function readSubject(row: Element): string {
  const node =
    row.querySelector('span[data-thread-id]') ||
    row.querySelector('.bog') ||
    row.querySelector('.y6 span:not(.gi-cat-chip)');
  const known = node ? textWithoutChips(node) : '';
  if (known) return known;
  const sender = row.querySelector('[email], [data-hovercard-id]');
  for (const cell of row.querySelectorAll('td, [role="gridcell"]')) {
    if (sender && cell.contains(sender)) continue;
    const text = (cell.querySelector('span')?.textContent || cell.textContent || '').replace(/\s+/g, ' ').trim();
    if (text && !text.includes('@')) return text;
  }
  return '';
}

function textWithoutChips(node: Element): string {
  const clone = node.cloneNode(true) as HTMLElement;
  clone.querySelectorAll('.gi-cat-chip, .gi-track-slot').forEach((chip) => chip.remove());
  return clone.textContent?.replace(/\s+/g, ' ').trim() || '';
}

function collectThreadIds(row: Element): string[] {
  const ids = new Set<string>();
  const attrs = ['data-gi-thread-id', 'data-legacy-thread-id', 'data-thread-id', 'data-thread-perm-id'];
  const nodes = [
    row,
    ...row.querySelectorAll('[data-gi-thread-id], [data-legacy-thread-id], [data-thread-id], [data-thread-perm-id]'),
  ];
  for (const node of nodes) {
    for (const attr of attrs) {
      const value = node.getAttribute(attr);
      if (value) ids.add(value);
    }
  }
  return [...ids];
}

export function paintConversation(
  root: ParentNode,
  emails: TrackedEmailSummary[],
  trackerBaseUrl: string,
  onNotify: (trackingId: string, enabled: boolean) => void,
  onLink?: (trackingId: string, gmailThreadId: string) => void,
): void {
  const heading = conversationHeading(root);
  if (!heading) return;
  const match = matchConversation(root, emails);
  const next = heading.nextElementSibling;
  const existing = next instanceof HTMLElement && next.classList.contains('gi-track-slot') ? next : null;
  if (!match) {
    existing?.remove();
    return;
  }
  const hashId = threadIdFromLocation();
  if (hashId && !match.gmailThreadId && onLink) {
    match.gmailThreadId = hashId;
    onLink(match.trackingId, hashId);
  }
  const slot = existing || createSlotAfter(heading);
  const opened = match.openCount > 0 || match.clickCount > 0;
  renderSlot(slot, match, trackerBaseUrl, onNotify, true, statusColor(heading, opened));
}

export function matchConversation(root: ParentNode, emails: TrackedEmailSummary[]): TrackedEmailSummary | null {
  const heading = conversationHeading(root);
  const hashId = threadIdFromLocation();
  if (!heading) {
    if (!hashId) return null;
    return matchTrackedEmail({ threadIds: [hashId], subject: '', emails: [] }, emails);
  }
  const query = readRowQuery(conversationScope(heading));
  const subject = subjectText(heading) || query.subject;
  const threadIds = hashId ? [...new Set([hashId, ...query.threadIds])] : query.threadIds;
  return matchTrackedEmail({ threadIds, subject, emails: query.emails }, emails);
}

function subjectText(heading: HTMLElement): string {
  const clone = heading.cloneNode(true) as HTMLElement;
  clone.querySelectorAll('.gi-track-slot, .gi-track-btn').forEach((node) => node.remove());
  return clone.textContent?.replace(/\s+/g, ' ').trim() || '';
}

function conversationHeading(root: ParentNode): HTMLElement | null {
  const heading = root.querySelector?.('h2.hP, h2[data-legacy-thread-id], h2[data-thread-perm-id], [role="main"] h2');
  return heading instanceof HTMLElement ? heading : null;
}

function conversationScope(heading: HTMLElement): Element {
  let scope: Element = heading;
  for (let i = 0; i < 6 && scope.parentElement; i += 1) {
    if (scope.querySelector('[email], [data-hovercard-id]')) break;
    scope = scope.parentElement;
  }
  return scope;
}

function statusSignatureFor(root: ParentNode, emails: TrackedEmailSummary[], trackerBaseUrl: string): string {
  const match = matchConversation(root, emails);
  if (!match) return '';
  const copy = describeTrackingStatus(match, { trackerBaseUrl });
  return `${match.trackingId}:${copy.markLabel}:${copy.countLabel}`;
}

/** Sit the check in the recipient line, just before "To: Name". A span between table cells is not shown. */
function senderHost(row: HTMLElement): HTMLElement | null {
  const named = row.querySelector<HTMLElement>('.yW');
  if (named && !named.closest('.gi-track-slot')) return named;
  const email = [...row.querySelectorAll<HTMLElement>('[email], [data-hovercard-id]')].find(
    (node) => !node.closest('.gi-track-slot'),
  );
  if (!email) return null;
  const cell = email.closest('td, [role="gridcell"]');
  if (cell instanceof HTMLElement) return cell;
  return email.parentElement;
}

function placeRowSlot(row: HTMLElement, existing: HTMLElement | null): HTMLElement {
  const host = senderHost(row);
  if (existing && host && existing.parentElement === host && host.firstElementChild === existing) return existing;
  existing?.remove();
  const slot = document.createElement('span');
  slot.className = 'gi-track-slot';
  slot.setAttribute('data-gi-ui', 'track');
  if (host) host.insertBefore(slot, host.firstChild);
  else row.insertBefore(slot, row.firstChild);
  return slot;
}

function statusColor(row: Element, opened: boolean): string {
  return opened ? (isDarkRow(row) ? '#edbb93' : '#935023') : isDarkRow(row) ? '#9aa0a6' : '#80868b';
}

function isDarkRow(row: Element): boolean {
  let current: Element | null = row;
  for (let i = 0; i < 8 && current; i += 1) {
    const opaque = opaqueColor(getComputedStyle(current).backgroundColor);
    if (opaque) {
      const luminance = (opaque[0] * 299 + opaque[1] * 587 + opaque[2] * 114) / 1000;
      return luminance < 140;
    }
    current = current.parentElement;
  }
  return false;
}

function opaqueColor(bg: string): [number, number, number] | null {
  const match = bg.match(/rgba?\((\d+),\s*(\d+),\s*(\d+)(?:,\s*([\d.]+))?\)/);
  if (!match) return null;
  const alpha = match[4] === undefined ? 1 : Number(match[4]);
  if (!Number.isFinite(alpha) || alpha < 0.5) return null;
  return [Number(match[1]), Number(match[2]), Number(match[3])];
}

function createSlotAfter(anchor: HTMLElement): HTMLElement {
  const slot = document.createElement('span');
  slot.className = 'gi-track-slot';
  slot.setAttribute('data-gi-ui', 'track');
  anchor.insertAdjacentElement('afterend', slot);
  return slot;
}

function renderSlot(
  slot: HTMLElement,
  match: TrackedEmailSummary,
  trackerBaseUrl: string,
  onNotify: (trackingId: string, enabled: boolean) => void,
  labeled = false,
  color?: string,
): void {
  const copy = describeTrackingStatus(match, { trackerBaseUrl });
  const ink = color || (copy.opened ? '#935023' : '#80868b');
  const signature = `${match.trackingId}:${copy.opened}:${copy.countLabel}:${copy.markLabel}:${labeled}:${match.notifyIfNoReply}:${trackerBaseUrl}:${ink}`;
  if (slot.dataset.signature === signature && slot.querySelector('.gi-track-btn')) return;
  slot.dataset.signature = signature;
  slot.replaceChildren(renderButton(match, copy, trackerBaseUrl, onNotify, labeled, ink));
}

function renderButton(
  email: TrackedEmailSummary,
  copy: TrackingStatusCopy,
  trackerBaseUrl: string,
  onNotify: (trackingId: string, enabled: boolean) => void,
  labeled: boolean,
  color: string,
): HTMLElement {
  const button = document.createElement('span');
  button.className = 'gi-track-btn';
  button.dataset.state = copy.opened ? 'opened' : 'pending';
  button.dataset.trackingId = email.trackingId;
  button.dataset.trackerBase = trackerBaseUrl;
  button.setAttribute('role', 'button');
  button.tabIndex = 0;
  button.setAttribute('aria-label', copy.headline);
  button.title = copy.headline;
  button.style.cssText = controlStyle(color);
  button.innerHTML = CHECK_ICON;
  if (labeled) {
    const label = document.createElement('span');
    label.className = 'gi-track-label';
    label.textContent = copy.markLabel;
    button.append(label);
  }
  button.addEventListener('pointerdown', (event) => {
    event.stopPropagation();
  });
  button.addEventListener('mousedown', (event) => {
    event.stopPropagation();
  });
  button.addEventListener('click', (event) => {
    event.preventDefault();
    event.stopPropagation();
    toggleCard(button, email, onNotify);
  });
  button.addEventListener('keydown', (event) => {
    if (event.key !== 'Enter' && event.key !== ' ') return;
    event.preventDefault();
    event.stopPropagation();
    toggleCard(button, email, onNotify);
  });
  return button;
}

function controlStyle(color: string): string {
  return [
    'display:inline-flex',
    'align-items:center',
    'gap:4px',
    'width:auto',
    'height:auto',
    'margin:0',
    'padding:0',
    'border:0',
    'background:transparent',
    'box-shadow:none',
    `color:${color}`,
    'cursor:pointer',
    'font-weight:600',
    'font-size:13px',
    'line-height:1',
    'font-family:ui-sans-serif,system-ui,sans-serif',
    'vertical-align:middle',
    'white-space:nowrap',
    'flex:0 0 auto',
  ].join(';');
}

let openCard: HTMLElement | null = null;
let openBackdrop: HTMLElement | null = null;
let openTrackingId: string | null = null;

function toggleCard(
  anchor: HTMLElement,
  email: TrackedEmailSummary,
  onNotify: (trackingId: string, enabled: boolean) => void,
): void {
  if (!openCard?.isConnected) {
    openCard = null;
    openBackdrop = null;
    openTrackingId = null;
  }
  if (openTrackingId === email.trackingId) {
    closeCard();
    anchor.focus();
    return;
  }
  closeCard();
  const card = renderCard(email, anchor, onNotify);
  const backdrop = document.createElement('div');
  backdrop.className = 'gi-track-backdrop';
  backdrop.setAttribute('data-gi-ui', 'track-backdrop');
  backdrop.addEventListener('click', () => {
    closeCard();
    anchor.focus();
  });
  document.body.append(backdrop, card);
  placeCard(card, anchor);
  openCard = card;
  openBackdrop = backdrop;
  openTrackingId = email.trackingId;
  card.querySelector<HTMLElement>('[role="switch"]')?.focus();
}

function renderCard(
  email: TrackedEmailSummary,
  anchor: HTMLElement,
  onNotify: (trackingId: string, enabled: boolean) => void,
): HTMLElement {
  const copy = describeTrackingStatus(email, {
    trackerBaseUrl: anchor.dataset.trackerBase || readTrackerBase(anchor),
  });
  const card = document.createElement('div');
  card.className = 'gi-track-card';
  card.setAttribute('data-gi-ui', 'track-card');
  card.setAttribute('role', 'dialog');
  card.setAttribute('aria-label', 'Email open status');
  card.tabIndex = -1;

  const headline = document.createElement('p');
  headline.className = 'gi-track-headline';
  if (copy.emphasis) {
    const strong = document.createElement('strong');
    strong.textContent = copy.emphasis;
    headline.append(strong, document.createTextNode(copy.rest));
  } else {
    headline.textContent = copy.headline;
  }

  const detail = document.createElement('p');
  detail.className = 'gi-track-detail';
  detail.innerHTML = EYE_ICON;
  const detailText = document.createElement('span');
  detailText.textContent = copy.detail;
  detail.append(detailText);

  const count = document.createElement('div');
  count.className = copy.opened ? 'gi-track-count is-open' : 'gi-track-count';
  count.textContent = copy.countLabel;

  const footer = document.createElement('div');
  footer.className = 'gi-track-footer';
  const toggle = document.createElement('button');
  toggle.type = 'button';
  toggle.className = 'gi-switch';
  toggle.setAttribute('role', 'switch');
  toggle.setAttribute('aria-checked', email.notifyIfNoReply ? 'true' : 'false');
  toggle.setAttribute('aria-label', 'Notify me if there is no reply');
  const knob = document.createElement('span');
  knob.className = 'gi-switch-knob';
  toggle.append(knob);
  toggle.addEventListener('click', (event) => {
    event.preventDefault();
    event.stopPropagation();
    const next = toggle.getAttribute('aria-checked') !== 'true';
    toggle.setAttribute('aria-checked', next ? 'true' : 'false');
    email.notifyIfNoReply = next;
    onNotify(email.trackingId, next);
  });
  const label = document.createElement('span');
  label.className = 'gi-track-notify';
  label.textContent = 'Notify me if there is no reply';
  footer.append(toggle, label);

  const arrow = document.createElement('span');
  arrow.className = 'gi-track-arrow';
  arrow.setAttribute('aria-hidden', 'true');

  card.append(headline, detail, count);
  if (copy.loopbackWarning) {
    const warning = document.createElement('p');
    warning.className = 'gi-track-warning';
    warning.textContent = copy.loopbackWarning;
    card.append(warning);
  }
  card.append(footer, arrow);

  const onKey = (event: KeyboardEvent) => {
    if (event.key !== 'Escape') return;
    event.stopPropagation();
    closeCard();
    anchor.focus();
  };
  card.addEventListener('keydown', onKey);
  return card;
}

function readTrackerBase(anchor: HTMLElement): string {
  return anchor.ownerDocument.documentElement.getAttribute('data-gi-tracker-base') || '';
}

export function setTrackerBaseAttribute(url: string): void {
  document.documentElement.setAttribute('data-gi-tracker-base', url);
}

function placeCard(card: HTMLElement, anchor: HTMLElement): void {
  const rect = anchor.getBoundingClientRect();
  const width = 340;
  const margin = 8;
  card.style.width = `${width}px`;
  const height = card.offsetHeight || 180;
  let top = rect.top - height - 12;
  let placement: 'above' | 'below' = 'above';
  if (top < margin) {
    top = rect.bottom + 12;
    placement = 'below';
  }
  let left = rect.left + rect.width / 2 - width / 2;
  left = Math.max(margin, Math.min(left, window.innerWidth - width - margin));
  card.style.top = `${Math.max(margin, top)}px`;
  card.style.left = `${left}px`;
  card.dataset.placement = placement;
  const arrow = card.querySelector<HTMLElement>('.gi-track-arrow');
  if (arrow) {
    const anchorCenter = rect.left + rect.width / 2;
    arrow.style.left = `${Math.max(18, Math.min(width - 18, anchorCenter - left))}px`;
  }
}

function refreshOpenCard(emails: TrackedEmailSummary[], trackerBaseUrl: string): void {
  if (!openCard?.isConnected || !openTrackingId) return;
  const email = emails.find((item) => item.trackingId === openTrackingId);
  if (!email) return;
  const copy = describeTrackingStatus(email, {
    trackerBaseUrl: openCard.querySelector<HTMLElement>('.gi-track-btn')?.dataset.trackerBase || trackerBaseUrl,
  });
  const headline = openCard.querySelector('.gi-track-headline');
  if (headline) {
    headline.replaceChildren();
    if (copy.emphasis) {
      const strong = document.createElement('strong');
      strong.textContent = copy.emphasis;
      headline.append(strong, document.createTextNode(copy.rest));
    } else {
      headline.textContent = copy.headline;
    }
  }
  const detail = openCard.querySelector('.gi-track-detail span');
  if (detail) detail.textContent = copy.detail;
  const count = openCard.querySelector('.gi-track-count');
  if (count) {
    count.textContent = copy.countLabel;
    count.className = copy.opened ? 'gi-track-count is-open' : 'gi-track-count';
  }
}

function closeCard(): void {
  openCard?.remove();
  openBackdrop?.remove();
  openCard = null;
  openBackdrop = null;
  openTrackingId = null;
}

function ensureStyles(): void {
  ensureSurface();
}

const CHECK_ICON = `<svg viewBox="0 0 16 16" width="16" height="16" fill="none" aria-hidden="true"><path d="M3.1 8.3 6.3 11.5 12.9 4.4" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"/></svg>`;
const EYE_ICON = `<svg viewBox="0 0 20 20" width="16" height="16" fill="none" aria-hidden="true"><path d="M1.8 10S4.8 4.8 10 4.8 18.2 10 18.2 10 15.2 15.2 10 15.2 1.8 10 1.8 10Z" stroke="currentColor" stroke-width="1.4"/><circle cx="10" cy="10" r="2.2" stroke="currentColor" stroke-width="1.4"/></svg>`;
