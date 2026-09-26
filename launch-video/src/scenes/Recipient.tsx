import React from "react";
import { AbsoluteFill, useCurrentFrame } from "remotion";
import { Art, FilmFinish, FlyingPigeon, MascotPigeon, mascotCol, Puffs, SheetRow } from "../components/Pixel";
import { Envelope, LightShafts, Sparkles } from "../components/World";
import { at, ci, ease, M, qbez, useAbsFrame } from "../lib";

const S = 6;
const A = M.r1_facade.anchors;
const [WX, WY] = A.window;
const PERCH = [199 * S, A.ledge_y * S];
const BAG = [PERCH[0] - 13 * S, PERCH[1] - 8 * S];
const FACE = [(WX + A.face[0]) * S, (WY + A.face[1]) * S];
const LAPTOP = [(WX + A.face[0]) * S, (WY + A.face[1] + 26) * S];
const STEAM = [(WX + A.steam[0]) * S, (WY + A.steam[1]) * S];

/** Maya's window: facade, her screen-light, her tea. */
const Facade: React.FC<{ faceLight: number }> = ({ faceLight }) => (
  <>
    <Art name="r1_facade" scale={S} />
    <div
      style={{
        position: "absolute",
        left: FACE[0] - 240,
        top: FACE[1] - 200,
        width: 480,
        height: 460,
        background: "radial-gradient(closest-side, rgba(225,238,255,0.6), rgba(225,238,255,0))",
        mixBlendMode: "screen",
        opacity: faceLight,
      }}
    />
    <Puffs x={STEAM[0]} y={STEAM[1]} scale={S} count={6} rise={14} life={70} color="rgba(255,250,240,0.35)" />
    <LightShafts x={1650} y={-240} angle={42} opacity={0.14} spread={1.6} />
  </>
);

/** The pigeon arrives on Maya's ledge and hands the email over. */
export const Arrival: React.FC = () => {
  const f = useCurrentFrame();
  const abs = useAbsFrame("arrival");
  const land = at("arrival", "landing");
  const coo = at("arrival", "coo");
  const give0 = 84;
  const give1 = 140;

  const t = ci(f, [0, land], [0, 1], ease.out);
  const [fx, fy] = qbez([2150, -160], [1500, 260], [PERCH[0], PERCH[1] - 150], t);
  const squash = ci(f, [land, land + 4, land + 12], [0, 1, 0], ease.inOut);
  let col = mascotCol(f, "idle");
  if (f >= coo && f < coo + 30) col = 1;
  if (f >= give0 && f < give1) col = 1;
  const bob = f >= coo && f < coo + 30 ? Math.abs(Math.sin((f - coo) / 4)) * -8 : 0;

  const envT = ci(f, [give0, give1], [0, 1], ease.inOut);
  const [ex, ey] = qbez(BAG, [760, 260], LAPTOP, envT);
  const faceLight = 0.45 + ci(f, [give1 - 4, give1 + 6, 160], [0, 0.55, 0.35], ease.out);

  return (
    <AbsoluteFill style={{ background: "#9c6b54", overflow: "hidden" }}>
      <AbsoluteFill style={{ scale: `${ci(f, [0, 160], [1.0, 1.06], ease.soft)}`, transformOrigin: "760px 620px" }}>
        <Facade faceLight={faceLight} />
        {f < land ? (
          <FlyingPigeon x={fx} y={fy} scale={S} absFrame={abs} flip rotate={ci(f, [0, land], [-18, 8], ease.inOut)} glide={f > land - 10} />
        ) : (
          <MascotPigeon x={PERCH[0]} y={PERCH[1]} scale={S} col={col} style={{ scale: `${1 + squash * 0.08} ${1 - squash * 0.1}`, translate: `0px ${bob}px` }} />
        )}
        {/* landing dust */}
        {f >= land && f < land + 24
          ? [0, 1, 2, 3, 4, 5].map((i) => {
              const k = f - land;
              const dir = i < 3 ? -1 : 1;
              return (
                <div
                  key={i}
                  style={{
                    position: "absolute",
                    left: PERCH[0] + dir * (40 + k * (3 + (i % 3))),
                    top: PERCH[1] - 10 - k * (0.6 + (i % 3) * 0.4),
                    width: 12,
                    height: 12,
                    background: "#efe2c8",
                    opacity: 1 - k / 24,
                  }}
                />
              );
            })
          : null}
        {envT > 0 && envT < 1 ? <Envelope x={ex} y={ey} scale={ci(f, [give1 - 10, give1], [S, 1], ease.in)} rotate={Math.sin(envT * 6) * 8} /> : null}
        <Sparkles x={BAG[0]} y={BAG[1]} start={give0} size={8} spread={60} />
        <Sparkles x={LAPTOP[0]} y={LAPTOP[1]} start={give1 - 2} size={9} />
      </AbsoluteFill>
      <FilmFinish vignette={0.5} />
    </AbsoluteFill>
  );
};

/** She opens it — and the pigeon sees. (PigeonBox's "open detected" sprite row.) */
export const Seen: React.FC = () => {
  const f = useCurrentFrame();
  const o = at("seen", "opened");
  let row: SheetRow = "idle";
  let col = mascotCol(f, "idle");
  if (f >= o) {
    row = "opened";
    col = f < o + 8 ? 0 : f < o + 16 ? 1 : f < o + 72 ? 2 : 3;
  }
  const bubble = ci(f, [o + 30, o + 40], [0, 1], ease.out);
  const lens = [PERCH[0] + 4 * S, PERCH[1] - 27 * S];

  return (
    <AbsoluteFill style={{ background: "#9c6b54", overflow: "hidden" }}>
      <AbsoluteFill style={{ scale: `${ci(f, [0, 120], [1.34, 1.46], ease.soft)}`, transformOrigin: "860px 640px" }}>
        <Facade faceLight={0.85 + 0.1 * Math.sin(f / 9)} />
        <MascotPigeon x={PERCH[0]} y={PERCH[1]} scale={S} row={row} col={col} />
        <Sparkles x={lens[0]} y={lens[1]} start={o + 16} size={8} spread={60} />
        {/* pixel thought bubble with PigeonBox's copper check */}
        <div
          style={{
            position: "absolute",
            left: PERCH[0] + 70,
            top: PERCH[1] - 380,
            width: 150,
            height: 110,
            scale: `${bubble}`,
            opacity: bubble,
            transformOrigin: "0% 100%",
          }}
        >
          <div style={{ position: "absolute", inset: 0, background: "#fbf6ec", border: "6px solid #1d1b1a", boxShadow: "0 6px 0 rgba(0,0,0,0.15)" }} />
          <div style={{ position: "absolute", left: -6, bottom: -30, width: 24, height: 24, background: "#fbf6ec", border: "6px solid #1d1b1a" }} />
          <div style={{ position: "absolute", left: -30, bottom: -60, width: 18, height: 18, background: "#fbf6ec", border: "6px solid #1d1b1a" }} />
          <svg viewBox="0 0 16 16" width={84} height={84} style={{ position: "absolute", left: 33, top: 13 }} fill="none">
            <path d="M3.1 8.3 6.3 11.5 12.9 4.4" stroke="#935023" strokeWidth={2.4} strokeLinecap="square" strokeLinejoin="miter" />
          </svg>
        </div>
      </AbsoluteFill>
      <FilmFinish vignette={0.55} />
    </AbsoluteFill>
  );
};
