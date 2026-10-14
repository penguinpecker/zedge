# Stop / resume manifest

"Stop" means **no wallet of ours sends a transaction** until "resume". Work through every row, in order, and tick it.
Railway projects: `zedge` and `zedge-vela` (ids in the local ops notes).
A `railway` command needs a linked directory (`railway link -p <project> -s <service> -e production`); backboard timeouts are
common, rerun until the answer is "No deployments found" (stop) or a deployment id (resume).

## What burns gas when it runs

| # | Service | Project / service | Wallet | Burns gas when | Stop | Resume |
|---|---|---|---|---|---|---|
| 1 | BTC house bot | zedge / `house-bot` | house 0xac8d…1ab5 (Horizen) | every quote, mint, cancel (~0.0002 ETH a round) | `railway down -s house-bot -y` — on SIGTERM it cancels its quotes first (log `cancel_all` → `stopped`) | `railway up <export> --path-as-root -s house-bot --ci` |
| 2 | Event house bot | zedge / `event-house` | event house 0xebc7…2c2c (Horizen) | same as 1 | `railway down -s event-house -y` | `railway up <export> --path-as-root -s event-house --ci` |
| 3 | Keeper | zedge / `keeper` | registry lane 0xaa6a…91d7 (Base publishes + Horizen rounds), book lane 0xa867…57d3 (ticks on Horizen) | every 15-min boundary (~0.0007 ETH a day on Base) and every tick | `railway down -s keeper -y` | `railway up <export> --path-as-root -s keeper --ci` |
| 4 | Vela manager (operator) | zedge-vela / `manager` | operator 0x3b26…3861 (Horizen) | every request it completes (~0.6× the house's gas) | **only when 1–3 are down and idle** (operator nonce latest == pending): `railway variables --set VELA_HOLD=1 -s manager` then `railway redeploy -s manager -y`; log must show `manager-start: HOLD: VELA_HOLD is set` | `railway variable delete VELA_HOLD -s manager` (no `--unset` flag exists) then `railway redeploy -s manager -y`; log shows the manager polling again |
| 5 | Vela executor | zedge-vela / `executor` | none | never (no sends) | leave running | — |
| 6 | Payout signer | zedge / `payout-signer-2` | payout signer 0xbd85…1839 (Base) | only when a payout record exists | leave running (idle = no gas) | — |
| 7 | Relayer | Vercel `/api/relay` | relayer 0x9336…d024 (Base deposits, Horizen requests) | only when a user deposits or trades | leave running; with 4 on hold no request completes anyway | — |
| 8 | Indexer + Postgres | zedge / `indexer` | none | never | leave running | — |

Order to stop: 1, 2, 3, then 4. Order to resume: 4 first, wait for it to poll, then 3, then 1 and 2 (the bots need an open round).

## Stop checklist

- [ ] `house-bot` down, last log `stopped`
- [ ] `event-house` down, last log `stopped`
- [ ] `keeper` down
- [ ] operator nonce latest == pending on Horizen (`eth_getTransactionCount` both tags)
- [ ] manager `VELA_HOLD=1`, redeployed, log `HOLD`
- [ ] 10 minutes later: nonces of 0xac8d, 0xebc7, 0xaa6a, 0xa867, 0x3b26 unchanged on Horizen, 0xaa6a and 0xbd85 unchanged on Base
- [ ] ops log entry with times and balances

## Resume checklist

- [ ] manager `VELA_HOLD` unset, redeployed, log shows polling (not `HOLD`)
- [ ] keeper up; next 15-min boundary opens a round (`/v1/live` `rounds[].open` not null)
- [ ] house-bot and event-house up from the same export; logs show `round open` then `market` with quotes
- [ ] `/v1/live` shows house `up.ask` / `down.ask` within one round
- [ ] balances read on both chains and written to the ops log

## Side effects of a stop

- The site shows no Up/Down prices and, after the next boundary, no new round. Open positions stay in the ledger and settle when the keeper is back; a round whose closing price was never delivered is voided and paid half-and-half.
- Deposits still land in the vault on Base and credit when the manager resumes.
- Nothing about keys or balances changes. Gas left on each wallet is exactly what was there at the stop.
