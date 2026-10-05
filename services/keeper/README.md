# ZEDGE public round keeper

This service operates the Base → Horizen oracle route and the round registry. For BTC/ETH 300- and 900-second rounds it schedules future rounds, fetches the signed report that covers each boundary, publishes it on Base, relays it again if it does not arrive, records openings, resolves rounds, and voids rounds nobody opened in time. An opened round is given up (voided) only when its closing report is established to be unobtainable; see Voidable rounds. A source publication is never treated as a destination receipt.

It sends only zero-value calls to six reviewed public methods (`publishBoundary`, `resendBoundary`, `createRound`, `recordOpening`, `resolveRound`, `voidRound`). No deposits, approvals, trading, custody or user data pass through it. Every one of those calls is permissionless and either idempotent or self-rejecting, and that is what the design below relies on: anything that fails is retried later, and the process ends only when continuing could double-spend, overspend, or act for a deployment or signer it cannot identify.

## Commands and options

```sh
node services/keeper/main.mjs <mode> [--secrets <file>] [--state-directory <directory>] [--rehearsal]
npm run test:keeper
```

The mode is the first argument. Without one it is `--plan`.

| Mode | Signs | What it does |
| --- | --- | --- |
| `--check-public` | no | Proves the release against both chains (see Verification) and prints `public-deployment-verified`. |
| `--plan` | no | The same proof, then reads the registry and prints the actions it would take now. |
| `--run-once` | yes | One tick of the run loop, one status line, exit. A transaction it sent is settled by a later run. For a look at a single tick only, not for operation from a timer: relay timers, retry spacing and `Retry-After` live in the process, so separate runs never relay a lost bridge message and do not back off. |
| `--watch` | yes | The run loop, until SIGTERM or SIGINT (exit status 0) or a stop (exit status 1). |

| Option | Meaning |
| --- | --- |
| `--secrets <file>` | The private settings file described below. Required for `--run-once`, `--watch` and with `--rehearsal`. In the read-only modes it is optional and only its RPC URLs are used. |
| `--state-directory <directory>` | Where the journal and the lock live. Default `evidence/keeper/` under the repository root (git-ignored). Used by `--run-once` and `--watch` only. |
| `--rehearsal` | Run against local forks; see The release gate. |

Anything else is refused before any file or network access: `KEEPER_MODE`, `KEEPER_ARGUMENT`, `KEEPER_SECRETS_REQUIRED`.

## The secrets file

All settings come from the one file given with `--secrets`. The process environment is never read, nothing is loaded implicitly, and nothing from the file is ever printed. The file must be a regular file (not a symbolic link), readable by the keeper's user, at most 16 KB, with mode exactly `0600`; otherwise the keeper stops with `KEEPER_SECRET_PERMISSIONS`. Copy `env.example`, fill it in locally and `chmod 600` it.

| Line | Meaning |
| --- | --- |
| `KEEPER_PRIVATE_KEY`, `KEEPER_ADDRESS` | A dedicated low-balance wallet: the key as 64 hex digits and the address it derives. A malformed key is `KEEPER_PRIVATE_KEY`; an address that is not the key's is `KEEPER_ADDRESS`. Fund it on Base and on Horizen. It must stay a plain key: an account with code stops the keeper (`KEEPER_SIGNER_CODE`). |
| `CHAINLINK_STREAMS_USERNAME`, `CHAINLINK_STREAMS_SECRET` | Data Streams credentials entitled to the BTC/USD and ETH/USD streams. |
| `KEEPER_BASE_DAILY_BUDGET_WEI`, `KEEPER_HORIZEN_DAILY_BUDGET_WEI` | Required. The most each chain may cost in any rolling 24 hours, in wei; see Budget. At most 250000000000000000 (0.25 ETH) for Base and 50000000000000000 (0.05 ETH) for Horizen. Missing, zero or above the maximum is `KEEPER_BUDGET_CONFIG`. The earlier `KEEPER_BASE_BUDGET_WEI` / `KEEPER_HORIZEN_BUDGET_WEI` names are not read. |
| `KEEPER_BASE_RPC_URL`, `KEEPER_HORIZEN_RPC_URL` | Optional `https://` endpoints replacing the public defaults in `contracts/deployment/hybrid-mainnet.json` (currently `base-rpc.publicnode.com` and `horizen.calderachain.xyz`). Recommended, and for production in effect required: the public ones are shared and rate limited (see Limits). They live in this file because a URL can carry an access key. The same chain and contract checks run against whichever endpoint answers. An endpoint given here must serve `eth_getTransactionReceipt`, or nothing the keeper sends can be settled; one that refuses is reported as `KEEPER_RPC_RECEIPTS` by every mode before anything is sent. The default Base endpoint refuses them, so while `KEEPER_BASE_RPC_URL` is not set, Base receipts (and nothing else) are read from the endpoint the profile names for them (`chains.base.receiptRpcUrl`, currently `https://mainnet.base.org`). Anything but `https://` is `KEEPER_RPC_CONFIG`. |
| `KEEPER_STREAMS_ORIGIN` | With `--rehearsal` only: a loopback stand-in for the report service, `http://127.0.0.1:<port>` or `http://localhost:<port>`. Ignored otherwise. |

## The release gate

Every mode first reads `contracts/deployment/mainnet-addresses.json` and `hybrid-mainnet.json` from the repository (or the image) and refuses to go on unless the release is `schemaVersion` 2, its `configHash` is the hash of the profile text, and it names the four contracts with their chains, addresses and runtime code hashes, plus the registry proxy's implementation, implementation code hash and owner (`KEEPER_RELEASE`). Both files are used exactly as committed. From the profile the keeper takes `chains.*.chainId` and `rpcUrl`, the optional `chains.*.receiptRpcUrl`, the two feed ids, `rules.observationWindow` and `rules.voidGrace`. It carries no RPC endpoint and no address of the release of its own. Its only fixed addresses are each chain's gas-price-oracle predeploy (`0x420000000000000000000000000000000000000F`, read for every fee bound) and the canonical Multicall3 (`0xcA11bde05977b3631167028862bE2a173976CA11`, views only, see How it runs), and its only fixed origin is Chainlink's report service (`https://api.dataengine.chain.link`). None of the three is part of the release's identity check.

A release whose `status` is `planned` names a registry that is not deployed yet. Until the file says `deployed`, every mode, the read-only ones included, stops with `KEEPER_RELEASE_NOT_DEPLOYED` before any network request.

The one exception is `--rehearsal`, for local forks: it accepts `planned` or `deployed`, requires both RPC URLs in the secrets file to be loopback `http://127.0.0.1:<port>` or `http://localhost:<port>` (`KEEPER_RPC_CONFIG` otherwise), allows `KEEPER_STREAMS_ORIGIN`, marks every status line `"rehearsal":true`, and uses a journal identity different from mainnet's, so rehearsal state can never be continued on mainnet (`KEEPER_JOURNAL_IDENTITY`). The receipt check applies here too: a fork answers for an old transaction from the endpoint it was forked from, so fork from one that serves receipts (`KEEPER_RPC_RECEIPTS` otherwise).

## Running it supervised

Run one `--watch` process per wallet under a supervisor that restarts it, on a host with a synchronised clock (Chainlink rejects requests whose timestamp is more than 5 s off) and a persistent state directory on a disk of that machine. Allow 30 seconds for a stop: a tick finishes before the process exits.

As a service:

```ini
[Service]
ExecStart=/usr/bin/node /srv/zedge/services/keeper/main.mjs --watch --secrets /etc/zedge/keeper.env --state-directory /var/lib/zedge-keeper
Restart=on-failure
RestartSec=30
TimeoutStopSec=30
```

As a container (the build context is the repository root; `Dockerfile.dockerignore` lets nothing but the keeper, the ABIs, the two deployment records, the lockfile and one test fixture reach the Docker daemon):

```sh
docker build -f services/keeper/Dockerfile -t zedge-keeper .
docker run --rm --entrypoint node zedge-keeper --test 'services/keeper/*.test.mjs'   # the suite, inside the image
docker run --rm zedge-keeper --check-public
docker run -d --name zedge-keeper --restart unless-stopped --stop-timeout 30 \
  --log-opt max-size=20m --log-opt max-file=5 \
  -v zedge-keeper-state:/state \
  -v /etc/zedge/keeper.env:/run/secrets/keeper.env:ro \
  zedge-keeper
```

The image runs as uid 1000 with `--watch --secrets /run/secrets/keeper.env --state-directory /state` as its default command; arguments after the image name replace all of it, so a signing mode given by hand needs `--state-directory /state` again (nothing else in the image is writable). The secrets file is mounted, never built in and never passed as a build argument or environment variable; on the host it must be owned by uid 1000 and `0600` (or run the container as the owner with `--user` and give that user the state volume). Pin the base image digest you have reviewed before production use.

Stopping is always safe. On SIGTERM the keeper finishes its tick, removes its lock and exits 0; whatever it had sent is settled after the next start. After a stop with status 1 a restart is harmless but pointless until the cause is removed: the keeper re-checks from scratch and stops again.

### State directory and lock

| File | Content |
| --- | --- |
| `state.json` | Open transactions, each chain's last settled transaction, tracked rounds, the rolling spend, attempt counters and, in a new directory, how far the look-back for older rounds has got and where it ends. A few kilobytes, rewritten and fsynced before every send. |
| `history.jsonl` | Every settled transaction with its cost, append-only. Never read back; rotate it as you like. |
| `keeper.<id>.lock`, `keeper.<id>.live` | The running writer's lock: a record (pid, host name, boot id, start time) and a FIFO the writer holds open for as long as it lives. |

One writer per state directory. A second keeper started on a directory whose writer is alive stops with `KEEPER_LOCKED` and leaves that writer's lock alone. Of keepers started on one directory at the same instant at most one continues; it can happen that all withdraw, and the supervisor's next start settles it.

A lock left by a writer that crashed or was killed is taken over automatically. The proof is the kernel's, not a pid: the kernel closes a process's FIFO when the process ends, and tells anyone who then tries to open that FIFO for writing that nobody is reading it. Pids are deliberately not used. Every containerised keeper is pid 1, pids are reused, and one container cannot see another's processes, so "that pid is gone" or "that pid is mine" proves nothing.

A kernel can only answer for its own processes. A leftover lock is therefore taken over only if its record was written under the running kernel (same boot id: any process or container on this machine since it started) or under this host name (the same machine after a restart). A record from anywhere else, an unreadable record, or one whose FIFO is missing is left alone and the keeper stops with `KEEPER_LOCKED`. In practice:

- crash, `kill -9`, out-of-memory kill, restart by the supervisor, a replaced container on the same machine, a machine restart with the same host name: no manual step;
- a container replaced across a machine restart, unless it runs with a fixed `--hostname`: `KEEPER_LOCKED`. Make sure no keeper runs on that directory anywhere, then delete `keeper.*.lock` and `keeper.*.live`.

This holds only while the state directory is a disk of one machine. On a network share that two machines (or a machine and a virtual machine on it) can write, a live writer elsewhere cannot be seen; do not put the state directory there. Do not run two keepers on one wallet or on copied state. Separate keepers with separate wallets and state are fine: each treats the other's work as done.

## Budget

Each chain has one number: the most the keeper may be charged there in a rolling 24 hours (kept as hourly totals: the current hour and the 24 before it). A transaction is booked under the hour of its block, and old hours leave the file relative to the newest hour booked, so a host clock that is wrong at a start can neither move spending to another day nor erase it. It refills by itself as spending ages out. There is no lifetime limit and nothing to reset.

- **Reservation.** Before signing, a transaction is priced in wei: gas limit × (2 × base fee + priority fee) plus twice the rollup data and operator fee quoted by the chain. The gas limit is the live estimate × 2.25 for publications and relays (the estimate includes the Base portal's deposit-fee burn at its current price, and that price can rise ×2.125 from one block to the next) and × 1.25 for registry calls, never above the chain's own limit of 2^24 gas.
- **Per-transaction cap.** One transaction may reserve at most 1/20 of the chain's daily budget. Above that the keeper waits with `KEEPER_FEE_CAP`; if no gas limit under 2^24 leaves headroom it waits with `KEEPER_GAS_CAP`, also when the endpoint itself refuses an estimate above 2^24 (Base answers `gas required exceeds: 16777216`).
- **Daily budget.** The reservation must fit into what is left of the rolling day (`KEEPER_BUDGET`) and into the wallet's balance (`KEEPER_BALANCE`).
- **What is charged.** An open transaction is charged its reservation (several hashes signed for one nonce count once, at the largest). A settled one, successful or reverted, is charged the execution fee it actually paid plus the reserved rollup-fee part. A replaced hash costs nothing.

All four codes are waits: the keeper keeps running, only the affected transactions stand still, and the other chain carries on. They clear when fees fall, the window refills, the wallet is funded, or the keeper is restarted with a larger budget.

Sizing at the fees of 2026-10-04 (an estimate, not a measurement of sustained operation): one Base publication used about 1.18M gas, about 0.000007 ETH, and there are 576 a day (two feeds, every five minutes), so Base needs about 0.004 ETH a day; Horizen needs well under 0.001 ETH a day. The example values (0.02 and 0.004 ETH) leave about five times that. The per-transaction cap decides which fee spikes are paid: with 0.02 ETH on Base a publication (about 2.64M gas limit at the deposit-fee floor) fits while Base's base fee is below about 0.19 gwei; above that the keeper waits rather than spend the day's budget on a few transactions. A budget is tied to its state directory: a new directory starts a new day.

## Status lines

`--watch` prints one JSON line per tick on stdout. Ticks are 30 s apart when there is nothing to do and closer when there is: half a second while a transaction is in flight, a second for the first 15 s after each five-minute boundary and while a price that an opening waits for is on its way to Horizen, and otherwise the time to the next retry of whatever is waiting. A stop is one line on stderr, `{"at":…,"status":"stopped","code":…}`; so is a defect that was survived (`"status":"defect"`). Lines carry fixed codes only, never provider text, URLs or anything from the secrets file.

| Field | Meaning |
| --- | --- |
| `at` | Host time of the line. |
| `status` | `sent` (a transaction was signed and sent on this tick), `waiting` (something is waiting, see `waiting` and `chains`), or `idle`. |
| `rounds` | Rounds in view that still need work. `null` until the registry has been read once. |
| `sent[]` | `action`, `chain`, `hash`, `nonce`, `maximumFeeWei` (the reservation) of each transaction sent on this tick. |
| `settled[]` | `key` (action and attempt number), `chain`, `hash`, `status` (`confirmed` or `reverted`), `feeWei` (what was charged) of each transaction that became final on this tick. |
| `done[]` | Actions somebody else had already taken: `action`, `already` (the contract's answer). |
| `waiting[]` | What is waiting and why: `action` (or `chain` when a pending transaction holds that chain), `wait` (reason code), `retryAt` when a retry time is set. |
| `chains` | Only chains that are not being worked on this tick: `wait` (reason code) and `retryAt`. Empty when both are fine. |
| `spentWei`, `remainingWei` | Per chain: charged to the rolling daily budget, and what is left of it. |
| `heads` | Per chain: `block` and `time` of the head its endpoint returned on this tick (the previous one while the chain is backing off; `null` before the first answer). |
| `reports` | Per feed (`BTC`, `ETH`): `lastOkAt`, when the report service last returned a usable report to this process, `observed`, that report's observation second, and `failing`, the reason code while the last request failed. In normal operation each feed is fetched at least every five minutes. |

Actions are named `create|open|resolve|void:<asset>:<duration>:<start>` (asset 0 is BTC, 1 is ETH) and `publish|resend:<feed id>:<boundary>`.

Useful alerts: no line for two minutes (hung or dead); a `stopped` line or exit status 1; `chains` not empty for several minutes; a `settled` entry with `reverted` that repeats for one action (a single `reverted` create, open, resolve or void after which that round moves on is a step somebody else took in the same block: harmless, and not retried; a publication or relay raced that way does not revert, it pays for a second bridge message); `remainingWei` low; `reports.*.failing` present or `lastOkAt` older than 15 minutes; any code listed under "need the operator" below.

## Reason codes

Every failure is one of four kinds. Only the last ends the process.

| Kind | What happens | Codes |
| --- | --- | --- |
| done | Somebody already did it. State is re-read and the keeper moves on. | `REVERT_ROUND_EXISTS`, `REVERT_OPENING_ALREADY_RECORDED`, `REVERT_ALREADY_FINALIZED` |
| retry | Not yet, or temporarily impossible. Tried again; only that action, or that chain, waits. | `RPC_*`, other `REVERT_*`, `STREAMS_*` (except those below), `KEEPER_FEE_CAP`, `KEEPER_GAS_CAP`, `KEEPER_BUDGET`, `KEEPER_BALANCE`, `KEEPER_TX_PENDING`, `KEEPER_PRESEND_STALE`, `KEEPER_SUBMITTED_HASH`, `KEEPER_NONCE_BEHIND`, `KEEPER_CHAIN_CLOCK`, `KEEPER_CLOCK`, `KEEPER_INTEGER`, `KEEPER_PHASE`, `KEEPER_BASE_BEHIND_BOUNDARY`, `KEEPER_STREAMS_STALE`, `KEEPER_ATTEMPT_SETTLING`, `KEEPER_RETRY_SPACING`, `KEEPER_TX_FAILED`, `KEEPER_TX_CANONICAL`, `KEEPER_TX_MISMATCH`, `KEEPER_RPC_RECEIPTS`, `KEEPER_REORGANISED`, `KEEPER_SIGNER_UNCONFIRMED`, `AWAITING_DELIVERY`, `UNEXPECTED_*` |
| skip | This action cannot succeed as planned. It is left alone and looked at again every five minutes; everything else continues. | `KEEPER_ATTEMPTS_EXHAUSTED`, `KEEPER_RESENDS_EXHAUSTED`, `REVERT_CONFLICTING_OBSERVATION`, `KEEPER_STREAMS_AUTHENTICATION`, `STREAMS_BOUNDARY_WINDOW`, `STREAMS_BOUNDARY`, `STREAMS_FEED`, `STREAMS_WINDOW` |
| stop | The process exits with status 1. | see What stops the process |

### What is retried, and how

- **A chain's endpoint fails or rate-limits** (`RPC_HTTP_429`, `RPC_*`): that chain is left alone for 1 s, doubling to 60 s, or for as long as `Retry-After` says (at most 15 minutes). The other chain carries on. While Horizen cannot be read, Base goes on publishing the boundaries known from the last view; nothing new is planned and nothing is sent to Horizen.
- **An action cannot be taken now** (a revert in simulation, a report that is not there yet, a fee over the cap): that action waits 1 s, doubling to 5 minutes. Publishing, relaying and recording an opening price never wait longer than 15 s while the opening window (210 s from the boundary) is open, so a cause that clears inside the window is still acted on inside it. Every other action goes ahead.
- **A transaction reverts on chain**: the action is attempted again under the next attempt number (`publish:<feed>:<boundary>:2`) after 10, 20, 40, 80 seconds, at most five reverts per action in a rolling day, then `KEEPER_ATTEMPTS_EXHAUSTED`.
- **A transaction is not mined**: it holds its chain for 20 seconds (doubling with each further unmined hash, up to about 11 minutes), then the same nonce is signed again with a higher bid. The `KEEPER_TX_PENDING` line says until when. See Stuck transactions.
- **A price is on Base but has not reached Horizen**, whoever published it: it is relayed again after 60 s, then with doubling gaps, at most four times in a rolling day, then `KEEPER_RESENDS_EXHAUSTED`. While an opening waits for it the keeper looks every second; when only a resolution does, it looks when the next relay is due. For a minute after this process has seen a publication or relay confirmed, it counts as stored on Base whatever a read says (an endpoint may answer from a backend a few blocks behind), and an attempt that may just have been mined is waited for (`KEEPER_ATTEMPT_SETTLING`): `publishBoundary` does not reject a repeat, it pays for a second bridge message.
- **A reorganisation removes the last settled transaction** (the endpoint counts fewer transactions than the journal has settled, and the block that held the last one has been replaced): its record is opened again and the action is taken again, with one `KEEPER_REORGANISED` line. If that block is still the chain's, the endpoint is merely behind: `KEEPER_NONCE_BEHIND`, and the keeper waits for it.
- **A nonce looks spent by somebody else** (`KEEPER_SIGNER_UNCONFIRMED`): one answer that misses a receipt reads the same, so that chain waits and is read again for 30 seconds. Only if it still holds does the process stop with `KEEPER_SIGNER_CHANGED`.
- **A boundary's report is missing**: the exact second is asked for, then one page of reports from that second (`STREAMS_NO_COVERING_REPORT` if neither covers it). A report stamped later than the Base head waits one block (`STREAMS_REPORT_AHEAD_OF_BASE`).
- **The report service is not answering for one feed**: no new rounds are created for that feed; everything else continues.
- **A round's opening was missed**: the registry reports it Voidable and the keeper voids it.
- **An opened round has no closing price cached**: it is resolved whenever that price is cached, however late; the keeper never voids on a timer of its own. Past its void time the registry reports it Voidable too; what the keeper does then is under Voidable rounds.

Codes that need the operator although the keeper keeps running:

- `STREAMS_HOST_CLOCK_SKEW`: the report service refused the request and its clock differs from this host's by more than 4 s. Fix time synchronisation.
- `STREAMS_HTTP_401_CHECK_CREDENTIALS_AND_CLOCK` (also 400, 403): refused with the clocks in agreement. Check the username, the secret and the stream entitlement.
- `KEEPER_BALANCE`, `KEEPER_BUDGET`, `KEEPER_FEE_CAP`, `KEEPER_GAS_CAP`: see Budget.
- `KEEPER_ATTEMPTS_EXHAUSTED`, `KEEPER_RESENDS_EXHAUSTED`: an action reverted five times, or a price was relayed four times without arriving, within a day. Look at `history.jsonl` and the chain.
- `KEEPER_CHAIN_CLOCK` that does not clear: a chain head is more than 60 s from the host clock (a lagging endpoint, a paused sequencer, or a wrong host clock).
- `KEEPER_NONCE_BEHIND` that does not clear: the endpoint goes on reporting a lower nonce than this journal has settled although the block of the last settled transaction is unchanged. Check the endpoint. (A reorganisation that removed that transaction is repaired without the operator, see above.)
- `KEEPER_RPC_RECEIPTS`: the endpoint answers, but refuses `eth_getTransactionReceipt`. Nothing is sent on that chain until an endpoint that serves receipts is configured.

### What stops the process, and how to recover

| Code | Cause | Recovery |
| --- | --- | --- |
| `KEEPER_MODE`, `KEEPER_ARGUMENT`, `KEEPER_SECRETS_REQUIRED` | The command line. | Correct it. |
| `KEEPER_SECRET_PERMISSIONS` | The secrets file is missing, unreadable by this user, a symbolic link, over 16 KB or not `0600`. | Fix the file or the mount. |
| `KEEPER_PRIVATE_KEY`, `KEEPER_ADDRESS`, `KEEPER_BUDGET_CONFIG`, `STREAMS_USERNAME`, `STREAMS_SECRET`, `STREAMS_ORIGIN`, `KEEPER_RPC_CONFIG` | A line of the secrets file. | Correct it. |
| `KEEPER_RELEASE`, `KEEPER_RELEASE_NOT_DEPLOYED` | The release file; see The release gate. | Install the release that describes the deployment. Nothing to do before deployment except `--rehearsal`. |
| `KEEPER_LOCKED` | Another keeper is alive on this state directory, or a lock is left that this machine cannot answer for. | See State directory and lock. |
| `KEEPER_JOURNAL_STORAGE` | The state directory cannot be created, read or written (permissions, a full or failing disk, a filesystem without FIFOs), or `state.json` is not valid JSON. | Fix the directory or the disk. Nothing is signed without a durable record. |
| `KEEPER_JOURNAL_FILE`, `KEEPER_JOURNAL_IDENTITY`, `KEEPER_JOURNAL_RECORD`, `KEEPER_JOURNAL_FEE_OR_INTENT`, `KEEPER_JOURNAL_RECEIPT`, `KEEPER_JOURNAL_ACCOUNTING`, `KEEPER_JOURNAL_ATTEMPTS`, `KEEPER_JOURNAL_CAPACITY` | `state.json` has the wrong mode, belongs to another release, wallet or rehearsal, or does not validate. | Restore the directory, or start with a new one (see below). |
| `KEEPER_CHAIN`, `KEEPER_CODE`, `KEEPER_REGISTRY_IMPLEMENTATION`, `KEEPER_REGISTRY_OWNER`, `KEEPER_REGISTRY_RULES` | An endpoint answers for another chain, or a contract, the registry's implementation, its owner or its rules are not the release's. An upgrade or a new owner is a different deployment. | Check the endpoint. If the deployment really changed, review it and install the release that names it. |
| `KEEPER_SIGNER_CODE` | The wallet is no longer a plain key. | Remove the delegation or use a new wallet. |
| `KEEPER_SIGNER_CHANGED` | The wallet's nonce was spent by a transaction this journal did not sign: another process or person is using the key, or a transaction was sent from the wallet by hand. Where the evidence is a missing receipt it has held for 30 seconds of re-reading (`KEEPER_SIGNER_UNCONFIRMED` until then). After a reorganisation it can also be one of the keeper's own earlier transactions landing again. | Establish who used the key. Then start with a new state directory. |
| `KEEPER_ACTIVE_CAPACITY` | More than 1,024 rounds are tracked (normal operation tracks a few dozen). | Start with a new state directory (see below). |
| `KEEPER_DUPLICATE_INTENT`, `KEEPER_INTENT`, `KEEPER_TARGET`, `KEEPER_CALL`, `KEEPER_CONTRACT`, `KEEPER_PERSISTED_ROUND`, `STREAMS_PATH`, `STREAMS_CLOCK` and any other `KEEPER_` code | An internal invariant failed: the journal contradicts itself or a call outside the allow-list was built. | Keep the state directory and report it. |

`--plan` and `--check-public` make one pass and retry nothing: there, any failure ends the process, including the ones the run loop waits out (`RPC_*`, `KEEPER_CHAIN_CLOCK`).

Starting with a new state directory is always possible and gives up three things: the record of what the rolling day has cost so far (the budget starts full), the retry counters, and the list of tracked rounds. The rounds are found again from the registry: those that started in the last 80 minutes on the first tick, and every older round that was opened and still awaits resolution, including one that turns Voidable while the look-back is under way, by a look-back over the last seven days (as far back as such a round can exist before the registry calls it Voidable). The look-back reads 24 rounds at most every 15 seconds, newest first, so it takes between one and two hours (rounds from the last few hours are found within minutes). Where it ends is fixed when it begins, so those hours do not move the end past rounds that were still pending then; its position and its end are in the journal and a restart carries on from them. The keeper then publishes those rounds' closing prices and resolves them. Not looked for: unopened rounds older than 80 minutes (they hold nothing and anyone can void them) and rounds older than seven days (an opened round that old is worked only by a keeper whose state directory still tracks it; see Voidable rounds). Those are left to `voidRound` or `resolveRound` by hand; resolving needs the closing price in the Horizen cache, which means publishing that boundary on Base with a Chainlink subscription, exactly what the keeper does for the rounds it finds. Before the first start on a new directory, wait until the wallet has no pending transaction: one that is mined afterwards looks like somebody else using the key (`KEEPER_SIGNER_CHANGED`).

## First supervised round

A checklist for following one BTC 15-minute round from creation to resolution. The keeper has no market filter and no wind-down mode: while it runs it operates all four markets and always keeps rounds scheduled two boundaries ahead. Plan for about 35 minutes and for what is left afterwards (last step).

Before the day:

1. The release file says `"status": "deployed"` and `node services/keeper/main.mjs --check-public` prints `public-deployment-verified`. Until then only `--rehearsal` runs.
2. `npm run test:keeper` passes on the host, or the suite passes inside the image.
3. The wallet is new, used by nothing else, and funded on both chains (about one daily budget each is plenty; whatever the balance, the keeper cannot be charged more than the budget in a day).
4. The secrets file is filled in and `0600`. Both private RPC URLs are set if you have them.
5. The host clock is synchronised to well under a second.
6. The state directory is empty and on a local disk, and the supervisor is configured but not started.

The run, with `S` the next quarter-hour boundary in Unix seconds (start at least two minutes before it):

7. `node services/keeper/main.mjs --plan`: it lists `create` actions only (plus `void` for rounds nobody opened in time). Nothing else is expected on a registry without open rounds.
8. Start the supervisor. The first lines show `sent` with `create:0:900:<S>` among the creations, then the same keys under `settled` with `confirmed`. `remainingWei` falls slightly, `heads` follow both chains, `reports` shows `lastOkAt` for both feeds, `chains` is empty.
9. At `S`: `sent` shows `publish:<BTC feed id>:<S>` on Base within a few seconds, then `waiting` shows `resend:…=AWAITING_DELIVERY` while the price travels to Horizen (the two deliveries observed so far took about 24 s; the keeper relays again after 60 s), then `sent` shows `open:0:900:<S>`. The opening must be recorded by `S + 210`; in simulation at 250 ms per request it lands by about `S + 40`.
10. Until `S + 870` the round trades and the keeper works the other rounds. Watch that every boundary repeats step 9 without `reverted`, without `chains` entries that persist, and with `remainingWei` falling at the expected rate.
11. At `S + 900`: `publish:<BTC feed id>:<S+900>`, delivery, then `sent` shows `resolve:0:900:<S>` and `settled` confirms it. Check the registry: `phase(roundIdFor(0, 900, S))` is 6 (Resolved) and `payoutNumerators` is `(2, 0, 2)` or `(0, 2, 2)`.
12. Compare `history.jsonl` with both explorers: every line is a transaction of the keeper wallet and the wallet has no other.
13. Stop the supervisor (SIGTERM). The last lines show no pending transaction, the exit status is 0 and the lock files are gone.

Afterwards the registry still holds the rounds scheduled ahead (unopened; they become Voidable 210 s after their start) and the rounds that were trading (opened; they can be resolved whenever their closing price reaches the cache, and become Voidable seven days and 60 s after their end if it has not). Nothing depends on them while no vault is deployed. Starting the keeper again on the same state directory voids the first kind and works the second kind for its true result, whenever that is: within those seven days as rounds awaiting resolution, later as overdue rounds (see Voidable rounds). A new state directory finds the second kind again only within those seven days.

## Voidable rounds

The registry calls a round Voidable in two different situations, and the keeper treats them differently.

A round **nobody opened in time** holds nothing to settle. The keeper voids it as soon as the registry says Voidable.

An **opened** round becomes Voidable when nothing is cached for its closing boundary seven days (and 60 s) after its end. That says nothing about whether the price can still be had: a Chainlink report verifies on Base for 30 days. Voiding pays both sides a half, so the keeper first works such a round exactly like one awaiting resolution, and gives it up only when the closing report is established to be unobtainable. Per tick, with everything read on that tick:

| Horizen cache holds the closing price | Base holds it | Report service, asked for the closing boundary | The keeper |
| --- | --- | --- | --- |
| yes | any | not asked | `resolveRound`. (With the price cached the registry no longer calls the round Voidable, and rejects a void.) |
| no | yes | not asked | Relays it (`resendBoundary`: after 60 s, then with doubling gaps, four times a rolling day), then resolves. Never voids, whatever the report service says: the price exists. |
| no | no | serves the covering report, and Base accepts it | `publishBoundary`, relay, `resolveRound`: the true result, however late. |
| no | no | serves the covering report, but its validity has run out and the Base adapter rejects it in a simulation (`InvalidOracleResponse`) | Unobtainable. `voidRound` on the next tick. |
| no | no | answers that no report covers the boundary (not found, or the nearest report lies outside the 60-second window), and on the same attempt serves that feed's latest report | Counted only once a report covering the boundary would have expired anyway, at the validity the latest report has (30 days): before that, the same answers can come from an outage of the historical lookup alone while the report still verifies on Base. Once counted, unobtainable after at least three such answers with at least ten minutes between the first and the last; then `voidRound`. Until then it waits (`STREAMS_NO_COVERING_REPORT`). |
| no | no | unknown: an outage (5xx), a refusal (400, 401, 403, clock skew), a rate limit, a timeout, a malformed answer; or "no report" while the feed's latest report cannot be had either | Waits and asks again (after 1 s, doubling to 5 minutes). Never voids. |
| no | no | serves the covering report, and the publication fails for any other reason (the verifier rejects it, a fee over the cap, a revert) | Waits and retries like any publication. Never voids. |
| no | unknown (Base cannot be read) | any | Waits. Nothing is voided without Base's own answer, on that tick, that the price is not there. |
| unknown (Horizen cannot be read) | any | any | Sends nothing to Horizen and relays nothing. Publication on Base goes on from the last view. |

So the keeper gives up an opened round only once its closing report is out of reach for good: when the report service still serves it but it no longer verifies on Base, or about 30 days after the round's end when no report is found. A round whose report never existed (the feed was down for more than a minute across its closing second) therefore stays open for about 30 days, not seven, unless somebody voids it by hand (below). What counts is kept in memory, per boundary. With the retry gaps (1 s doubling to 5 minutes) the ten minutes are reached at about the eleventh answer, so giving a round up this way takes about 14 minutes of uninterrupted running; a restart starts counting again, and `--run-once` never gives up an opened round. A report that turns up before the count is complete is published like any other; from then on the keeper holds it and no further answer is counted. The registry stays the last guard: it rejects a void before the round's void time and whenever the cache holds the closing price. `voidRound` is permissionless, so an operator who knows a price can never arrive (say a bridge that will not deliver what Base holds) can still void by hand; the keeper will not do it for them.

## How it runs

Each tick reads, per chain, the head and everything it needs to know in one `eth_call` through Multicall3: on Horizen the registry's own `phase()` for the rounds in view together with what the cache holds for their boundaries, on Base the observations those rounds are waiting for. A round's phase is read again only while it can change: not before its start while it is scheduled, not before its end while it trades. Until a phase has stood for three minutes it is read on every tick regardless, because a reorganisation could still undo the transaction behind it. Resolved, voided and never-created rounds are read on every tick while they are in view (about 15 minutes after their end), in the same call: a deeper reorganisation of somebody else's transaction shows nowhere else. When a reorganisation takes back the keeper's own last settled transaction (`KEEPER_REORGANISED`) it reads every round again. Multicall3 carries views only, and only where the code at its canonical address is exactly the canonical runtime (it is on Base and on Horizen); on any other chain the same views are asked one by one in a batch. Each chain has its own lane: identity check, reconciliation of open transactions, backoff, and at most one new transaction per tick, chosen from state read after the previous one. Neither lane waits for the other, for confirmations, or for the other chain's clock or endpoint.

**Verification.** `identify(chain)` proves, against that chain's endpoint, the chain id and the runtime code hash of every contract of the release on it (immutables are part of the runtime). For the proxied registry it also proves the implementation slot, the implementation's runtime hash, the owner and the stored rules hash. It runs at start-up, at most a minute before any send, and every minute while idle. The first time, it also asks for the receipt of one of the release's creation transactions: an endpoint that refuses receipts could never settle what the keeper sends (`KEEPER_RPC_RECEIPTS`; "not found" is accepted, a pruned index still serves recent receipts). A mismatch is a stop: an upgrade or a new owner is a different deployment until a release that names it is installed. Nothing upstream (Chainlink verifier and fee manager, messengers, portal, USDC.e) is pinned or read: the keeper sends no value, and its simulation of each call runs the real upstream path, so an upstream change either still works or shows up as a revert reason on the Base lane while Horizen carries on. Multicall3 is not part of the identity either: its code is compared once per process, and anything but the canonical runtime only means single reads, never a stop. Every call the keeper signs is simulated directly against its target, not through Multicall3.

**Transactions.** Before a send the keeper simulates the call, estimates gas and reads fees, nonce and balance in one batched request to the target chain. The transaction hash, the action and the reservation are written and fsynced before the single send; if signing and that write together took more than 8 s (a stalled signer or disk; the endpoint's own response time is not counted), the hash is withheld (`KEEPER_PRESEND_STALE`) and its signed bytes are discarded.

**Stuck transactions.** Only the wallet's latest confirmed nonce is ever signed. A nonce is consumed once, so of all the hashes the journal holds for one nonce at most one can ever execute, and each is a fee-capped call that is idempotent or rejects itself. An unmined hash therefore holds its lane for a while and then the same nonce is signed again with a higher bid; whichever is mined, the others are closed as `dropped` at no cost. This holds whatever became of the earlier hash: never sent, lost, or still pending. If fees have not moved and a higher bid would not fit the per-transaction cap, the signature is byte for byte an earlier one: that record takes the lane again and the same bytes are broadcast again, with no new record. A record seen in a block frees the lane at once; two blocks later it is checked field by field against the signed transaction and its cost is booked. That depth is an operational observation, not finality. Settled history is not re-read, with one exception: each chain's last settled transaction stays on record, and if a reorganisation takes it out again its record is opened once more (`KEEPER_REORGANISED`; `history.jsonl` then shows that key a second time). Only that one transaction is covered: one removed further back that lands again later is not on record any more and stops the keeper with `KEEPER_SIGNER_CHANGED`.

**Reports.** The HMAC client talks only to the fixed official origin and to three paths: the latest report, the report at a timestamp, and one page of reports from a timestamp. A boundary is published from the report whose signed window contains it. When the DON produced no report for that exact second, the next report's window absorbs it ([How Report Timestamps Work](https://docs.chain.link/data-streams/how-report-timestamps-work)); what the at-a-timestamp endpoint answers for such a second is not documented, so on a miss or a non-covering answer the keeper asks the page endpoint, whose first report from that timestamp is the covering one. This fallback has not been observed against the live service (it needs a subscription). The canonical report ABI, feed, window, positive price and expiry are checked locally, and the contract's own verification must return the same report hash in simulation before anything is signed.

## Limits

- Not yet run against the live report service, and nothing has been sent on mainnet. Read-only on 2026-10-05, the identity check and the settlement of a real transaction's receipt passed on the default Base endpoints (head and state from one, receipts from the other). Verified by tests on simulated chains (`regression.test.mjs` has at least one scenario per audit finding, `timing.test.mjs` measures a 900-aligned boundary at 250 ms per request on a simulated clock) and by running the command and the container image against loopback stand-ins. Also on 2026-10-05, `--check-public` and `--plan` ran with `--rehearsal` against local forks of both chains carrying the planned registry: the identity check passed, and phases, round data and observations read through the real Multicall3 equalled the same reads made one by one; and `--watch --rehearsal` ran through real rounds and five injected faults on those forks (`scripts/rehearsal/README.md`). Sustained operation and alerting on the status lines are still to be exercised with real credentials.
- There is no market filter and no wind-down mode: a running keeper schedules all four markets two boundaries ahead.
- Registry state lives on Horizen: while Horizen cannot be read, nothing new is planned.
- Against a fresh fork, the first tick has the fork fetch a few hundred storage slots from the endpoint it was forked from; if that endpoint is slow, the first read fails once (`RPC_*`) and the next succeeds. `--plan` makes one pass, so run it again.
- The public endpoints may still not be sized for this. In simulation at 250 ms per request (`timing.test.mjs` prints and bounds these numbers):

  | JSON-RPC calls | Horizen | Base |
  | --- | --- | --- |
  | Minute after a 15-minute boundary | 217, at most 63 in 10 s (98 HTTP requests) | 68, at most 42 in 10 s |
  | The same before views went through Multicall3 | 853, at most 190 in 10 s (125 HTTP requests) | 119, at most 54 in 10 s |
  | Idle, per minute | 9 (was 49) | 5 (was 5) |

  What is left in the boundary minute on Horizen is twelve transactions (ten calls each to price, sign and send, six to settle) and one call per tick. On a chain without the canonical Multicall3 the figures are the old ones. The public Horizen endpoint answered 429 with `Retry-After: 900` on 2026-10-04 to a call rate comparable to the old figure; its actual limit has not been measured. The keeper honours that header, and 15 minutes without Horizen means three five-minute boundaries without openings. A private Horizen endpoint is still recommended for production. A new state directory adds two calls every 15 seconds for its look-back (it was 48), three when a look finds Voidable rounds. Against local forks answering in about a millisecond (the dress rehearsal, 2026-10-05) the same work bunched up: the minute after a 15-minute boundary was 232 and 242 Horizen calls in two runs (114 and 118 HTTP requests), at most 117 and 125 in 10 s, and idle 13 a minute on a new state directory.
- What the report service answers for a boundary days or weeks old has not been observed. For an overdue round a plain "no such report" is taken as final only once a report covering the boundary would have expired anyway, and then, repeated over ten minutes, ends in a void; an error never does (see Voidable rounds). If the service turns out to drop old reports before Base stops verifying them, rounds left unresolved for that long wait until then (about 30 days after their end) and are then voided, although their price once existed.
- On the default Base endpoints, head and state come from one endpoint and receipts from another (see the secrets file). A private Base endpoint removes that split.
- The rollup data and operator fees are quoted, not capped by the transaction; the budget books them at twice the quote.
- The last-report times in the status line are kept in memory: after a restart they are `null` until the first request.

Sources: [REST API](https://docs.chain.link/data-streams/reference/data-streams-api/interface-api), [HMAC authentication](https://docs.chain.link/data-streams/reference/data-streams-api/authentication), [deployed route](../../contracts/deployment/MAINNET.md).
