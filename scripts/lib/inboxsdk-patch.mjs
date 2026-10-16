/**
 * InboxSDK 2.x only passes the first Gmail body segment to request modifiers.
 * Gmail appends separate quote/signature segments after that modified body.
 * Strip old PigeonBox pixels from those segments at the same send boundary,
 * without editing the live draft or changing any text, links or part metadata.
 */
export function stripQuotedPigeonboxPixels(html) {
  return html.replace(/<img\b[^>]*>/gi, (tag) => {
    for (const attr of tag.matchAll(/\s(?:src|data-src)\s*=\s*(["'])(.*?)\1/gi)) {
      let candidate = attr[2].replace(/&amp;|&#0*38;|&#x0*26;/gi, '&');
      for (let pass = 0; pass <= 2; pass += 1) {
        if (/\/open\/trk_[A-Za-z0-9_-]+/.test(candidate)) return '';
        if (pass === 2) break;
        try {
          const decoded = decodeURIComponent(candidate);
          if (decoded === candidate) break;
          candidate = decoded;
        } catch { break; }
      }
    }
    return tag;
  });
}

export function patchInboxSdkPageWorld(source) {
  if (source.includes('function stripQuotedPigeonboxPixels(')) throw new Error('InboxSDK compose layout changed; the quoted-pixel patch is already present.');
  const replacements = [
    ['function replaceBodyInRequestMsg(msg, newBodyHtmlContent) {', `${stripQuotedPigeonboxPixels.toString()}\nfunction replaceBodyInRequestMsg(msg, newBodyHtmlContent) {`],
    ['  msg[8][1][0][1] = newBodyHtmlContent;', `  msg[8][1][0][1] = newBodyHtmlContent;
  for (const part of msg[8][1].slice(1)) {
    if (Array.isArray(part) && typeof part[1] === 'string') part[1] = stripQuotedPigeonboxPixels(part[1]);
  }`],
    ['  sendUpdate[9][2][0][2] = newBody;', `  sendUpdate[9][2][0][2] = newBody;
  for (const part of sendUpdate[9][2].slice(1)) {
    if (Array.isArray(part) && typeof part[2] === 'string') part[2] = stripQuotedPigeonboxPixels(part[2]);
  }`],
    ['  if (!newBody) return request;', '  if (newBody == null) return request;'],
  ];
  for (const [from, to] of replacements) {
    if (source.split(from).length !== 2) throw new Error('InboxSDK compose layout changed; review the quoted-pixel patch before building.');
    source = source.replace(from, to);
  }
  return source;
}
