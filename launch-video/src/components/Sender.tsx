import React from "react";
import { M } from "../lib";
import { Art, Cell, Puffs } from "./Pixel";

export type SenderPose =
  | "neutral"
  | "blink"
  | "whistle"
  | "whistle_bliss"
  | "content"
  | "reach"
  | "reach_content"
  | "lift"
  | "sip"
  | "stretch"
  | "yawn";

/** Poses where the mug is in his hand (drawn in his sprite) rather than resting on the desk. */
const HELD: Partial<Record<SenderPose, "hold" | "lift" | "sip">> = { reach: "hold", reach_content: "hold", lift: "lift", sip: "sip" };

/**
 * The sender at his desk, seen through his window. Draw it right after `<Art name="s3_facade" scale={S} />`:
 * him (s3_sender, one cell per pose), then the desk and laptop in front of him, then his mug.
 * `dy` moves him by whole art pixels (a nod, leaning back), never the desk.
 */
export const Sender: React.FC<{ S: number; pose?: SenderPose; dy?: number; steam?: boolean }> = ({ S, pose = "neutral", dy = 0, steam = true }) => {
  const m = M.s3_sender;
  const [ax, ay] = m.at;
  const held = HELD[pose];
  const [mx, my] = m.mug[held ?? "rest"];
  return (
    <>
      <Cell
        file="art/s3_sender.png"
        sheetW={m.w}
        sheetH={m.h}
        cw={m.cw}
        ch={m.ch}
        col={m.poses.indexOf(pose)}
        row={0}
        scale={S}
        style={{ left: ax * S, top: (ay + dy) * S }}
      />
      <Art name="s3_front" scale={S} x={ax * S} y={ay * S} />
      {held ? null : <Art name="s3_mug" scale={S} x={ax * S} y={ay * S} />}
      {steam ? <Puffs x={(ax + mx) * S} y={(ay + my + (held ? dy : 0)) * S} scale={S} count={5} rise={12} life={56} /> : null}
    </>
  );
};
