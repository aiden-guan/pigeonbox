# PigeonBox launch film

A ~110 second launch film for PigeonBox, built in [Remotion](https://www.remotion.dev). Someone sends an email; the pigeon on their window carries it across a chaotic city (an airliner, a hawk, a thunderstorm) while, back at the desk, the sender blissfully gets on with their morning in PigeonBox: whistling, sipping coffee, yawning. The pigeon reaches Maya, she opens it, and the sender knows the moment she does.

## Watch

The final render is attached to the GitHub release `launch-film-v1`.

## Preview and render

```bash
npm install
npx remotion studio          # PigeonBoxLaunch, plus every scene as its own composition under Scenes
npx remotion render PigeonBoxLaunch out/pigeonbox-launch.mp4
# master limiter pass used for the release file
ffmpeg -i out/pigeonbox-launch.mp4 -c:v copy -af "alimiter=limit=0.89:level=false" -c:a aac -b:a 256k -movflags +faststart out/pigeonbox-launch-final.mp4
```

## How it's made

- **Timing:** `src/timeline.json` is the single source of truth for shots, story beats and the tempo map (90 BPM → 150 BPM for the chase → 90 BPM). Picture and sound both read it, so cuts and hits land on bar lines.
- **Pixel art:** generated in Python (numpy + Pillow), written to `public/art` with anchors in `src/art-manifest.json`.
  - `scripts/gen_pigeon.py`: derives the film cells from the approved production mascot and flight sheets via `gen_pigeon.mjs`; it preserves the existing film frame layout.
  - `scripts/gen_world.py`: the city, interiors, traffic and people. The sender behind his window is layered (`s3_sender` poses, `s3_front`, `s3_mug`, whistled `notes`) so the desk cutaways can animate him.
  - `scripts/gen_hazards.py`: airliner, hawk, storm.
  - `scripts/gen_sunset.py`: the closing rooftop and the pigeon's friends.
- **Score and sound design:** `scripts/gen_audio.py` synthesizes everything (original, no samples or licenses) into `public/audio`, and writes `src/typing.json` for the on-screen typing and `src/whistle.json` for the notes the sender whistles. Desk cutaway sound cues live in `DESK_CUES` (`src/scenes/Desk.tsx`).
- **Product UI:** real captures of the extension's Copper Perch preview fixture (`apps/extension/src/preview`) via `scripts/capture-product.mjs` (Chrome DevTools protocol, 2x). The fixture's fictional demo mail is swapped for the film's story; the UI is untouched. Tracking card, sent-row mark and category chips mirror `apps/extension/src/content/shell/surface.ts`.

Regenerate assets in this order: `gen_world.py`, `gen_pigeon.py`, `gen_hazards.py`, `gen_sunset.py`, then `gen_audio.py`.
