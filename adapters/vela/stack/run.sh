#!/bin/sh
# EVALUATION ONLY: the whole local Vela slice in one command, from clean volumes.
# Software TEE, no attestation, a worthless test token, a fixture oracle; sender,
# amount and time are trusted from the manager. Not private, not secure, not
# production-ready.
#
#   ./run.sh                      # build, test, start clean, run the slice, tear down
#   KEEP_STACK=1 ./run.sh         # leave the stack up afterwards, as the destructive phases left it:
#                                 # clock stopped (millisecond test), manager not processing. For logs only.
#   VELA_STARTERKIT=/path ./run.sh  # take the starter kit from a local clone
#
# Needs Docker (about 3 GB free for the stack's volumes), Foundry, Node 22 and the
# guest wasm (../guest/build.sh). Evidence goes to evidence/vela-slice-2026-10-06/.
set -u
cd "$(dirname "$0")"
. ./lib.sh
log=build/run.log
summary=""
failed=0
mkdir -p build
: > "$log"

step() {
  name=$1
  shift
  echo "== $name"
  # sh has no pipefail: the command's own status goes through a file.
  { "$@" 2>&1; echo $? > build/.step-status; } | tee -a "$log"
  if [ "$(cat build/.step-status)" = 0 ]; then
    summary="$summary
PASS  $name"
  else
    summary="$summary
FAIL  $name"
    failed=1
  fi
}

# The wasm is rebuilt when it is missing or older than any source it is built from, by the same rule as
# the guest's wasm tests (conformance_test.go), so the slice never deploys a stale program.
wasm=../guest/build/zedge_guest.wasm
stale=$(find ../guest/*.go ../guest/cmd/zedge-guest/*.go ../../../engine/*.go ! -name '*_test.go' -newer "$wasm" 2>/dev/null)
if [ ! -f "$wasm" ] || [ -n "$stale" ]; then
  step "build the guest wasm" ../guest/build.sh
fi
step "evaluation contracts: forge test" sh -c 'cd contracts && forge test'
step "clean start: remove this project's containers and volumes" ./down.sh
[ "$failed" = 0 ] && step "bring-up, handshake and manifest" ./up.sh
[ "$failed" = 0 ] && step "slice: deploy, lifecycle, negatives, clock, restarts, leak scan, timings" node --experimental-strip-types slice.mjs all
if [ "$failed" = 1 ] && [ -f "$KIT/dockerfiles/docker-compose.yml" ]; then
  # Kept local and git-ignored. These logs hold the evaluation's guest state in clear (see leak-scan.json).
  compose logs --no-color > build/stack-logs-on-failure.txt 2>&1 || true
  echo "stack logs saved to build/stack-logs-on-failure.txt"
fi
if [ "${KEEP_STACK:-}" != 1 ]; then
  step "teardown" ./down.sh
fi

echo
echo "EVALUATION ONLY. Software TEE, no attestation, test token, fixture oracle; sender, amount and time are manager-trusted."
grep -E '^(PASS|FAIL)  ' "$log" | awk '{print $1}' | sort | uniq -c | awk '{printf "checks: %s %s\n", $1, $2}'
grep -E '^FAIL  ' "$log" || true
echo "$summary"
echo "evidence: $(cd ../../.. && pwd)/evidence/vela-slice-2026-10-06/"
[ "$failed" = 0 ] && echo "RESULT: PASS" || echo "RESULT: FAIL"
exit "$failed"
