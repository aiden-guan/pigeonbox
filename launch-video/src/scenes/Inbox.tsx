import React from "react";
import { AbsoluteFill, useCurrentFrame } from "remotion";
import { Avatar, Cursor, INBOX_ROWS, Row, SearchBar, Sidebar, UI } from "../components/Mail";
import { FilmFinish } from "../components/Pixel";
import { at, ci, ease } from "../lib";
import { sans } from "../theme";
import typing from "../typing.json";

const NEW = {
  from: "Jamie Rivera",
  subject: "The new direction",
  snippet: "Hi Maya, Here's the new direction, with both changes. Can't wait to hear what you think.",
  time: "9:41 AM",
  unread: true,
};

/** Maya's screen: the email lands, and she opens it. */
export const Inbox: React.FC = () => {
  const f = useCurrentFrame();
  const arrive = at("inbox", "mailArrives");
  const click = at("inbox", "openClick");

  const slide = ci(f, [arrive, arrive + 14], [0, 1], ease.out);
  const flash = ci(f, [arrive, arrive + 6, arrive + 50], [0, 1, 0.25], ease.soft);
  const press = ci(f, [click, click + 3, click + 7], [0, 1, 0], ease.linear);
  const open = ci(f, [click + 4, click + 18], [0, 1], ease.inOut);

  const s = ci(f, [0, arrive, click, click + 30], [1.3, 1.5, 1.5, 1.32], ease.inOut);
  const fx = ci(f, [0, click, click + 30], [1060, 1000, 1080], ease.inOut);
  const fy = ci(f, [0, click, click + 30], [420, 330, 470], ease.inOut);

  const cx = ci(f, [arrive + 30, click - 4], [1560, 860], ease.out);
  const cy = ci(f, [arrive + 30, click - 4], [900, 262], ease.out);

  return (
    <AbsoluteFill style={{ background: "#1c1a18", overflow: "hidden" }}>
      <AbsoluteFill style={{ left: 960 - fx * s, top: 540 - fy * s, width: 1920, height: 1080, scale: `${s}`, transformOrigin: "0 0" }}>
        <AbsoluteFill style={{ background: UI.bg }}>
          <Sidebar active="Inbox" inboxCount={f >= arrive ? 5 : 4} />
          <SearchBar />
          <div style={{ position: "absolute", left: 380, top: 136, right: 24, bottom: 0, background: UI.panel, borderRadius: "32px 32px 0 0", overflow: "hidden" }}>
            {/* list view */}
            <div style={{ position: "absolute", inset: 0, opacity: 1 - open, translate: `${-open * 60}px 0px` }}>
              <div style={{ height: 80, display: "flex", alignItems: "center", paddingLeft: 30, gap: 40, color: UI.sub, fontFamily: sans, fontSize: 24 }}>
                <span style={{ color: UI.blue, fontWeight: 600, borderBottom: `4px solid ${UI.blue}`, paddingBottom: 18, marginTop: 22 }}>Primary</span>
                <span style={{ marginTop: 4 }}>Promotions</span>
                <span style={{ marginTop: 4 }}>Social</span>
              </div>
              <div style={{ position: "relative", height: 80 * slide, overflow: "hidden" }}>
                <Row
                  {...NEW}
                  highlight={press}
                  style={{ position: "absolute", left: 0, right: 0, bottom: 0, background: `rgba(255,244,214,${flash * 0.9})` }}
                />
              </div>
              {INBOX_ROWS.map((r) => (
                <Row key={r.from} {...r} />
              ))}
            </div>
            {/* reading view */}
            <div style={{ position: "absolute", inset: 0, padding: "56px 80px", fontFamily: sans, color: UI.text, opacity: open, translate: `${(1 - open) * 60}px 0px` }}>
              <div style={{ fontSize: 44, fontWeight: 500, marginBottom: 44, marginLeft: 96 }}>The new direction</div>
              <div style={{ display: "flex", gap: 32, alignItems: "center" }}>
                <Avatar letter="J" color="#2f6a63" size={72} />
                <div>
                  <div style={{ fontSize: 26 }}>
                    <b>Jamie Rivera</b> <span style={{ color: UI.sub, fontSize: 22 }}>&lt;jamie@fieldwork.studio&gt;</span>
                  </div>
                  <div style={{ fontSize: 22, color: UI.sub, marginTop: 6 }}>to me</div>
                </div>
                <div style={{ flex: 1 }} />
                <div style={{ fontSize: 22, color: UI.sub }}>9:41 AM (0 minutes ago)</div>
              </div>
              <div style={{ marginLeft: 104, marginTop: 44, fontSize: 30, lineHeight: 1.6, whiteSpace: "pre-wrap", maxWidth: 1100 }}>{typing.text}</div>
            </div>
          </div>
        </AbsoluteFill>
        {f > arrive + 26 && f < click + 14 ? <Cursor x={cx} y={cy} press={press} hand={f > click - 16} /> : null}
      </AbsoluteFill>
      <AbsoluteFill style={{ background: "linear-gradient(120deg, rgba(255,240,220,0.10), rgba(255,255,255,0) 40%)" }} />
      <FilmFinish vignette={0.5} grain={0.06} warmth={0.1} />
    </AbsoluteFill>
  );
};
