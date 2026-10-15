import { Easing, interpolate } from "remotion";
import { loadFont as loadDisplay } from "@remotion/google-fonts/InterTight";
import { mono, sans } from "../theme";
import timeline from "./timeline.json";

export { mono, sans };

/** Display face for all kinetic type: a tight, clean grotesque. */
export const display = loadDisplay("normal", { weights: ["500", "600", "700"], subsets: ["latin"] }).fontFamily;

export const FPS = 60;
export const BPM = timeline.bpm;
/** Seconds to frames. */
export const s = (sec: number) => Math.round(sec * FPS);
/** Beats (quarter notes at 120 BPM) to frames. */
export const b = (beats: number) => Math.round((beats * 60 * FPS) / BPM);

// Brand palette, from the PigeonBox site (pigeonboxsite/home.css).
export const K = {
  paper: "#f3f0e8",
  sheet: "#faf8f3",
  ink: "#111214",
  inkText: "#ebe7de",
  copper: "#a8502c",
  copperDeep: "#8a3f21",
  copperBright: "#e07a52",
  copperWash: "#f1ded2",
  pigeon: "#7d8b9b",
  muted: "#565a61",
  void: "#0a0a0b",
};

// The extension's light appearance, its default (apps/extension/src/ui/system.css, --pb-*).
export const PB = {
  surface: "#fafbf9",
  raised: "#ffffff",
  inset: "#f0f3f2",
  selected: "#e8eeed",
  border: "#dce2df",
  borderStrong: "#b5c1bc",
  fg: "#253039",
  fg2: "#53626d",
  muted: "#64717b",
  accent: "#9a4b2e",
  accentSoft: "#f6ebe5",
  onAccent: "#ffffff",
  busy: "#c79a88",
  success: "#287247",
  successSoft: "#e8f2eb",
  tracking: "#496775",
  warning: "#886017",
  edge: "rgba(0,0,0,0.08)",
};

// Gmail, light theme.
export const GM = {
  bg: "#ffffff",
  shell: "#f8fafd",
  surface: "#eef2f8",
  header: "#f2f6fc",
  text: "#1f1f1f",
  sub: "#444746",
  muted: "#747775",
  line: "#eceff1",
  blue: "#0b57d0",
  blueInk: "#ffffff",
  blueDone: "#7aa1e6",
  navSel: "#d3e3fd",
  compose: "#c2e7ff",
  avatar: "#5b7b5a",
};

export const ease = {
  out: Easing.bezier(0.16, 1, 0.3, 1),
  expo: Easing.bezier(0.19, 1, 0.22, 1),
  inOut: Easing.bezier(0.65, 0, 0.35, 1),
  in: Easing.bezier(0.55, 0, 1, 0.45),
  soft: Easing.bezier(0.33, 0, 0.2, 1),
  linear: Easing.linear,
};

/** Clamped interpolate. */
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

/** Deterministic hash in [0, 1). */
export const rnd = (seed: number) => {
  const x = Math.sin(seed * 12.9898 + 78.233) * 43758.5453;
  return x - Math.floor(x);
};

export const clamp01 = (v: number) => Math.min(1, Math.max(0, v));
