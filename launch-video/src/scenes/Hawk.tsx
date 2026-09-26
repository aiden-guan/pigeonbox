import React from "react";
import { AbsoluteFill, useCurrentFrame } from "remotion";
import { Cell, FilmFinish, FlyingPigeon } from "../components/Pixel";
import { at, ci, ease, M, rand, useAbsFrame } from "../lib";
import { ParkWorld } from "./Park";

const S = 4;
const HS = 5;

const Hawk: React.FC<{ x: number; y: number; frame: number; dive?: boolean; rotate?: number; flip?: boolean }> = ({
  x,
  y,
  frame,
  dive,
  rotate = 0,
  flip,
}) => (
  <Cell
    file="art/hawk.png"
    sheetW={440}
    sheetH={64}
    cw={88}
    ch={64}
    col={dive ? 4 : Math.floor((frame % 8) / 2)}
    row={0}
    scale={HS}
    style={{ left: x - 44 * HS, top: y - 36 * HS, rotate: `${rotate}deg`, scale: flip ? "-1 1" : undefined }}
  />
);

/** Back over the park — and a hawk drops out of the sun. */
export const HawkChase: React.FC = () => {
  const f = useCurrentFrame();
  const abs = useAbsFrame("hawk");
  const strike = at("hawk", "hawkStrike");
  const second = at("hawk", "hawkSecond");
  const camX = ci(f, [0, 192], [0, M.j3.travel], ease.linear);

  // pigeon: barrel-rolls down out of the first dive, then pops up over the second pass
  const roll = ci(f, [strike - 6, strike + 10], [0, 1], ease.inOut);
  const drop = ci(f, [strike - 6, strike + 6, strike + 36], [0, 1, 0.35], ease.inOut);
  const hop = ci(f, [second - 8, second, second + 26], [0, 1, 0], ease.inOut);
  const px = 800 + Math.sin(f / 18) * 40 - drop * 120 + ci(f, [170, 192], [0, 500], ease.in);
  const py = 430 + Math.sin(f / 6) * 10 + drop * 220 - hop * 230 - ci(f, [170, 192], [0, 260], ease.in);
  const rot = roll * 360 + drop * 18 - hop * 22;

  // hawk pass 1: stoops out of the sun, top-right → down-left through where the pigeon was
  const d1 = ci(f, [strike - 19, strike + 18], [0, 1], ease.linear);
  const h1x = 1780 - d1 * 1900;
  const h1y = -160 + d1 * 1200;
  // hawk pass 2: from behind, flapping hard, underneath
  const d2 = ci(f, [second - 26, second + 20], [0, 1], ease.inOut);
  const h2x = -300 + d2 * 2500;
  const h2y = 560 - Math.sin(d2 * Math.PI) * 110;

  const shake = ci(f, [strike, strike + 16], [20, 0], ease.out) + ci(f, [second, second + 12], [12, 0], ease.out);
  const sx = (rand(f * 1.7) - 0.5) * shake;
  const sy = (rand(f * 2.9) - 0.5) * shake;
  const glare = ci(f, [20, strike - 16, strike], [0.2, 0.75, 0.35], ease.inOut);
  const dusk = ci(f, [150, 192], [0, 0.5], ease.in);

  return (
    <AbsoluteFill style={{ background: "#e9dfcb", overflow: "hidden" }}>
      <AbsoluteFill style={{ translate: `${sx}px ${sy}px`, scale: `${1 + ci(f, [strike, strike + 4, strike + 20], [0, 0.05, 0], ease.out)}` }}>
        <ParkWorld camX={camX} />
        {/* the sun the hawk hides in */}
        <div
          style={{
            position: "absolute",
            left: 1300,
            top: -260,
            width: 900,
            height: 900,
            background: "radial-gradient(closest-side, rgba(255,248,225,1), rgba(255,236,190,0.5) 35%, rgba(255,230,180,0))",
            mixBlendMode: "screen",
            opacity: glare,
          }}
        />
        {f > strike - 19 && f < strike + 18 ? <Hawk x={h1x} y={h1y} frame={f} dive rotate={-38} flip /> : null}
        <FlyingPigeon x={px} y={py} scale={S} absFrame={abs} rotate={rot} />
        {f > second - 26 && f < second + 20 ? <Hawk x={h2x} y={h2y} frame={f} rotate={-6 - Math.cos(d2 * Math.PI) * 10} /> : null}
        {/* a few feathers from the close call */}
        {f >= strike
          ? new Array(6).fill(0).map((_, i) => {
              const t = f - strike;
              return (
                <div
                  key={i}
                  style={{
                    position: "absolute",
                    left: 800 + Math.cos(i * 1.7) * t * 4,
                    top: 430 + Math.sin(i * 2.3) * t * 3 + t * 1.5,
                    width: 10,
                    height: 22,
                    background: i % 2 ? "#b4b5bd" : "#9899a3",
                    rotate: `${t * 10 + i * 60}deg`,
                    opacity: ci(t, [0, 50], [1, 0], ease.linear),
                  }}
                />
              );
            })
          : null}
      </AbsoluteFill>
      {/* weather turning: the sky dims toward the storm */}
      <AbsoluteFill style={{ background: "linear-gradient(180deg, rgba(42,46,57,1), rgba(42,46,57,0.4))", opacity: dusk }} />
      <FilmFinish vignette={0.5} warmth={0.14} />
    </AbsoluteFill>
  );
};
