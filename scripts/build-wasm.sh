#!/usr/bin/env bash
set -euo pipefail
cd "$(dirname "$0")/.."
: "${ZEDGE_WASM_TOOL_ROOT:?Set ZEDGE_WASM_TOOL_ROOT to the checksum-verified task tools directory}"
mkdir -p adapters/vela/build
cd engine
GOTOOLCHAIN=go1.25.14 WASMOPT="$ZEDGE_WASM_TOOL_ROOT/binaryen-version_133/bin/wasm-opt" \
  "$ZEDGE_WASM_TOOL_ROOT/tinygo/bin/tinygo" build -target=wasi -no-debug \
  -o ../adapters/vela/build/scenario.wasm ./cmd/scenario
