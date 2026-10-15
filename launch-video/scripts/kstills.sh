#!/bin/bash
# Render stills: kstills.sh OUTDIR COMP:FRAME [COMP:FRAME ...]
set -eo pipefail
cd "$(dirname "$0")/.."
out=$1; shift
mkdir -p "$out"
npx remotion bundle --log=error --out-dir /tmp/kbundle >/dev/null 2>&1 || npx remotion bundle --out-dir /tmp/kbundle
pids=()
for spec in "$@"; do
  comp=${spec%%:*}; fr=${spec##*:}
  npx remotion still /tmp/kbundle "$comp" "$out/${comp}-${fr}.png" --frame="$fr" --log=error &
  pids+=("$!")
  if [ "${#pids[@]}" -ge "${KSTILLS_CONCURRENCY:-2}" ]; then
    for pid in "${pids[@]}"; do wait "$pid"; done
    pids=()
  fi
done
for pid in "${pids[@]}"; do wait "$pid"; done
