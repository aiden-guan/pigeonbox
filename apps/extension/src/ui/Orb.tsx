import { useEffect, useRef } from 'react';
import { orbClass, orbSvg, type OrbState, type OrbTone } from './orb-markup';
import { observeVisual } from './motion';

const artwork = { __html: orbSvg() };

/** Kinetic contours communicate ongoing work. CSS owns every frame; observers
 * pause offscreen/background work. Idle is static and allocates no observer. */
export function Orb({ size = 16, tone = 'paper', state = 'analyzing' }: { size?: number; tone?: OrbTone; state?: OrbState }) {
  const ref = useRef<HTMLSpanElement>(null);
  useEffect(() => {
    const node = ref.current;
    if (!node || state === 'idle') return;
    return observeVisual(node, (visible) => { node.dataset.visible = String(visible); });
  }, [state]);
  return <span ref={ref} className={orbClass(tone)} data-state={state} data-compact={size < 24}
    data-visible="false" aria-hidden="true" style={{ fontSize: size }} dangerouslySetInnerHTML={artwork} />;
}
