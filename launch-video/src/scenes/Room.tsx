import React from "react";
import { AbsoluteFill, useCurrentFrame } from "remotion";
import { Art, Dust, FilmFinish, FlyingPigeon, MascotPigeon, mascotCol, Puffs } from "../components/Pixel";
import { LightShafts } from "../components/World";
import { ci, ease, M, useAbsFrame } from "../lib";

const S = 3; // art scale for this shot (640x360 art)

/** Opening: a quiet room at sunrise. Someone at their laptop; a pigeon on the ledge outside. */
export const Room: React.FC = () => {
  const f = useCurrentFrame();
  const abs = useAbsFrame("room");
  const a = M.s1_room.anchors;
  const [lx, ly] = a.ledge;
  const [sx, sy, sw, sh] = a.screen;
  const [sx0, sy0] = a.steam;

  // The pigeon mostly idles, then turns to watch the screen.
  const watching = f > 120;
  const col = watching ? 1 : mascotCol(f, "idle");

  return (
    <AbsoluteFill style={{ background: "#241c18", overflow: "hidden" }}>
      <AbsoluteFill
        style={{
          scale: `${ci(f, [0, 200], [1.0, 1.075], ease.soft)}`,
          transformOrigin: "1350px 640px",
          filter: `blur(${ci(f, [0, 45], [7, 0], ease.out)}px)`,
        }}
      >
        <Art name="s1_outside" scale={S} x={ci(f, [0, 200], [0, -18], ease.linear)} />
        {/* distant birds crossing the skyline */}
        <FlyingPigeon x={ci(f, [20, 170], [1850, 780], ease.linear)} y={330 + Math.sin(f / 9) * 6} scale={1} absFrame={abs} flip style={{ filter: "brightness(0.45) saturate(0.4)", opacity: 0.8 }} />
        <FlyingPigeon x={ci(f, [45, 190], [1880, 840], ease.linear)} y={300 + Math.sin(f / 8) * 5} scale={1} absFrame={abs + 4} flip style={{ filter: "brightness(0.45) saturate(0.4)", opacity: 0.7 }} />
        <MascotPigeon x={lx * S} y={(ly + 1) * S} scale={S} row="idle" col={col} />
        {/* glass reflection on the window */}
        <div
          style={{
            position: "absolute",
            left: 250 * S,
            top: 40 * S,
            width: 350 * S,
            height: 210 * S,
            background: "linear-gradient(115deg, rgba(255,255,255,0) 30%, rgba(255,250,240,0.12) 42%, rgba(255,255,255,0) 52%)",
          }}
        />
        <Art name="s1_room" scale={S} />
        {/* laptop screen: the compose window waiting for words */}
        <div
          style={{
            position: "absolute",
            left: sx * S,
            top: sy * S,
            width: sw * S,
            height: sh * S,
            background: "#f7f5f1",
            overflow: "hidden",
          }}
        >
          <div style={{ position: "absolute", left: 18, top: 16, width: 120, height: 10, background: "#dcd6cc" }} />
          <div style={{ position: "absolute", left: 18, top: 40, width: 300, height: 2, background: "#e8e3db" }} />
          <div style={{ position: "absolute", left: 18, top: 58, width: 200, height: 8, background: "#e0dad1" }} />
          <div style={{ position: "absolute", left: 18, top: 78, width: 300, height: 2, background: "#e8e3db" }} />
          <div
            style={{
              position: "absolute",
              left: 20,
              top: 96,
              width: 4,
              height: 20,
              background: "#3b3833",
              opacity: Math.floor(f / 15) % 2 ? 1 : 0,
            }}
          />
          <div style={{ position: "absolute", right: 16, bottom: 14, width: 64, height: 22, borderRadius: 11, background: "#0b57d0" }} />
          <div style={{ position: "absolute", right: 90, bottom: 16, width: 70, height: 18, borderRadius: 9, background: "rgba(221,167,122,0.35)" }} />
        </div>
        {/* screen light spilling onto the desk and the person */}
        <div
          style={{
            position: "absolute",
            left: sx * S - 260,
            top: sy * S - 140,
            width: sw * S + 520,
            height: sh * S + 460,
            background: "radial-gradient(closest-side, rgba(220,235,255,0.22), rgba(220,235,255,0))",
            mixBlendMode: "screen",
          }}
        />
        <Puffs x={sx0 * S} y={sy0 * S} scale={S} count={7} rise={34} life={80} />
        <Art name="s1_person" scale={S} y={Math.sin(f / 22) * 3} />
        <LightShafts x={1260} y={60} angle={38} opacity={0.2} />
        <Dust area={[500, 150, 1100, 700]} count={46} />
      </AbsoluteFill>
      <FilmFinish vignette={0.65} />
      <AbsoluteFill style={{ background: "#000", opacity: ci(f, [0, 55], [1, 0], ease.soft) }} />
    </AbsoluteFill>
  );
};
