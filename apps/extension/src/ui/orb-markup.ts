export type OrbTone = 'paper' | 'bare' | 'on-accent';
export type OrbState = 'idle' | 'listening' | 'analyzing' | 'searching' | 'connecting' | 'drafting' | 'resolving' | 'success';

/** Original contour artwork. Shared by React and plain-DOM Gmail toasts.
 * No SVG IDs, external assets, shader, or background fill: safe across themes. */
export function orbSvg(): string {
  const bands = Array.from({ length: 7 }, (_, i) => {
    const y = 14 + i * 6;
    const radius = Math.sqrt(24 ** 2 - (y - 32) ** 2);
    return `<ellipse class="gi-orb-latitude" data-orb-band="${i}" cx="32" cy="${y}" rx="${radius.toFixed(2)}" ry="${(radius * .22).toFixed(2)}"/>`;
  }).join('');
  const orbit = (index: number) => `<svg class="gi-orb-orbit gi-orb-orbit-${index}" viewBox="0 0 64 64" fill="none" aria-hidden="true" focusable="false"><circle class="gi-orb-track" cx="32" cy="32" r="26"/><path class="gi-orb-arc" d="M32 6a26 26 0 0 1 26 26"/><circle class="gi-orb-satellite" cx="32" cy="6" r="2.5"/></svg>`;
  const waveform = [8, 16, 26, 36, 26, 16, 8].map((height, i) => `<line class="gi-orb-voice-bar" data-orb-band="${i}" x1="${14 + i * 6}" x2="${14 + i * 6}" y1="${32 - height / 2}" y2="${32 + height / 2}"/>`).join('');
  const hemisphere = (side: 'left' | 'right', x: number) => `<g class="gi-orb-peer gi-orb-peer-${side}"><circle cx="${x}" cy="32" r="11" class="gi-orb-peer-rim"/>${[25,32,39].map((y) => `<ellipse cx="${x}" cy="${y}" rx="${y === 32 ? 11 : 8}" ry="2.7"/>`).join('')}</g>`;
  const ribbons = [18,27,36,45].map((y, i) => `<path class="gi-orb-ribbon" data-orb-band="${i}" d="M9 ${y}C17 ${y - 9} 25 ${y + 9} 33 ${y}S49 ${y - 9} 55 ${y}"/>`).join('');
  const petals = Array.from({length:6}, (_, i) => `<g transform="rotate(${i * 60} 32 32)"><ellipse class="gi-orb-petal" data-orb-band="${i}" cx="32" cy="21" rx="7" ry="13"/></g>`).join('');
  return `<span class="gi-orb-form">
    <span class="gi-orb-shape gi-orb-sphere"><svg class="gi-orb-core" viewBox="0 0 64 64" fill="none" aria-hidden="true" focusable="false"><circle class="gi-orb-rim" cx="32" cy="32" r="24"/>${bands}</svg>${orbit(1)}${orbit(2)}</span>
    <svg class="gi-orb-shape gi-orb-search" viewBox="0 0 64 64" fill="none" aria-hidden="true" focusable="false"><g class="gi-orb-radar-rings"><circle cx="32" cy="32" r="25"/><circle cx="32" cy="32" r="17"/><circle cx="32" cy="32" r="9"/></g><circle class="gi-orb-radar-center" cx="32" cy="32" r="2"/><g class="gi-orb-sweep"><path class="gi-orb-sweep-area" d="M32 32V7a25 25 0 0 1 25 25Z"/><path class="gi-orb-sweep-edge" d="M32 32V7a25 25 0 0 1 25 25"/><circle class="gi-orb-satellite" cx="32" cy="7" r="2.5"/></g><circle class="gi-orb-found" cx="46" cy="22" r="2.5"/></svg>
    <svg class="gi-orb-shape gi-orb-listen" viewBox="0 0 64 64" fill="none" aria-hidden="true" focusable="false"><circle class="gi-orb-voice-rim" cx="32" cy="32" r="26"/>${waveform}</svg>
    <svg class="gi-orb-shape gi-orb-connect" viewBox="0 0 64 64" fill="none" aria-hidden="true" focusable="false"><path class="gi-orb-bridge" d="M24 32H40"/>${hemisphere('left',16)}${hemisphere('right',48)}<circle class="gi-orb-link" cx="32" cy="32" r="2.5"/></svg>
    <svg class="gi-orb-shape gi-orb-draft" viewBox="0 0 64 64" fill="none" aria-hidden="true" focusable="false">${ribbons}<path class="gi-orb-nib" d="m0-3 3 3-3 3-3-3Z" transform="translate(9 18)"/></svg>
    <svg class="gi-orb-shape gi-orb-focus" viewBox="0 0 64 64" fill="none" aria-hidden="true" focusable="false"><circle class="gi-orb-focus-rim" cx="32" cy="32" r="25"/>${petals}<circle class="gi-orb-focus-center" cx="32" cy="32" r="4"/></svg>
    <svg class="gi-orb-shape gi-orb-confirm" viewBox="0 0 64 64" fill="none" aria-hidden="true" focusable="false"><circle cx="32" cy="32" r="24"/><path d="m21 32 8 8 15-16"/></svg>
  </span>`.replace(/>\s+</g, '><');
}

export function orbClass(tone: OrbTone = 'paper'): string {
  return tone === 'paper' ? 'gi-orb' : `gi-orb is-${tone}`;
}

/** Adjacent status text carries semantics; the orb itself is decorative. */
export function createOrb(size = 16, tone: OrbTone = 'paper', state: OrbState = 'analyzing'): HTMLSpanElement {
  const span = document.createElement('span');
  span.className = orbClass(tone);
  span.style.fontSize = `${size}px`;
  span.dataset.state = state;
  span.dataset.compact = String(size < 24);
  span.dataset.visible = 'false';
  span.setAttribute('aria-hidden', 'true');
  // DOMParser avoids Gmail's Trusted Types gate on innerHTML.
  const doc = new DOMParser().parseFromString(`<body>${orbSvg()}</body>`, 'text/html');
  span.append(...Array.from(doc.body.childNodes).map((n) => document.importNode(n, true)));
  return span;
}
