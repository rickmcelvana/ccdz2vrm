#!/bin/sh
# Phase 2+: Blender's adapter (.blend dumped by dump_contract.py) against the TypeScript port,
# every step under a hard limit.   sh tools/port/run_adapt.sh cc "name|path/to.Fbx" ...
BL="${BLENDER:-/c/Program Files/Blender Foundation/Blender 5.2/blender.exe}"
kind=$1; shift
for pair in "$@"; do
  n=${pair%%|*}; f=${pair#*|}
  echo "=== $n"
  if [ ! -f out/spike/$n.adapted.json ]; then
    timeout -k 10 900 "$BL" --background --factory-startup --python-exit-code 1 --python src/blender/adapt_$kind.py -- "$f" out/spike/$n.$kind.blend --name $n 2>&1 | grep -oE "RESULT .{0,200}|Error.*"
    timeout -k 10 900 "$BL" --background --factory-startup out/spike/$n.$kind.blend --python-exit-code 1 --python src/blender/dump_contract.py -- out/spike/$n.adapted 2>&1 | grep -E "CONTRACT|Error"
  fi
  [ -f out/spike/$n.ufbx.json ] || timeout -k 10 300 node tools/fbx-spike/run.mjs "$f" $n ufbx
  timeout -k 10 600 node tools/port/adapt.ts out/spike/$n $kind $n && \
    timeout -k 10 900 node tools/compare/contract.mjs out/spike/$n.adapted out/spike/$n.ts-adapted --exact --json out/spike/$n.ts-adapted.report.json
done
