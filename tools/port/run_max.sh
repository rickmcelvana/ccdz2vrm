#!/bin/sh
# Phase 6: the TypeScript max tier (--spring-bones, + --twist-split for Daz) against Blender's
# (make_max_refs.sh), every step under a hard limit: humanoid, expressions, node constraints,
# spring bones, materials and geometry. (tools/compare/vrm.ts --geometry <n>.blender.vrm checks
# that a split file's rest mesh is the plain export's.)
#   sh tools/port/run_max.sh "name|cc" "name|daz" ...
for pair in "$@"; do
  n=${pair%%|*}; kind=${pair#*|}
  extra=""; [ "$kind" = daz ] && extra="--twist-split"
  echo "=== $n"
  timeout -k 10 900 node tools/port/finish.ts out/spike/$n $kind $n --max-texture 1024 --spring-bones $extra | cut -c1-200 && \
    timeout -k 10 1200 node tools/compare/vrm.ts out/spike/$n.blender.max.vrm out/spike/$n.ts.max.vrm
done
