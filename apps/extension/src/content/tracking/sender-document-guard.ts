/** Resolve ownership at click time: a cached preview would expire in long-lived Gmail tabs. */
function documentUrl(raw: string, apiBase: string | null): URL | null {
  try {
    if (!apiBase) return null;
    let url = new URL(raw);
    if (url.hostname === 'www.google.com' && url.pathname === '/url') url = new URL(url.searchParams.get('q') || url.searchParams.get('url') || '');
    if (url.hash && !/^#preview=[A-Za-z0-9_-]+$/.test(url.hash)) return null;
    return url.origin === new URL(apiBase).origin && /^\/d\/[A-Za-z0-9_-]{32}$/.test(url.pathname) && !url.username && !url.password && !url.search ? url : null;
  } catch { return null; }
}
export function senderDocumentUrl(raw: string, apiBase: string | null): string | null {
  const url = documentUrl(raw, apiBase);
  if (!url) return null;
  // Refresh proofs already cached by the email sender guard.
  url.hash = '';
  return url.href;
}
export function installSenderDocumentGuard(opts: { getApiBase: () => string | null; resolve: (url: string) => Promise<string | null> }, doc = document) {
  let stopped = false;
  const onClick = (event: MouseEvent) => {
    if (event.type === 'click' && event.button !== 0 || event.type === 'auxclick' && event.button !== 1) return;
    const anchor = event.target instanceof Element ? event.target.closest<HTMLAnchorElement>('a[href]') : null;
    if (!anchor?.closest('.a3s') || anchor.closest('[contenteditable="true"], [role="dialog"], [data-gi-ui]')) return;
    const url = senderDocumentUrl(anchor.href, opts.getApiBase());
    if (!url) return;
    const fallback = documentUrl(anchor.href, opts.getApiBase())?.href ?? url;
    event.preventDefault(); event.stopImmediatePropagation();
    const separate = event.button === 1 || event.ctrlKey || event.metaKey || event.shiftKey || anchor.target === '_blank';
    const tab = separate ? window.open('about:blank', '_blank') : null;
    if (tab) tab.opener = null;
    void opts.resolve(url).catch(() => null).then(preview => {
      if (stopped || !anchor.isConnected) { tab?.close(); return; }
      // Recipients still open the original link. Only an authenticated owner
      // receives a preview proof. Preserve a cached proof if refresh fails so
      // it cannot silently become recipient activity. Never edit a composer.
      const safe = preview && senderDocumentUrl(preview, opts.getApiBase()) === url && /#preview=[A-Za-z0-9_-]+$/.test(preview) ? preview : fallback;
      if (tab) tab.location.replace(safe); else window.location.assign(safe);
    });
  };
  doc.addEventListener('click', onClick, true); doc.addEventListener('auxclick', onClick, true);
  return { destroy: () => { stopped = true; doc.removeEventListener('click', onClick, true); doc.removeEventListener('auxclick', onClick, true); } };
}
