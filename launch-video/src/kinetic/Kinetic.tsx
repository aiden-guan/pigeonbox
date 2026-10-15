import React from "react";
import { AbsoluteFill, Sequence, staticFile } from "remotion";
import { Audio } from "@remotion/media";
import timeline from "./timeline.json";
import { b } from "./tokens";
import { Counter, Question, Strobe, Wall } from "./shots/Hook";
import { HalftoneSort, Wordmark } from "./shots/Reveal";
import { Triage } from "./shots/Triage";
import { Ask, Draft, Summary, Tracking } from "./shots/Features";
import { EndCard, Payoff, Privacy, RapidFire } from "./shots/Finale";

const SHOT: Record<string, React.FC> = {
  counter: Counter,
  strobe: Strobe,
  wall: Wall,
  question: Question,
  sort: HalftoneSort,
  wordmark: Wordmark,
  triage: Triage,
  summary: Summary,
  draft: Draft,
  ask: Ask,
  tracking: Tracking,
  rapid: RapidFire,
  payoff: Payoff,
  privacy: Privacy,
  end: EndCard,
};

export const SHOTS = (() => {
  let at = 0;
  return (timeline.shots as [string, number][]).map(([name, beats]) => {
    const s = { name, from: b(at), dur: b(at + beats) - b(at), C: SHOT[name] };
    at += beats;
    return s;
  });
})();

export const TOTAL = SHOTS.reduce((n, s) => n + s.dur, 0);

export const Kinetic: React.FC<{ audio?: boolean }> = ({ audio = true }) => (
  <AbsoluteFill style={{ background: "#000" }}>
    {SHOTS.map(({ name, from, dur, C }) => (
      <Sequence key={name} from={from} durationInFrames={dur} name={name}>
        <C />
      </Sequence>
    ))}
    {audio ? <Audio src={staticFile("kinetic/sfx.wav")} /> : null}
  </AbsoluteFill>
);
