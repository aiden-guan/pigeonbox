import React from "react";
import { AbsoluteFill } from "remotion";
import { ci, display, ease, K, mono } from "./tokens";

export type Word = {
  t: string;
  /** Frame (local to the card) the word lands. */
  at: number;
  /** Accent word: set in copper. */
  italic?: boolean;
  color?: string;
  /** Start a new line before this word. */
  br?: boolean;
};

/** One word rising out of its own baseline mask. */
export const Rise: React.FC<{ f: number; at: number; children: React.ReactNode; dur?: number; style?: React.CSSProperties }> = ({
  f,
  at,
  children,
  dur = 13,
  style,
}) => {
  const p = ci(f, [at, at + dur], [0, 1], ease.expo);
  return (
    <span style={{ display: "inline-block", overflow: "hidden", verticalAlign: "top", paddingBottom: "0.12em", marginBottom: "-0.12em", ...style }}>
      <span
        style={{
          display: "inline-block",
          transform: `translateY(${(1 - p) * 105}%) rotate(${(1 - p) * 4}deg)`,
          transformOrigin: "0 100%",
          opacity: f < at ? 0 : 1,
        }}
      >
        {children}
      </span>
    </span>
  );
};

/** Full-bleed type card: big words landing on the beat, with a slow push. */
export const Slam: React.FC<{
  f: number;
  words: Word[];
  bg?: string;
  color?: string;
  size?: number;
  label?: { t: string; at: number };
  push?: number;
  align?: "center" | "left";
  lineHeight?: number;
  children?: React.ReactNode;
}> = ({ f, words, bg = K.paper, color = K.ink, size = 170, label, push = 0.035, align = "center", lineHeight = 1.0, children }) => {
  const lines: Word[][] = [];
  words.forEach((w) => {
    if (w.br || lines.length === 0) lines.push([]);
    lines[lines.length - 1].push(w);
  });
  const scale = 1 + push * Math.min(1, f / 150);
  return (
    <AbsoluteFill style={{ background: bg, alignItems: align === "center" ? "center" : "flex-start", justifyContent: "center" }}>
      <div
        style={{
          transform: `scale(${scale})`,
          textAlign: align,
          padding: align === "left" ? "0 150px" : 0,
          fontFamily: display,
          fontWeight: 600,
          fontSize: size,
          lineHeight,
          letterSpacing: "-0.035em",
          color,
          fontKerning: "normal",
        }}
      >
        {lines.map((line, li) => (
          <div key={li} style={{ whiteSpace: "nowrap" }}>
            {line.map((w, wi) => (
              <React.Fragment key={wi}>
                {wi > 0 ? " " : null}
                <Rise f={f} at={w.at}>
                  <span style={{ color: w.color ?? color }}>
                    {w.t}
                  </span>
                </Rise>
              </React.Fragment>
            ))}
          </div>
        ))}
        {label ? (
          <div style={{ marginTop: size * 0.32, fontFamily: mono, fontSize: 24, letterSpacing: "0.22em", textTransform: "uppercase", color, opacity: ci(f, [label.at, label.at + 10], [0, 0.75]) }}>
            {label.t}
          </div>
        ) : null}
      </div>
      {children}
    </AbsoluteFill>
  );
};

/** Small monospaced kicker, like the site's section labels: "01  TRIAGE". */
export const Kicker: React.FC<{ n: string; t: string; color?: string; f: number; at?: number; style?: React.CSSProperties }> = ({
  n,
  t,
  color = K.paper,
  f,
  at = 0,
  style,
}) => (
  <div
    style={{
      position: "absolute",
      left: 84,
      top: 72,
      fontFamily: mono,
      fontSize: 22,
      letterSpacing: "0.2em",
      color,
      opacity: ci(f, [at, at + 8], [0, 1]),
      display: "flex",
      gap: 22,
      ...style,
    }}
  >
    <span style={{ color: K.copperBright }}>{n}</span>
    <span style={{ opacity: 0.8 }}>{t}</span>
  </div>
);
