import React from "react";
import { AbsoluteFill, useCurrentFrame } from "remotion";
import { Art, FilmFinish, FlyingPigeon } from "../components/Pixel";
import { Clouds, Plate } from "../components/World";
import { at, ci, ease, M, rand, useAbsFrame } from "../lib";

const S = 3; // city far below (640x360 plates)
const JS = 5; // the airliner, close

/** An airliner on final approach roars over the pigeon; its wake sends it tumbling. */
export const Airplane: React.FC = () => {
  const f = useCurrentFrame();
  const abs = useAbsFrame("airplane");
  const pass = at("airplane", "jetPass");
  const camX = ci(f, [0, 192], [40, 360], ease.linear);

  // the jet: sweeps left → right, its gear skimming just over the pigeon at `pass`
  const jw = M.jet.w * JS;
  const jx = ci(f, [pass - 46, pass + 40], [-jw - 200, 1920 + 300], ease.linear);
  const jy = ci(f, [pass - 46, pass + 40], [200, 150], ease.linear);
  const jetCenter = jx + jw / 2;

  // pigeon: flies steady, ducks as the gear arrives, tumbles in the wake, recovers
  const duck = ci(f, [pass - 16, pass - 7], [0, 1], ease.out);
  const tumble = ci(f, [pass, pass + 34], [0, 1], ease.out);
  const recover = ci(f, [pass + 34, pass + 70], [0, 1], ease.inOut);
  const px = 820 + ci(f, [0, 30], [-500, 0], ease.out) + tumble * 260 * (1 - recover) - recover * 60;
  const py = 560 + Math.sin(f / 6) * 10 + duck * 90 + tumble * 170 * (1 - recover * 0.8);
  const rot = f < pass ? -4 + duck * 16 : ci(f, [pass, pass + 34, pass + 70], [12, 560, 720], ease.out);

  // camera: rumble as it approaches, a hard jolt at the pass
  const shakeAmt = ci(f, [pass - 36, pass, pass + 30, pass + 60], [2, 22, 8, 0], ease.linear);
  const shx = (rand(f * 1.3) - 0.5) * shakeAmt;
  const shy = (rand(f * 2.1 + 5) - 0.5) * shakeAmt;
  const shadow = ci(f, [pass - 30, pass - 6, pass + 8, pass + 30], [0, 0.42, 0.42, 0], ease.inOut);

  return (
    <AbsoluteFill style={{ background: "#e6dcc8", overflow: "hidden" }}>
      <AbsoluteFill style={{ translate: `${shx}px ${shy}px`, scale: "1.04" }}>
        <Plate name="j4_sky" scale={S} camX={camX} />
        <Clouds scale={S} camX={camX} items={[[1, 60, 60], [0, 300, 100], [2, 470, 50], [3, 610, 120]]} speed={0.2} />
        <Plate name="j4_l1" scale={S} camX={camX} />
        <Plate name="j4_l2" scale={S} camX={camX} />
        <Plate name="j4_l3" scale={S} camX={camX} />
        <Plate name="j4_l4" scale={S} camX={camX} />
        <AbsoluteFill style={{ background: "linear-gradient(180deg, rgba(245,220,190,0) 40%, rgba(245,220,190,0.35) 100%)" }} />
        {/* the jet's shadow sweeping over everything */}
        <AbsoluteFill
          style={{
            background: `radial-gradient(ellipse 40% 30% at ${(jetCenter / 1920) * 100}% 30%, rgba(20,18,24,${shadow}), rgba(20,18,24,0))`,
          }}
        />
        <FlyingPigeon x={px} y={py} scale={4} absFrame={abs} rotate={rot} glide={f >= pass && f < pass + 34} />
        {/* feathers shaken loose */}
        {f >= pass
          ? new Array(7).fill(0).map((_, i) => {
              const t = f - pass;
              return (
                <div
                  key={i}
                  style={{
                    position: "absolute",
                    left: 820 + t * (3 + i * 1.6) - i * 20,
                    top: 640 + t * (1 + (i % 3)) + Math.sin(t / 5 + i) * 30 - 30 * i,
                    width: 10,
                    height: 22,
                    background: i % 2 ? "#b4b5bd" : "#9899a3",
                    rotate: `${t * 9 + i * 50}deg`,
                    opacity: ci(t, [0, 60], [1, 0], ease.linear),
                  }}
                />
              );
            })
          : null}
        {/* the airliner, with a little motion smear */}
        {[0.18, 0.35].map((o, i) => (
          <Art key={i} name="jet" scale={JS} x={jx - (i + 1) * 60} y={jy} style={{ opacity: o, filter: "blur(6px)" }} />
        ))}
        <Art name="jet" scale={JS} x={jx} y={jy} />
        {/* landing light and beacon */}
        <div
          style={{
            position: "absolute",
            left: jx + 150 * JS - 180,
            top: jy + 46 * JS - 180,
            width: 360,
            height: 360,
            borderRadius: "50%",
            background: "radial-gradient(closest-side, rgba(255,250,230,0.95), rgba(255,240,200,0.35) 40%, rgba(255,240,200,0))",
            mixBlendMode: "screen",
          }}
        />
        <div
          style={{
            position: "absolute",
            left: jx + M.jet.beacon[0] * JS - 8,
            top: jy + M.jet.beacon[1] * JS - 8,
            width: 16,
            height: 16,
            background: "#ff4a3a",
            boxShadow: "0 0 24px 8px rgba(255,74,58,0.7)",
            opacity: Math.floor(f / 6) % 3 === 0 ? 1 : 0,
          }}
        />
        {/* wake turbulence: shimmering air behind the engine */}
        <div
          style={{
            position: "absolute",
            left: jx + M.jet.engine[0] * JS - 1500,
            top: jy + M.jet.engine[1] * JS - 40,
            width: 1500,
            height: 80,
            background: "linear-gradient(90deg, rgba(255,255,255,0), rgba(255,250,240,0.35))",
            filter: "blur(18px)",
          }}
        />
      </AbsoluteFill>
      <AbsoluteFill style={{ background: "#fff6e6", opacity: ci(f, [pass, pass + 5], [0.35, 0], ease.out) * (f >= pass ? 1 : 0) }} />
      <FilmFinish vignette={0.45} warmth={0.16} />
    </AbsoluteFill>
  );
};
