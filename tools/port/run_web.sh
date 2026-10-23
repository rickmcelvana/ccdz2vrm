#!/bin/sh
# Phase 5: the TypeScript web tier against Blender's (make_web_refs.sh), every step under a hard
# limit. Reduced meshes and textures are judged against the unreduced Blender VRM
# (run_finish.sh's <n>.blender.vrm); morphs at 0.15 mm, since both sides zero deltas under 0.1.
#   sh tools/port/run_web.sh "name|cc" "name|daz" ...
for pair in "$@"; do
  n=${pair%%|*}; kind=${pair#*|}
  extra=""; [ "$kind" = daz ] && extra="--max-mesh-verts 50000"
  echo "=== $n"
  timeout -k 10 900 node tools/port/finish.ts out/spike/$n $kind $n --max-texture 1024 $extra --web | cut -c1-200 && \
    timeout -k 10 1200 node tools/compare/vrm.ts out/spike/$n.blender.web.vrm out/spike/$n.ts.web.vrm \
      --morph-mm 0.15 --original out/spike/$n.blender.vrm
done
