import React from "react";
import { AbsoluteFill, useCurrentFrame } from "remotion";
import { Art, FilmFinish, FlyingPigeon, MascotPigeon, mascotCol } from "../components/Pixel";
import { Envelope, LightShafts, Sparkles } from "../components/World";
import { at, ci, ease, M, qbez, useAbsFrame } from "../lib";

const S = 6;

/** Outside the sender's window: the email floats out through the glass and into the pigeon's satchel. */
export const Ledge: React.FC = () => {
  const f = useCurrentFrame();
  const abs = useAbsFrame("ledge");
  const a = M.s3_facade.anchors;
  const [wx, wy] = a.window;
  const glow = [(wx + a.glow[0]) * S, (wy + a.glow[1] - 4) * S];
  const perch = [199 * S, a.ledge_y * S];
  const bag = [perch[0] - 13 * S, perch[1] - 8 * S];

  const out = at("ledge", "envelopeOut");
  const inn = at("ledge", "envelopeIn");
  const take = at("ledge", "takeoff");

  const envT = ci(f, [out, inn], [0, 1], ease.inOut);
  const [ex, ey] = qbez(glow, [700, 150], bag, envT);
  const envScale = ci(f, [inn - 8, inn], [S, 0.5], ease.in);
  const screenGlow = ci(f, [out - 22, out, inn], [0.35, 1, 0.5], ease.soft);

  // pigeon acting
  let col = mascotCol(f, "idle");
  if (f > out - 6 && f < inn) col = 1; // watches the envelope
  if (f >= inn && f < inn + 6) col = 2; // blink
  if (f >= inn + 6) col = 0;
  const crouch = ci(f, [take - 14, take - 2, take], [0, 1, 0], ease.inOut);

  const flyT = ci(f, [take, take + 40], [0, 1], ease.in);
  const flying = f >= take;
  const fx = perch[0] + flyT * 1500 + ci(f, [take, take + 10], [0, 40], ease.out);
  const fy = perch[1] - 60 - flyT * 1100 + Math.sin(f / 3) * 8;

  const whip = ci(f, [take + 20, 168], [0, 1], ease.in);

  return (
    <AbsoluteFill style={{ background: "#b86a4a", overflow: "hidden" }}>
      <AbsoluteFill
        style={{
          scale: `${ci(f, [0, take], [1.0, 1.07], ease.soft)}`,
          transformOrigin: `${perch[0]}px ${perch[1] - 200}px`,
          translate: `${-whip * 900}px ${whip * 380}px`,
          filter: `blur(${whip * 14}px)`,
        }}
      >
        <Art name="s3_facade" scale={S} />
        {/* the laptop light inside, brightening as the email leaves */}
        <div
          style={{
            position: "absolute",
            left: glow[0] - 260,
            top: glow[1] - 220,
            width: 520,
            height: 420,
            background: "radial-gradient(closest-side, rgba(230,240,255,0.55), rgba(230,240,255,0))",
            mixBlendMode: "screen",
            opacity: screenGlow,
          }}
        />
        <LightShafts x={1500} y={-200} angle={40} opacity={0.16} spread={1.6} />
        {!flying ? (
          <MascotPigeon
            x={perch[0]}
            y={perch[1]}
            scale={S}
            col={col}
            style={{ scale: `${1 + crouch * 0.06} ${1 - crouch * 0.1}` }}
          />
        ) : (
          <FlyingPigeon x={fx} y={fy} scale={S} absFrame={abs} rotate={-24} />
        )}
        {envT > 0 && f < inn ? <Envelope x={ex} y={ey} scale={envScale} rotate={Math.sin(envT * 6) * 10} /> : null}
        <Sparkles x={glow[0]} y={glow[1]} start={out} size={9} />
        <Sparkles x={bag[0]} y={bag[1]} start={inn - 2} size={8} spread={70} />
        {/* takeoff feathers */}
        {f >= take
          ? [0, 1, 2, 3, 4].map((i) => {
              const t = f - take;
              return (
                <div
                  key={i}
                  style={{
                    position: "absolute",
                    left: perch[0] + (i - 2) * 40 + Math.sin(t / 6 + i) * 30,
                    top: perch[1] - 80 + t * (2 + i * 0.4),
                    width: 12,
                    height: 24,
                    background: i % 2 ? "#b4b5bd" : "#9899a3",
                    rotate: `${t * 6 + i * 40}deg`,
                    opacity: ci(t, [0, 50], [1, 0], ease.linear),
                  }}
                />
              );
            })
          : null}
      </AbsoluteFill>
      <FilmFinish vignette={0.5} />
    </AbsoluteFill>
  );
};
