import React from "react";
import { AbsoluteFill, useCurrentFrame } from "remotion";
import { Traffic, Walkers } from "../components/Crowd";
import { Art, FilmFinish, FlyingPigeon, Puffs } from "../components/Pixel";
import { onPlane, Plate } from "../components/World";
import { at, ci, ease, M, useAbsFrame } from "../lib";
import { pixelFont } from "../theme";

const S = 4;
const SIGNS = ["CAFÉ", "BOOKS", "BAKERY", "FLORIST", "RECORDS", "DELI", "OPEN", "RAMEN", "TAILOR", "PRINTS", "NOODLE", "VINYL"];
const SIGN_COLORS = ["#f7c873", "#f2a78a", "#bfe0d6", "#f7c873", "#fbe6b0"];

/** The busy street: trams, traffic, shopfronts, people with somewhere to be. */
export const Street: React.FC = () => {
  const f = useCurrentFrame();
  const abs = useAbsFrame("street");
  const travel = M.j2.travel;
  const camX = ci(f, [0, 144], [0, travel], ease.linear);
  const ground = M.j2_near.ground;
  const bell = at("street", "tramBell");

  // the pigeon dives in over the awnings, then weaves above the traffic
  const px = ci(f, [0, 22], [380, 760], ease.out) + Math.sin(f / 22) * 70;
  const py =
    ci(f, [0, 22], [-160, 620], ease.out) + Math.sin(f / 7) * 12 - ci(f, [bell - 14, bell, bell + 20], [0, 90, 0], ease.inOut);
  const rot = ci(f, [0, 22], [38, 0], ease.out) + Math.cos(f / 7) * 4;

  // tram: arrives on the far lane, centred on screen when its bell rings
  const tramSpeed = 3.2;
  const tramLeft = (travel * bell) / 144 + 240 - 56 - tramSpeed * (f - bell);

  return (
    <AbsoluteFill style={{ background: "#e9dcc6", overflow: "hidden" }}>
      <Plate name="j2_sky" scale={S} camX={camX} />
      <Plate name="j2_far" scale={S} camX={camX} />
      <Plate name="j2_near" scale={S} camX={camX} />
      {M.j2_near.anchors.signs.map(([x, y, w, h]: number[], i: number) => {
        const [sx, sy] = onPlane(x, y, 1, camX, S);
        if (sx < -200 || sx > 2000) return null;
        const flicker = i % 4 === 1 && Math.floor(abs / 20) % 2 === 0 ? 0.55 : 1;
        const c = SIGN_COLORS[i % SIGN_COLORS.length];
        return (
          <div
            key={i}
            style={{
              position: "absolute",
              left: sx,
              top: sy,
              width: (w + 1) * S,
              height: h * S,
              display: "flex",
              alignItems: "center",
              justifyContent: "center",
              fontFamily: pixelFont,
              fontSize: 18,
              color: c,
              opacity: flicker,
              textShadow: `0 0 8px ${c}, 0 0 18px ${c}88`,
              letterSpacing: 1,
            }}
          >
            {SIGNS[i % SIGNS.length]}
          </div>
        );
      })}
      {M.j2_near.anchors.smoke?.map(([x, y]: number[], i: number) => {
        const [sx, sy] = onPlane(x, y, 1, camX, S);
        return <Puffs key={i} x={sx} y={sy} scale={S} seed={i + 4} color="rgba(236,226,212,0.6)" rise={16} />;
      })}
      <Walkers frame={f} camX={camX} scale={S} feetY={ground + 5} count={46} range={[-60, travel + 520]} seed={3} />
      <Art
        name="tram"
        scale={S}
        x={(tramLeft - camX) * S}
        y={(ground + 32 - 34) * S + (Math.floor(f / 3) % 2)}
        style={{ scale: "-1 1" }}
      />
      <Traffic frame={f} camX={camX} scale={S} lane={ground + 46} dir={1} count={10} spacing={120} speed={1.6} offset={-80} />
      <Traffic frame={f} camX={camX} scale={S} lane={ground + 30} dir={-1} count={5} spacing={260} speed={2.6} offset={900} seed={7} />
      <FlyingPigeon x={px} y={py} scale={S} absFrame={abs} rotate={rot} />
      <Plate name="j2_fg" scale={S} camX={camX} />
      {/* warm sun bouncing off the facades */}
      <AbsoluteFill
        style={{
          background: "linear-gradient(100deg, rgba(255,214,160,0.18), rgba(255,214,160,0) 45%)",
          mixBlendMode: "screen",
        }}
      />
      <FilmFinish vignette={0.45} warmth={0.14} />
    </AbsoluteFill>
  );
};
