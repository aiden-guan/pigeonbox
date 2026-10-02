import { ownerPerspectiveKey, type MailboxIdentity } from '@pigeonbox/shared';

const ADDRESS = /[\w.+%-]+@[\w-]+(?:\.[\w-]+)+/;
export function mailboxOwner(doc: Document = document): MailboxIdentity | undefined {
  const sdkEmail = doc.head?.getAttribute('data-inboxsdk-user-email-address');
  const label = doc.querySelector('a[href*="accounts.google.com"][aria-label*="@"]')?.getAttribute('aria-label') || '';
  const labelEmail = label.match(ADDRESS)?.[0];
  // Gmail puts the signed-in address at the end of its title, after the subject.
  const titleEmail = doc.title.match(/[\w.+%-]+@[\w-]+(?:\.[\w-]+)+/g)?.at(-1);
  const email = sdkEmail?.match(ADDRESS)?.[0] || labelEmail || titleEmail;
  if (!email) return undefined;
  const name = label.split('(')[0]?.replace(/^[^:]*:\s*/, '').trim();
  return { email: email.toLowerCase(), name: name && !name.includes('@') && labelEmail?.toLowerCase() === email.toLowerCase() ? name : undefined };
}

/** Discovery observes mutations, with no polling or repeated full-mail DOM scans. */
export function observeMailboxOwner(onChange: (owner: MailboxIdentity | undefined) => void): () => void {
  let previous = '';
  let accountObserver: MutationObserver | null = null;
  const check = () => {
    const owner = mailboxOwner();
    const key = ownerPerspectiveKey(owner);
    if (key !== previous) { previous = key; onChange(owner); }
    const account = document.querySelector('a[href*="accounts.google.com"][aria-label*="@"]');
    if (account && !accountObserver) {
      accountObserver = new MutationObserver(check);
      accountObserver.observe(account, { attributes: true, attributeFilter: ['aria-label', 'href'] });
    }
    if (owner) discovery.disconnect();
  };
  const discovery = new MutationObserver(check);
  const head = new MutationObserver(check);
  if (document.head) head.observe(document.head, { subtree: true, childList: true, characterData: true, attributes: true, attributeFilter: ['data-inboxsdk-user-email-address'] });
  if (document.body) discovery.observe(document.body, { childList: true, subtree: true, attributes: true, attributeFilter: ['aria-label'] });
  check();
  window.addEventListener('hashchange', check);
  return () => { head.disconnect(); discovery.disconnect(); accountObserver?.disconnect(); window.removeEventListener('hashchange', check); };
}
