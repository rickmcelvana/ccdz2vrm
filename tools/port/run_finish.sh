#!/bin/sh
# Phase 3+: Blender's VRM (vrm_export.py on its adapter .blend) against the TypeScript chain's,
# every step under a hard limit. Needs run_adapt.sh's Blender outputs (out/spike/<n>.<kind>.blend).
#   sh tools/port/run_finish.sh cc "name|path/to.Fbx" ...
BL="${BLENDER:-/c/Program Files/Blender Foundation/Blender 5.2/blender.exe}"
kind=$1; shift
for pair in "$@"; do
  n=${pair%%|*}; f=${pair#*|}
  echo "=== $n"
  [ -f out/spike/$n.blender.vrm ] || timeout -k 10 900 "$BL" --background --python-exit-code 1 out/spike/$n.$kind.blend \
    --python src/blender/vrm_export.py -- out/spike/$n.blender.vrm --name $n --max-texture 1024 2>&1 | grep -E "Error"
  [ -f out/spike/$n.ufbx.json ] || timeout -k 10 300 node tools/fbx-spike/run.mjs "$f" $n ufbx
  timeout -k 10 900 node tools/port/finish.ts out/spike/$n $kind $n --max-texture 1024 | cut -c1-200 && \
    timeout -k 10 900 node tools/compare/vrm.ts out/spike/$n.blender.vrm out/spike/$n.ts.vrm
done
