import { stripHtml } from '@pigeonbox/shared';

/**
 * Minimal MIME handling for Gmail API payloads: headers, address lists,
 * text extraction for just-in-time AI input, and RFC 2822 message building
 * for drafts. Extracted text is used for one operation and then discarded.
 */

export type GmailHeader = { name: string; value: string };
export type GmailPart = {
  partId?: string;
  mimeType?: string;
  filename?: string;
  headers?: GmailHeader[];
  body?: { size?: number; data?: string; attachmentId?: string };
  parts?: GmailPart[];
};

export type Address = { email: string; name?: string };

export function headerValue(headers: GmailHeader[] | undefined, name: string): string | null {
  const wanted = name.toLowerCase();
  for (const header of headers ?? []) if (header.name.toLowerCase() === wanted) return header.value;
  return null;
}

const EMAIL = /[^\s<>"',;]+@[^\s<>"',;]+/;

/** Parse `Name <a@b>, "Last, First" <c@d>, e@f` into addresses. */
export function parseAddressList(value: string | null | undefined): Address[] {
  if (!value) return [];
  const out: Address[] = [];
  let current = '';
  let quoted = false;
  let angle = 0;
  const flush = () => {
    const part = current.trim();
    current = '';
    if (!part) return;
    const angleMatch = part.match(/^(.*)<([^>]+)>\s*$/);
    if (angleMatch) {
      const email = angleMatch[2]!.trim();
      if (!EMAIL.test(email)) return;
      const name = angleMatch[1]!.trim().replace(/^"|"$/g, '').replace(/\\"/g, '"').trim();
      out.push(name ? { email: email.toLowerCase(), name: decodeEncodedWords(name).slice(0, 200) } : { email: email.toLowerCase() });
      return;
    }
    const bare = part.match(EMAIL);
    if (bare) out.push({ email: bare[0].toLowerCase() });
  };
  for (const char of value) {
    if (char === '"') quoted = !quoted;
    if (!quoted && char === '<') angle += 1;
    if (!quoted && char === '>') angle = Math.max(0, angle - 1);
    if (char === ',' && !quoted && angle === 0) flush();
    else current += char;
  }
  flush();
  return out;
}

export function base64UrlToBytes(data: string): Uint8Array<ArrayBuffer> {
  const normalized = data.replace(/-/g, '+').replace(/_/g, '/');
  const padded = normalized + '='.repeat((4 - (normalized.length % 4)) % 4);
  const binary = atob(padded);
  const bytes = new Uint8Array(binary.length);
  for (let i = 0; i < binary.length; i += 1) bytes[i] = binary.charCodeAt(i);
  return bytes;
}

export function bytesToBase64Url(bytes: Uint8Array): string {
  let binary = '';
  for (const byte of bytes) binary += String.fromCharCode(byte);
  return btoa(binary).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
}

function decodeData(data: string | undefined): string {
  if (!data) return '';
  try {
    return new TextDecoder().decode(base64UrlToBytes(data));
  } catch {
    return '';
  }
}

/** RFC 2047 `=?utf-8?B?...?=` / `=?utf-8?Q?...?=` in display names and subjects. */
export function decodeEncodedWords(value: string): string {
  return value.replace(/=\?([^?]+)\?([bBqQ])\?([^?]*)\?=/g, (_match, _charset: string, encoding: string, text: string) => {
    try {
      if (encoding.toUpperCase() === 'B') return new TextDecoder().decode(Uint8Array.from(atob(text), (c) => c.charCodeAt(0)));
      const bytes = text.replace(/_/g, ' ').replace(/=([0-9A-F]{2})/gi, (_m, hex: string) => String.fromCharCode(parseInt(hex, 16)));
      return new TextDecoder().decode(Uint8Array.from(bytes, (c) => c.charCodeAt(0)));
    } catch {
      return text;
    }
  });
}

/** The readable text of a message: text/plain when present, else text/html converted. */
export function messageText(payload: GmailPart | undefined): string {
  if (!payload) return '';
  const plain: string[] = [];
  const html: string[] = [];
  const walk = (part: GmailPart) => {
    const type = (part.mimeType ?? '').toLowerCase();
    if (part.filename) return; // attachments are not read
    if (type === 'text/plain') plain.push(decodeData(part.body?.data));
    else if (type === 'text/html') html.push(decodeData(part.body?.data));
    for (const child of part.parts ?? []) walk(child);
  };
  walk(payload);
  const text = plain.join('\n').trim() || stripHtml(html.join('\n'));
  return text.replace(/\r\n/g, '\n').replace(/\n{3,}/g, '\n\n').trim();
}

/** Drop quoted history ("On … wrote:" and `>` lines) so each message is only its own words. */
export function stripQuotedReply(text: string): string {
  const lines = text.split('\n');
  const kept: string[] = [];
  for (let i = 0; i < lines.length; i += 1) {
    const line = lines[i]!;
    if (/^On .{4,200} wrote:\s*$/.test(line.trim()) || /^-{2,}\s*Original Message\s*-{2,}/i.test(line.trim())) break;
    if (/^From: .+/.test(line) && /^(Sent|Date): .+/.test(lines[i + 1] ?? '')) break;
    if (line.startsWith('>')) continue;
    kept.push(line);
  }
  return kept.join('\n').trim();
}

export function hasAttachment(payload: GmailPart | undefined): boolean {
  if (!payload) return false;
  if (payload.filename && (payload.body?.attachmentId || (payload.body?.size ?? 0) > 0)) return true;
  return (payload.parts ?? []).some(hasAttachment);
}

export function attachmentNames(payload: GmailPart | undefined): Array<{ filename: string; mimeType: string; size: number }> {
  const out: Array<{ filename: string; mimeType: string; size: number }> = [];
  const walk = (part: GmailPart) => {
    if (part.filename) out.push({ filename: part.filename.slice(0, 255), mimeType: part.mimeType ?? '', size: part.body?.size ?? 0 });
    for (const child of part.parts ?? []) walk(child);
  };
  if (payload) walk(payload);
  return out;
}

function needsEncoding(value: string): boolean {
  return /[^\x20-\x7e]/.test(value);
}

function encodeWord(value: string): string {
  if (!needsEncoding(value)) return value;
  let binary = '';
  for (const byte of new TextEncoder().encode(value)) binary += String.fromCharCode(byte);
  return `=?UTF-8?B?${btoa(binary)}?=`;
}

function formatAddress(address: Address): string {
  if (!address.name) return address.email;
  const name = needsEncoding(address.name) ? encodeWord(address.name) : `"${address.name.replace(/["\\]/g, '')}"`;
  return `${name} <${address.email}>`;
}

/** Refuse header injection through any field. */
function clean(value: string): string {
  return value.replace(/[\r\n]+/g, ' ').trim();
}

export type OutgoingMessage = {
  from?: Address;
  to: Address[];
  cc?: Address[];
  subject: string;
  body: string;
  inReplyTo?: string | null;
  references?: string | null;
  headers?: Record<string, string>;
  /** Optional HTML alternative (sent as multipart/alternative with the plain text). */
  html?: string;
};

function base64Body(text: string): string {
  let binary = '';
  for (const byte of new TextEncoder().encode(text.replace(/\r?\n/g, '\r\n'))) binary += String.fromCharCode(byte);
  return btoa(binary).replace(/(.{76})/g, '$1\r\n');
}

export function escapeHtml(value: string): string {
  return value.replace(/[&<>"']/g, (char) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[char]!);
}

/** An RFC 2822 message as base64url for Gmail's `raw` field. UTF-8 text/plain body. */
export function buildRawMessage(message: OutgoingMessage): string {
  const lines: string[] = [];
  if (message.from) lines.push(`From: ${clean(formatAddress(message.from))}`);
  if (message.to.length) lines.push(`To: ${clean(message.to.map(formatAddress).join(', '))}`);
  if (message.cc?.length) lines.push(`Cc: ${clean(message.cc.map(formatAddress).join(', '))}`);
  lines.push(`Subject: ${encodeWord(clean(message.subject))}`);
  if (message.inReplyTo) lines.push(`In-Reply-To: ${clean(message.inReplyTo)}`);
  if (message.references) lines.push(`References: ${clean(message.references)}`);
  for (const [name, value] of Object.entries(message.headers ?? {})) {
    if (/^[A-Za-z][A-Za-z0-9-]{1,60}$/.test(name)) lines.push(`${name}: ${clean(value)}`);
  }
  if (message.html) {
    const boundary = `pb_${crypto.randomUUID().replace(/-/g, '')}`;
    lines.push('MIME-Version: 1.0', `Content-Type: multipart/alternative; boundary="${boundary}"`, '');
    const parts = [
      `--${boundary}`,
      'Content-Type: text/plain; charset="UTF-8"',
      'Content-Transfer-Encoding: base64',
      '',
      base64Body(message.body),
      `--${boundary}`,
      'Content-Type: text/html; charset="UTF-8"',
      'Content-Transfer-Encoding: base64',
      '',
      base64Body(message.html),
      `--${boundary}--`,
      '',
    ];
    return bytesToBase64Url(new TextEncoder().encode(`${lines.join('\r\n')}\r\n${parts.join('\r\n')}`));
  }
  lines.push('MIME-Version: 1.0', 'Content-Type: text/plain; charset="UTF-8"', 'Content-Transfer-Encoding: base64', '');
  const raw = `${lines.join('\r\n')}\r\n${base64Body(message.body)}`;
  return bytesToBase64Url(new TextEncoder().encode(raw));
}

/** Decode a raw message built above (tests and draft edit detection). */
export function parseRawMessage(raw: string): { headers: Record<string, string>; body: string } {
  const text = new TextDecoder().decode(base64UrlToBytes(raw));
  const split = text.indexOf('\r\n\r\n');
  const head = split >= 0 ? text.slice(0, split) : text;
  const rest = split >= 0 ? text.slice(split + 4) : '';
  const headers: Record<string, string> = {};
  for (const line of head.split('\r\n')) {
    const colon = line.indexOf(':');
    if (colon > 0) headers[line.slice(0, colon).toLowerCase()] = line.slice(colon + 1).trim();
  }
  let body = rest;
  const boundary = (headers['content-type'] ?? '').match(/boundary="?([^";]+)"?/)?.[1];
  if (boundary) {
    // multipart/alternative: return the text/plain part.
    const part = rest.split(`--${boundary}`).find((chunk) => /content-type:\s*text\/plain/i.test(chunk)) ?? '';
    const split = part.indexOf('\r\n\r\n');
    const encoded = split >= 0 ? part.slice(split + 4) : '';
    try {
      return { headers, body: new TextDecoder().decode(Uint8Array.from(atob(encoded.replace(/\s+/g, '')), (c) => c.charCodeAt(0))).replace(/\r\n/g, '\n') };
    } catch {
      return { headers, body: '' };
    }
  }
  if (/base64/i.test(headers['content-transfer-encoding'] ?? '')) {
    try {
      body = new TextDecoder().decode(Uint8Array.from(atob(rest.replace(/\s+/g, '')), (c) => c.charCodeAt(0)));
    } catch {
      body = '';
    }
  }
  return { headers, body: body.replace(/\r\n/g, '\n') };
}

export function replySubject(subject: string): string {
  const trimmed = subject.trim();
  return /^re:/i.test(trimmed) ? trimmed : `Re: ${trimmed || '(no subject)'}`;
}
