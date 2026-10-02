import { motionOptions } from './motion';
import { useLayoutEffect, useRef } from 'react';
import { reducedMotion } from './dispatch-motion';

/** Roll the confirmed count when it changes; never invent intermediate totals. */
export function DispatchCount({ value }: { value: number }) {
  const ref = useRef<HTMLSpanElement>(null);
  const previous = useRef(value);
  useLayoutEffect(() => {
    const node = ref.current;
    if (node && previous.current !== value && !reducedMotion() && typeof node.animate === 'function') {
      const animation = node.animate([{ opacity: .3, transform: `translateY(${value > previous.current ? 6 : -6}px)` }, { opacity: 1, transform: 'translateY(0)' }], motionOptions(node,'standard'));
      previous.current = value;
      return () => animation.cancel();
    }
    previous.current = value;
  }, [value]);
  return <span ref={ref} style={{ display: 'inline-block', fontVariantNumeric: 'tabular-nums' }}>{new Intl.NumberFormat().format(value)}</span>;
}
