#!/bin/sh
# EVALUATION ONLY: brings up the local Vela v0.2.0 stack for the ZEDGE guest
# slice on chain 31337. Software TEE with fixed development keys and no
# attestation; a worthless 6-decimal test token; an unsigned fixture oracle;
# sender, amount and time are trusted from the manager. Not private, not
# secure, not production-ready.
#
# Fetches the Vela starter kit at a pinned commit into build/ (git-ignored; the
# kit has no licence file, so it is used in place and never copied into the
# repository), starts it under its own compose project with compose.override.yml
# (amd64, not privileged, no /dev/vsock), waits for the executor/manager keyset
# handshake and writes the manifest.
#
#   ./up.sh                                  # fetch from GitHub if needed
#   VELA_STARTERKIT=/path/to/clone ./up.sh   # fetch from a local clone, no network
set -eu
cd "$(dirname "$0")"
. ./lib.sh

if [ "$(cat "$KIT/.zedge-pin" 2>/dev/null || true)" != "$KIT_COMMIT" ]; then
  rm -rf "$KIT"
  mkdir -p "$KIT"
  if [ -n "${VELA_STARTERKIT:-}" ]; then
    git -C "$VELA_STARTERKIT" archive "$KIT_COMMIT" | tar -x -C "$KIT"
  else
    archive=build/vela-starterkit.tar.gz
    curl -fsSL -o "$archive" "https://codeload.github.com/HorizenOfficial/vela-starterkit/tar.gz/$KIT_COMMIT"
    [ "$(tar -tzf "$archive" | head -n 1)" = "vela-starterkit-$KIT_COMMIT/" ] || { echo "up.sh: archive is not commit $KIT_COMMIT" >&2; exit 1; }
    tar -xzf "$archive" --strip-components=1 -C "$KIT"
    rm -f "$archive"
  fi
  # The kit's sample environment file is passed to compose by path and never read
  # here. Any other environment file it ships is removed unread.
  find "$KIT" -name '.env*' ! -path "$KIT/dockerfiles/.env.dev" -delete
  [ -f "$KIT/dockerfiles/docker-compose.yml" ] && [ -f "$KIT/dockerfiles/.env.dev" ] || { echo "up.sh: $KIT is not the starter kit" >&2; exit 1; }
  echo "$KIT_COMMIT" > "$KIT/.zedge-pin"
fi

started=$(date +%s)
compose up -d --quiet-pull 2>&1 | grep -v -e ' Creat' -e ' Start' -e ' Wait' -e ' Healthy' -e ' Exited' -e ' Running' || true

# The manager logs this once the executor has given it the keyset (first start)
# or has restored it from the manager's database (restart).
deadline=$((started + 300))
until compose logs manager executor 2>/dev/null | grep -q 'Executor: Handshake successful'; do
  [ "$(date +%s)" -lt "$deadline" ] || { echo "up.sh: no executor/manager handshake after 300 s" >&2; compose ps >&2; exit 1; }
  sleep 2
done
echo "up.sh: stack up and handshake done in $(( $(date +%s) - started )) s (project $PROJECT)"

node --experimental-strip-types slice.mjs manifest
