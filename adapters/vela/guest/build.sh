#!/bin/sh
# EVALUATION ONLY: the guest runs on a software TEE with no attestation, a test
# token and a fixture oracle; sender, amount and time are trusted from the
# manager. Not private, not secure, not production-ready.
#
# Builds build/zedge_guest.wasm. The toolchain is pinned because the wasm's
# SHA-256 is the deployment's applicationFingerprint: a different compiler is a
# different application. Override the binaries with TINYGO and WASMOPT.
set -eu
cd "$(dirname "$0")"

TINYGO="${TINYGO:-tinygo}"
export WASMOPT="${WASMOPT:-wasm-opt}"
export GOTOOLCHAIN=go1.25.14

"$TINYGO" version | grep -q '^tinygo version 0\.39\.0 ' || { echo "build.sh: TinyGo 0.39.0 is required; found: $("$TINYGO" version 2>&1)" >&2; exit 1; }
"$WASMOPT" --version | grep -q 'version 133' || { echo "build.sh: Binaryen 133 is required; found: $("$WASMOPT" --version 2>&1)" >&2; exit 1; }
go version | grep -q ' go1\.25\.14 ' || { echo "build.sh: Go 1.25.14 is required; found: $(go version 2>&1)" >&2; exit 1; }

mkdir -p build
# -scheduler=none: the host never calls _start, and the default scheduler traps
# in crypto/sha256 without it. -target=wasi keeps the imports to the eight WASI
# functions Vela v0.3.0 allows.
"$TINYGO" build -target=wasi -scheduler=none -opt=2 -no-debug -o build/zedge_guest.wasm ./cmd/zedge-guest

wc -c build/zedge_guest.wasm
shasum -a 256 build/zedge_guest.wasm
