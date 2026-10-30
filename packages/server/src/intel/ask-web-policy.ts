/**
 * The mailbox-reading model must not turn private evidence into network requests.
 * Search terms come from the person's messages, plus public search vocabulary;
 * fetched URLs must be exact user URLs or exact search results. Neither email
 * prose, earlier assistant output nor a model-created URL can grant access.
 */
const PUBLIC_SEARCH_WORDS = new Set(('a an the of for to in on at and or is who what where when how current latest official public website site homepage contact contacts email address directory profile biography company university college student professor faculty department uc news price prices hours opening').split(' '));

function words(value: string): string[] {
  return value.normalize('NFKC').toLowerCase().match(/[\p{L}\p{N}]+/gu) ?? [];
}

export class AskWebPolicy {
  private readonly terms: Set<string>;
  private readonly urls = new Set<string>();

  constructor(userMessages: string[]) {
    this.terms = new Set(userMessages.flatMap(words));
    for (const message of userMessages) {
      for (const match of message.matchAll(/https?:\/\/[^\s<>"`]+/gi)) this.addUrl(match[0].replace(/[),.;!?\]}]+$/, ''));
      // A bare domain the person typed ("acme.com/team"), never the domain of an email address.
      for (const match of message.matchAll(/(?<![@\w./-])(?:[a-z0-9-]+\.)+[a-z]{2,}(?:\/[^\s<>"`]*)?/gi)) this.addUrl(match[0].replace(/[),.;!?\]}]+$/, ''));
    }
  }

  allowsSearch(query: string): boolean {
    return this.searchQuery(query) !== null;
  }

  /** Return only canonical approved words; punctuation, invisible characters
   * and capitalization in the model's raw string must not carry data out.
   */
  searchQuery(query: string): string | null {
    const terms = words(query);
    return terms.length > 0 && terms.every((term) => this.terms.has(term) || PUBLIC_SEARCH_WORDS.has(term)) ? [...new Set(terms)].join(' ') : null;
  }

  addUrl(value: string): void {
    const url = canonicalUrl(value);
    if (url) this.urls.add(url);
  }

  allowsUrl(value: string): boolean {
    return this.pageUrl(value) !== null;
  }

  pageUrl(value: string): string | null {
    const url = canonicalUrl(value);
    return url && this.urls.has(url) ? url : null;
  }
}

/** Pages are always read over HTTPS, so a typed http:// link or bare domain means the same page. */
function canonicalUrl(value: string): string | null {
  try {
    const url = new URL(/^https?:\/\//i.test(value) ? value.replace(/^http:/i, 'https:') : `https://${value}`);
    if (url.protocol !== 'https:' || url.username || url.password) return null;
    url.hash = '';
    return url.href;
  } catch {
    return null;
  }
}
