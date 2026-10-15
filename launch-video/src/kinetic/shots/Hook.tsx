import React from "react";
import { AbsoluteFill, useCurrentFrame } from "remotion";
import { CameraRig } from "../Camera";
import { Rise } from "../type";
import { b, ci, display, ease, K, mono, PB, rnd, sans } from "../tokens";

const fmt = (n: number) => Math.floor(n).toLocaleString("en-US");

/** A plain counter in tabular figures: digits change in place, nothing jumps. */
const Count: React.FC<{ value: number; size: number; color: string }> = ({ value, size, color }) => (
  <div style={{ fontFamily: display, fontWeight: 600, fontSize: size, lineHeight: 1, color, letterSpacing: "-0.045em", fontVariantNumeric: "tabular-nums" }}>
    {fmt(Math.max(1, value))}
  </div>
);

export const COUNT_END = 2847;

/** Shot 1: an inbox counter rolls up out of nowhere. */
export const Counter: React.FC = () => {
  const f = useCurrentFrame();
  const v = 12 + (COUNT_END - 12) * ease.expo(ci(f, [0, 64], [0, 1], ease.linear));
  return (
    <AbsoluteFill style={{ background: K.ink, alignItems: "center", justifyContent: "center" }}>
      <div style={{ position: "absolute", left: 84, top: 72, fontFamily: mono, fontSize: 22, letterSpacing: "0.08em", color: K.inkText, opacity: 0.6 }}>
        Inbox ({fmt(v)}) - Gmail
      </div>
      <div style={{ display: "flex", alignItems: "baseline", gap: 42, transform: `scale(${1.02 + f * 0.0003})` }}>
        <Count value={v} size={300} color={K.inkText} />
        <Rise f={f} at={58} dur={14}>
          <span style={{ fontFamily: display, fontWeight: 600, fontSize: 236, letterSpacing: "-0.045em", lineHeight: 1, color: K.copperBright }}>unread</span>
        </Rise>
      </div>
    </AbsoluteFill>
  );
};

const SUBJECTS: { from: string; t: string; style: "bold" | "medium" | "mono"; bg: string; fg: string; size: number; x: number; y: number }[] = [
  { from: "Dana (via Q3 Planning)", t: "Re: Re: Fwd: Q3 planning (final)", style: "bold", bg: K.paper, fg: K.ink, size: 130, x: 0, y: -10 },
  { from: "Marcus Hale", t: "Just circling back", style: "bold", bg: K.copper, fg: K.paper, size: 220, x: 40, y: 10 },
  { from: "no-reply@billing", t: "Your receipt #44-1092", style: "mono", bg: K.ink, fg: K.inkText, size: 150, x: 0, y: 30 },
  { from: "Priya Raman", t: "Quick question", style: "bold", bg: K.paper, fg: K.copper, size: 240, x: -40, y: -10 },
  { from: "IT Security", t: "ACTION REQUIRED", style: "mono", bg: K.copper, fg: K.ink, size: 190, x: 0, y: -20 },
  { from: "Theo Laurent", t: "Following up on my last email", style: "medium", bg: K.ink, fg: K.inkText, size: 132, x: 20, y: 20 },
  { from: "Studio Weekly", t: "Issue #148: slow mornings", style: "medium", bg: K.paper, fg: K.ink, size: 160, x: 0, y: 20 },
  { from: "Maya Chen", t: "Can you take a look?", style: "bold", bg: K.copper, fg: K.paper, size: 210, x: 0, y: 0 },
];

/** Shot 2: subject lines strobe past on eighth notes. */
export const Strobe: React.FC = () => {
  const f = useCurrentFrame();
  const per = b(0.5);
  const i = Math.min(SUBJECTS.length - 1, Math.floor(f / per));
  const g = f - i * per;
  const sj = SUBJECTS[i];
  const fam = sj.style === "mono" ? mono : display;
  const sc = 1.07 - 0.07 * ease.expo(Math.min(1, g / 10));
  return (
    <AbsoluteFill style={{ background: sj.bg, alignItems: "center", justifyContent: "center", overflow: "hidden" }}>
      <div style={{ position: "absolute", left: 84, top: 72, fontFamily: mono, fontSize: 22, letterSpacing: "0.08em", color: sj.fg, opacity: 0.65 }}>
        Inbox ({fmt(COUNT_END + i + 1)})
      </div>
      <div style={{ transform: `translate(${sj.x}px, ${sj.y}px) scale(${sc})`, textAlign: "center", maxWidth: 1820 }}>
        <div style={{ fontFamily: mono, fontSize: 26, letterSpacing: "0.12em", color: sj.fg, opacity: 0.6, marginBottom: 26, textTransform: "uppercase" }}>
          ● {sj.from}
        </div>
        <div
          style={{
            fontFamily: fam,
            fontWeight: sj.style === "bold" ? 700 : sj.style === "mono" ? 500 : 500,
            fontSize: sj.size,
            lineHeight: 1.0,
            letterSpacing: sj.style === "mono" ? "-0.02em" : "-0.04em",
            color: sj.fg,
          }}
        >
          {sj.t}
        </div>
      </div>
    </AbsoluteFill>
  );
};

const NOISE = [
  ["Dana (via Q3 Planning)", "Re: Re: Fwd: Q3 planning (final) (2)"],
  ["LinkedIn", "You appeared in 14 searches this week"],
  ["Marcus Hale", "Just circling back"],
  ["Paper & Co.", "Your receipt #44-1092"],
  ["Google Calendar", "Updated invitation: Sync (moved)"],
  ["Priya Raman", "Quick question"],
  ["IT Security", "ACTION REQUIRED: password expires"],
  ["Studio Weekly", "Issue #148: slow mornings"],
  ["Theo Laurent", "Following up on my last email"],
  ["GitHub", "[pigeonbox] 3 new notifications"],
  ["Figma", "Maya commented on Direction v2"],
  ["Airline", "Check in for your flight to Lisbon"],
  ["Jordan Park", "Re: Friday review"],
  ["Notion", "Weekly digest: 23 updates"],
  ["Bank", "Your statement is ready"],
  ["Maya Chen", "Can you take a look?"],
  ["Zoom", "Cloud recording available"],
  ["Sam Ortega", "Contract, v3"],
  ["Slack", "You have 9 unread messages"],
  ["Oliver at Fieldwork", "The samples are on their way"],
];

const WALL_W = 1100;
const ROW_H = 58;
const WALL_ROWS = 90;

const WallList: React.FC = () => (
  <div style={{ width: WALL_W, height: ROW_H * WALL_ROWS, background: PB.surface, fontFamily: sans, color: PB.fg }}>
    {Array.from({ length: WALL_ROWS }, (_, i) => {
      const [from, subj] = NOISE[(i * 7 + 3) % NOISE.length];
      const unread = rnd(i + 3) > 0.25;
      return (
        <div
          key={i}
          style={{
            height: ROW_H,
            display: "flex",
            alignItems: "center",
            gap: 22,
            padding: "0 26px",
            borderBottom: `1px solid ${PB.border}`,
            background: unread ? PB.raised : PB.surface,
          }}
        >
          <span style={{ width: 16, height: 16, borderRadius: 4, border: `1.5px solid ${PB.borderStrong}` }} />
          <span style={{ width: 230, fontSize: 19, fontWeight: unread ? 700 : 400, whiteSpace: "nowrap", overflow: "hidden" }}>{from}</span>
          <span style={{ flex: 1, fontSize: 19, fontWeight: unread ? 700 : 400, whiteSpace: "nowrap", overflow: "hidden" }}>
            {subj} <span style={{ fontWeight: 400, color: PB.muted }}>— {["Hi! Just wanted to", "Please review the", "Sharing a quick", "Reminder that the"][i % 4]} …</span>
          </span>
          <span style={{ fontSize: 16, color: PB.muted, fontWeight: unread ? 700 : 400 }}>{`${9 - (i % 9)}:${String((i * 13) % 60).padStart(2, "0")} AM`}</span>
        </div>
      );
    })}
  </div>
);

/** Shot 3: the inbox becomes an endless wall, scrolling faster and faster. */
export const Wall: React.FC = () => {
  const f = useCurrentFrame();
  const dur = b(3);
  const t = f / dur;
  // Accelerating scroll.
  const scroll = 300 + Math.pow(t, 2.2) * 3600;
  const v = COUNT_END + 9 + Math.floor(Math.pow(t, 2) * 260);
  const fy = 400 + scroll;
  return (
    <AbsoluteFill style={{ background: "#000" }}>
      <CameraRig
        cam={{
          w: WALL_W,
          h: ROW_H * WALL_ROWS,
          fx: 520,
          fy,
          tx: 40,
          ty: 0,
          pitch: 46,
          yaw: 10,
          roll: -16 - t * 4,
          mag: 1.75 + t * 0.35,
          band: 50,
          rate: 0.05,
          light: { x: 560, y: fy, rx: 900, ry: 520, dim: 0.85, kx: 80, ky: -60 },
        }}
      >
        <WallList />
      </CameraRig>
      <div
        style={{
          position: "absolute",
          right: 84,
          top: 64,
          fontFamily: display,
          fontWeight: 600,
          fontVariantNumeric: "tabular-nums",
          fontSize: 120,
          color: K.inkText,
          letterSpacing: "-0.03em",
          textShadow: "0 0 40px rgba(0,0,0,0.8)",
        }}
      >
        {fmt(v)}
      </div>
      <div style={{ position: "absolute", left: 84, top: 72, fontFamily: mono, fontSize: 22, letterSpacing: "0.08em", color: K.inkText, opacity: 0.6 }}>
        Inbox ({fmt(v)})
      </div>
    </AbsoluteFill>
  );
};

/** Shot 4: the music cuts out. One question. */
export const Question: React.FC = () => {
  const f = useCurrentFrame();
  // A scanning selection becomes a deliberate frame around the person, rather than the mail.
  const lock = ci(f, [b(1.75), b(2.7)], [0, 1], ease.expo);
  const left = 112 + 950 * lock;
  const top = 258 + 107 * lock;
  const width = 1696 - 950 * lock;
  const height = 568 - 128 * lock;
  return (
    <AbsoluteFill style={{ background: K.paper, color: K.ink }}>
      <div style={{ position: "absolute", left: 124, top: 100, fontFamily: mono, fontSize: 22, letterSpacing: "0.12em", color: K.muted }}>2,847 UNREAD. ONE QUESTION.</div>
      <div style={{ position: "absolute", left: 124, top: 290, fontFamily: display, fontWeight: 600, fontSize: 152, letterSpacing: "-0.04em", lineHeight: 1.03 }}>
        <div><Rise f={f} at={0}>Which</Rise>{" "}<Rise f={f} at={b(0.5)}>ones</Rise></div>
        <div style={{ color: K.copper }}><Rise f={f} at={b(1)}>actually</Rise></div>
        <div><Rise f={f} at={b(2)}>need</Rise></div>
      </div>
      <div style={{ position: "absolute", left: 1120, top: 386, fontFamily: display, fontWeight: 700, fontSize: 296, letterSpacing: "-0.045em", lineHeight: 1, color: K.copper }}>
        <Rise f={f} at={b(2.5)}>you?</Rise>
      </div>
      <svg width={1920} height={1080} style={{ position: "absolute", inset: 0 }}>
        {[[left, top, 1, 1], [left + width, top, -1, 1], [left, top + height, 1, -1], [left + width, top + height, -1, -1]].map(([x, y, dx, dy], i) => (
          <path key={i} d={`M ${x} ${y + 34 * dy} V ${y} H ${x + 34 * dx}`} stroke={K.copper} strokeWidth={3} fill="none" />
        ))}
      </svg>
      <div style={{ position: "absolute", left: 1120, top: 868, display: "flex", gap: 18, opacity: lock }}>
        {[0, 1, 2].map((i) => <span key={i} style={{ width: 12, height: 12, borderRadius: "50%", background: K.copper }} />)}
      </div>
    </AbsoluteFill>
  );
};
