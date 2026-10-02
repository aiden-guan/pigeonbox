/** Plain DOM loading uses the same finite dot vocabulary as React surfaces. */
export function orbSvg(): string {
  return `<svg viewBox="0 0 40 30" fill="currentColor" aria-hidden="true" focusable="false">${Array.from({ length: 35 }, (_, id) => `<circle cx="${5 + id % 7 * 5}" cy="${5 + Math.floor(id / 7) * 5}" r="1" opacity="${id % 3 === 0 ? .9 : .5}"/>`).join('')}</svg>`;
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
