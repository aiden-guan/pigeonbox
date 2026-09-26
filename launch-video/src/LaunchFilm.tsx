import React from "react";
import { Audio } from "@remotion/media";
import { AbsoluteFill, interpolate, Sequence, Series, staticFile } from "remotion";
import { T } from "./lib";
import { Airplane } from "./scenes/Airplane";
import { Compose } from "./scenes/Compose";
import { Descent } from "./scenes/Descent";
import { EndCard } from "./scenes/EndCard";
import { DeskAsk, DeskSort, DeskThread, DeskWait } from "./scenes/Desk";
import { HawkChase } from "./scenes/Hawk";
import { High } from "./scenes/High";
import { Homecoming } from "./scenes/Homecoming";
import { Inbox } from "./scenes/Inbox";
import { Ledge } from "./scenes/Ledge";
import { Payoff } from "./scenes/Payoff";
import { Arrival, Seen } from "./scenes/Recipient";
import { Room } from "./scenes/Room";
import { Rooftops } from "./scenes/Rooftops";
import { Storm } from "./scenes/Storm";
import { Street } from "./scenes/Street";

const E = T.events;
const SH = T.shots;
const sfx = (name: string) => staticFile(`audio/${name}.wav`);
const clamp = { extrapolateLeft: "clamp", extrapolateRight: "clamp" } as const;

/**
 * Slow → fast → slow. 90 BPM for the sender, 150 BPM for the chase across town,
 * intercut with calm cutaways to the sender at his desk (the chase heard muffled, far away),
 * then 90 BPM again for the recipient and the ending.
 * Every cut sits on a bar line of src/timeline.json.
 */
export const LaunchFilm: React.FC = () => {
  return (
    <AbsoluteFill style={{ background: "#000" }}>
      <Series>
        <Series.Sequence name="Room" durationInFrames={200}>
          <Room />
        </Series.Sequence>
        <Series.Sequence name="Compose" durationInFrames={240}>
          <Compose />
        </Series.Sequence>
        <Series.Sequence name="Ledge" durationInFrames={168}>
          <Ledge />
        </Series.Sequence>
        <Series.Sequence name="Rooftops" durationInFrames={96}>
          <Rooftops />
        </Series.Sequence>
        <Series.Sequence name="Desk: sorted" durationInFrames={192}>
          <DeskSort />
        </Series.Sequence>
        <Series.Sequence name="Street" durationInFrames={144}>
          <Street />
        </Series.Sequence>
        <Series.Sequence name="Desk: thread + draft" durationInFrames={144}>
          <DeskThread />
        </Series.Sequence>
        <Series.Sequence name="Airliner" durationInFrames={192}>
          <Airplane />
        </Series.Sequence>
        <Series.Sequence name="Desk: ask" durationInFrames={96}>
          <DeskAsk />
        </Series.Sequence>
        <Series.Sequence name="Hawk" durationInFrames={192}>
          <HawkChase />
        </Series.Sequence>
        <Series.Sequence name="Desk: waiting" durationInFrames={96}>
          <DeskWait />
        </Series.Sequence>
        <Series.Sequence name="Storm" durationInFrames={192}>
          <Storm />
        </Series.Sequence>
        <Series.Sequence name="Breakthrough" durationInFrames={144}>
          <High />
        </Series.Sequence>
        <Series.Sequence name="Descent" durationInFrames={160}>
          <Descent />
        </Series.Sequence>
        <Series.Sequence name="Arrival" durationInFrames={160}>
          <Arrival />
        </Series.Sequence>
        <Series.Sequence name="Inbox" durationInFrames={140}>
          <Inbox />
        </Series.Sequence>
        <Series.Sequence name="Seen" durationInFrames={120}>
          <Seen />
        </Series.Sequence>
        <Series.Sequence name="Payoff" durationInFrames={220}>
          <Payoff />
        </Series.Sequence>
        <Series.Sequence name="Homecoming" durationInFrames={160}>
          <Homecoming />
        </Series.Sequence>
        <Series.Sequence name="End card" durationInFrames={240}>
          <EndCard />
        </Series.Sequence>
      </Series>

      {/* ---- score: original, synthesized to the tempo map (scripts/gen_audio.py) */}
      <Audio name="Score" src={sfx("score")} volume={0.78} />

      {/* ---- ambience beds */}
      <Sequence name="Amb: morning" durationInFrames={608}>
        <Audio src={sfx("amb_morning")} volume={(f) => interpolate(f, [0, 40, 590, 608], [0, 0.55, 0.55, 0], clamp)} />
      </Sequence>
      {T.calm.map(([f0, f1]) => (
        <Sequence key={f0} name={`Amb: desk ${f0}`} from={f0} durationInFrames={f1 - f0}>
          <Audio src={sfx("amb_morning")} trimBefore={f0 % 300} volume={(f) => interpolate(f, [0, 4, f1 - f0 - 10, f1 - f0], [0, 0.5, 0.5, 0], clamp)} />
        </Sequence>
      ))}
      <Sequence name="Amb: street" from={SH.street[0]} durationInFrames={150}>
        <Audio src={sfx("amb_city")} volume={0.6} />
      </Sequence>
      <Sequence name="Amb: park" from={SH.hawk[0]} durationInFrames={192}>
        <Audio src={sfx("amb_park")} volume={0.5} />
      </Sequence>
      <Sequence name="Amb: storm" from={SH.storm[0]} durationInFrames={200}>
        <Audio src={sfx("storm_bed")} volume={(f) => interpolate(f, [0, 4, 170, 200], [0, 0.75, 0.75, 0], clamp)} />
      </Sequence>
      <Sequence name="Amb: high wind" from={SH.high[0]} durationInFrames={160}>
        <Audio src={sfx("wind")} volume={0.45} />
      </Sequence>
      <Sequence name="Amb: residential" from={SH.descent[0]} durationInFrames={350}>
        <Audio src={sfx("amb_residential")} volume={0.45} />
      </Sequence>
      <Sequence name="Amb: homecoming" from={SH.homecoming[0]} durationInFrames={170}>
        <Audio src={sfx("amb_morning")} volume={(f) => interpolate(f, [0, 20, 130, 170], [0, 0.45, 0.45, 0], clamp)} />
      </Sequence>

      <Sequence name="Amb: rooftop at sunset" from={SH.endcard[0]} durationInFrames={SH.endcard[1] - SH.endcard[0]}>
        <Audio src={sfx("wind")} volume={(f) => interpolate(f, [0, 30, 190, 240], [0, 0.22, 0.22, 0], clamp)} />
      </Sequence>

      {/* ---- the sender */}
      <Sequence name="Typing" from={200} durationInFrames={220}>
        <Audio src={sfx("typing")} volume={0.7} />
      </Sequence>
      <Sequence name="Click: send" from={E.sendClick} durationInFrames={20}>
        <Audio src={sfx("click")} volume={0.7} />
      </Sequence>
      <Sequence name="Whoosh: sent" from={E.sent} durationInFrames={30}>
        <Audio src={sfx("whoosh")} volume={0.35} />
      </Sequence>
      <Sequence name="Sparkle: email out" from={E.envelopeOut} durationInFrames={90}>
        <Audio src={sfx("sparkle")} volume={0.55} />
      </Sequence>
      <Sequence name="Takeoff" from={E.takeoff - 4} durationInFrames={70}>
        <Audio src={sfx("takeoff")} volume={0.5} />
      </Sequence>
      <Sequence name="Wing beats" from={E.takeoff} durationInFrames={E.landing - E.takeoff + 10}>
        <Audio src={sfx("flight_flaps")} volume={0.3} />
      </Sequence>
      <Sequence name="Whoosh: whip pan" from={586} durationInFrames={50}>
        <Audio src={sfx("whoosh_long")} volume={0.45} />
      </Sequence>

      {/* ---- at the desk: quiet clicks, nothing electronic */}
      <Sequence name="Desk: open Oliver" from={SH.deskSort[0] + 180} durationInFrames={20}>
        <Audio src={sfx("click")} volume={0.5} />
      </Sequence>
      <Sequence name="Desk: draft reply" from={SH.deskThread[0] + 76} durationInFrames={20}>
        <Audio src={sfx("click")} volume={0.55} />
      </Sequence>
      <Sequence name="Desk: pick question" from={SH.deskAsk[0] + 22} durationInFrames={20}>
        <Audio src={sfx("click")} volume={0.5} />
      </Sequence>
      <Sequence name="Desk: ask" from={SH.deskAsk[0] + 38} durationInFrames={20}>
        <Audio src={sfx("click")} volume={0.55} />
      </Sequence>
      <Sequence name="Desk: open status" from={SH.deskWait[0] + 14} durationInFrames={20}>
        <Audio src={sfx("click")} volume={0.5} />
      </Sequence>
      <Sequence name="Desk: notify toggle" from={SH.deskWait[0] + 40} durationInFrames={20}>
        <Audio src={sfx("click")} volume={0.45} />
      </Sequence>

      {/* ---- the chase: slam back in on every return, and each hazard */}
      {T.calm.map(([, f1]) => (
        <Sequence key={f1} name={`Slam ${f1}`} from={f1 - 8} durationInFrames={24}>
          <Audio src={sfx("whoosh_short")} volume={0.5} />
        </Sequence>
      ))}
      <Sequence name="Airliner" from={E.jetPass - 60} durationInFrames={150}>
        <Audio src={sfx("jet")} volume={0.5} />
      </Sequence>
      <Sequence name="Hawk: screech" from={E.hawkStrike - 18} durationInFrames={40}>
        <Audio src={sfx("screech")} volume={0.5} />
      </Sequence>
      <Sequence name="Hawk: screech 2" from={E.hawkSecond - 14} durationInFrames={40}>
        <Audio src={sfx("screech")} volume={0.4} />
      </Sequence>
      <Sequence name="Hawk: stoop" from={E.hawkStrike - 8} durationInFrames={30}>
        <Audio src={sfx("whoosh")} volume={0.5} />
      </Sequence>
      <Sequence name="Thunder 1" from={E.lightning1} durationInFrames={135}>
        <Audio src={sfx("thunder1")} volume={0.42} />
      </Sequence>
      <Sequence name="Thunder 2" from={E.lightning2} durationInFrames={135}>
        <Audio src={sfx("thunder2")} volume={0.42} />
      </Sequence>
      <Sequence name="Thunder 3" from={E.lightning3} durationInFrames={135}>
        <Audio src={sfx("thunder3")} volume={0.5} />
      </Sequence>
      <Sequence name="Whoosh: breakthrough" from={E.breakthrough - 12} durationInFrames={50}>
        <Audio src={sfx("whoosh_long")} volume={0.5} />
      </Sequence>
      <Sequence name="Whoosh: descent" from={SH.descent[0] - 6} durationInFrames={30}>
        <Audio src={sfx("whoosh")} volume={0.3} />
      </Sequence>

      {/* ---- the recipient */}
      <Sequence name="Coo" from={E.coo} durationInFrames={80}>
        <Audio src={sfx("coo")} volume={0.75} />
      </Sequence>
      <Sequence name="Sparkle: delivery" from={E.landing + 44} durationInFrames={90}>
        <Audio src={sfx("sparkle")} volume={0.4} />
      </Sequence>
      <Sequence name="Chime: new mail" from={E.mailArrives} durationInFrames={70}>
        <Audio src={sfx("chime")} volume={0.55} />
      </Sequence>
      <Sequence name="Click: open" from={E.openClick} durationInFrames={20}>
        <Audio src={sfx("click")} volume={0.6} />
      </Sequence>
      <Sequence name="Glint: seen" from={E.opened + 16} durationInFrames={50}>
        <Audio src={sfx("glint")} volume={0.6} />
      </Sequence>
      <Sequence name="Pop: opened mark" from={E.rowOpened} durationInFrames={20}>
        <Audio src={sfx("pop")} volume={0.35} />
      </Sequence>
      <Sequence name="Pop: card" from={E.cardPop} durationInFrames={20}>
        <Audio src={sfx("pop")} volume={0.5} />
      </Sequence>

      {/* ---- home again */}
      <Sequence name="Wings: homecoming" from={E.homeLanding - 16} durationInFrames={70}>
        <Audio src={sfx("takeoff")} volume={0.3} />
      </Sequence>
      <Sequence name="Coo: home" from={E.homeLanding + 16} durationInFrames={80}>
        <Audio src={sfx("coo")} volume={0.55} />
      </Sequence>
    </AbsoluteFill>
  );
};
