import React from "react";
import { Composition, Folder } from "remotion";
import { Kinetic, SHOTS, TOTAL } from "./Kinetic";
import { FPS } from "./tokens";

const V = { width: 1920, height: 1080, fps: FPS };

export const KineticCompositions: React.FC = () => (
  <>
    <Composition id="PigeonBoxKinetic" component={Kinetic} durationInFrames={TOTAL} defaultProps={{ audio: true }} {...V} />
    <Composition id="PigeonBoxKineticSilent" component={Kinetic} durationInFrames={TOTAL} defaultProps={{ audio: false }} {...V} />
    <Folder name="Kinetic">
      {SHOTS.map(({ name, dur, C }) => (
        <Composition key={name} id={`K-${name}`} component={C} durationInFrames={dur} {...V} />
      ))}
    </Folder>
  </>
);
