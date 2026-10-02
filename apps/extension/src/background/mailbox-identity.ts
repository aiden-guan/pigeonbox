import { isPlaceholderAddress, normalizeOwnerAddress, ownerPerspectiveKey, type ContactLike, type MailboxIdentity } from '@pigeonbox/shared';

export function withSelfAliases(owner: MailboxIdentity, contacts: ContactLike[]): MailboxIdentity {
  const learned = contacts.filter((contact) => /^\s*(?:me|you)\s*$/i.test(contact?.name || '') && !isPlaceholderAddress(contact?.email)).map((contact) => contact!.email!);
  return learned.length ? { ...owner, aliases: [...new Set([...(owner.aliases || []), ...learned])] } : owner;
}

function mergeIdentity(owner: MailboxIdentity, previous?: MailboxIdentity): MailboxIdentity {
  if (!previous || normalizeOwnerAddress(previous.email) !== normalizeOwnerAddress(owner.email)) return owner;
  const aliases = [...new Set([...(previous.aliases || []), ...(owner.aliases || [])])];
  return { ...owner, ...(owner.name || !previous.name ? {} : { name: previous.name }), ...(aliases.length ? { aliases } : {}) };
}

/** Legacy or differently scoped inference is never a visible summary. */
export function visibleSummaryForOwner<T extends { ownerPerspective?: string }>(summary: T | undefined, owner?: MailboxIdentity): T | undefined {
  return owner && summary?.ownerPerspective === ownerPerspectiveKey(owner) ? summary : undefined;
}

/** Gmail account slots are scoped to a URL, never to the most recently active tab. */
export function gmailAccountKey(url: string | undefined): string | null {
  try {
    const parsed = new URL(url || '');
    if (parsed.origin !== 'https://mail.google.com') return null;
    return parsed.searchParams.get('authuser')?.toLowerCase() || parsed.pathname.match(/\/u\/(\d+)/)?.[1] || '0';
  } catch { return null; }
}

export class MailboxIdentities {
  private writes: Promise<unknown> = Promise.resolve();
  private tabs = new Map<number, { key: string; owner: MailboxIdentity }>();
  constructor(private readonly storage: Pick<chrome.storage.StorageArea, 'get' | 'set'>) {}

  async remember(tabId: number, url: string, owner: MailboxIdentity): Promise<MailboxIdentity | undefined> {
    const key = gmailAccountKey(url);
    if (key === null) return;
    const write = this.writes.then(async () => {
      const stored = await this.storage.get('mailboxIdentities');
      const resolved = mergeIdentity(owner, stored.mailboxIdentities?.[key]);
      this.tabs.set(tabId, { key, owner: resolved });
      await this.storage.set({ mailboxIdentities: { ...(stored.mailboxIdentities || {}), [key]: resolved } });
      return resolved;
    });
    this.writes = write.catch(() => undefined);
    return write;
  }

  async resolve(tabId?: number, url?: string, explicit?: MailboxIdentity): Promise<MailboxIdentity | undefined> {
    if (explicit) {
      if (tabId != null && gmailAccountKey(url) !== null) return await this.remember(tabId, url!, explicit) || explicit;
      return mergeIdentity(explicit, await this.forEmail(explicit.email));
    }
    const key = gmailAccountKey(url);
    if (key === null) return undefined;
    const current = tabId == null ? null : this.tabs.get(tabId);
    if (current?.key === key) return current.owner;
    const stored = await this.storage.get('mailboxIdentities');
    return stored.mailboxIdentities?.[key];
  }

  async forEmail(email: string): Promise<MailboxIdentity | undefined> {
    const stored = await this.storage.get('mailboxIdentities');
    return Object.values(stored.mailboxIdentities || {}).find((owner) => (owner as MailboxIdentity).email.toLowerCase() === email.toLowerCase()) as MailboxIdentity | undefined;
  }
  forgetTab(tabId: number): void { this.tabs.delete(tabId); }
  perspective(owner?: MailboxIdentity): string { return ownerPerspectiveKey(owner); }
}
