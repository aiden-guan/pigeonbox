import React from "react";
import { AbsoluteFill, useCurrentFrame } from "remotion";
import { Art, Dust, FilmFinish, FlyingPigeon, MascotPigeon, mascotCol, Puffs } from "../components/Pixel";
import { LightShafts } from "../components/World";
import { at, ci, ease, M, qbez, useAbsFrame } from "../lib";
import { C } from "../theme";

const S = 3;

/** Bookend: late light, the pigeon lands back on the sender's ledge. Mail delivered, and seen. */
export const Homecoming: React.FC = () => {
  const f = useCurrentFrame();
  const abs = useAbsFrame("homecoming");
  const land = at("homecoming", "homeLanding");
  const a = M.s1_room.anchors;
  const [lx, ly] = a.ledge;
  const [sx, sy, sw, sh] = a.screen;
  const [sx0, sy0] = a.steam;
  const perch = [lx * S, (ly + 1) * S];

  const t = ci(f, [0, land], [0, 1], ease.out);
  const [fx, fy] = qbez([2050, 180], [1900, 520], [perch[0] + 10, perch[1] - 90], t);
  const landed = f >= land;
  const squash = ci(f, [land, land + 4, land + 12], [0, 1, 0], ease.inOut);
  const glance = ci(f, [land + 8, land + 24, 150], [0, 1, 1], ease.inOut);
  const col = landed && f > land + 20 ? 1 : mascotCol(f, "idle");

  return (
    <AbsoluteFill style={{ background: "#241c18", overflow: "hidden" }}>
      <AbsoluteFill style={{ scale: `${ci(f, [0, 160], [1.09, 1.0], ease.soft)}`, transformOrigin: "1350px 640px" }}>
        <Art name="s1_outside" scale={S} x={-18} style={{ filter: "sepia(0.35) saturate(1.3) brightness(0.98) hue-rotate(-8deg)" }} />
        {!landed ? (
          <FlyingPigeon x={fx} y={fy} scale={S} absFrame={abs} flip glide={f > land - 12} rotate={ci(f, [0, land], [-10, 6], ease.inOut)} />
        ) : (
          <MascotPigeon x={perch[0]} y={perch[1]} scale={S} col={col} style={{ scale: `${1 + squash * 0.08} ${1 - squash * 0.1}` }} />
        )}
        <div
          style={{
            position: "absolute",
            left: 250 * S,
            top: 40 * S,
            width: 350 * S,
            height: 210 * S,
            background: "linear-gradient(115deg, rgba(255,255,255,0) 30%, rgba(255,240,220,0.14) 42%, rgba(255,255,255,0) 52%)",
          }}
        />
        <Art name="s1_room" scale={S} />
        {/* the laptop now shows the Sent row, marked Opened in copper */}
        <div style={{ position: "absolute", left: sx * S, top: sy * S, width: sw * S, height: sh * S, background: "#f7f5f1", overflow: "hidden" }}>
          {[0, 1, 2, 3].map((i) => (
            <div key={i} style={{ position: "absolute", left: 16, top: 22 + i * 46, width: sw * S - 32, height: 30, borderBottom: "2px solid #ece7df" }}>
              <div style={{ position: "absolute", left: 0, top: 8, width: 90, height: 10, background: i ? "#dcd6cc" : "#9a948a" }} />
              <div style={{ position: "absolute", left: 110, top: 8, width: 150, height: 10, background: "#e4dfd6" }} />
              <svg viewBox="0 0 16 16" width={22} height={22} style={{ position: "absolute", right: 64, top: 1 }} fill="none">
                <path d="M3.1 8.3 6.3 11.5 12.9 4.4" stroke={i === 0 ? C.copperInk : "#b4b0a8"} strokeWidth={2.4} strokeLinecap="round" strokeLinejoin="round" />
              </svg>
              <div style={{ position: "absolute", right: 8, top: 8, width: 44, height: 10, background: i === 0 ? "rgba(147,80,35,0.6)" : "#e4dfd6" }} />
            </div>
          ))}
        </div>
        <Puffs x={sx0 * S} y={sy0 * S} scale={S} count={7} rise={34} life={80} />
        <Art name="s1_person" scale={S} y={Math.sin(f / 22) * 3} style={{ rotate: `${glance * 4}deg`, transformOrigin: "620px 1080px" }} />
        {/* late, low, warmer light */}
        <AbsoluteFill style={{ background: "radial-gradient(ellipse 70% 60% at 75% 35%, rgba(255,170,90,0.28), rgba(255,170,90,0) 70%)", mixBlendMode: "screen" }} />
        <AbsoluteFill style={{ background: "rgba(255,150,80,0.1)", mixBlendMode: "multiply" }} />
        <LightShafts x={1320} y={60} angle={48} opacity={0.26} />
        <Dust area={[500, 150, 1100, 700]} count={46} />
      </AbsoluteFill>
      <FilmFinish vignette={0.7} warmth={0.18} />
      <AbsoluteFill style={{ background: C.soot, opacity: ci(f, [136, 160], [0, 1], ease.inOut) }} />
    </AbsoluteFill>
  );
};
