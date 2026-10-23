#!/bin/sh
# Blender's max tier for each export: vrm_export --spring-bones (+ --twist-split for Daz, as the
# app does). Textures at 1024, not the app's 2048: the subject here is bones and extensions, and
# textures are judged by the desktop comparison. Needs make_refs.sh's <n>.<kind>.blend.
#   sh tools/port/make_max_refs.sh "name|kind" ...
BL="${BLENDER:-/c/Program Files/Blender Foundation/Blender 5.2/blender.exe}"
for pair in "$@"; do
  n=${pair%%|*}; kind=${pair#*|}
  extra=""; [ "$kind" = daz ] && extra="--twist-split"
  echo "=== $n"
  timeout -k 10 1800 "$BL" --background --python-exit-code 1 out/spike/$n.$kind.blend --python src/blender/vrm_export.py -- \
    out/spike/$n.blender.max.vrm --name $n --max-texture 1024 --spring-bones $extra 2>&1 > out/spike/$n.blender.max.log
  grep -oE '"(spring_bones|twist_split|twist_constraints|spring_export)": \{[^}]*(\{[^}]*\}[^}]*)*\}|Error.*|SystemExit.*' out/spike/$n.blender.max.log
done
echo "=== done"
