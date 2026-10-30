/**
 * Outbound fetches to URLs that are not fixed service endpoints (web research
 * results, developer webhooks) go through here: HTTPS only, no credentials in
 * URLs, no IP literals in private or reserved ranges, no internal host names,
 * no redirects, a timeout and a response size cap.
 */

export class UnsafeUrlError extends Error {
  constructor(readonly reason: string) {
    super(`unsafe_url:${reason}`);
    this.name = 'UnsafeUrlError';
  }
}

function privateIpv4(host: string): boolean {
  const parts = host.split('.').map(Number);
  if (parts.length !== 4 || parts.some((part) => !Number.isInteger(part) || part < 0 || part > 255)) return false;
  const [a, b] = parts as [number, number, number, number];
  return (
    a === 0 ||
    a === 10 ||
    a === 127 ||
    (a === 100 && b >= 64 && b <= 127) ||
    (a === 169 && b === 254) ||
    (a === 172 && b >= 16 && b <= 31) ||
    (a === 192 && b === 168) ||
    (a === 192 && b === 0) ||
    (a === 198 && (b === 18 || b === 19)) ||
    a >= 224
  );
}

export function assertSafeUrl(value: string): URL {
  let url: URL;
  try {
    url = new URL(value);
  } catch {
    throw new UnsafeUrlError('invalid');
  }
  if (url.protocol !== 'https:') throw new UnsafeUrlError('not_https');
  if (url.username || url.password) throw new UnsafeUrlError('credentials');
  if (url.port && url.port !== '443') throw new UnsafeUrlError('port');
  const host = url.hostname.toLowerCase().replace(/\.$/, '');
  if (!host.includes('.') || /(^|\.)(localhost|local|internal|intranet|lan|home|corp|localdomain)$/.test(host)) throw new UnsafeUrlError('internal_host');
  if (host.startsWith('[') || host.includes(':')) throw new UnsafeUrlError('ip_literal');
  if (/^\d+(\.\d+){3}$/.test(host) && privateIpv4(host)) throw new UnsafeUrlError('private_ip');
  if (/^\d+$/.test(host) || /^0x/i.test(host)) throw new UnsafeUrlError('ip_literal');
  if (host === 'metadata.google.internal' || host.endsWith('.metadata')) throw new UnsafeUrlError('metadata');
  return url;
}

export async function safeFetch(fetchImpl: typeof fetch, value: string, init: RequestInit & { maxBytes?: number; timeoutMs?: number } = {}): Promise<{ status: number; text: string; headers: Headers }> {
  const url = assertSafeUrl(value);
  const response = await fetchImpl(url.toString(), { ...init, redirect: 'manual', signal: AbortSignal.timeout(init.timeoutMs ?? 8_000) });
  if (response.status >= 300 && response.status < 400) throw new UnsafeUrlError('redirect');
  const max = init.maxBytes ?? 500_000;
  const reader = response.body?.getReader();
  let received = 0;
  const parts: Uint8Array[] = [];
  if (reader) {
    for (;;) {
      const { done, value: chunk } = await reader.read();
      if (done) break;
      received += chunk.byteLength;
      if (received > max) {
        await reader.cancel();
        throw new UnsafeUrlError('too_large');
      }
      parts.push(chunk);
    }
  }
  const bytes = new Uint8Array(received);
  let offset = 0;
  for (const part of parts) {
    bytes.set(part, offset);
    offset += part.byteLength;
  }
  return { status: response.status, text: new TextDecoder().decode(bytes), headers: response.headers };
}

export type WebResult = { title: string; url: string; snippet: string };

/** Web search for explicitly enabled research. Returns titles, URLs and snippets only; pages are not fetched. */
export async function webSearch(fetchImpl: typeof fetch, config: { provider: 'brave'; apiKey: string }, query: string, count = 5): Promise<WebResult[]> {
  const url = `https://api.search.brave.com/res/v1/web/search?q=${encodeURIComponent(query.slice(0, 300))}&count=${Math.min(10, count)}&safesearch=moderate`;
  const response = await safeFetch(fetchImpl, url, { headers: { Accept: 'application/json', 'X-Subscription-Token': config.apiKey }, maxBytes: 1_000_000 });
  if (response.status !== 200) return [];
  const data = JSON.parse(response.text) as { web?: { results?: Array<{ title?: string; url?: string; description?: string }> } };
  return (data.web?.results ?? [])
    .filter((result) => result.url && result.title)
    .flatMap((result) => {
      try {
        assertSafeUrl(result.url!);
        return [{ title: result.title!.replace(/<[^>]+>/g, '').slice(0, 300), url: result.url!.slice(0, 2_000), snippet: (result.description ?? '').replace(/<[^>]+>/g, '').slice(0, 500) }];
      } catch {
        return [];
      }
    })
    .slice(0, count);
}

export type WebPage = { url: string; title: string; text: string };

const ENTITIES: Record<string, string> = { amp: '&', lt: '<', gt: '>', quot: '"', apos: "'", nbsp: ' ', '#39': "'" };

function decodeHtmlEntities(value: string): string {
  return value.replace(/&(#x[0-9a-f]+|#\d+|[a-z]+\d*);/gi, (entity, name: string) => {
    if (name[0] === '#') {
      const code = name[1]?.toLowerCase() === 'x' ? parseInt(name.slice(2), 16) : Number(name.slice(1));
      return Number.isFinite(code) && code > 0 && code < 0x110000 ? String.fromCodePoint(code) : ' ';
    }
    return ENTITIES[name.toLowerCase()] ?? entity;
  });
}

/** Cloudflare's "email protection" hides addresses as hex XOR'd with the first byte. */
export function decodeCfEmail(hex: string): string {
  if (!/^(?:[0-9a-f]{2}){2,}$/i.test(hex)) return '';
  const key = parseInt(hex.slice(0, 2), 16);
  let out = '';
  for (let index = 2; index < hex.length; index += 2) out += String.fromCharCode(parseInt(hex.slice(index, index + 2), 16) ^ key);
  return out;
}

/**
 * Readable text of an HTML page: scripts, styles and markup removed, links
 * kept as "text (url)" when the URL adds something (mailto addresses do),
 * Cloudflare-obfuscated addresses decoded, block elements on their own lines.
 */
export function htmlToText(html: string, base?: string): { title: string; text: string } {
  const title = decodeHtmlEntities((html.match(/<title[^>]*>([\s\S]*?)<\/title>/i)?.[1] ?? '').replace(/\s+/g, ' ').trim());
  let body = html
    .replace(/<!--[\s\S]*?-->/g, ' ')
    .replace(/<(script|style|noscript|svg|template|iframe|head|title)\b[\s\S]*?<\/\1>/gi, ' ')
    .replace(/<[^>]*\bdata-cfemail="([0-9a-f]+)"[^>]*>[\s\S]*?<\/[a-z]+>/gi, (_, hex: string) => ` ${decodeCfEmail(hex)} `)
    .replace(/href="\/cdn-cgi\/l\/email-protection#([0-9a-f]+)"/gi, (_, hex: string) => `href="mailto:${decodeCfEmail(hex)}"`);
  body = body.replace(/<a\b[^>]*\bhref\s*=\s*["']([^"']+)["'][^>]*>([\s\S]*?)<\/a>/gi, (_, href: string, inner: string) => {
    const label = inner.replace(/<[^>]+>/g, ' ').replace(/\s+/g, ' ').trim();
    const target = decodeHtmlEntities(href.trim());
    if (/^mailto:/i.test(target)) {
      const address = decodeURIComponent(target.slice(7).split('?')[0] ?? '');
      return label.toLowerCase().includes(address.toLowerCase()) ? ` ${label} ` : ` ${label} (${address}) `;
    }
    if (!/^(https?:)?\/\//i.test(target) && !target.startsWith('/')) return ` ${label} `;
    let absolute = target;
    try {
      absolute = new URL(target, base).toString();
    } catch {
      return ` ${label} `;
    }
    return label && label.length < 120 && !label.includes(absolute) ? ` ${label} (${absolute}) ` : ` ${label} `;
  });
  const text = decodeHtmlEntities(
    body
      .replace(/<(br|hr)\b[^>]*>/gi, '\n')
      .replace(/<\/?(p|div|section|article|header|footer|li|ul|ol|tr|table|h[1-6]|dt|dd|dl|blockquote|pre|main|nav|aside|form|figure)\b[^>]*>/gi, '\n')
      .replace(/<(td|th)\b[^>]*>/gi, ' | ')
      .replace(/<[^>]+>/g, ' '),
  )
    .replace(/[ \t\u00a0]+/g, ' ')
    .replace(/ *\n */g, '\n')
    .replace(/\n{3,}/g, '\n\n')
    .trim();
  return { title, text };
}

/**
 * Fetch a public page and return its readable text. Follows up to three
 * redirects, checking every hop. Only HTML and plain text are read.
 */
export async function fetchPage(fetchImpl: typeof fetch, value: string, options: { timeoutMs?: number; maxBytes?: number } = {}): Promise<WebPage> {
  let current = value;
  for (let hop = 0; hop < 4; hop += 1) {
    const url = assertSafeUrl(current);
    const response = await fetchImpl(url.toString(), {
      redirect: 'manual',
      signal: AbortSignal.timeout(options.timeoutMs ?? 8_000),
      headers: { Accept: 'text/html,application/xhtml+xml,text/plain;q=0.9', 'User-Agent': 'Mozilla/5.0 (compatible; PigeonBox/1.0; +https://github.com/aiden-guan/pigeonbox)' },
    });
    if (response.status >= 300 && response.status < 400) {
      const location = response.headers.get('location');
      await response.body?.cancel();
      if (!location) throw new UnsafeUrlError('redirect');
      current = new URL(location, url).toString();
      continue;
    }
    const type = (response.headers.get('content-type') ?? '').toLowerCase();
    if (response.status !== 200) {
      await response.body?.cancel();
      throw new UnsafeUrlError(`status_${response.status}`);
    }
    if (type && !/text\/html|application\/xhtml|text\/plain/.test(type)) {
      await response.body?.cancel();
      throw new UnsafeUrlError('not_a_page');
    }
    const max = options.maxBytes ?? 1_500_000;
    const reader = response.body?.getReader();
    const parts: Uint8Array[] = [];
    let received = 0;
    if (reader) {
      for (;;) {
        const { done, value: chunk } = await reader.read();
        if (done) break;
        const bounded = chunk.subarray(0, max - received);
        received += bounded.byteLength;
        parts.push(bounded);
        // Long pages are cut, not refused: the start usually has what matters.
        if (received >= max) {
          await reader.cancel();
          break;
        }
      }
    }
    const bytes = new Uint8Array(received);
    let offset = 0;
    for (const part of parts) {
      bytes.set(part.subarray(0, Math.min(part.byteLength, received - offset)), offset);
      offset += part.byteLength;
    }
    const raw = new TextDecoder().decode(bytes);
    if (type.includes('text/plain')) return { url: url.toString(), title: '', text: raw.replace(/\s+\n/g, '\n').trim() };
    return { url: url.toString(), ...htmlToText(raw, url.toString()) };
  }
  throw new UnsafeUrlError('too_many_redirects');
}
