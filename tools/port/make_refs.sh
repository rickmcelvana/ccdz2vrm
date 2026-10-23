#!/bin/sh
# Blender references for one adapter kind: the adapter .blend, its contract dump and its
# desktop VRM (vrm_export --max-texture 1024), each under a hard limit.
#   sh tools/port/make_refs.sh daz "name|path/to.fbx" ...
BL="${BLENDER:-/c/Program Files/Blender Foundation/Blender 5.2/blender.exe}"
kind=$1; shift
for pair in "$@"; do
  n=${pair%%|*}; f=${pair#*|}
  echo "=== $n"
  timeout -k 10 1800 "$BL" --background --factory-startup --python-exit-code 1 --python src/blender/adapt_$kind.py -- "$f" out/spike/$n.$kind.blend --name $n 2>&1 | grep -oE "RESULT .{0,160}|Error.*|SystemExit.*"
  timeout -k 10 1800 "$BL" --background --factory-startup out/spike/$n.$kind.blend --python-exit-code 1 --python src/blender/dump_contract.py -- out/spike/$n.adapted 2>&1 | grep -E "CONTRACT|Error"
  timeout -k 10 1800 "$BL" --background --python-exit-code 1 out/spike/$n.$kind.blend --python src/blender/vrm_export.py -- out/spike/$n.blender.vrm --name $n --max-texture 1024 2>&1 | grep -oE "^RESULT .{0,80}|Error.*"
  [ -f out/spike/$n.ufbx.json ] || timeout -k 10 300 node tools/fbx-spike/run.mjs "$f" $n ufbx
done
echo "=== done"
