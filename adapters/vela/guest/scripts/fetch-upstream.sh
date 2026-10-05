#!/bin/sh
# EVALUATION ONLY (software TEE, no attestation, test token, fixture oracle;
# sender, amount and time trusted from the manager; not private, not secure,
# not production-ready).
#
# Fetches the upstream Vela source the conformance test runs the guest on, at
# two pinned commits, into build/upstream/ (git-ignored).
#
# Upstream is under the Business Source License 1.1, whose additional grant
# covers internal evaluation and testing only. It must stay in build/ and must
# never be committed or copied elsewhere in this repository. Each copy keeps
# upstream's LICENSE file.
#
#   scripts/fetch-upstream.sh                              # from GitHub
#   VELA_UPSTREAM=/path/to/vela scripts/fetch-upstream.sh  # from a local clone, no network
set -eu
cd "$(dirname "$0")/.."

for pin in v0.2.0=335724c95ba7b58d64ec97bbb67d18640123278e dev=25af7d627d1df1e515d27eda54ac58239a89c136; do
  name=${pin%%=*}
  commit=${pin#*=}
  dest=build/upstream/vela-$name
  if [ "$(cat "$dest/.zedge-pin" 2>/dev/null || true)" = "$commit" ]; then
    echo "$dest is already at $commit"
    continue
  fi
  rm -rf "$dest"
  mkdir -p "$dest"
  if [ -n "${VELA_UPSTREAM:-}" ]; then
    # git archive only reads the clone; a full hash cannot resolve to anything else.
    git -C "$VELA_UPSTREAM" archive "$commit" | tar -x -C "$dest"
  else
    archive=build/upstream/vela-$name.tar.gz
    curl -fsSL -o "$archive" "https://codeload.github.com/HorizenOfficial/vela/tar.gz/$commit"
    # GitHub names the top directory after the commit it archived.
    [ "$(tar -tzf "$archive" | head -n 1)" = "vela-$commit/" ] || { echo "fetch-upstream.sh: archive is not commit $commit" >&2; exit 1; }
    tar -xzf "$archive" --strip-components=1 -C "$dest"
    rm -f "$archive"
  fi
  [ -f "$dest/pkg/wasm/wasmtime_runtime.go" ] && [ -f "$dest/LICENSE" ] || { echo "fetch-upstream.sh: $dest is not a Vela source tree" >&2; exit 1; }
  # Upstream ships sample environment files. The test needs none of them.
  find "$dest" -name '.env*' -delete
  echo "$commit" > "$dest/.zedge-pin"
  echo "$dest is at $commit"
done
