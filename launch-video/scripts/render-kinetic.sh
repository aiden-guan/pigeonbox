#!/bin/bash
# Render the kinetic film in chunks (keeps temp frames small), then join, grade and mux the score.
#   scripts/render-kinetic.sh [out.mp4]
set -e
cd "$(dirname "$0")/.."
OUT=${1:-out/pigeonbox-kinetic.mp4}
TOTAL=$(node -e 'const t=require("./src/kinetic/timeline.json");console.log(Math.round(t.shots.reduce((n,s)=>n+s[1],0)*60*60/t.bpm))')
CHUNK=${CHUNK:-360}
FREE_KB=$(df -Pk . | awk 'NR==2 {print $4}')
if [ "$FREE_KB" -lt 6291456 ]; then
  echo "need at least 6 GiB free for a chunked 3x render" >&2
  exit 1
fi
mkdir -p out/chunks
rm -f out/chunks/*.mp4 out/chunks/list.txt
npx remotion bundle --out-dir out/chunks/bundle --log=error >/dev/null
i=0
for ((s=0; s<TOTAL; s+=CHUNK)); do
  e=$((s+CHUNK-1)); [ $e -ge $TOTAL ] && e=$((TOTAL-1))
  f=$(printf "out/chunks/c%02d.mp4" $i)
  npx remotion render out/chunks/bundle PigeonBoxKineticSilent "$f" --frames=$s-$e --concurrency=${CONC:-6} --crf=12 --jpeg-quality=95 --muted --log=error
  echo "file '$(basename $f)'" >> out/chunks/list.txt
  echo "chunk $i: $s-$e"
  i=$((i+1))
done
# Join into a silent master, then lay the sound design under it.
SILENT="${OUT%.mp4}-silent.mp4"
ffmpeg -v error -y -f concat -safe 0 -i out/chunks/list.txt \
  -c:v libx264 -preset slow -crf 14 -pix_fmt yuv420p -r 60 -movflags +faststart "$SILENT"
scripts/mux-kinetic.sh "$SILENT" "$OUT"
rm -rf out/chunks
echo "wrote $OUT"
