#!/usr/bin/env bash
# Regenerates public/model/hospital.glb + public/model/rooms.json from the FiveM resource.
# usage: npm run build:model -- [path/to/oceanHospital/stream]
set -euo pipefail
ROOT="$(cd "$(dirname "$0")/.." && pwd)"
SRC="${1:-$HOME/Downloads/oceanHospital/oceanHospital/stream}"
TMP="$ROOT/build/export"

[ -d "$ROOT/tools/CodeWalker" ] || git clone --depth 1 https://github.com/dexyfex/CodeWalker.git "$ROOT/tools/CodeWalker"
dotnet build "$ROOT/tools/OceanExporter" -c Release -v quiet -nologo
rm -rf "$TMP" && mkdir -p "$TMP" "$ROOT/public/model"
dotnet "$ROOT/tools/OceanExporter/bin/Release/net10.0/OceanExporter.dll" "$SRC" "$TMP"

npx gltf-transform optimize "$TMP/scene.gltf" "$ROOT/public/model/hospital.glb" \
  --compress meshopt --texture-compress webp --texture-size 1024 --simplify false --instance false --flatten false 2>&1 | grep -v "quantize: Skipping"
cp "$TMP/rooms.json" "$ROOT/public/model/rooms.json"
ls -la "$ROOT/public/model"
