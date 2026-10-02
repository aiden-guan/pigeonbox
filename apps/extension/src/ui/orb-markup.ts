/** Compatibility export: loading is now a dispatch route, shared with DOM toasts. */
export function orbSvg(): string {
  return '<svg viewBox="0 0 24 24" fill="none" aria-hidden="true" focusable="false"><path class="gi-route-track" d="M3 18V9a3 3 0 0 1 3-3h12"/><path class="gi-route-progress" pathLength="100" d="M3 18V9a3 3 0 0 1 3-3h12"/><path class="gi-route-end" d="m15 3 3 3-3 3"/></svg>';
}

export type OrbTone = 'paper' | 'bare' | 'on-accent';

export function orbClass(tone: OrbTone = 'paper'): string {
  return tone === 'paper' ? 'gi-orb' : `gi-orb is-${tone}`;
}

/** Plain-DOM orb for surfaces that are not rendered by React (toasts). */
export function createOrb(size = 16, tone: OrbTone = 'paper'): HTMLSpanElement {
  const span = document.createElement('span');
  span.className = orbClass(tone);
  span.style.fontSize = `${size}px`;
  span.innerHTML = orbSvg();
  return span;
}
