/** Inspect decoded HTML MIME parts, excluding attached messages/documents. */
export function inspectTrackingMime(input) {
  const source = Buffer.isBuffer(input) ? input : Buffer.from(input, 'utf8');
  if (source.length > 32 * 1024 * 1024) throw new Error('Message exceeds the 32 MB inspection limit.');
  let parts = 0;
  function htmlParts(raw, depth = 0) {
    if (++parts > 500 || depth > 10) throw new Error('Message exceeds the MIME nesting or part limit.');
    const normalized = raw.replace(/\r\n/g, '\n');
    const separator = normalized.indexOf('\n\n');
    // Also accept an HTML export without MIME headers.
    if (/^\s*</.test(normalized)) return [Buffer.from(normalized, 'latin1').toString('utf8')];
    if (separator < 0) return [];
    const headers = new Map();
    for (const line of normalized.slice(0, separator).replace(/\n[ \t]+/g, ' ').split('\n')) {
      const colon = line.indexOf(':');
      if (colon > 0) headers.set(line.slice(0, colon).toLowerCase(), line.slice(colon + 1).trim());
    }
    if (/^attachment\b/i.test(headers.get('content-disposition') ?? '')) return [];
    const type = headers.get('content-type') ?? 'text/plain';
    const body = normalized.slice(separator + 2);
    if (/^multipart\//i.test(type)) {
      const boundary = type.match(/\bboundary\s*=\s*(?:"([^"]+)"|([^;\s]+))/i);
      if (!boundary) throw new Error('Multipart message has no MIME boundary.');
      const delimiter = `--${boundary[1] ?? boundary[2]}`;
      const children = [];
      let current = null;
      for (const line of body.split('\n')) {
        const trimmed = line.trimEnd();
        if (trimmed === delimiter || trimmed === `${delimiter}--`) {
          if (current) children.push(...htmlParts(current.join('\n'), depth + 1));
          if (trimmed === `${delimiter}--`) break;
          current = [];
        } else if (current) current.push(line);
      }
      return children;
    }
    if (!/^text\/html(?:\s*;|\s*$)/i.test(type)) return [];
    const encoding = (headers.get('content-transfer-encoding') ?? '').toLowerCase();
    let bytes;
    if (encoding === 'base64') {
      const compact = body.replace(/\s/g, '');
      if (!/^[A-Za-z0-9+/]*={0,2}$/.test(compact) || compact.length % 4 === 1) throw new Error('Malformed base64 MIME part.');
      bytes = Buffer.from(compact, 'base64');
    } else if (encoding === 'quoted-printable') {
      const unfolded = body.replace(/=\n/g, '');
      bytes = Buffer.allocUnsafe(unfolded.length);
      let offset = 0;
      for (let index = 0; index < unfolded.length; index++) {
        if (unfolded[index] === '=' && /^[\da-f]{2}$/i.test(unfolded.slice(index + 1, index + 3))) {
          bytes[offset++] = Number.parseInt(unfolded.slice(index + 1, index + 3), 16); index += 2;
        } else bytes[offset++] = unfolded.charCodeAt(index);
      }
      bytes = bytes.subarray(0, offset);
    } else bytes = Buffer.from(body, 'latin1');
    const charset = type.match(/\bcharset\s*=\s*(?:"([^"]+)"|([^;\s]+))/i);
    return [new TextDecoder(charset?.[1] ?? charset?.[2] ?? 'utf-8').decode(bytes)];
  }
  const html = htmlParts(source.toString('latin1')).join('\n');
  const pixels = [...html.matchAll(/<img\b[^>]*\bsrc=["']([^"']*\/open\/(trk_[A-Za-z0-9_-]+))/gi)];
  const links = [...html.matchAll(/href=["'][^"']*\/c\/(clk_[A-Za-z0-9_-]+)/gi)];
  return { pixelCount: pixels.length, trackedLinks: links.length, trackingIds: [...new Set(pixels.map(match => match[2]))] };
}
