import { useEffect, useRef, useState, type CSSProperties, type KeyboardEvent, type PointerEvent } from 'react';
import { prefersReducedMotion } from '../ui/motion';

export type Mode = 'light' | 'night';

/** Faces on the drum, alternating light / night. Even indexes are light. */
const FACES = 12;
const STEP = 360 / FACES;
const modeAt = (index: number): Mode => (((index % 2) + 2) % 2 === 0 ? 'light' : 'night');
const STARS = Array.from({ length: 26 }, (_, index) => ({ x: (index * 37.3) % 100, y: (index * 53.7) % 62, s: 1 + (index % 3), d: (index % 7) * 0.6 }));

type Sim = {
  pos: number;
  v: number;
  mode: 'idle' | 'drag' | 'wheel' | 'coast' | 'snap' | 'tween';
  target: number;
  tween: { from: number; to: number; start: number; duration: number } | null;
  drag: { y: number; pos: number; lastY: number; lastT: number } | null;
};

/**
 * "You seem more like a ___ mode person." The blank is a drum of alternating
 * words. Scroll, drag or use the arrow keys to spin it; it coasts, then
 * springs onto a word, and the page floods into that theme from the word.
 */
export function ThemeIntro({ initial, leaving, onPick, onContinue }: {
  initial: Mode;
  leaving: boolean;
  onPick: (mode: Mode, origin: { x: number; y: number }) => void;
  onContinue: (mode: Mode) => void;
}) {
  const scene = useRef<HTMLDivElement>(null);
  const drum = useRef<HTMLSpanElement>(null);
  const slot = useRef<HTMLSpanElement>(null);
  const sim = useRef<Sim>({ pos: initial === 'night' ? 1 : 0, v: 0, mode: 'idle', target: 0, tween: null, drag: null });
  const frame = useRef(0);
  const wheelTimer = useRef(0);
  const committed = useRef<Mode>(initial);
  const [value, setValue] = useState<Mode>(initial);
  const [touched, setTouched] = useState(false);
  const latest = useRef({ onPick, value });
  latest.current = { onPick, value };

  const paint = () => {
    const { pos } = sim.current;
    if (drum.current) drum.current.style.transform = `rotateX(${pos * STEP}deg)`;
    // 0 at a light face, 1 at a night face, smooth in between: the sky follows the drum.
    scene.current?.style.setProperty('--t', ((1 - Math.cos(pos * Math.PI)) / 2).toFixed(4));
    const next = modeAt(Math.round(pos));
    if (next !== latest.current.value) setValue(next);
  };

  const settle = () => {
    const s = sim.current;
    s.pos = Math.round(s.pos);
    s.v = 0;
    s.mode = 'idle';
    paint();
    const mode = modeAt(s.pos);
    if (mode === committed.current) return;
    committed.current = mode;
    const rect = slot.current?.getBoundingClientRect();
    latest.current.onPick(mode, rect ? { x: rect.left + rect.width / 2, y: rect.top + rect.height / 2 } : { x: innerWidth / 2, y: innerHeight / 2 });
  };

  const run = () => {
    cancelAnimationFrame(frame.current);
    const tick = (now: number) => {
      const s = sim.current;
      if (s.mode === 'tween' && s.tween) {
        const k = Math.min(1, (now - s.tween.start) / s.tween.duration);
        // Fast spin that winds down and rocks onto the face, like a reel stopping.
        const ease = 1 + 2.2 * Math.pow(k - 1, 3) + 1.2 * Math.pow(k - 1, 2);
        s.pos = s.tween.from + (s.tween.to - s.tween.from) * ease;
        paint();
        if (k >= 1) { settle(); return; }
      } else if (s.mode === 'coast') {
        s.pos += s.v;
        s.v *= 0.94;
        paint();
        if (Math.abs(s.v) < 0.03) { s.mode = 'snap'; s.target = Math.round(s.pos); }
      } else if (s.mode === 'snap') {
        s.v = (s.v + (s.target - s.pos) * 0.11) * 0.74;
        s.pos += s.v;
        paint();
        if (Math.abs(s.target - s.pos) < 0.002 && Math.abs(s.v) < 0.002) { settle(); return; }
      } else {
        return;
      }
      frame.current = requestAnimationFrame(tick);
    };
    frame.current = requestAnimationFrame(tick);
  };

  const snapTo = (target: number) => {
    const s = sim.current;
    s.mode = 'snap';
    s.target = target;
    run();
  };

  const interact = () => { if (!touched) setTouched(true); if (sim.current.mode === 'tween') sim.current.mode = 'idle'; };

  // Opening spin: a few turns of the reel, landing on the current appearance.
  useEffect(() => {
    const s = sim.current;
    const to = initial === 'night' ? 1 : 0;
    paint();
    if (prefersReducedMotion()) return undefined;
    s.pos = to - 10;
    paint();
    const timer = window.setTimeout(() => {
      if (s.mode !== 'idle') return;
      s.mode = 'tween';
      s.tween = { from: s.pos, to, start: performance.now(), duration: 1900 };
      run();
    }, 900);
    return () => { clearTimeout(timer); cancelAnimationFrame(frame.current); };
    // Runs once, on arrival.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  // Scrolling anywhere on the page spins the reel.
  useEffect(() => {
    if (leaving) return undefined;
    const onWheel = (event: WheelEvent) => {
      event.preventDefault();
      interact();
      const s = sim.current;
      if (s.mode === 'drag') return;
      cancelAnimationFrame(frame.current);
      const unit = event.deltaMode === 1 ? 0.34 : event.deltaMode === 2 ? 1 : 0.0105;
      s.pos += Math.max(-0.9, Math.min(0.9, event.deltaY * unit));
      s.mode = 'wheel';
      s.v = 0;
      paint();
      clearTimeout(wheelTimer.current);
      wheelTimer.current = window.setTimeout(() => snapTo(Math.round(sim.current.pos)), 130);
    };
    window.addEventListener('wheel', onWheel, { passive: false });
    return () => { window.removeEventListener('wheel', onWheel); clearTimeout(wheelTimer.current); };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [leaving, touched]);

  const faceHeight = () => (slot.current?.getBoundingClientRect().height || 60);

  function onPointerDown(event: PointerEvent<HTMLSpanElement>) {
    if (event.button !== 0) return;
    interact();
    cancelAnimationFrame(frame.current);
    event.currentTarget.setPointerCapture(event.pointerId);
    const s = sim.current;
    s.mode = 'drag';
    s.v = 0;
    s.drag = { y: event.clientY, pos: s.pos, lastY: event.clientY, lastT: performance.now() };
  }
  function onPointerMove(event: PointerEvent<HTMLSpanElement>) {
    const s = sim.current;
    if (s.mode !== 'drag' || !s.drag) return;
    const now = performance.now();
    const step = -(event.clientY - s.drag.lastY) / faceHeight();
    s.v = step / Math.max(1, now - s.drag.lastT) * 16;
    s.drag.lastY = event.clientY;
    s.drag.lastT = now;
    s.pos = s.drag.pos - (event.clientY - s.drag.y) / faceHeight();
    paint();
  }
  function onPointerUp() {
    const s = sim.current;
    if (s.mode !== 'drag' || !s.drag) return;
    const moved = Math.abs(s.drag.lastY - s.drag.y) > 4;
    s.drag = null;
    if (!moved) { s.v = 0; snapTo(Math.round(s.pos) + 1); return; } // A tap turns one face.
    s.mode = 'coast';
    s.v = Math.max(-0.8, Math.min(0.8, s.v));
    run();
  }
  function onKeyDown(event: KeyboardEvent<HTMLSpanElement>) {
    const delta = event.key === 'ArrowDown' || event.key === 'ArrowRight' ? 1 : event.key === 'ArrowUp' || event.key === 'ArrowLeft' ? -1 : 0;
    if (delta) { event.preventDefault(); interact(); snapTo(Math.round(sim.current.pos) + delta); return; }
    if (event.key === 'Enter') { event.preventDefault(); onContinue(modeAt(Math.round(sim.current.pos))); }
  }

  return (
    <div ref={scene} className="ob-theme" data-leaving={leaving || undefined} style={{ '--t': initial === 'night' ? 1 : 0 } as CSSProperties}>
      <div className="ob-theme-sky" aria-hidden="true">
        {STARS.map((star, index) => <i key={index} style={{ left: `${star.x}%`, top: `${star.y}%`, width: star.s, height: star.s, animationDelay: `${star.d}s` }} />)}
      </div>
      <div className="ob-theme-glow" aria-hidden="true" />

      <div className="ob-theme-body">
        <svg className="ob-orb" viewBox="-96 -96 192 192" aria-hidden="true">
          <defs>
            <mask id="ob-crescent" maskUnits="userSpaceOnUse" x="-120" y="-120" width="240" height="240">
              <rect x="-120" y="-120" width="240" height="240" fill="#fff" />
              <circle className="ob-orb-bite" r="50" fill="#000" />
            </mask>
          </defs>
          <g className="ob-rays">
            <g className="ob-rays-spin">
              {Array.from({ length: 12 }, (_, index) => {
                const angle = (index / 12) * Math.PI * 2;
                return <line key={index} x1={Math.cos(angle) * 66} y1={Math.sin(angle) * 66} x2={Math.cos(angle) * (index % 2 ? 80 : 88)} y2={Math.sin(angle) * (index % 2 ? 80 : 88)} />;
              })}
            </g>
          </g>
          <circle className="ob-orb-body" r="48" mask="url(#ob-crescent)" />
          <g className="ob-craters" mask="url(#ob-crescent)">
            <circle cx="-18" cy="-10" r="7" /><circle cx="-6" cy="18" r="4.5" /><circle cx="-28" cy="14" r="3" />
          </g>
        </svg>

        <h1 className="ob-theme-line" aria-label={`You seem more like a ${value} mode person.`}>
          <Words text="You seem more like a" start={0} />{' '}
          <span ref={slot} className="ob-slot" role="slider" tabIndex={0} aria-label="Appearance" aria-valuemin={0} aria-valuemax={1}
            aria-valuenow={value === 'night' ? 1 : 0} aria-valuetext={`${value} mode`}
            onPointerDown={onPointerDown} onPointerMove={onPointerMove} onPointerUp={onPointerUp} onPointerCancel={onPointerUp} onKeyDown={onKeyDown}>
            <span className="ob-slot-window" aria-hidden="true">
              <span ref={drum} className="ob-drum">
                {Array.from({ length: FACES }, (_, index) => (
                  <span key={index} className="ob-drum-face" style={{ '--k': index } as CSSProperties}>{modeAt(index)}</span>
                ))}
              </span>
            </span>
            <span className="ob-slot-line" aria-hidden="true" />
          </span>{' '}
          <Words text="mode person." start={6} />
        </h1>

        <p className="ob-theme-hint" data-hidden={touched || undefined} aria-hidden={touched}>
          <span className="ob-mouse" aria-hidden="true"><i /></span>Scroll, drag or use ↑ ↓ to spin
        </p>

        <div className="ob-theme-actions">
          <button type="button" className="ob-btn" onClick={() => onContinue(modeAt(Math.round(sim.current.pos)))} disabled={leaving}>
            <span>That’s me</span>
            <svg width="14" height="14" viewBox="0 0 14 14" fill="none" aria-hidden="true"><path d="M3 7h8M8 3.5 11.5 7 8 10.5" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" strokeLinejoin="round" /></svg>
          </button>
          <span className="ob-theme-note">Change it any time in Settings.</span>
        </div>
      </div>
    </div>
  );
}

function Words({ text, start }: { text: string; start: number }) {
  const words = text.split(' ');
  return <>{words.map((word, index) => (
    <span key={index}>
      <span className="ob-word" aria-hidden="true"><span style={{ '--w': (start + index) * 70 } as CSSProperties}>{word}</span></span>
      {index < words.length - 1 ? ' ' : null}
    </span>
  ))}</>;
}
