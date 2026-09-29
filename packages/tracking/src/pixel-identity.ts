/**
 * Read the tracking id out of the message the sender is actually looking at.
 * Gmail rewrites external images through its proxy, so the pixel URL may be
 * encoded or stored in a fragment rather than sitting in img.src literally.
 */

const TRACKING_ID_RE = /\/open\/(trk_[A-Za-z0-9_-]+)/;
const MAX_DECODE_PASSES = 2;

export type PixelCandidateElement = {
  getAttribute(name: string): string | null;
  closest?(selector: string): unknown;
};

export type PixelCandidateRoot = {
  querySelectorAll(selector: string): Iterable<PixelCandidateElement>;
};

function pushUnique(target: string[], value: string): void {
  if (value && !target.includes(value)) target.push(value);
}

/** Decode a few times at most. Never walk an arbitrarily nested encoding. */
export function decodeBounded(value: string): string[] {
  const out: string[] = [];
  pushUnique(out, value);
  let current = value;
  for (let i = 0; i < MAX_DECODE_PASSES; i++) {
    let next = current;
    try {
      next = decodeURIComponent(current.replace(/\+/g, ' '));
    } catch {
      break;
    }
    if (next === current) break;
    pushUnique(out, next);
    current = next;
  }
  return out;
}

function collectVariants(raw: string): string[] {
  const variants: string[] = [];
  for (const decoded of decodeBounded(raw.trim())) {
    pushUnique(variants, decoded);
    try {
      const url = new URL(decoded);
      if (url.hash.length > 1) {
        for (const hash of decodeBounded(url.hash.slice(1))) pushUnique(variants, hash);
      }
      url.searchParams.forEach((val) => {
        for (const nested of decodeBounded(val)) pushUnique(variants, nested);
      });
    } catch {
      // The candidate is not an absolute URL. The raw text is still searched.
    }
  }
  return variants;
}

function expectedOrigin(trackerBaseUrl?: string): string | null {
  if (!trackerBaseUrl?.trim()) return null;
  try {
    return new URL(trackerBaseUrl).origin;
  } catch {
    return null;
  }
}

function variantOwnsOrigin(variant: string, matchIndex: number, origin: string): boolean {
  const before = variant.slice(0, matchIndex);
  const origins = before.match(/https?:\/\/[^\s"'<>#?]+/gi) || [];
  const last = origins[origins.length - 1];
  if (!last) return false;
  try {
    return new URL(last).origin === origin;
  } catch {
    return last.startsWith(origin);
  }
}

export function extractTrackingIdFromCandidateUrl(raw: string, trackerBaseUrl?: string): string | null {
  if (!raw || typeof raw !== 'string') return null;
  const origin = expectedOrigin(trackerBaseUrl);
  if (trackerBaseUrl?.trim() && !origin) return null;
  for (const variant of collectVariants(raw)) {
    const match = variant.match(TRACKING_ID_RE);
    if (!match?.[1]) continue;
    const index = match.index ?? variant.indexOf(match[0]);
    if (origin && !variantOwnsOrigin(variant, index, origin)) continue;
    return match[1];
  }
  return null;
}

function isQuotedImage(el: PixelCandidateElement): boolean {
  return typeof el.closest === 'function' && Boolean(el.closest('blockquote, .gmail_quote, .gmail_extra'));
}

/** Unique tracking ids from images that are part of the message itself, not a quote. */
export function extractTrackingIdsFromMessageBody(body: PixelCandidateRoot, trackerBaseUrl?: string): string[] {
  const ids: string[] = [];
  for (const node of body.querySelectorAll('img[src], img[data-src]')) {
    if (isQuotedImage(node)) continue;
    for (const attr of ['src', 'data-src'] as const) {
      const value = node.getAttribute(attr);
      if (!value) continue;
      const id = extractTrackingIdFromCandidateUrl(value, trackerBaseUrl);
      if (id) pushUnique(ids, id);
    }
  }
  return ids;
}

/** Unique tracking ids from images inside a quote in this body (an earlier message this one replies to or forwards). */
export function extractQuotedTrackingIdsFromMessageBody(body: PixelCandidateRoot, trackerBaseUrl?: string): string[] {
  const ids: string[] = [];
  for (const node of body.querySelectorAll('img[src], img[data-src]')) {
    if (!isQuotedImage(node)) continue;
    for (const attr of ['src', 'data-src'] as const) {
      const value = node.getAttribute(attr);
      if (!value) continue;
      const id = extractTrackingIdFromCandidateUrl(value, trackerBaseUrl);
      if (id) pushUnique(ids, id);
    }
  }
  return ids;
}

/**
 * The tracking id embedded in this exact message body.
 * Returns null when the body has no pixel, or more than one distinct pixel.
 */
export function extractTrackingIdFromMessageBody(body: PixelCandidateRoot, trackerBaseUrl?: string): string | null {
  const ids = extractTrackingIdsFromMessageBody(body, trackerBaseUrl);
  return ids.length === 1 ? ids[0] : null;
}
