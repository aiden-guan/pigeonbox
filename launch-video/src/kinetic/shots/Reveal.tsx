import React from "react";
import { AbsoluteFill, useCurrentFrame } from "remotion";
import { DotCanvas, fillDot } from "../Halftone";
import { Rise } from "../type";
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

/**
 * Shot 5: the inbox wall turns into the brand's dot matrix. Three rows turn copper and
 * gather in the middle, then collapse into a point.
 */
export const HalftoneSort: React.FC = () => {
  const f = useCurrentFrame();
  const scroll = (1 - ease.expo(ci(f, [0, 40], [0, 1], ease.linear))) * 520;
  const sortP = ci(f, [26, 46], [0, 1], ease.inOut);
  const gather = ci(f, [44, 84], [0, 1], ease.expo);
  const implode = ci(f, [100, 119], [0, 1], ease.in);

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
    rowDots.forEach((d) => {
      if (!d.hot) return;
      const slot = HOT.indexOf(d.row);
      const appear = clamp01((f - (d.x / 1920) * 10 - (d.y / 1080) * 8) / 10);
      const y0 = d.y - scroll;
      const ty = 470 + slot * 60 + (d.y - (120 + d.row * 70));
      const tx = d.x + 170;
      let x = d.x + (tx - d.x) * gather;
      let y = y0 + (ty - y0) * gather;
      x += (960 - x) * implode;
      y += (540 - y) * implode;
      const r = (4.0 + 1.8 * sortP) * appear * (1 - implode * 0.6);
      fillDot(ctx, x, y, r);
    });
    ctx.fill();

  };

  return (
    <AbsoluteFill style={{ background: K.ink }}>
      <DotCanvas draw={draw} deps={[f]} />
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
  const letters = "PigeonBox".split("");
  return (
    <AbsoluteFill style={{ background: K.copper }}>
      <DotCanvas draw={draw} deps={[f]} />
      <div
        style={{
          position: "absolute",
          left: 0,
          right: 0,
          top: WM_Y - WM_SIZE * 0.55,
          textAlign: "center",
          fontFamily: display,
          fontWeight: 700,
          fontSize: WM_SIZE,
          lineHeight: 1.1,
          letterSpacing: "-0.05em",
          color: K.paper,
          transform: `scale(${1.04 - 0.04 * ease.expo(clamp01(f / 40)) + 0.015 * ci(f, [40, 120], [0, 1], ease.linear)})`,
        }}
      >
        {letters.map((ch, i) => (
          <Rise key={i} f={f} at={2 + i * 1.6} dur={16}>
            {ch}
          </Rise>
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
