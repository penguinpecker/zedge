# Cutover: the combined BTC + event application, without stopping BTC

The live private book is application `7408397676477227659` (the **old application**), with trigger proxy `0x9ca46470b05350384c31c8b236af4df638cbb30d` on implementation `0x6f8500186ccb07e3c14ff7bbf1c9b5c05b8ca9a8`. It is replaced by one **new application** that runs BTC 15-minute rounds and the event "Will Democrats win control of the US House in the 3 November 2026 midterms?" (Yes = Up, No = Down).

The order is fixed:

1. Freeze the old application's deposits. Its trigger proxy is upgraded to `WithdrawOnlyBookClockTrigger`: same clock and registry records, never a deposit record. From then on the old application can trade, settle and withdraw, but credits no new Base deposit.
2. Read N, the last inbox index the old application processed.
3. Deploy the new application with `depositsFrom = N`. It credits only inbox indexes above N.

So no deposit is ever credited by both applications, and the old payout signer can keep paying old-application withdrawals.

Owner decisions (2026-10-09) built into the tools:

- Trading cutoff 1793743200 (3 Nov 2026 22:00:00 UTC). End 1793743201, off the 900 s grid.
- Void only by timeout after 1801439999 (31 Jan 2027 23:59:59 UTC).
- A new, dedicated resolver wallet.
- Stake limits as today: 50 per account per round, 200 for all accounts, house 2,000.
- No new Chainlink digest.

## Who does what

| Mark | Meaning |
| --- | --- |
| **OWNER KEY** | Sends with the deployer key (`contracts/.env.deploy.local`, read by `loadAccount`) or the house key (`~/.config/zedge/house.key`). Only the owner runs these, after his go. |
| **OWNER ACCOUNT** | Uses the owner's Railway, Vercel or GitHub login. Never touches a key. |
| read-only | Public RPCs only, no key. Anyone may run these, at any time. |

## Tools

All are in this repository.

- **`adapters/vela/stack/contracts`**: `WithdrawOnlyBookClockTrigger`.
  - Build it: `cd adapters/vela/stack/contracts && forge build`.
  - The live-fork proof: `HORIZEN_FORK_RPC=https://26514.rpc.thirdweb.com forge test --mc WithdrawOnlyFork -vv`. It upgrades the live proxy on a local fork and checks, byte for byte, that the clock words and registry records do not change and that the deposit records go away.
- **`adapters/vela/stack/cutover.mjs facts [--new APP:DEPLOY_BLOCK] [--base-rpc URL]`** (read-only). Prints and checks:
  - the deploy slots;
  - the old trigger's code and owner;
  - the inbox against the vault's `Deposited` events;
  - each application's credit and payout records against the vault's `Deposited` and `Paid` events;
  - N, once it is proven;
  - the wallets' balances.

  It exits 1 if any check fails.
- **`adapters/vela/stack/cutover.mjs freeze`**. A dry run unless `--fork URL` (a local Anvil fork) or `--broadcast-mainnet` (OWNER KEY). `--trigger` freezes another trigger proxy; `--implementation` reuses an already deployed `WithdrawOnlyBookClockTrigger`.
- **`adapters/vela/stack/cutover.mjs thaw`**. Rollback only, same modes. Upgrades a trigger back to the live `BookClockTrigger` implementation. It refuses while any other application on the same inbox (deployed, or its deploy request still pending) is not withdraw-only, has a credit record, or has applied no tick asked after its freeze.
- **`adapters/vela/stack/deploy-book.mjs`**. The new application: `--fork` (rehearsal) or `--broadcast-mainnet` (OWNER KEY).
- **`scripts/write-orderbook-manifest.mjs`** (read-only). Writes `public/deployments/26514-orderbook.json` (same shape as today) and `public/deployments/26514-events.json` (event, resolver, depositsFrom).

## Before the day

None of these steps sends anything.

1. **Legal.** The owner launches at his own risk (owner decision). The site still says "only where lawful" and has no geoblocking.
2. **Code.** Engine, guest, site, house, event house and indexer lanes are merged and CI is green.
   - Build the guest with TinyGo (`adapters/vela/guest/build.sh`) and record its SHA-256 twice, from two clean builds.
   - `public/events/us-house-2026.txt` is committed. The Keccak-256 of its exact bytes becomes the question hash; `deploy-book.mjs` prints it, and the manifest writer checks the served file against it.
3. **Rehearsal on a fork**, with the new guest.
   - Plain fork:
     1. `anvil --fork-url https://26514.rpc.thirdweb.com --chain-id 26514 --port 48545`.
     2. `node adapters/vela/stack/cutover.mjs freeze --fork http://127.0.0.1:48545`.
     3. `node adapters/vela/stack/deploy-book.mjs --fork http://127.0.0.1:48545 --resolver <address> --deposits-from <N from facts>`.
     4. The manifest writer against the fork.
   - With a manager on the fork (lean e2e stack): the same with `--wait`. This proves the completion, the key registration, the clock record, rounds T1 and T2 and `nextDeposit = N + 1`.
   - The lean e2e `up.sh` still calls the old path `build/mainnet-recipe/deploy-book.mjs`. Point it at `adapters/vela/stack/deploy-book.mjs` and add `--resolver` and `--deposits-from`.
4. **Wallets** (OWNER, in his own Terminal; never printed, never pasted into a chat).
   - The resolver wallet: a new key, file mode 0600, kept offline with a backup. Only its address is used here, and it must never send a transaction (`deploy-book.mjs` refuses an address with any Horizen transaction).
   - Check the address before step 5: sign a test result with the resolver-signing tool (resolver lane) and check that it recovers to the address you will pass as `--resolver`. A wrong address can never settle the event; it would only void on 31 Jan 2027.
   - The event house wallet (event house lane).
5. **Gas** (OWNER). Top up to at least a day of runway at today's burn: house about 0.0074 and operator about 0.0064 ETH a day on Horizen, plus keeper-vela and the relayer. The deployer needs about 0.00002 ETH on Horizen for the whole cutover. Measured on a fork:

   | Transaction | Gas | ETH at the 2,000,504 wei cap |
   | --- | --- | --- |
   | Freeze: deploy the implementation | 1,682,544 | about 0.0000034, for both freeze transactions |
   | Freeze: upgrade | 37,865 | (included above) |
   | New trigger proxy | 242,244 | about 0.0000047, for proxy and request |
   | Deploy request | about 2,117,438 | (included above) |
   | Key registration | about 1.6M | about 0.00001, for the key and both syncs |
   | Each of the two syncs | about 1.7M | (included above) |

6. **Old-application balances.** Run `node adapters/vela/stack/cutover.mjs facts`.
   - The line `old application …: private balances (credited − withdrawn)` is everything held there: cash and shares.
   - Compare it with the house's own balance: every `receipt` line in the house-bot's Railway log shows its cash and holdings.
   - **Anything above the house's balance belongs to users.** After the freeze the site fails closed on the old application, and after the switch it shows only the new one, so users would have no way to withdraw. Announce a withdrawal window and wait until it is only the house's, or stop here.
7. **New Railway service for the new payout signer** (OWNER ACCOUNT): same image and `ZEDGE_SERVICE=payout-signer`, its own volume at `/data`, and the same two sealed variables as today's payout signer. Create it, but do not deploy it yet.
   - **Never redeploy today's payout-signer service from the new export.** It keeps serving the old application until every old balance is withdrawn.
   - The two run with one key. Expect an occasional dropped Base transaction, which the signer re-sends. The vault pays each `(application, ordinal)` once.
8. **Confirm the manager's artifact folder** (OWNER ACCOUNT, read-only): `railway ssh -p <zedge-vela project ID> -s manager printenv SHARED_DATA_FOLDER`. The tools assume `/vela/shared-data`, so blobs go in `/vela/shared-data/artifacts/blobs`. If the value differs, pass `--blobs <it>/artifacts/blobs` to `deploy-book.mjs`.

**Go/no-go before step 1:**

- `facts` exits 0, the old trigger is `BookClockTrigger`, and at least 1 deploy slot is free.
- The old-application balances are the house's only.
- Gas is topped up.
- The rehearsal passed.

## The day

Pick T0 a minute after a 15-minute boundary, so that the new application's first sync lands well inside the slot. BTC keeps running throughout:

- the old application settles its own rounds until the keeper is switched;
- the public registry market is not touched.

From step 3 until step 8f is live, the site's private trading fails closed, because it pins the old trigger's implementation (`src/chain/orderbook-manifest.ts`). Prepare steps 7 and 8 so that this window is about 10 minutes.

### 1. Copy the guest to the manager

OWNER ACCOUNT. No restart, no `VELA_HOLD`, never `vela-load-*` or `vela-commit`.

```sh
SHA=$(shasum -a 256 adapters/vela/guest/build/zedge_guest.wasm | cut -d' ' -f1); B=/vela/shared-data/artifacts/blobs
base64 < adapters/vela/guest/build/zedge_guest.wasm | railway ssh -p <zedge-vela project ID> -s manager \
  "sh -c 'mkdir -p $B && base64 -d > $B/$SHA.wasm.tmp && chmod 644 $B/$SHA.wasm.tmp && mv $B/$SHA.wasm.tmp $B/$SHA.wasm && sha256sum $B/$SHA.wasm'"
```

**Check:** the printed hash is `$SHA`. An unused blob is inert, so this can be done any time before step 5. Try the same pipe with a small file first: this stdin path was proven bit-exact at 3 MB on 2026-10-07, through the image's own helpers.

### 2. Pause the BTC house

OWNER ACCOUNT. Set `MM_ARGS='run --mainnet --dry-run'` on house-bot, then `railway redeploy -s house-bot --yes`. It cancels its orders on SIGTERM.

**Check:** its log shows `dryRun: true`.

### 3. Freeze the old application's deposits

OWNER KEY.

```sh
node adapters/vela/stack/cutover.mjs freeze                       # dry run: prints both transactions (nonce, to, data)
node adapters/vela/stack/cutover.mjs freeze --broadcast-mainnet   # after the go
```

**Check:** `PASS the proxy runs WithdrawOnlyBookClockTrigger at …, its state is unchanged, and a tick gets … registry records and 0 deposit records`. Write down the freeze block. A rerun prints `already withdraw-only since block …`.

If the deploy transaction landed but the upgrade did not, rerun with `--implementation <the deployed address>`.

### 4. Read N

read-only.

1. Wait for the old application to apply a tick asked after the freeze. The keeper's sync at boundary + 45 s does it, or any old-application request.
2. Run `node adapters/vela/stack/cutover.mjs facts`.

**Go/no-go** (all must hold, or stop and see Rollback):

- `old trigger …: … (WithdrawOnlyBookClockTrigger, since block <freeze block>)`.
- `N = <n>: depositsFrom for the new application (proven)`.
- Every check line passes, in particular:
  - `old: Σ Deposited(0, N] − Σ Paid = credited − withdrawn + unpaid + not yet credited`;
  - `every inbox record 1…highest is present and equals its Deposited event`.
- `deliveries in flight from Base` may be above 0: they are indexes above N, and the new application credits them.

### 5. Deploy the new application

OWNER KEY.

```sh
node adapters/vela/stack/deploy-book.mjs --broadcast-mainnet --resolver <resolver address> --deposits-from <N> \
  --railway-project <zedge-vela project ID>
```

It refuses to send in any of these cases:

- N is not proven, or `--deposits-from` differs from it;
- the resolver is any deployment role or has sent a transaction;
- the trigger implementation is not this source's `BookClockTrigger`;
- another application on the inbox (deployed, or an earlier run's pending request) is not withdraw-only;
- the guest's SHA-256 is not in the manager's blobs.

**Check**, all `PASS`:

- the endpoint, the trigger and the registry;
- `guest … in the Railway manager's artifact store`;
- `application … deployed: its state root is set`, after `DeployRequestCompleted` with status 0;
- `depositsFrom <N> holds: no inbox index at or below it is credited, and the deposit asked for next (…) follows the credits above it`;
- `BTC rounds T1 and T2 … exist in the new application`.

Write down the application ID, the trigger, the deploy transaction and the block (all printed; also in `evidence/vela-book-politics/checkpoint.json`).

The event round does not appear in any public record (the guest never asks the trigger about it). Step 10e confirms it.

A rerun is safe at any point: done steps are read back, and the syncs are repeated only as needed.

### 6. The other application's view

read-only. Run `node adapters/vela/stack/cutover.mjs facts --new <application>:<deploy block>`.

**Check:**

- `old: every credit record is an index in (0, N]`;
- `new: every credit record is an index in (N, …]`;
- `new: the credit records number N+1… once each`;
- both books equations pass.

### 7. Manifests

Read-only, then OWNER ACCOUNT for the push.

```sh
node scripts/write-orderbook-manifest.mjs --rpc https://26514.rpc.thirdweb.com --base-rpc https://base-rpc.publicnode.com \
  --checkpoint evidence/vela-mainnet/checkpoint.json --deploy-tx <deploy tx> --relayer 0x9336887b575f11da697f53614d0f2a262dded024 \
  --out public/deployments/26514-orderbook.json --rules public/events/us-house-2026.txt --events-out public/deployments/26514-events.json
```

Then:

1. Update the pinned IDs in `src/chain/orderbook.test.ts` (application, trigger) and `services/indexer/rows.test.mjs`.
2. Run `npm run check` and the service tests.
3. Commit, wait for the owner's "ship", push, and check CI.

### 8. Switch the services

OWNER ACCOUNT. Use one `git archive` export of that commit and redeploy each with `railway up <export> --path-as-root -s <service> --ci`.

| Order | Service | Check |
| --- | --- | --- |
| a | **New** payout-signer service (step 7 of the preparation) | Log shows the new application ID. Today's payout signer keeps running untouched. |
| b | keeper (not within 30 s before to 60 s after a boundary) | Order-book lane `running … application <new>`; registry lane unchanged. |
| c | indexer | Same database. It serves at once and logs `waiting` until the reset in `services/indexer/README.md` (Switch-over): once the old indexer deployment is removed, run that SQL; then `indexing` from the new deploy block − 1, prices and the old rows kept. |
| d | house-bot | Still `--dry-run`. |
| e | event house | Dry run (event house lane). |
| f | Vercel: site and relayer from the same export | The served `index-<hash>.js` equals a local build of the export. `/deployments/26514-orderbook.json` names the new application. A private-trading tab verifies again. |

### 9. Move the house's money

OWNER KEY, the house key, with the Railway bot in dry run.

1. **Old application.** Use a checkout of the commit before step 7, whose committed manifest is the old one. Wait until the house holds no shares in an unsettled round. Then:
   1. Run `withdraw 999999999 --mainnet` to read the free cash.
   2. Run `withdraw <that cash> --mainnet`.

   **Check:** vault `Paid(7408397676477227659, <ordinal>)` within about a minute (old payout signer), and `facts` shows that the house's part of the old balances is gone. The old payout signer may be stopped once `facts` shows the old application's private balances at 0 and no unpaid payout record.
2. **New application.** From the new commit: `deposit <amount> --mainnet`. Its index is above N.

   **Check:** `facts --new …` shows a new credit record at that index and none in the old application. Then set `MM_ARGS` back and redeploy house-bot.
3. **Event house.** Its deposit and go-live (event house lane).

### 10. Checks at the next boundaries

- a. The keeper's report opens the round in the new application: a settle record, source 1. `/v1/live` shows house quotes.
- b. **BTC smoke test** with the owner's test wallet: deposit 1 USDC, buy, close, withdraw.
  - **Check:** the credit record is in the new application only, and vault `Paid(<new>, 1)`.
- c. **Event smoke test:** buy 1 Yes at the house ask, then close it.
- d. `facts --new …`: every check passes. `vault USDC ≥ Σ Deposited − Σ Paid`.
- e. The event round exists: the event house shows it open, and a 1-lot mint for it is accepted. A refusal for an unknown round means the guest did not create it. Then forward-fix: there is no way back once the new application has credited anything.
- f. Records: `records.txt`, the handoff and the MAINNET docs, with the freeze block, N, the application, the trigger, the transactions and the facts output.

## Rollback

There are three rules. They follow from one fact: two applications read one inbox.

1. **At most one application may credit deposits at any time.** Only an application whose trigger is not withdraw-only credits deposits. Never let two do it.
2. **A payout signer may serve an application only if that application is the only one crediting deposits, or its deposits are frozen.** The old payout signer is safe from step 3 on because the old application is frozen. Never start a payout signer for an application whose deposits are not frozen while another application also credits.
3. **Forward-fix only once the new application has credited anything** (any credit record in `facts --new`). Never thaw the old trigger after that.

| When | What |
| --- | --- |
| Before step 3 | Nothing was sent: unpause the house (`MM_ARGS` back, redeploy). |
| After step 3, before step 5 sent its deploy request | To give up: thaw the old trigger, OWNER KEY: `node adapters/vela/stack/cutover.mjs thaw` (dry run), then add `--broadcast-mainnet`. The old application then credits from N + 1 again, and the site's pin matches again. Unpause the house. |
| Step 5's deploy request failed (`DeployRequestCompleted` status ≠ 0) | The endpoint refunds the slot and clears the trigger. Either forward-fix (fix the cause, move `evidence/vela-book-politics/checkpoint.json` aside, rerun step 5), or give up as in the row above: no other application exists. |
| The new application is deployed and has credited nothing | To give up: first freeze the new application's trigger (`cutover.mjs freeze --trigger <new trigger> --broadcast-mainnet`), confirm with `facts --new …` that it has no credit record, and only then thaw the old trigger as above (`thaw` refuses until the new trigger is frozen). Redeploy the services from the old export, except that the new payout signer is stopped. If the indexer's reset (step 8 c) already ran, first follow the rollback order at the end of the Switch-over section of `services/indexer/README.md`. |
| The new application has credited anything | Forward-fix only. Both payout signers keep running. The old application stays withdraw-only for good. |

Never use a volume backup or database copy on the manager (`/vela`). The old application's state is never touched by any step here, so no rollback needs one.

## Limits accepted by the owner

- 32 accounts for the new application's whole life. A 33rd account's first deposit is refunded.
- About 1,300 deposit-and-withdraw pairs in total.
- Funds in the event are locked until the result, or until the void on 31 Jan 2027.
- The site cannot trade the old application after step 3. Its users must withdraw before then (preparation step 6).
