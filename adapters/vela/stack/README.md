# ZEDGE Vela guest on the local Vela stack: evaluation slice

**EVALUATION ONLY.** This runs the ZEDGE guest (`../guest`) on Horizen's local Vela v0.2.0 Docker stack, on a throwaway Anvil chain (31337). The executor is a software TEE with fixed development keys and no attestation; the collateral is a worthless test token; the round registry runs on an unsigned fixture oracle; the sender, the amount and the time the guest sees are trusted from the manager. Nothing here is private, secure or production-ready, and none of it may be pointed at a public chain or real funds.

The protocol is [`../guest/README.md`](../guest/README.md). This folder covers its time-free path (key, deposit, withdrawal, claim) and its clock (§8), on the real stack.

## Run

```sh
./run.sh                          # from clean volumes: build checks, bring-up, the slice, teardown, PASS/FAIL
KEEP_STACK=1 ./run.sh             # leave the stack up afterwards, for its logs (see below)
VELA_STARTERKIT=/path/to/clone ./run.sh   # take the starter kit from a local clone instead of GitHub
```

`KEEP_STACK=1` keeps the stack as the destructive phases leave it, which is no longer usable: the millisecond test has moved Anvil's time past anything the guest accepts, so every later tick fails with `malformed trusted payload` (Anvil time cannot go back), and the manager was killed mid-inclusion and then lost its database, so it processes nothing. Use it to read logs; start again with `./run.sh` for a working stack.

`run.sh` rebuilds the guest wasm (`../guest/build.sh`) when it is missing or older than any guest or engine source, the same rule the guest's wasm tests use, so a stale wasm is never deployed.

Needs Docker with the Vela v0.2.0 images pulled (about 3 GB) and room for the stack's volumes, Foundry 1.7, Node 22 and the built guest (`../guest/build.sh`, TinyGo 0.39.0). It uses the starter kit's host ports 8545 (chain), 8000 (subgraph) and 8081 (authority service). A full run takes about 13 minutes, most of it the manager's 5-second polling (the starter kit's setting). Results go to `evidence/vela-slice-2026-10-05/` at the repository root (git-ignored).

| File | Role |
| --- | --- |
| `up.sh`, `down.sh`, `lib.sh` | Fetch the starter kit at `85529cb` into `build/` (git-ignored), start it as compose project `zedgevela` with `compose.override.yml`, wait for the executor/manager handshake, write `manifest.json`. `down.sh` removes this project's containers and volumes only; images are kept. |
| `compose.override.yml` | Ours. Runs the amd64-only images emulated, and takes away the executor's and manager's privileged mode and `/dev/vsock`. |
| `contracts/` | Evaluation-only Foundry project: `EvaluationClockTrigger` (§8 of the guest README) and `EvaluationToken` (6 decimals, anyone can mint). Not part of `contracts/`, so production contract CI never builds them. |
| `slice.mjs` | The evaluation client: ethers, the pinned SDK (`VelaClient`) and `../crypto/session.ts` (`EvaluationSession`), from `../crypto/node_modules`. |
| `run.sh` | The one command. |

## What the slice does and checks

1. **Bring-up.** Chain id 31337; endpoint code present; the TEE signer and enclave key on chain equal what the executor logs; image digests, contract addresses, role holders and the wasm SHA-256 go to `manifest.json`. Addresses are found on the chain itself: the kit writes them to an environment file in a volume, which is not read.
2. **Deployment.** A fresh throwaway operator deploys the test token, the trigger, and the `StreamsRoundRegistry` implementation behind an `ERC1967Proxy` with `MockStreamsBoundaryOracle`, from the read-only artifacts in `contracts/out`. The endpoint admin allow-lists the token through Anvil impersonation (no key is typed or read). The wasm goes to the authority service, then `submitDeployRequestWithTrigger`. Checked: the registry's rules hash equals the engine's computation; the deploy completes; the application root is non-zero; the trigger is bound; the descriptor's wasm hash equals the built artifact and the upload's; the constructor parameters reach the chain byte for byte.
3. **Lifecycle.** Fresh random wallets funded with `anvil_setBalance`; keys stay in the process. Key registration without a seed (133 bytes), the bootstrap sync, a deposit (receipt decrypted: credited amount, auto-registration), a withdrawal request (receipt decrypted, one `Withdrawal`), the claim, a second account withdrawing to a third address, and two private refusals: a withdrawal to the endpoint, and one to the trigger (which would otherwise be paid at once to a contract that returns nothing), with the trigger left holding no tokens.
4. **Negative cases.** Deposit before the first tick; deposit with no registered key; a second allow-listed token; ETH (refunded exactly: the deposit plus the unused part of the fee, in one refund); an exact duplicate command (a `retry` receipt, no second withdrawal); a 16,385-byte payload. Each is checked for its public error and its refund.
5. **Reconciliation, no tolerance**, three times: after the lifecycle, after the restarts and clock tests, and at the end, after the destructive phases.
   - The endpoint's books: token balance = app custody + pending claims; app custody = deposits submitted − refunds − withdrawals + trigger returns (0); pending claims = refunds + withdrawals − claims paid. The first is an independent comparison; the other two restate the endpoint's own bookkeeping, which balances for any withdrawal the guest emits.
   - Against what the slice asked for: app custody = the deposits it had credited − the withdrawals it asked for, and the sum of all `Withdrawal` events (in any transaction, ticks and bursts included) = those withdrawals; the trigger holds no collateral. A withdrawal nobody asked for fails these.
   - The second token and ETH: the endpoint's balance = custody + pending claims (for ETH, plus the fee each still-queued request offered).
   - The engine's own ledger, once: after a last deposit-only request (`deposit alice 1 (engine ledger probe)`), the state the executor logged for it (the leak below, used here as a reading) gives engine `custody` = app custody, `paidOut` = the `Withdrawal` events, `deposited` = the deposits credited, `claimable` = 0: the equalities of the guest README §7.
   - Every receipt ciphertext is 2,076 bytes with the one receipt subtype. Every tick request gets exactly one trusted request in the same transaction; failed, key and deposit-only requests ask for none; no clock record asks for a tick. The state roots form one unbroken chain, which the endpoint enforces (it reverts a transition from any other root), so that check only confirms the slice reads the logs right.
6. **Restart** (run before any time is moved; see the findings). `compose restart executor manager` once the manager is idle, then `compose down` and `up` with volumes kept: the keyset is restored with the same signer, the chain keeps its state and its block time does not go back, and requests, ticks, withdrawals and claims go on. Root continuity is enforced by the endpoint (previous root must be the current one) and the executor (it refuses a state whose hash is not the supplied root). What shows the ledger itself was not rolled back is that alice's next-nonce withdrawal is applied after each restart: the engine accepts only the previous nonce + 1.
7. **Clock.** Every clock record equals the asking block's number and timestamp, including a block whose time Anvil was told to set and one an hour later. A tick lost because the trigger reverted (its code swapped for a reverting stub, then restored byte for byte) is replaced by the next request's tick, and receipts show the lost tick was never applied. A block stamped in milliseconds makes the trusted request fail with `malformed trusted payload` and leaves the clock where it was.
8. **Destructive, last.** The manager is restarted in the second between its `stateUpdate` being mined and the manager seeing it included; then its data volume is removed. What happens is recorded (see the findings).
9. **Leak scan.** What the executor and manager logs hold in clear (`leak-scan.json`; counts, source lines and field names, no log text).
10. **Timings.** Request latency, the executor's time per request from its own log timestamps with the state size the host logged for each, and transitions per minute in a burst.

## Findings from the run of 2026-10-05

All 106 checks passed (manifest 5, slice 101) on colima (aarch64, 4 CPUs, 6 GiB) with the amd64 images under Rosetta. Numbers are from `slice.json` of that run.

| What | Measured |
| --- | --- |
| Executor time per request, own log timestamps | median 6 ms for a `PROCESS` (deposit, command or sync; 34 requests), 2 ms for a tick (24), 1 ms for a key; 564 ms for the deploy (module compile); one `PROCESS` took 412 ms, most likely the first after an executor restart, when the module is compiled again (not attributed per request) |
| Guest state those times were taken on | 1,536 to 3,653 bytes (median 3,365), the state size the host logs per request (`measurements.executor.stateBytesLogged`); the bound is 524,288 |
| Manager | starts one request every 5,000 ms (median gap: one transition per poll, at the starter kit's poll setting) and spends about 1,026 ms on each, mostly waiting for its own transaction |
| Request to completion | median 4,749 ms; its tick another 5,057 ms |
| Throughput | 8 syncs submitted in 0.7 s: 16 transitions in 80 s, 12 per minute, which is one per poll |
| Restart | executor and manager restart: keyset restored in 1.6 s; `compose down` and `up`: 37 s |
| Reconciliation | after the restarts and clock tests: engine `custody` 66 tokens = app custody, engine `paidOut` 60 = the `Withdrawal` events, engine `deposited` 126 = the deposits credited, `claimable` 0; at the end: app custody 63 = 126 credited − 63 withdrawn, nothing pending, the trigger holding nothing; the second token and ETH exact |

- **`MaxActivations`/`MaxSweeps` were not measured.** Guest work took milliseconds against the 30 s request bound, but only on states of at most 3,653 bytes. Those caps bound the work of one tick on a full book near the 524,288-byte limit, about 140 times larger, with order activations that do not exist yet; nothing in this run measures that, and the emulated executor's time at the bound is unknown. The manager's pacing is a separate matter: it starts one transition per poll, every 5 s here. That interval is the starter kit's manager poll setting (its environment file is not read; 5 s is the observed gap), a configuration value, not a capacity. At that setting each user request costs two polls, about 6 user requests a minute for the whole endpoint, and a chain of n ticks takes about 5n seconds. It bounds latency, not how many activations fit in one tick.
- **A manager stopped while its transaction is in flight never recovers.** Restarted about 0.5 s after its `stateUpdate` was mined, the v0.2.0 manager rolls back its database ("error waiting for tx inclusion: context canceled", "Rollback the application state to previous version"); the chain has the new root, so on every start it logs "unrecoverable disalignment between DB and chain" and exits, and Docker restarts it in a loop. No request is processed again. Claims already credited are still paid (`claim` needs no manager); the application's custody (63 test tokens here) has no way out. Seen five times today, twice by accident and three times on purpose. The slice therefore restarts only an idle manager.
- **With its data volume removed, the manager panics** ("State root mismatch … expected 0000…", then `panic: runtime error: slice bounds out of range [1:0]`) on every start and processes nothing. The executor regenerates the same signer, because the development keys are fixed.
- **Anvil does not keep an `evm_increaseTime` offset across `compose down`/`up`.** In one run the restarts came after the clock tests; afterwards the block time was about 4,550 s behind the last applied tick, and the guest refused every tick as `clock regression` while requests, deposits and withdrawals still completed (judged at the old clock). That is the guest behaving as specified; the slice now restarts before moving time.
- **The host wraps the guest's public errors**: on chain they read `failed to process deposit: zedge: …` or `failed to process request: zedge: …`. A deposit from an address with no key fails with the host's own `no Secp521r1_PubKey found` (error code 9) and is refunded.
- **Logs (`leak-scan.json`).** Every `deposit` result is logged at INFO (`pkg/wasm/wasmtime_runtime.go:582`): the whole guest state in clear, salt and engine ledger included, and the deposit receipt's plaintext with its recipient. That includes the deposit of the account with no key, whose request then failed. The token, amount and sender of each deposit (`:510`, `:594`) and the payload and state size of every request (`:601`) are logged too. No command or receipt plaintext was found anywhere else, decoded or not, and no user wallet key.

## What it shows and what it does not

Shown, on this machine: the guest wasm runs inside the emulated amd64 v0.2.0 executor; the on-chain deposit, withdrawal, refund and claim paths move exactly the amounts the slice asked for, and the endpoint's custody equals the engine's own ledger (item 5); restarts with the manager idle keep the ledger (its next nonces are accepted); receipts are encrypted to the registered key and decrypt under `EvaluationSession`'s context checks; the trigger's clock answer reaches `trusted_request` and the published record matches the chain.

Not shown, and not showable here: confidentiality of anything from the host (the executor logs the whole guest state, salt included, on every deposit: see `leak-scan.json`); that the guest's sender, amount or time are genuine (the manager supplies them and v0.2.0 binds none of them); attestation; any order-book or round behaviour (not built); performance on real hardware or under load. `MaxActivations` and `MaxSweeps` cannot be confirmed until the order build exists; this slice measured only the per-request cost on small states and the manager's configured poll pacing, and neither bounds them.

## Licence boundary

Upstream Vela is under the Business Source License 1.1 (internal evaluation and testing only). The starter kit has no licence file. Both are fetched into git-ignored `build/` directories and used in place; nothing of theirs is copied into tracked files. `compose.override.yml`, the contracts and the scripts here are original. The images are Horizen's v0.2.0 images, pulled by digest-recorded tag.
