import React from "react";
import { Cell } from "./Pixel";
import { M, rand } from "../lib";

/** Pedestrians walking on a plane. Positions are in art px on that plane. */
export const Walkers: React.FC<{
  frame: number;
  camX: number;
  scale: number;
  feetY: number;
  count: number;
  range: [number, number];
  parallax?: number;
  seed?: number;
  rows?: number;
}> = ({
  frame,
  camX,
  scale,
  feetY,
  count,
  range,
  parallax = 1,
  seed = 1,
  rows = 2,
}) => {
  const P = M.people;
  return (
    <>
      {/* back row first, so the front row overlaps it — no z-index, which would lift people above foreground layers */}
      {new Array(count)
        .fill(0)
        .map((_, i) => i)
        .sort((a, b) => (a % rows) - (b % rows) || a - b)
        .map((i) => {
          const dir = rand(i * 5 + seed) > 0.5 ? 1 : -1;
          const speed = 0.28 + rand(i * 9 + seed) * 0.22;
          const x0 = range[0] + rand(i * 13 + seed) * (range[1] - range[0]);
          const x = x0 + dir * speed * frame;
          const row = i % rows;
          const y = feetY + row * 3;
          const sx = (x - camX * parallax) * scale;
          if (sx < -60 || sx > 1980) return null;
          const step = Math.floor(frame / 6 + i) % 4;
          return (
            <Cell
              key={i}
              file="art/people.png"
              sheetW={P.cw * 4}
              sheetH={P.ch * P.n}
              cw={P.cw}
              ch={P.ch}
              col={step}
              row={i % P.n}
              scale={scale}
              style={{
                left: sx,
                top: (y - P.ch) * scale,
                scale: dir < 0 ? "-1 1" : undefined,
              }}
            />
          );
        })}
    </>
  );
};

/** Cars on a lane. dir 1 drives right, -1 left. lane is the wheel baseline in art px. */
export const Traffic: React.FC<{
  frame: number;
  camX: number;
  scale: number;
  lane: number;
  dir: 1 | -1;
  count: number;
  spacing: number;
  speed: number;
  offset?: number;
  seed?: number;
}> = ({
  frame,
  camX,
  scale,
  lane,
  dir,
  count,
  spacing,
  speed,
  offset = 0,
  seed = 2,
}) => {
  const C = M.cars;
  return (
    <>
      {new Array(count).fill(0).map((_, i) => {
        const x =
          offset +
          i * spacing +
          rand(i + seed) * spacing * 0.5 +
          dir * speed * frame;
        const sx = (x - camX) * scale;
        if (sx < -200 || sx > 2000) return null;
        return (
          <Cell
            key={i}
            file="art/cars.png"
            sheetW={C.cw}
            sheetH={C.ch * C.n}
            cw={C.cw}
            ch={C.ch}
            col={0}
            row={Math.floor(rand(i * 3 + seed) * C.n)}
            scale={scale}
            style={{
              left: sx,
              top: (lane - C.ch) * scale + (Math.floor(frame / 4 + i) % 2),
              scale: dir < 0 ? "-1 1" : undefined,
            }}
          />
        );
      })}
    </>
  );
};
