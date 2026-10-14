export type OrbTone = 'paper' | 'bare' | 'on-accent';
export type OrbState = 'idle' | 'listening' | 'analyzing' | 'searching' | 'connecting' | 'drafting' | 'resolving' | 'success';

/** Deterministic, so React and plain-DOM orbs render byte-identical artwork. */
function random(seed: number): () => number {
  let state = seed >>> 0;
  return () => {
    state = (Math.imul(state, 1664525) + 1013904223) >>> 0;
    return state / 4294967296;
  };
}
const n = (value: number) => Number(value.toFixed(2));

/**
 * One particle. Its group carries position and the direction its dust drifts;
 * CSS reads distance (`data-d`), stagger (`data-t`) and jitter (`data-k`)
 * buckets, so no inline styles are needed under a strict style-src.
 */
function dot(x: number, y: number, r: number, options: { opacity?: number; angle?: number; d?: number; t?: number; k?: number; fine?: boolean; cls?: string } = {}): string {
  const { opacity = 1, angle = 0, d = 0, t = 0, k = 0, fine = false, cls = 'gi-orb-dust' } = options;
  return `<g transform="translate(${n(x)} ${n(y)}) rotate(${Math.round(angle)})"><circle class="${cls}${fine ? ' is-fine' : ''}" data-d="${d}" data-t="${t}" data-k="${k}" r="${n(r)}" fill-opacity="${n(opacity)}"/></g>`;
}

/** A tilted Fibonacci sphere. Depth sets size and opacity; dust blows up and to the right. */
function sphere(): string {
  const next = random(7);
  const count = 72;
  const tilt = -0.42;
  const turn = 0.5;
  return Array.from({ length: count }, (_, i) => {
    const y0 = 1 - (2 * (i + 0.5)) / count;
    const ring = Math.sqrt(1 - y0 * y0);
    const theta = i * Math.PI * (3 - Math.sqrt(5));
    let x = Math.cos(theta) * ring;
    let z = Math.sin(theta) * ring;
    // Turn, then tilt, for an orb seen slightly from above.
    [x, z] = [x * Math.cos(turn) - z * Math.sin(turn), x * Math.sin(turn) + z * Math.cos(turn)];
    const y = y0 * Math.cos(tilt) - z * Math.sin(tilt);
    z = y0 * Math.sin(tilt) + z * Math.cos(tilt);
    const depth = (z + 1) / 2;
    const px = 32 + x * 23;
    const py = 32 + y * 23;
    return dot(px, py, 0.75 + depth * 1.35, {
      opacity: 0.22 + depth * 0.78,
      angle: -58 + next() * 62,
      d: Math.floor(next() * 5),
      // Disintegrates from left to right, like a sweep of wind.
      t: Math.min(7, Math.floor(((px - 8) / 48) * 8)),
      k: Math.floor(next() * 3),
      fine: z < -0.15 || i % 2 === 1,
    });
  }).join('');
}

/** Radar rings of dots. Each dot lights as the sweep passes its angle. */
function radar(): string {
  const rings: Array<[number, number, boolean]> = [[25, 30, false], [17, 20, true], [9, 10, false]];
  return rings.map(([radius, count, fine]) => Array.from({ length: count }, (_, i) => {
    const angle = (i / count) * Math.PI * 2;
    // Clockwise from twelve o'clock, matching the sweep.
    const bucket = Math.floor(((angle / (Math.PI * 2)) * 12) % 12);
    return dot(32 + Math.sin(angle) * radius, 32 - Math.cos(angle) * radius, radius > 20 ? 1.5 : 1.35, { t: bucket, fine: fine || (radius > 20 && i % 2 === 1), cls: 'gi-orb-blip' });
  }).join('')).join('');
}

function column(x: number, height: number, band: number): string {
  const count = Math.max(2, Math.round(height / 5));
  const dots = Array.from({ length: count }, (_, i) => dot(x, 32 - height / 2 + (height * i) / (count - 1), 1.7, { cls: 'gi-orb-speck' })).join('');
  return `<g class="gi-orb-voice-bar" data-orb-band="${band}">${dots}</g>`;
}

function peer(side: 'left' | 'right', cx: number): string {
  const ring = Array.from({ length: 14 }, (_, i) => {
    const angle = (i / 14) * Math.PI * 2;
    return dot(cx + Math.cos(angle) * 11, 32 + Math.sin(angle) * 11, 1.45, { cls: 'gi-orb-speck', fine: i % 2 === 1 });
  }).join('');
  const core = [[-4, -3], [4, -3], [0, 0], [-4, 4], [4, 4]].map(([dx, dy]) => dot(cx + dx!, 32 + dy!, 1.3, { cls: 'gi-orb-speck', opacity: 0.55, fine: true })).join('');
  return `<g class="gi-orb-peer gi-orb-peer-${side}">${ring}${core}</g>`;
}

/** Ribbons of dots; a wave travels along each one, left to right. */
function ribbons(): string {
  return [18, 27, 36, 45].map((y, row) => Array.from({ length: 13 }, (_, i) => {
    const x = 9 + i * (46 / 12);
    const wave = Math.sin((i / 12) * Math.PI * 2 + row * 0.9) * 4.5;
    return dot(x, y + wave, 1.5, { cls: 'gi-orb-ink', opacity: 0.45 + row * 0.18, t: Math.min(7, Math.floor(i / 1.6)), fine: i % 2 === 1 });
  }).join('')).join('');
}

/** Original particle artwork. Shared by React and plain-DOM Gmail toasts.
 * No SVG IDs, inline styles, external assets or background fill: safe across themes and strict CSP. */
export function orbSvg(): string {
  const svg = (cls: string, body: string) => `<svg class="gi-orb-shape ${cls}" viewBox="0 0 64 64" fill="none" aria-hidden="true" focusable="false">${body}</svg>`;
  const waveform = [8, 16, 26, 36, 26, 16, 8].map((height, i) => column(14 + i * 6, height, i)).join('');
  const petals = Array.from({ length: 6 }, (_, i) => `<g transform="rotate(${i * 60} 32 32)"><ellipse class="gi-orb-petal" data-orb-band="${i}" cx="32" cy="21" rx="7" ry="13"/></g>`).join('');
  return `<span class="gi-orb-form">
    ${svg('gi-orb-sphere', `<circle class="gi-orb-glow" cx="32" cy="32" r="12"/><g class="gi-orb-spin">${sphere()}</g>`)}
    ${svg('gi-orb-search', `<g class="gi-orb-sweep"><path class="gi-orb-sweep-area" d="M32 32V6a26 26 0 0 1 26 26Z"/><path class="gi-orb-sweep-edge" d="M32 32V6"/></g>${radar()}<circle class="gi-orb-radar-center" cx="32" cy="32" r="2.2"/>`)}
    ${svg('gi-orb-listen', `<circle class="gi-orb-voice-rim" cx="32" cy="32" r="27"/>${waveform}`)}
    ${svg('gi-orb-connect', `${peer('left', 16)}${peer('right', 48)}<circle class="gi-orb-link" cx="32" cy="32" r="2.4"/>`)}
    ${svg('gi-orb-draft', `${ribbons()}<path class="gi-orb-nib" d="m0-3 3 3-3 3-3-3Z" transform="translate(9 18)"/>`)}
    ${svg('gi-orb-focus', `<circle class="gi-orb-focus-rim" cx="32" cy="32" r="25"/>${petals}<circle class="gi-orb-focus-center" cx="32" cy="32" r="4"/>`)}
    ${svg('gi-orb-confirm', `<circle cx="32" cy="32" r="24"/><path d="m21 32 8 8 15-16"/>`)}
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
