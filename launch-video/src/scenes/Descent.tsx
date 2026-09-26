import React from "react";
import { AbsoluteFill, useCurrentFrame } from "remotion";
import { Walkers } from "../components/Crowd";
import { FilmFinish, FlyingPigeon } from "../components/Pixel";
import { Clouds, onPlane, Plate } from "../components/World";
import { ci, ease, M, qbez, useAbsFrame } from "../lib";

const S = 4;
const CAM_END = 340;

/** A quieter street across town. One window is warm and lit. */
export const Descent: React.FC = () => {
  const f = useCurrentFrame();
  const abs = useAbsFrame("descent");
  const camX = ci(f, [0, 160], [0, CAM_END], ease.soft);
  const tw = M.j5_near.anchors.target.windows[4];
  const [wx, wy] = onPlane(tw[0] + tw[2] / 2, tw[1] + tw[3] / 2, 1, CAM_END, S);

  const t = ci(f, [0, 156], [0, 1], ease.inOut);
  const [px, py] = qbez([-120, 120], [520, 60], [wx + 30, wy + 30], t);
  const scale = ci(f, [0, 156], [4, 2.6], ease.in);
  const rot = ci(f, [0, 60, 156], [18, 10, 24], ease.inOut);
  const [tx, ty] = onPlane(tw[0] - 6, tw[1] - 6, 1, camX, S);

  return (
    <AbsoluteFill style={{ background: "#ece0cb", overflow: "hidden" }}>
      <Plate name="j5_sky" scale={S} camX={camX} />
      <Clouds scale={S} camX={camX} items={[[2, 60, 40], [0, 260, 25], [3, 400, 55]]} />
      <Plate name="j5_far" scale={S} camX={camX} />
      <Plate name="j5_near" scale={S} camX={camX} />
      {/* the recipient's window glows a little warmer */}
      <div
        style={{
          position: "absolute",
          left: tx - 60,
          top: ty - 60,
          width: (tw[2] + 12) * S + 120,
          height: (tw[3] + 12) * S + 120,
          background: "radial-gradient(closest-side, rgba(255,214,150,0.55), rgba(255,214,150,0))",
          mixBlendMode: "screen",
          opacity: 0.6 + 0.4 * Math.sin(f / 10),
        }}
      />
      <Walkers frame={f} camX={camX} scale={S} feetY={M.j5_near.ground + 6} count={10} range={[0, 900]} seed={12} />
      <FlyingPigeon x={px} y={py} scale={scale} absFrame={abs} rotate={rot} />
      <Plate name="j5_fg" scale={S} camX={camX} />
      <FilmFinish vignette={0.45} warmth={0.14} />
    </AbsoluteFill>
  );
};
