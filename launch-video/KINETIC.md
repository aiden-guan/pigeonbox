# PigeonBox launch film (kinetic cut)

A 49-second launch film for X and YouTube, 1920×1080 at 60 fps, cut to a 120 BPM score
(one beat = 0.5 s = 30 frames). Composition: `PigeonBoxKinetic`.

## Direction

Taken from the most-watched launch videos on startuplaunchvideos.com (Aside 1.5M, Palmier 2.7M,
Kickbacks 7.7M, Anything, Lovable) and from Linear-style product films:

- **Hook in the first second** with a problem everyone has: a number, not a logo.
- **Kinetic type carries the story.** Bold Inter Tight on full-bleed copper, paper and ink. One idea
  per card, hard cuts on the beat. Emphasis comes from copper, never italics.
- **Real product, early and often.** Every feature shot is the real PigeonBox UI, rebuilt as
  vector components from the extension's own tokens (Instrument Sans, IBM Plex Mono, light
  `--pb-*` colours) and shot with a tilted 3D camera, shallow focus and slow drift. The camera
  renders the UI natively at 3× so magnified text stays pixel-sharp.
- **No stock, no characters.** Product UI and type only; the brand's halftone dots appear as
  texture (the inbox dissolving into dots, the burst behind the wordmark).
- **Takeaway:** find what needs a reply, and it all runs on your computer.

## Shot list

| # | Time (s) | Shot | On screen |
|---|---|---|---|
| 1 | 0.0–1.5 | Counter | Ink. Counter rolls to **2,847** unread |
| 2 | 1.5–3.5 | Subject strobe | 8 subject lines, 1/8-note cuts, copper / paper / ink |
| 3 | 3.5–5.0 | Inbox wall | Tilted endless inbox scrolling faster, counter still climbing |
| 4 | 5.0–7.0 | Question | The groove drops away. Paper. A selection locks onto "you?" |
| 5 | 7.0–9.0 | Halftone sort | Three copper rows become a dot-matrix **3**, then collapse to a point |
| 6 | 9.0–11.0 | Wordmark | Copper. The point bursts into dots; three type slices assemble **PigeonBox** |
| 7 | 11.0–15.0 | Triage | "Sorted." → workspace: Respond 3 · Waiting 5 · FYI 12 · Notifications 41 |
| 8 | 15.0–19.0 | Summary | "Long thread? Three lines." → companion card writes itself, date chip, to-do |
| 9 | 19.0–24.0 | Draft | "Replies, in your voice." → reply streams into Gmail → "You press Send." → the press |
| 10 | 24.0–29.0 | Ask | "Ask your inbox." → question types → reasoning trace → cited answer |
| 11 | 29.0–33.0 | Tracking | "Know when it lands." → ✓ Opened · open toast · notify-if-no-reply |
| 12 | 33.0–37.0 | Rapid fire | Follow-ups · Key dates · To-dos · Cited answers · Works with AI off · your AI, your choice |
| 13 | 37.0–39.0 | Wide payoff | The whole Gmail window, sorted, with the workspace beside it |
| 14 | 39.0–43.0 | Privacy | A computer-window boundary closes around the privacy promise |
| 15 | 43.0–49.0 | End card | Paper. **2,847 → 3**. Three fields become dots. **PigeonBox** · usepigeonbox.com |

## Sound

No synthesised music. The selected soundtrack is **“Dry Gin” by Michael Ramir C.** (Mixkit),
120 BPM, licensed for commercial online video without required attribution. See [MUSIC.md](MUSIC.md)
for source, license links, hash, timing measurement and the exact mux command.

`scripts/gen_kinetic_sfx.py` builds the sound design from the cut list:
whooshes on cuts, low impacts on the big moments, and clicks and key ticks for every visible
action. Lay a licensed track under it with `scripts/mux-kinetic.sh`, which needs no re-render:

```bash
scripts/mux-kinetic.sh out/pigeonbox-kinetic-silent.mp4 out/pigeonbox-kinetic-music.mp4 track.mp3 [offset-seconds]
```

The cut list runs at 120 BPM (`src/kinetic/timeline.json`). For a track at another tempo, change
`bpm` and the beat lengths there, review local shot animation and foley timings too, and re-render
so the cuts land on its beats.

## Build it

```bash
python3 scripts/gen_kinetic_sfx.py            # public/kinetic/sfx.wav
npx remotion studio                           # PigeonBoxKinetic, every shot under Kinetic/
scripts/render-kinetic.sh out/pigeonbox-kinetic.mp4   # chunked render: -silent.mp4 master + sound design
scripts/kstills.sh /tmp/stills K-ask:200 K-end:200    # spot-check frames
```

## Files

- `src/kinetic/timeline.json`: the cut list in beats. The picture and `gen_kinetic_sfx.py` both read it.
- `src/kinetic/Camera.tsx`: perspective camera with optical depth of field (stacked, masked blur copies),
  a light pool that lies on the UI plane, and focus tracks that trail the subject.
- `src/kinetic/Halftone.tsx`: the brand dot matrix as a frame-driven canvas.
- `src/kinetic/ui/`: the PigeonBox workspace, companion card, Ask with its reasoning trace, the sent list
  and open toast, and Gmail around them, rebuilt from the extension's light-theme tokens.
- `src/kinetic/shots/`: one file per act (Hook, Reveal, Triage, Features, Finale).

## Status and next steps

Where the film stands (October 14, 2026):

- **Picture has a graphic revision**: 15 shots, 49 s, 1080p60. A shared “2,847 → 3” motif now links
  the question, sorting, wordmark and ending; the privacy promise is enclosed by a computer frame.
  Product demonstrations retain the original light UI and 3× camera raster. See
  [MOTION-REFERENCES.md](MOTION-REFERENCES.md) for the researched references and original adaptations.
  The render lands at
  `out/pigeonbox-kinetic.mp4` (sound design only) and `out/pigeonbox-kinetic-silent.mp4` (no audio).
  `out/` is gitignored, so render again from a fresh checkout.
- **Music export is complete.** “Dry Gin” matches 120 BPM; no re-timing or time stretch.
  The finished soundtrack export is `out/pigeonbox-kinetic-music.mp4`. The mux script ducks the
  question and privacy sections and fades the ending. See [MUSIC.md](MUSIC.md) for licensing.
- **Verified:** settled and transitional frames through `kstills.sh`, including Ask and Send;
  TypeScript and kinetic ESLint; full output decode; 2,940 frames at 1920×1080 / 60 fps with
  49-second AAC audio. The mix measures −17.4 LUFS integrated / −1.1 dB true peak. The revised
  graphic sections were rendered and assembled with the existing product footage; the ignored
  `out/review/` folder retains the original masters, patch ranges and render provenance.
- Possible follow-ups: a vertical 9:16 or 4:5 cut for mobile feeds; music-synced re-timing.

### Taste rules from the owner (do not regress)

- **No Pidgy mascot as a character:** no flying, waving or posing bird and no pixel-art end card.
  The only bird is the tiny static logo inside the real workspace header, because that is the product UI.
- **No serif or italic display type.** Kinetic type is Inter Tight (`display` in `src/kinetic/tokens.ts`),
  weights 600 and 700. Emphasis is copper colour, never italics.
- **No synthesised music.** Use a real, licensed track. Foley and sound design are fine.
- **Text must be crisp and never collide.** Keep `CameraRig`'s `res` at 3 (the UI renders natively at 3×);
  keep display tracking around -0.035em to -0.05em and check that glyphs don't touch.
- Product shots use the extension's **light** theme tokens (`PB`, `GM` in `tokens.ts`) and must stay
  faithful to the real UI. "Tracking ready" sits inline to the left of Send, never below it.

### Working on it

- Preview a single shot: `npx remotion studio`, then open `Kinetic/K-<shot>`.
- Check frames before a full render: `scripts/kstills.sh /tmp/stills K-ask:200 K-end:120`
  (the frame numbers are local to the shot at 60 fps; one beat is 30 frames).
- A full render takes about 45 minutes, because the 3× UI raster is slow. `scripts/render-kinetic.sh`
  renders in 360-frame chunks because the disk on this machine runs nearly full; a single-pass
  render failed with ENOSPC. Make sure several GB are free before starting.
- After changing the cut list, rerun `python3 scripts/gen_kinetic_sfx.py` so the sound follows the picture.
