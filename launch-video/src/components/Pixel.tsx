import React from "react";
import { AbsoluteFill, Img, staticFile, useCurrentFrame } from "remotion";
import { M, rand, T } from "../lib";

const px: React.CSSProperties = { imageRendering: "pixelated", position: "absolute", maxWidth: "none" };

/** A pixel-art PNG from public/art drawn at an integer scale. */
export const Art: React.FC<{
  name: string;
  scale: number;
  x?: number;
  y?: number;
  style?: React.CSSProperties;
}> = ({ name, scale, x = 0, y = 0, style }) => {
  const meta = M[name];
  return (
    <Img
      src={staticFile(`art/${name}.png`)}
      style={{ ...px, left: x, top: y, width: meta.w * scale, height: meta.h * scale, ...style }}
    />
  );
};

/** One cell of a sprite sheet. (x, y) is the top-left corner in screen px. */
export const Cell: React.FC<{
  file: string;
  sheetW: number;
  sheetH: number;
  cw: number;
  ch: number;
  col: number;
  row: number;
  scale: number;
  style?: React.CSSProperties;
}> = ({ file, sheetW, sheetH, cw, ch, col, row, scale, style }) => (
  <div
    style={{
      position: "absolute",
      width: cw * scale,
      height: ch * scale,
      overflow: "hidden",
      ...style,
    }}
  >
    <Img
      src={staticFile(file)}
      style={{
        ...px,
        left: -col * cw * scale,
        top: -row * ch * scale,
        width: sheetW * scale,
        height: sheetH * scale,
      }}
    />
  </div>
);

export type SheetRow = "idle" | "indexing" | "drafting" | "opened" | "error";
const ROWS: SheetRow[] = ["idle", "indexing", "drafting", "opened", "error"];

/**
 * The shipped PigeonBox mascot (pigeon-sprites.png, snapped to its pixel grid).
 * (x, y) is the point between the pigeon's feet in screen px.
 */
export const MascotPigeon: React.FC<{
  x: number;
  y: number;
  scale: number;
  row?: SheetRow;
  col?: number;
  style?: React.CSSProperties;
}> = ({ x, y, scale, row = "idle", col = 0, style }) => (
  <Cell
    file="art/pigeon-sheet-1x.png"
    sheetW={200}
    sheetH={200}
    cw={50}
    ch={40}
    col={col}
    row={ROWS.indexOf(row)}
    scale={scale}
    style={{ left: x - 25 * scale, top: y - 39 * scale, transformOrigin: "50% 97%", ...style }}
  />
);

/** Frame index for the mascot's 4-frame loops (matches src/ui/pigeon.css durations). */
export const mascotCol = (frame: number, row: SheetRow) => {
  const cycle = { idle: 3.8, indexing: 1.6, drafting: 1.9, opened: 2.4, error: 2.8 }[row] * 30;
  return Math.floor(((frame % cycle) + cycle) % cycle / (cycle / 4));
};

/**
 * Side-view flight cycle. Flaps are locked to the absolute timeline so they
 * land with the wing-beat sound (scripts/gen_audio.py flight_flaps).
 * (x, y) is the body centre in screen px.
 */
export const FlyingPigeon: React.FC<{
  x: number;
  y: number;
  scale: number;
  absFrame: number;
  glide?: boolean;
  rotate?: number;
  flip?: boolean;
  phase?: number;
  style?: React.CSSProperties;
}> = ({ x, y, scale, absFrame, glide, rotate = 0, flip, phase = 0, style }) => {
  const fl = T.flap;
  const period = absFrame >= fl.fastFrom && absFrame < fl.fastTo ? fl.fast : fl.slow;
  const t = (((absFrame + phase) % period) + period) % period;
  const idx = glide ? 4 : Math.floor((t / period) * 4);
  return (
    <Cell
      file="art/pigeon-fly-1x.png"
      sheetW={280}
      sheetH={50}
      cw={56}
      ch={50}
      col={idx}
      row={0}
      scale={scale}
      style={{
        left: x - 28 * scale,
        top: y - 27 * scale,
        rotate: `${rotate}deg`,
        scale: flip ? "-1 1" : undefined,
        ...style,
      }}
    />
  );
};

/** Animated film grain + warm vignette + gentle halation — the film's finishing pass. */
export const FilmFinish: React.FC<{ vignette?: number; grain?: number; warmth?: number }> = ({
  vignette = 0.55,
  grain = 0.07,
  warmth = 0.12,
}) => {
  const frame = useCurrentFrame();
  const tile = Math.floor(frame / 2) % 4;
  const ox = Math.floor(rand(frame) * 512);
  const oy = Math.floor(rand(frame + 99) * 512);
  return (
    <AbsoluteFill style={{ pointerEvents: "none" }}>
      <AbsoluteFill
        style={{
          background: `radial-gradient(ellipse 75% 70% at 50% 45%, rgba(255,214,160,${warmth}) 0%, rgba(0,0,0,0) 60%)`,
          mixBlendMode: "soft-light",
        }}
      />
      <AbsoluteFill
        style={{
          background: `radial-gradient(ellipse 85% 80% at 50% 50%, rgba(0,0,0,0) 55%, rgba(18,12,8,${vignette}) 100%)`,
        }}
      />
      <Img
        src={staticFile(`art/grain${tile}.png`)}
        style={{
          position: "absolute",
          left: -(ox % 128),
          top: -(oy % 72),
          width: 2048,
          height: 1152,
          maxWidth: "none",
          mixBlendMode: "overlay",
          opacity: grain,
        }}
      />
    </AbsoluteFill>
  );
};

/** Soft rising puffs (steam, chimney smoke), in screen px. */
export const Puffs: React.FC<{
  x: number;
  y: number;
  scale: number;
  color?: string;
  count?: number;
  rise?: number;
  seed?: number;
  life?: number;
}> = ({ x, y, scale, color = "rgba(255,248,235,0.5)", count = 6, rise = 26, seed = 1, life = 70 }) => {
  const frame = useCurrentFrame();
  return (
    <>
      {new Array(count).fill(0).map((_, i) => {
        const t = ((frame + (i * life) / count + seed * 13) % life) / life;
        const drift = Math.sin(t * 5 + i + seed) * 3;
        const s = Math.round((1 + t * 2.2) * scale);
        return (
          <div
            key={i}
            style={{
              position: "absolute",
              left: x + drift * scale - s / 2,
              top: y - t * rise * scale - s / 2,
              width: s,
              height: s,
              background: color,
              opacity: Math.sin(Math.PI * t) * 0.9,
            }}
          />
        );
      })}
    </>
  );
};

/** Floating dust motes catching light. */
export const Dust: React.FC<{ count?: number; area: [number, number, number, number]; seed?: number; size?: number }> = ({
  count = 40,
  area,
  seed = 3,
  size = 4,
}) => {
  const frame = useCurrentFrame();
  const [x0, y0, w, h] = area;
  return (
    <>
      {new Array(count).fill(0).map((_, i) => {
        const bx = rand(i * 3 + seed) * w;
        const by = rand(i * 7 + seed) * h;
        const sp = 0.15 + rand(i + seed * 5) * 0.35;
        const x = x0 + ((bx + frame * sp * 0.6 + Math.sin(frame / 40 + i) * 12) % w);
        const y = y0 + ((by + frame * sp * 0.25 + h) % h);
        const tw = 0.35 + 0.65 * Math.abs(Math.sin(frame / (25 + i) + i));
        const s = size * (0.6 + rand(i * 11) * 0.9);
        return (
          <div
            key={i}
            style={{
              position: "absolute",
              left: x,
              top: y,
              width: s,
              height: s,
              borderRadius: s,
              background: "#fff1d6",
              opacity: tw * 0.55,
              boxShadow: `0 0 ${s * 2}px rgba(255,230,180,0.6)`,
            }}
          />
        );
      })}
    </>
  );
};
