#!/bin/sh
# EVALUATION ONLY: stops the local Vela stack started by up.sh and removes its
# containers and volumes, by compose project name only. The pulled upstream
# images and the fetched starter kit in build/ are kept. (Software TEE, no
# attestation, test token, fixture oracle; sender, amount and time trusted from
# the manager. Not private, not secure, not production-ready.)
set -eu
cd "$(dirname "$0")"
. ./lib.sh
[ -f "$KIT/dockerfiles/docker-compose.yml" ] || { echo "down.sh: nothing fetched, nothing to stop"; exit 0; }
compose down -v --remove-orphans 2>&1 | grep -v -e ' Stop' -e ' Remov' || true
echo "down.sh: project $PROJECT stopped; its containers and volumes are removed"
