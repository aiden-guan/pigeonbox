import type { Address } from '../google/mime.js';

/** Names must come from account settings or headers, never an email local part. */
export function signerName(voiceName: string | null | undefined, displayName: string | null | undefined): string {
  const saved = voiceName?.trim();
  if (saved && /\p{L}/u.test(saved) && !/[@\r\n[\]<>]/.test(saved)) return saved.slice(0, 80);
  const display = displayName?.trim() ?? '';
  if (/[@\r\n[\]<>]/.test(display)) return '';
  const untitled = display.replace(/(?:,?\s+)(?:Ph\.?D\.?|M\.?D\.?|MBA|Jr\.?|Sr\.?|II|III|IV)$/i, '').trim();
  const ordered = untitled.includes(',') ? untitled.split(',').slice(1).join(' ').trim() : untitled;
  const first = ordered.replace(/^(?:(?:dr|prof|professor|mr|ms|mrs)\.?\s+)+/i, '').split(/\s+/)[0] ?? '';
  return /\p{L}/u.test(first) ? first.slice(0, 80) : '';
}

const CLOSING_WORDS = 'best(?: regards| wishes)?|thanks(?: so much| again)?|thank you(?: so much)?|cheers|regards|kind regards|warm regards|warmly|sincerely|talk soon|thx|many thanks|all the best|speak soon|take care|appreciate it|yours truly';
const CLOSING = new RegExp(`^(${CLOSING_WORDS})\\s*[,!.]?\\s*$`, 'i');
const INLINE_CLOSING = new RegExp(`^(${CLOSING_WORDS}),\\s+([^\\n]{1,160})$`, 'i');
const FLAT_SIGNATURE = new RegExp(`(?<=[.!?])\\s+(${CLOSING_WORDS})\\s*[,!.]?\\s+([^\\n]{1,80})$`, 'i');

function signatureName(value: string): boolean {
  if (/^\[[^\]\n]{1,80}\]$/.test(value)) return true;
  const words = value.split(/\s+/);
  return words.length <= 6 && /^[\p{L}\p{M}.'’\- ]{1,80}$/u.test(value)
    && words.every((word) => /^\p{Lu}|^[\p{Script=Han}\p{Script=Hiragana}\p{Script=Katakana}\p{Script=Hangul}]/u.test(word)
      || /^(?:de|del|da|van|von|der|bin|al)$/i.test(word) || words.length === 1);
}

/** Replace a model's signature, including invented signers, with the owner's identity. */
export function ensureSignature(body: string, name: string, signoff?: string | null): string {
  let trimmed = body.trimEnd().replace(/\r\n/g, '\n');
  const flat = trimmed.match(FLAT_SIGNATURE);
  if (flat && signatureName(flat[2]!.trim())) trimmed = `${trimmed.slice(0, flat.index).trimEnd()}\n\n${flat[1]},\n${flat[2]!.trim()}`;
  if (name) {
    const escaped = name.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
    trimmed = trimmed.replace(new RegExp(`([.!?])\\s+${escaped}$`, 'iu'), '$1');
  }
  const lines = trimmed.split('\n');
  const preferred = signoff?.trim().replace(/[,!.\s]+$/, '');
  let closing = preferred || 'Best';
  let found = false;
  // Only inspect a short terminal signature block, not arbitrary mentions of a name.
  for (let i = lines.length - 1; i >= Math.max(0, lines.length - 5); i--) {
    const line = lines[i]!.trim();
    const match = line.match(CLOSING) ?? line.match(INLINE_CLOSING);
    const custom = preferred && line.replace(/[,!.\s]+$/, '').toLowerCase() === preferred.toLowerCase();
    const tail = [...(match?.[2] ? [match[2]] : []), ...lines.slice(i + 1)].map((part) => part.trim()).filter(Boolean);
    if ((match || custom) && tail.length <= 3 && tail.every((part) => part.length <= 160) && (!tail.length || signatureName(tail[0]!))) {
      closing = preferred || match?.[1] || closing;
      lines.splice(i);
      found = true;
      break;
    }
  }
  // A bare correct name is also a signature; a name in prose is not.
  const last = lines.at(-1)?.trim();
  if (name && last?.toLocaleLowerCase() === name.toLocaleLowerCase()) lines.pop();
  if (!name && !found) return body;
  return `${lines.join('\n').trimEnd()}\n\n${closing},${name ? `\n${name}` : ''}`;
}

function nameWords(value: string): string[] {
  return value.normalize('NFKC').toLocaleLowerCase().replace(/\b(?:dr|prof|professor|mr|ms|mrs|phd|md)\b\.?/g, '')
    .match(/[\p{L}\p{M}]+(?:['’-][\p{L}\p{M}]+)*/gu) ?? [];
}

/** Keep supported names/titles; use a neutral greeting when a model invents or swaps names. */
export function ensureRecipientGreeting(body: string, recipients: Address[], userText: string[] = []): string {
  const greeting = body.match(/^(?:hi|hello|hey|dear|good (?:morning|afternoon|evening))\s+([^,!\n]{1,100})(?:[,!]|(?=\r?\n))/i);
  if (!greeting) return body;
  const addressed = greeting[1]!.trim();
  if (/^(?:all|everyone|everybody|team|there|folks|both)$/i.test(addressed)) return body;
  const known = new Set([...recipients.flatMap((person) => person.name && !person.name.includes('@') ? nameWords(person.name) : []), ...userText.flatMap(nameWords)]);
  const words = nameWords(addressed).filter((word) => word !== 'and');
  if (words.length && words.every((word) => known.has(word))) return body;
  return `Hello,${body.slice(greeting[0].length)}`;
}
