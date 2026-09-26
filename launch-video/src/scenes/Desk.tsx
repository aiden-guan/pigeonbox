import React from "react";
import { AbsoluteFill, Img, staticFile, useCurrentFrame } from "remotion";
import { Avatar, Chip, Cursor, Row, SearchBar, Sidebar, TrackCard, TrackMark, UI } from "../components/Mail";
import { Art, FilmFinish, Puffs } from "../components/Pixel";
import { LightShafts } from "../components/World";
import { ci, ease, M } from "../lib";
import { sans } from "../theme";

/*
 * Cutaways to the sender while the pigeon fights its way across town.
 * Same room, same screen, same light as the opening — calm, unaware of the chaos,
 * getting on with his morning in PigeonBox. Product surfaces are real captures
 * from apps/extension's preview fixture (scripts/capture-product.mjs).
 */

// ------------------------------------------------------------------ framing
/** Screen-space camera: frame (fx, fy) of the 1920x1080 UI at scale s, never past the screen's edges. */
const ScreenCam: React.FC<{ fx: number; fy: number; s: number; children: React.ReactNode; style?: React.CSSProperties }> = ({
  fx,
  fy,
  s,
  children,
  style,
}) => {
  const x = Math.min(Math.max(fx, 960 / s), 1920 - 960 / s);
  const y = Math.min(Math.max(fy, 540 / s), 1080 - 540 / s);
  return (
    <AbsoluteFill style={{ left: 960 - x * s, top: 540 - y * s, width: 1920, height: 1080, scale: `${s}`, transformOrigin: "0 0", ...style }}>
      {children}
    </AbsoluteFill>
  );
};

const Glass: React.FC = () => (
  <AbsoluteFill style={{ background: "linear-gradient(120deg, rgba(255,240,220,0.10), rgba(255,255,255,0) 40%)", pointerEvents: "none" }} />
);

/** The window from outside: him at the laptop, the ledge empty but for one feather. Pushes into the screen. */
const OutsideWindow: React.FC<{ push: [number, number]; look?: number }> = ({ push, look = 0 }) => {
  const f = useCurrentFrame();
  const S = 6;
  const a = M.s3_facade.anchors;
  const [wx, wy] = a.window;
  const glow = [(wx + a.glow[0]) * S, (wy + a.glow[1] + 8) * S];
  const ledgeY = a.ledge_y * S;
  const p = ci(f, [push[0], push[1]], [0, 1], ease.in);
  return (
    <AbsoluteFill
      style={{
        scale: `${1.02 + ci(f, [0, push[0]], [0, 0.05], ease.soft) + p * 2.2}`,
        transformOrigin: `${glow[0]}px ${glow[1]}px`,
        opacity: 1 - ci(f, [push[1] - 4, push[1]], [0, 1], ease.linear),
      }}
    >
      <Art name="s3_facade" scale={S} />
      <div
        style={{
          position: "absolute",
          left: glow[0] - 280,
          top: glow[1] - 300,
          width: 560,
          height: 460,
          background: "radial-gradient(closest-side, rgba(230,240,255,0.5), rgba(230,240,255,0))",
          mixBlendMode: "screen",
        }}
      />
      {/* the feather it left behind */}
      <div style={{ position: "absolute", left: 199 * S - 30, top: ledgeY - 12, rotate: `${-8 + Math.sin(f / 14) * 3 + look * 4}deg` }}>
        <div style={{ position: "absolute", left: 0, top: 6, width: 54, height: 12, background: "#9899a3" }} />
        <div style={{ position: "absolute", left: 6, top: 0, width: 36, height: 6, background: "#b4b5bd" }} />
        <div style={{ position: "absolute", left: 42, top: 8, width: 24, height: 4, background: "#6b6c80" }} />
      </div>
      <LightShafts x={1500} y={-200} angle={40} opacity={0.16} spread={1.6} />
    </AbsoluteFill>
  );
};

/** Over-the-shoulder in the room: him, the laptop, the empty ledge. Pushes into the screen. */
const InTheRoom: React.FC<{ push: [number, number] }> = ({ push }) => {
  const f = useCurrentFrame();
  const S = 3;
  const a = M.s1_room.anchors;
  const [sx, sy, sw, sh] = a.screen;
  const [sx0, sy0] = a.steam;
  const cx = (sx + sw / 2) * S;
  const cy = (sy + sh / 2) * S;
  const p = ci(f, [push[0], push[1]], [0, 1], ease.in);
  return (
    <AbsoluteFill style={{ scale: `${1.05 + p * 3.6}`, transformOrigin: `${cx}px ${cy}px`, opacity: 1 - ci(f, [push[1] - 4, push[1]], [0, 1], ease.linear) }}>
      <Art name="s1_outside" scale={S} x={-10} />
      <Art name="s1_room" scale={S} />
      <div style={{ position: "absolute", left: sx * S, top: sy * S, width: sw * S, height: sh * S, background: "#f7f5f1" }}>
        {[0, 1, 2, 3, 4].map((i) => (
          <div key={i} style={{ position: "absolute", left: 16, top: 20 + i * 38, width: sw * S - 180, height: 10, background: "#e4dfd6" }} />
        ))}
        <div style={{ position: "absolute", right: 0, top: 0, width: 120, height: sh * S, background: "#262620" }} />
      </div>
      <Puffs x={sx0 * S} y={sy0 * S} scale={S} count={7} rise={34} life={80} />
      <Art name="s1_person" scale={S} y={Math.sin(f / 22) * 3} />
      <LightShafts x={1260} y={60} angle={38} opacity={0.2} />
    </AbsoluteFill>
  );
};

/** Screen layer that resolves out of the push-in. */
const ScreenIn: React.FC<{ at: number; children: React.ReactNode }> = ({ at, children }) => {
  const f = useCurrentFrame();
  const t = ci(f, [at - 6, at + 8], [0, 1], ease.out);
  if (t <= 0) return null;
  return <AbsoluteFill style={{ opacity: t, filter: `blur(${(1 - t) * 10}px)`, scale: `${0.94 + t * 0.06}` }}>{children}</AbsoluteFill>;
};

/** Chrome's side panel with PigeonBox docked on the right edge of the browser. */
const SidePanel: React.FC<{ src: string; slide?: number; next?: string; mix?: number }> = ({ src, slide = 1, next, mix = 0 }) => (
  <div
    style={{
      position: "absolute",
      right: 16,
      top: 24,
      width: 690,
      height: 1028,
      borderRadius: 28,
      overflow: "hidden",
      background: "#1b1a17",
      boxShadow: "0 20px 60px rgba(0,0,0,0.25)",
      translate: `${(1 - slide) * 720}px 0px`,
    }}
  >
    <Img src={staticFile(src)} style={{ position: "absolute", width: "100%", height: "100%", objectFit: "cover", objectPosition: "top" }} />
    {next ? (
      <Img src={staticFile(next)} style={{ position: "absolute", width: "100%", height: "100%", objectFit: "cover", objectPosition: "top", opacity: mix }} />
    ) : null}
  </div>
);

const MailShell: React.FC<{ active: "Inbox" | "Sent"; right?: number; children: React.ReactNode; blur?: number }> = ({
  active,
  right = 24,
  children,
  blur = 0,
}) => (
  <AbsoluteFill style={{ background: UI.bg, filter: blur ? `blur(${blur}px)` : undefined }}>
    <Sidebar active={active} />
    <SearchBar />
    <div style={{ position: "absolute", left: 380, top: 136, right, bottom: 0, background: UI.panel, borderRadius: "32px 32px 0 0", overflow: "hidden" }}>
      {children}
    </div>
  </AbsoluteFill>
);

const HIS_INBOX = [
  { from: "Maya Chen", subject: "A few thoughts on the new direction", snippet: "Love where this is going. Two small things before Friday…", time: "9:02 AM", chip: "Respond" },
  { from: "Oliver at Fieldwork", subject: "The samples are on their way", snippet: "Your material samples should arrive tomorrow morning.", time: "8:51 AM", chip: "Respond" },
  { from: "Nina & Alex", subject: "Coffee next week?", snippet: "We’ll be in your neighborhood on Tuesday. Free at 10?", time: "8:40 AM", chip: "Respond" },
  { from: "Jordan Park", subject: "Re: Friday review", snippet: "Works for me — I’ll bring the printed boards.", time: "8:12 AM", chip: "Waiting" },
  { from: "Studio Weekly", subject: "Five small rituals for slower mornings", snippet: "This week: notebooks, window light, and the second coffee.", time: "7:05 AM", chip: "News" },
  { from: "City Library", subject: "Your hold is ready", snippet: "“The Art of Noticing” is waiting for you at the front desk.", time: "Yesterday", chip: "Notifications" },
  { from: "Sam Ortega", subject: "Photos from the weekend", snippet: "A few favorites from the lake.", time: "Yesterday", chip: "FYI" },
  { from: "Paper & Co.", subject: "20% off notebooks this week", snippet: "Stock up on the dotted grid you love.", time: "Sep 24", chip: "Promotions" },
];

// ------------------------------------------------------------------ 1. sorting
/** He opens his inbox: PigeonBox has sorted it. The split inbox slides in; he picks Oliver's thread. */
export const DeskSort: React.FC = () => {
  const f = useCurrentFrame();
  const at = 36;
  const panelIn = [100, 122];
  const click = 180;
  // camera: land on the chips, read down the sorted list, rise to the panel header, settle on its threads
  const s = ci(f, [at, 72, 100, 124, 150, 192], [1.55, 1.5, 1.42, 1.5, 1.55, 1.5], ease.inOut);
  const fx = ci(f, [at, 72, 100, 124, 150], [860, 900, 1000, 1540, 1540], ease.inOut);
  const fy = ci(f, [at, 72, 100, 124, 150, 192], [380, 420, 560, 300, 330, 620], ease.inOut);
  // Oliver's row in the side panel capture (752x1120 → 690x1028 at right: 16, top: 24)
  const oliver = [1920 - 16 - 690 + 0.42 * 690, 24 + 830 * (1028 / 1120)];
  const cx = ci(f, [150, click - 2], [1860, oliver[0]], ease.out);
  const cy = ci(f, [150, 168, click - 2], [980, oliver[1] - 190, oliver[1]], ease.inOut);
  const press = ci(f, [click, click + 3, click + 7], [0, 1, 0], ease.linear);
  const hover = ci(f, [click - 12, click - 4], [0, 1], ease.out);
  return (
    <AbsoluteFill style={{ background: "#1c1a18", overflow: "hidden" }}>
      <OutsideWindow push={[20, at]} />
      <ScreenIn at={at}>
        <ScreenCam fx={fx} fy={fy} s={s}>
          <MailShell active="Inbox" right={24 + ci(f, panelIn, [0, 710], ease.inOut)}>
            <div style={{ height: 80 }} />
            {HIS_INBOX.map((r, i) => (
              <Row key={r.from} {...r} unread={i < 3} afterSubject={<Chip label={r.chip} t={ci(f, [at + 4 + i * 4, at + 10 + i * 4], [0, 1], ease.out)} />} />
            ))}
          </MailShell>
          <SidePanel src="product/sidepanel.png" slide={ci(f, panelIn, [0, 1], ease.out)} />
          {/* hover state on Oliver's thread */}
          <div
            style={{
              position: "absolute",
              left: 1920 - 16 - 690 + 12,
              top: oliver[1] - 64,
              width: 666,
              height: 128,
              borderRadius: 20,
              background: `rgba(255,255,255,${0.05 * hover + 0.05 * press})`,
            }}
          />
          {f > 150 ? <Cursor x={cx} y={cy} press={press} hand={f > click - 14} /> : null}
        </ScreenCam>
        <Glass />
      </ScreenIn>
      <FilmFinish vignette={0.5} grain={0.06} warmth={0.1} />
    </AbsoluteFill>
  );
};

// ------------------------------------------------------------------ 2. thread + draft
const REPLY = "Hi Oliver — thank you! The address is right, and I’ll be at the studio from 9 to sign. Can’t wait to see the copper.";

/** He opens Oliver's thread; the companion untangles it; "Draft reply" writes it for him to review. */
export const DeskThread: React.FC = () => {
  const f = useCurrentFrame();
  const at = 30;
  const click = 76;
  const draftDone = 120;
  const typed = Math.floor(ci(f, [click + 10, draftDone], [0, REPLY.length], ease.linear));
  const press = ci(f, [click, click + 3, click + 7], [0, 1, 0], ease.linear);
  const reply = ci(f, [click + 4, click + 16], [0, 1], ease.out);

  const s = ci(f, [at, click - 6, click + 14, 144], [1.2, 1.32, 1.3, 1.36], ease.inOut);
  const fx = ci(f, [at, click - 6, click + 14, 144], [1250, 1440, 1000, 980], ease.inOut);
  const fy = ci(f, [at, click - 6, click + 14, 144], [520, 700, 700, 760], ease.inOut);
  const cardH = 900;
  const cardW = (752 / 1136) * cardH;
  const cardX = 1920 - cardW - 40;
  const cardY = 150;
  const btn = [cardX + (100 / 596) * cardW, cardY + (848 / 900) * cardH];
  const cx = ci(f, [at + 14, click - 2], [1100, btn[0] + 10], ease.out);
  const cy = ci(f, [at + 14, click - 2], [980, btn[1] + 6], ease.out);

  return (
    <AbsoluteFill style={{ background: "#1c1a18", overflow: "hidden" }}>
      <InTheRoom push={[16, at]} />
      <ScreenIn at={at}>
        <ScreenCam fx={fx} fy={fy} s={s}>
          <MailShell active="Inbox">
            <div style={{ padding: "48px 70px", fontFamily: sans, color: UI.text, width: 1560 - cardW }}>
              <div style={{ fontSize: 42, fontWeight: 500, marginLeft: 96, display: "flex", alignItems: "center", gap: 20 }}>
                The samples are on their way
                <span style={{ fontSize: 20, padding: "4px 12px", borderRadius: 8, background: "#e8eaed", color: UI.sub }}>Inbox</span>
              </div>
              <div style={{ display: "flex", gap: 28, alignItems: "center", marginTop: 40 }}>
                <Avatar letter="O" color="#6f8f86" size={68} />
                <div style={{ fontSize: 25 }}>
                  <b>Oliver at Fieldwork</b>
                  <div style={{ fontSize: 21, color: UI.sub, marginTop: 4 }}>to me</div>
                </div>
              </div>
              <div style={{ marginLeft: 96, marginTop: 34, fontSize: 28, lineHeight: 1.6, maxWidth: 700 }}>
                Hi! Your material samples ship today and should arrive tomorrow morning, around 9. Three swatches, including the copper finish.
                <br />
                <br />
                Could you confirm the delivery address? The courier will need a signature.
                <br />— Oliver
              </div>
              {/* the draft PigeonBox writes into Gmail's reply box (never sent on its own) */}
              <div
                style={{
                  marginLeft: 96,
                  marginTop: 40,
                  maxWidth: 700,
                  minHeight: 190,
                  borderRadius: 20,
                  padding: "24px 30px",
                  boxShadow: "0 2px 10px rgba(0,0,0,0.12), 0 0 0 2px #e3e6ea",
                  fontSize: 28,
                  lineHeight: 1.55,
                  opacity: reply,
                  translate: `0px ${(1 - reply) * 20}px`,
                }}
              >
                <div style={{ fontSize: 21, color: UI.sub, marginBottom: 10 }}>Reply to Oliver at Fieldwork · Draft</div>
                {REPLY.slice(0, typed)}
                {typed < REPLY.length ? <span style={{ display: "inline-block", width: 3, height: 32, background: "#dda77a", verticalAlign: "-5px", marginLeft: 2 }} /> : null}
              </div>
            </div>
          </MailShell>
          {/* the thread companion, docked beside the thread */}
          <div style={{ position: "absolute", left: cardX, top: cardY, width: cardW, height: cardH, borderRadius: 34, overflow: "hidden", boxShadow: "0 30px 80px rgba(20,16,12,0.35)" }}>
            <Img src={staticFile("product/thread.png")} style={{ position: "absolute", width: "100%", height: "100%", objectFit: "cover", objectPosition: "top" }} />
            <Img
              src={staticFile("product/thread-drafting.png")}
              style={{ position: "absolute", width: "100%", height: "100%", objectFit: "cover", objectPosition: "top", opacity: ci(f, [click + 2, click + 6, draftDone, draftDone + 6], [0, 1, 1, 0], ease.linear) }}
            />
            <div style={{ position: "absolute", left: btn[0] - cardX - 70, top: btn[1] - cardY - 26, width: 140, height: 52, borderRadius: 26, background: `rgba(0,0,0,${press * 0.2})` }} />
          </div>
          {f > at + 10 && f < click + 24 ? <Cursor x={cx} y={cy} press={press} hand={f > click - 16} /> : null}
        </ScreenCam>
        <Glass />
      </ScreenIn>
      <FilmFinish vignette={0.5} grain={0.06} warmth={0.1} />
    </AbsoluteFill>
  );
};

// ------------------------------------------------------------------ 3. ask
/** He asks his inbox what needs a reply. */
export const DeskAsk: React.FC = () => {
  const f = useCurrentFrame();
  const pick = 22;
  const ask = 38;
  const answer = 64;
  // side panel coords in UI px: right: 16, top: 24, 690x1028
  const px = 1920 - 16 - 690;
  // targets measured on the 752x1120 captures
  const sugg = [px + (300 / 752) * 690, 24 + (718 / 1120) * 1028];
  const askBtn = [px + (654 / 752) * 690, 24 + (1026 / 1120) * 1028];
  const cx = ci(f, [0, pick - 2, pick + 4, ask - 2], [1300, sugg[0], sugg[0], askBtn[0]], ease.out);
  const cy = ci(f, [0, pick - 2, pick + 4, ask - 2], [700, sugg[1], sugg[1], askBtn[1]], ease.out);
  const press1 = ci(f, [pick, pick + 3, pick + 7], [0, 1, 0], ease.linear);
  const press2 = ci(f, [ask, ask + 3, ask + 7], [0, 1, 0], ease.linear);
  const src = f < pick + 2 ? "product/ask-empty.png" : f < ask + 2 ? "product/ask-typed.png" : "product/ask-loading.png";
  const s = ci(f, [0, 96], [1.4, 1.52], ease.soft);
  return (
    <AbsoluteFill style={{ background: "#1c1a18", overflow: "hidden" }}>
      <ScreenCam fx={ci(f, [0, 96], [1480, 1540], ease.soft)} fy={ci(f, [0, answer, 96], [640, 560, 480], ease.inOut)} s={s}>
        <MailShell active="Inbox" right={734} blur={2}>
          <div style={{ height: 80 }} />
          {HIS_INBOX.map((r, i) => (
            <Row key={r.from} {...r} unread={i < 3} afterSubject={<Chip label={r.chip} t={1} />} />
          ))}
        </MailShell>
        <SidePanel src={src} next="product/ask.png" mix={ci(f, [answer, answer + 8], [0, 1], ease.out)} />
        {f < ask + 12 ? <Cursor x={cx} y={cy} press={Math.max(press1, press2)} hand /> : null}
      </ScreenCam>
      <Glass />
      <AbsoluteFill style={{ background: "#000", opacity: ci(f, [0, 5], [0.6, 0], ease.out) }} />
      <FilmFinish vignette={0.5} grain={0.06} warmth={0.1} />
    </AbsoluteFill>
  );
};

// ------------------------------------------------------------------ 4. waiting
/** He checks on Maya's email: not opened yet. He asks PigeonBox to tell him if she doesn't reply — and glances at the window. */
export const DeskWait: React.FC = () => {
  const f = useCurrentFrame();
  const open = 14;
  const toggle = 40;
  const cut = 60;
  const slotX = 1600;
  const card = ci(f, [open, open + 10], [0, 1], ease.out);
  const notify = ci(f, [toggle, toggle + 6], [0, 1], ease.out);
  const cardLeft = 1920 - 680 - 30;
  const sw = [cardLeft + 32 + 36, 216 + 80 + 20 + 306];
  const cx = ci(f, [0, open - 2, open + 6, toggle - 2], [1300, slotX, slotX, sw[0]], ease.out);
  const cy = ci(f, [0, open - 2, open + 6, toggle - 2], [700, 262, 262, sw[1]], ease.out);
  const press = Math.max(ci(f, [open, open + 3, open + 7], [0, 1, 0], ease.linear), ci(f, [toggle, toggle + 3, toggle + 7], [0, 1, 0], ease.linear));
  const s = ci(f, [0, open, cut], [1.55, 1.5, 1.4], ease.inOut);
  const fx = ci(f, [0, open, cut], [1500, 1520, 1500], ease.inOut);
  const fy = ci(f, [0, open, cut], [300, 420, 470], ease.inOut);

  return (
    <AbsoluteFill style={{ background: "#1c1a18", overflow: "hidden" }}>
      {f < cut ? (
        <>
          <ScreenCam fx={fx} fy={fy} s={s}>
            <MailShell active="Sent">
              <div style={{ height: 80 }} />
              <Row from="To: Maya Chen" subject="The new direction" snippet="Hi Maya, Here's the new direction, with both changes." time="9:37 AM" unread slot={<TrackMark opened={false} />} />
              <Row from="To: Jordan Park" subject="Boards for Friday" snippet="Printed and packed — see you there." time="Yesterday" slot={<TrackMark opened />} />
              <Row from="To: Oliver at Fieldwork" subject="Re: Samples" snippet="Thank you! Tomorrow morning works." time="9:31 AM" slot={<TrackMark opened={false} />} />
              <Row from="To: Nina & Alex" subject="Re: Coffee next week?" snippet="Tuesday at 10 is perfect." time="Sep 24" slot={<TrackMark opened />} />
            </MailShell>
            {card > 0 ? (
              <div style={{ position: "absolute", left: cardLeft, top: 216 + 80 + 20, opacity: card, scale: `${0.94 + card * 0.06}`, transformOrigin: `${slotX - cardLeft}px 0px` }}>
                <TrackCard style={{ position: "relative" }} arrow={false} opened={false} notify={notify} />
                <div style={{ position: "absolute", top: -12, left: slotX - cardLeft - 12, width: 24, height: 24, background: "#282822", rotate: "45deg" }} />
              </div>
            ) : null}
            <Cursor x={cx} y={cy} press={press} hand />
          </ScreenCam>
          <Glass />
        </>
      ) : (
        <OutsideWindow push={[999, 1000]} look={ci(f, [cut, 96], [0, 1], ease.inOut)} />
      )}
      <FilmFinish vignette={f < cut ? 0.5 : 0.6} grain={0.06} warmth={0.1} />
    </AbsoluteFill>
  );
};
