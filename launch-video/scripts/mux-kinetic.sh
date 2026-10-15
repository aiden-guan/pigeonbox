#!/bin/bash
# Put sound under the silent master without re-rendering the picture.
#   scripts/mux-kinetic.sh SILENT.mp4 OUT.mp4 [music.(wav|mp3|m4a)] [music offset seconds]
# With a music file, the sound design sits on top of the track at -6 dB and the music fades out
# with the picture.
set -e
cd "$(dirname "$0")/.."
SILENT=$1; OUT=$2; MUSIC=$3; OFFSET=${4:-0}
DUR=$(ffprobe -v error -show_entries format=duration -of csv=p=0 "$SILENT")
if [ -z "$MUSIC" ]; then
  ffmpeg -v error -y -i "$SILENT" -i public/kinetic/sfx.wav -map 0:v -map 1:a -c:v copy -c:a aac -b:a 320k -shortest -movflags +faststart "$OUT"
else
  FADE=$(python3 -c "print(max(0, $DUR - 2.5))")
  ffmpeg -v error -y -i "$SILENT" -ss "$OFFSET" -i "$MUSIC" -i public/kinetic/sfx.wav \\
    -filter_complex "[1:a]atrim=0:$DUR,asetpts=PTS-STARTPTS,afade=t=out:st=$FADE:d=2.5,volume=1.0[m];[2:a]volume=0.5[s];[m][s]amix=inputs=2:normalize=0,alimiter=limit=0.89[a]" \\
    -map 0:v -map "[a]" -c:v copy -c:a aac -b:a 320k -shortest -movflags +faststart "$OUT"
fi
echo "wrote $OUT"
