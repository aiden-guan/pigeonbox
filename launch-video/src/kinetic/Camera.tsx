import React from "react";
import { AbsoluteFill } from "remotion";

/**
 * A perspective camera looking at one UI plane, with optical depth of field.
 *
 * The plane is rotated in-plane (roll), then yawed, then tilted back (pitch), so text runs
 * diagonally and recedes. Depth on the plane is linear, so depth of field is built from
 * stacked copies of the plane: the most blurred copy at the bottom, and each sharper copy
 * above it masked to a narrower band around the focal line. Every copy is opaque inside its
 * band, so the stack never shows seams.
 */
export type Cam = {
  /** UI size in px. */
  w: number;
  h: number;
  /** Focal point on the UI, in UI px. It lands at the frame centre plus (tx, ty). */
  fx: number;
  fy: number;
  tx?: number;
  ty?: number;
  /** Degrees. */
  pitch: number;
  yaw?: number;
  roll?: number;
  /** Magnification at the focal point. */
  mag: number;
  perspective?: number;
  /** Half-depth of the sharp band, in screen-depth px. */
  band?: number;
  /** Screen blur px per screen-depth px outside the band. */
  rate?: number;
  /** Light pool centre and radii, in UI px. */
  light?: { x: number; y: number; rx: number; ry: number; dim?: number; kx?: number; ky?: number };
  /** Render the UI natively at this multiple so the camera never upscales a 1x raster. */
  res?: number;
};

const LEVELS = [0, 1.6, 3.5, 6.5, 11, 17, 26];
const rad = (d: number) => (d * Math.PI) / 180;

export const CameraRig: React.FC<{
  cam: Cam;
  children: React.ReactNode;
  bg?: string;
  vignette?: number;
}> = ({ cam, children, bg = "#000", vignette = 0.75 }) => {
  const res = cam.res ?? 3;
  const {
    tx = 0,
    ty = 0,
    pitch,
    yaw = 0,
    roll = 0,
    perspective = 1300,
    band = 40,
    rate = 0.05,
  } = cam;
  // Work in the high-resolution plane's own pixels from here on.
  const w = cam.w * res;
  const h = cam.h * res;
  const fx = cam.fx * res;
  const fy = cam.fy * res;
  const mag = cam.mag / res;
  const light = cam.light
    ? { ...cam.light, x: cam.light.x * res, y: cam.light.y * res, rx: cam.light.rx * res, ry: cam.light.ry * res, kx: (cam.light.kx ?? 0) * res, ky: (cam.light.ky ?? 0) * res }
    : undefined;

  // Depth gradient on the plane: z(x, y) = A x + B y, in screen px per UI px.
  const p = rad(pitch);
  const yw = rad(yaw);
  const r = rad(roll);
  const A = mag * (Math.sin(p) * Math.sin(r) - Math.cos(p) * Math.sin(yw) * Math.cos(r));
  const B = mag * (Math.sin(p) * Math.cos(r) + Math.cos(p) * Math.sin(yw) * Math.sin(r));
  const G = Math.max(1e-4, Math.hypot(A, B));
  const dx = A / G;
  const dy = B / G;
  // CSS gradient angle whose direction vector is (dx, dy).
  const theta = Math.atan2(dx, -dy);
  const L = Math.abs(w * Math.sin(theta)) + Math.abs(h * Math.cos(theta));
  const pos0 = L / 2 + (fx - w / 2) * dx + (fy - h / 2) * dy;
  const deg = (theta * 180) / Math.PI;

  // Boundary (in UI px along the gradient) where the screen blur reaches a level.
  const edge = (level: number) => (band + level / rate) / G;

  const transform = `translate3d(${tx}px, ${ty}px, 0) rotateX(${pitch}deg) rotateY(${yaw}deg) rotateZ(${roll}deg) scale(${mag})`;
  const planeStyle: React.CSSProperties = {
    position: "absolute",
    left: 960 - fx,
    top: 540 - fy,
    width: w,
    height: h,
    transformOrigin: `${fx}px ${fy}px`,
    transform,
  };

  const layers = LEVELS.map((level, i) => {
    const blur = level / mag;
    if (i === LEVELS.length - 1) {
      return { i, blur, mask: undefined as string | undefined };
    }
    // Opaque while the blur is below the midpoint to the next level, then fade.
    const reach = edge((level + LEVELS[i + 1]) / 2);
    const f = Math.max(6, (edge(LEVELS[i + 1]) - edge(level)) * 0.6);
    const a = pos0 - reach;
    const z = pos0 + reach;
    const mask = `linear-gradient(${deg}deg, transparent ${a - f / 2}px, #000 ${a + f / 2}px, #000 ${z - f / 2}px, transparent ${z + f / 2}px)`;
    return { i, blur, mask };
  }).reverse();

  const kx = light ? light.x + (light.kx ?? 0) : 0;
  const ky = light ? light.y + (light.ky ?? 0) : 0;

  return (
    <AbsoluteFill style={{ background: bg, overflow: "hidden" }}>
      <AbsoluteFill style={{ perspective, perspectiveOrigin: "50% 50%" }}>
        {layers.map(({ i, blur, mask }) => (
          <div
            key={i}
            style={{
              ...planeStyle,
              filter: blur > 0.05 ? `blur(${blur.toFixed(2)}px) brightness(${1 - Math.min(0.25, i * 0.035)})` : undefined,
              WebkitMaskImage: mask,
              maskImage: mask,
            }}
          >
            <div style={{ zoom: res, width: cam.w, height: cam.h }}>{children}</div>
          </div>
        ))}
        {light ? (
          <div
            style={{
              ...planeStyle,
              pointerEvents: "none",
              background: [
                `radial-gradient(ellipse ${light.rx * 0.6}px ${light.ry * 0.6}px at ${kx}px ${ky}px, transparent 0%, transparent 60%, rgb(0 0 0 / 0.04) 82%, rgb(0 0 0 / 0.09) 100%)`,
                `radial-gradient(ellipse ${light.rx * 1.25}px ${light.ry * 1.25}px at ${light.x}px ${light.y}px, transparent 0%, transparent 26%, rgb(0 0 0 / 0.05) 38%, rgb(0 0 0 / ${0.24 * (light.dim ?? 1)}) 50%, rgb(0 0 0 / ${0.52 * (light.dim ?? 1)}) 68%, rgb(0 0 0 / ${0.82 * (light.dim ?? 1)}) 85%, rgb(0 0 0 / ${0.96 * (light.dim ?? 1)}) 100%)`,
              ].join(","),
            }}
          />
        ) : null}
      </AbsoluteFill>
      <AbsoluteFill
        style={{
          pointerEvents: "none",
          background: `radial-gradient(120% 95% at 50% 50%, transparent 50%, rgb(0 0 0 / ${vignette}) 100%)`,
        }}
      />
    </AbsoluteFill>
  );
};

/** Keyframed focus track: [frame, x, y][], eased between keys. */
export type Key = [number, number, number];
export const track = (f: number, keys: Key[]): [number, number] => {
  if (f <= keys[0][0]) return [keys[0][1], keys[0][2]];
  for (let i = 1; i < keys.length; i++) {
    const [f1, x1, y1] = keys[i];
    const [f0, x0, y0] = keys[i - 1];
    if (f <= f1) {
      const t = (f - f0) / Math.max(1, f1 - f0);
      const e = t < 0.5 ? 4 * t * t * t : 1 - Math.pow(-2 * t + 2, 3) / 2;
      return [x0 + (x1 - x0) * e, y0 + (y1 - y0) * e];
    }
  }
  const last = keys[keys.length - 1];
  return [last[1], last[2]];
};

/** The light trails the subject like a follow-spot: the mean of the last T frames. */
export const trail = (f: number, keys: Key[], T = 20): [number, number] => {
  let x = 0;
  let y = 0;
  const n = 8;
  for (let i = 0; i < n; i++) {
    const [a, c] = track(Math.max(0, f - (T * i) / (n - 1)), keys);
    x += a;
    y += c;
  }
  return [x / n, y / n];
};
