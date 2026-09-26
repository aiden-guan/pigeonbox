import React from "react";
import { AbsoluteFill, Img, staticFile, useCurrentFrame } from "remotion";
import { Avatar, Chip, Cursor, Row, SearchBar, Sidebar, TrackCard, TrackMark, UI } from "../components/Mail";
import { Art, Cell, FilmFinish } from "../components/Pixel";
import { Sender, SenderPose } from "../components/Sender";
import { LightShafts } from "../components/World";
import { ci, ease, M, shotStart } from "../lib";
import { sans } from "../theme";
import whistle from "../whistle.json";

/*
 * Cutaways to the sender while the pigeon fights its way across town.
 * Same room, same screen, same light as the opening — calm, unaware of the chaos,
 * getting on with his morning in PigeonBox: whistling, a slow sip of coffee, a big yawn.
 * Product surfaces are real captures from apps/extension's preview fixture (scripts/capture-product.mjs).
 */

/** Sound cues, in each cutaway's local frames (LaunchFilm places the sound effects on them). */
export const DESK_CUES = {
  sort: { click: 178 },
  thread: { slurp: 13, clink: 35, sigh: 39, click: 88 },
  ask: { pick: 22, ask: 38 },
  wait: { open: 14, toggle: 40, creak: 62, yawn: 65 },
};

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
const OutsideWindow: React.FC<{
  push: [number, number];
  pose?: SenderPose;
  dy?: number;
  /** extra scale around his face, for a closer framing */
  zoom?: number;
  children?: React.ReactNode;
}> = ({ push, pose = "neutral", dy = 0, zoom = 0, children }) => {
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
        scale: `${1.02 + zoom + ci(f, [0, push[0]], [0, 0.05], ease.soft) + p * 2.2}`,
        transformOrigin: `${glow[0]}px ${glow[1]}px`,
        opacity: 1 - ci(f, [push[1] - 4, push[1]], [0, 1], ease.linear),
      }}
    >
      <Art name="s3_facade" scale={S} />
      <Sender S={S} pose={pose} dy={dy} />
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
      <div style={{ position: "absolute", left: 199 * S - 30, top: ledgeY - 12, rotate: `${-8 + Math.sin(f / 14) * 3}deg` }}>
        <div style={{ position: "absolute", left: 0, top: 6, width: 54, height: 12, background: "#9899a3" }} />
        <div style={{ position: "absolute", left: 6, top: 0, width: 36, height: 6, background: "#b4b5bd" }} />
        <div style={{ position: "absolute", left: 42, top: 8, width: 24, height: 4, background: "#6b6c80" }} />
      </div>
      <LightShafts x={1500} y={-200} angle={40} opacity={0.16} spread={1.6} />
      {children}
    </AbsoluteFill>
  );
};

/** Music notes drifting up out of his pucker, one per `spawns` frame. (x, y) is his mouth in screen px. */
const WhistleNotes: React.FC<{ spawns: number[]; x: number; y: number; S: number }> = ({ spawns, x, y, S }) => {
  const f = useCurrentFrame();
  const n = M.notes;
  return (
    <>
      {spawns.map((s0, i) => {
        const t = f - s0;
        if (t < 0 || t > 60) return null;
        const dir = i % 2 ? -0.7 : 1;
        return (
          <Cell
            key={s0}
            file="art/notes.png"
            sheetW={n.w}
            sheetH={n.h}
            cw={n.cw}
            ch={n.ch}
            col={i % 2}
            row={0}
            scale={S}
            style={{
              left: x + 30 + dir * t * 2.4 + Math.sin(t / 7 + i) * 16 - (n.cw * S) / 2,
              top: y - 40 - t * 4 - n.ch * S,
              opacity: ci(t, [0, 3, 42, 60], [0, 1, 1, 0], ease.linear),
              scale: `${ci(t, [0, 7], [0.3, 1], ease.out)}`,
              rotate: `${Math.sin(t / 9 + i * 2) * 14}deg`,
            }}
          />
        );
      })}
    </>
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
/** Whistled notes (scripts/gen_audio.py writes whistle.json): [absolute frame, midi, length in frames]. */
const WHISTLE = whistle.notes.map(([f0, m, d]) => [f0 - shotStart("deskSort"), m, d]);
/** One note sprite per whistled note, plus a second on the long ones. */
const WHISTLE_SPAWNS = WHISTLE.flatMap(([f0, , d]) => (d >= 36 ? [f0, f0 + 18] : [f0]));

/** He's whistling to himself. Then he opens his inbox: PigeonBox has sorted it. The split inbox slides in; he picks Oliver's thread. */
export const DeskSort: React.FC = () => {
  const f = useCurrentFrame();
  const at = 84;
  const panelIn = [114, 134];
  const click = DESK_CUES.sort.click;
  // whistling: pucker on every note, eyes shut on the long ones, nodding along on the beat
  const S = 6;
  const a = M.s3_facade.anchors;
  const note = WHISTLE.find(([f0, , d]) => f >= f0 && f < f0 + d);
  const pose: SenderPose = !note ? "neutral" : note[2] >= 36 ? "whistle_bliss" : "whistle";
  const dy = f < WHISTLE[0][0] ? 0 : Math.floor((f - WHISTLE[0][0]) / 12) % 2;
  const mouth = [(a.window[0] + a.face[0]) * S, (a.window[1] + a.face[1] + 7 + dy) * S];
  // camera: land on the chips, read down the sorted list, rise to the panel header, settle on its threads
  const s = ci(f, [at, 104, 116, 136, 150, 192], [1.55, 1.5, 1.42, 1.5, 1.55, 1.5], ease.inOut);
  const fx = ci(f, [at, 104, 116, 136, 150], [860, 900, 1000, 1540, 1540], ease.inOut);
  const fy = ci(f, [at, 104, 116, 136, 150, 192], [380, 420, 560, 300, 330, 620], ease.inOut);
  // Oliver's row in the side panel capture (752x1120 → 690x1028 at right: 16, top: 24)
  const oliver = [1920 - 16 - 690 + 0.42 * 690, 24 + 830 * (1028 / 1120)];
  const cx = ci(f, [150, click - 2], [1860, oliver[0]], ease.out);
  const cy = ci(f, [150, 164, click - 2], [980, oliver[1] - 190, oliver[1]], ease.inOut);
  const press = ci(f, [click, click + 3, click + 7], [0, 1, 0], ease.linear);
  const hover = ci(f, [click - 12, click - 4], [0, 1], ease.out);
  return (
    <AbsoluteFill style={{ background: "#1c1a18", overflow: "hidden" }}>
      <OutsideWindow push={[62, at]} pose={pose} dy={dy}>
        <WhistleNotes spawns={WHISTLE_SPAWNS} x={mouth[0]} y={mouth[1]} S={S} />
      </OutsideWindow>
      <ScreenIn at={at}>
        <ScreenCam fx={fx} fy={fy} s={s}>
          <MailShell active="Inbox" right={24 + ci(f, panelIn, [0, 710], ease.inOut)}>
            <div style={{ height: 80 }} />
            {HIS_INBOX.map((r, i) => (
              <Row key={r.from} {...r} unread={i < 3} afterSubject={<Chip label={r.chip} t={ci(f, [at + 2 + i * 3, at + 8 + i * 3], [0, 1], ease.out)} />} />
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

/** The coffee: reach, lift, a long slurp, set it down, "ahh". */
const sipPose = (f: number): SenderPose => {
  const c = DESK_CUES.thread;
  if (f < 6) return "neutral";
  if (f < 10) return "reach";
  if (f < c.slurp) return "lift";
  if (f < 32) return "sip";
  if (f < c.clink) return "lift";
  if (f < c.clink + 4) return "reach_content";
  return "content";
};

/** A sip of coffee. Then he opens Oliver's thread; the companion untangles it; "Draft reply" writes it for him to review. */
export const DeskThread: React.FC = () => {
  const f = useCurrentFrame();
  const at = 66;
  const click = DESK_CUES.thread.click;
  const draftDone = 122;
  // head tipped back while he drinks; settles a pixel lower after the "ahh"
  const dy = f >= DESK_CUES.thread.slurp && f < 32 ? -1 : f >= DESK_CUES.thread.sigh + 3 ? 1 : 0;
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
  const cx = ci(f, [at + 4, click - 2], [1100, btn[0] + 10], ease.out);
  const cy = ci(f, [at + 4, click - 2], [980, btn[1] + 6], ease.out);

  return (
    <AbsoluteFill style={{ background: "#1c1a18", overflow: "hidden" }}>
      <OutsideWindow push={[48, at]} pose={sipPose(f)} dy={dy} zoom={ci(f, [0, 48], [0.5, 0.56], ease.soft)} />
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
          {f > at + 2 && f < click + 24 ? <Cursor x={cx} y={cy} press={press} hand={f > click - 16} /> : null}
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
  const { pick, ask } = DESK_CUES.ask;
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
/** He checks on Maya's email: not opened yet. He asks PigeonBox to tell him if she doesn't reply — then leans back into a huge yawn. */
export const DeskWait: React.FC = () => {
  const f = useCurrentFrame();
  const { open, toggle, creak, yawn } = DESK_CUES.wait;
  const cut = 60;
  const stretchPose: SenderPose = f < creak ? "neutral" : f < yawn + 1 ? "stretch" : f < 88 ? "yawn" : f < 91 ? "stretch" : "content";
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
        <OutsideWindow push={[999, 1000]} pose={stretchPose} dy={f >= creak + 2 && f < 90 ? -1 : 0} zoom={ci(f, [cut, 96], [0.22, 0.34], ease.soft)} />
      )}
      <FilmFinish vignette={f < cut ? 0.5 : 0.6} grain={0.06} warmth={0.1} />
    </AbsoluteFill>
  );
};
