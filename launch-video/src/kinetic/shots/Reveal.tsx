import React from "react";
import { AbsoluteFill, useCurrentFrame } from "remotion";
import { DotCanvas, fillDot } from "../Halftone";
import { ci, clamp01, display, ease, K, mono, rnd } from "../tokens";

const ROWS = 13;
const HOT = [3, 7, 10];
const CELL = 11;

type RowDot = { row: number; x: number; y: number; hot: boolean; seed: number };

const rowDots: RowDot[] = (() => {
  const out: RowDot[] = [];
  for (let r = 0; r < ROWS; r++) {
    const y = 120 + r * 70;
    const senderLen = 10 + Math.floor(rnd(r + 1) * 9);
    const subjLen = 34 + Math.floor(rnd(r + 7) * 40);
    const hot = HOT.includes(r);
    for (let line = 0; line < 2; line++) {
      for (let i = 0; i < senderLen; i++) out.push({ row: r, x: 260 + i * CELL, y: y + line * CELL, hot, seed: out.length });
      for (let i = 0; i < subjLen; i++) {
        // Word gaps make the dots read as greeked text.
        if (rnd(r * 131 + i) < 0.14) continue;
        out.push({ row: r, x: 560 + i * CELL, y: y + line * CELL, hot, seed: out.length });
      }
    }
  }
  return out;
})();

// The reply count is made of the very same dots as the inbox. No rasterised display type.
const THREE = ["11110", "00001", "00001", "01110", "00001", "00001", "11110"];
const threeDots = THREE.flatMap((row, y) => row.split("").flatMap((cell, x) => cell === "0" ? [] :
  Array.from({ length: 25 }, (_, i) => ({ x: 798 + x * 68 + (i % 5) * 12, y: 312 + y * 68 + Math.floor(i / 5) * 12 }))));
const hotDots = rowDots.filter((d) => d.hot);

/**
 * Shot 5: the inbox wall turns into the brand's dot matrix. Three rows turn copper and
 * gather in the middle, then collapse into a point.
 */
export const HalftoneSort: React.FC = () => {
  const f = useCurrentFrame();
  const scroll = (1 - ease.expo(ci(f, [0, 40], [0, 1], ease.linear))) * 520;
  const sortP = ci(f, [26, 46], [0, 1], ease.inOut);
  const gather = ci(f, [44, 84], [0, 1], ease.expo);
  const resolve = ci(f, [60, 89], [0, 1], ease.inOut);
  const implode = ci(f, [108, 119], [0, 1], ease.in);

  const draw = (ctx: CanvasRenderingContext2D) => {
    // Grey sea.
    ctx.fillStyle = "#9aa6b4";
    ctx.beginPath();
    rowDots.forEach((d) => {
      if (d.hot) return;
      const appear = clamp01((f - (d.x / 1920) * 10 - (d.y / 1080) * 8) / 10);
      const fade = 1 - sortP * 0.65 - gather * 0.35;
      const drift = gather * (d.y - 540) * 0.5;
      const y = d.y - scroll + drift;
      const r = 4.0 * appear * Math.max(0, fade) * (0.85 + 0.3 * rnd(d.seed));
      fillDot(ctx, d.x, y, r);
    });
    ctx.fill();

    // Three copper rows: brighten, gather at the centre, then collapse into a point.
    ctx.fillStyle = K.copperBright;
    ctx.beginPath();
    hotDots.forEach((d, i) => {
      const slot = HOT.indexOf(d.row);
      const appear = clamp01((f - (d.x / 1920) * 10 - (d.y / 1080) * 8) / 10);
      const y0 = d.y - scroll;
      const ty = 470 + slot * 60 + (d.y - (120 + d.row * 70));
      const tx = d.x + 170;
      let x = d.x + (tx - d.x) * gather;
      let y = y0 + (ty - y0) * gather;
      const target = threeDots[Math.floor(i * threeDots.length / hotDots.length)];
      x += (target.x - x) * resolve;
      y += (target.y - y) * resolve;
      x += (960 - x) * implode;
      y += (540 - y) * implode;
      const r = (4.0 + 1.0 * sortP) * appear * (1 - implode * 0.6);
      fillDot(ctx, x, y, r);
    });
    ctx.fill();

  };

  return (
    <AbsoluteFill style={{ background: K.ink }}>
      <DotCanvas draw={draw} deps={[f]} />
      <div style={{ position: "absolute", left: 0, right: 0, top: 860, textAlign: "center", fontFamily: mono, fontSize: 26, letterSpacing: "0.12em", color: K.inkText, opacity: ci(f, [69, 83, 105, 115], [0, 1, 1, 0]) }}>THREE NEED YOU.</div>
    </AbsoluteFill>
  );
};

const WM_SIZE = 280;
const WM_Y = 500;

/** Shot 6: copper. The collapsed point bursts into a ring of dots; the wordmark lands clean. */
export const Wordmark: React.FC = () => {
  const f = useCurrentFrame();
  const draw = (ctx: CanvasRenderingContext2D) => {
    ctx.fillStyle = "rgba(243,240,232,0.55)";
    ctx.beginPath();
    for (let k = 0; k < 260; k++) {
      const ang = rnd(k) * Math.PI * 2;
      const speed = 0.35 + rnd(k + 9) * 0.65;
      const p = ease.expo(clamp01(f / 50));
      const dist = 40 + p * speed * 1100;
      const x = 960 + Math.cos(ang) * dist * 1.25;
      const y = WM_Y + Math.sin(ang) * dist * 0.75;
      const r = (2 + rnd(k + 3) * 4) * (1 - clamp01((f - 20) / 50));
      fillDot(ctx, x, y, r);
    }
    ctx.fill();
  };
  return (
    <AbsoluteFill style={{ background: K.copper }}>
      <DotCanvas draw={draw} deps={[f]} />
      <div
        style={{
          position: "absolute",
          left: 140,
          right: 140,
          top: WM_Y - WM_SIZE * 0.55,
          height: 330,
          textAlign: "center",
          fontFamily: display,
          fontWeight: 700,
          fontSize: WM_SIZE,
          lineHeight: 1.1,
          letterSpacing: "-0.035em",
          color: K.paper,
        }}
      >
        {[0, 1, 2].map((i) => (
          <div key={i} style={{ position: "absolute", left: 0, right: 0, top: i * 110, height: 110, overflow: "hidden" }}>
            <div style={{ height: 330, transform: `translate(${(i % 2 ? -1 : 1) * ci(f, [i * 4, 33 + i * 4], [1600, 0], ease.expo)}px, ${-i * 110}px)` }}>PigeonBox</div>
          </div>
        ))}
      </div>
      <div
        style={{
          position: "absolute",
          left: 0,
          right: 0,
          top: WM_Y + 200,
          textAlign: "center",
          fontFamily: mono,
          fontSize: 26,
          letterSpacing: "0.32em",
          color: K.paper,
          opacity: ci(f, [40, 56], [0, 0.85]),
        }}
      >
        FIND WHAT NEEDS A REPLY · IN GMAIL
      </div>
    </AbsoluteFill>
  );
};
