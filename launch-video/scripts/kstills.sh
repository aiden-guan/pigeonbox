#!/bin/bash
# Render stills: kstills.sh OUTDIR COMP:FRAME [COMP:FRAME ...]
out=$1; shift
mkdir -p "$out"
npx remotion bundle --log=error --out-dir /tmp/kbundle >/dev/null 2>&1 || npx remotion bundle --out-dir /tmp/kbundle
for spec in "$@"; do
  comp=${spec%%:*}; fr=${spec##*:}
  npx remotion still /tmp/kbundle "$comp" "$out/${comp}-${fr}.png" --frame="$fr" --log=error &
done
wait
