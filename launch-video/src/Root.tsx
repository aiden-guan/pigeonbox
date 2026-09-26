import "./index.css";
import React from "react";
import { Composition, Folder } from "remotion";
import { LaunchFilm } from "./LaunchFilm";
import { Airplane } from "./scenes/Airplane";
import { Compose } from "./scenes/Compose";
import { DeskAsk, DeskSort, DeskThread, DeskWait } from "./scenes/Desk";
import { HawkChase } from "./scenes/Hawk";
import { Homecoming } from "./scenes/Homecoming";
import { Storm } from "./scenes/Storm";
import { Descent } from "./scenes/Descent";
import { EndCard } from "./scenes/EndCard";
import { High } from "./scenes/High";
import { Inbox } from "./scenes/Inbox";
import { Ledge } from "./scenes/Ledge";
import { Payoff } from "./scenes/Payoff";
import { Arrival, Seen } from "./scenes/Recipient";
import { Room } from "./scenes/Room";
import { Rooftops } from "./scenes/Rooftops";
import { Street } from "./scenes/Street";
import { T } from "./lib";

const V = { width: 1920, height: 1080, fps: T.fps };
const len = (s: keyof typeof T.shots) => T.shots[s][1] - T.shots[s][0];

export const RemotionRoot: React.FC = () => {
  return (
    <>
      <Composition id="PigeonBoxLaunch" component={LaunchFilm} durationInFrames={T.total} {...V} />
      <Folder name="Scenes">
        <Composition id="Room" component={Room} durationInFrames={len("room")} {...V} />
        <Composition id="Compose" component={Compose} durationInFrames={len("compose")} {...V} />
        <Composition id="Ledge" component={Ledge} durationInFrames={len("ledge")} {...V} />
        <Composition id="Rooftops" component={Rooftops} durationInFrames={len("rooftops")} {...V} />
        <Composition id="DeskSort" component={DeskSort} durationInFrames={len("deskSort")} {...V} />
        <Composition id="Street" component={Street} durationInFrames={len("street")} {...V} />
        <Composition id="DeskThread" component={DeskThread} durationInFrames={len("deskThread")} {...V} />
        <Composition id="Airliner" component={Airplane} durationInFrames={len("airplane")} {...V} />
        <Composition id="DeskAsk" component={DeskAsk} durationInFrames={len("deskAsk")} {...V} />
        <Composition id="Hawk" component={HawkChase} durationInFrames={len("hawk")} {...V} />
        <Composition id="DeskWait" component={DeskWait} durationInFrames={len("deskWait")} {...V} />
        <Composition id="Storm" component={Storm} durationInFrames={len("storm")} {...V} />
        <Composition id="Breakthrough" component={High} durationInFrames={len("high")} {...V} />
        <Composition id="Descent" component={Descent} durationInFrames={len("descent")} {...V} />
        <Composition id="Arrival" component={Arrival} durationInFrames={len("arrival")} {...V} />
        <Composition id="Inbox" component={Inbox} durationInFrames={len("inbox")} {...V} />
        <Composition id="Seen" component={Seen} durationInFrames={len("seen")} {...V} />
        <Composition id="Payoff" component={Payoff} durationInFrames={len("payoff")} {...V} />
        <Composition id="Homecoming" component={Homecoming} durationInFrames={len("homecoming")} {...V} />
        <Composition id="EndCard" component={EndCard} durationInFrames={len("endcard")} {...V} />
      </Folder>
    </>
  );
};
