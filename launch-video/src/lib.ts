import { Easing, interpolate, useCurrentFrame } from "remotion";
import timeline from "./timeline.json";
import manifest from "./art-manifest.json";

export const T = timeline;
export type ShotName = keyof typeof timeline.shots;
// eslint-disable-next-line @typescript-eslint/no-explicit-any
export const M = manifest as Record<string, any>;

export const shotStart = (s: ShotName) => T.shots[s][0];
export const shotLen = (s: ShotName) => T.shots[s][1] - T.shots[s][0];
/** An absolute timeline event expressed in a shot's local frames. */
export const at = (s: ShotName, ev: keyof typeof timeline.events) => T.events[ev] - T.shots[s][0];

/** Current frame on the film's absolute timeline, whether the scene plays alone or in the film. */
export const useAbsFrame = (s: ShotName) => useCurrentFrame() + shotStart(s);

export const ease = {
  out: Easing.bezier(0.16, 1, 0.3, 1),
  inOut: Easing.bezier(0.65, 0, 0.35, 1),
  in: Easing.bezier(0.55, 0, 1, 0.45),
  soft: Easing.bezier(0.33, 0, 0.2, 1),
  linear: Easing.linear,
};

/** Clamped interpolate shorthand for choreography maths. */
export const ci = (
  f: number,
  input: number[],
  output: number[],
  easing: (t: number) => number = ease.inOut,
) =>
  interpolate(f, input, output, {
    extrapolateLeft: "clamp",
    extrapolateRight: "clamp",
    easing,
  });

/** Deterministic pseudo-random in [0, 1). */
export const rand = (seed: number) => {
  const x = Math.sin(seed * 12.9898 + 78.233) * 43758.5453;
  return x - Math.floor(x);
};

/** Quadratic bezier point. */
export const qbez = (p0: number[], p1: number[], p2: number[], t: number) => [
  (1 - t) * (1 - t) * p0[0] + 2 * (1 - t) * t * p1[0] + t * t * p2[0],
  (1 - t) * (1 - t) * p0[1] + 2 * (1 - t) * t * p1[1] + t * t * p2[1],
];
