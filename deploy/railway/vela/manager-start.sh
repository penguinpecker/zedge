#!/bin/sh
# ZEDGE Vela manager on Railway. Does what the mainnet recipe's compose.yml (stop_signal SIGKILL, key check) and watchdog.mjs
# (executor-drop restart, address check, bricked page) did on the Mac:
# - Railway stops a deployment only with SIGTERM (to this script, never to its children: tested 2026-10-07 on redeploy, restart
#   and down); on SIGTERM the manager would roll back a stateUpdate it already sent, which bricks it if that transaction mines.
#   Here SIGTERM becomes SIGKILL.
# - Nothing starts until a copied database is verified (/vela/.copy-verified): an empty volume never runs.
# - The executor never redials: when it drops, SIGKILL; Railway restarts the container.
# - Bricked ("unrecoverable disalignment") or started under the wrong address: hold, no restart loop.
set -u
hold() { echo "manager-start: HOLD: $*" >&2; exec sleep 2147483647; }
lc() { printf %s "$1" | tr A-Z a-z; }
[ -z "${VELA_HOLD:-}" ] || hold "VELA_HOLD is set" # the operator's pause switch: unset it and redeploy to start
[ -f /vela/.copy-verified ] || hold "no verified database on /vela"
want=$(lc "${VELA_MANAGER_ADDRESS:?}")
k=${MANAGER_KEY_SECP256:-}; unset MANAGER_KEY_SECP256
if [ ${#k} -ne 64 ] || [ -n "$(printf %s "$k" | tr -d 0-9a-fA-F)" ]; then echo "manager key: not 64 hex characters; refusing to start" >&2; exit 64; fi
mkdir -p "${MANAGER_DATA_FOLDER:?}" "${SHARED_DATA_FOLDER:?}" "${LOG_SERVER_FOLDER:?}"
m= g= r=
trap 'echo "manager-start: SIGTERM -> SIGKILL" >&2; kill -KILL $m $g 2>/dev/null; exit 143' TERM INT
su-exec appuser node /guard/rpcguard.mjs & g=$!
sleep 1
rm -f /tmp/out /tmp/hold; mkfifo /tmp/out
MANAGER_KEY_SECP256=$k /entrypoint.sh su-exec appuser /manager >/tmp/out 2>&1 & m=$!
unset k
( while kill -0 $g 2>/dev/null; do sleep 2; done; echo "manager-start: rpcguard exited" >&2; kill -KILL $m 2>/dev/null ) &
while IFS= read -r l; do
  printf '%s\n' "$l"
  case $l in
  *"failed to send message: not connected"*) echo "manager-start: executor dropped; SIGKILL, Railway restarts" >&2; kill -KILL $m ;;
  *"unrecoverable disalignment"*) : > /tmp/hold; kill -KILL $m ;;
  *"startup sequence complete - Ethereum address: "*) case $(lc "$l") in *"$want"*) ;; *) : > /tmp/hold; kill -KILL $m ;; esac ;;
  esac
done </tmp/out & r=$!
wait $m
wait $r # the reader ends at the pipe's end; only then is /tmp/hold certain
kill -KILL $g 2>/dev/null
[ -f /tmp/hold ] && hold "manager bricked or started under the wrong address; not restarting. Do not touch /vela (recovery: exit.mjs)"
exit 1
