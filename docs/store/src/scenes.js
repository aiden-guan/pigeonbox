// Dot-matrix scenes for the store graphics, rendered by the website's own
// halftone field (halftone.js). Scenes draw at CSS-pixel scale into the
// field's density grid: red is ink density, green marks copper accent dots.
import { createField } from '/halftone.js';

const TAU = Math.PI * 2;
export const ink = (v) => `rgb(${Math.round(Math.min(1, Math.max(0, v)) * 255)},0,0)`;
export const acc = (v) => `rgb(0,${Math.round(Math.min(1, Math.max(0, v)) * 255)},0)`;
export const CUT = 'rgb(0,0,0)';

export function rng(seed) {
  let a = seed >>> 0;
  return () => {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = a;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

const load = (src) => new Promise((resolve, reject) => { const i = new Image(); i.onload = () => resolve(i); i.onerror = reject; i.src = src; });
export const assets = Promise.all([load('/brand/pidgy-ink.png'), load('/brand/pidgy-flight.webp')]).then(([inkAtlas, flight]) => ({ inkAtlas, flight }));

/** Paints one static field into `canvas` and resolves once drawn. */
export async function paint(canvas, build, options = {}) {
  const { inkAtlas, flight } = await assets;
  const field = createField(canvas, {
    static: true,
    options: { cell: 5, dot: 0.44, color: [24, 25, 27], accent: [168, 80, 44], alphas: [0.2, 0.46, 0.86], flashlight: 0, interactive: false, ...options },
    build(ctx, W, H, state) { build(new Pen(ctx, state.cell, inkAtlas, flight), W, H); },
  });
  field.render(true);
  return field;
}

class Pen {
  constructor(ctx, cell, inkAtlas, flight) { Object.assign(this, { ctx, cell, inkAtlas, flight }); }

  /** Checkerboard dither: shapes read as tone, not slabs. */
  dither(x, y, w, h, v, odd = 0, step = 2) {
    const { ctx, cell } = this;
    ctx.fillStyle = ink(v);
    for (let gy = Math.ceil(y / cell); gy * cell < y + h; gy++)
      for (let gx = Math.ceil(x / cell); gx * cell < x + w; gx++)
        if ((gx + gy + odd) % step === 0) ctx.fillRect(gx * cell, gy * cell, cell, cell);
  }

  /** Dots along a polyline/bezier sampled every `gap` px. */
  dotted(points, gap, color) {
    const { ctx, cell } = this;
    ctx.fillStyle = color;
    let carry = 0;
    for (let i = 1; i < points.length; i++) {
      const [ax, ay] = points[i - 1], [bx, by] = points[i];
      const len = Math.hypot(bx - ax, by - ay);
      for (let d = carry; d < len; d += gap) {
        const x = ax + (bx - ax) * d / len, y = ay + (by - ay) * d / len;
        ctx.fillRect(Math.floor(x / cell) * cell, Math.floor(y / cell) * cell, cell, cell);
      }
      carry = (carry - len) % gap; if (carry < 0) carry += gap;
    }
  }

  static bezier(p0, p1, p2, p3, n = 120) {
    const out = [];
    for (let i = 0; i <= n; i++) {
      const t = i / n, u = 1 - t;
      out.push([u * u * u * p0[0] + 3 * u * u * t * p1[0] + 3 * u * t * t * p2[0] + t * t * t * p3[0],
        u * u * u * p0[1] + 3 * u * u * t * p1[1] + 3 * u * t * t * p2[1] + t * t * t * p3[1]]);
    }
    return out;
  }

  /** The dashed copper flight path from the reference banner. */
  flightPath(p0, p1, p2, p3, gap = 15) { this.dotted(Pen.bezier(p0, p1, p2, p3), gap, acc(0.95)); }

  envelope(x, y, w, rot = 0, v = 0.9, accent = false, lw = 5) {
    const { ctx } = this;
    const h = w * 0.64;
    ctx.save(); ctx.translate(x, y); ctx.rotate(rot);
    ctx.fillStyle = CUT; ctx.fillRect(-w / 2, -h / 2, w, h);
    ctx.strokeStyle = accent ? acc(v) : ink(v); ctx.lineWidth = lw;
    ctx.strokeRect(-w / 2, -h / 2, w, h);
    ctx.beginPath(); ctx.moveTo(-w / 2, -h / 2); ctx.lineTo(0, h * 0.1); ctx.lineTo(w / 2, -h / 2); ctx.stroke();
    ctx.restore();
  }

  /** Circular postmark: ring text, envelope at its heart, cancellation waves. */
  postmark(cx, cy, R, { text = 'PIGEONBOX · GMAIL DISPATCH · LOCAL FIRST · ', v = 1, waves = 'left', wavesLength = R * 1.6 } = {}) {
    const { ctx } = this;
    ctx.strokeStyle = ink(v); ctx.lineWidth = Math.max(4, R * 0.035);
    ctx.beginPath(); ctx.arc(cx, cy, R, 0, TAU); ctx.stroke();
    ctx.lineWidth = Math.max(3, R * 0.025);
    ctx.beginPath(); ctx.arc(cx, cy, R * 0.72, 0, TAU); ctx.stroke();
    ctx.fillStyle = ink(v);
    ctx.font = `600 ${R * 0.15}px ui-monospace, Menlo, monospace`;
    ctx.textAlign = 'center'; ctx.textBaseline = 'middle';
    const step = TAU / text.length;
    for (let i = 0; i < text.length; i++) {
      const a = -Math.PI / 2 + i * step;
      ctx.save(); ctx.translate(cx + Math.cos(a) * R * 0.86, cy + Math.sin(a) * R * 0.86); ctx.rotate(a + Math.PI / 2);
      ctx.fillText(text[i], 0, 0); ctx.restore();
    }
    this.envelope(cx, cy, R * 0.66, 0, v, false, Math.max(5, R * 0.05));
    if (!waves) return;
    ctx.strokeStyle = ink(v * 0.85); ctx.lineWidth = Math.max(4, R * 0.04);
    const dir = waves === 'left' ? -1 : 1;
    for (let k = 0; k < 5; k++) {
      ctx.beginPath();
      const y0 = cy - R * 0.5 + k * R * 0.25;
      for (let s = 0; s <= wavesLength; s += 4) {
        const x = cx + dir * (R * 1.08 + s);
        const y = y0 + Math.sin(s / (R * 0.18) + k * 0.6) * R * 0.05;
        if (s === 0) ctx.moveTo(x, y); else ctx.lineTo(x, y);
      }
      ctx.stroke();
    }
  }

  /** A small bird in flight: two wing strokes and a body dot, printed in dots. */
  gull(x, y, size, flap = 0.5, v = 0.9, rot = 0) {
    const { ctx } = this;
    const s = size / 2;
    ctx.save(); ctx.translate(x, y); ctx.rotate(rot);
    ctx.strokeStyle = ink(v); ctx.lineWidth = Math.max(4, size * 0.13); ctx.lineCap = 'round';
    ctx.beginPath(); ctx.moveTo(-s, -s * flap * 0.2); ctx.quadraticCurveTo(-s * 0.5, -s * flap, 0, 0);
    ctx.quadraticCurveTo(s * 0.5, -s * flap, s, -s * flap * 0.2); ctx.stroke();
    ctx.fillStyle = ink(v); ctx.fillRect(-size * 0.08, -size * 0.04, size * 0.16, size * 0.14);
    ctx.restore();
  }

  /** A pigeon silhouette from the flight atlas, printed in ink. */
  bird(x, y, size, frame = 4, v = 0.9, mirror = false) {
    const { ctx, flight } = this;
    const t = document.createElement('canvas'); t.width = t.height = 112;
    const c = t.getContext('2d');
    c.drawImage(flight, frame * 112, 0, 112, 112, 0, 0, 112, 112);
    c.globalCompositeOperation = 'source-in'; c.fillStyle = ink(v); c.fillRect(0, 0, 112, 112);
    ctx.save(); ctx.translate(x, y); if (mirror) ctx.scale(-1, 1);
    ctx.drawImage(t, -size / 2, -size / 2, size, size); ctx.restore();
  }

  /** Approved Pidgy from the ink-density atlas (feet at x, ground). */
  inkPidgy(x, ground, height, row = 0, frame = 0, mirror = false) {
    const { ctx, inkAtlas } = this;
    const size = height * 96 / 56;
    ctx.save(); ctx.translate(x, ground); if (mirror) ctx.scale(-1, 1);
    ctx.imageSmoothingEnabled = false;
    ctx.drawImage(inkAtlas, frame * 96, row * 96, 96, 96, -size * 44 / 96, -size * 92 / 96, size, size);
    ctx.restore();
  }

  /** San Francisco-ish skyline in dither, bridge on the left, pyramid and towers. */
  skyline(W, H, { seed = 7, ground = H, x0 = 0, x1 = W, min = 0.18, max = 0.7, bridge = true, pyramid = 0.62, water = true, span = H * 0.3, tone = 0.3 } = {}) {
    const { ctx, cell } = this;
    const rand = rng(seed);
    const blocks = [];
    let x = x0;
    const bridgeEnd = bridge ? x0 + (x1 - x0) * 0.3 : x0;
    if (bridge) {
      // Water under the bridge: sparse horizontal dot lines.
      if (water) for (let y = ground - cell * 2; y < H; y += cell * 2) this.dither(x0, y, bridgeEnd - x0 + 40, cell, 0.22 + (y - ground) / H * 0.3, Math.floor(y / cell), 3);
      const deck = ground - span * 0.22;
      const towers = [x0 + (bridgeEnd - x0) * 0.22, x0 + (bridgeEnd - x0) * 0.78];
      const top = deck - span * 0.55;
      ctx.fillStyle = acc(0.95);
      for (const tx of towers) { ctx.fillRect(tx - 5, top, 10, ground - top); ctx.fillRect(tx - 12, top + 20, 24, 5); ctx.fillRect(tx - 12, top + 60, 24, 5); }
      ctx.fillRect(x0 - 20, deck, bridgeEnd - x0 + 40, 7);
      ctx.strokeStyle = acc(0.85); ctx.lineWidth = 4;
      const cable = (ax, bx, sag) => { ctx.beginPath(); ctx.moveTo(ax, top); ctx.quadraticCurveTo((ax + bx) / 2, top + sag, bx, top); ctx.stroke(); };
      cable(towers[0], towers[1], (deck - top) * 1.85);
      ctx.beginPath(); ctx.moveTo(x0 - 30, deck - 6); ctx.quadraticCurveTo((x0 + towers[0]) / 2, top + (deck - top) * 0.6, towers[0], top); ctx.stroke();
      ctx.beginPath(); ctx.moveTo(towers[1], top); ctx.quadraticCurveTo((towers[1] + bridgeEnd) / 2 + 20, top + (deck - top) * 0.6, bridgeEnd + 40, deck - 6); ctx.stroke();
      // Hangers
      ctx.fillStyle = acc(0.55);
      for (let hx = towers[0] + 14; hx < towers[1] - 8; hx += 16) {
        const t = (hx - towers[0]) / (towers[1] - towers[0]);
        const cy = top + (deck - top) * 1.85 * 2 * t * (1 - t);
        ctx.fillRect(hx, cy, 2, deck - cy);
      }
      x = bridgeEnd + 20;
    }
    while (x < x1) {
      const near = Math.abs((x - x0) / (x1 - x0) - pyramid);
      const w = 30 + rand() * 70;
      const lift = Math.max(0, 1 - near * 2.4);
      const h = span * (min + rand() * (max - min) * (0.45 + lift * 0.75));
      blocks.push({ x, w, top: ground - h });
      x += w + (rand() < 0.2 ? 6 + rand() * 10 : 0);
    }
    for (const b of blocks) {
      ctx.fillStyle = CUT; ctx.fillRect(b.x, b.top, b.w, H - b.top);
      this.dither(b.x, b.top, b.w, H - b.top, tone + rand() * 0.06);
      ctx.fillStyle = ink(0.82); ctx.fillRect(b.x, b.top, b.w, cell * 0.9);
      // Lit windows, copper
      for (let gy = Math.ceil((b.top + cell * 2) / cell); gy * cell < H - cell; gy += 2)
        for (let gx = Math.ceil((b.x + cell) / cell); gx * cell < b.x + b.w - cell; gx += 2)
          if ((gx + gy) % 2 === 1 && rand() < 0.035) { ctx.fillStyle = acc(0.8); ctx.fillRect(gx * cell, gy * cell, cell, cell); }
      if (rand() < 0.25) { ctx.fillStyle = ink(0.8); ctx.fillRect(b.x + b.w * 0.5, b.top - 26, 4, 26); }
    }
    if (pyramid !== null) {
      // The pyramid tower
      const px = x0 + (x1 - x0) * pyramid, base = ground, h = span * 1.25, half = span * 0.11;
      ctx.fillStyle = CUT;
      ctx.beginPath(); ctx.moveTo(px - half, base); ctx.lineTo(px, base - h); ctx.lineTo(px + half, base); ctx.fill();
      ctx.save(); ctx.clip();
      this.dither(px - half, base - h, half * 2, h, 0.95, 0, 1);
      ctx.restore();
      ctx.fillStyle = ink(1); ctx.fillRect(px - 2, base - h - 30, 4, 30);
      // Wings near the base
      ctx.fillStyle = CUT; ctx.fillRect(px - half * 0.9, base - h * 0.28, half * 1.8, 0);
    }
    return blocks;
  }
}
export { Pen };

/**
 * Places a crop of a real UI capture. Captures are 2× PNGs; `w` is the
 * capture's CSS width (1100 for Gmail + workspace, 360 for the side panel).
 * sx/sy/sw/sh are in capture CSS px; s scales the crop on the canvas.
 */
export function shot(parent, { src, w, sx = 0, sy = 0, sw, sh, s = 1, x, y, cls = 'window', z = 2, radius }) {
  const box = document.createElement('div');
  box.className = `crop ${cls}`;
  Object.assign(box.style, { left: `${x}px`, top: `${y}px`, width: `${sw * s}px`, height: `${sh * s}px`, zIndex: z });
  if (radius !== undefined) box.style.borderRadius = `${radius}px`;
  const img = new Image();
  img.src = src;
  Object.assign(img.style, { width: `${w * s}px`, left: `${-sx * s}px`, top: `${-sy * s}px` });
  box.append(img);
  parent.append(box);
  return img.decode().then(() => box);
}
