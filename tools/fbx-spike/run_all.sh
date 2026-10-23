#!/bin/sh
# The spike over several exports: Blender raw dump (once), each parser under a hard limit,
# each comparison. Results land in out/spike/ (gitignored: made from licensed content).
#   sh tools/fbx-spike/run_all.sh "name|path/to.fbx" ...
BL="${BLENDER:-/c/Program Files/Blender Foundation/Blender 5.2/blender.exe}"
for pair in "$@"; do
  n=${pair%%|*}; f=${pair#*|}
  echo "=== $n $f"
  [ -f out/spike/$n.blender.json ] || timeout -k 10 900 "$BL" --background --factory-startup --python-exit-code 1 \
    --python src/blender/dump_contract.py -- "$f" out/spike/$n.blender --raw 2>&1 | grep -E "CONTRACT|Error"
  for p in ufbx fbxloader; do
    rm -f out/spike/$n.$p.json out/spike/$n.$p.bin
    timeout -k 10 300 node tools/fbx-spike/run.mjs "$f" $n $p || echo "{\"parser\":\"$p\",\"error\":\"killed after 300 s\"}"
    [ -f out/spike/$n.$p.json ] && timeout -k 10 900 node tools/compare/contract.mjs out/spike/$n.blender out/spike/$n.$p --json out/spike/$n.$p.report.json
  done
done
echo "=== done"
