/** WAAPI reads the same timing/easing roles as CSS, including reduced motion. */
export function motionOptions(node: Element, role: 'quick' | 'standard' | 'expressive' | 'resolution' = 'standard'): KeyframeAnimationOptions {
  const style = getComputedStyle(node);
  return { duration: parseFloat(style.getPropertyValue(`--pb-motion-${role}`)) || 0, easing: style.getPropertyValue('--pb-ease').trim() || 'ease-out' };
}
export const prefersReducedMotion = () => typeof matchMedia === 'function' && matchMedia('(prefers-reduced-motion: reduce)').matches;
/** Visibility is event-driven. No polling or frame loop while a surface rests. */
export function observeVisual(node: HTMLElement, update: (visible: boolean) => void): () => void {
  let intersecting = typeof IntersectionObserver === 'undefined';
  const notify = () => update(intersecting && !document.hidden);
  const observer = typeof IntersectionObserver === 'undefined' ? null : new IntersectionObserver(([entry]) => { intersecting = entry.isIntersecting; notify(); });
  observer?.observe(node);
  document.addEventListener('visibilitychange', notify);
  notify();
  return () => { observer?.disconnect(); document.removeEventListener('visibilitychange', notify); };
}
