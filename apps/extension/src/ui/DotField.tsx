import { useEffect, useRef } from 'react';
import { motionOptions, observeVisual, prefersReducedMotion } from './motion';
export type DotState = 'idle' | 'listening' | 'analyzing' | 'searching' | 'connecting' | 'resolving' | 'success';
const dots = Array.from({ length: 35 }, (_, id) => ({ id, x: 5 + id % 7 * 5, y: 5 + Math.floor(id / 7) * 5 }));
function glyph(state: DotState, id: number, x: number, y: number) {
  const col = id % 7, row = Math.floor(id / 7);
  if (state === 'listening') return { x:20 + Math.cos(id / 35 * Math.PI * 2) * 12, y:15 + Math.sin(id / 35 * Math.PI * 2) * 10, opacity:id % 3 === 0 ? .8 : .3 };
  if (state === 'connecting') return { x:col === 3 ? 15 + row * 2.5 : col < 3 ? 4 + col * 4 : 28 + (col - 4) * 4, y:col === 3 ? 15 : 7 + row * 4, opacity:col === 3 ? .9 : .4 };
  if (state === 'success') return { x, y, opacity:([22, 30, 24, 18, 12, 6].includes(id)) ? 1 : .12 };
  if (state === 'searching') return { x, y, opacity:Math.abs(row - 2) === Math.abs(col - 4) ? .95 : .15 };
  return { x, y, opacity:state === 'idle' ? .3 : id % 3 === 0 ? .9 : .5 };
}
/** 35 SVG marks, one finite resolution per state. Idle allocates no animation.
 * Semantic status belongs in the adjacent label, not this decorative field. */
export function DotField({ state = 'idle', size = 24, onAccent = false }: { state?: DotState; size?: number; onAccent?: boolean }) {
  const ref = useRef<HTMLSpanElement>(null);
  useEffect(() => {
    const root = ref.current;
    if (!root || state === 'idle' || prefersReducedMotion()) return;
    let animations: Animation[] = [];
    let started = false;
    const unobserve = observeVisual(root, (visible) => {
      if (!visible) { animations.forEach((item) => item.pause()); return; }
      if (started) { animations.forEach((item) => { if (item.playState === 'paused') item.play(); }); return; }
      started = true;
      if (typeof root.animate !== 'function') return;
      const options = motionOptions(root, 'resolution');
      root.querySelectorAll('circle').forEach((dot, id) => {
        const col = id % 7, row = Math.floor(id / 7);
        const direction = state === 'connecting' ? (col < 3 ? -1 : 1) : state === 'searching' ? -1 : 1;
        const x = state === 'listening' ? 0 : direction * ((id * 7 % 9) - 4);
        const y = state === 'success' ? 0 : (id * 11 % 7) - 3;
        animations.push(dot.animate([
          { transform: `translate(${x}px, ${y}px)`, opacity: .2 },
          { transform: `translate(${direction * (col - 3)}px, ${(row - 2) * .5}px)`, opacity: .8, offset: .55 },
          { transform: 'translate(0, 0)', opacity: 1 },
        ], { ...options, delay: (col + row) * 12, fill: 'backwards' }));
      });
    });
    const reduced = typeof matchMedia === 'function' ? matchMedia('(prefers-reduced-motion: reduce)') : null;
    const stop = () => { if (reduced?.matches) animations.forEach((item) => item.cancel()); };
    reduced?.addEventListener('change', stop);
    return () => { unobserve(); reduced?.removeEventListener('change', stop); animations.forEach((item) => item.cancel()); animations = []; };
  }, [state]);
  return <span ref={ref} className="pb-dot-field" data-state={state} data-on-accent={onAccent} aria-hidden="true" style={{ width: size, height: size }}>
    <svg viewBox="0 0 40 30" fill="currentColor" focusable="false">{dots.map(({ id, x, y }) => { const point = glyph(state, id, x, y); return <circle key={id} cx={point.x} cy={point.y} r={1} opacity={point.opacity} />; })}</svg>
  </span>;
}
