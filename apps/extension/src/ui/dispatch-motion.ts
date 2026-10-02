import { useLayoutEffect, useRef } from 'react';

export const DISPATCH_EASE = 'cubic-bezier(.22, 1, .36, 1)';
export const reducedMotion = () => typeof matchMedia === 'function' && matchMedia('(prefers-reduced-motion: reduce)').matches;

/** Read geometry before writing. Stable keys survive category changes and expansion.
 * Cleanup captures the current visible positions when a transition is interrupted. */
export function useDispatchLayout<T extends HTMLElement>(revision: unknown) {
  const ref = useRef<T>(null);
  const previous = useRef(new Map<string, { rect: DOMRect; node: HTMLElement }>());
  const animations = useRef<Animation[]>([]);
  useLayoutEffect(() => {
    const root = ref.current;
    if (!root) return;
    const measured = [...root.querySelectorAll<HTMLElement>('[data-motion-id]')].filter((node) => !node.closest('[hidden]')).map((node) => ({ node, id: node.dataset.motionId!, rect: node.getBoundingClientRect() }));
    const before = previous.current;
    const next = new Map(measured.map(({ node, id, rect }) => [id, { node, rect }]));
    animations.current.forEach((animation) => animation.cancel());
    animations.current = [];
    if (!reducedMotion() && typeof root.animate === 'function') {
      measured.forEach(({ node, id, rect }, index) => {
        const old = before.get(id)?.rect;
        const ancestor = node.parentElement?.closest<HTMLElement>('[data-motion-id]');
        const parentId = ancestor?.dataset.motionId;
        const parentBefore = parentId ? before.get(parentId)?.rect : undefined;
        const parentAfter = parentId ? next.get(parentId)?.rect : undefined;
        const parentX = parentBefore && parentAfter ? parentBefore.left - parentAfter.left : 0;
        const parentY = parentBefore && parentAfter ? parentBefore.top - parentAfter.top : 0;
        const x = old ? old.left - rect.left - parentX : 6;
        const y = old ? old.top - rect.top - parentY : 6;
        if (!old || Math.abs(x) + Math.abs(y) > .5) animations.current.push(node.animate([
          { transform: `translate(${x}px, ${y}px)`, opacity: old ? 1 : 0 },
          { transform: 'translate(0, 0)', opacity: 1 },
        ], { duration: 340, delay: old ? 0 : Math.min(index * 20, 100), easing: DISPATCH_EASE, fill: 'backwards' }));
      });
      before.forEach(({ node, rect }, id) => {
        if (next.has(id) || !id.startsWith('thread:')) return;
        const ghost = node.cloneNode(true) as HTMLElement;
        ghost.removeAttribute('id');
        ghost.removeAttribute('hidden');
        ghost.querySelectorAll('[id]').forEach((child) => child.removeAttribute('id'));
        ghost.setAttribute('aria-hidden', 'true');
        ghost.inert = true;
        Object.assign(ghost.style, { position: 'fixed', top: `${rect.top}px`, left: `${rect.left}px`, width: `${rect.width}px`, margin: '0', pointerEvents: 'none', zIndex: '5' });
        document.body.append(ghost);
        const animation = ghost.animate([{ opacity: .6, transform: 'translateY(0)' }, { opacity: 0, transform: 'translateY(6px)' }], { duration: 140, easing: DISPATCH_EASE });
        animation.finished.then(() => ghost.remove()).catch(() => ghost.remove());
        animations.current.push(animation);
      });
    }
    previous.current = next;
    return () => { previous.current.forEach((entry) => { if (entry.node.isConnected) entry.rect = entry.node.getBoundingClientRect(); }); };
  }, [revision]);
  useLayoutEffect(() => () => { animations.current.forEach((animation) => animation.cancel()); }, []);
  return ref;
}
