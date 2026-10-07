#!/bin/sh
# Railway entrypoint for the ZEDGE Node services. Railway hands secrets over as variables; these services read
# secrets only from 0600 files. So: write the files on this container's own disk (never the volume), drop the
# variables, and exec node as PID 1 so Railway's SIGTERM reaches it. The volume admits one container at a time,
# so a lock left on it by a killed container is always stale. Only sizes are printed, never values.
set -eu
umask 077
d=$(mktemp -d)
put() { [ -n "$2" ] || { echo "start: $1 is empty" >&2; exit 64; }; printf '%s' "$2" > "$d/$1"; echo "start: $1 $(wc -c < "$d/$1") bytes"; }
put64() { [ -n "$2" ] || { echo "start: $1 is empty" >&2; exit 64; }; printf '%s' "$2" | base64 -d > "$d/$1"; echo "start: $1 $(wc -c < "$d/$1") bytes"; }
case "${ZEDGE_SERVICE:-}" in
house-bot)
  mkdir -p "$d/.config/zedge"
  put .config/zedge/house.key "${ZEDGE_HOUSE_KEY:-}"
  put .config/zedge/thirdweb.id "${ZEDGE_THIRDWEB_ID:-}"
  put .config/zedge/alchemy.key "${ZEDGE_ALCHEMY_KEY:-}"
  [ -z "${ZEDGE_HORIZEN_RPC:-}" ] || put .config/zedge/horizen.url "$ZEDGE_HORIZEN_RPC"
  unset ZEDGE_HOUSE_KEY ZEDGE_THIRDWEB_ID ZEDGE_ALCHEMY_KEY ZEDGE_HORIZEN_RPC
  export HOME="$d" # main.mjs reads $HOME/.config/zedge/*; its pid lock lands here, never on the volume
  set -- node --experimental-strip-types services/market-maker/main.mjs ${MM_ARGS:-run --mainnet} ;;
payout-signer)
  put payout-signer.key "${PAYOUT_SIGNER_KEY:-}"
  put64 payout-signer.env "${PAYOUT_SIGNER_ENV_B64:-}"
  # parseEnv keeps the last value: these replace the Mac paths inside the copied settings file
  printf '\nPAYOUT_SIGNER_KEY_FILE=%s\nPAYOUT_SIGNER_STATE_DIRECTORY=/data/payout-signer-state\n' "$d/payout-signer.key" >> "$d/payout-signer.env"
  [ -z "${ZEDGE_HORIZEN_RPC:-}" ] || printf 'PAYOUT_SIGNER_HORIZEN_RPC_URL=%s\n' "$ZEDGE_HORIZEN_RPC" >> "$d/payout-signer.env"
  rm -f /data/payout-signer-state/signer.lock # holds pid 1 after a kill, and the next node is pid 1 too
  unset PAYOUT_SIGNER_KEY PAYOUT_SIGNER_ENV_B64 ZEDGE_HORIZEN_RPC
  set -- node --experimental-strip-types services/payout-signer/main.mjs --settings "$d/payout-signer.env" ;;
keeper)
  put keeper-vela.key "${KEEPER_VELA_KEY:-}"
  put64 keeper.env "${KEEPER_ENV_B64:-}"
  printf '\nKEEPER_VELA_KEY_FILE=%s\n' "$d/keeper-vela.key" >> "$d/keeper.env"
  [ -z "${ZEDGE_HORIZEN_RPC:-}" ] || printf 'KEEPER_HORIZEN_RPC_URL=%s\n' "$ZEDGE_HORIZEN_RPC" >> "$d/keeper.env"
  rm -f /data/keeper-state/keeper.*.lock /data/keeper-state/keeper.*.live # another host's lock reads as live
  unset KEEPER_VELA_KEY KEEPER_ENV_B64 ZEDGE_HORIZEN_RPC
  set -- node services/keeper/main.mjs "${KEEPER_MODE:---watch}" --secrets "$d/keeper.env" --state-directory /data/keeper-state ;;
indexer)
  # DATABASE_URL: a reference to the Postgres service's private-network URL. No volume: the database is the state.
  put indexer.env "$(printf 'DATABASE_URL=%s\nINDEXER_HORIZEN_RPC_URL=%s\nINDEXER_SOLANA_RPC_URL=%s\n' "${DATABASE_URL:-}" "${ZEDGE_HORIZEN_RPC:-}" "${ZEDGE_SOLANA_RPC:-}")"
  unset DATABASE_URL ZEDGE_HORIZEN_RPC ZEDGE_SOLANA_RPC
  set -- node --experimental-strip-types services/indexer/main.mjs --settings "$d/indexer.env" ;;
*) echo "start: set ZEDGE_SERVICE to house-bot, payout-signer, keeper or indexer" >&2; exit 64 ;;
esac
exec "$@"
