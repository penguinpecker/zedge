# Fork rehearsal of the politics switch-over (2026-10-09/10)

The rehearsal that `docs/cutover-politics.md` (preparation step 3) and plan §12 require before any mainnet send. Everything ran on
local Anvil forks of Horizen 26514 and Base 8453, with the real Vela manager and executor images and throwaway keys for every
role. Nothing was sent to Horizen or Base mainnet, nothing on Railway or Vercel changed, and no file under `~/.config/zedge/` or
`contracts/.env.deploy.local` was read. Times are UTC. Every hash below is a fork transaction.

## Set-up

| What | How |
| --- | --- |
| Horizen fork | `anvil --fork-url https://26514.rpc.thirdweb.com --fork-block-number 28172247 --chain-id 26514 --block-time 1` (head at 18:12 on 10-09) |
| Base fork | `anvil --fork-url https://mainnet.base.org --fork-block-number 52390092 --chain-id 8453 --block-time 2` |
| Vela stack | The executor image Railway runs (`horizen/cce-executor@sha256:6ecff56f…`) and the manager image built from `deploy/railway/vela/manager.Dockerfile` (manager, rpcguard, `manager-start.sh`), compose project `zedge-reh`, pointed at the Horizen fork. |
| Operator | A throwaway manager key. On the fork only: its `UPDATE_STATUS_ROLE` on the live endpoint was written into storage, and the live authenticator's TEE signer and P-521 key were set to the local executor's with the deployer impersonated. |
| Base to Horizen delivery | Simulated: each vault message on the Base fork is executed on the Horizen fork by the real L2 messenger from the impersonated alias, 24 s later (measured live: 23–24 s). |
| Money | Real native USDC on the Base fork, moved from a real holder by impersonation: house 200, event house 40, users 6 each, site user 10. The vault's payout signer was set to a throwaway key (owner impersonated). |
| Keys | 41 throwaway keys in a 0600 folder of the git-ignored harness (`adapters/vela/stack/build/reh/`): manager, house, event house, resolver, a wrong resolver, keeper, keeper-vela, payout signer, relayer, registrar, the site user and u01…u30. |
| The old application | A **stand-in**: the live application's state is in the Railway manager's database, so no local manager can serve 7408397676477227659. Application 2261950499236545176 runs the live guest (`f38fb91e…`, the 10-07 build) with the live deploy request's constructor parameters (read from its transaction on the fork), a new `BookClockTrigger` proxy on the live implementation `0x6f85…` reading the live inbox, and the throwaway house. Its first tick credited the live inbox's 8 records, as the live application did, so the stand-in holds deposits 1…N like the real one. The cutover tools take it with `--old APP:TRIGGER:BLOCK` (fork only, commit `7cf2996`). |
| New guest | `7ce7ce61d90d7c48864d1d9c4d8811dd2b2e49874357d794464a670ccd51ab27` (700,282 bytes), the reproducible pol-core build. |

## Step log

The harness commands below run from `adapters/vela/stack/build/reh/` (git-ignored); the tools from the repository root.

### Bring-up and runbook step 1 (the guest to the manager)

- 18:13: the manager wrapper held on its empty volume ("HOLD: no verified database"), as on Railway; `vela-rehearsal-empty` marked it and the executor handshake took 16 s.
- 18:14: runbook step 1's pipe, with `railway ssh -p <project> -s manager` replaced by `docker compose exec -T manager` (same image, same path `/vela/shared-data/artifacts/blobs`): a 4,096-byte random file first, then the live guest `f38fb91e…` and the new guest `7ce7ce61…`. Each printed hash equals the local SHA-256 (bit-exact).
- `deploy-book --railway-project` ran its artifact check through a shim that turns `railway ssh -p P -s manager CMD` into the same `docker compose exec`: `PASS guest 7ce7ce61… in the Railway manager's artifact store`.

### The old application (stand-in)

- 18:20: `deploy-old.mjs`: trigger proxy `0x243cd8d8…` (242,244 gas), deploy request `0x9f3525a3…` (1,958,124 gas, block 28172684), completed in `0xa8729c71…` (operator 469,032 gas).
- The house's first sync `0xd450a789…` started its clock and credited the live inbox's records 1–8. Then the house (30 USDC, index 9, Base `0xf27a4813…`, 566,115 Base gas) and u01 (5 USDC, index 10, `0x5ed25094…`) deposited; both credited: 10 credit records.

### Runbook step 3: freeze (`cutover.mjs freeze`)

- Dry run against mainnet (read-only): deployer nonce 35; the implementation would land at `0x2bb67a7177ef9351df8a0ce61b4194d34f06da3d`, create gas estimate 1,697,065.
- `--fork` on the live trigger `0x9ca46470…`: implementation deployed `0x2003544e…` (block 28172935, 1,682,544 gas, at `0x87033a7f…` on the fork), upgrade `0x3eb4b482…` (block 28172936, 37,865 gas). `PASS … a tick gets 2 registry records and 0 deposit records`. A rerun: `already withdraw-only since block 28172936: nothing to send`.
- `--fork --trigger 0x243cd8d8… --implementation 0x87033a7f…` on the stand-in: upgrade `0x756c219b…` (block 28172952, 37,865 gas), PASS.

**The old application credits nothing new, withdrawals still pay** (`old-frozen.mjs`): u02 deposited after the freeze (indexes 11 and 12, Base `0x34c9a14e…` for 12); the stand-in's next sync `0xe4e6adff…` kept its credit records at 1…10 and asked for 11 again. u01 withdrew 2 USDC from it (`0xb9b5f852…`, applied, one payout record) and the old payout signer paid it on Base: `Paid(2261950499236545176, 1)` `0x0ef660ff…` (the script ran twice: ordinal 2 `0xb6df8b14…`).

### Runbook step 4: N (`cutover.mjs facts`)

`facts --fork … --old 2261950499236545176:0x243c…:28172684` (Base logs before the fork block through Tenderly's gateway, `logsplit.mjs`): every check PASS, `N = 10: depositsFrom for the new application (proven)`; vault depositCount 12, Σ Deposited 70.945550, 9 Paid 17.911260, held 53.034290 USDC; inbox highest 12, nothing in flight.

### Runbook step 5: the new application (`deploy-book.mjs --wait`)

```
deploy-book.mjs --fork … --house <throwaway> --resolver <throwaway> --deposits-from 10 --old <stand-in> --wait --railway-project REHEARSAL
```

- Proxy `0x7605d2e0…` (`0xde124a18…`, 242,244 gas); deploy request `0xe0d907dc…` (2,117,402 gas, block 28173450): application **698527611949929914**.
- `DeployRequestCompleted` status 0 in `0x4d2e1962…` (block 28173453, operator 497,296 gas); `PASS application … deployed: its state root is set`.
- Key registration `0xdff474ee…`; clock started: tick 1 at block 28173476 (18:55:15).
- `PASS depositsFrom 10 holds: no inbox index at or below it is credited, and the deposit asked for next (13) follows the credits above it`.
- `PASS BTC rounds 1791572400 and 1791573300 exist in the new application`.
- The event round: the event house's status shows it (`0xae7d3e07…`, registry ID `0x2e669c9c…`), and its first mint of 10 sets was applied (runbook step 10e's real check).

### Runbook steps 6 and 7

- `facts --new 698527611949929914:28173450`: old credit records only in (0, 10], new only in (10, …], each once, both books equations PASS.
- `write-orderbook-manifest.mjs … --rules public/events/us-house-2026.txt --events-out …`: both manifests written; the events manifest names the application, the deploy transaction, resolver and depositsFrom 10, and the site's parser accepts it.

### Runbook steps 8 and 9: services on the new application, the house moves its money (plan §12 item 7)

- Keeper (`services/keeper/main.mjs --watch --rehearsal`, both lanes; Base and Horizen through the bridge's endpoints): its order-book lane registered its key with the new application (`0xa376c656…`) and ran. Its first log line reads `firstSync: failed: no Secp521r1_PubKey found` after `key registered`: that is the probe sync that found no key, by design, not a failure.
- New payout signer (`services/payout-signer/main.mjs --rehearsal --manifest <new>`) and the old one (`--manifest <old>`) ran side by side with the same throwaway key.
- House, old application: `main.mjs withdraw 999999999` read 30.00 USDC free; `withdraw 30` applied; `Paid(2261950499236545176, 3)` `0x4e50bcaf…` (Base block 52391705), about 4 s after the request.
- House, new application: `main.mjs deposit 30` → index 13 (Base `0xe44ffee6…`); event house `deposit 20 --event` → index 14 (`0x2586a81f…`); both credited by the new application (cash 30.00 and 20.00 in their first receipts).
- `facts --new` at 22:16 (fork time) (43 deposits, 10 payouts, Σ Deposited 179.945550, Σ Paid 47.911260, vault 132.034290 USDC): old 10 credit records in (0, 10], 3 payout records all paid, private balances 30.945550; new 33 credit records in (10, 43], 115.000000 credited; every check PASS, exit 0.
- Indexer (`services/indexer/main.mjs`, Postgres 16, Horizen through a local TLS front because it takes https only): `indexing` from the deploy block − 1; `/v1/event` names the event round and its registry ID with `settle: null`; `/v1/live` carries the event house's quotes (`event.up.ask` 93¢) next to the BTC house's.

### BTC with the event present (plan §12 item 2)

Rounds of the new application, from the indexer (`/v1/rounds`; source 1 = Chainlink report through the keeper, 2 = registry record, 3 = timeout void):

| Round (UTC) | Open | Settle |
| --- | --- | --- |
| 19:15 | report | Down, report |
| 19:45 | registry | Down, registry |
| 21:30 | report | Down, report |
| 21:45 | report | Down, report |
| 22:00 | registry | Down, report |
| 22:15 | report | Up, report |

The BTC house minted and quoted every round it saw open (for example 22:30: sell Up 10 @ 79, sell Down 10 @ 26, buy Down 10 @ 12, then a cancel-all at the cutoff). The voided rounds in between (no opening) are the keeper's downtime while the fork was slow (below), not a guest refusal.

### The event (plan §12 items 5 and 8)

- Event house (`main.mjs run --event`): price from Kalshi 0.9005 (Polymarket does not resolve from this machine), quotes Yes 88/93, No 7/12; minted 10 sets (19:19), then sell Yes 5 @ 93, sell No 5 @ 12, buy Yes 5 @ 88, buy No 5 @ 7, 4-hour expiries; `GET /quotes` serves them.
- Its first sync ran out of gas at the SDK's exact estimate (`0xa4279977…`, 1,689,915 gas, `ReentrancySentryOOG`), which stopped the service: fixed in `89ca8a3` (estimate + 20 %, as the keeper and relayer send).
- Holders (`event-users.mjs`, each a throwaway wallet doing what a site user does: Base deposit, key registration, then one command): u04, u05, u06 bought 1 Yes at the ask 93 (`0x22056175…`, `0x9d0e4ca1…`, `0x9fa1ec93…`); u03 bought and closed (sold 1 Yes at the bid 88, `0x8ef8682a…`: cash 1.07 → 1.95); u09…u30 minted 1 set each (22 accounts). u07 and u08 placed buys at 93 that expired unfilled while the queue was stalled (below). With the site user, 32 accounts: the cap.
- Wrong signer (`resolve-try.mjs u02 wrongresolver yes`): public error `zedge: sender mismatch` (status 1, code 6), `0x90e189c3…`, no settle record.
- Before End (resolver's own signature, signed in-process because the signing tool itself refuses before End): receipt `rejected`, `resolve: refused by the engine`, judged at tick 93 (time 1791583856), `0x3bace255…`, no settle record.
- Forged registry record (`forge-test.mjs`): the new application's trigger proxy upgraded (deployer impersonated) to a hostile implementation whose every answer carries one well-formed record naming the event's registry round ID, first with outcome 1 (Yes), then 3 (void). Each forged tick applied with `applied 0, skipped 1` in its clock record (`0x580def07…`, `0x7703f7ab…`) and no settle record for the event; the proxy went back to `0x6f85…` (`0xf7204d36…`).

### The site (plan §12 item 8; task item 9)

One headless Chromium (`site-check.mjs`, `site-buy.mjs`) on the merged site in `vite --mode fork`, with the real relay function (`api/relay.ts`) behind a local server, Redis behind an Upstash-compatible REST server, the fork-mode test signer instead of Privy, the fork's manifests and the local indexer (commit `bb7e586`):

- Politics page at 1440 and 390 px: no horizontal overflow, no page errors; question, countdown, close times, the resolver line and the rules (hash-checked) render; the event house's prices appear once it quotes.
- As a user (the site user, the application's 32nd account): sign in, Unlock (key registration through the relayer, `0x2e9c775a…`), Deposit 3 USDC from Base through the relayer (Base `0xc9eef0e3…`, credited at index 43), Refresh balance, then the ticket's own **Buy Yes · 93¢** for 1 USDC: `Buy Yes: Filled`, trading balance 2.07 USDC, position "Yes 1 shares · pays 1 USDC if right · worth 0.88 USDC now".
- **Close · 88¢** was sent (`0xe152d878…`) but refused at its tick as `invalid order`: the site's one-click order rests 20 s, and on this fork a request reaches its tick 30–60 s later. The ticket then stayed on "Collecting result · The network is unavailable." (two collection syncs timed out at the relay's 8 s limit). No money moved; the share stayed and was paid at the result (below). On Horizen a tick follows in about 5–10 s.
- After the result, with the browser's clock set to the fork's time (`page.clock`): "Result: Yes … Result posted: Yes. Democrats won control of the House. Each Yes share paid 1 USDC. Settle record", at 1440 and 390 px, no errors.

### The days around the end (time warp; plan §12 items 2, 5, 6)

The keeper and both houses' BTC side were stopped first (no Chainlink report exists for a warped time); BTC boundaries were driven through the registry instead, with TEST observations relayed into the real price cache through the real messenger (`boundary.mjs`, as `fork-round.mjs` does). The event house kept running.

| Fork time (UTC) | What | Result |
| --- | --- | --- |
| 3 Nov 21:41:40 | warp (`evm_setNextBlockTimestamp`) | the first ticks voided the 9 October rounds left open (source 3 and registry voids) and created the next slots |
| 21:59:03 (cutoff − 57 s) | event house | its backstop `cancel_all` (`0xbe076b7e…`), applied: no order left; then `waiting: trading closed` |
| 22:00:00 | BTC boundary at the cutoff, one second before End | observation `0x09d1bb82…`; registry `recordOpening` for the round starting at 22:00 (`0xb65b2c9e…`); the next tick mirrored it: open record, source 2 (`0x27e6f1fc…`). No crash. |
| 22:01:35 | u09 sells 1 Yes after the cutoff | staged, then `rejected: round closed` at tick 143 |
| 22:04:12 | **the result**: `sign-event-result.mjs <resolver key> yes --out result.json` with the process clock set after End (the tool refused with the real clock: "no result is signed before the event's end"), then `sign-event-result.mjs submit result.json --fork … --settings <house>` | startup sync, then the result request `0x4ecd35e4…` (1,685,025 gas); receipt `resolve applied`; the operator's transition `0x81f944b4…` (639,566 gas) published the settle record kind 2, outcome 1 (Yes), price/time/hash 0, source 4, and the archive record. `/v1/event` shows it. |
| 22:15:01 | BTC boundary after End | observation `0x30565f29…`; registry resolves the 22:00 round Up (`0x45229c9d…`) and opens 22:15 (`0xc53e398f…`); one tick mirrored both (`0x10ad3c2f…`). No crash. |
| 1 Feb 2027 00:00 | warp past `voidableAfter` (1801439999); the second application's holders sync | **timeout void**: settle record kind 3, outcome 3, source 3 for its event (`0xdd8e39ec…`, the tick's transition 549,439 gas) |

## Gas

### Tick gas with the event present (plan §12 item 4; task item 10)

`gasshape.mjs` groups each operator transition by the shape of the trigger's answer it carried (registry records, deposits), so applications are compared at the same work. The stand-in runs the live guest `f38fb91e…` on the same fork and the same trigger implementation; the live application was read from mainnet (read-only, the last 8,000 blocks).

| Transition | New application (event live) | Stand-in (live guest, same fork) | Live application 7408… (mainnet) |
| --- | --- | --- | --- |
| tick, no record, no deposit | 170,193–170,222 (n = 46) | 170,193–170,222 (n = 7) | — |
| tick, 1 record | 213,308–297,316, median 217,816 (n = 24) | 213,346–246,979 (n = 2) | — |
| tick, 2 records | 258,710–355,218 (n = 3) | — | 301,916–301,955 (n = 9) |
| tick, 0 records, 8 deposits | 337,196–337,205 | — | — |
| request (sync or command) asking a tick with no record | 951,328–999,680, median 975,009 (n = 46) | 941,700–974,932, median 951,376 (n = 7) | — |
| request asking a tick with 2 records | 1,251,935–1,291,347 (n = 3) | — | 666,397–1,511,349, median 1,511,169 (n = 18) |

The event adds nothing to a tick: the guest never asks the trigger about it, and the BTC tick request is byte-identical. Within one shape the spread follows the number of BTC rounds a request asks about (each costs a registry read and 32 bytes of payload), not the event. The live application's requests are mostly the keeper's reports, whose answers carry more records.

### Transactions

| Transaction | Gas |
| --- | --- |
| Freeze: deploy `WithdrawOnlyBookClockTrigger` | 1,682,544 |
| Freeze: upgrade (each trigger) | 37,865 |
| New trigger proxy | 242,244 |
| Deploy request (`submitDeployRequestWithTrigger`) | 2,117,402 |
| The operator's completion of the deploy | 497,296 (live guest: 469,032) |
| Key registration (request) | 321,961–322,016; operator 164,7xx |
| A sync or command (request, 2,076-byte payload) | 1,684,893–1,685,080 |
| Base deposit (`depositWithPermit`) | 566,1xx Base gas |
| **The event's result (request)** | **1,685,025** |
| **Its transition (every holder paid, settle and archive records)** | **639,566** |
| A refused result: wrong signer (failed request) / before End (rejected) | operator 385,442 / 605,744 |
| The timeout void's tick (with three BTC voids) | 549,439 |

At Horizen's cap of 2,000,504 wei, the result costs its sender about 0.0000034 ETH plus a sync, and the operator about 0.0000013 ETH.

### Every holder paid (read back from each account's own view after the result)

| Accounts | Before | After |
| --- | --- | --- |
| u04, u05, u06 (1 Yes, bought at 93) | 1.07 USDC | 2.07 USDC, no shares |
| the site user (1 Yes, bought on the site) | 2.07 | 3.07, no shares |
| u09 … u30, 22 accounts (1 Yes + 1 No, minted) | 1.00 | 2.00, no shares |
| event house (6 Yes, 10 No) | 13.77 | 19.77; then `withdraw 19.77 --event` from the (frozen) application, paid on Base by the new payout signer: `Paid(698527611949929914, 1)` `0xd9e1b10c…` |
| controls: u03 (closed before), u07, u08 (no shares) | 1.95, 2.00, 2.00 | unchanged |

27 holders, 32 Yes shares, paid in the one result transition; each holder's nonce moved by one (the sweep redeems in the account's own name).

### The timeout void, second application (plan §12 item 6; task item 7)

The first new application's trigger was frozen with the tools (`cutover.mjs freeze --trigger 0x7605… --implementation 0x8703…`, `0x5890fd33…`, the rollback row's first step), and a second application was deployed with `deploy-book.mjs --deposits-from 43 --old 698527611949929914:0x7605…:28173450 --wait` (application **6559368445607932608**, deploy request `0x2444ad45…`; the first run stopped on an RPC timeout during the first sync, the rerun completed). Its holders: u01 and u03 deposited 2 USDC each (indexes 44 and 45, credited by the second application only: the frozen first one has no credit record for them); u01 minted 2 sets and sold its 2 No at 40 to u03.

| Holder | Before the void | After (1 Feb 2027) |
| --- | --- | --- |
| u01 | 2 Yes, 0.80 USDC | 1.80 USDC (2 × 0.50), no shares |
| u03 | 2 No, 1.20 USDC | 2.20 USDC (2 × 0.50), no shares |

`cutover.mjs thaw --trigger <stand-in>` then refused: "a thaw could credit a deposit twice: application 6559368445607932608 … credits deposits: freeze it first; application 7408397676477227659 has credited 8 deposits: forward-fix only, never thaw; application 698527611949929914 has credited 33 deposits: forward-fix only, never thaw; …".

### Final reconciliation

`facts --new 698527611949929914:28173450` at the end: vault depositCount 45, Σ Deposited 183.945550, 11 Paid 67.681260, held 116.264290 USDC (exactly the difference); every inbox record present; old application 10 credits, 3 payouts all paid; new application 33 credits, 1 payout paid; every check PASS.

## What broke and how it was fixed

Committed (author penguinpecker, not pushed):

- `89ca8a3` **Market maker: requests carry the estimate plus 20 %.** The event house's first sync landed in the same block as the BTC house's and ran out of gas at the SDK's exact estimate (`0xa4279977…`, 1,689,915 gas, `ReentrancySentryOOG`); the startup failure stopped the service. The keeper and the relayer already add 20 %.
- `7eca83b` **Resolver tool: the signed result file is written owner-only.** `--out` wrote the result with mode 644; after the end it settles the event for whoever sends it. Now 600, with a test.
- `7cf2996` **Cutover tools: `--old APP:TRIGGER:BLOCK` and `facts --fork`** (fork only), so a rehearsal can name its stand-in old application.
- `bb7e586` **Fork mode: the site reads the events manifest and a local indexer** (with the application's origin, which the indexer requires).

Harness only (git-ignored, `adapters/vela/stack/build/reh/`):

- The simulated bridge dropped one delivery after an RPC timeout (inbox index 19 missing while 20–42 landed). The guest credits only consecutive indexes, so 24 deposits waited; `facts` would have failed its inbox check. Replayed with `relay-missing.mjs` (`0xdb855296…`); the bridge now retries.
- The fork fetches every fresh storage slot from the public gateway (about 0.5 s each, about 70 per request), so a request took 30–60 s to reach its tick. Speed-ups: a client-side write of zeros into the slots a request will take, and a JSON-RPC front doing the same for the relay function (whose 8 s RPC timeout the fork otherwise exceeds). A first version also zeroed the queue's order entry for the next tails, which erased another client's entry once and stalled the queue for 10 minutes; it was repaired from the requests' own IDs (`queue-repair.mjs`) and the order slots are no longer touched.
- Re-running the key step had regenerated the Redis token the relay harness uses; it now keeps an existing one.

No defect was found in the guest, the engine, the trigger contracts, the keeper, the indexer, the payout signer or the site's money paths.

## Not rehearsed, and why

- **`railway ssh`**: replaced by `docker compose exec` into the same manager image; the real CLI against the real project is untested. The path `/vela/shared-data` is the image's, still to be confirmed on Railway (preparation step 8).
- **The live old application** 7408397676477227659: its state is in the Railway manager's database. A stand-in with the same guest, parameters and the live inbox's records took its place.
- **Chainlink reports after a time warp**: none exist for a future time, so the boundaries next to the event's end ran through the registry (TEST observations). The report path at a boundary equal to the event's end is covered by the guest's native `TestEventReportAtItsEnd` only; reports at real boundaries with the event live ran all evening (above).
- **Polymarket**: it does not resolve from this machine; the event house priced from Kalshi alone. The owner's rule "Polymarket alone when Kalshi is down" (`759e6a8`) is unit-tested only, and reachability from Railway is still to be checked there.
- **Real hardware speed**: everything here ran on a fork whose fresh-slot fetches made each request 30–60 s; the site's 20 s one-click orders and the relay's 8 s RPC timeout are tuned for Horizen itself.
- **The indexer reset SQL** on the shared database (step 8c): the rehearsal's indexer started on a fresh database. The indexer lane tested the statement on Postgres.
- **Owner-key and account steps**: Railway services, Vercel, the owner's key files, and the house-bot dry-run toggles.
- **The indexer's and the site's cutoff and result rules use the wall clock**, so on the warped fork `/v1/live` kept an (empty) event quote after the cutoff and the site needed its clock set to show the result; on Horizen the chain and the wall clock agree.

## Runbook changes made (`docs/cutover-politics.md`)

- Step 1: a missing wasm path is stopped before the pipe, and the check names the empty-file hash a wrong path would print.
- Step 4: what a missing inbox record means and what to do (replay the failed delivery).
- Step 5: rerunning after a timeout in the first syncs, as rehearsed.
- Steps 8e and 9.3: the event house's commands; step 10c: a one-click close refused as `invalid order` just expired; step 10e: the real check is the event house's first mint receipt.
- Preparation step 5: the measured gas, including the result's.
- Limits: the next replacement of this application needs `cutover.mjs`'s proof of N changed first (it assumes credits start at index 1).
