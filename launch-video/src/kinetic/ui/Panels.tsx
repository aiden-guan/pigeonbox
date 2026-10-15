import React from "react";
import { Appear, Caret, Dots, Icon, uiFont } from "./bits";
import { GM, mono, PB, sans } from "../tokens";

/* ------------------------------------------------------------------ */
/* Gmail thread with the PigeonBox companion card                      */
/* ------------------------------------------------------------------ */

export { GM };

export const THREAD_W = 1500;
export const THREAD_H = 980;

const OLIVER = [
  "Hi Ada,",
  "",
  "Good news: your material samples ship today and should arrive tomorrow morning, around 9. There are three swatches in the box, including the copper finish you asked about, plus the two linen options from last time.",
  "",
  "The courier will need a signature on delivery, so someone has to be there to receive it.",
  "",
  "Could you confirm the delivery address? We have the old studio on file and I want to make sure this goes to the right place.",
  "",
  "Thanks,",
  "Oliver",
];

export type CardState = {
  /** 0..1 reveal for each block. */
  label: number;
  summary: number;
  date: number;
  bullets: [number, number];
  todo: number;
  button: number;
  /** Button state. */
  drafting?: boolean;
  pressed?: number;
};

export const CompanionCard: React.FC<{ s: CardState; width?: number }> = ({ s, width = 400 }) => (
  <div
    style={{
      ...uiFont,
      width,
      background: PB.raised,
      borderRadius: 18,
      boxShadow: `inset 0 0 0 1px ${PB.border}, inset 0 1px 0 rgba(255,255,255,0.07), 0 30px 80px rgba(0,0,0,0.18)`,
      padding: "26px 26px 18px",
    }}
  >
    <Dots p={s.label}>
      <div style={{ fontSize: 15, color: PB.fg2 }}>Respond</div>
    </Dots>
    <Dots p={s.summary}>
      <div style={{ fontSize: 20, lineHeight: 1.55, marginTop: 6, color: PB.fg }}>
        Oliver’s samples arrive tomorrow morning. He needs the delivery address confirmed.
      </div>
    </Dots>
    <Dots p={s.date}>
      <span
        style={{
          display: "inline-block",
          marginTop: 22,
          background: PB.accentSoft,
          color: PB.accent,
          fontSize: 17,
          fontWeight: 500,
          padding: "6px 12px",
          borderRadius: 7,
        }}
      >
        Friday, October 9
      </span>
    </Dots>
    <div style={{ marginTop: 22 }}>
      {["Three swatches, including the copper finish.", "The courier needs a signature."].map((t, i) => (
        <Dots key={t} p={s.bullets[i]}>
          <Bullet>{t}</Bullet>
        </Dots>
      ))}
    </div>
    <Dots p={s.todo}>
      <div style={{ fontSize: 16, fontWeight: 600, color: PB.fg2, marginTop: 22 }}>To do</div>
      <Bullet>Confirm the delivery address.</Bullet>
    </Dots>
    <Appear p={s.button} style={{ marginTop: 20 }}>
      <div
        style={{
          height: 50,
          borderRadius: 10,
          background: s.drafting ? PB.busy : PB.accent,
          color: PB.onAccent,
          display: "flex",
          alignItems: "center",
          justifyContent: "center",
          gap: 10,
          fontSize: 17,
          fontWeight: 600,
          transform: `scale(${1 - 0.03 * (s.pressed ?? 0)})`,
        }}
      >
        {s.drafting ? Icon.waves(PB.onAccent, 18) : null}
        {s.drafting ? "Drafting…" : "Draft reply"}
      </div>
      <div style={{ textAlign: "right", color: PB.muted, marginTop: 8, letterSpacing: 2 }}>···</div>
    </Appear>
  </div>
);

const Bullet: React.FC<{ children: React.ReactNode }> = ({ children }) => (
  <div style={{ display: "flex", gap: 14, fontSize: 18, lineHeight: 1.45, marginTop: 8, color: PB.fg }}>
    <span style={{ width: 5, height: 5, borderRadius: 3, background: PB.accent, marginTop: 9, flex: "none" }} />
    <span>{children}</span>
  </div>
);

/** Gmail's dark thread view with the companion card floating at the right. */
export const ThreadView: React.FC<{ card: CardState; cardX?: number; cardY?: number }> = ({ card, cardX = 1010, cardY = 120 }) => (
  <div style={{ width: THREAD_W, height: THREAD_H, background: GM.bg, borderRadius: 18, position: "relative", fontFamily: sans, color: GM.text, overflow: "hidden" }}>
    <div style={{ padding: "48px 70px 0 70px", width: 880 }}>
      <div style={{ fontSize: 30, fontWeight: 400 }}>
        The samples are on their way <span style={{ fontSize: 15, background: GM.surface, color: GM.sub, padding: "3px 8px", borderRadius: 5, verticalAlign: 4 }}>Inbox</span>
      </div>
      <div style={{ display: "flex", alignItems: "center", gap: 16, marginTop: 34 }}>
        <div style={{ width: 48, height: 48, borderRadius: 24, background: GM.avatar, display: "grid", placeItems: "center", fontSize: 22, fontWeight: 600 }}>O</div>
        <div>
          <div style={{ fontSize: 19, fontWeight: 600 }}>
            Oliver at Fieldwork <span style={{ fontWeight: 400, color: GM.muted, fontSize: 16 }}>&lt;oliver@fieldwork.studio&gt;</span>
          </div>
          <div style={{ fontSize: 16, color: GM.muted, marginTop: 3 }}>to me</div>
        </div>
        <div style={{ flex: 1 }} />
        <div style={{ fontSize: 16, color: GM.muted }}>8:54 AM (2 hours ago)</div>
      </div>
      <div style={{ marginTop: 30, marginLeft: 64, fontSize: 19, lineHeight: 1.6, color: GM.sub }}>
        {OLIVER.map((l, i) => (
          <div key={i} style={{ minHeight: l ? undefined : 18 }}>{l}</div>
        ))}
      </div>
    </div>
    <div style={{ position: "absolute", left: cardX, top: cardY }}>
      <CompanionCard s={card} />
    </div>
  </div>
);

/* ------------------------------------------------------------------ */
/* Gmail compose with the drafted reply                               */
/* ------------------------------------------------------------------ */

const gi = (d: string, s = 20) => (
  <svg width={s} height={s} viewBox="0 0 24 24" fill="none" stroke={GM.sub} strokeWidth={2} strokeLinecap="round" strokeLinejoin="round">
    <path d={d} />
  </svg>
);
/** Gmail's compose glyphs, drawn rather than typed so no font fallback can garble them. */
const GI = {
  min: gi("M6 12h12"),
  expand: gi("M14 4h6v6M10 20H4v-6M20 4l-7 7M4 20l7-7"),
  close: gi("M6 6l12 12M18 6 6 18"),
  format: gi("M6 19 11.5 5h1L18 19M8.5 14h7"),
  attach: gi("M20 11.5 12.5 19a5 5 0 0 1-7-7l8-8a3.3 3.3 0 0 1 4.7 4.7l-8 8a1.7 1.7 0 0 1-2.4-2.4l7.3-7.3"),
  link: gi("M10 14a4.5 4.5 0 0 0 6.4 0l3-3a4.5 4.5 0 0 0-6.4-6.4l-1 1M14 10a4.5 4.5 0 0 0-6.4 0l-3 3a4.5 4.5 0 0 0 6.4 6.4l1-1"),
  smile: gi("M12 21a9 9 0 1 0 0-18 9 9 0 0 0 0 18ZM8.5 14.5a4.5 4.5 0 0 0 7 0M9 9.5h.01M15 9.5h.01"),
};

export const COMPOSE_W = 820;
export const COMPOSE_H = 640;

export const Composer: React.FC<{
  body: string;
  caret?: boolean;
  frame: number;
  sendPress?: number;
  sent?: number;
}> = ({ body, caret, frame, sendPress = 0, sent = 0 }) => (
  <div
    style={{
      width: COMPOSE_W,
      height: COMPOSE_H,
      background: GM.bg,
      borderRadius: 16,
      overflow: "hidden",
      fontFamily: sans,
      color: GM.text,
      boxShadow: `inset 0 0 0 1px #dadce0, 0 30px 80px rgba(0,0,0,0.25)`,
      position: "relative",
    }}
  >
    <div style={{ height: 54, background: GM.header, display: "flex", alignItems: "center", padding: "0 22px", fontSize: 18, fontWeight: 500 }}>
      Re: The samples are on their way
      <span style={{ flex: 1 }} />
      <span style={{ display: "inline-flex", gap: 18 }}>{[GI.min, GI.expand, GI.close].map((g, i) => <span key={i}>{g}</span>)}</span>
    </div>
    <div style={{ padding: "0 26px" }}>
      <div style={{ height: 52, borderBottom: `1px solid ${GM.line}`, display: "flex", alignItems: "center", gap: 12, fontSize: 18 }}>
        <span style={{ color: GM.muted }}>To</span>
        <span style={{ background: GM.surface, borderRadius: 16, padding: "4px 14px 4px 4px", display: "inline-flex", alignItems: "center", gap: 9 }}>
          <span style={{ width: 26, height: 26, borderRadius: 13, background: GM.avatar, display: "grid", placeItems: "center", fontSize: 13, fontWeight: 600 }}>O</span>
          Oliver at Fieldwork
        </span>
      </div>
      <div style={{ paddingTop: 22, fontSize: 20, lineHeight: 1.6, whiteSpace: "pre-wrap", minHeight: 400, color: GM.text }}>
        {body}
        {caret ? <Caret frame={frame} color={GM.text} h={22} idle={false} /> : null}
      </div>
    </div>
    <div style={{ position: "absolute", left: 22, right: 22, bottom: 20, display: "flex", alignItems: "center", gap: 14 }}>
      <span
        style={{
          display: "inline-flex",
          alignItems: "center",
          gap: 8,
          height: 40,
          padding: "0 16px",
          borderRadius: 20,
          background: PB.accentSoft,
          color: PB.accent,
          fontSize: 16,
          fontWeight: 500,
          boxShadow: `inset 0 0 0 1px rgba(228,138,101,0.35)`,
        }}
      >
        {Icon.eye(PB.accent, 16)} Tracking ready
      </span>
      <span
        style={{
          display: "inline-flex",
          alignItems: "center",
          height: 44,
          padding: "0 28px",
          borderRadius: 22,
          background: sent > 0 ? GM.blueDone : GM.blue,
          color: GM.blueInk,
          fontSize: 18,
          fontWeight: 600,
          transform: `scale(${1 - 0.06 * sendPress})`,
          boxShadow: sendPress > 0 ? "0 0 0 6px rgba(11,87,208,0.18)" : undefined,
        }}
      >
        Send
      </span>
      <span style={{ display: "inline-flex", gap: 20, marginLeft: 10 }}>{[GI.format, GI.attach, GI.link, GI.smile].map((g, i) => <span key={i}>{g}</span>)}</span>
    </div>
  </div>
);

/* ------------------------------------------------------------------ */
/* Ask, with its reasoning trace and citations                         */
/* ------------------------------------------------------------------ */

const GLYPH: Record<string, string> = {
  search: "M10.5 17a6.5 6.5 0 1 0 0-13 6.5 6.5 0 0 0 0 13ZM15.5 15.5 20 20",
  read: "M4 5.5h6a2 2 0 0 1 2 2V19a1.5 1.5 0 0 0-1.5-1.5H4ZM20 5.5h-6a2 2 0 0 0-2 2V19a1.5 1.5 0 0 1 1.5-1.5H20Z",
  people: "M12 11a3.5 3.5 0 1 0 0-7 3.5 3.5 0 0 0 0 7ZM5 20c.6-3.5 3.3-5.5 7-5.5s6.4 2 7 5.5",
  calendar: "M5 6.5h14v13H5ZM5 10.5h14M9 4v4M15 4v4",
  write: "M5 19l1-4L15.5 5.5a2.1 2.1 0 0 1 3 3L9 18Z M13.5 7.5l3 3",
};
const KIND_COLOR: Record<string, string> = {
  search: "#e48a65",
  read: "#a9b4c0",
  people: "#6cc890",
  calendar: "#e2b260",
  write: "#e48a65",
};

export const Glyph: React.FC<{ kind: string; size?: number; color?: string }> = ({ kind, size = 13, color }) => (
  <svg viewBox="0 0 24 24" width={size} height={size} fill="none" stroke={color ?? "currentColor"} strokeWidth={2} strokeLinecap="round" strokeLinejoin="round">
    <path d={GLYPH[kind]} />
  </svg>
);

export const STEPS = [
  { kind: "search", pill: "Search", text: "“Maya” in 2,847 threads" },
  { kind: "people", pill: "People", text: "Maya Chen · maya@fieldwork.studio" },
  { kind: "read", pill: "Read", text: "A few thoughts on the new direction" },
  { kind: "calendar", pill: "Calendar", text: "Design review · Fri 10:00" },
];

/** Copper orb: the swirl that shows Pigeon working. */
export const Orb: React.FC<{ frame: number; size?: number }> = ({ frame, size = 18 }) => (
  <svg width={size} height={size} viewBox="-12 -12 24 24">
    {[0, 1, 2].map((i) => (
      <ellipse key={i} rx={10} ry={4 + i * 2} fill="none" stroke={PB.accent} strokeWidth={1.4} opacity={0.5 + i * 0.2} transform={`rotate(${frame * 3 + i * 60})`} />
    ))}
  </svg>
);

export type AskState = {
  question: string;
  caret: boolean;
  /** Question sent and shown as a quote. */
  asked: number;
  /** Number of trace rows shown (fractional for the arriving row). */
  steps: number;
  /** Trace has settled into "Worked for 4s". */
  settled: number;
  /** 0..1 for answer lines. */
  answer: number;
  sources: number;
};

export const AskBody: React.FC<{ s: AskState; frame: number }> = ({ s, frame }) => {
  const live = s.settled < 0.5;
  const shown = Math.floor(s.steps);
  const answerLines = [
    <>You told Maya you’d send the <b style={{ fontWeight: 600 }}>updated screens before Friday’s review</b>, with a warmer tone on the main screen</>,
    <>and simpler controls <Cite n={1} />. The review is Friday at 10:00 <Cite n={2} />.</>,
  ];
  return (
    <div style={{ padding: "18px 20px 0", fontFamily: sans, position: "relative", height: 640 }}>
      <Appear p={s.asked}>
        <div style={{ borderLeft: `2px solid ${PB.borderStrong}`, padding: "4px 0 4px 14px", fontSize: 17, color: PB.fg, lineHeight: 1.4 }}>
          What did I promise Maya before Friday?
        </div>
      </Appear>
      {s.asked > 0.5 ? (
        <div style={{ marginTop: 18 }}>
          <div style={{ display: "flex", alignItems: "center", gap: 10, minHeight: 28, color: PB.muted, fontSize: 15 }}>
            {live ? (
              <Orb frame={frame} />
            ) : (
              <span style={{ display: "inline-flex" }}>
                {["search", "people", "read"].map((k, i) => (
                  <span
                    key={k}
                    style={{
                      width: 20,
                      height: 20,
                      borderRadius: 10,
                      display: "grid",
                      placeItems: "center",
                      background: PB.selected,
                      color: KIND_COLOR[k],
                      marginLeft: i ? -5 : 0,
                      boxShadow: `0 0 0 2px ${PB.surface}`,
                    }}
                  >
                    <Glyph kind={k} size={11} />
                  </span>
                ))}
              </span>
            )}
            <span style={{ fontWeight: 500, color: live ? PB.fg2 : PB.fg2 }}>{live ? "Searching your mail" : "Worked for 4s"}</span>
            <span style={{ fontFamily: mono, fontSize: 12.5, color: PB.muted, opacity: 0.8 }}>{live ? "" : "4 steps"}</span>
          </div>
          <div style={{ marginLeft: 8, paddingLeft: 14, borderLeft: `1px solid ${PB.border}`, marginTop: 6, display: "grid", gap: 4 }}>
            {STEPS.slice(0, Math.max(0, Math.ceil(s.steps))).map((st, i) => {
              const p = i < shown ? 1 : s.steps - shown;
              return (
                <div key={i} style={{ display: "flex", alignItems: "center", gap: 10, minHeight: 30, opacity: p, transform: `translateX(${(1 - p) * 8}px)` }}>
                  <span
                    style={{
                      display: "inline-flex",
                      alignItems: "center",
                      gap: 5,
                      height: 22,
                      padding: "0 8px 0 7px",
                      borderRadius: 11,
                      background: `${KIND_COLOR[st.kind]}22`,
                      color: KIND_COLOR[st.kind],
                      fontSize: 12,
                      fontWeight: 600,
                    }}
                  >
                    <Glyph kind={st.kind} size={12} />
                    {st.pill}
                  </span>
                  <span style={{ fontSize: 14.5, color: PB.fg2, whiteSpace: "nowrap" }}>{st.text}</span>
                </div>
              );
            })}
          </div>
          <div style={{ marginTop: 16, fontSize: 18, lineHeight: 1.6, color: PB.fg }}>
            {answerLines.map((l, i) => (
              <Dots key={i} p={s.answer * 2 - i * 0.6}>
                <div>{l}</div>
              </Dots>
            ))}
          </div>
          <div style={{ marginTop: 16, display: "grid", gap: 8 }}>
            {[
              { n: 1, who: "Maya Chen", t: "A few thoughts on the new direction", d: "Oct 2" },
              { n: 2, who: "Google Calendar", t: "Design review", d: "Fri 10:00" },
            ].map((src, i) => (
              <Appear key={src.n} p={s.sources * 2 - i * 0.5}>
                <div
                  style={{
                    display: "flex",
                    alignItems: "center",
                    gap: 10,
                    background: PB.raised,
                    borderRadius: 10,
                    boxShadow: `inset 0 0 0 1px ${PB.border}`,
                    padding: "10px 12px",
                    fontSize: 14.5,
                  }}
                >
                  <span style={{ fontFamily: mono, fontSize: 12, color: PB.accent, background: PB.accentSoft, borderRadius: 5, padding: "1px 6px" }}>{src.n}</span>
                  <span style={{ fontWeight: 600, color: PB.fg }}>{src.who}</span>
                  <span style={{ color: PB.fg2, flex: 1, whiteSpace: "nowrap", overflow: "hidden", textOverflow: "ellipsis" }}>{src.t}</span>
                  <span style={{ color: PB.muted, fontSize: 13 }}>{src.d}</span>
                </div>
              </Appear>
            ))}
          </div>
        </div>
      ) : null}
      <div
        style={{
          position: "absolute",
          left: 20,
          right: 20,
          top: 600,
          display: "flex",
          gap: 10,
        }}
      >
        <div
          style={{
            flex: 1,
            height: 50,
            borderRadius: 10,
            background: PB.inset,
            boxShadow: `inset 0 0 0 ${s.caret ? 2 : 1}px ${s.caret ? PB.accent : PB.border}`,
            display: "flex",
            alignItems: "center",
            padding: "0 14px",
            fontSize: 16.5,
            color: s.question ? PB.fg : PB.muted,
            whiteSpace: "nowrap",
            overflow: "hidden",
          }}
        >
          {s.question || "Ask, or draft an email…"}
          {s.caret ? <Caret frame={frame} h={20} /> : null}
        </div>
        <div
          style={{
            width: 92,
            height: 50,
            borderRadius: 10,
            background: s.asked > 0 && live ? PB.busy : PB.accent,
            color: PB.onAccent,
            display: "grid",
            placeItems: "center",
            fontWeight: 600,
            fontSize: 16,
          }}
        >
          {s.asked > 0 && live ? "Working" : "Ask"}
        </div>
      </div>
    </div>
  );
};

const Cite: React.FC<{ n: number }> = ({ n }) => (
  <span style={{ fontFamily: mono, fontSize: 12, color: PB.accent, background: PB.accentSoft, borderRadius: 5, padding: "1px 6px", verticalAlign: 2 }}>{n}</span>
);

/* ------------------------------------------------------------------ */
/* Sent mail with the open mark, and the open toast                    */
/* ------------------------------------------------------------------ */

export const SENT_W = 1300;
export const SENT_H = 700;

const SENT = [
  { to: "To: Maya Chen", subj: "The new direction", snip: "Hi Maya, Here’s the new direction, with both changes…", when: "9:37 AM", track: true },
  { to: "To: Oliver at Fieldwork", subj: "Re: The samples are on their way", snip: "Hi Oliver, Thanks for the heads up. The address is…", when: "9:12 AM" },
  { to: "To: Jordan Park", subj: "Boards for Friday", snip: "Printed and packed, see you there.", when: "Yesterday" },
  { to: "To: Nina, Alex", subj: "Re: Coffee next week?", snip: "Tuesday at 10 works! The usual place?", when: "Yesterday" },
  { to: "To: Sam Ortega", subj: "Contract, v3", snip: "Signed copy attached.", when: "Mon" },
];

export const SentList: React.FC<{ opened: number; toast: number; notify: number; frame: number }> = ({ opened, toast, notify }) => (
  <div style={{ width: SENT_W, height: SENT_H, background: GM.bg, borderRadius: 18, position: "relative", fontFamily: sans, color: GM.text, overflow: "hidden" }}>
    <div style={{ padding: "26px 34px 14px", fontSize: 18, color: GM.muted, display: "flex", gap: 26 }}>
      <span style={{ color: GM.text, fontWeight: 600 }}>Sent</span>
      <span>1–5 of 1,204</span>
    </div>
    {SENT.map((r, i) => (
      <div key={i} style={{ height: 66, display: "flex", alignItems: "center", gap: 22, padding: "0 34px", borderTop: `1px solid ${GM.line}`, fontSize: 19 }}>
        <span style={{ width: 230, color: GM.sub }}>{r.to}</span>
        <span style={{ flex: 1, whiteSpace: "nowrap", overflow: "hidden" }}>
          <span style={{ fontWeight: 500 }}>{r.subj}</span> <span style={{ color: GM.muted }}>— {r.snip}</span>
        </span>
        {r.track ? (
          <span
            style={{
              display: "inline-flex",
              alignItems: "center",
              gap: 6,
              fontSize: 16,
              fontWeight: 600,
              color: opened > 0.5 ? PB.accent : GM.muted,
              opacity: 0.4 + 0.6 * Math.min(1, opened * 2),
              transform: `scale(${1 + 0.18 * Math.sin(Math.min(1, opened) * Math.PI)})`,
            }}
          >
            {Icon.check(opened > 0.5 ? PB.accent : GM.muted, 16)}
            {opened > 0.5 ? "Opened" : "Sent"}
          </span>
        ) : null}
        <span style={{ width: 96, textAlign: "right", fontSize: 16, color: GM.muted }}>{r.when}</span>
      </div>
    ))}
    <div style={{ position: "absolute", left: 640, top: 160 }}>
      <Appear p={toast} y={18}>
        <div
          style={{
            width: 520,
            background: PB.raised,
            borderRadius: 16,
            boxShadow: `inset 0 0 0 1px ${PB.border}, 0 30px 70px rgba(0,0,0,0.2)`,
            padding: "22px 24px",
            fontFamily: sans,
            position: "relative",
          }}
        >
          <div style={{ position: "absolute", left: 250, top: -9, width: 18, height: 18, background: PB.raised, transform: "rotate(45deg)", boxShadow: `-1px -1px 0 ${PB.border}` }} />
          <div style={{ display: "flex", gap: 14, alignItems: "flex-start" }}>
            <div>
              <div style={{ fontSize: 19, lineHeight: 1.4, color: PB.fg }}>
                <b style={{ fontWeight: 600 }}>Maya Chen</b> opened your email less than a minute ago.
              </div>
              <div style={{ display: "flex", alignItems: "center", gap: 8, fontSize: 15, color: PB.muted, marginTop: 8 }}>
                {Icon.eye(PB.muted, 15)} First opened 4 minutes after you sent.
              </div>
            </div>
          </div>
          <div
            style={{
              marginTop: 18,
              height: 44,
              borderRadius: 10,
              boxShadow: `inset 0 0 0 1px ${PB.borderStrong}`,
              display: "grid",
              placeItems: "center",
              fontSize: 16,
              fontWeight: 600,
              color: PB.fg,
            }}
          >
            Opened once
          </div>
          <div style={{ display: "flex", alignItems: "center", gap: 12, marginTop: 16, fontSize: 16, color: PB.fg2 }}>
            <span style={{ width: 40, height: 22, borderRadius: 11, background: notify > 0.5 ? PB.accent : PB.selected, position: "relative" }}>
              <span style={{ position: "absolute", top: 3, left: 3 + 18 * Math.min(1, notify), width: 16, height: 16, borderRadius: 8, background: "#fff" }} />
            </span>
            Notify me if there is no reply
          </div>
        </div>
      </Appear>
    </div>
  </div>
);
