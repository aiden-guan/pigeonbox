import { useEffect, useId, useState, type CSSProperties } from 'react';

// Fixed seed keeps the sky stable through React renders. Independent random axes
// and minimum spacing avoid the diagonal rows produced by modular sequences.
const STARS = (() => {
  let seed = 7319;
  const random = () => {
    seed = (Math.imul(seed, 1664525) + 1013904223) >>> 0;
    return seed / 4294967296;
  };
  const stars: Array<{ x: number; y: number; size: number; delay: string }> = [];
  for (let attempt = 0; stars.length < 32 && attempt < 2000; attempt++) {
    const x = 3 + random() * 93;
    const y = 4 + random() * 90;
    // Keep the question, sun/moon and UFO readable, with stars along the sides.
    if (x > 22 && x < 78 && y > 39 && y < 79) continue;
    if (x > 40 && x < 60 && y > 20 && y < 44) continue;
    if (x > 77 && y > 11 && y < 40) continue;
    if (stars.some(s => Math.hypot((x - s.x) * 1.6, y - s.y) < 8)) continue;
    stars.push({ x, y, size: random() > .8 ? 4 : 1.2 + random() * .7, delay: `${-random() * 10}s` });
  }
  return stars;
})();

/** Small SVG silhouettes share one dot screen; only their transforms and opacity move. */
export function ThemeSky({ leaving }: { leaving: boolean }) {
  const id = useId().replace(/:/g, '');
  const [hidden, setHidden] = useState(() => document.hidden);
  useEffect(() => {
    const update = () => setHidden(document.hidden);
    document.addEventListener('visibilitychange', update);
    return () => document.removeEventListener('visibilitychange', update);
  }, []);
  const dots = `url(#${id}-dots)`;
  return (
    <div className="ob-sky-art" aria-hidden="true" data-paused={hidden || leaving || undefined}>
      <svg className="ob-sky-defs" width="0" height="0" aria-hidden="true">
        <defs>
          <pattern id={`${id}-screen`} width="3.8" height="3.8" patternUnits="userSpaceOnUse">
            <circle cx="1.9" cy="1.9" r="1.15" fill="white" />
          </pattern>
          <mask id={`${id}-dots`} x="-100" y="-100" width="920" height="580" maskUnits="userSpaceOnUse">
            <rect x="-100" y="-100" width="920" height="580" fill={`url(#${id}-screen)`} />
          </mask>
          <linearGradient id={`${id}-beam-fade`} x1="0" y1="0" x2="0" y2="1">
            <stop stopColor="#a9d997" stopOpacity=".65" />
            <stop offset="1" stopColor="#a9d997" stopOpacity=".06" />
          </linearGradient>
        </defs>
      </svg>

      <div className="ob-sky-day">
        <svg className="ob-sky-sprite ob-sky-cloud ob-sky-cloud-back" viewBox="-25 -25 125 85" fill="#a5b9bf" focusable="false">
          <g className="ob-sky-cloud-drift" mask={dots}>
            <path d="M0 22C-8 22-9 8 1 7C1-8 22-13 30 0C42-7 55 0 55 12C70 10 75 29 61 31H2Z" />
          </g>
        </svg>
        <svg className="ob-sky-sprite ob-sky-cloud ob-sky-cloud-front" viewBox="-25 -25 125 85" fill="#d1b6a0" focusable="false">
          <g className="ob-sky-cloud-drift" mask={dots}><path d="M0 18C-4 8 4 1 13 4C17-15 44-17 52 2C66-3 76 6 73 17C86 17 86 32 72 32H7C-3 32-7 22 0 18Z" /></g>
        </svg>
        {[{ x: 14, y: 17, s: 1, d: '-2s' }, { x: 20, y: 23, s: .72, d: '-5s' }, { x: 23, y: 80, s: .55, d: '-8s' }].map((bird, i) => (
          <svg key={i} className="ob-sky-sprite ob-sky-bird-sprite" viewBox="-70 -40 140 80" focusable="false" style={{ left: `${bird.x}%`, top: `${bird.y}%`, '--bird-scale': bird.s } as CSSProperties}>
            <g className="ob-sky-bird" style={{ '--bird-delay': bird.d } as CSSProperties} fill="#737f79">
              <g mask={dots}>
                <g className="ob-sky-wings">
                  <path d="M0 2C-11-17-31-19-42-12C-24-13-15-2-5 7L0 4Z" />
                  <path d="M0 2C11-17 31-19 42-12C24-13 15-2 5 7L0 4Z" />
                </g>
                <ellipse cy="5" rx="6" ry="4" /><path d="M4 4 12 5 4 7ZM-3 7-10 13 1 10Z" />
              </g>
            </g>
          </svg>
        ))}
        <svg className="ob-sky-sprite ob-sky-kite-sprite" viewBox="-65 -65 130 265" focusable="false">
          <g className="ob-sky-kite">
            <g mask={dots}>
              <path d="M0-38 30-2 0 42-30-2Z" fill="#c68162" />
              <path d="M0-38V42L30-2Z" fill="#e8b16b" />
              <path d="M0-38V42M-30-2H30" fill="none" stroke="#9b654e" strokeWidth="2.5" />
              <path d="M0 42C-23 68 22 83 0 111C-16 133-8 149-20 165" fill="none" stroke="#af9581" strokeWidth="2.8" />
              <path d="M-5 68-16 61-17 74ZM-5 68 7 62 7 76ZM5 99-6 92-7 106ZM5 99 17 93 16 107ZM-11 133-22 126-22 140ZM-11 133 1 128 0 142Z" fill="#bd8069" />
            </g>
          </g>
        </svg>
      </div>

      <div className="ob-sky-night">
        {STARS.map((star, i) => (
          <svg key={i} className="ob-sky-sprite ob-sky-star-sprite" viewBox="-7 -7 14 14" focusable="false" style={{ left: `${star.x}%`, top: `${star.y}%` }}>
            <g className="ob-sky-star" style={{ animationDelay: star.delay }} fill="#bac8df">
              {star.size === 4 ? <path d="M0-5 1.7-1.7 5 0 1.7 1.7 0 5-1.7 1.7-5 0-1.7-1.7Z" mask={dots} /> : <circle r={star.size} />}
            </g>
          </svg>
        ))}
        {[{ x: 27, y: 12, delay: '-3s' }, { x: 67, y: 84, delay: '-10s' }].map((star, i) => (
          <svg key={i} className="ob-sky-sprite ob-sky-meteor-sprite" viewBox="-70 -35 230 125" focusable="false" style={{ left: `${star.x}%`, top: `${star.y}%` }}>
            <g className="ob-sky-meteor" style={{ animationDelay: star.delay }}>
              {Array.from({ length: 15 }, (_, j) => <circle key={j} cx={-j * 4} cy={-j * 2} r={1.8 - j * .07} fill="#d3dded" opacity={1 - j / 15} />)}
            </g>
          </svg>
        ))}
        <svg className="ob-sky-sprite ob-sky-ufo-sprite" viewBox="-95 -55 190 235" focusable="false">
          <g className="ob-sky-ufo">
            <g className="ob-sky-beam" mask={dots}>
              <path d="M-13 17 13 17 64 148-64 148Z" fill={`url(#${id}-beam-fade)`} />
              <ellipse cy="148" rx="60" ry="7" fill="#a9d997" opacity=".12" />
            </g>
            <g className="ob-sky-passenger" fill="#b6d79e" mask={dots}>
              <circle cy="112" r="5" /><path d="M-4 120H4L6 135H-6ZM-4 132-9 145H-5L0 136 5 145H9L4 132ZM-4 121-14 116-16 119-5 128ZM4 121 14 116 16 119 5 128Z" />
            </g>
            <g mask={dots}>
              <path d="M-23 0C-22-35 22-35 23 0Z" fill="#a2b8c5" />
              <path d="M-13-5C-12-22 5-28 12-15C3-21-5-16-6-5Z" fill="#d1dce1" />
              <ellipse rx="46" ry="13" fill="#8997b1" />
              <path d="M-44 2Q0 22 44 2Q32 23 0 23Q-32 23-44 2Z" fill="#616f88" />
              <ellipse cy="21" rx="14" ry="4" fill="#a9d997" />
              {[-29, -14, 0, 14, 29].map((x) => <circle key={x} cx={x} cy="5" r="3.5" fill="#d3deb0" />)}
            </g>
          </g>
        </svg>
      </div>
    </div>
  );
}

/** The sun/moon remains anchored above the question while the sky fills the viewport. */
export function ThemeOrb() {
  const id = useId().replace(/:/g, '');
  const dots = `url(#${id}-orb-dots)`;
  const crescent = `url(#${id}-orb-crescent)`;
  return (
    <svg className="ob-sky-orb" viewBox="-96 -96 192 192" aria-hidden="true" focusable="false">
      <defs>
        <pattern id={`${id}-orb-screen`} width="3.8" height="3.8" patternUnits="userSpaceOnUse"><circle cx="1.9" cy="1.9" r="1.15" fill="white" /></pattern>
        <mask id={`${id}-orb-dots`} x="-100" y="-100" width="200" height="200" maskUnits="userSpaceOnUse"><rect x="-100" y="-100" width="200" height="200" fill={`url(#${id}-orb-screen)`} /></mask>
        <mask id={`${id}-orb-crescent`} x="-90" y="-90" width="180" height="180" maskUnits="userSpaceOnUse"><rect x="-90" y="-90" width="180" height="180" fill="white" /><circle className="ob-orb-bite" r="50" fill="black" /></mask>
      </defs>
      <g>
        <g mask={dots}>
          <g className="ob-rays">
            <g className="ob-rays-spin">
              {Array.from({ length: 12 }, (_, i) => {
                const a = i * Math.PI / 6;
                return <line key={i} x1={Math.cos(a) * 66} y1={Math.sin(a) * 66} x2={Math.cos(a) * (i % 2 ? 80 : 88)} y2={Math.sin(a) * (i % 2 ? 80 : 88)} />;
              })}
            </g>
          </g>
          <g mask={crescent}>
            <circle className="ob-orb-body" r="48" />
            <g className="ob-craters"><circle cx="-18" cy="-10" r="7" /><circle cx="-6" cy="18" r="4.5" /><circle cx="-28" cy="14" r="3" /></g>
          </g>
        </g>
      </g>
    </svg>
  );
}
