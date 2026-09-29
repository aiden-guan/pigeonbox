import { describe, expect, it } from 'vitest';
import {
  extractQuotedTrackingIdsFromMessageBody,
  extractTrackingIdFromCandidateUrl,
  extractTrackingIdFromMessageBody,
  senderFingerprintMatches,
  type PixelCandidateElement,
  type PixelCandidateRoot,
} from './index';

function img(attrs: Record<string, string | null>, quoted = false): PixelCandidateElement {
  return {
    getAttribute: (name) => attrs[name] ?? null,
    closest: () => (quoted ? {} : null),
  };
}

function body(images: PixelCandidateElement[]): PixelCandidateRoot {
  return { querySelectorAll: () => images };
}

describe('extractTrackingIdFromMessageBody', () => {
  const tracker = 'https://track.example';

  it('reads a direct pixel url', () => {
    const id = extractTrackingIdFromMessageBody(body([img({ src: 'https://track.example/open/trk_direct' })]), tracker);
    expect(id).toBe('trk_direct');
  });

  it('reads a Gmail proxy fragment and a decoded query url', () => {
    expect(
      extractTrackingIdFromCandidateUrl(
        'https://ci3.googleusercontent.com/meips/abc#https://track.example/open/trk_fragment',
        tracker,
      ),
    ).toBe('trk_fragment');
    expect(
      extractTrackingIdFromCandidateUrl(
        'https://ci3.googleusercontent.com/proxy?url=https%3A%2F%2Ftrack.example%2Fopen%2Ftrk_query',
        tracker,
      ),
    ).toBe('trk_query');
  });

  it('stops after two decodes', () => {
    const real = 'https://track.example/open/trk_once';
    const twice = encodeURIComponent(encodeURIComponent(real));
    const thrice = encodeURIComponent(twice);
    expect(extractTrackingIdFromCandidateUrl(twice, tracker)).toBe('trk_once');
    expect(extractTrackingIdFromCandidateUrl(thrice, tracker)).toBeNull();
  });

  it('rejects a pixel whose origin is not the configured tracker', () => {
    expect(extractTrackingIdFromCandidateUrl('https://evil.example/open/trk_nope', tracker)).toBeNull();
    expect(extractTrackingIdFromCandidateUrl('https://evil.example/open/trk_nope')).toBe('trk_nope');
  });

  it('uses data-src, ignores quoted pixels, and returns null when two live pixels disagree', () => {
    expect(
      extractTrackingIdFromMessageBody(
        body([img({ src: 'https://track.example/open/trk_quoted' }, true), img({ 'data-src': 'https://track.example/open/trk_live.gif' })]),
        tracker,
      ),
    ).toBe('trk_live');
    expect(
      extractTrackingIdFromMessageBody(
        body([
          img({ src: 'https://track.example/open/trk_one' }),
          img({ src: 'https://track.example/open/trk_two' }),
        ]),
        tracker,
      ),
    ).toBeNull();
  });

  it('lists quoted pixels separately from the live one', () => {
    const root = body([
      img({ src: 'https://track.example/open/trk_live' }),
      img({ src: 'https://ci3.googleusercontent.com/meips/x#https://track.example/open/trk_q1' }, true),
      img({ src: 'https://track.example/open/trk_q2.gif' }, true),
      img({ src: 'https://evil.example/open/trk_foreign' }, true),
    ]);
    expect(extractQuotedTrackingIdsFromMessageBody(root, tracker)).toEqual(['trk_q1', 'trk_q2']);
    expect(extractTrackingIdFromMessageBody(root, tracker)).toBe('trk_live');
  });
});

describe('sender fingerprints', () => {
  const chrome = 'Mozilla/5.0 (Macintosh) AppleWebKit/537.36 Chrome/120.0.0.0 Safari/537.36';
  const otherChrome = 'Mozilla/5.0 (Windows NT 10.0) AppleWebKit/537.36 Chrome/121.0.0.0 Safari/537.36';

  it('matches the same IP and browser family, and ignores a proxy or a different IP', () => {
    const claim = { senderIpHash: 'ip_sender', senderUaFamily: 'chrome' };
    expect(senderFingerprintMatches(claim, { ipHash: 'ip_sender', userAgent: chrome })).toBe(true);
    expect(senderFingerprintMatches(claim, { ipHash: 'ip_sender', userAgent: otherChrome })).toBe(true);
    expect(senderFingerprintMatches(claim, { ipHash: 'ip_recipient', userAgent: chrome })).toBe(false);
    expect(senderFingerprintMatches(claim, { ipHash: 'ip_sender', userAgent: 'GoogleImageProxy' })).toBe(false);
    expect(senderFingerprintMatches({ senderIpHash: null, senderUaFamily: 'chrome' }, { ipHash: 'ip_sender', userAgent: chrome })).toBe(false);
  });
});
