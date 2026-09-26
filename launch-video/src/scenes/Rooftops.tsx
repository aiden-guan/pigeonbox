import React from "react";
import { AbsoluteFill, useCurrentFrame } from "remotion";
import { FilmFinish, FlyingPigeon, Puffs } from "../components/Pixel";
import { Caption, Clouds, onPlane, Plate } from "../components/World";
import { ci, ease, M, useAbsFrame } from "../lib";

const S = 4;

/** Sunrise over the rooftops. The journey begins. */
export const Rooftops: React.FC = () => {
  const f = useCurrentFrame();
  const abs = useAbsFrame("rooftops");
  const camX = ci(f, [0, 96], [0, M.j1.travel], ease.linear);
  const px = ci(f, [0, 18], [-240, 700], ease.out) + ci(f, [18, 96], [0, 140], ease.soft);
  const py = 430 + Math.sin(f / 7) * 16 + ci(f, [78, 96], [0, 460], ease.in);
  const rot = ci(f, [0, 16, 78, 96], [-14, -4, -4, 30], ease.inOut);

  return (
    <AbsoluteFill style={{ background: "#e9dcc6", overflow: "hidden" }}>
      <Plate name="j1_sky" scale={S} camX={camX} />
      <Clouds
        scale={S}
        camX={camX}
        items={[
          [1, 40, 40],
          [0, 230, 70],
          [2, 380, 30],
          [3, 520, 60],
        ]}
      />
      <Plate name="j1_far" scale={S} camX={camX} />
      <Plate name="j1_mid" scale={S} camX={camX} />
      <Plate name="j1_near" scale={S} camX={camX} />
      {M.j1_near.anchors.smoke.map(([x, y]: number[], i: number) => {
        const [sx, sy] = onPlane(x, y, 1, camX, S);
        return <Puffs key={i} x={sx} y={sy} scale={S} seed={i} color="rgba(236,226,212,0.7)" rise={20} />;
      })}
      <Caption from={6} to={92} x={140} y={150} size={112}>
        Every email takes a journey.
      </Caption>
      <FlyingPigeon x={px} y={py} scale={S} absFrame={abs} rotate={rot} />
      <Plate name="j1_fg" scale={S} camX={camX} />
      <FilmFinish vignette={0.45} warmth={0.16} />
    </AbsoluteFill>
  );
};
