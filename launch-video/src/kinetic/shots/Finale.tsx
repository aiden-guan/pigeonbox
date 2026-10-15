import React from "react";
import { AbsoluteFill, useCurrentFrame } from "remotion";
import { CameraRig } from "../Camera";
import { DotCanvas, fillDot } from "../Halftone";
import { Kicker, Rise } from "../type";
import { b, ci, clamp01, display, ease, K, mono, PB, sans } from "../tokens";
import { Icon } from "../ui/bits";
import { GM } from "../ui/Panels";
import { Workspace, WS_H, WS_W } from "../ui/Workspace";

/* ------------------------------------------------------------------ */
/* Rapid fire                                                          */
/* ------------------------------------------------------------------ */

const Chip: React.FC<{ children: React.ReactNode; size?: number }> = ({ children, size = 54 }) => (
  <span style={{ display: "inline-block", background: K.copperWash, color: K.copper, fontFamily: sans, fontWeight: 500, fontSize: size, padding: "0.18em 0.45em", borderRadius: "0.2em" }}>{children}</span>
);

type Fire = { word: string; italic?: string; bg: string; fg: string; art: (f: number) => React.ReactNode };

const FIRE: Fire[] = [
  {
    word: "Follow-ups.",
    bg: K.ink,
    fg: K.inkText,
    art: (f) => (
      <div style={{ display: "flex", alignItems: "center", gap: 22, fontFamily: sans, fontSize: 46, color: K.inkText, background: "#1b1d20", borderRadius: 20, padding: "22px 30px", boxShadow: "inset 0 0 0 2px #2e3237" }}>
        <span style={{ width: 16, height: 16, borderRadius: 8, background: K.copperBright, opacity: f % 30 < 18 ? 1 : 0.4 }} />
        <span>Invoice #2041</span>
        <span style={{ color: "#8b9199" }}>· no reply in 3 days</span>
      </div>
    ),
  },
  {
    word: "Key dates.",
    bg: K.paper,
    fg: K.ink,
    art: () => <Chip size={96}>Friday, October 9</Chip>,
  },
  {
    word: "To-dos.",
    bg: K.copper,
    fg: K.paper,
    art: (f) => (
      <div style={{ display: "flex", alignItems: "center", gap: 26, fontFamily: sans, fontSize: 72, color: K.paper }}>
        <span style={{ width: 84, height: 84, borderRadius: 18, border: `5px solid ${K.paper}`, display: "grid", placeItems: "center", background: f > 10 ? K.paper : "transparent" }}>
          {f > 10 ? Icon.check(K.copper, 62) : null}
        </span>
        <span style={{ textDecoration: f > 12 ? "line-through" : "none", textDecorationThickness: 4, opacity: f > 12 ? 0.8 : 1 }}>Confirm the delivery address</span>
      </div>
    ),
  },
  {
    word: "Cited answers.",
    bg: K.ink,
    fg: K.inkText,
    art: () => (
      <div style={{ display: "flex", gap: 18 }}>
        {[1, 2, 3].map((n) => (
          <span key={n} style={{ fontFamily: mono, fontSize: 84, color: K.copperBright, background: "#2e2019", borderRadius: 16, padding: "6px 34px" }}>{n}</span>
        ))}
      </div>
    ),
  },
  {
    word: "Works with",
    italic: "AI off.",
    bg: K.paper,
    fg: K.ink,
    art: (f) => (
      <div style={{ display: "flex", alignItems: "center", gap: 28, fontFamily: sans, fontSize: 56, color: K.ink }}>
        <span>AI</span>
        <span style={{ width: 132, height: 72, borderRadius: 36, background: f > 8 ? "#cfd6d2" : K.copper, position: "relative" }}>
          <span style={{ position: "absolute", top: 8, left: f > 8 ? 8 : 68, width: 56, height: 56, borderRadius: 28, background: "#fff", boxShadow: "0 2px 6px rgba(0,0,0,0.2)" }} />
        </span>
        <span style={{ color: K.muted }}>Off</span>
      </div>
    ),
  },
];

const AI = ["Gemini Nano", "WebGPU", "Ollama", "Your own key"];

export const RapidFire: React.FC = () => {
  const f = useCurrentFrame();
  const per = b(1);
  const idx = Math.floor(f / per);
  if (idx < FIRE.length) {
    const c = FIRE[idx];
    const g = f - idx * per;
    const pop = ease.expo(clamp01(g / 9));
    return (
      <AbsoluteFill style={{ background: c.bg, alignItems: "center", justifyContent: "center", gap: 60 }}>
        <div style={{ transform: `scale(${1.08 - 0.08 * pop})`, opacity: pop, height: 300, display: "grid", placeItems: "center" }}>{c.art(g)}</div>
        <div style={{ fontFamily: display, fontWeight: 600, fontSize: 190, lineHeight: 1, letterSpacing: "-0.04em", color: c.fg, transform: `translateY(${(1 - pop) * 30}px)` }}>
          {c.word}
          {c.italic ? (
            <>
              {" "}
              <span style={{ color: c.bg === K.copper ? K.ink : K.copper }}>{c.italic}</span>
            </>
          ) : null}
        </div>
      </AbsoluteFill>
    );
  }
  // Last card: the AI you choose, cycling on eighth notes.
  const g = f - FIRE.length * per;
  const step = Math.min(AI.length - 1, Math.floor(g / b(0.75)));
  const sg = g - step * b(0.75);
  return (
    <AbsoluteFill style={{ background: K.ink, alignItems: "center", justifyContent: "center" }}>
      <div style={{ fontFamily: mono, fontSize: 28, letterSpacing: "0.24em", color: K.inkText, opacity: 0.7, marginBottom: 40 }}>YOUR AI, YOUR CHOICE</div>
      <div style={{ position: "relative", height: 220, width: 1700, overflow: "hidden" }}>
        {AI.map((a, i) => {
          const y = (i - step) * 220 - ease.expo(clamp01(sg / 10)) * 0 + (i === step ? (1 - ease.expo(clamp01(sg / 10))) * 220 : 0);
          return (
            <div
              key={a}
              style={{
                position: "absolute",
                inset: 0,
                display: "grid",
                placeItems: "center",
                transform: `translateY(${i < step ? -220 : y}px)`,
                opacity: i === step ? 1 : 0,
                fontFamily: display,
                fontWeight: 600,
                fontSize: 200,
                letterSpacing: "-0.04em",
                color: i % 2 ? K.copperBright : K.inkText,
              }}
            >
              {a}
            </div>
          );
        })}
      </div>
    </AbsoluteFill>
  );
};

/* ------------------------------------------------------------------ */
/* Wide payoff: the whole Gmail window                                 */
/* ------------------------------------------------------------------ */

const GW = 1760;
const GH = 1000;

const GmailWindow: React.FC<{ f: number }> = ({ f }) => {
  const rows = [
    ["Maya Chen", "A few thoughts on the new direction", "Respond", "9:42 AM"],
    ["Oliver at Fieldwork", "The samples are on their way", "Respond", "8:54 AM"],
    ["Nina & Alex", "Coffee next week?", "Respond", "8:12 AM"],
    ["Jordan Park", "Re: Friday review", "Waiting", "Tue"],
    ["Studio Weekly", "Five small rituals for slower mornings", "FYI", "7:05 AM"],
    ["City Library", "Your hold is ready", "FYI", "6:40 AM"],
    ["Google Calendar", "Reminder: Design review @ Fri 10:00", "Notifications", "6:00 AM"],
    ["GitHub", "[pigeonbox] CI passed on main", "Notifications", "5:51 AM"],
    ["Figma", "Maya commented on Direction v2", "Notifications", "Yesterday"],
    ["Paper & Co.", "20% off notebooks this week", "FYI", "Yesterday"],
  ];
  const tagColor: Record<string, string> = { Respond: PB.accent, Waiting: "#e2b260", FYI: PB.tracking, Notifications: PB.muted };
  return (
    <div style={{ width: GW, height: GH, background: GM.shell, borderRadius: 18, overflow: "hidden", fontFamily: sans, color: GM.text, boxShadow: "inset 0 0 0 1px #dadce0" }}>
      <div style={{ height: 52, background: "#dee3ea", display: "flex", alignItems: "center", gap: 10, padding: "0 20px" }}>
        {["#ff5f57", "#febc2e", "#28c840"].map((c) => (
          <span key={c} style={{ width: 13, height: 13, borderRadius: 7, background: c }} />
        ))}
        <span style={{ marginLeft: 160, flex: 1, maxWidth: 900, height: 32, borderRadius: 16, background: "#ffffff", color: GM.muted, fontSize: 15, display: "flex", alignItems: "center", padding: "0 18px" }}>
          mail.google.com/mail/u/0/#inbox
        </span>
      </div>
      <div style={{ display: "flex", height: GH - 52 }}>
        <div style={{ width: 230, padding: "22px 14px", fontSize: 16 }}>
          <div style={{ fontSize: 24, marginBottom: 22, paddingLeft: 10 }}>
            <span style={{ color: "#ea4335", fontWeight: 700 }}>M</span> Gmail
          </div>
          <div style={{ background: GM.compose, borderRadius: 16, height: 56, display: "flex", alignItems: "center", padding: "0 20px", marginBottom: 16, color: GM.text }}>Compose</div>
          {["Inbox", "Starred", "Snoozed", "Sent", "Drafts"].map((n, i) => (
            <div key={n} style={{ height: 36, display: "flex", alignItems: "center", padding: "0 20px", borderRadius: 18, background: i === 0 ? GM.navSel : undefined, fontWeight: i === 0 ? 600 : 400 }}>
              {n}
              {i === 0 ? <span style={{ marginLeft: "auto" }}>3</span> : null}
            </div>
          ))}
        </div>
        <div style={{ flex: 1, background: GM.bg, borderRadius: 16, marginTop: 10, overflow: "hidden", boxShadow: "0 0 0 1px #e3e7ec" }}>
          <div style={{ height: 54, display: "flex", alignItems: "center", gap: 30, padding: "0 26px", fontSize: 15, color: GM.muted, borderBottom: `1px solid ${GM.line}` }}>
            <span style={{ color: GM.blue, borderBottom: `3px solid ${GM.blue}`, paddingBottom: 12, marginTop: 15 }}>Primary</span>
            <span>Promotions</span>
            <span>Social</span>
          </div>
          {rows.map((r, i) => {
            const p = ease.expo(clamp01((f - 6 - i * 4) / 18));
            return (
              <div key={i} style={{ height: 56, display: "flex", alignItems: "center", gap: 18, padding: "0 26px", borderBottom: `1px solid ${GM.line}`, fontSize: 16, fontWeight: i < 3 ? 600 : 400 }}>
                <span style={{ width: 190, whiteSpace: "nowrap" }}>{r[0]}</span>
                <span
                  style={{
                    fontSize: 12.5,
                    fontWeight: 600,
                    color: tagColor[r[2]],
                    background: `${tagColor[r[2]]}22`,
                    padding: "3px 8px",
                    borderRadius: 6,
                    opacity: p,
                    transform: `translateX(${(1 - p) * -10}px)`,
                  }}
                >
                  {r[2]}
                </span>
                <span style={{ flex: 1, whiteSpace: "nowrap", overflow: "hidden" }}>{r[1]}</span>
                <span style={{ fontSize: 14, color: GM.muted }}>{r[3]}</span>
              </div>
            );
          })}
        </div>
        <div style={{ width: WS_W + 30, padding: "10px 14px 0 16px", position: "relative" }}>
          <div style={{ transform: "scale(1)", transformOrigin: "0 0" }}>
            <Workspace tab="Home" cat={0} pose="idle" pidgyFrame={Math.floor(f / 10)} />
          </div>
        </div>
      </div>
    </div>
  );
};

export const Payoff: React.FC = () => {
  const f = useCurrentFrame();
  const t = f / b(4);
  return (
    <AbsoluteFill>
      <CameraRig
        cam={{
          w: GW,
          h: GH,
          fx: GW / 2,
          fy: GH / 2,
          tx: 0,
          ty: 10,
          pitch: 11 - t * 2,
          yaw: -2 + t * 2,
          roll: 0,
          mag: 0.98 + t * 0.06,
          perspective: 2000,
          band: 260,
          rate: 0.02,
          light: { x: GW / 2, y: GH / 2, rx: 1500, ry: 1000, dim: 0.55 },
        }}
        vignette={0.6}
      >
        <GmailWindow f={f} />
      </CameraRig>
      <div style={{ position: "absolute", left: 0, right: 0, bottom: 46, textAlign: "center", fontFamily: mono, fontSize: 22, letterSpacing: "0.3em", color: K.inkText, opacity: ci(f, [20, 40], [0, 0.7]) }}>
        RIGHT INSIDE GMAIL
      </div>
    </AbsoluteFill>
  );
};

/* ------------------------------------------------------------------ */
/* Privacy                                                             */
/* ------------------------------------------------------------------ */

export const Privacy: React.FC = () => {
  const f = useCurrentFrame();
  const dimOld = ci(f, [b(5), b(5.5)], [1, 0.35]);
  const line = (n: number) => (n < 2 ? dimOld : 1);
  const L: { w: { t: string; italic?: boolean; color?: string }[]; at: number }[] = [
    { w: [{ t: "No" }, { t: "PigeonBox" }, { t: "account." }], at: 0 },
    { w: [{ t: "No" }, { t: "Gmail" }, { t: "API" }, { t: "access." }], at: b(1.5) },
    { w: [{ t: "Your" }, { t: "mail" }, { t: "stays" }, { t: "on" }, { t: "your" }, { t: "computer.", italic: true, color: K.copperBright }], at: b(3) },
  ];
  return (
    <AbsoluteFill style={{ background: K.ink, justifyContent: "center", padding: "0 150px" }}>
      <Kicker n="06" t="PRIVATE BY DEFAULT" f={f} color={K.inkText} />
      <div style={{ fontFamily: display, fontWeight: 600, fontSize: 106, lineHeight: 1.14, letterSpacing: "-0.04em", color: K.inkText, transform: `scale(${1 + f * 0.00012})`, transformOrigin: "0 50%" }}>
        {L.map((l, li) => (
          <div key={li} style={{ opacity: line(li), whiteSpace: "nowrap" }}>
            {l.w.map((w, wi) => (
              <React.Fragment key={wi}>
                {wi ? " " : null}
                <Rise f={f} at={l.at + wi * 4}>
                  <span style={{ color: w.color }}>{w.t}</span>
                </Rise>
              </React.Fragment>
            ))}
          </div>
        ))}
        <div style={{ marginTop: 50, fontFamily: mono, fontSize: 28, letterSpacing: "0.2em", color: K.inkText, opacity: ci(f, [b(5), b(5.5)], [0, 0.8]) }}>
          LOCAL BY DEFAULT · FREE &amp; OPEN SOURCE (MIT)
        </div>
      </div>
    </AbsoluteFill>
  );
};

/* ------------------------------------------------------------------ */
/* End card                                                            */
/* ------------------------------------------------------------------ */

export const EndCard: React.FC = () => {
  const f = useCurrentFrame();
  // A fine dot field settles behind the type: the brand's halftone, used as texture only.
  const draw = (ctx: CanvasRenderingContext2D) => {
    ctx.fillStyle = "rgba(243,240,232,0.16)";
    ctx.beginPath();
    const cell = 22;
    for (let y = cell / 2; y < 1080; y += cell) {
      for (let x = cell / 2; x < 1920; x += cell) {
        const dx = (x - 960) / 960;
        const dy = (y - 540) / 540;
        const d = Math.sqrt(dx * dx + dy * dy);
        const p = ease.expo(clamp01((f - d * 30) / 30));
        fillDot(ctx, x, y, 2.6 * Math.min(1, d * 1.1) * p);
      }
    }
    ctx.fill();
  };
  const letters = "PigeonBox".split("");
  return (
    <AbsoluteFill style={{ background: K.copper, alignItems: "center", justifyContent: "center" }}>
      <DotCanvas draw={draw} deps={[f]} />
      <div style={{ textAlign: "center", color: K.paper, transform: `scale(${1 + 0.02 * ci(f, [0, 300], [0, 1], ease.linear)})` }}>
        <div style={{ fontFamily: display, fontWeight: 700, fontSize: 250, lineHeight: 1.05, letterSpacing: "-0.05em" }}>
          {letters.map((ch, i) => (
            <Rise key={i} f={f} at={4 + i * 1.6} dur={16}>
              {ch}
            </Rise>
          ))}
        </div>
        <div style={{ fontFamily: display, fontWeight: 500, fontSize: 64, marginTop: 18, letterSpacing: "-0.02em", opacity: 0.92 }}>
          <Rise f={f} at={30} dur={16}>Find what needs a reply.</Rise>
        </div>
        <div style={{ display: "flex", justifyContent: "center", gap: 30, marginTop: 70, fontFamily: mono, fontSize: 27, letterSpacing: "0.12em", opacity: ci(f, [52, 68], [0, 1]) }}>
          <span style={{ background: K.paper, color: K.copper, padding: "12px 22px", borderRadius: 8 }}>usepigeonbox.com</span>
          <span style={{ padding: "12px 0", opacity: 0.85 }}>FREE FOR GMAIL</span>
        </div>
      </div>
    </AbsoluteFill>
  );
};
export { WS_H };
