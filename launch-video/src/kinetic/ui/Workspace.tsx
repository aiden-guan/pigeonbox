import React from "react";
import { Icon, Kbd, Pidgy, PidgyPose, uiFont } from "./bits";
import { mono, PB } from "../tokens";

export type Row = { sender: string; subject: string; snippet: string; when: string; hot?: boolean; tag?: string };

export const RESPOND: Row[] = [
  { sender: "Maya Chen", subject: "A few thoughts on the new direction", snippet: "Love where this is going. Two small things before Friday…", when: "9:42 AM", hot: true },
  { sender: "Oliver at Fieldwork", subject: "The samples are on their way", snippet: "Could you confirm the delivery address? The courier needs…", when: "8:54 AM" },
  { sender: "Nina & Alex", subject: "Coffee next week?", snippet: "We’ll be in your neighborhood on Tuesday. Free at 10?", when: "8:12 AM" },
];
export const WAITING: Row[] = [
  { sender: "Jordan Park", subject: "Re: Friday review", snippet: "You: I’ll bring the printed boards. Let me know if…", when: "Tue" },
  { sender: "Sam Ortega", subject: "Contract, v3", snippet: "You: Signed copy attached. Could you countersign by…", when: "Mon" },
  { sender: "Priya Raman", subject: "Intro: Priya and Lena", snippet: "You: Thanks Priya! Lena, great to meet you…", when: "Oct 9" },
  { sender: "Fieldwork Billing", subject: "Invoice #2041", snippet: "You: Paid this morning, receipt attached.", when: "Oct 8" },
  { sender: "Theo Laurent", subject: "Studio walkthrough", snippet: "You: Does Thursday at 4 still work for you?", when: "Oct 7" },
];
export const FYI: Row[] = [
  { sender: "Studio Weekly", subject: "Five small rituals for slower mornings", snippet: "This week: notebooks, window light and the 10-minute walk.", when: "7:05 AM" },
  { sender: "City Library", subject: "Your hold is ready", snippet: "“The Art of Noticing” is waiting at the front desk.", when: "6:40 AM" },
  { sender: "Lena Okafor", subject: "Photos from the weekend", snippet: "A few favourites from the hike. No reply needed!", when: "Yesterday" },
  { sender: "Paper & Co.", subject: "20% off notebooks this week", snippet: "Our autumn line is here, in four new colours.", when: "Yesterday" },
];
export const NOTIFS: Row[] = [
  { sender: "Google Calendar", subject: "Reminder: Design review @ Fri 10:00", snippet: "Maya Chen, Jordan Park, you", when: "6:00 AM" },
  { sender: "GitHub", subject: "[pigeonbox] CI passed on main", snippet: "All checks have passed · 4 successful", when: "5:51 AM" },
  { sender: "Figma", subject: "Maya commented on Direction v2", snippet: "“Can we try the warmer copper here?”", when: "Yesterday" },
  { sender: "Bank", subject: "Your statement is ready", snippet: "October statement for account ending 4417", when: "Yesterday" },
];

export const CATS = [
  { key: "Respond", rows: RESPOND, count: 3 },
  { key: "Waiting", rows: WAITING, count: 5 },
  { key: "FYI", rows: FYI, count: 12 },
  { key: "Notifications", rows: NOTIFS, count: 41 },
];

export const WS_W = 440;
export const WS_H = 860;

export const InboxRow: React.FC<{ row: Row; first?: boolean; lit?: number }> = ({ row, first, lit = 0 }) => (
  <div
    style={{
      padding: "16px 22px 16px 34px",
      borderTop: first ? "none" : `1px solid ${PB.border}`,
      position: "relative",
      background: lit ? `rgba(228,138,101,${0.08 * lit})` : undefined,
    }}
  >
    <span
      style={{
        position: "absolute",
        left: 16,
        top: 24,
        width: 6,
        height: 6,
        borderRadius: 3,
        background: row.hot ? PB.accent : PB.muted,
      }}
    />
    <div style={{ display: "flex", justifyContent: "space-between", alignItems: "baseline" }}>
      <span style={{ fontSize: 16, fontWeight: 600, color: PB.fg }}>{row.sender}</span>
      <span style={{ fontSize: 13, color: PB.muted }}>{row.when}</span>
    </div>
    <div style={{ fontSize: 15.5, color: PB.fg, marginTop: 6 }}>{row.subject}</div>
    <div style={{ fontSize: 14, color: PB.muted, marginTop: 5, whiteSpace: "nowrap", overflow: "hidden", textOverflow: "ellipsis" }}>
      {row.snippet}
    </div>
  </div>
);

/** The PigeonBox workspace panel beside Gmail, in its dark appearance. */
export const Workspace: React.FC<{
  tab?: "Home" | "Inbox" | "Ask";
  /** Fractional index into CATS while the category switches. */
  cat?: number;
  /** 0..1 progress of the tab underline between tabs. */
  underline?: { from: number; to: number; p: number };
  pose?: PidgyPose;
  pidgyFrame?: number;
  body?: React.ReactNode;
  rowsOffset?: number;
  lit?: number;
}> = ({ tab = "Inbox", cat = 0, underline, pose = "idle", pidgyFrame = 0, body, rowsOffset = 0, lit = 0 }) => {
  const tabs = ["Home", "Inbox", "Ask"] as const;
  const tabX = [0, 64, 130];
  const tabW = [48, 46, 34];
  const ti = tabs.indexOf(tab);
  const u = underline
    ? {
        x: tabX[underline.from] + (tabX[underline.to] - tabX[underline.from]) * underline.p,
        w: tabW[underline.from] + (tabW[underline.to] - tabW[underline.from]) * underline.p,
      }
    : { x: tabX[ti], w: tabW[ti] };
  const ci = Math.round(cat);
  const c = CATS[Math.max(0, Math.min(CATS.length - 1, ci))];

  return (
    <div
      style={{
        ...uiFont,
        width: WS_W,
        height: WS_H,
        background: PB.surface,
        borderRadius: 16,
        boxShadow: `inset 0 0 0 1px ${PB.border}, inset 0 1px 0 rgba(255,255,255,0.06)`,
        overflow: "hidden",
        position: "relative",
      }}
    >
      <div style={{ display: "flex", alignItems: "center", padding: "20px 22px 0 18px", gap: 10 }}>
        <Pidgy pose={pose} frame={pidgyFrame} size={40} />
        <span style={{ fontSize: 19, fontWeight: 600, letterSpacing: -0.2 }}>PigeonBox</span>
        <span style={{ flex: 1 }} />
        <span style={{ fontSize: 14, color: PB.fg2, marginRight: 14 }}>Local</span>
        {Icon.contrast()}
      </div>
      <div
        style={{
          margin: "16px 20px 0",
          height: 46,
          borderRadius: 10,
          background: PB.inset,
          boxShadow: `inset 0 0 0 1px ${PB.border}`,
          display: "flex",
          alignItems: "center",
          padding: "0 12px 0 14px",
          gap: 10,
        }}
      >
        {Icon.search()}
        <span style={{ fontSize: 15.5, color: PB.muted, flex: 1 }}>Ask Pigeon or run a command</span>
        <Kbd>⌘ K</Kbd>
      </div>
      <div style={{ position: "relative", margin: "18px 20px 0", height: 38, borderBottom: `1px solid ${PB.border}` }}>
        {tabs.map((t, i) => (
          <span
            key={t}
            style={{ position: "absolute", left: tabX[i], top: 4, fontSize: 15.5, color: i === ti ? PB.fg : PB.fg2, fontWeight: i === ti ? 500 : 400 }}
          >
            {t}
          </span>
        ))}
        <span style={{ position: "absolute", left: u.x - 4, width: u.w + 8, bottom: -1, height: 2, background: PB.accent, borderRadius: 1 }} />
        <span style={{ position: "absolute", right: 0, top: 4 }}>{Icon.dock()}</span>
      </div>
      {body ?? (
        <>
          <div style={{ display: "flex", alignItems: "center", gap: 12, padding: "16px 20px 10px" }}>
            <span style={{ fontSize: 14, color: PB.fg2 }}>Inbox</span>
            <div
              style={{
                flex: 1,
                height: 38,
                borderRadius: 8,
                background: PB.raised,
                boxShadow: `inset 0 0 0 1px ${PB.borderStrong}`,
                display: "flex",
                alignItems: "center",
                justifyContent: "space-between",
                padding: "0 12px",
                overflow: "hidden",
                position: "relative",
              }}
            >
              <CatLabel cat={cat} />
              {Icon.chevron()}
            </div>
            <span style={{ fontFamily: mono, fontSize: 14, color: PB.fg2, width: 24, textAlign: "right" }}>
              <CatCount cat={cat} />
            </span>
          </div>
          <div style={{ transform: `translateY(${rowsOffset}px)` }}>
            {c.rows.map((r, i) => (
              <InboxRow key={c.key + i} row={r} first={i === 0} lit={i === 0 ? lit : 0} />
            ))}
          </div>
        </>
      )}
    </div>
  );
};

/** Category label that rolls vertically as `cat` moves between integers. */
const CatLabel: React.FC<{ cat: number }> = ({ cat }) => (
  <div style={{ position: "relative", height: 22, flex: 1, overflow: "hidden" }}>
    {CATS.map((c, i) => (
      <span
        key={c.key}
        style={{ position: "absolute", left: 0, top: (i - cat) * 26, fontSize: 15.5, color: PB.fg, fontWeight: 500, opacity: 1 - Math.min(1, Math.abs(i - cat)) }}
      >
        {c.key}
      </span>
    ))}
  </div>
);

const CatCount: React.FC<{ cat: number }> = ({ cat }) => {
  const i = Math.floor(cat);
  const f = cat - i;
  const a = CATS[Math.max(0, Math.min(3, i))].count;
  const bb = CATS[Math.max(0, Math.min(3, i + 1))].count;
  return <>{Math.round(a + (bb - a) * f)}</>;
};
