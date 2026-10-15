import React from "react";
import { useCurrentFrame } from "remotion";
import { CameraRig, Key, track, trail } from "../Camera";
import { Kicker, Slam } from "../type";
import { b, ci, ease, K, PB } from "../tokens";
import { typed } from "../ui/bits";
import { AskBody, COMPOSE_H, COMPOSE_W, Composer, SENT_H, SENT_W, SentList, THREAD_H, THREAD_W, ThreadView } from "../ui/Panels";
import { Workspace, WS_H, WS_W } from "../ui/Workspace";


/* ------------------------------------------------------------------ */

export const Summary: React.FC = () => {
  const f = useCurrentFrame();
  const word = b(2);
  if (f < word) {
    return (
      <Slam
        f={f}
        bg={K.paper}
        color={K.ink}
        size={210}
        words={[
          { t: "Long", at: 0 },
          { t: "thread?", at: b(0.5) },
          { t: "Three", at: b(1), br: true, italic: true, color: K.copper },
          { t: "lines.", at: b(1.5), italic: true, color: K.copper },
        ]}
      >
        <Kicker n="02" t="SUMMARIES" color={K.ink} f={f} />
      </Slam>
    );
  }
  const g = f - word;
  const dur = b(6);
  const t = g / dur;
  const rv = (a: number) => ci(g, [a, a + 26], [0, 1], ease.linear);
  // Focus follows the card as it writes itself: summary, date, bullets, to-do, button.
  const keys: Key[] = [
    [0, 1190, 205],
    [30, 1190, 215],
    [52, 1160, 300],
    [80, 1190, 380],
    [110, 1190, 465],
    [140, 1210, 540],
    [dur, 1210, 550],
  ];
  const [fx, fy] = track(g, keys);
  const [lx, ly] = trail(g, keys);
  return (
    <CameraRig
      cam={{
        w: THREAD_W,
        h: THREAD_H,
        fx,
        fy,
        tx: 40 - t * 60,
        ty: 0,
        pitch: 30,
        yaw: 8,
        roll: -11 + t * 1.5,
        mag: 2.85 + t * 0.14,
        band: 70,
        rate: 0.035,
        light: { x: lx, y: ly, rx: 420, ry: 320, dim: 0.45, kx: 40, ky: -50 },
      }}
    >
      <ThreadView
        card={{
          label: rv(0),
          summary: rv(8),
          date: rv(42),
          bullets: [rv(62), rv(72)],
          todo: rv(98),
          button: rv(120),
        }}
      />
    </CameraRig>
  );
};

/* ------------------------------------------------------------------ */

const REPLY = "Hi Oliver,\n\nThanks for the heads up! The address is 14 Larkin Street, Studio 3. I’ll be in all morning to sign for it.\n\nCan’t wait to see the copper finish.\n\nBest,\nAda";

export const Draft: React.FC = () => {
  const f = useCurrentFrame();
  const word = b(2);
  const composeEnd = b(7);
  const slamEnd = b(9);
  if (f < word) {
    return (
      <Slam
        f={f}
        bg={K.copper}
        color={K.paper}
        size={220}
        words={[
          { t: "Replies,", at: 0 },
          { t: "in", at: b(1), br: true },
          { t: "your", at: b(1.25), color: K.ink },
          { t: "voice.", at: b(1.5), color: K.ink },
        ]}
      >
        <Kicker n="03" t="DRAFTS" f={f} color={K.paper} />
      </Slam>
    );
  }
  if (f < composeEnd) {
    const g = f - word;
    // The draft streams in word by word, like the model writing it.
    const words = REPLY.split(/(\s+)/);
    const total = words.length;
    const shown = Math.floor(ci(g, [6, composeEnd - word - 20], [0, total], ease.linear));
    const body = words.slice(0, shown).join("");
    const t = g / (composeEnd - word);
    // Visual line of the caret, wrapping paragraphs at about 66 characters.
    const visualLines = body.split("\n").reduce((n, para) => n + Math.max(1, Math.ceil(para.length / 78)), 0);
    const curLine = Math.max(0, visualLines - 1);
    const lineY = (n: number) => 144 + 32 * Math.min(8, n);
    // Pan with the caret along its line.
    const lastPara = body.split("\n").pop() ?? "";
    const col = lastPara.length % 78;
    const fx = 320 + Math.min(1, col / 78) * 150;
    const fy = lineY(curLine) - 16 + 32 * ci(g, [0, composeEnd - word], [0, 0.5], ease.linear);
    // The light trails the caret's line.
    let ly = 0;
    for (let i = 0; i < 8; i++) {
      const gg = Math.max(0, g - i * 3);
      const sh = Math.floor(ci(gg, [6, composeEnd - word - 20], [0, total], ease.linear));
      const bb = words.slice(0, sh).join("");
      const vl = bb.split("\n").reduce((n, para) => n + Math.max(1, Math.ceil(para.length / 78)), 0);
      ly += lineY(Math.max(0, vl - 1)) / 8;
    }
    return (
      <CameraRig
        cam={{
          w: COMPOSE_W,
          h: COMPOSE_H,
          fx,
          fy,
          tx: -20,
          ty: 20,
          pitch: 30,
          yaw: -9,
          roll: 11,
          mag: 2.7 + t * 0.12,
          band: 60,
          rate: 0.035,
          light: { x: fx, y: ly, rx: 520, ry: 300, dim: 0.45, kx: -50, ky: -40 },
        }}
      >
        <Composer body={body} caret frame={f} />
      </CameraRig>
    );
  }
  if (f < slamEnd) {
    const g = f - composeEnd;
    return (
      <Slam
        f={g}
        bg={K.ink}
        color={K.inkText}
        size={230}
        words={[
          { t: "You", at: 0 },
          { t: "press", at: b(0.5) },
          { t: "Send.", at: b(1), italic: true, color: K.copperBright },
        ]}
        label={{ t: "NOTHING SENDS WITHOUT YOU", at: b(1.25) }}
      />
    );
  }
  // Extreme macro on the real Send button, beside "Tracking ready".
  const g = f - slamEnd;
  const press = ci(g, [8, 13], [0, 1], ease.out) * (1 - ci(g, [13, 24], [0, 1], ease.out));
  return (
    <CameraRig
      cam={{
        w: COMPOSE_W,
        h: COMPOSE_H,
        fx: 250 + g * 0.6,
        fy: 598,
        tx: 0,
        ty: 20,
        pitch: 44,
        yaw: 8,
        roll: -16,
        mag: 4.6 + g * 0.01,
        band: 22,
        rate: 0.07,
        light: { x: 240, y: 598, rx: 240, ry: 150, dim: 0.8, kx: 30, ky: -30 },
      }}
    >
      <Composer body={REPLY} frame={f} sendPress={press} sent={g > 13 ? 1 : 0} />
    </CameraRig>
  );
};

/* ------------------------------------------------------------------ */

const QUESTION = "What did I promise Maya before Friday?";

export const Ask: React.FC = () => {
  const f = useCurrentFrame();
  const word = b(2);
  if (f < word) {
    return (
      <Slam
        f={f}
        bg={K.paper}
        color={K.ink}
        size={230}
        words={[
          { t: "Ask", at: 0 },
          { t: "your", at: b(0.5) },
          { t: "inbox.", at: b(1), italic: true, color: K.copper, br: true },
        ]}
      >
        <Kicker n="04" t="ASK" color={K.ink} f={f} />
      </Slam>
    );
  }
  const g = f - word;
  const typeEnd = 6 + Math.ceil((QUESTION.length / 24) * 60);
  const q = typed(QUESTION, g, 6, 24);
  const sendAt = typeEnd + 8;
  const asked = ci(g, [sendAt, sendAt + 18], [0, 1], ease.out);
  const steps = ci(g, [sendAt + 12, sendAt + 70], [0, 4], ease.linear);
  const settled = ci(g, [sendAt + 76, sendAt + 80], [0, 1], ease.linear);
  const answer = ci(g, [sendAt + 80, sendAt + 120], [0, 1], ease.linear);
  const sources = ci(g, [sendAt + 108, sendAt + 135], [0, 1], ease.linear);
  const dur = b(8);
  const t = g / dur;
  // Composer first, then rack up to the question, follow the trace down, land on the answer.
  const keys: Key[] = [
    [0, 230, 812],
    [sendAt, 230, 812],
    [sendAt + 22, 200, 250],
    [sendAt + 72, 210, 385],
    [sendAt + 95, 230, 470],
    [sendAt + 130, 230, 545],
    [dur, 230, 555],
  ];
  const [fx, fy] = track(g, keys);
  const [lx, ly] = trail(g, keys);
  return (
    <CameraRig
      cam={{
        w: WS_W,
        h: WS_H + 200,
        fx,
        fy,
        tx: 60 - t * 50,
        ty: 0,
        pitch: 31,
        yaw: -8,
        roll: 13 - t * 2,
        mag: 3.0 + t * 0.14,
        band: 70,
        rate: 0.035,
        light: { x: lx, y: ly, rx: 380, ry: 300, dim: 0.45, kx: -30, ky: -40 },
      }}
    >
      <div style={{ width: WS_W, height: WS_H + 200 }}>
        <Workspace
          tab="Ask"
          pose="idle"
          body={<AskBody frame={f} s={{ question: asked > 0 ? "" : q, caret: asked === 0, asked, steps, settled, answer, sources }} />}
        />
      </div>
    </CameraRig>
  );
};

/* ------------------------------------------------------------------ */

export const Tracking: React.FC = () => {
  const f = useCurrentFrame();
  const word = b(2);
  if (f < word) {
    return (
      <Slam
        f={f}
        bg={K.copper}
        color={K.paper}
        size={210}
        words={[
          { t: "Know", at: 0 },
          { t: "when", at: b(0.5) },
          { t: "it", at: b(1), br: true },
          { t: "lands.", at: b(1.25), color: K.ink },
        ]}
      >
        <Kicker n="05" t="TRACKING" f={f} color={K.paper} />
      </Slam>
    );
  }
  const g = f - word;
  const opened = ci(g, [20, 34], [0, 1], ease.out);
  const toast = ci(g, [44, 66], [0, 1], ease.linear);
  const notify = ci(g, [118, 128], [0, 1], ease.inOut);
  const dur = b(6);
  const t = g / dur;
  const keys: Key[] = [
    [0, 1060, 103],
    [40, 1080, 105],
    [72, 900, 215],
    [112, 890, 290],
    [140, 860, 345],
    [dur, 860, 350],
  ];
  const [fx, fy] = track(g, keys);
  const [lx, ly] = trail(g, keys);
  return (
    <CameraRig
      cam={{
        w: SENT_W,
        h: SENT_H,
        fx,
        fy,
        tx: -20 - t * 50,
        ty: 0,
        pitch: 30,
        yaw: 7,
        roll: -10 + t * 1.5,
        mag: 2.75 + t * 0.14,
        band: 70,
        rate: 0.035,
        light: { x: lx, y: ly, rx: 480, ry: 340, dim: 0.45, kx: 40, ky: -50 },
      }}
    >
      <SentList opened={opened} toast={toast} notify={notify} frame={f} />
    </CameraRig>
  );
};

export { PB };
