import React from "react";
import { AbsoluteFill, Img, staticFile, useCurrentFrame } from "remotion";
import { ci, ease, M } from "../lib";
import { serif } from "../theme";
import { Art } from "./Pixel";

/** A parallax plate. camX/camY are in near-plane art px. */
export const Plate: React.FC<{ name: string; scale: number; camX: number; camY?: number; style?: React.CSSProperties }> = ({
  name,
  scale,
  camX,
  camY = 0,
  style,
}) => {
  const p = M[name].parallax ?? 1;
  return <Art name={name} scale={scale} x={-camX * p * scale} y={-camY * p * scale} style={style} />;
};

/** Screen position of a point on a parallax plane. */
export const onPlane = (x: number, y: number, parallax: number, camX: number, scale: number, camY = 0) => [
  (x - camX * parallax) * scale,
  (y - camY * parallax) * scale,
];

/** Pixel clouds drifting on a far plane. */
export const Clouds: React.FC<{
  scale: number;
  camX: number;
  parallax?: number;
  items: Array<[number, number, number]>; // [cloudIndex, x, y] in art px
  speed?: number;
  opacity?: number;
}> = ({ scale, camX, parallax = 0.06, items, speed = 0.05, opacity = 0.95 }) => {
  const frame = useCurrentFrame();
  return (
    <>
      {items.map(([i, x, y], k) => (
        <Art
          key={k}
          name={`cloud${i}`}
          scale={scale}
          x={(x + frame * speed - camX * parallax) * scale}
          y={y * scale}
          style={{ opacity }}
        />
      ))}
    </>
  );
};

/** Editorial caption: italic serif, soft focus-in. */
export const Caption: React.FC<{
  children: React.ReactNode;
  from: number;
  to: number;
  x: number;
  y: number;
  size?: number;
  color?: string;
  align?: "left" | "center";
  shadow?: string;
  width?: number;
}> = ({ children, from, to, x, y, size = 96, color = "#2a2622", align = "left", shadow, width = 1400 }) => {
  const f = useCurrentFrame();
  const inT = ci(f, [from, from + 24], [0, 1], ease.out);
  const outT = ci(f, [to - 18, to], [0, 1], ease.in);
  return (
    <div
      style={{
        position: "absolute",
        left: align === "center" ? x - width / 2 : x,
        top: y,
        width,
        textAlign: align,
        fontFamily: serif,
        fontStyle: "italic",
        fontSize: size,
        lineHeight: 1.05,
        letterSpacing: "-0.01em",
        color,
        opacity: inT * (1 - outT),
        translate: `0px ${(1 - inT) * 18 - outT * 10}px`,
        filter: `blur(${(1 - inT) * 8 + outT * 6}px)`,
        textShadow: shadow,
      }}
    >
      {children}
    </div>
  );
};

/** The email, as a small glowing pixel envelope. (x, y) is its centre. */
export const Envelope: React.FC<{ x: number; y: number; scale: number; glow?: number; rotate?: number; opacity?: number }> = ({
  x,
  y,
  scale,
  glow = 1,
  rotate = 0,
  opacity = 1,
}) => (
  <div style={{ position: "absolute", left: x - 7 * scale, top: y - 5 * scale, rotate: `${rotate}deg`, opacity }}>
    <div
      style={{
        position: "absolute",
        left: -10 * scale,
        top: -10 * scale,
        width: 34 * scale,
        height: 30 * scale,
        borderRadius: "50%",
        background: "radial-gradient(closest-side, rgba(255,222,170,0.85), rgba(255,200,140,0.25) 55%, rgba(255,200,140,0))",
        opacity: glow,
      }}
    />
    <Img
      src={staticFile("art/envelope.png")}
      style={{ position: "absolute", width: 14 * scale, height: 10 * scale, imageRendering: "pixelated" }}
    />
  </div>
);

/** Sparkle burst (4-point pixel stars) around a point. */
export const Sparkles: React.FC<{ x: number; y: number; start: number; size?: number; count?: number; spread?: number }> = ({
  x,
  y,
  start,
  size = 10,
  count = 9,
  spread = 90,
}) => {
  const f = useCurrentFrame() - start;
  if (f < 0 || f > 40) return null;
  return (
    <>
      {new Array(count).fill(0).map((_, i) => {
        const a = (i / count) * Math.PI * 2 + i;
        const d = ci(f, [0, 30], [10, spread * (0.6 + (i % 3) * 0.25)], ease.out);
        const o = ci(f, [0, 6, 40], [0, 1, 0], ease.linear);
        const s = size * (1 - f / 50) * (i % 2 ? 1 : 0.6);
        return (
          <div key={i} style={{ position: "absolute", left: x + Math.cos(a) * d, top: y + Math.sin(a) * d, opacity: o }}>
            <div style={{ position: "absolute", left: -s / 2, top: -s * 1.5, width: s, height: s * 3, background: "#fff4dc" }} />
            <div style={{ position: "absolute", left: -s * 1.5, top: -s / 2, width: s * 3, height: s, background: "#fff4dc" }} />
          </div>
        );
      })}
    </>
  );
};

/** Warm diagonal light shafts. */
export const LightShafts: React.FC<{ x: number; y: number; angle?: number; opacity?: number; spread?: number }> = ({
  x,
  y,
  angle = 32,
  opacity = 0.22,
  spread = 1,
}) => {
  const f = useCurrentFrame();
  return (
    <AbsoluteFill style={{ mixBlendMode: "screen", pointerEvents: "none" }}>
      {[0, 1, 2, 3].map((i) => (
        <div
          key={i}
          style={{
            position: "absolute",
            left: x + (i - 1.5) * 170 * spread,
            top: y,
            width: (60 + i * 35) * spread,
            height: 1800,
            transformOrigin: "50% 0%",
            rotate: `${angle}deg`,
            background: "linear-gradient(180deg, rgba(255,226,180,0.9), rgba(255,210,160,0) 80%)",
            filter: "blur(28px)",
            opacity: opacity * (0.7 + 0.3 * Math.sin(f / (40 + i * 9) + i)),
          }}
        />
      ))}
    </AbsoluteFill>
  );
};
