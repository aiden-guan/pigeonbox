/** Mailbox perspective is data, shared by Gmail orchestration and every AI provider. */
export type MailboxIdentity = { email: string; name?: string; aliases?: string[] };
export type AuthorRole = 'owner' | 'other';
export type ContactLike = { email?: string; name?: string } | undefined;
export type OwnerMatcher = (contact: ContactLike | string) => boolean;

export function isPlaceholderAddress(email: string | undefined): boolean {
  const value = (email || '').trim().toLowerCase();
  return !value || value === 'unknown' || value.endsWith('@local');
}

export function contactFromSender(sender: string): { email: string; name?: string } {
  const value = sender.trim();
  const named = value.match(/^"?([^"<]*?)"?\s*<([^>]+)>$/);
  if (named) return { email: named[2]!.trim().toLowerCase(), name: named[1]!.trim() || undefined };
  return value.includes('@') ? { email: value.toLowerCase() } : { email: '', name: value || undefined };
}

/** Gmail's own dot/plus aliases are equivalent; custom-domain addresses are not guessed. */
export function normalizeOwnerAddress(value: string): string {
  const email = value.trim().toLowerCase();
  const parts = email.split('@');
  return parts.length === 2 && /^(gmail|googlemail)\.com$/.test(parts[1]!)
    ? `${parts[0]!.split('+')[0]!.replace(/\./g, '')}@gmail.com`
    : email;
}

export function createOwnerMatcher(input: { owner: MailboxIdentity | null; aliases?: Iterable<string>; contacts?: Iterable<ContactLike> }): OwnerMatcher {
  const addresses = new Set<string>();
  const add = (value: string | undefined) => {
    const email = value?.match(/[\w.+%-]+@[\w-]+(?:\.[\w-]+)+/)?.[0];
    if (email && !isPlaceholderAddress(email)) addresses.add(normalizeOwnerAddress(email));
  };
  add(input.owner?.email);
  for (const alias of [...(input.owner?.aliases ?? []), ...(input.aliases ?? [])]) add(alias);
  // Only Gmail's explicit self label teaches an address. A same-name contact is not an alias.
  const selfLabel = (name: string | undefined) => /^\s*(?:me|you)\s*$/i.test(name || '');
  for (const contact of input.contacts ?? []) if (selfLabel(contact?.name)) add(contact?.email);
  const ownerTokens = nameTokens(input.owner?.name);
  return (value) => {
    const contact = typeof value === 'string' ? contactFromSender(value) : value;
    if (!contact) return false;
    if (selfLabel(contact.name)) return true;
    if (contact.email && !isPlaceholderAddress(contact.email)) return addresses.has(normalizeOwnerAddress(contact.email));
    const tokens = nameTokens(contact.name);
    return ownerTokens.length >= 2 && ownerTokens.every((token) => tokens.includes(token));
  };
}

function nameTokens(value: string | undefined): string[] {
  return (value || '').toLowerCase().replace(/<[^>]*>|\([^)]*\)/g, ' ').split(/[^\p{L}\p{N}]+/u).filter((token) => token.length > 1);
}

/** Never combine other signed-in Gmail accounts with this owner's aliases. */
export function ownerPerspectiveKey(owner?: MailboxIdentity): string {
  if (!owner?.email || isPlaceholderAddress(owner.email)) return 'perspective-v1:unresolved';
  return `perspective-v1:${JSON.stringify({
    email: normalizeOwnerAddress(owner.email), name: (owner.name || '').trim().toLowerCase(),
    aliases: [...new Set((owner.aliases ?? []).map(normalizeOwnerAddress))].sort(),
  })}`;
}

export function tagAuthors<T extends { sender: string; authorRole?: AuthorRole }>(messages: T[], owner?: MailboxIdentity): Array<T & { authorRole: AuthorRole }> {
  const isOwner = createOwnerMatcher({ owner: owner ?? null, contacts: messages.map((message) => contactFromSender(message.sender)) });
  return messages.map((message) => ({ ...message, authorRole: owner?.email ? (isOwner(message.sender) ? 'owner' : 'other') : message.authorRole ?? 'other' }));
}

/** Reject actor attribution, not mentions. Ambiguous first names and quotes stay intact. */
export function summaryPerspectiveIssue(summary: { oneLine?: string; keyPoints?: string[]; commitments?: string[]; actionItems?: string[] }, input: {
  owner?: MailboxIdentity; messages: Array<{ sender: string; authorRole?: AuthorRole; bodyText?: string }>;
}): boolean {
  if (!input.owner?.email) return false;
  const tagged = tagAuthors(input.messages, input.owner);
  if (!tagged.some((message) => message.authorRole === 'owner')) return false;
  const names = new Set<string>([input.owner.email, input.owner.name || '']);
  for (const message of tagged) if (message.authorRole === 'owner') names.add(contactFromSender(message.sender).name || '');
  const firstNames = [...names].filter((name) => !name.includes('@')).map((name) => name.trim().split(/\s+/)[0]);
  const others = tagged.filter((message) => message.authorRole === 'other').map((message) => contactFromSender(message.sender).name || '');
  for (const first of firstNames) if (first && first.length > 1 && !others.some((name) => name.split(/\s+/)[0]?.toLowerCase() === first.toLowerCase())) names.add(first);
  const actor = '(?:sent|wrote|asked|replied|confirmed|shared|forwarded|offered|promised|committed|requested|agreed|needs?|will|has|had|is|was|did|can|could|should|must|followed|provided|completed|scheduled|suggested|accepted|declined)\\b';
  const patterns = [...names].filter((name) => Boolean(name) && !others.some((other) => other.trim().toLowerCase() === name.trim().toLowerCase())).map((name) => new RegExp(`(?:^|[.!?;]\\s+|^[-•]\\s*)${escapeRegex(name.trim())}(?:\\s+|:\\s*)${actor}`, 'i'));
  const lines = [summary.oneLine || '', ...(summary.keyPoints ?? []), ...(summary.commitments ?? []), ...(summary.actionItems ?? [])];
  return lines.some((line) => patterns.some((pattern) => pattern.test(line)));
}

function escapeRegex(value: string): string { return value.replace(/[.*+?^${}()|[\]\\]/g, '\\$&'); }
