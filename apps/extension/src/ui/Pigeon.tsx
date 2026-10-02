import { useEffect, useRef, type CSSProperties } from 'react';
import { observeVisual } from './motion';

export type PigeonState = 'idle' | 'indexing' | 'drafting' | 'opened' | 'error' | 'searching' | 'working' | 'success' | 'attention' | 'offline' | 'sleeping' | 'active' | 'thinking' | 'ready' | 'warning';

// Rows of pigeon-sprites.webp, a 4-column grid of 320x256 cells built by
// scripts/pack-pigeon.py with a shared body center and foot baseline.
const rows: PigeonState[] = ['idle', 'indexing', 'drafting', 'opened', 'error'];
export function Pigeon({ state = 'idle', size = 32 }: { state?: PigeonState; size?: number }) {
  const url = typeof chrome !== 'undefined' && chrome.runtime?.getURL
    ? chrome.runtime.getURL('brand/pigeon-sprites.webp')
    : '/brand/pigeon-sprites.webp';
  const ref = useRef<HTMLSpanElement>(null);
  useEffect(() => ref.current ? observeVisual(ref.current, (visible) => { if (ref.current) ref.current.dataset.visible = String(visible); }) : undefined, []);
  const aliases: Partial<Record<PigeonState, PigeonState>> = { searching: 'opened', working: 'indexing', success: 'drafting', attention: 'error', offline: 'idle', sleeping: 'idle', active: 'opened', thinking: 'indexing', ready: 'drafting', warning: 'error' };
  const row = rows.indexOf(aliases[state] ?? state);
  return <span ref={ref} aria-hidden="true" className="gi-pigeon" data-state={state}
    style={{ fontSize: size } as CSSProperties}>
    {[0, 1, 2, 3].map((col) => <span key={col} className="gi-pigeon-frame" style={{
      '--frame': col,
      backgroundImage: `url("${url}")`,
      backgroundPosition: `${-col}em ${-row * 0.8}em`,
    } as CSSProperties} />)}
  </span>;
}

export function Brand({ state = 'idle' }: { state?: PigeonState } = {}) {
  return <div className="gi-brand-lockup"><Pigeon size={38} state={state} /><span>PigeonBox<span className="gi-brand-sub">Gmail intelligence</span></span></div>;
}
