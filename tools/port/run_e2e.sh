#!/bin/sh
# Phase 7: the shipped conversion (tools/port/convert.ts -> app/src/convert/convert.ts) from each
# FBX file, every tier, against Blender's VRMs (run_finish.sh, make_web_refs.sh, make_max_refs.sh),
# with the references' settings: springs only in the max tier, max-tier textures at 1024.
#   sh tools/port/run_e2e.sh "name|kind|path/to.fbx" ...
for spec in "$@"; do
  n=${spec%%|*}; rest=${spec#*|}; kind=${rest%%|*}; fbx=${rest#*|}
  twist=""; [ "$kind" = daz ] && twist="--twist-split"
  for tier in desktop web max; do
    suffix=""; [ $tier != desktop ] && suffix=".$tier"
    flags="--no-springs"; [ $tier = max ] && flags="$twist --max-texture 1024"
    echo "=== $n $tier"
    timeout -k 10 1200 node tools/port/convert.ts "$fbx" $kind $n $tier $flags 2>&1 | tail -5
    cmp=""; [ $tier = web ] && cmp="--morph-mm 0.15 --original out/spike/$n.blender.vrm"
    timeout -k 10 1200 node tools/compare/vrm.ts out/spike/$n.blender$suffix.vrm out/spike/$n.e2e$suffix.vrm $cmp 2>&1 | \
      grep -E "^PASS|^FAIL|size|constraints|spring bones|reduced| x " | cut -c1-220
  done
done
echo "=== done"
