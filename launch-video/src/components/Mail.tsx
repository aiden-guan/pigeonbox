import React from "react";
import { sans } from "../theme";

/**
 * A light webmail surface, drawn at ~2x so it reads on a 1080p frame.
 * PigeonBox elements (tracking pill, sent-row mark, open-status card) mirror
 * apps/extension/src/content/surface.ts and packages/tracking describeTrackingStatus.
 */

export const UI = {
  bg: "#f6f8fc",
  panel: "#ffffff",
  text: "#1f1f1f",
  sub: "#5f6368",
  line: "#eceff3",
  blue: "#0b57d0",
  active: "#d3e3fd",
};

const Icon: React.FC<{ d: string; size?: number; color?: string; stroke?: boolean }> = ({ d, size = 30, color = UI.sub, stroke }) => (
  <svg width={size} height={size} viewBox="0 0 24 24" fill={stroke ? "none" : color} stroke={stroke ? color : "none"} strokeWidth={stroke ? 1.8 : 0} strokeLinecap="round" strokeLinejoin="round">
    <path d={d} />
  </svg>
);

const ICONS = {
  inbox: "M4 4h16v12h-5a3 3 0 0 1-6 0H4z M4 16v4h16v-4",
  star: "M12 3l2.7 5.6 6.1.9-4.4 4.3 1 6.1L12 17l-5.4 2.9 1-6.1L3.2 9.5l6.1-.9z",
  clock: "M12 3a9 9 0 1 0 0 18 9 9 0 0 0 0-18z M12 7v5l3 2",
  send: "M3 11l18-8-8 18-2-7z",
  file: "M6 3h8l4 4v14H6z M14 3v4h4",
  pencil: "M4 20l4-1 11-11-3-3L5 16z",
  search: "M10.5 4a6.5 6.5 0 1 0 0 13 6.5 6.5 0 0 0 0-13z M15.5 15.5L20 20",
  menu: "M4 7h16 M4 12h16 M4 17h16",
};

export const Sidebar: React.FC<{ active: "Inbox" | "Sent"; inboxCount?: number }> = ({ active, inboxCount = 4 }) => (
  <div style={{ position: "absolute", left: 0, top: 0, width: 380, bottom: 0, fontFamily: sans }}>
    <div style={{ position: "absolute", left: 36, top: 36, display: "flex", alignItems: "center", gap: 28 }}>
      <Icon d={ICONS.menu} stroke size={34} />
      <div style={{ fontSize: 34, color: "#444746", letterSpacing: "-0.01em" }}>Mail</div>
    </div>
    <div
      style={{
        position: "absolute",
        left: 24,
        top: 120,
        height: 104,
        padding: "0 44px 0 36px",
        borderRadius: 32,
        background: "#c2e7ff",
        display: "flex",
        alignItems: "center",
        gap: 24,
        fontSize: 28,
        fontWeight: 600,
        color: "#001d35",
      }}
    >
      <Icon d={ICONS.pencil} stroke color="#001d35" /> Compose
    </div>
    {[
      ["Inbox", ICONS.inbox, inboxCount],
      ["Starred", ICONS.star, null],
      ["Snoozed", ICONS.clock, null],
      ["Sent", ICONS.send, null],
      ["Drafts", ICONS.file, 2],
    ].map(([label, icon, count], i) => {
      const on = label === active;
      return (
        <div
          key={label as string}
          style={{
            position: "absolute",
            left: 0,
            top: 262 + i * 64,
            width: 356,
            height: 60,
            borderRadius: "0 30px 30px 0",
            background: on ? UI.active : "transparent",
            display: "flex",
            alignItems: "center",
            gap: 30,
            paddingLeft: 44,
            fontSize: 26,
            fontWeight: on ? 700 : 400,
            color: on ? "#001d35" : "#444746",
          }}
        >
          <Icon d={icon as string} stroke size={28} color={on ? "#001d35" : "#444746"} />
          <span style={{ flex: 1 }}>{label as string}</span>
          {count ? <span style={{ marginRight: 30, fontSize: 22, fontWeight: 700 }}>{count as number}</span> : null}
        </div>
      );
    })}
  </div>
);

export const SearchBar: React.FC = () => (
  <div
    style={{
      position: "absolute",
      left: 400,
      top: 24,
      width: 1000,
      height: 88,
      borderRadius: 44,
      background: "#e9eef6",
      display: "flex",
      alignItems: "center",
      gap: 26,
      paddingLeft: 32,
      fontFamily: sans,
      fontSize: 28,
      color: "#444746",
    }}
  >
    <Icon d={ICONS.search} stroke size={32} color="#444746" /> Search mail
  </div>
);

export type RowData = {
  from: string;
  subject: string;
  snippet: string;
  time: string;
  unread?: boolean;
  slot?: React.ReactNode;
  afterSubject?: React.ReactNode;
};

export const Row: React.FC<RowData & { highlight?: number; style?: React.CSSProperties }> = ({
  from,
  subject,
  snippet,
  time,
  unread,
  slot,
  afterSubject,
  highlight = 0,
  style,
}) => (
  <div
    style={{
      position: "relative",
      height: 80,
      display: "flex",
      alignItems: "center",
      padding: "0 36px 0 28px",
      borderBottom: `1px solid ${UI.line}`,
      background: unread ? "#ffffff" : "#f2f6fc",
      boxShadow: highlight ? `inset 0 0 0 999px rgba(11,87,208,${0.08 * highlight})` : undefined,
      fontFamily: sans,
      fontSize: 25,
      color: UI.text,
      ...style,
    }}
  >
    <div style={{ width: 26, height: 26, border: "2.5px solid #9aa0a6", borderRadius: 4, marginRight: 26 }} />
    <div style={{ marginRight: 26 }}>
      <Icon d={ICONS.star} stroke size={28} color="#9aa0a6" />
    </div>
    <div style={{ width: 300, fontWeight: unread ? 700 : 400, whiteSpace: "nowrap", overflow: "hidden" }}>{from}</div>
    <div style={{ flex: 1, whiteSpace: "nowrap", overflow: "hidden", textOverflow: "ellipsis", marginRight: 24 }}>
      <span style={{ fontWeight: unread ? 700 : 400 }}>{subject}</span>
      {afterSubject}
      <span style={{ color: UI.sub }}> — {snippet}</span>
    </div>
    {slot}
    <div style={{ width: 120, textAlign: "right", fontSize: 22, fontWeight: unread ? 700 : 500, color: unread ? UI.text : UI.sub }}>
      {time}
    </div>
  </div>
);

/** PigeonBox's sent-row mark: check + label ("Sent" → "Opened"), copper once opened. */
export const TrackMark: React.FC<{ opened: boolean; pulse?: number }> = ({ opened, pulse = 0 }) => {
  const color = opened ? "#935023" : "#80868b";
  return (
    <div
      style={{
        display: "inline-flex",
        alignItems: "center",
        gap: 8,
        marginRight: 30,
        color,
        fontFamily: sans,
        fontWeight: 600,
        fontSize: 24,
        position: "relative",
      }}
    >
      {pulse > 0 ? (
        <div
          style={{
            position: "absolute",
            left: -14,
            top: -12,
            right: -14,
            bottom: -12,
            borderRadius: 30,
            background: `rgba(221,167,122,${0.35 * (1 - pulse)})`,
            scale: `${1 + pulse * 0.6}`,
          }}
        />
      ) : null}
      <svg viewBox="0 0 16 16" width={32} height={32} fill="none">
        <path d="M3.1 8.3 6.3 11.5 12.9 4.4" stroke="currentColor" strokeWidth={2} strokeLinecap="round" strokeLinejoin="round" />
      </svg>
      <span>{opened ? "Opened" : "Sent"}</span>
    </div>
  );
};

/** PigeonBox open-status card (surface.ts .gi-track-card), at 2x. Copy from describeTrackingStatus. */
export const TrackCard: React.FC<{ style?: React.CSSProperties; notify?: number; arrow?: boolean; opened?: boolean }> = ({
  style,
  notify = 1,
  arrow = true,
  opened = true,
}) => (
  <div
    style={{
      position: "absolute",
      width: 680,
      padding: "32px 32px 24px",
      borderRadius: 36,
      background: "#282822",
      color: "#f4f0e8",
      border: "2px solid rgba(255,255,255,0.1)",
      boxShadow: "inset 0 2px 0 rgba(255,255,255,0.14), 0 48px 100px rgba(14,13,10,0.45)",
      fontFamily: "ui-sans-serif, system-ui, -apple-system, sans-serif",
      fontSize: 28,
      lineHeight: 1.4,
      ...style,
    }}
  >
    <p style={{ margin: 0 }}>
      {opened ? (
        <>
          <strong style={{ fontWeight: 600 }}>Maya Chen</strong> opened your email less than a minute ago.
        </>
      ) : (
        "Not opened yet."
      )}
    </p>
    <p style={{ display: "flex", gap: 16, alignItems: "flex-start", margin: "20px 0 0", color: "#aba99e", fontSize: 26 }}>
      <svg viewBox="0 0 20 20" width={32} height={32} fill="none" style={{ flex: "0 0 auto", marginTop: 2 }}>
        <path d="M1.8 10S4.8 4.8 10 4.8 18.2 10 18.2 10 15.2 15.2 10 15.2 1.8 10 1.8 10Z" stroke="currentColor" strokeWidth={1.4} />
        <circle cx="10" cy="10" r="2.2" stroke="currentColor" strokeWidth={1.4} />
      </svg>
      <span>{opened ? "First opened 4 minutes after you sent." : "Tracking is on for this email."}</span>
    </p>
    <div
      style={{
        marginTop: 28,
        borderRadius: 24,
        background: opened ? "rgba(221,167,122,0.18)" : "rgba(255,255,255,0.06)",
        color: opened ? "#f5d9bf" : "#d2cfc5",
        boxShadow: opened ? "inset 0 0 0 2px rgba(221,167,122,0.35)" : undefined,
        textAlign: "center",
        fontWeight: 600,
        padding: "20px 24px",
      }}
    >
      {opened ? "Opened once" : "Not opened yet"}
    </div>
    <div
      style={{
        display: "flex",
        alignItems: "center",
        gap: 20,
        marginTop: 24,
        paddingTop: 24,
        borderTop: "2px solid rgba(255,255,255,0.08)",
      }}
    >
      <div
        style={{
          position: "relative",
          width: 72,
          height: 44,
          borderRadius: 999,
          background: `rgba(${Math.round(255 + (221 - 255) * notify)},${Math.round(255 + (167 - 255) * notify)},${Math.round(255 + (122 - 255) * notify)},${0.14 + 0.86 * notify})`,
        }}
      >
        <div style={{ position: "absolute", top: 4, left: 4 + 28 * notify, width: 36, height: 36, borderRadius: "50%", background: "#fff" }} />
      </div>
      <span style={{ color: "#eae5db", fontSize: 26 }}>Notify me if there is no reply</span>
    </div>
    {arrow ? (
      <div
        style={{
          position: "absolute",
          bottom: -12,
          left: "50%",
          width: 24,
          height: 24,
          background: "#282822",
          transform: "translateX(-50%) rotate(45deg)",
        }}
      />
    ) : null}
  </div>
);

/** PigeonBox category chip on a mail row (chips.ts / surface.ts .gi-cat-chip), at 2x. */
export const CHIP_COLORS: Record<string, string> = {
  Respond: "#935023",
  Waiting: "#8d6b1f",
  FYI: "#5f6b7a",
  Notifications: "#3d6fbf",
  Promotions: "#a14d6c",
  News: "#2f7a56",
};
export const Chip: React.FC<{ label: string; t: number }> = ({ label, t }) => (
  <span
    style={{
      display: "inline-block",
      marginLeft: 16,
      fontFamily: "ui-sans-serif, system-ui, -apple-system, sans-serif",
      fontWeight: 600,
      fontSize: 22,
      letterSpacing: "-0.01em",
      color: CHIP_COLORS[label],
      opacity: t,
      translate: `${(1 - t) * -10}px 0px`,
      scale: `${0.9 + 0.1 * t}`,
    }}
  >
    {label}
  </span>
);

/** macOS-style pointer. (x, y) is the tip. */
export const Cursor: React.FC<{ x: number; y: number; press?: number; hand?: boolean }> = ({ x, y, press = 0, hand }) => (
  <div style={{ position: "absolute", left: x, top: y, scale: `${1 - press * 0.12}`, transformOrigin: "0 0", filter: "drop-shadow(0 6px 10px rgba(0,0,0,0.25))" }}>
    {hand ? (
      <svg width="56" height="60" viewBox="0 0 28 30" style={{ marginLeft: -16, marginTop: -2 }}>
        <path
          d="M10 3.5c0-1.4 2.6-1.4 2.6 0V12l.2-2.4c.2-1.3 2.5-1.2 2.5.2V12.4l.3-1.6c.3-1.2 2.4-1 2.4.3v2l.3-.9c.4-1.1 2.2-.8 2.2.5 0 3.6-.4 6.8-1.6 9.4-.8 1.8-1.8 3-3.4 3.8H11c-1.5-.9-2.6-2.3-3.6-4.2L5 16.3c-.6-1.2 1-2.3 2-1.3l3 3.2z"
          fill="#fff"
          stroke="#111"
          strokeWidth="1.3"
          strokeLinejoin="round"
        />
      </svg>
    ) : (
      <svg width="44" height="60" viewBox="0 0 22 30">
        <path d="M2 2v21.5l5.3-5.2 3.4 8.2 3.6-1.5-3.4-8h7.6z" fill="#111" stroke="#fff" strokeWidth="1.8" strokeLinejoin="round" />
      </svg>
    )}
  </div>
);

export const Avatar: React.FC<{ letter: string; color: string; size?: number }> = ({ letter, color, size = 64 }) => (
  <div
    style={{
      width: size,
      height: size,
      borderRadius: size,
      background: color,
      color: "#fff",
      display: "flex",
      alignItems: "center",
      justifyContent: "center",
      fontFamily: sans,
      fontWeight: 600,
      fontSize: size * 0.45,
      flex: "0 0 auto",
    }}
  >
    {letter}
  </div>
);

export const INBOX_ROWS: RowData[] = [
  { from: "Oliver at Fieldwork", subject: "The samples are on their way", snippet: "Your material samples should arrive tomorrow morning.", time: "9:12 AM" },
  { from: "Nina & Alex", subject: "Coffee next week?", snippet: "We’ll be in your neighborhood on Tuesday. Free at 10?", time: "8:40 AM" },
  { from: "Studio Weekly", subject: "Five small rituals for slower mornings", snippet: "This week: notebooks, window light, and the art of the second coffee.", time: "7:05 AM" },
  { from: "Jordan Park", subject: "Re: Friday review", snippet: "Works for me — I’ll bring the printed boards.", time: "Yesterday" },
  { from: "City Library", subject: "Your hold is ready", snippet: "“The Art of Noticing” is waiting for you at the front desk.", time: "Yesterday" },
  { from: "Sam Ortega", subject: "Photos from the weekend", snippet: "A few favorites from the lake. The pigeon one is my favorite.", time: "Sep 24" },
];
