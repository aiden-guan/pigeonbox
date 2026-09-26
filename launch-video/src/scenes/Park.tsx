import React from "react";
import { AbsoluteFill, Img, staticFile, useCurrentFrame } from "remotion";
import { Walkers } from "../components/Crowd";
import { Art, Cell } from "../components/Pixel";
import { Clouds, onPlane, Plate } from "../components/World";
import { M, rand } from "../lib";

const S = 4;

/** The park world: river, boats, clock tower, fountain, kites and walkers. The hawk chase flies through it. */
export const ParkWorld: React.FC<{ camX: number }> = ({ camX }) => {
  const f = useCurrentFrame();
  const travel = M.j3.travel;
  const lawn = M.j3_near.anchors.lawn_y;
  const water = M.j3_mid.anchors.water_y;
  const [ckx, cky] = M.j3_far.anchors.clock;
  const [cx, cy] = onPlane(ckx, cky, M.j3_far.parallax, camX, S);
  const [fx0, fy0] = M.j3_near.anchors.fountain;
  const [fsx, fsy] = onPlane(fx0, fy0, 1, camX, S);

  const kites: Array<[number, number, number]> = [
    [260, 118, 0],
    [700, 96, 1],
    [1090, 128, 2],
  ];

  return (
    <>
      <Plate name="j3_sky" scale={S} camX={camX} />
      <Clouds scale={S} camX={camX} items={[[0, 20, 50], [3, 170, 30], [1, 330, 70], [2, 470, 40]]} />
      <Plate name="j3_far" scale={S} camX={camX} />
      {/* clock hands: the minutes tick on while it flies */}
      <div style={{ position: "absolute", left: cx, top: cy }}>
        <div style={{ position: "absolute", left: -2, top: -24, width: 4, height: 24, background: "#3a2f28", transformOrigin: "50% 100%", rotate: `${228 + f * 0.09}deg` }} />
        <div style={{ position: "absolute", left: -2, top: -16, width: 4, height: 16, background: "#3a2f28", transformOrigin: "50% 100%", rotate: `${290 + f * 0.0075}deg` }} />
        <div style={{ position: "absolute", left: -3, top: -3, width: 6, height: 6, background: "#3a2f28" }} />
      </div>
      <Plate name="j3_mid" scale={S} camX={camX} />
      {/* river shimmer */}
      {new Array(40).fill(0).map((_, i) => {
        const wx = rand(i * 3) * (M.j3_mid.w - 20);
        const wy = water + 2 + rand(i * 7) * 22;
        const [sx, sy] = onPlane(wx, wy, M.j3_mid.parallax, camX, S);
        const on = Math.sin(f / 7 + i * 1.7) > 0.3;
        return on ? (
          <div key={i} style={{ position: "absolute", left: sx, top: sy, width: (3 + (i % 4)) * S, height: S, background: "#d6e6e1", opacity: 0.7 }} />
        ) : null;
      })}
      {[0, 1].map((i) => {
        const bx = 120 + i * 420 + f * (0.25 + i * 0.1);
        const [sx, sy] = onPlane(bx, water - 12, M.j3_mid.parallax, camX, S);
        return <Art key={i} name="boat" scale={S} x={sx} y={sy + Math.sin(f / 14 + i) * 3} />;
      })}
      <Plate name="j3_near" scale={S} camX={camX} />
      {/* fountain */}
      {new Array(22).fill(0).map((_, i) => {
        const t = ((f + i * 4) % 34) / 34;
        const dir = (i % 2 ? 1 : -1) * (0.4 + rand(i) * 0.8);
        const x = fsx + dir * t * 60;
        const y = fsy - Math.sin(Math.PI * t) * 70 + t * 30;
        return <div key={i} style={{ position: "absolute", left: x, top: y, width: S, height: S, background: "#e8f3f2", opacity: 0.9 - t * 0.5 }} />;
      })}
      {/* kites and the people flying them */}
      {kites.map(([kx, ky, i]) => {
        const bob = Math.sin(f / 16 + i) * 5;
        const [sx, sy] = onPlane(kx + Math.sin(f / 30 + i) * 4, ky + bob, 1, camX, S);
        const [hx, hy] = onPlane(kx - 34, lawn + 13, 1, camX, S);
        const P = M.people;
        return (
          <React.Fragment key={i}>
            <svg style={{ position: "absolute", left: 0, top: 0, overflow: "visible" }} width={1} height={1}>
              <path d={`M${hx + 16} ${hy + 20} Q ${(hx + sx) / 2} ${(hy + sy) / 2 + 60} ${sx + 20} ${sy + 36}`} stroke="#4a4440" strokeWidth={2} fill="none" opacity={0.7} />
            </svg>
            <Img src={staticFile("art/kite.png")} style={{ position: "absolute", left: sx, top: sy, width: 40, height: 40, imageRendering: "pixelated", rotate: `${Math.sin(f / 10 + i) * 12}deg` }} />
            {[0, 1, 2].map((k) => (
              <div key={k} style={{ position: "absolute", left: sx + 16 + Math.sin(f / 6 + k + i) * 6, top: sy + 40 + k * 14, width: 8, height: 8, background: k % 2 ? "#f0c26b" : "#c65a43" }} />
            ))}
            <Cell file="art/people.png" sheetW={P.cw * 4} sheetH={P.ch * P.n} cw={P.cw} ch={P.ch} col={0} row={(i * 5 + 2) % P.n} scale={S} style={{ left: hx, top: hy - 5 * S }} />
          </React.Fragment>
        );
      })}
      <Walkers frame={f} camX={camX} scale={S} feetY={lawn + 22} count={20} range={[0, travel + 500]} seed={8} />
      <AbsoluteFill style={{ background: "radial-gradient(ellipse 60% 50% at 78% 18%, rgba(255,236,200,0.35), rgba(255,236,200,0) 70%)", mixBlendMode: "screen" }} />
    </>
  );
};
