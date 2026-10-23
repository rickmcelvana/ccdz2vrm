#!/bin/sh
# Phase 6: the TypeScript max tier (--spring-bones, + --twist-split for Daz) against Blender's
# (make_max_refs.sh), every step under a hard limit. Structure -- humanoid, expressions, node
# constraints, spring bones, materials -- against Blender's max file; geometry against Blender's
# plain file (run_finish.sh's <n>.blender.vrm): the split must not move the rest mesh.
#   sh tools/port/run_max.sh "name|cc" "name|daz" ...
for pair in "$@"; do
  n=${pair%%|*}; kind=${pair#*|}
  extra=""; [ "$kind" = daz ] && extra="--twist-split"
  echo "=== $n"
  timeout -k 10 900 node tools/port/finish.ts out/spike/$n $kind $n --max-texture 1024 --spring-bones $extra | cut -c1-200 && \
    timeout -k 10 1200 node tools/compare/vrm.ts out/spike/$n.blender.max.vrm out/spike/$n.ts.max.vrm \
      --geometry out/spike/$n.blender.vrm
done
