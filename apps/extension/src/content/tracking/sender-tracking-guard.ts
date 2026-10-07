import { findMain, findMessageBodies } from '@pigeonbox/gmail';
import { extractTrackingIdFromCandidateUrl, type TrackerBase } from '@pigeonbox/tracking';

const EMPTY_PIXEL = 'data:image/gif;base64,R0lGODlhAQABAIAAAAAAAP///yH5BAEAAAAALAAAAAABAAEAAAIBRAA7';

/** Only configured trackers, including Gmail's outbound-link wrapper. */
export function senderClickUrl(raw: string, bases: TrackerBase | null | undefined): { origin: string; clickId: string } | null {
  const origins = (typeof bases === 'string' ? [bases] : bases || []).flatMap((base) => {
    try { return [new URL(base).origin]; } catch { return []; }
  });
  if (!origins.length) return null;
  try {
    let url = new URL(raw);
    if (url.hostname === 'www.google.com' && url.pathname === '/url') {
      url = new URL(url.searchParams.get('q') || url.searchParams.get('url') || '');
    }
    const match = url.pathname.match(/^\/c\/(clk_[A-Za-z0-9_-]+)\/?$/);
    return match && origins.includes(url.origin) ? { origin: url.origin, clickId: match[1]! } : null;
  } catch { return null; }
}

function safeDestination(raw: string | null): string | null {
  try {
    const url = new URL(raw || '');
    return ['https:', 'http:'].includes(url.protocol) && !url.username && !url.password ? url.href : null;
  } catch { return null; }
}

/**
 * Protect the sender's displayed copy for its entire lifetime. The outbound
 * message is untouched: compose editors are excluded and ownership is checked.
 * Keep pixel identity available to the existing initial-render reconciliation.
 */
export function installSenderTrackingGuard(opts: {
  getTrackerBases: () => TrackerBase | null | undefined;
  getOwnedTrackingIds: () => ReadonlySet<string>;
  resolveLink: (origin: string, clickId: string) => Promise<string | null>;
  onPixelRender: (trackingId: string, quoted: boolean) => void;
}, doc = document) {
  let stopped = false;
  const requests = new Map<string, Promise<string | null>>();
  const protectedLinks = new WeakMap<HTMLAnchorElement, { href: string; destination: Promise<string | null>; resolved?: string }>();

  const refresh = () => {
    if (stopped) return;
    const bases = opts.getTrackerBases();
    if (!bases || (Array.isArray(bases) && !bases.length)) return;
    const owned = opts.getOwnedTrackingIds();
    const main = findMain(doc);
    // Image-only mail is still a rendered message even when the text parser skips it.
    const bodies = main ? new Set([...findMessageBodies(main), ...main.querySelectorAll<HTMLElement>('.a3s')]) : [];
    for (const body of bodies) {
      if (body.closest('[contenteditable="true"], [role="dialog"], [data-gi-ui]')) continue;
      for (const image of body.querySelectorAll<HTMLImageElement>('img[src], img[data-src]')) {
        if (image.closest('[contenteditable="true"], [role="dialog"], [data-gi-ui]')) continue;
        let id: string | null = null;
        for (const attr of ['src', 'data-src']) {
          const raw = image.getAttribute(attr);
          const candidate = raw ? extractTrackingIdFromCandidateUrl(raw, bases) : null;
          if (!candidate || !owned.has(candidate)) continue;
          image.setAttribute('data-pb-self-pixel-src', raw!);
          if (attr === 'src') image.setAttribute('src', EMPTY_PIXEL);
          else image.removeAttribute(attr);
          // Prevent an alternate responsive source from restoring this same pixel.
          image.removeAttribute('srcset');
          id = candidate;
        }
        if (id) opts.onPixelRender(id, Boolean(image.closest('blockquote, .gmail_quote, .gmail_extra')));
      }
      for (const anchor of body.querySelectorAll<HTMLAnchorElement>('a[href]')) {
        if (anchor.closest('[contenteditable="true"], [role="dialog"], [data-gi-ui]')) continue;
        const href = anchor.getAttribute('href') || '';
        const previous = protectedLinks.get(anchor);
        if (previous?.resolved === href && senderClickUrl(anchor.getAttribute('data-saferedirecturl') || '', bases)) {
          anchor.removeAttribute('data-saferedirecturl');
        }
        const link = senderClickUrl(href, bases);
        if (!link || protectedLinks.get(anchor)?.href === href) continue;
        const key = `${link.origin}/c/${link.clickId}`;
        let destination = requests.get(key);
        if (!destination) {
          destination = opts.resolveLink(link.origin, link.clickId).then(safeDestination).catch(() => null);
          requests.set(key, destination);
          // Failed lookup can be retried on a later Gmail mutation/cache refresh.
          void destination.then((value) => { if (!value) requests.delete(key); });
        }
        const entry: { href: string; destination: Promise<string | null>; resolved?: string } = { href, destination };
        protectedLinks.set(anchor, entry);
        void destination.then((url) => {
          if (stopped || !url || !anchor.isConnected || anchor.getAttribute('href') !== href) return;
          entry.resolved = url;
          anchor.setAttribute('href', url);
          anchor.removeAttribute('data-saferedirecturl');
        });
      }
    }
  };

  // Resolve proactively for native context-menu/keyboard/modified clicks. If
  // clicked before lookup finishes, preserve the user's tab choice and wait.
  const onClick = (event: MouseEvent) => {
    if (event.type === 'auxclick' && event.button !== 1) return;
    const anchor = (event.target instanceof Element ? event.target : null)?.closest<HTMLAnchorElement>('a[href]');
    const entry = anchor && protectedLinks.get(anchor);
    if (!anchor || !entry || anchor.getAttribute('href') !== entry.href || event.defaultPrevented) return;
    event.preventDefault();
    event.stopImmediatePropagation();
    const newTab = event.button === 1 || event.ctrlKey || event.metaKey || event.shiftKey || anchor.target === '_blank';
    const target = newTab ? window.open('about:blank', '_blank') : null;
    if (target) target.opener = null;
    void entry.destination.then((destination) => {
      // An unowned link (404) keeps normal behavior; credentials are never sent
      // to the link origin. The background uses the configured management API.
      const url = destination || entry.href;
      if (target) target.location.replace(url);
      else if (!newTab) window.location.assign(url);
    });
  };
  const observer = new MutationObserver((mutations) => {
    if (mutations.some((mutation) => !(mutation.target instanceof Element ? mutation.target : mutation.target.parentElement)?.closest('[data-gi-ui], .gi-track-slot, .gi-cat-chip'))) refresh();
  });
  observer.observe(doc.body, { childList: true, subtree: true, attributes: true, attributeFilter: ['src', 'data-src', 'srcset', 'href', 'data-saferedirecturl'] });
  doc.addEventListener('click', onClick, true);
  doc.addEventListener('auxclick', onClick, true);
  refresh();
  return {
    refresh,
    destroy: () => { stopped = true; observer.disconnect(); doc.removeEventListener('click', onClick, true); doc.removeEventListener('auxclick', onClick, true); requests.clear(); },
  };
}
