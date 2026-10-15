import React from "react";
import { Img, staticFile } from "remotion";
import { clamp01, ease, mono, PB, sans } from "../tokens";

/** Pidgy from the shipped colour atlas (pidgy-world.webp, 4 × 13 cells of 96 px). */
export const PIDGY_ROWS = {
  idle: 0,
  thinking: 1,
  drafting: 2,
  searching: 3,
  attention: 4,
  coffee: 5,
  sleepy: 6,
  parcel: 7,
  plane: 8,
  wave: 9,
  star: 10,
  map: 11,
  lantern: 12,
} as const;
export type PidgyPose = keyof typeof PIDGY_ROWS;

export const Pidgy: React.FC<{
  pose?: PidgyPose;
  frame?: number;
  size: number;
  mirror?: boolean;
  style?: React.CSSProperties;
}> = ({ pose = "idle", frame = 0, size, mirror, style }) => {
  const row = PIDGY_ROWS[pose];
  const col = ((frame % 4) + 4) % 4;
  const k = size / 96;
  return (
    <div
      style={{
        width: size,
        height: size,
        overflow: "hidden",
        position: "relative",
        transform: mirror ? "scaleX(-1)" : undefined,
        ...style,
      }}
    >
      <Img
        src={staticFile("kinetic/pidgy-world.webp")}
        style={{
          position: "absolute",
          width: 384 * k,
          height: 1248 * k,
          left: -col * 96 * k,
          top: -row * 96 * k,
          imageRendering: "pixelated",
          maxWidth: "none",
        }}
      />
    </div>
  );
};

/** Characters typed so far at `cps`, starting at frame `start`. */
export const typed = (text: string, frame: number, start: number, cps = 13, fps = 60) => {
  const n = Math.floor(((frame - start) / fps) * cps);
  return text.slice(0, Math.max(0, Math.min(text.length, n)));
};

export const typingDone = (text: string, start: number, cps = 13, fps = 60) =>
  start + Math.ceil((text.length / cps) * fps);

export const Caret: React.FC<{ frame: number; color?: string; h?: number; idle?: boolean }> = ({
  frame,
  color = PB.accent,
  h = 18,
  idle,
}) => (
  <span
    style={{
      display: "inline-block",
      width: 2,
      height: h,
      marginLeft: 1,
      verticalAlign: "-3px",
      background: color,
      opacity: idle ? (Math.floor(frame / 19) % 2 === 0 ? 1 : 0) : 1,
    }}
  />
);

/**
 * Halftone resolve: content appears through a growing dot screen, the brand's dot matrix,
 * then settles to solid. `p` runs 0 → 1.
 */
export const Dots: React.FC<{ p: number; children: React.ReactNode; cell?: number; style?: React.CSSProperties }> = ({
  p,
  children,
  cell = 3,
  style,
}) => {
  const q = ease.out(clamp01(p));
  if (q >= 0.999) return <div style={style}>{children}</div>;
  const r = q * cell * 0.75;
  const mask = `radial-gradient(circle at 50% 50%, #000 ${r}px, transparent ${r + 0.6}px)`;
  return (
    <div
      style={{
        ...style,
        opacity: q < 0.02 ? 0 : 1,
        WebkitMaskImage: mask,
        maskImage: mask,
        WebkitMaskSize: `${cell}px ${cell}px`,
        maskSize: `${cell}px ${cell}px`,
        filter: `brightness(${1 + 0.15 * (1 - q)})`,
        transform: `translateY(${(1 - q) * 4}px)`,
      }}
    >
      {children}
    </div>
  );
};

/** Fade and rise through a little blur. */
export const Appear: React.FC<{ p: number; children: React.ReactNode; y?: number; style?: React.CSSProperties }> = ({
  p,
  children,
  y = 12,
  style,
}) => {
  const q = ease.expo(clamp01(p));
  return (
    <div style={{ ...style, opacity: q, transform: `translateY(${(1 - q) * y}px)`, filter: q < 1 ? `blur(${(1 - q) * 6}px)` : undefined }}>
      {children}
    </div>
  );
};

export const Icon = {
  search: (c = PB.accent, s = 18) => (
    <svg width={s} height={s} viewBox="0 0 24 24" fill="none" stroke={c} strokeWidth={2.2} strokeLinecap="round">
      <circle cx="10.5" cy="10.5" r="6.5" />
      <path d="M15.5 15.5 20 20" />
    </svg>
  ),
  contrast: (c = PB.fg2, s = 16) => (
    <svg width={s} height={s} viewBox="0 0 24 24">
      <circle cx="12" cy="12" r="8.5" fill="none" stroke={c} strokeWidth={2} />
      <path d="M12 3.5a8.5 8.5 0 0 1 0 17z" fill={c} />
    </svg>
  ),
  dock: (c = PB.fg2, s = 18) => (
    <svg width={s} height={s} viewBox="0 0 24 24" fill="none" stroke={c} strokeWidth={1.8}>
      <rect x="3.5" y="5" width="17" height="14" rx="2.5" />
      <path d="M15 5v14" />
    </svg>
  ),
  check: (c = PB.accent, s = 14) => (
    <svg width={s} height={s} viewBox="0 0 24 24" fill="none" stroke={c} strokeWidth={2.6} strokeLinecap="round" strokeLinejoin="round">
      <path d="M5 12.5 10 17.5 19 7" />
    </svg>
  ),
  eye: (c = PB.fg2, s = 14) => (
    <svg width={s} height={s} viewBox="0 0 24 24" fill="none" stroke={c} strokeWidth={1.8}>
      <path d="M2.5 12S6 5.5 12 5.5 21.5 12 21.5 12 18 18.5 12 18.5 2.5 12 2.5 12z" />
      <circle cx="12" cy="12" r="3" />
    </svg>
  ),
  chevron: (c = PB.fg2, s = 14) => (
    <svg width={s} height={s} viewBox="0 0 24 24" fill="none" stroke={c} strokeWidth={2} strokeLinecap="round">
      <path d="m7 10 5 5 5-5" />
    </svg>
  ),
  waves: (c = PB.onAccent, s = 16) => (
    <svg width={s} height={s} viewBox="0 0 24 24" fill="none" stroke={c} strokeWidth={1.8} strokeLinecap="round">
      <path d="M4 8c2-1.5 4-1.5 6 0s4 1.5 6 0 4-1.5 4-1.5M4 12c2-1.5 4-1.5 6 0s4 1.5 6 0 4-1.5 4-1.5M4 16c2-1.5 4-1.5 6 0s4 1.5 6 0 4-1.5 4-1.5" />
    </svg>
  ),
};

/** The Gmail-style keyboard hint chip. */
export const Kbd: React.FC<{ children: React.ReactNode }> = ({ children }) => (
  <span
    style={{
      fontFamily: mono,
      fontSize: 12,
      color: PB.fg2,
      background: PB.inset,
      border: `1px solid ${PB.border}`,
      borderRadius: 6,
      padding: "2px 7px",
    }}
  >
    {children}
  </span>
);

export const uiFont: React.CSSProperties = {
  fontFamily: sans,
  color: PB.fg,
  WebkitFontSmoothing: "antialiased",
};
