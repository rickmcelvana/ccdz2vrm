#!/bin/sh
# Phase 1 over several exports, every step under a hard limit (a dead Chromium tab is not
# reported, ENVIRONMENT.md s30): Blender's cleaned import, ufbx raw import, the TS cleanup,
# the exact comparison.   sh tools/port/run_clean.sh "name|path/to.fbx" ...
BL="${BLENDER:-/c/Program Files/Blender Foundation/Blender 5.2/blender.exe}"
for pair in "$@"; do
  n=${pair%%|*}; f=${pair#*|}
  echo "=== $n"
  [ -f out/spike/$n.clean.json ] || timeout -k 10 900 "$BL" --background --factory-startup --python-exit-code 1 \
    --python src/blender/dump_contract.py -- "$f" out/spike/$n.clean --clean 2>&1 | grep -E "CONTRACT|Error"
  rm -f out/spike/$n.ufbx.json out/spike/$n.ufbx.bin out/spike/$n.ts-clean.json
  timeout -k 10 300 node tools/fbx-spike/run.mjs "$f" $n ufbx || echo "ufbx killed"
  [ -f out/spike/$n.ufbx.json ] && timeout -k 10 600 node tools/port/clean.ts out/spike/$n
  [ -f out/spike/$n.ts-clean.json ] && timeout -k 10 900 node tools/compare/contract.mjs out/spike/$n.clean out/spike/$n.ts-clean --exact --json out/spike/$n.ts-clean.report.json
done
echo "=== done"
