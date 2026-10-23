#!/bin/sh
# ufbx + ufbx_contract.c -> ufbx_contract.wasm (wasm32-wasi reactor), with Zig's clang.
#   ZIG=~/.toolchains/zig-x86_64-windows-0.17.0/zig.exe sh build.sh
# ufbx.c/.h are fetched from the pinned release on first build (MIT or Unlicense).
set -e
cd "$(dirname "$0")"
UFBX=v0.23.1
[ -f ufbx.c ] || curl -sLo ufbx.c "https://raw.githubusercontent.com/ufbx/ufbx/$UFBX/ufbx.c"
[ -f ufbx.h ] || curl -sLo ufbx.h "https://raw.githubusercontent.com/ufbx/ufbx/$UFBX/ufbx.h"
"${ZIG:-zig}" cc -target wasm32-wasi -O2 -mexec-model=reactor -DUFBX_NO_STDIO \
  -Wl,--max-memory=4294901760 -Wl,--export=malloc -Wl,--export=free \
  -o ufbx_contract.wasm ufbx.c ufbx_contract.c
# the converter ships this build (committed, so a site build needs no Zig)
cp ufbx_contract.wasm ../../app/src/convert/ufbx_contract.wasm
ls -la ufbx_contract.wasm
