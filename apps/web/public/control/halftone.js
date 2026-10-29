// Halftone printing for the control plane.
// A scene paints tone into a tiny buffer, one pixel per dot: red is ink
// density, green marks copper accent dots. The field prints that as dots in
// the theme's ink, with an optional pointer "flashlight" on fine pointers.
//
// Unlike the website's always-on scenes, nothing here runs a permanent loop:
// a scene asks for frames only while something is moving (an intro, a parcel
// on its way, the flashlight fading), and it stops when hidden, off screen,
// or under reduced motion. Fields are destroyed when their page goes away.
import { finePointer, onPreferenceChange, reduced } from './motion.js';
import { postmarkDate } from './ui.js';

const TAU = Math.PI * 2;
const ink = (v) => `rgb(${Math.round(Math.min(1, Math.max(0, v)) * 255)},0,0)`;
const acc = (v) => `rgb(0,${Math.round(Math.min(1, Math.max(0, v)) * 255)},0)`;
const CUT = 'rgb(0,0,0)';
const MONO = 'ui-monospace, Menlo, monospace';
const SERIF = 'ui-serif, Georgia, serif';

// Pidgy as ink density: the approved atlas geometry at 48px cells, 4 frames × 13 rows.
const INK_CELL = 48;
const PIDGY_INK = new Image();
PIDGY_INK.decoding = 'async';
PIDGY_INK.src = new URL('./assets/pidgy-ink.webp', import.meta.url).href;
export const PIDGY_ROWS = { idle: 0, alert: 4, tea: 5, sleep: 6, parcel: 7, wave: 9, stars: 10, map: 11, lantern: 12 };

/** Print Pidgy standing on `ground` at x, `height` px tall. */
function printPidgy(ctx, x, ground, height, row = 0, frame = 0) {
  if (!PIDGY_INK.complete || !PIDGY_INK.naturalWidth) return;
  const size = (height * 96) / 56;
  ctx.save();
  ctx.translate(x, ground);
  ctx.imageSmoothingEnabled = true;
  ctx.drawImage(PIDGY_INK, frame * INK_CELL, row * INK_CELL, INK_CELL, INK_CELL, (-size * 44) / 96, (-size * 92) / 96, size, size);
  ctx.restore();
}

function envelope(ctx, x, y, w, v, accent = false) {
  const hgt = w * 0.64;
  ctx.fillStyle = accent ? acc(v * 0.3) : ink(v * 0.22);
  ctx.fillRect(x - w / 2, y - hgt / 2, w, hgt);
  ctx.strokeStyle = accent ? acc(v) : ink(v);
  ctx.lineWidth = 4;
  ctx.strokeRect(x - w / 2, y - hgt / 2, w, hgt);
  ctx.beginPath();
  ctx.moveTo(x - w / 2, y - hgt / 2);
  ctx.lineTo(x, y + hgt * 0.08);
  ctx.lineTo(x + w / 2, y - hgt / 2);
  ctx.stroke();
}

function ringText(ctx, cx, cy, r, text, size, fill) {
  ctx.fillStyle = fill;
  ctx.font = `600 ${size}px ${MONO}`;
  ctx.textAlign = 'center';
  ctx.textBaseline = 'middle';
  const step = TAU / text.length;
  for (let i = 0; i < text.length; i += 1) {
    const a = -Math.PI / 2 + i * step;
    ctx.save();
    ctx.translate(cx + Math.cos(a) * r, cy + Math.sin(a) * r);
    ctx.rotate(a + Math.PI / 2);
    ctx.fillText(text[i], 0, 0);
    ctx.restore();
  }
}

function postmark(ctx, cx, cy, R, { ring, center, word, accent = true, v = 1 }) {
  ctx.strokeStyle = ink(v);
  ctx.lineWidth = 5;
  ctx.beginPath(); ctx.arc(cx, cy, R, 0, TAU); ctx.stroke();
  ctx.lineWidth = 3;
  ctx.beginPath(); ctx.arc(cx, cy, R * 0.72, 0, TAU); ctx.stroke();
  ringText(ctx, cx, cy, R * 0.86, ring, R * 0.13, ink(v));
  ctx.textAlign = 'center';
  ctx.textBaseline = 'middle';
  if (center) {
    ctx.fillStyle = ink(v);
    ctx.font = `600 ${R * 0.15}px ${MONO}`;
    ctx.fillText(center, cx, cy - R * 0.16);
  }
  if (word) {
    ctx.fillStyle = accent ? acc(1) : ink(v);
    ctx.font = `400 ${R * 0.27}px ${SERIF}`;
    ctx.fillText(word, cx, cy + R * 0.14);
  }
}

function waves(ctx, x0, x1, y, rows, gap, v) {
  ctx.lineWidth = 4;
  for (let k = 0; k < rows; k += 1) {
    ctx.beginPath();
    for (let x = x0; x <= x1; x += 4) {
      const fade = Math.min(1, (x - x0) / Math.max(1, (x1 - x0) * 0.55));
      const yy = y + k * gap + Math.sin(x / 22 + k * 0.7) * gap * 0.22;
      ctx.strokeStyle = ink(v * fade);
      if (x === x0) ctx.moveTo(x, yy);
      else ctx.lineTo(x, yy);
    }
    ctx.stroke();
  }
}

// ---------------------------------------------------------------------------
// Field
// ---------------------------------------------------------------------------

const fields = new Set();

function readColors(canvas) {
  const style = getComputedStyle(canvas);
  const triplet = (name, fallback) => (style.getPropertyValue(name).trim() || fallback).split(',').map((part) => Number(part.trim()));
  return { color: triplet('--ht-ink', '24, 25, 27'), accent: triplet('--ht-accent', '168, 80, 44') };
}

export function createField(canvas, scene) {
  const opts = { cell: 6, dot: 0.4, alphas: [0.14, 0.38, 0.78], flashlight: 0.7, radius: 90, fps: 40, ...scene.options };
  const ctx = canvas.getContext('2d');
  const low = document.createElement('canvas');
  const lctx = low.getContext('2d', { willReadFrequently: true });
  const base = document.createElement('canvas');
  const bctx = base.getContext('2d');
  const state = { W: 0, H: 0, cols: 0, rows: 0, cell: opts.cell, dpr: 1, t: 0, pointer: null, glow: 0, running: false, visible: false, last: 0, colors: readColors(canvas) };
  let raf = 0;
  let built = false;
  let alive = true;

  const fit = () => {
    const rect = canvas.getBoundingClientRect();
    const W = Math.max(1, Math.round(rect.width));
    const H = Math.max(1, Math.round(rect.height));
    if (W === state.W && H === state.H && built) return;
    state.W = W;
    state.H = H;
    state.cell = typeof opts.cell === 'function' ? opts.cell(W, H) : opts.cell;
    state.dpr = Math.min(2, window.devicePixelRatio || 1);
    canvas.width = Math.round(W * state.dpr);
    canvas.height = Math.round(H * state.dpr);
    state.cols = Math.ceil(W / state.cell);
    state.rows = Math.ceil(H / state.cell);
    low.width = base.width = state.cols;
    low.height = base.height = state.rows;
    bctx.setTransform(1, 0, 0, 1, 0, 0);
    bctx.fillStyle = CUT;
    bctx.fillRect(0, 0, state.cols, state.rows);
    bctx.setTransform(1 / state.cell, 0, 0, 1 / state.cell, 0, 0);
    scene.build?.(bctx, W, H, state);
    built = true;
  };

  const paint = () => {
    const { W, H, cols, rows, cell, dpr } = state;
    if (!cols || !rows) return;
    lctx.setTransform(1, 0, 0, 1, 0, 0);
    lctx.globalCompositeOperation = 'source-over';
    lctx.fillStyle = CUT;
    lctx.fillRect(0, 0, cols, rows);
    lctx.drawImage(base, 0, 0);
    lctx.setTransform(1 / cell, 0, 0, 1 / cell, 0, 0);
    lctx.globalCompositeOperation = 'lighten';
    scene.frame?.(lctx, W, H, state.t, state);
    const px = lctx.getImageData(0, 0, cols, rows).data;

    ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
    ctx.clearRect(0, 0, W, H);
    const paths = [new Path2D(), new Path2D(), new Path2D(), new Path2D(), new Path2D(), new Path2D()];
    const rMax = cell * opts.dot;
    const p = state.pointer;
    const R = opts.radius;
    const glow = state.glow * opts.flashlight;
    for (let y = 0; y < rows; y += 1) {
      const cy = (y + 0.5) * cell;
      for (let x = 0; x < cols; x += 1) {
        const i = (y * cols + x) * 4;
        const r = px[i];
        const g = px[i + 1];
        let v = Math.max(r, g) / 255;
        const cx = (x + 0.5) * cell;
        if (glow && p) {
          const dx = cx - p.x;
          const dy = cy - p.y;
          const d2 = dx * dx + dy * dy;
          if (d2 < R * R) {
            const f = 1 - Math.sqrt(d2) / R;
            v = Math.min(1, v + f * f * glow * (v > 0.05 ? 0.55 : 0.28));
          }
        }
        if (v < 0.06) continue;
        const accent = g > r + 8 ? 3 : 0;
        const bucket = v < 0.36 ? 0 : v < 0.7 ? 1 : 2;
        const rad = rMax * (0.5 + 0.5 * Math.sqrt(v));
        const path = paths[accent + bucket];
        path.moveTo(cx + rad, cy);
        path.arc(cx, cy, rad, 0, TAU);
      }
    }
    const { color, accent } = state.colors;
    for (let k = 0; k < 6; k += 1) {
      const [cr, cg, cb] = k < 3 ? color : accent;
      ctx.fillStyle = `rgba(${cr},${cg},${cb},${opts.alphas[k % 3]})`;
      ctx.fill(paths[k]);
    }
  };

  const busy = () => state.glow > 0.001 || Boolean(scene.animating?.(state));

  const tick = (now) => {
    raf = 0;
    if (!state.running || !alive) return;
    const dt = Math.min(0.1, (now - (state.last || now)) / 1000);
    if (!state.last || now - state.last >= 1000 / opts.fps - 2) {
      state.t += dt;
      state.last = now;
      if (state.pointer && finePointer() && !reduced()) state.glow = Math.min(1, state.glow + dt * 5);
      else state.glow = Math.max(0, state.glow - dt * 3);
      scene.update?.(dt, state);
      paint();
    }
    if (busy()) raf = requestAnimationFrame(tick);
    else {
      state.running = false;
      state.last = 0;
    }
  };

  /** Ask for frames until the scene settles. */
  const wake = () => {
    if (!alive || state.running || !state.visible || document.hidden || reduced()) return;
    state.running = true;
    state.last = 0;
    raf = requestAnimationFrame(tick);
  };
  const sleep = () => {
    state.running = false;
    cancelAnimationFrame(raf);
    raf = 0;
  };
  const render = (rebuild = false) => {
    if (!alive) return;
    if (rebuild) built = false;
    fit();
    paint();
  };

  const host = canvas.parentElement;
  const move = (event) => {
    if (!finePointer() || reduced()) return;
    const rect = canvas.getBoundingClientRect();
    state.pointer = { x: event.clientX - rect.left, y: event.clientY - rect.top };
    wake();
  };
  const out = () => {
    state.pointer = null;
    wake();
  };
  if (opts.flashlight) {
    host.addEventListener('pointermove', move, { passive: true });
    host.addEventListener('pointerleave', out);
  }
  const visibility = () => (document.hidden ? sleep() : wake());
  document.addEventListener('visibilitychange', visibility);
  let resizeTimer = 0;
  const resize = new ResizeObserver(() => {
    clearTimeout(resizeTimer);
    resizeTimer = setTimeout(() => render(true), 120);
  });
  resize.observe(canvas);
  const seen = new IntersectionObserver(([entry]) => {
    state.visible = entry.isIntersecting;
    if (entry.isIntersecting) wake();
    else sleep();
  });
  seen.observe(canvas);

  const field = {
    state,
    scene,
    canvas,
    render,
    wake,
    recolor() {
      state.colors = readColors(canvas);
      render();
    },
    destroy() {
      alive = false;
      sleep();
      clearTimeout(resizeTimer);
      resize.disconnect();
      seen.disconnect();
      document.removeEventListener('visibilitychange', visibility);
      host?.removeEventListener('pointermove', move);
      host?.removeEventListener('pointerleave', out);
      fields.delete(field);
    },
  };
  scene.attach?.(field);
  fields.add(field);
  render();
  setTimeout(() => canvas.classList.add('is-ready'), 40);
  return field;
}

// ---------------------------------------------------------------------------
// Scene: dispatch (Overview). Real state picks the bird and the route.
// ---------------------------------------------------------------------------

/**
 * tone: 'clear' | 'attention' | 'quiet'. stops: how many stages the route
 * passes (the Overview's route strip). A parcel travels the route now and then
 * when everything is clear; a held route shows its break instead.
 */
export function dispatch({ tone = 'clear', stops = 4 } = {}) {
  let route = [];
  let bird = null;
  let breakAt = null;
  let intro = 0;
  let parcel = null;
  let nextParcel = 2.2;
  let arrived = -10;
  const INTRO = 1.6;
  const TRIP = 2.6;
  const GAP = 11;

  const along = (p) => {
    const at = Math.max(0, Math.min(route.length - 1, p * (route.length - 1)));
    const i = Math.floor(at);
    const f = at - i;
    const a = route[i];
    const b = route[Math.min(route.length - 1, i + 1)];
    return { x: a.x + (b.x - a.x) * f, y: a.y + (b.y - a.y) * f };
  };

  return {
    options: { cell: (W) => (W < 420 ? 4 : 5), dot: 0.42, alphas: [0.12, 0.34, 0.78], flashlight: 0.75, radius: 100, fps: 40 },
    build(ctx, W, H) {
      // Postmark top right; Pidgy standing clear of it at the end of the route.
      const R = Math.min(H * 0.34, W * 0.15, 76);
      const cx = W - R - 10;
      const cy = R + 6;
      postmark(ctx, cx, cy, R, { ring: 'PIGEONBOX PRO · DISPATCH · ', center: postmarkDate(), word: tone === 'attention' ? 'Held' : tone === 'quiet' ? 'Resting' : 'Clear', accent: tone !== 'quiet' });
      bird = { height: Math.min(H * 0.5, 92) };
      bird.ground = H - 4;
      bird.x = Math.min(cx - R - bird.height * 0.55, W * 0.74);
      // Cancellation waves stay above the bird's head.
      waves(ctx, W * 0.16, cx - R * 1.1, cy - R * 0.62, 4, Math.min(R * 0.2, (bird.ground - bird.height - cy + R * 0.62) / 4.5), 0.6);

      // The route: from the left margin, low across the sheet, to Pidgy's feet.
      const y0 = H * 0.86;
      const x0 = W * 0.04;
      const x1 = bird.x - bird.height * 0.45;
      route = [];
      for (let k = 0; k <= 48; k += 1) {
        const p = k / 48;
        route.push({ x: x0 + (x1 - x0) * p, y: y0 - Math.sin(p * Math.PI) * H * 0.12 + Math.sin(p * 9) * 2 });
      }
      breakAt = tone === 'attention' ? 0.62 : null;
    },
    frame(ctx, W, H, t) {
      intro = reduced() ? 1 : Math.min(1, t / INTRO);
      const drawn = 1 - (1 - intro) ** 3;
      // Dotted route, drawn in.
      for (let k = 0; k < route.length; k += 1) {
        const p = k / (route.length - 1);
        if (p > drawn) break;
        if (breakAt !== null && Math.abs(p - breakAt) < 0.035) continue;
        if (k % 2) continue;
        const { x, y } = route[k];
        ctx.fillStyle = breakAt !== null && p > breakAt ? ink(0.35) : ink(0.9);
        ctx.fillRect(x - 3, y - 3, 6, 6);
      }
      // Stops along the route.
      for (let s = 0; s < stops; s += 1) {
        const p = stops === 1 ? 0.5 : s / (stops - 1);
        if (p > drawn + 0.001) continue;
        const { x, y } = along(p * 0.96);
        const held = breakAt !== null && p > breakAt;
        ctx.fillStyle = held ? ink(0.5) : acc(1);
        ctx.beginPath(); ctx.arc(x, y, 9, 0, TAU); ctx.fill();
        ctx.fillStyle = CUT;
        ctx.beginPath(); ctx.arc(x, y, 4, 0, TAU); ctx.fill();
      }
      if (breakAt !== null && drawn > breakAt) {
        const { x, y } = along(breakAt);
        const pulse = 0.65 + 0.35 * Math.sin(t * 5);
        ctx.strokeStyle = acc(t < INTRO + 2.4 ? pulse : 0.9);
        ctx.lineWidth = 5;
        ctx.beginPath(); ctx.moveTo(x - 9, y - 9); ctx.lineTo(x + 9, y + 9); ctx.moveTo(x + 9, y - 9); ctx.lineTo(x - 9, y + 9); ctx.stroke();
      }
      // A parcel on its way, with a fading wake.
      if (parcel) {
        const e = parcel.p < 0.5 ? 2 * parcel.p * parcel.p : 1 - (-2 * parcel.p + 2) ** 2 / 2;
        for (let k = 1; k <= 7; k += 1) {
          const back = Math.max(0, e - k * 0.025);
          const { x, y } = along(back);
          ctx.fillStyle = acc(0.55 * (1 - k / 8));
          ctx.fillRect(x - 3, y - 3, 6, 6);
        }
        const { x, y } = along(e);
        envelope(ctx, x, y - 14, 26, 1, true);
      }
      if (t - arrived < 1.1) {
        const k = (t - arrived) / 1.1;
        ctx.strokeStyle = acc(1 - k);
        ctx.lineWidth = 5;
        ctx.beginPath(); ctx.arc(bird.x, bird.ground - bird.height * 0.55, 18 + k * 46, 0, TAU); ctx.stroke();
      }
      const row = tone === 'attention' ? PIDGY_ROWS.alert : tone === 'quiet' ? PIDGY_ROWS.sleep : PIDGY_ROWS.idle;
      const blinking = t - arrived < 0.9 ? Math.floor((t - arrived) * 6) % 4 : 0;
      printPidgy(ctx, bird.x, bird.ground, bird.height, row, tone === 'clear' ? blinking : 0);
    },
    update(dt, state) {
      if (tone !== 'clear' || state.t < INTRO) return;
      if (parcel) {
        parcel.p += dt / TRIP;
        if (parcel.p >= 1) {
          parcel = null;
          arrived = state.t;
          nextParcel = state.t + GAP;
        }
      } else if (state.t >= nextParcel) parcel = { p: 0 };
    },
    animating(state) {
      if (state.t < INTRO + (tone === 'attention' ? 2.4 : 0)) return true;
      if (parcel || state.t - arrived < 1.2) return true;
      return false;
    },
    attach(field) {
      // Between trips nothing repaints: scene time advances on a slow timer
      // while the field sleeps, and wakes it when the next parcel is due.
      if (tone !== 'clear') return;
      const timer = setInterval(() => {
        if (!field.canvas.isConnected) return clearInterval(timer);
        const { state } = field;
        if (state.running || !state.visible || document.hidden || reduced() || state.t < INTRO) return;
        state.t += 1;
        if (state.t >= nextParcel) field.wake();
      }, 1_000);
    },
  };
}

// ---------------------------------------------------------------------------
// Masthead glyphs: one quiet, static print per section.
// ---------------------------------------------------------------------------

const quiet = { cell: 5, dot: 0.42, alphas: [0.1, 0.26, 0.55], flashlight: 0.8, radius: 70 };

function glyph(draw, ring) {
  return () => ({
    options: quiet,
    build(ctx, W, H) {
      const R = Math.min(H * 0.42, 52);
      const cx = W - R - 8;
      const cy = H * 0.48;
      ctx.strokeStyle = ink(0.5);
      ctx.lineWidth = 3;
      ctx.beginPath(); ctx.arc(cx, cy, R, 0, TAU); ctx.stroke();
      ringText(ctx, cx, cy, R * 0.82, ring, R * 0.15, ink(0.5));
      waves(ctx, W * 0.1, cx - R * 1.05, cy - R * 0.45, 4, R * 0.3, 0.32);
      draw(ctx, W, H, { x: W * 0.52, y: H * 0.52, s: Math.min(H * 0.62, 80), cx, cy, R });
    },
  });
}

const GLYPHS = {
  account: glyph((ctx, W, H, { x, y, s }) => {
    const w = s * 0.7;
    const top = y - s * 0.55;
    ctx.fillStyle = ink(0.16);
    ctx.fillRect(x - w / 2, top, w, s * 1.05);
    ctx.strokeStyle = ink(0.85); ctx.lineWidth = 4;
    ctx.beginPath(); ctx.moveTo(x - w / 2, top + s * 1.05); ctx.lineTo(x - w / 2, top); ctx.lineTo(x + w / 2, top); ctx.lineTo(x + w / 2, top + s * 1.05); ctx.stroke();
    ctx.beginPath();
    for (let k = 0; k <= 8; k += 1) ctx.lineTo(x - w / 2 + (w * k) / 8, top + s * 1.05 + (k % 2 ? 6 : 0));
    ctx.stroke();
    for (let k = 0; k < 4; k += 1) { ctx.fillStyle = ink(0.6); ctx.fillRect(x - w * 0.36, top + s * (0.18 + k * 0.16), w * (k === 3 ? 0.3 : 0.55), 4); }
    ctx.fillStyle = acc(1); ctx.fillRect(x + w * 0.04, top + s * 0.82, w * 0.32, 6);
  }, 'ACCOUNT · LEDGER · '),
  connections: glyph((ctx, W, H, { x, y, s }) => {
    envelope(ctx, x - s * 0.95, y + s * 0.05, s * 0.5, 0.9);
    ctx.strokeStyle = ink(0.8); ctx.lineWidth = 4;
    ctx.strokeRect(x + s * 0.55, y - s * 0.22, s * 0.42, s * 0.5);
    ctx.beginPath(); ctx.moveTo(x + s * 0.5, y - s * 0.2); ctx.lineTo(x + s * 0.76, y - s * 0.46); ctx.lineTo(x + s * 1.02, y - s * 0.2); ctx.stroke();
    for (let k = 0; k <= 20; k += 1) {
      const p = k / 20;
      const px = x - s * 0.66 + p * s * 1.18;
      const py = y - Math.sin(p * Math.PI) * s * 0.42;
      ctx.fillStyle = k % 5 === 0 ? acc(1) : ink(0.75);
      ctx.fillRect(px - 2.5, py - 2.5, 5, 5);
    }
  }, 'MAIL ROUTES · GMAIL · '),
  privacy: glyph((ctx, W, H, { x, y, s }) => {
    const w = s * 1.25; const hgt = w * 0.62;
    ctx.strokeStyle = ink(0.85); ctx.lineWidth = 4;
    ctx.strokeRect(x - w / 2, y - hgt / 2, w, hgt);
    ctx.beginPath(); ctx.moveTo(x - w / 2, y - hgt / 2); ctx.lineTo(x, y + hgt * 0.1); ctx.lineTo(x + w / 2, y - hgt / 2); ctx.stroke();
    ctx.fillStyle = acc(1);
    ctx.beginPath();
    for (let a = 0, k = 0; a <= TAU + 0.01; a += TAU / 16, k += 1) {
      const rr = s * 0.17 * (k % 2 ? 1.08 : 0.94);
      ctx.lineTo(x + Math.cos(a) * rr, y + hgt * 0.1 + Math.sin(a) * rr);
    }
    ctx.fill();
    ctx.fillStyle = CUT; ctx.font = `600 ${s * 0.15}px ${SERIF}`; ctx.textAlign = 'center'; ctx.textBaseline = 'middle';
    ctx.fillText('PB', x, y + hgt * 0.1 + 1);
  }, 'SEALED · ENCRYPTED · '),
  memory: glyph((ctx, W, H, { x, y, s }) => {
    const cards = [[-0.75, -0.25], [-0.05, -0.45], [0.55, -0.05], [-0.3, 0.32]];
    const holes = [];
    cards.forEach(([dx, dy], k) => {
      const cx = x + dx * s; const cy = y + dy * s; const w = s * 0.56; const hgt = s * 0.36;
      ctx.fillStyle = ink(0.14); ctx.fillRect(cx - w / 2, cy - hgt / 2, w, hgt);
      ctx.strokeStyle = ink(0.75); ctx.lineWidth = 3; ctx.strokeRect(cx - w / 2, cy - hgt / 2, w, hgt);
      ctx.fillStyle = ink(0.5); ctx.fillRect(cx - w * 0.36, cy, w * 0.6, 3);
      holes.push([cx - w * 0.36, cy - hgt * 0.22, k === 1]);
    });
    ctx.strokeStyle = acc(0.9); ctx.lineWidth = 3;
    ctx.beginPath(); holes.forEach(([hx, hy], k) => (k ? ctx.lineTo(hx, hy) : ctx.moveTo(hx, hy))); ctx.stroke();
    for (const [hx, hy] of holes) { ctx.fillStyle = acc(1); ctx.beginPath(); ctx.arc(hx, hy, 5, 0, TAU); ctx.fill(); }
  }, 'MEMORY · INDEX · '),
  activity: glyph((ctx, W, H, { x, y, s }) => {
    const x0 = x - s * 0.9;
    ctx.strokeStyle = ink(0.6); ctx.lineWidth = 3;
    ctx.beginPath(); ctx.moveTo(x0, y - s * 0.55); ctx.lineTo(x0, y + s * 0.55); ctx.stroke();
    for (let k = 0; k < 5; k += 1) {
      const yy = y - s * 0.45 + k * s * 0.22;
      ctx.fillStyle = k === 0 ? acc(1) : ink(0.8);
      ctx.beginPath(); ctx.arc(x0, yy, 6, 0, TAU); ctx.fill();
      ctx.fillStyle = ink(k === 0 ? 0.9 : 0.45);
      ctx.fillRect(x0 + 16, yy - 2, s * (0.7 + ((k * 37) % 10) / 14), 4);
    }
  }, 'DISPATCH LOG · '),
  approvals: glyph((ctx, W, H, { x, y, s }) => {
    envelope(ctx, x - s * 0.1, y + s * 0.05, s * 1.25, 0.85);
    const sx = x + s * 0.32; const sy = y - s * 0.18;
    ctx.strokeStyle = acc(1); ctx.lineWidth = 4; ctx.strokeRect(sx, sy, s * 0.3, s * 0.34);
    ctx.fillStyle = acc(0.5); ctx.fillRect(sx + 6, sy + 6, s * 0.3 - 12, s * 0.34 - 12);
  }, 'AWAITING YOUR SAY · '),
  automations: glyph((ctx, W, H, { x, y, s }) => {
    for (let k = 0; k < 3; k += 1) {
      const ty = y - s * 0.4 + k * s * 0.34; const tx = x - s * 0.1;
      ctx.strokeStyle = ink(k === 0 ? 0.9 : 0.55); ctx.lineWidth = 4;
      ctx.beginPath(); ctx.moveTo(tx, ty); ctx.lineTo(tx, ty + s * 0.2); ctx.lineTo(tx + s * 0.75, ty + s * 0.2); ctx.lineTo(tx + s * 0.75, ty); ctx.stroke();
    }
    envelope(ctx, x - s * 0.75, y - s * 0.05, s * 0.36, 1, true);
    ctx.strokeStyle = acc(0.8); ctx.lineWidth = 3;
    ctx.beginPath(); ctx.moveTo(x - s * 0.5, y - s * 0.15); ctx.quadraticCurveTo(x - s * 0.25, y - s * 0.6, x + s * 0.25, y - s * 0.32); ctx.stroke();
  }, 'STANDING ORDERS · '),
  views: glyph((ctx, W, H, { x, y, s }) => {
    const lx = x - s * 0.1; const ly = y - s * 0.05; const R = s * 0.34;
    for (let yy = y - s * 0.5; yy < y + s * 0.5; yy += s * 0.16) {
      for (let xx = x - s * 0.95; xx < x + s * 0.8; xx += 6) {
        if (Math.sin(xx * 0.21 + yy) < -0.3) continue;
        const near = Math.hypot(xx - lx, yy - ly) < R;
        ctx.fillStyle = near ? (Math.hypot(xx - lx, yy - ly) < R * 0.5 ? acc(1) : ink(0.9)) : ink(0.25);
        ctx.fillRect(xx, yy, near ? 5 : 3, near ? 5 : 3);
      }
    }
    ctx.strokeStyle = ink(1); ctx.lineWidth = 5; ctx.beginPath(); ctx.arc(lx, ly, R, 0, TAU); ctx.stroke();
    ctx.lineWidth = 7; ctx.beginPath(); ctx.moveTo(lx + R * 0.72, ly + R * 0.72); ctx.lineTo(lx + R * 1.35, ly + R * 1.35); ctx.stroke();
  }, 'SMART VIEWS · '),
  sequences: glyph((ctx, W, H, { x, y, s }) => {
    for (let k = 0; k < 3; k += 1) envelope(ctx, x - s * 0.8 + k * s * 0.62, y - s * 0.3 + k * s * 0.24, s * 0.4, k === 2 ? 1 : 0.7, k === 2);
    ctx.strokeStyle = ink(0.5); ctx.lineWidth = 3; ctx.setLineDash([6, 8]);
    ctx.beginPath(); ctx.moveTo(x - s * 0.8, y + s * 0.2); ctx.lineTo(x + s * 0.5, y + s * 0.6); ctx.stroke(); ctx.setLineDash([]);
  }, 'SEQUENCES · STEP BY STEP · '),
  contacts: glyph((ctx, W, H, { x, y, s }) => {
    const a = [x - s * 0.62, y]; const b = [x + s * 0.5, y - s * 0.12];
    for (const [px, py] of [a, b]) {
      ctx.strokeStyle = ink(0.85); ctx.lineWidth = 4;
      ctx.beginPath(); ctx.arc(px, py - s * 0.14, s * 0.13, 0, TAU); ctx.stroke();
      ctx.beginPath(); ctx.arc(px, py + s * 0.3, s * 0.24, Math.PI * 1.05, Math.PI * 1.95); ctx.stroke();
    }
    for (let k = 1; k < 12; k += 1) { const p = k / 12; ctx.fillStyle = k === 6 ? acc(1) : ink(0.6); ctx.fillRect(a[0] + (b[0] - a[0]) * p - 2, a[1] - s * 0.1 + (b[1] - a[1]) * p - Math.sin(p * Math.PI) * s * 0.25 - 2, k === 6 ? 7 : 4, k === 6 ? 7 : 4); }
  }, 'CORRESPONDENTS · '),
  documents: glyph((ctx, W, H, { x, y, s }) => {
    const w = s * 0.72; const hgt = s * 0.95; const x0 = x - w / 2 - s * 0.2; const y0 = y - hgt / 2;
    ctx.fillStyle = ink(0.14); ctx.fillRect(x0, y0, w, hgt);
    ctx.strokeStyle = ink(0.85); ctx.lineWidth = 4;
    ctx.beginPath(); ctx.moveTo(x0, y0); ctx.lineTo(x0 + w * 0.72, y0); ctx.lineTo(x0 + w, y0 + w * 0.28); ctx.lineTo(x0 + w, y0 + hgt); ctx.lineTo(x0, y0 + hgt); ctx.closePath(); ctx.stroke();
    for (let k = 0; k < 4; k += 1) { ctx.fillStyle = ink(0.55); ctx.fillRect(x0 + w * 0.14, y0 + hgt * (0.38 + k * 0.13), w * 0.66, 4); }
    for (let k = 0; k < 4; k += 1) { ctx.fillStyle = k === 1 ? acc(1) : ink(0.6); ctx.fillRect(x0 + w + s * 0.2, y0 + hgt * (0.3 + k * 0.17), s * [0.4, 0.62, 0.22, 0.3][k], 6); }
  }, 'TRACKED · PAGES SEEN · '),
  team: glyph((ctx, W, H, { x, y, s }) => {
    for (const [dx, dy, v] of [[-0.4, -0.1, 0.6], [0.15, 0.12, 0.95]]) {
      const w = s * 0.8; const hgt = s * 0.52; const cx = x + dx * s; const cy = y + dy * s;
      ctx.fillStyle = ink(0.12); ctx.fillRect(cx - w / 2, cy - hgt / 2, w, hgt);
      ctx.strokeStyle = ink(v); ctx.lineWidth = 4; ctx.strokeRect(cx - w / 2, cy - hgt / 2, w, hgt);
      ctx.fillStyle = ink(v * 0.6); ctx.fillRect(cx - w * 0.36, cy - hgt * 0.12, w * 0.5, 4); ctx.fillRect(cx - w * 0.36, cy + hgt * 0.12, w * 0.32, 4);
    }
    ctx.fillStyle = acc(1); ctx.beginPath(); ctx.arc(x + s * 0.44, y - s * 0.06, 7, 0, TAU); ctx.fill();
  }, 'SHARED DESK · '),
  developers: glyph((ctx, W, H, { x, y, s }) => {
    const w = s * 1.3; const hgt = s * 0.8; const x0 = x - w / 2 - s * 0.1; const y0 = y - hgt / 2;
    ctx.fillStyle = ink(0.75); ctx.fillRect(x0, y0, w, hgt);
    ctx.fillStyle = CUT; ctx.fillRect(x0 + 4, y0 + 12, w - 8, hgt - 16);
    ctx.fillStyle = acc(1); ctx.font = `600 ${s * 0.3}px ${MONO}`; ctx.textAlign = 'left'; ctx.textBaseline = 'middle';
    ctx.fillText('>_', x0 + s * 0.14, y0 + hgt * 0.56);
    ctx.fillStyle = ink(0.55); ctx.fillRect(x0 + s * 0.62, y0 + hgt * 0.5, w * 0.36, 4);
  }, 'API · MCP · TOKENS · '),
  preferences: glyph((ctx, W, H, { x, y, s }) => {
    const cols = 7; const rows = 4; const cw = s * 0.2; const x0 = x - (cols * cw) / 2 - s * 0.1; const y0 = y - (rows * cw) / 2;
    for (let r = 0; r < rows; r += 1) for (let c = 0; c < cols; c += 1) {
      const work = c < 5;
      ctx.fillStyle = r === 1 && c === 2 ? acc(1) : ink(work ? 0.7 : 0.25);
      ctx.fillRect(x0 + c * cw + 3, y0 + r * cw + 3, cw - 6, cw - 6);
    }
  }, 'WORKING WEEK · '),
  briefings: glyph((ctx, W, H, { x, y, s }) => {
    const w = s * 1.15; const hgt = s * 0.8; const x0 = x - w / 2 - s * 0.1; const y0 = y - hgt / 2;
    ctx.fillStyle = ink(0.12); ctx.fillRect(x0, y0, w, hgt);
    ctx.strokeStyle = ink(0.85); ctx.lineWidth = 4; ctx.strokeRect(x0, y0, w, hgt);
    ctx.fillStyle = ink(0.9); ctx.fillRect(x0 + w * 0.08, y0 + hgt * 0.14, w * 0.84, 7);
    for (let k = 0; k < 3; k += 1) { ctx.fillStyle = ink(0.5); ctx.fillRect(x0 + w * 0.08, y0 + hgt * (0.42 + k * 0.16), w * 0.4, 4); ctx.fillRect(x0 + w * 0.54, y0 + hgt * (0.42 + k * 0.16), w * 0.38, 4); }
    ctx.strokeStyle = acc(1); ctx.lineWidth = 4; ctx.beginPath(); ctx.arc(x0 + w * 0.9, y0, s * 0.18, Math.PI, TAU); ctx.stroke();
  }, 'MORNING · EVENING · '),
  locked: glyph((ctx, W, H, { x, y, s }) => {
    const w = s * 0.62; const hgt = s * 0.5;
    ctx.strokeStyle = ink(0.85); ctx.lineWidth = 5;
    ctx.beginPath(); ctx.arc(x - s * 0.1, y - hgt * 0.4, w * 0.3, Math.PI, TAU); ctx.stroke();
    ctx.fillStyle = ink(0.75); ctx.fillRect(x - s * 0.1 - w / 2, y - hgt * 0.4, w, hgt);
    ctx.fillStyle = acc(1); ctx.beginPath(); ctx.arc(x - s * 0.1, y - hgt * 0.05, 6, 0, TAU); ctx.fill();
  }, 'PIGEONBOX PRO · '),
};

const SCENES = { dispatch, ...GLYPHS };

/** Mount every unmounted `canvas[data-scene]` in `root`. Scene options come from data attributes. */
export function mount(root = document) {
  sweep();
  for (const canvas of root.querySelectorAll('canvas[data-scene]')) {
    if (canvas.dataset.mounted) continue;
    const make = SCENES[canvas.dataset.scene];
    if (!make) continue;
    canvas.dataset.mounted = '1';
    createField(canvas, make({ tone: canvas.dataset.tone, stops: Number(canvas.dataset.stops) || 4 }));
  }
}

/** Destroy fields whose page has gone. */
export function sweep() {
  for (const field of [...fields]) if (!field.canvas.isConnected) field.destroy();
}

const repaintAll = (rebuild) => () => {
  for (const field of fields) rebuild ? field.render(true) : field.recolor();
};
if (!PIDGY_INK.complete) PIDGY_INK.addEventListener('load', repaintAll(true), { once: true });
matchMedia('(prefers-color-scheme: dark)').addEventListener('change', repaintAll(false));
onPreferenceChange(repaintAll(true));
new MutationObserver(repaintAll(false)).observe(document.documentElement, { attributes: true, attributeFilter: ['data-pb-theme'] });
