import { loadFont as loadSans } from "@remotion/google-fonts/InstrumentSans";
import { loadFont as loadSerif } from "@remotion/google-fonts/InstrumentSerif";
import { loadFont as loadPixel } from "@remotion/google-fonts/Silkscreen";
import { loadFont as loadMono } from "@remotion/google-fonts/IBMPlexMono";

export const sans = loadSans("normal", {
  weights: ["400", "500", "600", "700"],
  subsets: ["latin"],
}).fontFamily;
export const serif = loadSerif("italic", { weights: ["400"], subsets: ["latin"] }).fontFamily;
export const serifUpright = loadSerif("normal", { weights: ["400"], subsets: ["latin"] }).fontFamily;
export const pixelFont = loadPixel("normal", { weights: ["400"], subsets: ["latin"] }).fontFamily;
export const mono = loadMono("normal", { weights: ["400", "500"], subsets: ["latin"] }).fontFamily;

// Copper Perch palette (docs/design/copper-perch.md)
export const C = {
  soot: "#151512",
  glass: "#292923",
  card: "#282822",
  ivory: "#f4f0e8",
  muted: "#aba99e",
  copper: "#dda77a",
  copperLight: "#edbb93",
  copperInk: "#935023",
  copperDeep: "#78421e",
  ink: "#2a2622",
};
