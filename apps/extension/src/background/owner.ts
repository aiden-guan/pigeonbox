/**
 * Who "you" are in the mailbox. The stored Gmail account address alone misses
 * a lot: another signed-in account, a school alias, rows where Gmail writes
 * "me" instead of an address, and Sent rows that show "To: Sam". Everything
 * that decides whose turn it is to reply goes through this.
 */

export type ContactLike = { email?: string; name?: string } | undefined;

export type OwnerMatcher = (contact: ContactLike | string) => boolean;

/** Addresses Gmail adapters write when they could not read the sender. */
export function isPlaceholderAddress(email: string | undefined): boolean {
  const value = (email || '').trim().toLowerCase();
  return !value || value === 'unknown' || value.endsWith('@local');
}

export function createOwnerMatcher(input: {
  owner: { email: string; name?: string } | null;
  /** Other addresses this install has seen signed in, and senders of tracked mail. */
  aliases?: Iterable<string>;
  /** Contacts to learn from: any one Gmail labels "me" is an owner address. */
  contacts?: Iterable<ContactLike>;
}): OwnerMatcher {
  const addresses = new Set<string>();
  const add = (value: string | undefined) => {
    const address = value?.match(/[\w.+-]+@[\w-]+(?:\.[\w-]+)+/)?.[0]?.toLowerCase();
    if (address && !isPlaceholderAddress(address)) addresses.add(address);
  };
  add(input.owner?.email);
  for (const alias of input.aliases ?? []) add(alias);

  // "Aiden Guan" matches "Aiden Haoyu Guan"; a single first name is too loose to trust.
  const ownerTokens = nameTokens(input.owner?.name);
  const namedLikeOwner = (name: string | undefined) => {
    if (ownerTokens.length < 2 || !name) return false;
    const tokens = nameTokens(name);
    return ownerTokens.every((token) => tokens.includes(token));
  };
  const selfLabel = (name: string | undefined) => /^\s*me\s*$/i.test(name || '');

  for (const contact of input.contacts ?? []) {
    if (contact && (selfLabel(contact.name) || namedLikeOwner(contact.name))) add(contact.email);
  }

  return (contact) => {
    if (typeof contact === 'string') return addresses.has(contact.trim().toLowerCase());
    if (!contact) return false;
    if (contact.email && addresses.has(contact.email.trim().toLowerCase())) return true;
    return selfLabel(contact.name) || namedLikeOwner(contact.name);
  };
}

function nameTokens(name: string | undefined): string[] {
  return (name || '')
    .toLowerCase()
    .replace(/<[^>]*>|\([^)]*\)/g, ' ')
    .split(/[^\p{L}\p{N}]+/u)
    .filter((token) => token.length > 1);
}
