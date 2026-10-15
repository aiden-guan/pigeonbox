import React from "react";
import { AbsoluteFill, useCurrentFrame } from "remotion";
import { CameraRig, Key, track, trail } from "../Camera";
import { Workspace, WS_H, WS_W } from "../ui/Workspace";
import { b, ci, ease, K } from "../tokens";
import { Slam } from "../type";

/**
 * "Sorted." then the workspace inbox, the category switch rolling through
 * Respond → Waiting → FYI → Notifications on the beat.
 */
export const Triage: React.FC = () => {
  const f = useCurrentFrame();
  const word = b(1.5);
  if (f < word) {
    return <Slam bg={K.copper} color={K.paper} words={[{ t: "Sorted.", at: 0, italic: false }]} size={300} f={f} />;
  }
  const g = f - word;
  // Category steps on beats.
  const steps = [b(1.5), b(2.5), b(3.5)];
  let cat = 0;
  steps.forEach((st) => {
    cat += ci(g, [st, st + 14], [0, 1], ease.inOut);
  });
  const dur = b(6.5);
  const t = g / dur;
  const keys: Key[] = [
    [0, 210, 228],
    [b(4.2), 220, 250],
    [dur, 230, 300],
  ];
  const [fx, fy] = track(g, keys);
  const [lx, ly] = trail(g, keys);
  return (
    <AbsoluteFill>
      <CameraRig
        cam={{
          w: WS_W,
          h: WS_H,
          fx: fx,
          fy: fy,
          tx: -40 - t * 60,
          ty: 30,
          pitch: 32,
          yaw: -8,
          roll: 12 - t * 2,
          mag: 2.85 + t * 0.15,
          band: 70,
          rate: 0.035,
          light: { x: lx, y: ly, rx: 380, ry: 300, dim: 0.45, kx: -30, ky: -40 },
        }}
      >
        <Workspace tab="Inbox" cat={cat} lit={ci(g, [10, 30], [0, 1])} />
      </CameraRig>
    </AbsoluteFill>
  );
};
