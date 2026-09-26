import React from "react";
import { AbsoluteFill, useCurrentFrame } from "remotion";
import { Cell, FilmFinish, FlyingPigeon, MascotPigeon, mascotCol } from "../components/Pixel";
import { Plate } from "../components/World";
import { at, ci, ease, M, qbez, useAbsFrame } from "../lib";
import { sans } from "../theme";

const S = 4;
const WARM = "sepia(0.22) saturate(1.25) hue-rotate(-10deg) brightness(0.96)";

/** A plain city pigeon (the mascot without its satchel). (x, y) is between its feet. */
const Friend: React.FC<{ x: number; y: number; variant: number; frame: number; flip?: boolean }> = ({ x, y, variant, frame, flip }) => (
  <Cell
    file="art/pigeon-friends-1x.png"
    sheetW={200}
    sheetH={160}
    cw={50}
    ch={40}
    col={mascotCol(frame, "idle")}
    row={variant}
    scale={S}
    style={{ left: x - 25 * S, top: y - 39 * S, scale: flip ? "-1 1" : undefined, filter: WARM }}
  />
);

/** Sunset, later that day: the pigeon on a skyscraper with its friends, and the name in the sky. */
export const EndCard: React.FC = () => {
  const f = useCurrentFrame();
  const abs = useAbsFrame("endcard");
  const logo = at("endcard", "logo");
  const camX = ci(f, [0, 240], [0, 34], ease.soft);
  const roofY = M.ss_roof.top * S;

  // friends along the parapet; the straggler lands in the gap at x = 1400
  const seats: Array<[number, number, boolean, number]> = [
    [290, 0, false, 11],
    [520, 1, true, 37],
    [745, 2, false, 5],
    [1180, 3, true, 23],
    [1600, 1, false, 52],
  ];
  const landAt = 58;
  const t = ci(f, [8, landAt], [0, 1], ease.out);
  const [sx, sy] = qbez([2100, 160], [1700, 300], [1400, roofY - 110], t);
  const squash = ci(f, [landAt, landAt + 4, landAt + 12], [0, 1, 0], ease.inOut);

  const word = ci(f, [logo, logo + 30], [0, 1], ease.out);
  const fadeIn = ci(f, [0, 26], [1, 0], ease.soft);
  const fadeOut = ci(f, [206, 240], [0, 1], ease.inOut);

  return (
    <AbsoluteFill style={{ background: "#2e2344", overflow: "hidden" }}>
      <AbsoluteFill style={{ scale: `${ci(f, [0, 240], [1.07, 1.0], ease.soft)}`, transformOrigin: "50% 80%" }}>
        <Plate name="ss_sky" scale={S} camX={camX} />
        {/* birds crossing the sun, far away */}
        {[0, 1, 2].map((i) => (
          <FlyingPigeon
            key={i}
            x={ci(f, [0, 240], [-100 - i * 90, 1100 + i * 60], ease.linear)}
            y={560 - i * 34 + Math.sin(f / 9 + i) * 6}
            scale={1}
            absFrame={abs + i * 3}
            style={{ filter: "brightness(0.25) saturate(0.3)", opacity: 0.8 }}
          />
        ))}
        <Plate name="ss_far" scale={S} camX={camX} />
        <Plate name="ss_mid" scale={S} camX={camX} />
        <Plate name="ss_roof" scale={S} camX={camX} />
        {/* antenna beacon */}
        <div
          style={{
            position: "absolute",
            left: (M.ss_roof.beacon[0] - camX) * S - 6,
            top: M.ss_roof.beacon[1] * S - 6,
            width: 12,
            height: 12,
            background: "#ff5a48",
            boxShadow: "0 0 18px 6px rgba(255,90,72,0.6)",
            opacity: Math.floor(f / 15) % 2 ? 1 : 0.15,
          }}
        />
        {seats.map(([x, v, flip, phase]) => (
          <Friend key={x} x={x - camX * S} y={roofY} variant={v} frame={f + phase} flip={flip} />
        ))}
        {/* the straggler flies in to join */}
        {f < landAt ? (
          <FlyingPigeon x={sx - camX * S} y={sy} scale={S} absFrame={abs} flip glide={f > landAt - 10} rotate={ci(f, [8, landAt], [-12, 6], ease.inOut)} style={{ filter: WARM }} />
        ) : (
          <div style={{ position: "absolute", left: 0, top: 0, scale: `${1 + squash * 0.06} ${1 - squash * 0.08}`, transformOrigin: `${1400 - camX * S}px ${roofY}px` }}>
            <Friend x={1400 - camX * S} y={roofY} variant={0} frame={f + 17} />
          </div>
        )}
        {/* our pigeon, satchel and all, in the middle of them */}
        <MascotPigeon x={960 - camX * S} y={roofY} scale={S} col={mascotCol(f, "idle")} style={{ filter: WARM }} />
        {/* warm sunset spill */}
        <AbsoluteFill style={{ background: "radial-gradient(ellipse 55% 45% at 50% 62%, rgba(255,170,120,0.28), rgba(255,170,120,0) 70%)", mixBlendMode: "screen" }} />
      </AbsoluteFill>
      <div
        style={{
          position: "absolute",
          left: 0,
          right: 0,
          top: 190,
          textAlign: "center",
          fontFamily: sans,
          fontWeight: 600,
          fontSize: 210,
          letterSpacing: "-0.045em",
          color: "#fff1e4",
          textShadow: "0 0 40px rgba(255,160,140,0.55), 0 0 90px rgba(255,120,120,0.35)",
          opacity: word,
          translate: `0px ${(1 - word) * 26}px`,
          filter: `blur(${(1 - word) * 12}px)`,
        }}
      >
        PigeonBox
      </div>
      <FilmFinish vignette={0.55} grain={0.06} warmth={0.12} />
      <AbsoluteFill style={{ background: "#000", opacity: Math.max(fadeIn, fadeOut) }} />
    </AbsoluteFill>
  );
};
