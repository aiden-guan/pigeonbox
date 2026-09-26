import React from "react";
import { AbsoluteFill, useCurrentFrame } from "remotion";
import { Row, SearchBar, Sidebar, TrackCard, TrackMark, UI } from "../components/Mail";
import { FilmFinish } from "../components/Pixel";
import { Caption } from "../components/World";
import { at, ci, ease } from "../lib";
import { C } from "../theme";

const SLOT_X = 1600; // centre of the tracked row's mark in UI px
const ROW_Y = 216;

/** Back at the sender's desk: the mark turns copper. Maya opened it. */
export const Payoff: React.FC = () => {
  const f = useCurrentFrame();
  const flip = at("payoff", "rowOpened");
  const pop = at("payoff", "cardPop");
  const opened = f >= flip;
  const pulse = ci(f, [flip, flip + 24], [0.001, 1], ease.out);
  const card = ci(f, [pop, pop + 12], [0, 1], ease.out);
  const dim = ci(f, [118, 150], [0, 1], ease.inOut);

  const s = ci(f, [0, pop, pop + 40, 220], [1.75, 1.6, 1.3, 1.24], ease.inOut);
  const fx = ci(f, [0, pop, pop + 40, 150], [1500, 1520, 1480, 1120], ease.inOut);
  const fy = ci(f, [0, pop, pop + 40], [260, 330, 480], ease.inOut);

  const cardLeft = 1920 - 680 - 30;
  return (
    <AbsoluteFill style={{ background: "#1c1a18", overflow: "hidden" }}>
      <AbsoluteFill style={{ left: 960 - fx * s, top: 540 - fy * s, width: 1920, height: 1080, scale: `${s}`, transformOrigin: "0 0" }}>
        <AbsoluteFill style={{ background: UI.bg, filter: `blur(${dim * 3}px)` }}>
          <Sidebar active="Sent" />
          <SearchBar />
          <div style={{ position: "absolute", left: 380, top: 136, right: 24, bottom: 0, background: UI.panel, borderRadius: "32px 32px 0 0", overflow: "hidden" }}>
            <div style={{ height: 80 }} />
            <Row
              from="To: Maya Chen"
              subject="The new direction"
              snippet="Hi Maya, Here's the new direction, with both changes."
              time="9:37 AM"
              unread
              slot={<TrackMark opened={opened} pulse={opened ? pulse : 0} />}
            />
            <Row from="To: Jordan Park" subject="Boards for Friday" snippet="Printed and packed — see you there." time="Yesterday" slot={<TrackMark opened />} />
            <Row from="To: Oliver at Fieldwork" subject="Re: Samples" snippet="Thank you! Tomorrow morning works." time="Yesterday" slot={<TrackMark opened={false} />} />
            <Row from="To: Nina & Alex" subject="Re: Coffee next week?" snippet="Tuesday at 10 is perfect." time="Sep 24" slot={<TrackMark opened />} />
            <Row from="To: Sam Ortega" subject="Re: Photos from the weekend" snippet="The pigeon one is my favorite too." time="Sep 24" slot={<TrackMark opened />} />
          </div>
        </AbsoluteFill>
        {card > 0 ? (
          <div style={{ position: "absolute", left: cardLeft, top: ROW_Y + 80 + 20, opacity: card, scale: `${0.94 + card * 0.06}`, transformOrigin: `${SLOT_X - cardLeft}px 0px`, translate: `0px ${(1 - card) * -14}px` }}>
            <TrackCard style={{ position: "relative" }} arrow={false} opened />
            <div style={{ position: "absolute", top: -12, left: SLOT_X - cardLeft - 12, width: 24, height: 24, background: "#282822", rotate: "45deg" }} />
          </div>
        ) : null}
      </AbsoluteFill>
      <AbsoluteFill style={{ background: "linear-gradient(90deg, rgba(21,21,18,0.96) 0%, rgba(21,21,18,0.9) 38%, rgba(21,21,18,0) 47%)", opacity: dim }} />
      <Caption from={130} to={240} x={110} y={270} size={128} color={C.ivory} width={1000}>
        Know the
        <br />
        moment
        <br />
        it’s <span style={{ color: C.copper }}>opened.</span>
      </Caption>
      <FilmFinish vignette={0.5} grain={0.06} warmth={0.1} />
    </AbsoluteFill>
  );
};
