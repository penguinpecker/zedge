# ZEDGE Vela guest: local evaluation slice

**EVALUATION ONLY**: software TEE, no attestation, test token, fixture oracle; the sender, amount and time the guest sees are trusted from the manager. The ZEDGE engine behind the Vela v0.2.0 guest ABI, for a local evaluation. It is **not** a private, secure, confidential or production exchange: on v0.2.0 the manager can impersonate any account (see [What is trusted or unproven](#what-is-trusted-or-unproven)).

Built and tested, version 4 of the state (2026-10-07, the owner's perps-style design: deposit once on Base, trade from a private balance, withdraw once): deploy, register, the trusted clock tick, the two-phase order book (§9), the registry round mirror with its settlement sweep and archive (§10), **custody on Base**: deposits credited exactly once from the Horizen inbox's records of the Base vault (§6) and withdrawals published as payout records the vault pays (§7), and **Chainlink reports checked in the guest**: a DON-signed report for a round boundary resolves the round that ends there, pays its holders and opens the next round in one transition, with the registry kept as the public record and compared (§10, §12). The trigger's half is `../stack/contracts/src/BookClockTrigger.sol` (UUPS). The stack run of `../stack` predates version 4; the gate for this build is the fork run of `../stack/fork-round.mjs`.

The Horizen mainnet settings of 2026-10-06 stay: chain 26514 with a floor on the cutoff buffer (§2, §9 Cutoff), BTC 900 as the one market and no trading fee (§2), stake limits (§9).

Upstream Vela is under the Business Source License 1.1 (internal evaluation and testing only). No upstream code is copied here, and the guest imports none of it. The conformance test fetches upstream into `build/`, which is git-ignored; it must never be committed. One file, `testdata/host/conformance_test.go`, is ZEDGE code written against upstream's API and compiles only inside that fetched copy.

## Build and test

```sh
go test ./...                    # native unit tests; wasm tests skip until the guest is built
go test -run '^$' -fuzz FuzzEntryPoints -fuzztime 60s -fuzzminimizetime 5s .

./build.sh                       # build/zedge_guest.wasm; needs TinyGo 0.39.0, Binaryen 133, Go 1.25.14
scripts/fetch-upstream.sh        # upstream Vela at 335724c (v0.2.0) and 25af7d6 (dev) into build/upstream/
go test -run 'TestGuest|TestUpstream' -v .
ZEDGE_SOAK_ROUNDS=400 go test -timeout 40m -run TestGuestSoak -v .   # the long memory run, about 11 minutes

npm --prefix ../crypto run check && npm --prefix ../crypto test   # TypeScript side of the shared vectors, request padding (§4) included
go test -run TestVectors -update .                                # only after an intended protocol change
```

- `build.sh` refuses any other toolchain version. Set `TINYGO` and `WASMOPT` to point at the binaries. It prints the wasm's SHA-256, which is the deployment's `applicationFingerprint`.
- This build (2026-10-07, state version 4: Base custody, payout records, in-guest Chainlink verification, own rounds; a report no longer opens a round past its opening deadline): 681,381 bytes, SHA-256 `f38fb91ef2a450f050bb6a3ca53491f0c8c9eaa028df03b47fd14ddef3067320`. The build before that one rule, `a65291cc…` (680,810 bytes), was built twice, here and in a separate copy of `engine/` and this folder with empty TinyGo and Go build caches (and an empty home directory for TinyGo's own cache): byte for byte the same. The previous build (state version 3) was 554,087 bytes, `9cd140d7…`; the 126 KB added are mostly the secp256k1 code.
- Signature recovery is `github.com/decred/dcrd/dcrec/secp256k1/v4` v4.4.1 (latest stable, pinned in `go.mod`). Under TinyGo it computes base-point multiples without its 1 MB precomputed table (`curve_embedded.go`), so neither the table nor its compressed source is in the wasm.
- The build flags are `-target=wasi -scheduler=none -opt=2 -no-debug`. The Vela host never calls `_start`. Two things follow: TinyGo's default scheduler traps in `crypto/sha256`, hence `-scheduler=none`; and TinyGo's initialisers never run, so `cmd/zedge-guest` runs them itself on the first export call. That guard links to a TinyGo runtime internal; `TestUpstreamConformance` is the tripwire.
- `scripts/fetch-upstream.sh` takes the two pinned commits from GitHub, or from a local clone with `VELA_UPSTREAM=/path/to/vela` (no network). `TestUpstreamConformance` skips, naming this script, when a commit is absent. It needs upstream's Go dependencies in the module cache.
- A wasm older than its sources fails the wasm tests rather than testing the wrong program.

| Test | What it shows |
| --- | --- |
| `TestTimeFreePaths`, `Test*Rejected`, `TestContextComesFromTheHost`, `TestBaseDeposits` | Every rule of §1 to §8, natively: Base deposits in index order, exactly once, waiting at a gap, refunded when the engine or a cap refuses them, stopping at a record the inbox could not have written; payout records; a tick behind the clock applied at the clock. |
| `TestChainlinkKnownAnswers`, `TestChainlinkReportsRejected`, `TestChainlinkBlobRules` | §12: all 11 report copies the keeper recorded from Solana (`testdata/chainlink.json`) verify against the pinned DON and read exactly what an independent implementation (viem) read, and each needs every signer viem recovered; altered reports (a byte of the price, the context, a signature, the digest, the offsets, the count, a recovery byte of 2 or 4, one signer twice, five signatures) are refused; a test DON with keys from public labels reaches the blob rules (zero, negative and over-int192 prices, times out of order or past 32 bits, another feed). |
| `TestReportScenario`, `TestReportAfterTheClock`, `TestConfirmation`, `TestOwnVoid` | §10 and §12 at the recorded reports' own times: one report resolves round 0, pays both holders and opens round 1 in one transition; copies, other seconds, other feeds and altered reports are refused in private; a report after a later tick settles at its boundary; the registry's record agrees, or disagrees and the guest's result stands; past eight unconfirmed rounds the oldest are given up in public; a round that never opened voids itself after its opening deadline and void grace. |
| `TestStagingRules`, `TestOrderCapCountsRestingOrders`, `TestCutoff`, `TestTicksOutOfOrder`, `TestStagedOrderForAVoidedRound`, `TestCancelRacingActivation`, `TestExactRetries`, `TestCancelCannotProbeAnotherAccount`, `TestMatchingWorkLimit`, `TestOutcomeCollection` | The rules of §9, natively: staging S1 to S5, the order cap counting only what would rest (an IOC and a GTC filled on arrival pass at four orders), activation at exactly the cutoff and one second before, ticks skipped and replayed, an order for a round the registry voids, a cancel against a fill in both commit orders, exact retries before and after activation and after a refusal, a cancel of another account's order that cannot tell whether it rests, more than four fills, collection by any next request. |
| `TestRoundMirror`, `TestClockRecordBindsThePayload`, `TestSweepAndArchive`, `TestFullRound` | The rules of §10, natively: the guest's own next two rounds, creation only of configured future rounds within the slots, in `(start, asset, duration)` order; refused, undecodable and disagreeing records skipped while the tick still applies; malformed payloads; a clock record that shows a forged record or a stripped deposit record fed in place of the trigger's answer; a void only from the registry's record and at its time; the sweep in each account's own name, skipping staged accounts, sixteen per tick; four archives per tick and their records; and the script's full round, account by account, down to the ledger. |
| `TestEveryReplyHasOneShape`, `TestRequestsAreOneSize`, `TestReceiptsAreOneSize` | Every accepted request has the same public shape: every request is 2,048 bytes whatever it carries (a report included), and every receipt 8,192 bytes whatever it says (§4, §5, §11); a report asks for no tick; a tick publishes only public records. |
| `TestExitReserve` | Using up the engine's evidence IDs cannot strand a balance (§7). |
| `TestStateAtEveryCapFitsTheBound`, `TestFullBookAtEveryCap` | The first gate of §9: a state with every cap reached (now with eight unconfirmed rounds and two pinned DON configurations of 31 signers) encodes under the bound with every number at its widest. Every cap is enforced where it is reached, a state past one is refused, a tick activates sixteen and asks for the next, the busiest tick timed applies 40 engine commands, and the heaviest report (a test DON's, on that state) applies 36: it resolves the open round, pays all 32 holders, archives it and creates the next. |
| `TestStakeLimitPerAccount`, `TestStakeLimitCountsRestingOrdersAsFilled`, `TestStakeLimitAtOneClosingTime`, `TestStakeLimitRestingBidsLeaveTheBoundary`, `TestStakeLimitRefusalShape` | The stake limits of §9: many small orders reaching the limit and one lot past it, resting buys of both sides, mint then sell, a taker refused whole with the maker untouched, a maker's fill that needs no check, a sell that gives up a hedge refused, positions bought from the house filling the all-accounts limit over two rounds at one closing time, a resting bid still taken there but the house's sell into it refused, the house past both user limits but not its own, room freed by a sale, orders that leave a stake at its limit taken, four one-cent bids at the per-account limit leaving everyone else free to trade, a refusing tick identical byte for byte to an idle one, a state past a limit refused. |
| `TestHorizenMainnetDeployment` | §2 on 26514: with the owner's engine configuration the engine's rules hash and round IDs equal those the deployed registry returns; the deploy succeeds with BTC 900 and no fee, and fails with any other market, any fee or a cutoff buffer under the floor; the floor binds the testnets too. |
| `TestEngineReplay` | The same commands and times applied straight to the engine give the same engine state hash, Base deposit evidence and the guest's own rounds included. |
| `FuzzEntryPoints` | No entry point panics; an error carries no effect; no result carries a Vela withdrawal; each entry point has its one public shape; a refusal, a retry or a sync changes nothing but the tick counter (none for a report) and the sender's collected outcome, and staging adds only its item; the ledger is conserved (the engine takes in exactly the deposits a tick credits and pays out exactly the withdrawal payouts published; a refund never touches it); the exit reserve is never spent. Seeded with every step of the script. |
| `TestGuestImports` | The wasm imports only the eight WASI functions Vela v0.3.0 allows. |
| `TestGuestShim` | Hostile pointers and lengths at the wasm exports return error results, not traps. |
| `TestGuestSoak` | The second gate of §9. 840 requests (8,400 in the long run) in one wasm instance, on states at the size bound and on the states with every cap reached, including reports at both and the three busiest ticks and the heaviest report timed (§9): linear memory stops growing and every result equals the native adapter's. Also: the salt is the host's random bytes, and `allocate` stops at the bound. |
| `TestUpstreamConformance` | An 85-step script through upstream's own host runtime, at both commits, returns exactly what the native adapter returned at every step: state bytes, engine state hash, events, error text. Includes runtime restarts, hostile payloads, a payload the guest refuses to allocate, a full account table filled by Base deposits and one refunded, a full round through the registry mirror, a second deployment driven by real Chainlink reports (secp256k1 recovery in the wasm: the report that resolves a round, pays both holders and opens the next, a copy already applied, a report past the boundary, another feed, a changed price), and the three busiest ticks and the heaviest report timed on the states at the caps. |
| `TestVectors` + `../crypto/guest.test.ts` + `../crypto/pad.test.ts` | One committed file, `testdata/vectors.json`, that both languages must reproduce, including each request before and after padding (a report request from the recorded report), the receipts of reports, and public records (clock, credit, refund, payout, settle, confirm) that `guest.ts` decodes. |

## Layout

| Path | Role |
| --- | --- |
| `adapter.go`, `state.go`, `envelope.go`, `result.go`, `chainlink.go` | All adapter logic, ordinary Go, no clock, no randomness. `chainlink.go` is the report check of §12. |
| `testdata/chainlink.json` | The Chainlink reports the keeper recorded from Solana (`../../../services/keeper/solana-fixtures.json`), with what viem read from each. |
| `cmd/zedge-guest/main.go` | The wasm layer: seven exports, buffer table, initialiser guard, the one draw of host randomness. No logic. |
| `testdata/host/conformance_test.go` | ZEDGE code that compiles only inside the fetched upstream module. |
| `testdata/shim.mjs`, `testdata/soak.mjs` | Node drivers for the wasm exports. |
| `../crypto/guest.ts`, `../crypto/pad.ts` | Canonical command encoder, the three request bodies, request IDs, receipt types and public-record decoders for clients; the request padding of §4. |

## Protocol

### 1. Host calls (built)

The guest holds nothing between calls. The host passes the whole state in and takes the whole state out.

| On-chain request | Export the executor calls | Guest behaviour |
| --- | --- | --- |
| `DEPLOYAPP` | `deploy(appId, constructorParams)` | Builds the first state (§2). |
| Any request with `assetAmount > 0` | `deposit(appId, sender, token, value, state)`, before the row for its type | Always fails, `zedge: unsupported token`: custody is the Base vault (§6). The endpoint refunds the amount as a claim. |
| `PROCESS`, non-empty payload | `process_request(appId, sender, 1, plaintext, state)`; the executor has decrypted the payload with the key registered for `sender` | Validates the envelope, then answers a command or a sync with one receipt and one request for a tick (§4, §5), and a Chainlink report with one receipt (§12). A book command is staged, not applied (§9). |
| `PROCESS`, empty payload | none: the host skips the guest | A deposit-only request. |
| `ASSOCIATEKEY` | none: the executor stores the key | — |
| `DEANONYMIZATION` | `process_request(…, 2, …)` | Error `zedge: unsupported request type`. |
| `TRUSTPROCESS` | `trusted_request(appId, payload, state)` | Applies a tick: the clock, the Base deposits, the round mirror and its confirmations, the guest's own rounds, staged book commands, the settlement sweep and archive. Publishes the clock it set and the public records of §11 (§6 to §10). |
| Executor restart (v0.2.0 only) | `load_module(appId)` | Empty result; the host discards it. |

Every export returns `[uint32 little-endian length][JSON]` with `state`, `events`, `appEvents`, `withdrawals` (always empty in this build: the endpoint holds no custody, §7), `fuel` and, on refusal, `error`. `fuel` is the constant `0x1`: nothing meters the guest, so the fee is the endpoint minimum.

A result with `error` makes the endpoint record a failed request, keep the old state and refund any attached deposit as a claim. Error strings are public, so they are constants that describe no account (§11).

The wasm layer reads input only from buffers it handed out through `allocate`. A pointer or length it does not recognise is `zedge: bad buffer`, never a memory read. `allocate` returns 0 for a size below 1 or above 524,288 bytes, the state bound of §3. The host then fails that request itself (`allocate returned null pointer`): the state is unchanged, an attached deposit is refunded and the guest has allocated nothing. A user can cause this only with a payload above 512 KiB, which no valid envelope needs (§4). Checked on both upstream runtimes.

### 2. Deployment and identity (built)

Constructor parameters are canonical JSON, at most 16 KiB:

```json
{"engine":{ …engine.Config… },"applicationFingerprint":"<64 hex>","origin":"http://localhost:5173","epoch":"1","markets":[{"asset":"BTC","duration":900}],"stakeLimits":{"account":50000000,"boundary":200000000,"house":"0x…","houseTotal":2000000000},
 "chainlink":{"feedId":"0x00039d9e…75b8","configs":[{"digest":"0x00094bae…17ee","f":5,"signers":["0x…", …]}]},"custody":{"chainId":8453,"vault":"0x…","inbox":"0x…","usdc":"0x833589fcd6edb6e08f4c7c32d4f71b54bda02913"}}
```

1. `engine.domain.applicationId` must be `""`. Vela derives the application ID from the deploy request itself, so the guest takes it from the host's `appId` argument, written in decimal. `appId` 0 is refused.
2. `engine.domain.chainId` must be 31337 (local Anvil), 26514 (Horizen mainnet), 2651420 (Horizen testnet) or 84532 (Base Sepolia), the networks `session.ts` accepts. Any other chain fails deploy. On every chain but 31337 the engine's `oracle.cutoffBuffer` must be at least `MinPublicCutoffBuffer`, 30 seconds (§9, Cutoff).
3. `engine.oracle.chainId` must equal `engine.domain.chainId`. The trigger reads the registry in the block whose time it reports (§10), so the registry has to be on the endpoint's own chain. A registry on another chain fails deploy.
4. `engine.authority` must be the trigger contract's address. The guest cannot check that. It is the engine's reserved system principal: it can never register, deposit or trade, and withdrawals to it are refused. The trigger is deployed first; its address goes into these parameters and into `submitDeployRequestWithTrigger`.
5. `applicationFingerprint` is the wasm's SHA-256. The guest cannot measure itself; the executor checks the deploy descriptor's hash against the module. A client must check that the descriptor hash and this value are the same before trusting either.
6. `origin` is the one web origin clients put in their session domain: `http://` or `https://`, then lowercase host characters and an optional port. The guest checks that shape only.
7. `epoch` is the key epoch, 1–10 digits with no leading zero. It is fixed for the life of the deployment; there is no rotation.
8. `markets` is the list of registry schedules the deployment mirrors (§10): exactly one in this build (`MaxSliceMarkets`), asset `BTC` or `ETH`, duration 300 or 900. On 26514 it must be exactly `[{"asset":"BTC","duration":900}]`, the owner's one market. The trigger keeps its own immutable copy; the two must be the same, which the guest cannot check.
9. `stakeLimits` are the limits of §9 (Stake limits), required on every chain: `account`, `boundary` and `houseTotal` in collateral atoms, each 1 to 10^15, with `account` at most `boundary`; and `house`, the market maker's address in lowercase, which may not be `engine.authority` (it can never trade, so the market would have no maker), `domain.endpoint` or `collateral`. They are fixed for the life of the deployment.
10. `engine.New` validates the rest, including the registry rules hash.
11. `chainlink` pins the Data Streams DON whose reports the guest checks itself (§12): `feedId` must be the engine's BTC feed; `configs` holds 1 to `MaxDigests` (2) entries, each a config digest (0x and 64 lowercase hex, not zero, no two alike), its fault tolerance `f` ≥ 1 and its signers (lowercase addresses, distinct, at least 3f + 1, at most 31), as the Base verifier's `ConfigSet` recorded them. Deploy also requires that a report request for the largest `f` pinned, with the longest request ID, fits the 2,048-byte request with this deployment's own domain (§4): with `f` = 5 an origin of up to about 200 characters. Two digests, not four: each pinned config can hold 31 addresses in the state, and four would take the state at every cap past its bound (§9).
12. `custody` names the money (§6, §7): `chainId` 8453 (Base), the `vault` proxy (`BaseCustodyVault`), the Horizen `inbox` proxy (`HorizenDepositInbox`), and the `usdc` it holds; addresses distinct from each other, from the endpoint and from the authority. `engine.collateral` stays Horizen USDC.e: the registry's rules hash, and so every registry round ID, commits to it. It only labels the engine's atoms, one per Base USDC atom.
13. The wasm layer draws 32 bytes from the host's `random_get` and the state keeps them as `salt`. If the host's random source fails or gives only zeros, deploy fails with `zedge: internal error`. The salt is the only secret in the state: without it the public state root would confirm guesses at private commands (§11). It is never sent to anyone.

Every later call must carry the same `appId`, or it fails with `zedge: wrong application`.

**Horizen mainnet (26514).** The owner's deployment (a new application on the same endpoint, `../stack/build/mainnet-recipe/deploy-book.mjs`) mirrors the registry proxy deployed on 2026-10-06 (`../../../contracts/deployment/MAINNET.md`). Its engine configuration, addresses in lowercase as the guest requires: `collateral` `0xdf7108f8b10f9b9ec1aba01cca057268cbf86b6c` (USDC.e, 6 decimals, read from the token); `oracle.chainId` 26514, `oracle.registry` `0x4dd4aacdb7e8d2e6d06c5af38238f3deab836744`, `oracle.oracle` `0xc800c3f18d35d492ae6b07655d7f31bfe98a4b6b` (the price cache), the two stream IDs, `decimals` 18, `observationWindow` 60, `openingGrace` 150, `voidGrace` 300, `cutoffBuffer` 30. With these the engine's rules hash is the registry's own `rulesHash`, `0x65e485f8468fda2de9d8681ee9fbbff779acabf1451e29a3d2cb2248b2a30ba6`, and its round IDs are what the registry's `roundIdFor` returns (BTC 900 and BTC 300 at 1791100800, read from the chain on 2026-10-06); `TestHorizenMainnetDeployment` holds both and deploys it with `markets` BTC 900. `feeBps` must be 0 on 26514: no engine operation pays collected fees out, so every fee would stay in the endpoint's custody for good (§7). `domain.endpoint` and `authority` (the trigger) come from the owner's own Vela deployment and are not fixed here. The guest checks the shape of these addresses, not their values: whoever deploys must check them against this list.

### 3. State (built)

Canonical JSON, at most 524,288 bytes (512 KiB):

| Field | Meaning |
| --- | --- |
| `version` | 4. Versions 1 (time-free), 2 (before stake limits) and 3 (custody in the endpoint) are refused. |
| `applicationFingerprint`, `origin`, `epoch`, `markets`, `stakeLimits`, `chainlink`, `custody` | From the constructor parameters. |
| `salt` | 64 hex characters drawn at deploy (§2). Never changes. |
| `clock` | `block.timestamp` of the last accepted tick. 0 until the first tick. At most 4,294,967,295. |
| `block` | `block.number` that tick reported. Recorded, never compared. |
| `tickSeq` | Number of ticks requested so far: one per accepted `PROCESS` request, and one per tick that carries on past the activation cap (§9, A4). |
| `lastTick` | Highest tick number applied. |
| `staged` | `[{tick, command}]`: book commands waiting for their tick (§9), in tick order, at most one per account. |
| `outcomes` | `[{account, commandId, tick, status, reason}]`: what activation did with a staged command, until its account collects it (§9). Sorted by account, at most one per account. |
| `deposits` | Base deposits credited to the engine (one evidence ID each). |
| `depositsSeen` | The last Base deposit index processed, credited or refunded (§6). |
| `withdrawals` | Withdrawals the engine exported (two evidence IDs each). |
| `payouts` | The last payout ordinal: withdrawals and refunds (§7). |
| `unconfirmed` | `[{round, opening, closing, outcome}]`, oldest first, at most 8: rounds the guest settled from a report, with the report hashes and outcome, until the registry's record of them is compared (§10). |
| `engine` | The engine snapshot, including its configuration. |

A state is accepted only if it is byte for byte what the adapter would write, and:

- the identity fields and the stake limits have the shapes of §2, the salt is 64 lowercase hex characters and not all zeros, the engine domain names a supported chain and a decimal application ID, the registry is on that chain, a public chain's cutoff buffer is at least the floor and 26514 mirrors BTC 900 alone with no trading fee;
- the engine snapshot passes `engine.Validate`;
- `lastTick ≤ tickSeq`, `clock` is 0 exactly when `lastTick` is 0, `clock ≤ 4,294,967,295`, and the engine's time is not ahead of `clock`;
- the engine holds exactly `deposits + 2 × withdrawals` evidence IDs, no claimable amount and no open withdrawal; `deposits ≤ depositsSeen`, and `payouts = withdrawals + (depositsSeen − deposits)`: every Base index seen was credited or refunded, and every payout is a withdrawal or a refund;
- `chainlink` and `custody` have the shapes of §2; `unconfirmed` holds at most 8 distinct rounds, each with an opening hash, and a closing hash exactly when it has an outcome (Up or Down);
- the engine holds at most 32 accounts, 8 rounds and 4 active orders per account (§9), and no stake is above its limit (§9, Stake limits);
- every staged command is a book command of a registered account, with that account's next nonce, at most 576 bytes of canonical JSON, under a tick that was asked for; ticks strictly ascend, so no account has two;
- every outcome names a registered account, a command ID of that account, a tick already applied, and `applied` with no reason or `rejected` with one; outcomes are sorted by account.

This detects a malformed or inconsistent state. It does not show that a state is genuine or current.

**Why 512 KiB and not the engine's 8 MiB.** The whole ledger is one JSON document, and every request allocates several buffers as large as it. TinyGo's collector treats every constant in the wasm's data section as a possible pointer, so a dead buffer that one of them happens to point into is never freed. Small buffers are rarely hit. Buffers much above half a megabyte are hit faster than they are reused, linear memory doubles, and wasm memory never shrinks. Measured on the built wasm under Node (same allocate, call, free order as the host; not wasmtime):

| What was repeated in one instance | Linear memory |
| --- | --- |
| `allocate(1 MiB)` then `deallocate` | 3,072 MiB after 1,787 rounds, still doubling |
| 2,000 mixed requests on a 393, 459, 525 or 655 KB state | 96 MiB, flat |
| The same on a 787 KB state | 768 MiB after 860 requests |
| The same on a 1.05 MB state | 768 MiB by request 35 |
| The time-free build, 3,200 mixed requests on a 522 KB state (`TestGuestSoak`, long run) | 96 MiB, flat from the second round |
| The previous build, 6,800 requests on 522 KB states and on the 389 to 465 KB states at the caps, including 1,600 ticks that each apply 17 to 40 engine commands (`TestGuestSoak`, long run; wasm `9cd140d7…`) | 96 MiB, flat from the first round |
| This build, 8,400 requests on 522 KB states and on the states at the caps, including 1,600 ticks of 17 to 40 engine commands, 400 reports that each apply 36, and 1,600 reports checked on states at the bound and at the caps (`TestGuestSoak`, long run, 2026-10-07, wasm `a65291cc…`) | 96 MiB, flat from the first round |
| An earlier version-4 build whose report path ran the engine's checkpoint on a 522 KB state before finding nothing to apply | 96 MiB, then 192 MiB at round 9: a report now touches the engine only when a round is due (§12) |

So the bound is a measured one, with about 25% in hand, and `TestGuestSoak` holds it: it fails if memory is still growing after the first quarter of its run or ends above 192 MiB. It depends on the constants in this exact wasm, so it must be re-run for every build. A state above the bound is refused like any other invalid state, and `allocate` will not even take it (§1).

This build cannot write a state above the bound: the caps of §9 hold it there. A state with every cap reached is 478,772 bytes, and at most 523,785 with every number at its widest (`TestStateAtEveryCapFitsTheBound`, §9; version 4 added the pinned DON, custody and the unconfirmed rounds, and dropped the deposit notices). An encoding above the bound is refused anyway, so a request that would write one fails with `zedge: internal error` and changes nothing.

### 4. Envelope (built)

`process_request` receives the plaintext `adapters/vela/crypto/session.ts` encrypts: canonical JSON with these keys in this order, exactly 2,048 bytes (`RequestBytes`).

```json
{"version":1,"domain":{"chainId":31337,"endpoint":"0x…","applicationId":"…","applicationFingerprint":"…","rulesHash":"…","origin":"…"},"account":"0x…","epoch":"1","requestId":"…","kind":"command","body":{…,"pad":"000…"}}
```

Checks, in order. The first that fails is the public error returned.

| # | Check | Error |
| --- | --- | --- |
| 1 | Request type is 1 (`PROCESS`). | `unsupported request type` |
| 2 | State is valid and belongs to `appId`. | `invalid state`, `wrong application` |
| 3 | Sender is 20 bytes and not zero. | `malformed sender` |
| 4 | Payload is exactly 2,048 bytes and is exactly the canonical JSON above: no unknown, reordered or duplicate keys, no whitespace, no trailing bytes; `body.pad` holds only `0`. | `malformed envelope` |
| 5 | `version` is 1, `kind` is `"command"`, `epoch` is the deployment's, and all six domain fields equal the deployment's. | `wrong context` |
| 6 | `account` equals the host-supplied sender. | `sender mismatch` |
| 7 | `body` is one of the three shapes below. | see below |

Domain values: `chainId`, `endpoint` and `applicationId` come from the engine domain; `applicationFingerprint` and `origin` from the constructor parameters; `rulesHash` is the SHA-256 (lowercase hex) of the canonical JSON of the stored engine configuration. It is not the registry's Keccak rules hash, which is one field inside that configuration.

Bodies:

- `{"type":"sync","pad":"0…"}` with `requestId` equal to `<account>:sync`. Anything else in a sync is `malformed envelope`.
- `{"type":"report","report":"<base64>","pad":"0…"}` with `requestId` `<account>:report:<n>`: a Chainlink full report in standard, padded base64 (anything else, or a command beside it, is `malformed envelope`), checked as §12 says; `n` must be its `observationsTimestamp` (`wrong context`). Any sender with a registered key may send one.
- `{"type":"command","command":"<text>","pad":"0…"}` where `<text>` is the canonical engine command JSON `engine.DecodeCommand` accepts (`malformed command` otherwise; the envelope's length keeps it far below the engine's own 8,192-byte limit). Then `command.account` must equal the sender (`sender mismatch`), and `command.id` must equal both `requestId` and `<sender>:<nonce>`, and `command.domain` must equal the engine domain (`wrong context`).

`../crypto/guest.ts` builds the three bodies without the pad (`commandBody`, `syncBody`, `reportBody(fullReportHex)`), and `../crypto/pad.ts` adds it: `session.encryptCommand(id, padBody(session, id, commandBody(command)))`. `encodeCommand`'s output is the `<text>`; its SHA-256 is the command digest. It throws on anything the engine would read differently, including an empty value of the wrong type (`roundId: 0` on `cancel_all` is an error, not "every round").

**Why every request is 2,048 bytes.** The request's ciphertext is public: it is calldata of `submitRequest`, the endpoint stores it until the request is processed, and `getNextPendingRequest` returns it. The executor's encryption adds a fixed 28 bytes and pads nothing, so before this rule the length gave away the kind of command and, for an order, its outcome and side (measured in review: 536 bytes for a sync, 852 for `cancel_all`, 948 for a mint, 1,061 to 1,064 for the four kinds of `place_order`). The client pads the body with zeros to the one length, and the guest refuses any other length, so a client that does not pad fails in public with `malformed envelope` and leaks no command. Every request the guest could accept fits: the longest, a book command as long as staging takes (§9, S4) with the longest origin, application ID, epoch and nonce, is 1,424 bytes (`TestRequestsAreOneSize`); every ciphertext on chain is 2,076 bytes (checked on the stack, `../stack/README.md`). The price is storage: the endpoint keeps about 65 words of ciphertext per pending request, against 30 to 35 before. (Added after review; the earlier text said a staged command was invisible on chain, which the request length contradicted.)

### 5. Commands (built)

**Authority.** The engine context is built in two places only. A user context is `{principal, timestamp: clock, system: false}`, where the principal is the host-supplied sender, or, in a tick, the account that staged the command being activated or whose shares are swept (§9, §10). A system context is `{principal: engine.authority, timestamp: clock, system: true}` and is used only for commands the adapter itself constructs: the deposit credit, the export and claim credit that follow an accepted withdrawal request, and in a tick the checkpoint, the round mirror and the archive. No byte of a client payload selects the principal, the time or `system`; in a tick the clock is the tick's own timestamp.

**Clock.** Before the first tick (`clock` 0) every command and every report fails with `zedge: clock not initialised`. Only `sync` works.

**One reply shape.** Every `process_request` that passes §4, with the clock set or as a sync, ends the same way:

- `tickSeq` goes up by one and the result carries exactly one public app event asking for that tick (§8);
- the sender gets exactly one receipt, 8,192 bytes long (§11);
- a withdrawal that was accepted adds its public payout record (§7), which is public in any case.

A report (§12) is the exception: it is public anyway (anyone may send one), so it gets one receipt and asks for no tick, the clock having moved already.

A sync is that and nothing more. On chain, an applied command, a staged one, a refused one, a retry and a sync are therefore the same thing: one request of one length (§4), one encrypted event of one length and one tick request. Only a public error (the list in §11) looks different, and it carries no receipt. What still differs is listed in §11 under **Residual channels**.

**Direct commands.** After the checks in §4 a command is handled as follows.

| Operation | This build |
| --- | --- |
| `register` | Applied at once. A 33rd account is refused in private: `account capacity` (§9). |
| `request_withdrawal` | Applied at once; export and claim credit follow in the same transition, and a payout record is published (§7). |
| `mint`, `merge`, `redeem` | Passed to the engine at once: `mint` needs an open round before its cutoff, `redeem` a settled round, `merge` neither. |
| `cancel_withdrawal` | Passed to the engine, which always refuses it: no withdrawal stays open (§7). |
| `place_order`, `cancel_order`, `cancel_all` | Staged, then applied by a later tick at that tick's chain timestamp (§9). |
| Any authority operation | Refused in private by the engine: `wrong authorization class`. |

Direct commands run at `clock`, which is the past. That is safe for these operations: none of them reads the order book, and none gains from an old time. A mint accepted after the real cutoff creates a pair that is always worth exactly one unit and can be merged back at any time. Every receipt says which clock it was judged at (`at`, §11). An account with a staged command is frozen and sends no direct command until it is activated (§9, S3).

**Private refusal.** Once the checks in §4 pass and the clock is set, a refusal is not an error, whether it comes from the engine or from the adapter's own rules (staging and the caps, §9; withdrawal destinations and the exit reserve, §7). The request succeeds with the reply shape above: the ledger (the `engine` part of the state) is the input's byte for byte, there is no withdrawal, and the receipt has `status: "rejected"` and the reason. On chain such a request is `COMPLETED`: completion does not mean the command was accepted, so a client must read its receipt. A refused command does not consume its nonce.

**Retry.** If the command is byte for byte the account's latest accepted command, the engine returns the original receipt and changes nothing. The adapter then leaves the ledger as it was and sends the original receipt again with `status: "retry"`, and no payout. An older nonce, or a different command under the latest nonce, is a private refusal.

### 6. Deposits: Base custody (built)

The money is native USDC on Base in the `BaseCustodyVault` (`custody.vault`, §2); nothing is held by the endpoint. A user deposits once on Base (`depositWithPermit`, sent by our relayer); the vault numbers each deposit (`index` 1, 2, …) and sends `receiveDeposit(index, account, amount)` through Horizen's native messenger to the `HorizenDepositInbox` (`custody.inbox`), which stores each index once (`../../../contracts/src/`). The guest learns of deposits only from the inbox, through the trigger (§8, §10):

1. Every tick request carries `nextDeposit` = `depositsSeen + 1`. The trigger reads `inbox.recordsFrom(nextDeposit, 8)` in the block it answers in and appends up to 8 records `index, account, amount` to the payload (version 3).
2. The tick applies them in order, after the checkpoint and before the round mirror: an index at or below `depositsSeen` is skipped (a repeat); an index above `depositsSeen + 1` stops the run (a gap: wait for it); a record the inbox could not have written (an index past 10^15, an account with high bytes or zero, an amount of zero or past uint96) stops it too.
3. The next index is credited: if the engine has never seen the account, the adapter first applies its one canonical `register` (nonce 1, its own user context), then the engine's `deposit` as the authority, with evidence `SHA-256("ZEDGE_VELA_V1:BASE_DEPOSIT:8453:<vault>:<applicationId>:<index>")`: a chain event, so the engine itself refuses a second credit of the same deposit even if the adapter's counter were wrong. The exit reserve of §7 must still hold afterwards. Then `depositsSeen = index`, `deposits += 1`, and the tick publishes a `credit` record with status 1.
4. If the engine or a cap refuses it (the 33rd account, the authority as depositor, the atom or lifetime cap, the exit reserve), the deposit is refunded in full: `depositsSeen = index`, a `payout` record of kind 2 to the depositor (§7), and a `credit` record with status 2 and that payout's ordinal.

So every Base index ends in exactly one of the two, once. A deposit is credited whether or not the account has a book command staged: it touches no user nonce. No receipt is sent; the account sees its balance in its next receipt's view, and the public `credit` record tells it when.

Reconciliation, at any accepted state root: Σ credited = engine `deposited`; Σ vault `Deposited` = Σ credited + Σ refunded + deposits still in flight; the vault's USDC = Σ `Deposited` − Σ vault `Paid`.

A Vela deposit (`assetAmount > 0` on any request) always fails with `zedge: unsupported token`, and the endpoint refunds it as a claim.

### 7. Withdrawals: payout records (built)

1. A `request_withdrawal` whose destination is the endpoint, the authority (the trigger) or the vault is refused in private: `withdrawal destination not allowed`.
2. Otherwise the engine applies the request. If it is accepted and is not a retry, the adapter applies, in the same transition, `export_withdrawal` and then `confirm_claim` as the authority, with evidence IDs `…:WITHDRAWAL:…:<n>` and `…:CLAIM:…:<n>` (`n` = `withdrawals + 1`, the format of version 3). If either fails, or the exit reserve below would not hold afterwards, the whole command is a private refusal and the ledger does not change.
3. The result carries no Vela withdrawal. It publishes a `payout` record: `applicationId, ordinal, kind 1, account, to, amount`, with `ordinal = payouts + 1`, and the receipt says `withdrawal: <ordinal>`. The payout signer (`../../../services/payout-signer/`) reads it after the transition is committed, signs it (EIP-712 `Payout`, domain "ZEDGE Vault" "1" 8453) and submits it; the vault pays `amount` USDC to `to` on Base, once per `(applicationId, ordinal)`, within its per-payout and daily caps.

`confirm_claim` here means "the payout record is published with the state root", not "the tokens left the vault". The guest never learns of the Base payment; the engine record is closed in the same transition, so the engine's `claimable` is always 0 and no withdrawal is left open. Trust: the payout signer and the vault's owner are the operator, as they were for the endpoint's custody.

**Exit reserve.** The engine holds at most 4,096 evidence IDs and never frees one. A deposit uses one and a withdrawal two, and the IDs here are ordinals that deduplicate nothing. Left alone, one account recycling a single atom (one request carrying a one-atom deposit and a one-atom withdrawal uses three IDs) would use them all in 1,365 requests, and then no balance could ever leave. So the adapter keeps two IDs back for every account that still holds something. After any deposit or withdrawal this must hold:

```
4,096 − evidence IDs used  ≥  2 × (accounts holding cash or shares)
```

- A deposit that would break it is refunded through a payout (§6).
- A withdrawal that would break it is a private refusal: `exit reserve reached: only a withdrawal of the whole balance is accepted`.
- A withdrawal of an account's whole balance never breaks it: the account stops counting.

A deployment that runs out of IDs therefore ends closed, not locked: no more deposits and no more partial withdrawals, and every account can still take its whole balance out once. With all 32 accounts of the slice funded the reserve is 64 IDs, so at least 4,032 are usable. This costs nothing in the engine and is why the limit in [Limits](#limits) is survivable; the limit itself is still an engine matter.

**Custody.** At any accepted state root: Σ credited deposits = engine `deposited`; Σ withdrawal payouts (kind 1) = engine `paidOut`; engine `custody` = `deposited` − `paidOut` (no trading fee on 26514, §2); and on Base, the vault's USDC = Σ `Deposited` − Σ `Paid`, with Σ `Paid` ≤ Σ payout records (all kinds) and each paid once.

### 8. Chain time (built; the trigger is `../stack/contracts/src/BookClockTrigger.sol`)

The only clock is a trigger contract answering inside the endpoint's own transaction, and, since version 4, a Chainlink report's own DON-signed boundary time (§12).

1. **Asking.** Every accepted command or sync (§5) increments `tickSeq` and emits one public app event: subtype `SHA-256("zedge.vela.tick.v1")` = `0x8af869f39217eabc1718875ec064086a0e0283d1c1ee8a025b687fd40b5e3850`, data = 32-byte big-endian words: the new `tickSeq`, the next Base deposit index wanted (`depositsSeen + 1`, §6), then the number of rounds the engine holds as scheduled, as open, and of settled rounds awaiting the registry's confirmation, then their registry round IDs in that order (§10). With no round held that is five words. A `sync` is the way to ask when there is nothing else to send; any sender with a registered key may send one, at any time.
2. **Answering.** The endpoint calls the trigger at the end of every successful `stateUpdate`. `BookClockTrigger` (UUPS behind an `ERC1967Proxy`, owner the deployer, renounce disabled; `initialize(owner, endpoint, registry, inbox, asset, duration)`) does exactly this:
   - `getTrustProcessPayload`: find the first tick subtype in `appEventData` with at least 32 bytes of data and return the version-3 payload: the words `3, block.chainid, endpoint, block.number, block.timestamp, tick, n, d`, then `n ≤ 16` registry records of 19 words (§10) and `d ≤ 8` deposit records of 3 words (§6). A request of any other shape (32 bytes, the time-free build's; a deposit index of 0 or past uint64; counts that do not match the IDs sent; more than 16 IDs) gets `n = d = 0`: a plain clock tick. `block.timestamp` is the timestamp of the block that committed the asking transition. With a tick request present it never reverts: the endpoint swallows a revert and the tick is silently lost.
   - Return empty bytes in every other case, and in particular for the guest's public records (§11). A trigger that answered a tick's own record would loop.
   - `execute`: do nothing. `withdraw`: move nothing and return two empty arrays. The trigger never holds tokens.
   - Accept calls from the endpoint only.

   The registry and the inbox are called with a gas limit each (250,000 per `createRound`, 60,000 per read, 150,000 for `recordsFrom`) and without Solidity's ABI decoding, so either can revert, burn gas, answer garbage or be upgraded into something else and only delay rounds or deposits, never the clock (`../stack/contracts/test/BookClockTrigger.t.sol`: hostile registries and inboxes; the busiest honest answer, 16 IDs asked, two slots created and eight deposits, about 400,000 gas). `EvaluationClockTrigger` serves the state-version-3 application already deployed and is left as it is.
3. **Applying.** `trusted_request` accepts the payload only if all of these hold, else it fails and nothing changes:
   - version 3 and exactly 256 + 608n + 96d bytes with n ≤ 16 and d ≤ 8; `chainId` and `endpoint` equal the engine domain; every integer in the first eight words fits 64 bits; `1 ≤ timestamp ≤ 4,294,967,295`; `blockNumber ≤ 10^15` (`zedge: malformed trusted payload`);
   - `lastTick < tick ≤ tickSeq` (`zedge: stale or unknown tick`).

   It then sets `clock` to the larger of the clock and the timestamp, `block` and `lastTick`, and applies an engine `checkpoint` as the authority at the new `clock`, which releases expired orders; then, at that same time, the Base deposits (§6), the round mirror and its confirmations (§10), the guest's own void and next rounds (§10), activation (§9), the settlement sweep and the archive (§10). A tick stamped behind the clock applies at the clock: a report may have moved the clock past Horizen's block time (§12), and the tick must not be lost. (Version 3 refused it, `zedge: clock regression`; that error is gone.) Ticks may be skipped; they may not be replayed or reordered. The block number is recorded and not compared with the previous one. The timestamp cap is the largest time any engine round can use; a value in milliseconds is above it.
4. **Publishing.** The tick's result carries first one public app event: subtype `SHA-256("zedge.vela.clock.v1")` = `0xfcec946954aa78965de9f0bba32063a87447ec772e05beb1e50c0e36f5f09460`, data = seven 32-byte big-endian words: `tick`, `blockNumber`, `timestamp` as applied, the number of registry records applied and skipped (§10), the number of deposits processed (§6), and the Keccak-256 of the whole trusted payload the tick was fed. Then the credit, payout, settle, confirm and archive records (§11). It carries no receipt. It carries the tick subtype only when staged commands it was due to activate are left over (§9, A4); each such tick activates at least one, so the chain of ticks ends.

   This record is what makes the clock and the round records checkable from outside. The request for tick `k` is an app event in a transaction of some block `B`, so the only genuine record for `k` is `(k, B.number, B.timestamp, …)`. The trigger's answer is stored by the endpoint in its trigger queue (readable with `getNextPendingRequest` at `B`), and the trusted request's ID on chain is `keccak256(abi.encode(trigger, applicationId, TRUSTPROCESS, keccak256(payload), 0, 0, index))`. So an observer checks, for every trusted request, that the clock record its transition published carries `B`'s number and time and the Keccak-256 of the payload the trigger stored for it. A record that differs proves the enclave was fed a payload the trigger did not produce: a forged clock, or a substituted or stripped round or deposit record. (The counts alone could not show a record replaced by another of the same count, or a stripped deposit record that would have changed nothing; the hash shows both.) Missing tick numbers show ticks that were lost or withheld, and the block a record lands in shows how late it was applied. Each receipt also carries the clock it was judged at (§11). All of this detects; none of it prevents (see [What is trusted or unproven](#what-is-trusted-or-unproven)).

A lost tick (the trigger reverted, or its trusted request failed) is replaced by the tick of any later request.

One wrong tick that is accepted still moves the clock for good: after a tick stamped a year ahead, every genuine tick is a regression until real time catches up. The cap only rules out values that are not seconds at all.

Bootstrap: the deploy result cannot carry an app event, so a new deployment has no clock. One account registers a key (`ASSOCIATEKEY`) and sends a sync; the first applied tick sets the clock, creates the next two rounds and credits the deposits waiting in the inbox, and commands and reports work from then on.

Cost: every command or sync is followed by one trusted request, so two transitions, and the endpoint stores each trusted payload on chain until it is processed: 256 + 608n + 96d bytes (§6, §10); and each request's 2,076-byte ciphertext (§4). A report is one transition. That is the price of one request shape (§11) and of a clock that is as fresh as the last request.

### 9. Two-phase book commands (built)

`place_order`, `cancel_order` and `cancel_all` are the book commands. The rule is: **the order book changes only inside `trusted_request`, in tick order, at the tick's chain timestamp.** `process_request` and `deposit` never change it.

**Staging (`process_request`).**

- S1. The envelope and command pass §4, and the clock is set.
- S2. The account is registered and the command's nonce is its next engine nonce; otherwise a private refusal. (The account's latest accepted command, resent, is a retry as in §5.)
- S3. An account holds at most one staged command. While it holds one:
  - the same bytes again get the `staged` receipt again; the item keeps its original tick number;
  - any other command from that account is a private refusal (`a staged command is waiting for its tick`);
  - `sync` still works.
- S4. Any book command whose canonical JSON is longer than `MaxStagedBytes` (576 bytes) is a private refusal (`command too large to stage`): every book command the engine could accept is at most 519 bytes, and without the bound 32 accounts could each keep an 8 KiB command in the state until its tick, which the budget below does not allow. (Added while building: the design bounded staged commands in its budget but not in its rules.) The order cap is not checked here but at activation (A0), on what the order would leave resting. (Changed after review: a staging check of the cap refused an IOC from an account quoting four orders, though an IOC never rests.)
- S5. Otherwise `{tick, command}` is appended to `staged`, where `tick` is the tick this very reply asks for (§5), and the receipt has `status: "staged"` and that tick. Nothing in the engine changes, nothing is reserved, and no nonce is consumed.

A staged command has the request length and the reply shape of every other request (§4, §5): neither shows the staging. One thing can: the settlement sweep, and a report's payment of a round's holders, skip staged accounts, which can delay an archive record (§11, residual channels). (Version 3 also refused a Vela deposit from a staged account in public; deposits now arrive through ticks and are credited whatever is staged.)

**Activation (`trusted_request` for tick `k` at timestamp `T`).** After the checkpoint and the round mirror (§10), staged items with `tick ≤ k` are applied in ascending tick order, at most `MaxActivations` of them, each with the context `{principal: command.account, timestamp: T, system: false}`.

- A0. A `place_order` the engine accepts but which would leave its account with more than `MaxAccountOrders` active orders is rejected (`order capacity`) and the engine's result dropped, fills included. Only what would rest counts: an IOC, or a GTC filled on arrival, is taken from an account with four orders. (Changed after review: the cap was checked before the engine, which refused orders that never rest.)
- A1. Accepted with at most `MaxFills` fills: the item is removed and the outcome `applied` is recorded for its owner.
- A2. Refused by the engine, or accepted with more than `MaxFills` fills (the adapter then drops the engine's result, as the engine itself does at 64): the item is removed and the outcome `rejected` is recorded with the reason (`matching work limit; split order` in the second case). The nonce is not consumed. A taker facing many small orders has to split its order. **The book is private, so a taker cannot see how to split, and the cap can be used against it:** one account resting four one-lot orders (1,000 share atoms each) at the top of the book refuses every taker that would need a fifth fill, even with real liquidity one cent behind, for the price of those four lots and the request fees; each account can add one order per tick, so a few accounts keep it up for good. A refusal also tells the taker, without a trade, that at least five maker orders sit within its price and size. The adapter cannot fix this alone, because it can only take or drop the engine's whole result, and raising `MaxFills` does not fit the state budget (every account's stored last receipt keeps its fills). The fix is an engine change: a per-command fill limit at which matching stops and the remainder follows its time-in-force (a GTC rests, an IOC is released), so that the adapter passes `MaxFills` to the engine instead of refusing afterwards. Accepted for the evaluation, not solved (stated after review).
- A3. Items with `tick > k` stay staged.
- A5. A `place_order` the engine accepts but that would leave any stake above its limit is rejected (`stake limit: account per round`, `stake limit: all accounts at this closing time` or `stake limit: house total`, see Stake limits below) and the engine's result dropped, fills included. Checked after A0. (Added for the mainnet deployment.)
- A4. If items with `tick ≤ k` are left over because of the cap, the tick's result also carries one tick request (§8.1), so the trigger answers again and the next tick carries on. Each such tick removes at least one item, so the chain is at most ⌈staged ÷ `MaxActivations`⌉ ticks long. With nothing left over a tick never asks for a tick.

A tick sends **no receipt to anyone**. Every tick has the same public shape, the clock record of §8.4 followed by any archive records of §10, whether it activated nothing, rested an order or filled twenty; what timing and the archive records can still show is in §11 (residual channels). Only a tick left with more than `MaxActivations` due commands also asks for the next tick: that shows that many were staged, not what they were. Results are collected by each account with its own next request:

- **Outcome.** The state keeps at most one outcome per account, `{account, commandId, tick, status, reason}`, sorted by account. The account's next accepted request of any kind (a command, a staged command, a refusal, a retry, a sync or a deposit) returns it in its receipt as `outcome` and removes it; a request that fails with a public error changes nothing and returns nothing. For `applied`, `outcome.receipt` is `engine.ProjectReceipt` of the account's stored last receipt, read before that request's own command is applied; it holds the fills. It is attached only while the stored last receipt is still that command's: the account's next ledger command, its own or a settlement sweep (§10), replaces the stored receipt, and the outcome then comes back without it. **That loses a taker's fill detail.** An IOC, or an order filled on arrival, leaves nothing in the view, so when a sweep replaces the stored receipt before the account collects its outcome, the taker learns that its command was applied and its net cash and holdings, but not its fill prices, sizes or fees. This is the ordinary schedule: the tick that activates an order in one round can settle the previous round the account holds, and so can any tick before the account's next request. The same replacement ends §5's exact retry: the command is no longer the account's latest, so a resend of its bytes is refused (`replayed, conflicting or out-of-order nonce`). A client therefore decides what happened from the outcome, which comes back once with its next request of any kind, and from the view's nonce, never from the status of a resend. Keeping the fills in the outcome would need state the budget below does not have, so it waits for the engine change of the first decision. Accepted for the evaluation (stated after review).
- **View.** Every receipt carries `view`: `engine.AccountView` of its recipient after the request: cash, reserved cash, holdings, its own active orders with their filled quantity, filled notional and fee paid, and its nonce. A maker learns of fills and releases from its view. A maker's order trades only at its own price, so an order's fills follow from its filled quantity, and an order that is gone was either filled (the cash arrived) or released (the reservation came back). A client takes its next nonce from its latest view, never from its own count. Even that can be overtaken: the settlement sweep (§10) redeems in the account's own name with its next nonce, so a command signed from the latest view and committed after any tick that sweeps the account is refused in private with `replayed, conflicting or out-of-order nonce`. This happens at round boundaries, when a round the account holds settles. A client that gets that refusal re-signs with the nonce of the view in the same receipt (another fee and round trip), or redeems its own settled shares before its next command.

So neither the taker's request, nor the tick that activates it, nor the maker's next request shows that a trade happened, how many makers it touched or who they were. What stays public is the list in §11.

**Cutoff.** An item staged by the transition that asked for tick `k` was committed in the block whose timestamp is `T`. The engine admits a `place_order` only if the round is open, `round.start ≤ T < round.cutoff` and `T < expiry ≤ round.cutoff`. So `T = cutoff` is refused and `T = cutoff − 1` is admitted. Resting orders are released by the checkpoint of the first tick with `T ≥ cutoff` or `T ≥ expiry`, before any activation in that tick. No fill can happen at or after the cutoff.

This argument stands on three things that the guest cannot check:

- `T` is the endpoint chain's block timestamp, while the closing price is stamped in real time. The margin between the last admission and the result being knowable is the cutoff buffer minus however far that chain's timestamps can run behind real time. The engine allows a buffer of 1 to 299 seconds. On local Anvil the test sets the time, so any buffer works. On every other chain the guest refuses a buffer below `MinPublicCutoffBuffer`, **30 seconds** (§2), set from two measurements of 2026-10-06:
  - *Chain-time lag*, read-only on Horizen mainnet: 1-second blocks (2,000 blocks in 2,000 s), and the latest block's timestamp 0.0 to 1.6 s behind real time in 30 samples over a minute (RPC round trip of up to 0.74 s included; this machine's clock agreed with the RPC server's to the second).
  - *Transition time*, on the stack (`../stack`, `slice.json`): one transition per 5-second manager poll; a request committed 1.9 to 13.2 s after it was submitted (median 4.9 s, 60 requests); a staged command's tick 4.6 to 5.1 s after its staging transition.

  The floor is twice the worst of their sum, 2 × (1.6 + 13.2) = 29.6 s, rounded up. The lag term is the safety condition: an order admitted at `T ≤ cutoff − 1` was committed at most 1.6 s later in real time, so more than 28 s before the close. The transition term is the queue wait of the last point of this list: an order is judged when the manager commits it, not when it is sent, so with the floor an order a client sends up to about 15 s before the cutoff, at the worst wait measured, is still judged before it. Doubling allows for a busier manager and chain than the measurements saw. On 26514 the buffer is exactly 30 s, because it is part of the registry's rules hash, which the engine reproduces (§2). Not covered: a sequencer that stalls and then catches up stamps its catch-up blocks behind real time by as long as the stall, and no buffer the engine allows covers a stall of minutes near a cutoff. The two testnets were not measured; they get the same floor.
- The registry is on the endpoint's chain (§2.3), so the registry's own times and `T` are one clock.
- `T` is when the manager committed the staging request, not when the user submitted it, and the manager chooses that. On v0.2.0 the endpoint has one request queue shared by every application, at most `maxQueueSize` = 10 requests long, and anyone can fill it for the 10-wei minimum fee without a registered key (`submitRequest` then reverts with `QueueThresholdExceeded`). The kit's manager takes one transition per 5-second poll and serves the trigger queue first, so each user request costs about 10 s: a request at the back of a full queue is committed about 100 s after submission, and an order submitted well before the cutoff is refused with `round closed`. The stack's own cutoff test shows the effect in miniature: two orders submitted in one block before the cutoff were committed at `cutoff − 1` and at the cutoff, and only the first was admitted. A cutoff buffer has to cover this queue wait, not only chain-time lag. Judging an order at its submission (the endpoint records `PendingRequest.timestamp`) would take the choice away from the manager, but Vela hands that time to neither the guest nor the trigger. (Stated after review.)
- **On the owner's mainnet stack the transition term holds only while the queue is short.** The floor's 13.2 s came from the kit's 5-second poll. The mainnet recipe polls every second, and its manager then waits on the public RPC: six calls before inclusion at about 0.25 s each from a laptop (measured read-only on 2026-10-06), 1-second blocks and a 1-second receipt poll, so a transition takes about 2.5 to 3.5 s and a request with its tick about 5 to 7 s, inside the term. A full queue (10 requests and their 10 ticks) takes about 50 to 70 s, longer than the 30 s buffer, which the registry's rules hash fixes. Under load or spam, an order sent up to about a minute before the cutoff is therefore refused with `round closed` (the safe direction), and the house's cancels wait in the same first-in, first-out queue: house quotes have to be sized as if they cannot be pulled in the last minute, and users told that orders in the last minute may be refused. Admission stays safe: an admitted order is judged at a block stamped before the cutoff. (Added after the mainnet review; re-measure from the server that runs the manager.)

**Sequencing.** Tick numbers are the order in which staging transitions were committed, so the book evolves as if each command ran at its commit time, in commit order, however late the ticks are processed. An item whose own tick was lost, or that waited behind the activation cap, is activated by a later tick at that later timestamp: never earlier than its commit, and its order among the others is unchanged. Such an item can miss its cutoff.

**Why an account is frozen while it holds a staged command.** If it could cancel, withdraw or top up before activation, a delayed activation would give it a free option: stage an order, watch, and keep it only if it turned out well. An exit that drops the staged item has the same flaw, so there is none. The price is liveness: **if no tick is ever applied again, an account holding a staged command cannot act and cannot withdraw.** Accounts without one still can. A tick needs only the trigger's clock answer, which depends on no other contract (§10). What stops ticks is then a broken trigger; a manager that stops or withholds them; or anyone who keeps the endpoint's shared queue full of requests that ask for no tick (failed requests, deposit-only requests, other applications' requests): for as long as that lasts no request of this application is committed, so no tick is asked for, the clock stops and rounds are neither created nor mirrored, for about six requests a minute at the minimum fee (Cutoff, above). The manager is trusted with far more than that (see [What is trusted or unproven](#what-is-trusted-or-unproven)). This is accepted for the evaluation, not solved.

**Retry.**

- A replayed tick fails (§8), and activation removes the item in the same accepted transition, so nothing activates twice.
- A staged command resent while staged never creates a second item (S3).
- A refused command stays valid for its nonce until another command with that nonce is accepted. A client that no longer wants it must consume the nonce.

**Caps, and the state budget they come from.** The engine's own limits (256 accounts, 128 rounds, 1,024 orders, 64 fills kept in every account's stored last receipt) let a state grow to the engine's 8 MiB snapshot cap, and §3 allows 524,288 bytes. Worse, a state that grows past what the guest can serve cannot be shrunk again, because the requests that would shrink it fail too. So the order build enforces its own caps, in the adapter, and they are chosen so that a state with everything at its cap still fits:

| Cap | Value | Enforced by |
| --- | --- | --- |
| `MaxSliceAccounts` | 32 | A `register` for a 33rd account is refused; a first Base deposit from one is refunded. |
| `MaxSliceRounds` | 8 | The mirror creates no round while the engine holds 8 (§10). |
| `MaxAccountOrders` | 4 active orders per account, so 128 in the book | A0. |
| `MaxStagedBytes` | 576 bytes of canonical JSON per staged command | S4. |
| `MaxFills` | 4 fills per command | A2. |
| `MaxActivations`, `MaxSweeps` | 16 per tick each | A1–A4 and §10. |
| `MaxArchives` | 4 per tick | §10. |

| Part of the state | Worst case, bytes |
| --- | --- |
| Evidence IDs: 4,096 × 67 | 274,432 |
| Identity, configuration, engine scalars, the authority's last receipt (128 released order IDs, or an archived round) | 13,000 |
| Accounts: 32 × 420 | 13,440 |
| Fills in stored last receipts: 32 × 4 × 404 | 51,712 |
| Released order IDs in stored last receipts: 32 × 4 × 62 | 7,936 |
| Holdings: 32 accounts × 8 rounds × 162 | 41,472 |
| Orders: 128 × 440 | 56,320 |
| Rounds: 8 × 1,300 | 10,400 |
| Staged commands: 32 × 612 (576 bytes of command, its tick and the wrapper) | 19,584 |
| Outcomes: 32 × 300 | 9,600 |
| Pinned DON configurations: 2 × (31 signers × 45 + 120) (version 4) | 3,030 |
| Unconfirmed rounds: 8 × 260 (version 4) | 2,080 |
| Custody and the new counters (version 4) | 300 |
| **Total** | **503,306** of 524,288 |

That was the design's estimate, with the staged-command row raised to the bound added while building. **Measured** (`TestStateAtEveryCapFitsTheBound`): a state with 32 accounts, 8 rounds (7 resolved and not yet swept, 1 open), 128 resting orders, holdings for every account in every round, and, written in because they cannot all coexist, a staged `place_order` and an outcome for every account, 4 fills and 4 released orders in every stored last receipt, 128 released orders in the authority's last receipt and all 4,096 evidence IDs used, is **478,772 bytes** in version 4, with eight unconfirmed rounds and two pinned DON configurations of 31 signers each. With every number at the widest the engine and the adapter allow, every price at the largest int192, every command ID at a 16-digit nonce, every staged command at 576 bytes and every stake limit at 16 digits it is at most **523,785** of 524,288: 503 bytes to spare, which is why the DON configurations are capped at two (§2). More than half of it is the evidence set, and most of the rest is data the engine stores for every account. Two engine changes would free it: keeping adapter-issued ordinals as counters instead of 4,096 hashes, and keeping a digest of the last receipt instead of its fills. With those, the same bound serves well over a hundred accounts. That is the first decision below.

Both gates exist: `TestStateAtEveryCapFitsTheBound`, and `TestGuestSoak` run on that state (§3).

**Stake limits** (built for the mainnet deployment, owner decision 2026-10-06). An account's *stake* in a round is measured two ways. Its *worst* stake is the most its payout if Up and its payout if Down can differ once its resting orders have filled in whichever way widens that gap; its *held* stake is that difference for the shares it holds now:

```
worst = max( up + reservedUp + resting Up buys − down ,  down + reservedDown + resting Down buys − up )
held  = | up + reservedUp − down − reservedDown |
```

where `up` and `down` are its free shares in the round and `reservedUp`, `reservedDown` the shares its sell orders offer, which are still held. A share pays one collateral atom, so a stake is in atoms. The per-account and house limits bound worst stakes; the all-accounts limit bounds held ones. A stake is what a forced void moves: a void pays every share 1/2, so an account on the losing side gains half its stake and one on the winning side loses half of its own (audit finding D4, `../../../contracts/deployment/MAINNET.md`). Only open rounds count: a scheduled round holds nothing and a settled one risks nothing.

The definition leaves nothing to dodge with:

- **Mint, then sell.** A complete set counts zero, and a share offered for sale counts as sold, so minting 60 and offering 60 Up is 60 at stake before anything fills, though the account never bought.
- **Many small orders.** Every resting order counts at its whole remaining size toward the account's worst stake, however many there are.
- **Rest, then be filled.** A resting buy counts as bought and an offered share as sold, so a fill never raises the maker's worst stake, and a maker's fill can never cause a per-account refusal of someone else's order. It does raise the maker's held stake, but only inside the order that fills it, which is checked against the whole ledger.
- **Resting bids against the shared limit.** A resting buy locks only its price and fee: a one-cent bid of 50 USDC.e locks 0.505 USDC.e and comes back whole on cancel. Counted at its size toward the all-accounts limit, four such bids (2.02 USDC.e, all refundable, one request each) filled the 200 USDC.e default for every other account until the cutoff, and nobody could clear it: selling into a bid only turned it into a position. So the all-accounts limit counts held shares only (changed after the mainnet review; `TestStakeLimitRestingBidsLeaveTheBoundary`).
- **Both sides at once.** Resting buys of Up and of Down do not offset, since either may fill alone; held shares do (a complete set is riskless).
- **Several rounds at one closing time.** The all-accounts limit adds every round that ends at the same time (with one market there is one; the rule holds for more). The per-account limit is per round, and the all-accounts limit caps their sum.
- **Several accounts.** The all-accounts limit counts every account but the house.
- **The forced void.** At the cutoff every resting order is released (§9, Cutoff), so from then on only held shares are left, and the all-accounts limit bounds exactly what a forced void can move.

The limits are constructor parameters (§2), fixed for the life of the deployment:

| Parameter | Bounds the stake of | Evaluation default |
| --- | --- | --- |
| `account` | each account but the house, in each round (worst) | 50,000,000 atoms (50 USDC.e) |
| `boundary` | every account but the house together, over all rounds that end at one time (held) | 200,000,000 (200 USDC.e) |
| `houseTotal` | the account `house`, the market maker, over all open rounds (worst) | 2,000,000,000 (2,000 USDC.e) |

The house is exempt from the first two. Deploy refuses an `account` above `boundary`, and a `house` that is the authority, the endpoint or the token (§2). The owner sets the real numbers at deploy. As a guide: with the planned five-minute void grace, forcing a void costs about 0.03 to 0.05 ETH at 2026-10-05 Base fees (D4), and every account but the house can gain at most half of `boundary` from it at one closing time.

Only a `place_order` can raise a stake: mint and merge change both sides alike, cancels and expiry only lower it, redemption is of settled rounds, and fills happen only inside a `place_order`. So the limits are checked when a `place_order` is activated (A5), against the whole ledger after the engine's result, the makers it filled included: an order whose fills would take the all-accounts total past its limit is refused whoever sends it, the house too. The first one broken refuses the order whole, fills included, with a private outcome; the tick's effects are then byte for byte those of the same tick with nothing to activate (`TestStakeLimitRefusalShape`). A state with any stake above its limit is refused like a state past a cap (§3). An order is refused only if a stake ends above its limit, so an account at its limit can still trade down (in the tests: a buy of the other side, and a sell of the side it holds). A sell is not always a reduction: one that gives up the shares hedging a resting buy of the other side raises the stake, and is checked like any other order. The check costs about 23 µs per activated `place_order` natively on the state at every cap.

What the limits cost: the all-accounts limit is shared, so its refusal tells an account in private that the others together hold close to it at that closing time (§11, residual channels). Any shared limit can be blocked by someone willing to lock enough: with held shares counted, two accounts of one person taking opposite sides fill it for about half the limit in money locked until settlement (about 100 USDC.e per round with the defaults, against 2 USDC.e of refundable bids before the change). And the house is an address: whoever can send as it is exempt, which on v0.2.0 includes the manager ([What is trusted or unproven](#what-is-trusted-or-unproven)).

**How busy one tick can be.** By the code, a tick applies one checkpoint, at most 16 mirror commands (an opening and a resolution for each of the 8 rounds held), at most 16 activations, at most 16 sweeps and at most 4 archives: 53 engine commands, each of which validates, clones and encodes the whole state. The busiest tick the tests time has 40 on a 389 KB state: seven rounds resolve while 128 orders rest in the eighth, sixteen `cancel_all` activate and sixteen accounts are swept (`TestFullBookAtEveryCap` counts them). (Corrected after review: this section called sixteen `cancel_all` and sixteen sweeps, 33 commands, the busiest tick the caps allow.) Measured on this machine (darwin/arm64, natively; not the emulated executor of the local stack): one run through each upstream runtime (`TestUpstreamConformance`), the slowest of the long soak's 400 rounds under Node (`TestGuestSoak`):

| Tick | Upstream v0.2.0 host runtime (wasmtime-go 1.0) | Upstream dev host runtime | Node |
| --- | --- | --- | --- |
| 40 commands: 7 resolutions, 16 `cancel_all`, 16 sweeps (389 KB) | 1.29 s | 0.72 s | 0.44 s |
| 33 commands: 16 `cancel_all`, 16 sweeps (465 KB) | 0.80 s | 0.45 s | 0.46 s |
| 17 commands: 16 sweeps (455 KB) | 0.47 s | 0.28 s | 0.26 s |
| A report: 36 commands, 32 holders paid (version 4) | 0.90 s | 0.43 s | 0.51 s |
| Version 4, the same three ticks | 0.90, 0.90, 0.55 s | 0.56, 0.57, 0.21 s | 0.51, 0.59, under 0.51 s |

(Version 4 measured on 2026-10-07: one conformance run, and the long soak's slowest of 400 rounds. Measured again with the stake limits, on 2026-10-06, with another job running on the machine; the build before them took 1.21, 0.84 and 0.50 s on v0.2.0's runtime.) Scaled to 53 commands, the worst is under 2 s on v0.2.0's runtime, well inside the executor's bound of 30 s per request on v0.2.0 and 10 s on dev. `MaxActivations` and `MaxSweeps` stay 16 until a tick at the caps has run on the stack's executor, which runs the amd64 image under emulation and has not.

### 10. Registry rounds (built: the guest and `BookClockTrigger`)

Since version 4 the guest settles rounds from Chainlink reports itself (§12) and creates its own rounds; the `StreamsRoundRegistry` stays the public record, is mirrored as the fallback, and is compared with what the guest did. The registry's records reach the guest through the trusted payload, version 3. The constructor parameter `markets` (§2) is the list of `{asset, duration}` the deployment mirrors. This build mirrors one market (BTC, 900 s in the tests); `MaxSliceRounds` is sized for that.

**Asking.** The tick request (§8.1): `tick, nextDeposit, s, o, c`, then `s` registry round IDs of the engine's `scheduled` rounds, `o` of its `open` rounds and `c` of the `unconfirmed` rounds (§3) the engine no longer holds as scheduled or open (`s + o ≤ 8`, `c ≤ 8`, so at most 16).

**Answering.** `BookClockTrigger` in `../stack/contracts` (the registry half as `EvaluationClockTrigger` built it for version 2), tested against the real registry and against registries that revert, burn gas or answer garbage (`../stack/README.md`). For version 2 it:

1. calls the registry's permissionless `createRound` for the next two slots of every market in its own immutable copy of `markets`, ignoring a failure (the round usually exists already). The registry round and the engine round are then created by the same tick, and no keeper has to win a race;
2. reads `getRound` for every asked ID and for those next slots (their IDs from the registry's `roundIdFor`), each in its own low-level call with a gas limit, and skips a read that fails or whose answer is not exactly 22 words. (Corrected while building the trigger: the design said `try`/`catch`, but Solidity's `try`/`catch` does not catch an answer that fails to decode, which reverts the caller, so a registry upgraded into one that answers garbage would have stopped the clock. Only the 704 expected bytes are copied, so a huge answer costs nothing.);
3. returns a record only where the registry is ahead of the engine as the asking request saw it: an asked `scheduled` round that now has `openedAt ≠ 0` or an outcome; an asked `open` or unconfirmed round that now has an outcome; a next slot that was not asked about; at most 16 (asked rounds first, then the slots);
4. returns, as 32-byte words, `3, block.chainid, endpoint, block.number, block.timestamp, tick, n, d`, then `n ≤ 16` records of 19 words each, then the deposit records (§6): `roundId, asset (0 BTC, 1 ETH), duration, start, openedAt, resolvedAt, outcome (0 pending, 1 Up, 2 Down, 3 Void)`, then the opening and the closing observation as `price, validFromTimestamp, observationsTimestamp, expiresAt, reportHash, decimals` each.

A request committed while an earlier tick is still pending lists the rounds of an engine that tick has not changed yet. If the manager serves such a request before that tick (it may take the head of either queue) and the earlier tick creates round R, the later tick neither asks about R nor sees it as a next slot once its block time has reached R's start. An opening the registry recorded before the later request is then missing from that request's own tick, and an order for R staged by it is refused with `round closed`; R stays scheduled until a later tick asks about it. Nothing is ever admitted wrongly, and a manager that serves the trigger queue first, as `getNextPendingRequest` orders them, never causes it. Reading the current slot as well would cover the case at one more registry read per tick; it is not done, because the same manager can drop the tick outright. (Stated after review.)

The clock words never depend on a registry or inbox read. If the data after the tick word is malformed or lists more than 16 IDs, the trigger returns the payload with `n = d = 0`, which is a plain clock tick. A registry that reverts, runs out of gas or is upgraded into something else can therefore delay rounds but cannot stop the clock, and with it cannot freeze a staged account (§9).

The record cap matters for more than the guest. The endpoint writes the payload into contract storage outside any `try`, so a payload too large to store would revert the asking transition on every attempt, and with it the endpoint's queue. Sixteen records are about 10 KB, roughly 7 million gas to store (an estimate, not measured). In normal running a payload has zero to three; on the stack the asking transition used about 0.84 million gas with none and 1.79 million with five.

**Applying.** After the checkpoint, the guest applies, per record in `(start, asset, duration)` order, the first rule that fits and then re-examines the record:

- not in the engine, a configured market, `T < start`, and fewer than `MaxSliceRounds` rounds held: `create_round` with `engine.NewRoundSpec`; the derived `registryRoundId` must equal the record's (`T < start` is the engine's own rule for `create_round`; the adapter does not repeat it);
- not in the engine and `T ≥ start`: nothing, for good (the engine cannot create a started round);
- `scheduled` and `openedAt ≠ 0`: `open_round` with `registryTime = openedAt`, the opening observation, and evidence = its `reportHash` without `0x`;
- `open` and outcome Up or Down: `resolve_round` with `registryTime = resolvedAt`, the closing observation, and evidence = its `reportHash` without `0x`; the engine's outcome must equal the registry's;
- `scheduled` or `open` and outcome Void: `void_round` with `registryTime = resolvedAt` and evidence = the registry round ID without `0x`.

A record the engine refuses, or whose outcome differs, is skipped and that round stays as it was. So is a record that does not decode: an asset other than 0 or 1, an outcome above 3, an integer that does not fit 64 bits, a time above `MaxClock`, decimals above 255; a price that is zero or negative reads as a number the engine refuses. The tick still applies: one bad round must not stop the clock. A payload whose framing is wrong (a length other than 224 + 608n bytes, n above 16, a version other than 1 or 2) is `zedge: malformed trusted payload`, as in §8. So that a skip is visible, the clock record of §8.4 carries two more words in this build: records applied (those that changed the engine at least once) and records skipped (the rest).

`registryTime` is always the registry's own recorded block timestamp, never `T` and never the guest's clock. The trigger reads the registry in the block at `T`, so `registryTime ≤ T`, as the engine requires. A void is mirrored only from a recorded `outcome == Void`.

Each mirrored opening, resolution or void publishes a `settle` record with source 2 (§11).

**The guest's own rounds.** After the mirror, every tick (and every applied report, §12) creates the rounds of the next two slots of each market after the clock, `engine.NewRoundSpec`, so their registry round IDs equal the registry's, while fewer than `MaxSliceRounds` are held; the trigger still creates them in the registry. A round therefore exists in the engine as soon as any tick or report lands in the two slots before its start; it no longer depends on the trigger's next-slot record.

**The guest's own void.** An **open** round is voided only by mirroring a registry `Void`. A **scheduled** round that never opened is voided by the guest itself once the clock is past its opening deadline plus the void grace (start + 210 + 300 on 26514): nobody can hold a position in it, and nobody can open it any more. It publishes a `settle` record with source 3.

**Confirmation.** Every round the guest settled from a report (§12) is kept in `unconfirmed` with the report hashes and outcome it used. When a registry record with an outcome arrives for one of them, after the mirror, the guest compares the opening hash, the closing hash and the outcome with what it did, publishes a `confirm` record (agree 1, or 0 with both outcomes and both closing hashes) and drops it. **On a disagreement the engine's result stands**: the book has paid out already, and halting would let anyone who front-runs the keeper's Base publication with another in-window report stop the market; the record is the alert for the keeper and the payout signer. Past eight unconfirmed rounds the oldest is dropped with agree 2 (unconfirmed).

**When a round exists in the engine (the registry mirror).** A round with start `s` and duration `d` is created by any tick whose asking request is committed in `[s − 2d, s)`, provided that tick is applied before any tick stamped `s` or later; the guest's own creation above covers the same window.

**Then, in the same tick, after activation (§9):**

1. **Settlement sweep.** For each resolved or void round, oldest first, and each account, in address order, that still holds shares in it and holds no staged command, the adapter applies `redeem` for that round as that account: the one redeem command the account could have sent itself, with its next nonce, in its own user context at `T`, as §6.3 does for `register`. At most `MaxSweeps` attempts per tick; an account left over can redeem for itself, and a later tick sweeps the rest. The payout is the engine's and has only one possible value. The account's nonce advances by one, which is why a client reads its nonce from its view (§9). Without this, one lot left unredeemed in each round by an account that never returns would hold every round slot for ever, at almost no cost.
2. **Archive.** Each resolved or void round with no locked collateral and no supply left is removed with `archive_round`, as the authority, oldest first; at most `MaxArchives` (4) per tick. The engine requires the archive record to be kept with the new state, so the tick's result carries it as a public app event: subtype `SHA-256("zedge.vela.archive.v1")` = `0xefe437757209e66cb09e68c2bfe69073f2740c38bea74805a8b00d3b3de3df7a`, data = the canonical JSON of `receipt.archive`. It is accepted in the same `stateUpdate` as the state root and holds only public round data. The trigger ignores it.

**Round budget.** Per market the engine then holds the next two rounds, the open one, and those that have ended but are not yet resolved, swept and archived: three or four in normal running, since a report resolves, pays and archives in one transition. A round whose closing price never arrives stays until the registry voids it, after its `voidableAfter`: the registry's grace is at least two minutes, 300 s in the planned mainnet profile and in the stack slice (with the forced-refund risk the owner accepted for it, `../../../protocol/README.md`). If the 8 slots are full, no round is created until one is archived, and rounds whose window passes meanwhile are skipped for good. Four markets need about 24 slots, which the budget of §9 does not have with the engine as it is.

### 11. Receipts and what is public (built)

A receipt is the envelope of §4 with `kind: "receipt"`, `account` = the recipient, and a `body`. The executor encrypts it to the recipient's registered key. Every receipt answers a request of the account it goes to and travels in that request's own transaction.

| `type` | `status` | When | `requestId` | Body |
| --- | --- | --- | --- | --- |
| `command` | `applied` | The sender's command was accepted | Command ID | `receipt`; `withdrawal` = payout ordinal, for a withdrawal |
| `command` | `retry` | Exact retry of its latest accepted command | Command ID | `receipt` (the original) |
| `command` | `rejected` | Refused after the checks in §4 | Command ID | `reason` |
| `sync` | `requested` | A sync | `<account>:sync` | — |
| `report` | `applied` or `rejected` | The sender's Chainlink report (§12) | `<account>:report:<boundary>` | `reason` if rejected; no `tick` |
| `command` | `staged` | Book command staged (§9), or the same bytes resent while staged | Command ID | — |

Every body also has:

- `at`: `{tick, block, timestamp}`, the trusted clock the request was judged at, which is the last tick applied before it. A client compares `timestamp` with the block that carried its request. A large gap means the clock was stale, or was held back.
- `tick`: the tick this request asked for (absent on a report receipt). The clock record for that tick or a later one (§8.4) tells the client when the clock passed its request.
- `outcome`: the account's collected outcome, once (§9).
- `view`: `engine.AccountView` of the recipient after the request (§9); absent if the sender is not registered.
- `pad`: zeros. **Every receipt's plaintext is padded to the next multiple of 8,192 bytes.** The largest receipt this build can produce is 7,519 bytes before padding (an exact retry of an order that filled four times, collecting the applied outcome of the same order, with a view at every cap, the longest origin and application ID, every number at its cap), so every receipt is exactly 8,192 bytes and its ciphertext 8,220 (`TestReceiptsAreOneSize`). The time-free build's class was 2,048 bytes; the view and the outcome made it four times larger. The executor encrypts without padding, so without this the length on chain gives away the refusal reason, the kind of command, whether an outcome came back and the size of the account.

Further:

- `receipt` is `engine.ProjectReceipt` for that account: its own status, amounts, fills (with its own side, role, price, size and fee) and released orders. It never names another account or another account's order.
- There are no deposit receipts any more: a Base deposit is credited by a tick, and the public `credit` record says when.
- A command ID is `<account>:<nonce>`. `session.decryptReceipt(ciphertext, requestId)` accepts a receipt only under its exact `requestId`, account, epoch and domain.
- A tick produces no receipt. A request that fails with a public error produces no receipt at all.
- An archive record is public: the round as it ended, with both observations, its supply and its outcome, all of it chain data already.
- The public records (app events; data as 32-byte big-endian words; subtype = SHA-256 of the label; `../crypto/guest.ts` decodes each):

| Label | Subtype | Words |
| --- | --- | --- |
| `zedge.vela.tick.v1` | `0x8af869f3…3850` | the request of §8.1 |
| `zedge.vela.clock.v1` | `0xfcec9469…9460` | tick, block, timestamp, records applied, skipped, deposits processed, payload Keccak-256 (§8.4) |
| `zedge.vela.archive.v1` | `0xefe43775…df7a` | the canonical JSON of the archive record (§10) |
| `zedge.vela.settle.v1` | `0x9724dc1f…6b8a` | roundId, kind (1 open, 2 resolve, 3 void), outcome (0 none, 1 Up, 2 Down, 3 Void), price, observationsTimestamp, reportHash, source (1 report, 2 registry, 3 own void) |
| `zedge.vela.credit.v1` | `0xb1807d8a…5a83` | index, account, amount, status (1 credited, 2 refunded), payout ordinal of the refund or 0 (§6) |
| `zedge.vela.payout.v1` | `0x9fc2837b…62e9` | applicationId, ordinal, kind (1 withdrawal, 2 refund), account, to, amount (§7) |
| `zedge.vela.confirm.v1` | `0x5e1da736…9b0a` | roundId, agree (1 yes, 0 no, 2 unconfirmed), engine outcome, registry outcome, engine closing hash, registry closing hash (§10) |

  The trigger answers only the tick subtype. Deposits, payouts and outcomes are public in any case (the vault's events on Base, the registry).
- The guest gives every receipt one event subtype, `SHA-256("zedge.vela.receipt.v1")` = `0x124f25ec420301d96ad47008349df043146fa7ec26b5d9118962a276e3219968`. **That holds only for accounts that registered no subtype seed.** If an account's `ASSOCIATEKEY` payload carried a seed (the 226-byte form; the ZEDGE client sends the 133-byte form without one), the executor replaces the subtype with one of 50 values that belong to that account alone, and its receipts can be linked to each other and to its address. The guest cannot prevent that. Clients must trial-decrypt every `UserEvent` of the application and never filter by subtype.

**Public**, on chain, for every request: the sender; the length of its ciphertext (always 2,076 bytes, §4); every Base deposit and refund and every withdrawal's account, destination and amount (the vault's events and the credit and payout records); every settled round; the tick request with the registry IDs of the rounds the engine holds and, for a tick, the trusted payload (stored by the endpoint), the clock record with its record counts and the payload's hash, and any archive records; the number of encrypted receipts (always one per `PROCESS` request and one per deposit) and their length (always the same); the error string of a failed request; and the new state root.

**Residual channels.** Padding fixes every length. A chain observer can still read the following, all left open in this evaluation (listed after review):

- **Archive timing.** The sweep skips an account with a staged command, and a round is archived only once nothing is left in it. A round archived later than the tick that resolved it therefore shows that one of its holders had a book command staged at that tick, or that it had more than `MaxSweeps` holders. The structural fix is decision 2's alternative, a settlement of terminal holdings that uses no user nonce.
- **Withdrawals name the account.** A payout record carries the engine account as well as the destination, because the vault's signed `Payout` does. The account is the Base address that deposited, which the deposit already showed.
- **Executor time.** Apart from its archive records, a tick's events and gas do not depend on its work; its execution time does: a few milliseconds on the stack's small states, up to about 1.2 s at the caps (§9). The manager submits each `stateUpdate` when the executor finishes, so near the caps a busy tick lands later after the poll than an idle one.
- **The all-accounts stake limit.** Its refusal, `stake limit: all accounts at this closing time`, depends on every other account's held stake at that closing time: an account that knows its own learns that the others together hold more than `boundary` less its own after the order. It no longer depends on resting orders, so a probe has to fill: a one-cent resting bid, which locks 1 % of its size and comes back on cancel, now reads nothing, where before about 18 such probes found the others' total to one lot. Reading it now takes positions that really trade, and the probe pays the spread and holds the shares. It never shows who holds the stake. Any shared limit tells this much; a per-account limit alone would not, and would not bound the forced void across many accounts (§9, Stake limits). Accepted and documented.
- **Refusal reasons.** No refusal reason depends on another account's orders or balances, except the all-accounts stake limit above and where the book makes it unavoidable: a `place_order`'s outcome depends on what it met. `matching work limit; split order` says that at least five maker orders sat within its price and size, and `execution fee cap exceeded` that a sell met a buyer above its limit, both without a trade. A cancel of another account's order reads `unknown active order` whether that order rests or not. (Changed after review: it read `order not owned` while the order rested, which let a registered account with no funds watch any order fill by staging the probe right behind a taker's request.)

**The state root.** Vela publishes `SHA-256` of the application data after every request: its own request counter, the wasm hash, every registered key, and the guest state in clear. Everything in the guest state except the salt can be rebuilt from public data (deploy parameters are plaintext calldata; deposits, withdrawals and ticks are public). Without the salt an observer could therefore hash candidate commands until one matched the root; in review a staged order was recovered that way in seven seconds. The 256-bit salt of §2 removes that: no candidate state can be computed without it. It protects the root from chain observers only. The host sees the state anyway (below).

The public errors are exactly these, each prefixed `zedge: `:

`bad buffer`, `malformed parameters`, `invalid configuration`, `invalid state`, `wrong application`, `malformed sender`, `unsupported token`, `clock not initialised`, `unsupported request type`, `malformed envelope`, `wrong context`, `sender mismatch`, `malformed command`, `malformed trusted payload`, `stale or unknown tick`, `internal error`. (Version 4 dropped `invalid amount`, `deposit rejected` and `clock regression`.)

To these the host adds its own failure when the guest refuses a buffer (§1). On chain the host also prefixes the guest's error: `failed to process deposit: zedge: …` or `failed to process request: zedge: …` (seen on the stack).

### 12. Chainlink reports, checked in the guest (built)

The keeper (`../../../services/keeper/`) harvests each Chainlink Data Streams BTC/USD report from its free copies on Solana and sends it as soon as it sees the copy for the exact boundary second. Anyone may send one: the guest checks the DON's signatures itself, so the sender is trusted for nothing.

**The check** (`chainlink.go`), as the Base verifier would make it, against the `chainlink` parameter (§2):

1. Exact ABI: `abi.encode(bytes32[3] reportContext, bytes reportBlob, bytes32[] rs, bytes32[] ss, bytes32 rawVs)` with offsets `0xe0`, `0x220`, `0x220 + 32 + 32(f+1)`, a 288-byte blob, `f + 1` signatures in `rs` and in `ss`, nothing else: 992 bytes for `f` = 5 (`report: malformed`). `reportContext[0]` must be a pinned digest (`report: unknown config digest`), whose `f` and signers apply.
2. Signatures: `h = keccak256(keccak256(blob) ‖ reportContext)`; signature `i` is `(rs[i], ss[i])` with `v` = byte `i` of `rawVs` (most significant first) + 27. As `ecrecover`: `v` must be 27 or 28 (`report: bad signature`, also for an `r` or `s` of zero or past the group order), no low-`s` rule. Each must recover to a pinned signer, all distinct (`report: not signed by the pinned signers`). Recovery is decred's secp256k1 v4.4.1, inside the guest.
3. The v3 blob: `feedId` the pinned feed (`report: not the pinned feed`); `validFromTimestamp ≤ observationsTimestamp ≤ expiresAt`, each within 32 bits; `price`, an int192, positive (`report: invalid observation`). The observation is the registry's: price, the three times, `reportHash = keccak256(blob)`, 18 decimals.
4. **Only the exact boundary**: `observationsTimestamp` a multiple of the market's duration (`report: not a boundary report`). Every copy of the report for one second carries the same blob (checked on the recorded copies: two different signature sets, one blob), so whoever sends it has no choice of price.

**Applying it**, with `B` = its `observationsTimestamp`, in one transition at `T = max(clock, B)` (a DON-signed time is real time): if the engine holds no open round ending at `B` and no scheduled round starting at `B` that `T` has not taken past its opening deadline, nothing is touched and the sender is told `report: already applied` (a round carries this report's hash) or `report: nothing to apply`. Otherwise: the engine's checkpoint at `T`; the open round with `end = B` is resolved (`registryTime = B`, the observation, evidence = the report hash; the engine decides the outcome); **every holder of it is paid at once**, each by its own `redeem` with its next nonce, except an account with a command staged (the next tick's sweep takes it); the scheduled round with `start = B` is opened with the same report, unless `T` is past its opening deadline (the registry could no longer open it and would void it, so the book would disagree with the record; it stays scheduled and is voided as in §10); finished rounds are archived and the next two slots created (§10); both rounds go into `unconfirmed`. It publishes a `settle` record for each (source 1) and the archive records, and sends the sender one receipt, `applied`. A report that fails any check is answered with a receipt `rejected` and the check's reason; the ledger does not change. A report asks for no tick.

`T` is never before the clock, so a report can move the clock ahead of Horizen's block time by the seconds between the boundary and the next block; ticks then apply at the clock (§8.3).

**Fallback.** A boundary with no exact-second report (a Chainlink gap, a digest not pinned, the keeper down) is settled from the registry's record as before (§10): the trigger reports the registry's opening or resolution, recorded from any report in its window, and the mirror applies it.

**Timing.** With the manager polling every 10 s on the public Horizen endpoint: report on Solana about 3.5 s after `B`, keeper sees it within a second, Horizen inclusion 1 to 2 s, the manager's poll 0 to 10 s, the transition 2.5 to 3.5 s: winners paid about 13 s after the boundary (median), 21 s slow, with nothing queued ahead (the timing budget of 2026-10-07). Measured here: the heaviest report (32 holders paid) takes 0.90 s through upstream v0.2.0's host runtime and 0.43 s through dev's on the state at every cap; a report on a small state, under 0.1 s.

## Limits

The engine's limits are 256 accounts, 4,096 evidence IDs and 10^15 lifetime deposited atoms, none of them reclaimable, and 128 retained rounds. In this adapter:

- **Accounts.** 32 `register` commands or first Base deposits from distinct addresses fill the slice's table (§9; the engine's own limit is 256). No deposit is needed, only a registered key and the request fee. After that no new account can be created, for good.
- **Evidence IDs.** A credited deposit uses one and a withdrawal two: about 1,300 deposit-and-withdraw pairs per application, then a new application. The exit reserve of §7 keeps exhaustion from stranding anyone: once the IDs are gone every deposit is refunded and each account gets one last withdrawal.
- **Lifetime deposits.** One deposit of 10^15 atoms (10^9 tokens) ends deposits for good. Withdrawals do not give the allowance back.
- **State size.** 524,288 bytes (§3). The caps of §9 hold this build under it.
- **Rounds.** 8 at a time, reused through the sweep and the archive of §10. A round whose window passes while the 8 slots are full is skipped for good.
- **Unconfirmed rounds.** 8; past that the oldest is given up, publicly (§10).
- **Pinned DON configurations.** 2 (§2). When Chainlink moves the BTC feed to a digest not pinned, its reports are refused and the registry fallback settles every round, about 20 s later, until a new application pins it.

None of these is acceptable outside a local evaluation.

## What is trusted or unproven

On Vela v0.2.0 the enclave does not rebuild the on-chain request ID, so it cannot tell whether what the manager hands it is what the chain holds. Everything below follows from that or from the local setup.

- **Sender.** The `sender` the guest sees is whatever the manager supplied. Key registration is not bound either, so the manager can register its own key for any address and then send commands as that address. The manager can take every account's balance.
- **Deposits.** The Base deposit records reach the guest inside the trusted payload, which is manager bytes. The manager can credit an account with a deposit that never happened and then withdraw real USDC through it: the payout signer checks only that the payout record was committed, and the vault only its caps (per payout and per day). Each forged credit is provable afterwards (the clock record's payload hash against the inbox's real records, §8.4); nothing prevents it. The evidence ID now names the Base index, so the same deposit cannot be credited twice even then.
- **Time.** A trusted payload is bytes from the manager. The guest checks its shape, that its tick number is pending and that its timestamp is not behind the clock; it cannot check that the trigger produced it. So the manager can:
  - move the clock forward at will;
  - hold it back: stamp any pending tick with any time from the current clock on, so that the guest's clock sits as far behind the chain as the manager likes. An order's `expiry` and a round's cutoff are compared with that clock, so neither bounds anything in real time;
  - withhold ticks, or fail one on purpose, while it goes on serving ordinary requests.

  With orders (§9) that is a free option on every staged order, and it needs no forged sender or amount, only an ordinary trading account. A report (§12) cannot be forged: its price and time are signed by the Chainlink DON. The manager can still withhold or delay one, and then the registry fallback settles the round from its own record. A payload's round records are manager bytes too: a fabricated record can open, resolve or void a round with any observation the engine's checks accept, or create far-future rounds (any start up to 2^32 − 1) that then hold the 8 slots for good: such a round leaves the engine only through a registry void, which never comes for a round the registry does not hold, or a fabricated void, which needs the clock moved past its opening deadline for good. The clock record's payload hash makes any of this provable at the next block (§8.4); nothing prevents it. With genuine payloads only, the manager still chooses when each request is committed, and with it the time at which each order is judged (§9, Cutoff). The manager can wait until a round's result is public and then admit its own order "before the cutoff" with a backdated tick; or, using genuine payloads only, apply or drop the ticks that would activate the orders staged before the cutoff, its own included, once it knows which way the round went. The clock record of §8.4 makes a fabricated payload provable and a withheld tick visible after the fact. It prevents neither.
- **Request identity.** The guest gets no request ID. Withdrawal evidence IDs are ordinals; a Base deposit's names its vault index. The manager can feed the enclave an account's earlier ciphertext in place of a later one; nonces limit that to a retry of the latest command or a previously refused command whose nonce is still unused.
- **Ordering.** The endpoint accepts the head of either queue, so the manager chooses whether a normal request or a pending tick runs first. Serving a request ahead of a pending tick can make its own tick miss a round opening the registry already recorded, and an order is then refused (§10). On v0.2.0 the request queue is also shared by every application and capped at 10, so anyone can delay or deny every submission (§9, Cutoff).
- **State freshness.** The enclave runs on whatever stored state the manager supplies. The chain refuses a transition from an old root, but the manager can still run old states to watch what comes out.
- **House.** The stake limits exempt the address named `house` from the per-account and all-accounts limits. The guest knows the house only by the sender the manager supplies, so on v0.2.0 a manager that sends as the house is exempt too.
- **Trigger.** `trusted_request` has no sender. `engine.authority` being the trigger's address is a deployment promise, not something the guest verifies. The book's trigger is `../stack/contracts/src/BookClockTrigger.sol` behind a UUPS proxy: its address is fixed for the application's life, and its owner (the deployer) can upgrade what answers there, which is the same trust as the registry's and the vault's owner.
- **No attestation.** The local executor is an ordinary container with fixed development keys. Its signature says nothing about the code that ran. `applicationFingerprint` is a constructor parameter.
- **No chain or endpoint in the signed transition.** Replay of a signed transition across deployments is not excluded by upstream.
- **What the host sees.** v0.2.0 logs the raw `deposit` result at INFO: the whole state, salt included, in clear, in the executor log. The manager is handed the recipient of every receipt in clear, and sees the exact length of the state after every request. Nothing in this adapter hides anything from the host; the padding, the single request shape and the salt are against chain observers.
- **What chain observers still see.** Who sends requests and when; deposits and withdrawals with their amounts, a withdrawal's account included (§11); that an address is active; the residual channels of §11. Each receipt carries the engine's global sequence number, so an account learns how much the whole ledger moved between its receipts.
- **No exit.** If the manager stops, or its database is lost, private balances cannot be recovered or withdrawn. `claim` pays only what was already credited. Both happened to the v0.2.0 manager on the local stack (`../stack`): restarted in the second between its `stateUpdate` being mined and its seeing the inclusion, it rolls back its database and then refuses to start for good ("unrecoverable disalignment between DB and chain"); with its data volume removed it panics on every start. Either way no request is processed again. The mainnet review of 2026-10-06 found two more ways in on snapshot1: one lost RPC answer to the manager's `stateUpdate` (it rolls back though the transaction mines), and a stop by SIGTERM at any time between sending a `stateUpdate` and seeing its receipt. The owner's operator recipe therefore sends through an idempotent-send guard and stops the manager with SIGKILL. After a brick the only way custody can move is the last-resort exit, rehearsed on a fork: the authenticator's owner registers a signer it holds, and the manager key submits one hand-signed transition for the queue head that pays the custody out. Who gets what must come from the latest balances, which only the manager's database holds; a backup of it older than one transition is refused, and nothing yet replays history.
- **Run on the stack as an evaluation only.** `../stack` ran key registration, deposit, withdrawal, claim, private refusals, event encryption and the trigger's clock on the local v0.2.0 Docker stack (software TEE with fixed keys, no attestation, test token, fixture oracle); its README says what that showed and what it did not. The executor took milliseconds per request there, on states of a few kilobytes only. At the size bound the guest was measured only through upstream's host runtime and under Node: tens of milliseconds per request, up to about 125 ms at the bound on a busy laptop, and up to 1.21 s for the busiest tick timed at the caps (§9). The order build then ran on the stack too, for one BTC 15-minute market with two traders: every tick took at most 11 ms in the emulated executor, on states of at most 7,160 bytes; nothing near the caps (`../stack/README.md`).
- **Memory.** The size bound was measured under Node's V8, not wasmtime, and on this wasm only (§3). The 2 GiB ceilings of the two upstream runtimes were not reached and not tested.
- **Stack.** The guest runs on TinyGo's fixed 64 KiB stack; `-stack-size` does not change it with `-scheduler=none`. The adapter keeps recursion depth independent of input (the nested-payload steps of the conformance script check that). In review at most 22.9 KB of it was used.
- **v0.3.0.** The guest passes the same test on unreleased dev `25af7d6`, which no longer calls `load_module`. That is an early warning, not support.

## Decisions for the owner

For the local evaluation all nine were settled on 2026-10-05, as marked **Evaluation** below; they can be revisited before anything public. The first two still shape the order build. The owner's decisions of 2026-10-06 for Horizen mainnet are marked **2026-10-06** (5 and 10).

1. **How the order build fits the state bound.** Either the engine changes (adapter-issued evidence as counters, a digest in place of the stored last receipt's fills, and an authority-side settlement of terminal holdings), or the adapter caps of §9 stand: 32 accounts, 8 rounds, one market, 4 orders per account, 4 fills per command. This document is written for the caps, so that nothing waits on the engine. The engine changes would also let an outcome keep a taker's fills (§9, Outcome); a per-command fill limit, so that matching stops at `MaxFills` instead of the adapter refusing the whole order, is a further one (§9, A2). **Evaluation:** the caps; no engine redesign.
2. **Who redeems abandoned shares.** §10 has the adapter redeem for the account, in the account's own name, which advances its nonce. The alternative is an engine operation that settles a terminal round's holdings as the authority. Without one of the two, rounds cannot be reused. **Evaluation:** the adapter redeems in the account's own name (§10).
3. **The trigger contract.** §8 specifies an original implementation that holds and returns nothing. Extending upstream's `AbstractTrigger` instead means vendoring BSL code outside the public tree, and it sweeps stray tokens into the app's custody, which turns the custody equality of §7 into "at least". **Evaluation:** the original trigger, built at `../stack/contracts/src/EvaluationClockTrigger.sol`; no upstream code in the tree.
4. **Results by collection, not notification.** §9 sends no receipt from a tick, so a maker learns of a fill only with its next request. That, with the padded requests of §4, is what keeps trades off the chain's metadata, except for the residual channels of §11. Notices in the activating tick would be prompter and would show who traded with whom. **Evaluation:** collection.
5. **Networks.** The guest accepts 31337, 26514, 2651420 and 84532. The minimum cutoff buffer for public networks is now fixed: 30 s on every chain but 31337, from the measured chain-time lag and transition time (§9, Cutoff). **Evaluation:** the slice runs on 31337 only. **2026-10-06:** the owner runs the guest on Horizen mainnet (26514), on the owner's own Vela contracts, manager and executor, with one market, BTC 900 (§2), which the guest requires on that chain.
6. **Seeded key registration.** Forbid it for the evaluation (the client never sends a seed), or accept that such an account's receipts are linkable (§11). **Evaluation:** forbidden. The guest cannot enforce it: the executor handles `ASSOCIATEKEY` itself and never calls the guest, so the guest cannot tell a seeded account. Only the client enforces it: `../crypto/session.ts` builds the 133-byte form without a seed, and the stack slice checks that length.
7. **Private refusal** as the default: an on-chain `COMPLETED` no longer means the command was accepted. **Evaluation:** private refusal.
8. **The payout record (version 3: the endpoint's claim credit) counted as the engine's `confirm_claim`** (§7), instead of a one-step settlement operation in the engine. **Evaluation:** the claim credit counts.
9. **`MaxActivations` and `MaxSweeps`** (16 each) are estimates until measured on the executor. **Evaluation:** they stay 16. Measured in this build, natively on darwin/arm64 (§9): the busiest tick the tests time, 40 engine commands on the full book, takes 1.29 s through upstream v0.2.0's host runtime and 0.72 s through dev's (1.21 s and 0.73 s before the stake limits); by the code a tick can apply up to 53, under 2 s scaled, against the executor's bound of 30 s (v0.2.0) and 10 s (dev). The stack's emulated executor has run the build before the stake limits, but not a tick at the caps: its busiest tick (eleven engine commands on a 6 KB state) took at most 11 ms, and reaching the caps through requests needs about 250 of them (`../stack/README.md`).
10. **Stake limits** (2026-10-06). Per account per round, for every account but the house at one closing time, and for the house over all open rounds, with "at stake" defined so that it cannot be split, minted around or spread over rounds (§9, Stake limits). **Built**, with evaluation defaults of 50, 200 and 2,000 USDC.e; the owner sets the real numbers at deploy. After the mainnet review the all-accounts limit counts held shares, not resting bids, and deploy checks how the limits and the house relate.
11. **Version 4, the perps-style book** (owner decision of 2026-10-07). Built with these defaults, each the owner can change: reports reach the guest in a PROCESS request, not in the trigger payload (one manager poll instead of two); only the exact-boundary report is accepted; on a disagreement with the registry the engine's result stands and a public record goes out, with no halt; payout ordinals per application; at most two pinned DON digests (the one BTC uses today is pinned; the newer `0x00097e7e…` of 2026-08-20 is not); pilot limits of 32 accounts and about 1,300 deposit-and-withdraw pairs per application.
