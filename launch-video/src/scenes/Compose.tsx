import React from "react";
import { AbsoluteFill, useCurrentFrame } from "remotion";
import { Avatar, Cursor, INBOX_ROWS, Row, SearchBar, Sidebar, UI } from "../components/Mail";
import { FilmFinish } from "../components/Pixel";
import { Envelope } from "../components/World";
import { at, ci, ease, shotStart } from "../lib";
import { sans } from "../theme";
import typing from "../typing.json";

const WIN = { x: 560, y: 150, w: 1220, h: 820 };
const SEND = { x: 872, y: 876, w: 156, h: 72 };
const PILL = { x: 604, y: 886, w: 240, h: 52 };

/** Close on the sender's screen: the email is written, tracking is ready, it's sent. */
export const Compose: React.FC = () => {
  const f = useCurrentFrame();
  const abs = f + shotStart("compose");
  const click = at("compose", "sendClick");
  const sent = at("compose", "sent");

  const typed = typing.frames.filter((fr) => fr <= abs).length;
  const text = typing.text.slice(0, typed);
  const caretOn = typed < typing.text.length ? true : Math.floor(f / 14) % 2 === 0;

  // camera: follow the words, then settle on the toolbar for the send
  const s = ci(f, [0, 150, 200], [1.62, 1.58, 1.3], ease.inOut);
  const fx = ci(f, [0, 150, 205], [1150, 1160, 1000], ease.inOut);
  const fy = ci(f, [0, 60, 150, 205], [470, 500, 540, 650], ease.inOut);

  const press = ci(f, [click, click + 3, click + 7], [0, 1, 0], ease.linear);
  const collapse = ci(f, [sent, sent + 16], [0, 1], ease.in);
  const pillGlow = ci(f, [160, 176, 206], [0, 1, 0], ease.soft);

  const cx = ci(f, [194, click - 2], [1540, SEND.x + 70], ease.out);
  const cy = ci(f, [194, click - 2], [1060, SEND.y + 40], ease.out);

  // the envelope lifts off the sent message
  const envT = ci(f, [sent + 4, 240], [0, 1], ease.in);

  return (
    <AbsoluteFill style={{ background: "#1c1a18", overflow: "hidden" }}>
      <AbsoluteFill
        style={{
          left: 960 - fx * s,
          top: 540 - fy * s,
          width: 1920,
          height: 1080,
          scale: `${s}`,
          transformOrigin: "0 0",
        }}
      >
        {/* the inbox, out of focus behind the compose window */}
        <AbsoluteFill style={{ background: UI.bg, filter: "blur(3px)" }}>
          <Sidebar active="Inbox" />
          <SearchBar />
          <div style={{ position: "absolute", left: 380, top: 136, right: 24, bottom: 0, background: UI.panel, borderRadius: "32px 32px 0 0", overflow: "hidden" }}>
            <div style={{ height: 80 }} />
            {INBOX_ROWS.map((r) => (
              <Row key={r.from} {...r} />
            ))}
          </div>
        </AbsoluteFill>
        <AbsoluteFill style={{ background: "rgba(20,16,12,0.18)" }} />

        {/* compose window */}
        <div
          style={{
            position: "absolute",
            left: WIN.x,
            top: WIN.y,
            width: WIN.w,
            height: WIN.h,
            borderRadius: 24,
            background: "#fff",
            boxShadow: "0 30px 80px rgba(20,16,12,0.28), 0 4px 14px rgba(20,16,12,0.12)",
            overflow: "hidden",
            fontFamily: sans,
            color: UI.text,
            transformOrigin: "90% 0%",
            scale: `${1 - collapse * 0.85}`,
            translate: `${collapse * 380}px ${-collapse * 260}px`,
            opacity: 1 - ci(f, [sent + 8, sent + 16], [0, 1], ease.linear),
          }}
        >
          <div style={{ height: 76, background: "#f2f6fc", display: "flex", alignItems: "center", padding: "0 32px", fontSize: 26, fontWeight: 600 }}>
            New message
            <div style={{ flex: 1 }} />
            <div style={{ display: "flex", gap: 28, color: UI.sub, fontWeight: 400, fontSize: 30 }}>
              <span>—</span>
              <span>⤢</span>
              <span>✕</span>
            </div>
          </div>
          <div style={{ margin: "0 32px", height: 76, borderBottom: `2px solid ${UI.line}`, display: "flex", alignItems: "center", gap: 18, fontSize: 26 }}>
            <span style={{ color: UI.sub }}>To</span>
            <div style={{ display: "flex", alignItems: "center", gap: 12, padding: "6px 18px 6px 6px", borderRadius: 30, border: `2px solid ${UI.line}` }}>
              <Avatar letter="M" color="#c65a43" size={40} />
              <span style={{ fontSize: 25 }}>Maya Chen</span>
            </div>
          </div>
          <div style={{ margin: "0 32px", height: 76, borderBottom: `2px solid ${UI.line}`, display: "flex", alignItems: "center", fontSize: 26 }}>
            The new direction
          </div>
          <div style={{ padding: "30px 32px", fontSize: 32, lineHeight: 1.55, whiteSpace: "pre-wrap", width: WIN.w - 64 }}>
            {text}
            <span
              style={{
                display: "inline-block",
                width: 3,
                height: 38,
                marginLeft: 2,
                verticalAlign: "-6px",
                background: UI.text,
                opacity: caretOn ? 1 : 0,
              }}
            />
          </div>
          {/* toolbar: PigeonBox's tracking pill sits right before Send (compose-tracking.ts) */}
          <div
            style={{
              position: "absolute",
              left: PILL.x - WIN.x,
              top: PILL.y - WIN.y,
              height: PILL.h,
              padding: "0 22px",
              borderRadius: 999,
              background: "rgba(221,167,122,0.16)",
              color: "#78421e",
              font: `600 24px/${PILL.h}px ${sans}`,
              boxShadow: `0 0 0 ${pillGlow * 10}px rgba(221,167,122,${pillGlow * 0.3})`,
            }}
          >
            Tracking ready
          </div>
          <div
            style={{
              position: "absolute",
              left: SEND.x - WIN.x,
              top: SEND.y - WIN.y,
              width: SEND.w,
              height: SEND.h,
              borderRadius: 36,
              background: press > 0 ? "#0842a0" : UI.blue,
              color: "#fff",
              display: "flex",
              alignItems: "center",
              justifyContent: "center",
              fontSize: 26,
              fontWeight: 600,
              scale: `${1 - press * 0.05}`,
            }}
          >
            Send
          </div>
          <div style={{ position: "absolute", left: SEND.x + SEND.w + 40 - WIN.x, top: SEND.y + 20 - WIN.y, display: "flex", gap: 34, color: UI.sub, fontSize: 28, fontWeight: 600 }}>
            <span style={{ textDecoration: "underline" }}>A</span>
            <span>⌁</span>
            <span>☺</span>
            <span>▢</span>
            <span>⋮</span>
          </div>
        </div>

        {f >= 190 && f < sent + 10 ? <Cursor x={cx} y={cy} press={press} hand={f > click - 12} /> : null}

        {envT > 0 && envT < 1 ? (
          <Envelope x={1500 + envT * 500} y={300 - envT * 700} scale={9} rotate={-12 + envT * 20} glow={1} />
        ) : null}

        {/* "Message sent" toast */}
        <div
          style={{
            position: "absolute",
            left: 420,
            top: 960,
            padding: "22px 34px",
            borderRadius: 10,
            background: "#303030",
            color: "#f2f2f2",
            fontFamily: sans,
            fontSize: 26,
            display: "flex",
            gap: 40,
            opacity: ci(f, [sent + 6, sent + 12], [0, 1], ease.out),
            translate: `0px ${ci(f, [sent + 6, sent + 14], [20, 0], ease.out)}px`,
          }}
        >
          Message sent
          <span style={{ color: "#a8c7fa", fontWeight: 600 }}>Undo</span>
          <span style={{ color: "#a8c7fa", fontWeight: 600 }}>View message</span>
        </div>
      </AbsoluteFill>
      {/* screen glass: soft reflection and falloff */}
      <AbsoluteFill style={{ background: "linear-gradient(120deg, rgba(255,240,220,0.10), rgba(255,255,255,0) 40%)", pointerEvents: "none" }} />
      <FilmFinish vignette={0.5} grain={0.06} warmth={0.1} />
    </AbsoluteFill>
  );
};
