import React from "react";
import { AbsoluteFill, useCurrentFrame } from "remotion";
import { Art, FilmFinish, FlyingPigeon } from "../components/Pixel";
import { Clouds, Plate } from "../components/World";
import { at, ci, ease, M, rand, useAbsFrame } from "../lib";

const S = 3;

/** Breakthrough: up out of the storm into golden light, a flock alongside. The film's widest moment. */
export const High: React.FC = () => {
  const f = useCurrentFrame();
  const abs = useAbsFrame("high");
  const camX = ci(f, [0, 144], [0, M.j4.travel], ease.soft);
  const g0 = at("high", "glideStart");
  const g1 = at("high", "glideEnd");
  const gliding = f >= g0 && f < g1;

  const px = ci(f, [0, 36], [760, 900], ease.out) + ci(f, [112, 144], [0, 520], ease.in);
  const py = ci(f, [0, 36], [1260, 470], ease.out) + Math.sin(f / (gliding ? 24 : 10)) * (gliding ? 22 : 12) + ci(f, [112, 144], [0, 820], ease.in);
  const rot = ci(f, [0, 36, 112, 144], [-38, -6, -4, 34], ease.inOut) + (gliding ? Math.sin(f / 20) * 5 : 0);

  const sunX = 200 * S - camX * 0.02 * S;
  const sunY = 150 * S;

  return (
    <AbsoluteFill style={{ background: "#e6dcc8", overflow: "hidden" }}>
      <AbsoluteFill style={{ scale: `${ci(f, [0, 144], [1.16, 1.0], ease.soft)}`, transformOrigin: "50% 60%" }}>
        <Plate name="j4_sky" scale={S} camX={camX} />
        <Clouds scale={S} camX={camX} items={[[1, 60, 70], [0, 330, 110], [2, 480, 60], [3, 600, 130]]} speed={0.08} />
        <Plate name="j4_l1" scale={S} camX={camX} />
        <Plate name="j4_l2" scale={S} camX={camX} />
        <Plate name="j4_l3" scale={S} camX={camX} />
        <Plate name="j4_l4" scale={S} camX={camX} />
        {/* morning haze over the city */}
        <AbsoluteFill style={{ background: "linear-gradient(180deg, rgba(245,220,190,0) 45%, rgba(245,220,190,0.35) 100%)" }} />
      </AbsoluteFill>
      {/* sun flare */}
      <div style={{ position: "absolute", left: sunX - 500, top: sunY - 500, width: 1000, height: 1000, background: "radial-gradient(closest-side, rgba(255,240,210,0.55), rgba(255,220,170,0))", mixBlendMode: "screen" }} />
      {[0.35, 0.6, 0.85].map((t, i) => (
        <div
          key={i}
          style={{
            position: "absolute",
            left: sunX + (960 - sunX) * t * 2 - 40 - i * 20,
            top: sunY + (540 - sunY) * t * 2 - 40 - i * 20,
            width: 80 + i * 40,
            height: 80 + i * 40,
            borderRadius: "50%",
            background: ["rgba(255,210,150,0.10)", "rgba(180,220,230,0.08)", "rgba(255,200,160,0.07)"][i],
            mixBlendMode: "screen",
          }}
        />
      ))}
      {/* the flock */}
      {new Array(8).fill(0).map((_, i) => {
        const lane = i - 3.5;
        const enter = ci(f, [14 + i * 3, 52 + i * 3], [-400 - i * 60, 0], ease.out);
        const leave = ci(f, [90 + i * 4, 132 + i * 4], [0, 1], ease.in);
        const x = 900 - 260 - Math.abs(lane) * 110 + enter + leave * 900 + Math.sin(f / 30 + i) * 20;
        const y = 470 + lane * 70 + Math.sin(f / 12 + i) * 10 - leave * (500 + i * 40);
        return (
          <FlyingPigeon
            key={i}
            x={x}
            y={y}
            scale={2}
            absFrame={abs}
            phase={Math.floor(rand(i) * 10)}
            glide={gliding && i % 3 === 0}
            rotate={-leave * 30}
            style={{ opacity: 0.92, filter: "saturate(0.85) brightness(0.96)" }}
          />
        );
      })}
      <FlyingPigeon x={px} y={py} scale={4} absFrame={abs} glide={gliding} rotate={rot} />
      {/* near clouds rushing past for depth */}
      {[
        [0, 2300, -120, 12],
        [2, 3500, 930, 11],
        [1, 5200, -90, 13],
      ].map(([i, x0, y, s], k) => (
        <Art key={k} name={`cloud${i}`} scale={s} x={x0 - f * 22} y={y} style={{ filter: "blur(10px)", opacity: 0.85 }} />
      ))}
      {/* bursting up through the top of the storm clouds */}
      {[
        [0, 200, 12],
        [2, 900, 14],
        [1, -300, 16],
        [3, 1300, 13],
      ].map(([i, x, s], k) => (
        <Art
          key={`b${k}`}
          name={`cloud${i}`}
          scale={s}
          x={x}
          y={ci(f, [0, 30], [80 + k * 90, 1300 + k * 80], ease.in)}
          style={{ filter: "blur(14px) brightness(1.05)", opacity: ci(f, [18, 30], [1, 0], ease.linear) }}
        />
      ))}
      <AbsoluteFill style={{ background: "#fff6e8", opacity: ci(f, [0, 22], [1, 0], ease.out) }} />
      <FilmFinish vignette={0.4} warmth={0.18} />
    </AbsoluteFill>
  );
};
