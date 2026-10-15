# Kinetic soundtrack

Selected October 14, 2026: **“Dry Gin” — Michael Ramir C.**, Mixkit asset **868**.
An instrumental acid-jazz groove, listed with bass and drums; published in Mixkit's
catalog on January 28, 2020. This is an existing composer track, not generated music.

- [Track listing](https://mixkit.co/free-stock-music/funk/) (search for “Dry Gin”).
- [Original MP3](https://assets.mixkit.co/music/868/868.mp3).
- [Stock Music Free License](https://mixkit.co/license/#musicFree).
- [Attribution FAQ](https://mixkit.co/free-stock-music/).
- [User Terms](https://mixkit.co/terms/) (revision October 2, 2025).

## Permitted use

The published license permits commercial web/social videos and online advertising.
The FAQ explicitly says attribution is optional. No on-screen credit or description
credit is required for this X/YouTube launch video. The license is non-exclusive;
the track is not owned by PigeonBox or covered by this repository's MIT license.
Standalone music redistribution, Content ID registration, games, and TV/radio use
are outside this soundtrack workflow. Keep the downloaded MP3 in ignored `out/`.

The license modal and FAQ were checked directly on October 14, 2026. Local HTML
source snapshots are in `out/research/`; the catalog's structured metadata associates
asset 868 with the Stock Music Free License. Retain this note with the final film.

## Timing and mix

- Original MP3: 108.487596 seconds.
- SHA-256: `eb0bbb8967dfe68641639ec596c5cd32d9e90a75b5ba09304a676d122975c718`.
- Measured tempo: **120 BPM**, using spectral-onset autocorrelation plus a fine
  tempo/phase grid over the first 65 seconds. The strongest fine-grid result was
  120.0 BPM; the nearest coarse autocorrelation bin was 120.19 BPM. No time stretch.
- Source offset: **0 seconds**. The beat grid continues through the quiet question.
- Picture remains 98 beats / 49 seconds / 2,940 frames at 60 fps.
- `mux-kinetic.sh` ducks the track for the question, brings it back through the sort,
  eases it under the privacy card, and fades the last 2.5 seconds. Foley stays above
  the groove at a lower gain, with a final peak limiter. The picture is stream-copied.

## Reproduce

Run from `launch-video/`. Download only this selected asset, then verify its hash:

```bash
mkdir -p out/music
curl --fail --location https://assets.mixkit.co/music/868/868.mp3 -o out/music/dry-gin-868.mp3
shasum -a 256 out/music/dry-gin-868.mp3
scripts/mux-kinetic.sh out/pigeonbox-kinetic-silent.mp4 out/pigeonbox-kinetic-music.mp4 out/music/dry-gin-868.mp3
```

The raw track and all rendered outputs are intentionally untracked. With a new
track at a different tempo, review all local shot timings as well as the beat cut
list, regenerate the foley, check stills, and render again before muxing.
