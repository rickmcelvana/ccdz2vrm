#!/bin/sh
# Blender's web tier for each export: vrm_export at 1K textures (+ --max-mesh-verts 50000 for
# Daz, as the app does), then glb_web.py inside Blender. Needs make_refs.sh's <n>.<kind>.blend.
#   sh tools/port/make_web_refs.sh "name|kind" ...
BL="${BLENDER:-/c/Program Files/Blender Foundation/Blender 5.2/blender.exe}"
for pair in "$@"; do
  n=${pair%%|*}; kind=${pair#*|}
  extra=""; [ "$kind" = daz ] && extra="--max-mesh-verts 50000"
  echo "=== $n"
  timeout -k 10 1800 "$BL" --background --python-exit-code 1 out/spike/$n.$kind.blend --python src/blender/vrm_export.py -- \
    out/spike/$n.blender.webbase.vrm --name $n --max-texture 1024 $extra 2>&1 | grep -oE '"decimated": \{[^}]*\}[^}]*\}|Error.*'
  timeout -k 10 900 "$BL" --background --factory-startup --python-exit-code 1 --python src/blender/glb_web.py -- \
    out/spike/$n.blender.webbase.vrm out/spike/$n.blender.web.vrm 2>&1 | grep -oE '"dst_bytes": [0-9]+|Error.*'
done
echo "=== done"
