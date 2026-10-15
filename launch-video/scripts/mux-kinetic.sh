#!/bin/bash
# Put sound under the silent master without re-rendering the picture.
#   scripts/mux-kinetic.sh SILENT.mp4 OUT.mp4 [music.(wav|mp3|m4a)] [music offset seconds]
# With music, the track follows a timeline-driven gain envelope and fades with the picture;
# sound design sits above it at 0.3 gain. Video is copied without another encode.
set -euo pipefail
cd "$(dirname "$0")/.."
if [ "$#" -lt 2 ]; then
  echo "usage: $0 SILENT.mp4 OUT.mp4 [music] [offset-seconds]" >&2
  exit 1
fi
SILENT=$1; OUT=$2; MUSIC=${3:-}; OFFSET=${4:-0}
if [ "$SILENT" = "$OUT" ]; then echo "input and output must differ" >&2; exit 1; fi
DUR=$(ffprobe -v error -show_entries format=duration -of csv=p=0 "$SILENT")
mkdir -p "$(dirname "$OUT")"
if [ -z "$MUSIC" ]; then
  ffmpeg -v error -y -i "$SILENT" -i public/kinetic/sfx.wav -map 0:v -map 1:a -c:v copy -c:a aac -b:a 320k -shortest -movflags +faststart "$OUT"
else
  MUSIC_DUR=$(ffprobe -v error -show_entries format=duration -of csv=p=0 "$MUSIC")
  python3 - "$DUR" "$MUSIC_DUR" "$OFFSET" <<'PY'
import sys
duration, music, offset = map(float, sys.argv[1:])
if offset < 0 or music - offset < duration:
    raise SystemExit("music must cover the whole picture after the requested offset")
PY
  FADE=$(python3 -c "print(max(0, $DUR - 2.5))")
  # Leave room for the question, then bring the groove back with the dot reveal.
  # Times come from the cut list, so music never stops or slips off its beat grid.
  ENVELOPE=$(python3 - <<'PY'
import json
t = json.load(open('src/kinetic/timeline.json'))
at = 0
starts = {}
for name, beats in t['shots']:
    starts[name] = at * 60 / t['bpm']
    at += beats
q, s, w, p, e = (starts[n] for n in ['question', 'sort', 'wordmark', 'privacy', 'end'])
print(f"if(lt(t,{q-.08}),0.8,if(lt(t,{q}),0.8-0.74*(t-{q-.08})/0.08,if(lt(t,{s}),0.06,if(lt(t,{w}),0.06+0.74*(t-{s})/{w-s},if(between(t,{p},{e}),0.5,0.8)))))")
PY
)
  ffmpeg -v error -y -i "$SILENT" -ss "$OFFSET" -i "$MUSIC" -i public/kinetic/sfx.wav \
    -filter_complex "[1:a]atrim=0:$DUR,asetpts=PTS-STARTPTS,volume='$ENVELOPE':eval=frame,afade=t=out:st=$FADE:d=2.5[m];[2:a]volume=0.3[s];[m][s]amix=inputs=2:normalize=0,alimiter=limit=0.89:level=false:latency=true,apad,atrim=0:$DUR[a]" \
    -map 0:v -map "[a]" -c:v copy -c:a aac -b:a 320k -t "$DUR" -movflags +faststart "$OUT"
fi
echo "wrote $OUT"
