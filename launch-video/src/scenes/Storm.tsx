import React from "react";
import { AbsoluteFill, useCurrentFrame } from "remotion";
import { FilmFinish, FlyingPigeon } from "../components/Pixel";
import { onPlane, Plate } from "../components/World";
import { at, ci, ease, M, rand, useAbsFrame } from "../lib";

const S = 4;

/** A jagged pixel lightning bolt from the clouds down to (x2, y2). */
const Bolt: React.FC<{ x: number; y2: number; x2: number; seed: number; age: number }> = ({ x, x2, y2, seed, age }) => {
  if (age < 0 || age > 9) return null;
  const pts: number[][] = [[x, -40]];
  const steps = 14;
  for (let i = 1; i < steps; i++) {
    const t = i / steps;
    pts.push([x + (x2 - x) * t + (rand(seed * 31 + i) - 0.5) * 120, -40 + (y2 + 40) * t]);
  }
  pts.push([x2, y2]);
  const d = pts.map((p, i) => `${i ? "L" : "M"}${Math.round(p[0] / 4) * 4} ${Math.round(p[1] / 4) * 4}`).join(" ");
  const branch = pts
    .slice(4, 8)
    .map((p, i) => `${i ? "L" : "M"}${Math.round((p[0] + i * 40 * (seed % 2 ? 1 : -1)) / 4) * 4} ${Math.round((p[1] + i * 20) / 4) * 4}`)
    .join(" ");
  const on = age < 3 || age === 5 || age === 6;
  return (
    <svg width={1920} height={1080} style={{ position: "absolute", left: 0, top: 0, opacity: on ? 1 : 0 }}>
      <path d={d} stroke="#cfe0ff" strokeWidth={26} fill="none" opacity={0.35} style={{ filter: "blur(10px)" }} />
      <path d={d} stroke="#ffffff" strokeWidth={8} fill="none" strokeLinejoin="miter" />
      <path d={branch} stroke="#e8f0ff" strokeWidth={4} fill="none" />
    </svg>
  );
};

/** Into a thunderstorm: rain, wind and lightning striking the rooftops beside it. */
export const Storm: React.FC = () => {
  const f = useCurrentFrame();
  const abs = useAbsFrame("storm");
  const L = [at("storm", "lightning1"), at("storm", "lightning2"), at("storm", "lightning3")];
  const camX = ci(f, [0, 192], [0, M.storm.travel], ease.linear);
  const rods: number[][] = M.st_near.anchors.rods;

  // strikes land on the lightning rod nearest a chosen screen x
  const strikeAt = (screenX: number) => {
    let best = rods[0];
    let bestD = 1e9;
    for (const r of rods) {
      const [sx] = onPlane(r[0], r[1], 1, camX, S);
      const dd = Math.abs(sx - screenX);
      if (dd < bestD) {
        bestD = dd;
        best = r;
      }
    }
    return onPlane(best[0], best[1], 1, camX, S);
  };

  const flash = Math.max(...L.map((l, i) => ci(f - l, [0, 2, 10], [0, i === 2 ? 1 : 0.8, 0], ease.out)));
  const shake = 5 + Math.max(...L.map((l, i) => ci(f - l, [0, 14], [i === 2 ? 30 : 18, 0], ease.out)));
  const sx = (rand(f * 1.9) - 0.5) * shake;
  const sy = (rand(f * 3.1) - 0.5) * shake;

  // pigeon fights the wind; flinches away from each strike; climbs for the clouds at the end
  const flinch = Math.max(...L.map((l) => ci(f - l, [0, 4, 20], [0, 1, 0], ease.out)));
  const climb = ci(f, [L[2] + 8, 192], [0, 1], ease.in);
  const px = 760 + Math.sin(f / 9) * 60 - flinch * 90 + climb * 300;
  const py = 520 + Math.sin(f / 5) * 26 + Math.sin(f / 13) * 30 - flinch * 60 - climb * 900;
  const rot = Math.sin(f / 4) * 10 - flinch * 20 - climb * 40;

  return (
    <AbsoluteFill style={{ background: "#2a2e39", overflow: "hidden" }}>
      <AbsoluteFill style={{ translate: `${sx}px ${sy}px`, scale: "1.05", filter: `brightness(${1 + flash * 1.4})` }}>
        <Plate name="st_sky" scale={S} camX={camX} />
        <Plate name="st_cfar" scale={S} camX={camX} />
        <Plate name="st_city" scale={S} camX={camX} />
        <Plate name="st_near" scale={S} camX={camX} />
        {L.map((l, i) => {
          const [tx, ty] = strikeAt([1350, 380, 1080][i]);
          return <Bolt key={i} x={tx + [200, -260, 120][i]} x2={tx} y2={ty} seed={i + 3} age={f - l} />;
        })}
        {/* far rain */}
        {new Array(90).fill(0).map((_, i) => {
          const x = ((rand(i) * 2300 + f * 14) % 2300) - 200;
          const y = ((rand(i + 50) * 1300 + f * 46) % 1300) - 150;
          return <div key={i} style={{ position: "absolute", left: x, top: y, width: 3, height: 44, background: "rgba(200,212,230,0.35)", rotate: "16deg" }} />;
        })}
        <FlyingPigeon x={px} y={py} scale={S} absFrame={abs} rotate={rot} style={{ filter: `brightness(${0.7 + flash})` }} />
        <Plate name="st_clow" scale={S} camX={camX} />
        {/* near rain */}
        {new Array(40).fill(0).map((_, i) => {
          const x = ((rand(i + 200) * 2400 + f * 24) % 2400) - 240;
          const y = ((rand(i + 300) * 1400 + f * 80) % 1400) - 200;
          return <div key={i} style={{ position: "absolute", left: x, top: y, width: 6, height: 110, background: "rgba(220,230,245,0.3)", rotate: "18deg", filter: "blur(2px)" }} />;
        })}
      </AbsoluteFill>
      <AbsoluteFill style={{ background: "#eef3ff", opacity: flash * 0.7 }} />
      <FilmFinish vignette={0.7} warmth={0.02} grain={0.09} />
    </AbsoluteFill>
  );
};
