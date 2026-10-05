# ZEDGE Vela guest: local evaluation slice

The ZEDGE engine behind the Vela v0.2.0 guest ABI, for a local evaluation with a test token and a fixture oracle. It is **not** a confidential or production exchange: on v0.2.0 the manager can impersonate any account (see [What is trusted or unproven](#what-is-trusted-or-unproven)).

Built and tested in this step: deploy, deposit credit, register, withdrawal, and a trusted clock tick. Designed here and built next: order-book commands and registry round mirroring. Each section says which. The designed sections end in [Decisions for the owner](#decisions-for-the-owner): two of them have to be taken before orders are built.

Upstream Vela is under the Business Source License 1.1 (internal evaluation and testing only). No upstream code is copied here, and the guest imports none of it. The conformance test fetches upstream into `build/`, which is git-ignored; it must never be committed. One file, `testdata/host/conformance_test.go`, is ZEDGE code written against upstream's API and compiles only inside that fetched copy.

## Build and test

```sh
go test ./...                    # native unit tests; wasm tests skip until the guest is built
go test -run '^$' -fuzz FuzzEntryPoints -fuzztime 60s -fuzzminimizetime 5s .

./build.sh                       # build/zedge_guest.wasm; needs TinyGo 0.39.0, Binaryen 133, Go 1.25.14
scripts/fetch-upstream.sh        # upstream Vela at 335724c (v0.2.0) and 25af7d6 (dev) into build/upstream/
go test -run 'TestGuest|TestUpstream' -v .
ZEDGE_SOAK_ROUNDS=400 go test -run TestGuestSoak -v .             # the long memory run, about 100 s

npm --prefix ../crypto run check && npm --prefix ../crypto test   # TypeScript side of the shared vectors
go test -run TestVectors -update .                                # only after an intended protocol change
```

- `build.sh` refuses any other toolchain version. Set `TINYGO` and `WASMOPT` to point at the binaries. It prints the wasm's SHA-256, which is the deployment's `applicationFingerprint`.
- The build flags are `-target=wasi -scheduler=none -opt=2 -no-debug`. The Vela host never calls `_start`. Two things follow: TinyGo's default scheduler traps in `crypto/sha256`, hence `-scheduler=none`; and TinyGo's initialisers never run, so `cmd/zedge-guest` runs them itself on the first export call. That guard links to a TinyGo runtime internal; `TestUpstreamConformance` is the tripwire.
- `scripts/fetch-upstream.sh` takes the two pinned commits from GitHub, or from a local clone with `VELA_UPSTREAM=/path/to/vela` (no network). `TestUpstreamConformance` skips, naming this script, when a commit is absent. It needs upstream's Go dependencies in the module cache.
- A wasm older than its sources fails the wasm tests rather than testing the wrong program.

| Test | What it shows |
| --- | --- |
| `TestTimeFreePaths`, `Test*Rejected`, `TestContextComesFromTheHost` | Every rule in the built sections below, natively. |
| `TestEveryReplyHasOneShape`, `TestReceiptsAreOneSize` | Every accepted request has the same public shape, and every receipt is 2,048 bytes whatever it says (§5, §11). |
| `TestExitReserve` | Using up the engine's evidence IDs cannot strand a balance (§7). |
| `TestBuiltStateFitsTheBound` | This build cannot write a state above the size bound (§3). |
| `TestEngineReplay` | The same commands and times applied straight to the engine give the same engine state hash. |
| `FuzzEntryPoints` | No entry point panics; an error carries no effect; each entry point has its one public shape; a refusal, a retry or a sync changes nothing but the tick counter; the exit reserve is never spent. |
| `TestGuestImports` | The wasm imports only the eight WASI functions Vela v0.3.0 allows. |
| `TestGuestShim` | Hostile pointers and lengths at the wasm exports return error results, not traps. |
| `TestGuestSoak` | 320 requests (3,200 in the long run) on states at the size bound, in one wasm instance: linear memory stops growing and every result equals the native adapter's. Also: the salt is the host's random bytes, and `allocate` stops at the bound. |
| `TestUpstreamConformance` | A 288-step script through upstream's own host runtime, at both commits, returns exactly what the native adapter returned at every step: state bytes, engine state hash, events, withdrawals, error text. Includes a runtime restart, hostile payloads, a payload the guest refuses to allocate, and a full account table. |
| `TestVectors` + `../crypto/guest.test.ts` | One committed file, `testdata/vectors.json`, that both languages must reproduce. |

## Layout

| Path | Role |
| --- | --- |
| `adapter.go`, `state.go`, `envelope.go`, `result.go` | All adapter logic, ordinary Go, no clock, no randomness. |
| `cmd/zedge-guest/main.go` | The wasm layer: seven exports, buffer table, initialiser guard, the one draw of host randomness. No logic. |
| `testdata/host/conformance_test.go` | ZEDGE code that compiles only inside the fetched upstream module. |
| `testdata/shim.mjs`, `testdata/soak.mjs` | Node drivers for the wasm exports. |
| `../crypto/guest.ts` | Canonical command encoder and request IDs for clients. |

## Protocol

### 1. Host calls (built)

The guest holds nothing between calls. The host passes the whole state in and takes the whole state out.

| On-chain request | Export the executor calls | Guest behaviour |
| --- | --- | --- |
| `DEPLOYAPP` | `deploy(appId, constructorParams)` | Builds the first state (§2). |
| Any request with `assetAmount > 0` | `deposit(appId, sender, token, value, state)`, before the row for its type | Credits the sender or fails (§6). |
| `PROCESS`, non-empty payload | `process_request(appId, sender, 1, plaintext, state)`; the executor has decrypted the payload with the key registered for `sender` | Validates the envelope, then answers with one receipt and one request for a tick (§4, §5). |
| `PROCESS`, empty payload | none: the host skips the guest | A deposit-only request. |
| `ASSOCIATEKEY` | none: the executor stores the key | — |
| `DEANONYMIZATION` | `process_request(…, 2, …)` | Error `zedge: unsupported request type`. |
| `TRUSTPROCESS` | `trusted_request(appId, payload, state)` | Applies a tick and publishes the clock it set (§8). |
| Executor restart (v0.2.0 only) | `load_module(appId)` | Empty result; the host discards it. |

Every export returns `[uint32 little-endian length][JSON]` with `state`, `events`, `appEvents`, `withdrawals`, `fuel` and, on refusal, `error`. `fuel` is the constant `0x1`: nothing meters the guest, so the fee is the endpoint minimum.

A result with `error` makes the endpoint record a failed request, keep the old state and refund any attached deposit as a claim. Error strings are public, so they are constants that describe no account (§11).

The wasm layer reads input only from buffers it handed out through `allocate`. A pointer or length it does not recognise is `zedge: bad buffer`, never a memory read. `allocate` returns 0 for a size below 1 or above 524,288 bytes, the state bound of §3. The host then fails that request itself (`allocate returned null pointer`): the state is unchanged, an attached deposit is refunded and the guest has allocated nothing. A user can cause this only with a payload above 512 KiB, which no valid envelope needs (§4). Checked on both upstream runtimes.

### 2. Deployment and identity (built)

Constructor parameters are canonical JSON, at most 16 KiB:

```json
{"engine":{ …engine.Config… },"applicationFingerprint":"<64 hex>","origin":"http://localhost:5173","epoch":"1"}
```

1. `engine.domain.applicationId` must be `""`. Vela derives the application ID from the deploy request itself, so the guest takes it from the host's `appId` argument, written in decimal. `appId` 0 is refused.
2. `engine.domain.chainId` must be 31337, 2651420 or 84532 (the networks `session.ts` accepts). Any other chain fails deploy.
3. `engine.oracle.chainId` must equal `engine.domain.chainId`. The trigger reads the registry in the block whose time it reports (§10), so the registry has to be on the endpoint's own chain. A registry on another chain fails deploy.
4. `engine.authority` must be the trigger contract's address. The guest cannot check that. It is the engine's reserved system principal: it can never register, deposit or trade, and withdrawals to it are refused. The trigger is deployed first; its address goes into these parameters and into `submitDeployRequestWithTrigger`.
5. `applicationFingerprint` is the wasm's SHA-256. The guest cannot measure itself; the executor checks the deploy descriptor's hash against the module. A client must check that the descriptor hash and this value are the same before trusting either.
6. `origin` is the one web origin clients put in their session domain: `http://` or `https://`, then lowercase host characters and an optional port. The guest checks that shape only.
7. `epoch` is the key epoch, 1–10 digits with no leading zero. It is fixed for the life of the deployment; there is no rotation.
8. `engine.New` validates the rest, including the registry rules hash.
9. The wasm layer draws 32 bytes from the host's `random_get` and the state keeps them as `salt`. If the host's random source fails or gives only zeros, deploy fails with `zedge: internal error`. The salt is the only secret in the state: without it the public state root would confirm guesses at private commands (§11). It is never sent to anyone.

Every later call must carry the same `appId`, or it fails with `zedge: wrong application`.

### 3. State (built)

Canonical JSON, at most 524,288 bytes (512 KiB):

| Field | Meaning |
| --- | --- |
| `version` | 1. |
| `applicationFingerprint`, `origin`, `epoch` | From the constructor parameters. |
| `salt` | 64 hex characters drawn at deploy (§2). Never changes. |
| `clock` | `block.timestamp` of the last accepted tick. 0 until the first tick. At most 4,294,967,295. |
| `block` | `block.number` that tick reported. Recorded, never compared. |
| `tickSeq` | Number of ticks requested so far: one per accepted `PROCESS` request. |
| `lastTick` | Highest tick number applied. |
| `staged` | Book commands waiting for their tick (§9). Always `[]` in this build; a state holding one is refused. |
| `deposits` | Number of deposits credited. |
| `withdrawals` | Number of withdrawals handed to the endpoint. |
| `notices` | `[{account, count}]`, sorted by account: the number of deposit receipts sent to each account. |
| `engine` | The engine snapshot, including its configuration. |

A state is accepted only if it is byte for byte what the adapter would write, and:

- the identity fields have the shapes of §2, the salt is 64 lowercase hex characters and not all zeros, the engine domain names an evaluation chain and a decimal application ID, and the registry is on that chain;
- the engine snapshot passes `engine.Validate`;
- `lastTick ≤ tickSeq`, `clock` is 0 exactly when `lastTick` is 0, `clock ≤ 4,294,967,295`, and the engine's time is not ahead of `clock`;
- the engine holds exactly `deposits + 2 × withdrawals` evidence IDs, no claimable amount and no open withdrawal;
- `staged` is empty and `notices` is sorted, with valid addresses and counts of at least 1.

This detects a malformed or inconsistent state. It does not show that a state is genuine or current.

**Why 512 KiB and not the engine's 8 MiB.** The whole ledger is one JSON document, and every request allocates several buffers as large as it. TinyGo's collector treats every constant in the wasm's data section as a possible pointer, so a dead buffer that one of them happens to point into is never freed. Small buffers are rarely hit. Buffers much above half a megabyte are hit faster than they are reused, linear memory doubles, and wasm memory never shrinks. Measured on the built wasm under Node (same allocate, call, free order as the host; not wasmtime):

| What was repeated in one instance | Linear memory |
| --- | --- |
| `allocate(1 MiB)` then `deallocate` | 3,072 MiB after 1,787 rounds, still doubling |
| 2,000 mixed requests on a 393, 459, 525 or 655 KB state | 96 MiB, flat |
| The same on a 787 KB state | 768 MiB after 860 requests |
| The same on a 1.05 MB state | 768 MiB by request 35 |
| This build, 3,200 mixed requests on a 522 KB state (`TestGuestSoak`, long run) | 96 MiB, flat from the second round |

So the bound is a measured one, with about 25% in hand, and `TestGuestSoak` holds it: it fails if memory is still growing after the first quarter of its run or ends above 192 MiB. It depends on the constants in this exact wasm, so it must be re-run for every build. A state above the bound is refused like any other invalid state, and `allocate` will not even take it (§1).

This build cannot write a state above the bound. With all 256 account slots and all 4,096 evidence IDs used the state is 382,245 bytes, and under 485,000 with every number at its widest (`TestBuiltStateFitsTheBound`). The order design of §9 can, and has to be bounded before it is built.

### 4. Envelope (built)

`process_request` receives the plaintext `adapters/vela/crypto/session.ts` encrypts: canonical JSON with these keys in this order, at most 16,384 bytes.

```json
{"version":1,"domain":{"chainId":31337,"endpoint":"0x…","applicationId":"…","applicationFingerprint":"…","rulesHash":"…","origin":"…"},"account":"0x…","epoch":"1","requestId":"…","kind":"command","body":{…}}
```

Checks, in order. The first that fails is the public error returned.

| # | Check | Error |
| --- | --- | --- |
| 1 | Request type is 1 (`PROCESS`). | `unsupported request type` |
| 2 | State is valid and belongs to `appId`. | `invalid state`, `wrong application` |
| 3 | Sender is 20 bytes and not zero. | `malformed sender` |
| 4 | Payload is 1–16,384 bytes and is exactly the canonical JSON above: no unknown, reordered or duplicate keys, no whitespace, no trailing bytes. | `malformed envelope` |
| 5 | `version` is 1, `kind` is `"command"`, `epoch` is the deployment's, and all six domain fields equal the deployment's. | `wrong context` |
| 6 | `account` equals the host-supplied sender. | `sender mismatch` |
| 7 | `body` is one of the two shapes below. | see below |

Domain values: `chainId`, `endpoint` and `applicationId` come from the engine domain; `applicationFingerprint` and `origin` from the constructor parameters; `rulesHash` is the SHA-256 (lowercase hex) of the canonical JSON of the stored engine configuration. It is not the registry's Keccak rules hash, which is one field inside that configuration.

Bodies:

- `{"type":"sync"}` with `requestId` equal to `<account>:sync`. Anything else in a sync is `malformed envelope`.
- `{"type":"command","command":"<text>"}` where `<text>` is the canonical engine command JSON `engine.DecodeCommand` accepts, at most 8,192 bytes (`malformed command` otherwise). Then `command.account` must equal the sender (`sender mismatch`), and `command.id` must equal both `requestId` and `<sender>:<nonce>`, and `command.domain` must equal the engine domain (`wrong context`).

`../crypto/guest.ts` builds both bodies. Its `encodeCommand` output is the `<text>`; its SHA-256 is the command digest. It throws on anything the engine would read differently, including an empty value of the wrong type (`roundId: 0` on `cancel_all` is an error, not "every round").

### 5. Commands (built)

**Authority.** The engine context is built in two places only. A user context is `{principal: host-supplied sender, timestamp: clock, system: false}`. A system context is `{principal: engine.authority, timestamp: clock, system: true}` and is used only for commands the adapter itself constructs: the deposit credit, the export and claim credit that follow an accepted withdrawal request, and the checkpoint in a tick. No byte of a client payload selects the principal, the time or `system`.

**Clock.** Before the first tick (`clock` 0) every command and every deposit fails with `zedge: clock not initialised`. Only `sync` works.

**One reply shape.** Every `process_request` that passes §4, with the clock set or as a sync, ends the same way:

- `tickSeq` goes up by one and the result carries exactly one public app event asking for that tick (§8);
- the sender gets exactly one receipt, 2,048 bytes long (§11);
- a withdrawal that was accepted adds one Vela withdrawal (§7), which is public in any case.

A sync is that and nothing more. On chain, an applied command, a refused one, a retry and a sync are therefore the same thing: one encrypted event of one length and one tick request. Only a public error (the list in §11) looks different, and it carries no receipt.

**Direct commands.** After the checks in §4 a command is handled as follows.

| Operation | This build |
| --- | --- |
| `register` | Applied at once. |
| `request_withdrawal` | Applied at once; export and claim credit follow in the same transition (§7). |
| `mint`, `merge`, `redeem`, `cancel_withdrawal` | Passed to the engine at once. All are refused by the engine in this build, because it never holds a round or an open withdrawal. |
| `place_order`, `cancel_order`, `cancel_all` | Refused in private: `order book commands are not enabled in this build` (§9). |
| Any authority operation | Refused in private by the engine: `wrong authorization class`. |

Direct commands run at `clock`, which is the past. That is safe for these operations: none of them reads the order book, and none gains from an old time. A mint accepted after the real cutoff creates a pair that is always worth exactly one unit and can be merged back at any time. Every receipt says which clock it was judged at (`at`, §11).

**Private refusal.** Once the checks in §4 pass and the clock is set, a refusal is not an error, whether it comes from the engine or from the adapter's own rules (book commands, above; withdrawal destinations and the exit reserve, §7). The request succeeds with the reply shape above: the ledger (the `engine` part of the state) is the input's byte for byte, there is no withdrawal, and the receipt has `status: "rejected"` and the reason. On chain such a request is `COMPLETED`: completion does not mean the command was accepted, so a client must read its receipt. A refused command does not consume its nonce.

**Retry.** If the command is byte for byte the account's latest accepted command, the engine returns the original receipt and changes nothing. The adapter then leaves the ledger as it was and sends the original receipt again with `status: "retry"`, and no withdrawal. An older nonce, or a different command under the latest nonce, is a private refusal.

### 6. Deposits and endpoint custody (built)

A user deposits by submitting any request with `tokenAddress` = collateral and `assetAmount` > 0. The endpoint pulls the tokens and adds them to `appCustody[app][collateral]` at submission, before the guest runs.

`deposit` then does the following.

1. `token` must be the engine's collateral, else `zedge: unsupported token`. That includes ETH (the zero address).
2. `value` is big-endian. After leading zero bytes it must be 1–8 bytes and at most 10^15, else `zedge: invalid amount`. One token base unit is one engine atom; the token must have 6 decimals, which the guest cannot check.
3. If the engine has never seen the sender, the adapter first applies `register` for it: the one canonical register command that account could have sent itself, with nonce 1, in the sender's own user context. A later explicit `register` with nonce 1 is then an exact retry.
4. The adapter applies the engine's `deposit` as the authority. Its evidence ID is `SHA-256("ZEDGE_VELA_V1:DEPOSIT:<chainId>:<endpoint>:<applicationId>:<n>")`, where `n` is this deposit's ordinal (`deposits + 1`).
5. The exit reserve of §7 must still hold afterwards.
6. The sender gets one `deposit` receipt (§11). A deposit asks for no tick.

Any failure, including an engine refusal (account limit, lifetime cap, the authority as sender) and the exit reserve, is `zedge: deposit rejected` or the specific error above. The endpoint then takes the amount out of app custody and credits it to `pendingClaims[collateral][sender]`.

A depositor with no registered key: by upstream's executor code the receipt cannot be encrypted, the request fails and the deposit is refunded. So every account the engine holds had a key when it was registered. This was read from the source and then run on the local stack (`../stack`): the host fails the request with its own error, `no Secp521r1_PubKey found` (code 9), and refunds the deposit.

A deposit and a command in one request: `deposit` runs first, then `process_request` on the new state. An error from the command fails the whole request and refunds the deposit. A private refusal does not: the deposit stays credited.

The evidence ID names an ordinal, not a chain event. v0.2.0 gives the guest no request ID, so the adapter cannot tell a deposit apart from a replay of it; each `deposit` call credits once.

### 7. Withdrawals and endpoint custody (built)

1. A `request_withdrawal` whose destination is the endpoint or the authority (the trigger) is refused in private: `withdrawal destination not allowed`. A claim credited to the endpoint itself is paid to nobody, and one credited to the trigger is not the user's.
2. Otherwise the engine applies the request. If it is accepted and is not a retry, the adapter applies, in the same transition, `export_withdrawal` and then `confirm_claim` as the authority, with evidence IDs `…:WITHDRAWAL:…:<n>` and `…:CLAIM:…:<n>` in the format of §6 (`n` = `withdrawals + 1`). If either fails, or the exit reserve below would not hold afterwards, the whole command is a private refusal and the ledger does not change.
3. The result carries one Vela withdrawal `{tokenAddress: collateral, destinationAddress, amount}`. In the same `stateUpdate` call that accepts the new state root, the endpoint subtracts the amount from `appCustody[app][collateral]` and adds it to `pendingClaims[collateral][destination]`. If app custody is short, that call reverts and the state is not accepted.
4. Anyone can then call `claim(collateral, destination)` on the endpoint to move the tokens.

`confirm_claim` here means "the endpoint credited the claim", not "the tokens left the endpoint". The guest never learns about a later `claim`, and the credit is atomic with the state root, so the engine record is closed in the same transition. As a result the engine's `claimable` is always 0 and no withdrawal is left open.

**Exit reserve.** The engine holds at most 4,096 evidence IDs and never frees one. A deposit uses one and a withdrawal two, and the IDs here are ordinals that deduplicate nothing. Left alone, one account recycling a single atom (one request carrying a one-atom deposit and a one-atom withdrawal uses three IDs) would use them all in 1,365 requests, and then no balance could ever leave. So the adapter keeps two IDs back for every account that still holds something. After any deposit or withdrawal this must hold:

```
4,096 − evidence IDs used  ≥  2 × (accounts holding cash or shares)
```

- A deposit that would break it fails with `zedge: deposit rejected` and is refunded.
- A withdrawal that would break it is a private refusal: `exit reserve reached: only a withdrawal of the whole balance is accepted`.
- A withdrawal of an account's whole balance never breaks it: the account stops counting.

A deployment that runs out of IDs therefore ends closed, not locked: no more deposits and no more partial withdrawals, and every account can still take its whole balance out once. With 256 accounts funded the reserve is 512 IDs, so at least 3,584 are usable. This costs nothing in the engine and is why the limit in [Limits](#limits) is survivable; the limit itself is still an engine matter.

**Custody.** At any accepted state root:

- `appCustody[app][collateral]` ≥ engine `custody` + deposits submitted but not yet processed. It is equal as long as the trigger hands nothing back to the endpoint: the endpoint adds whatever the trigger's `withdraw()` reports to this application's custody, without any guest call. With the trigger of §8, which holds and returns nothing, it stays equal. A reconciliation must subtract the amounts in the endpoint's `TriggerWithdraw` events and then require equality; it must not use a tolerance.
- the sum of the app's `Withdrawal` events = engine `paidOut`;
- the sum of credited deposits = engine `deposited`.

Trading fees stay in `custody`. There is no fee withdrawal.

### 8. Chain time (built; the evaluation trigger is `../stack/contracts/src/EvaluationClockTrigger.sol`)

The only clock is a trigger contract answering inside the endpoint's own transaction.

1. **Asking.** Every accepted `PROCESS` request (§5) increments `tickSeq` and emits one public app event: subtype `SHA-256("zedge.vela.tick.v1")` = `0x8af869f39217eabc1718875ec064086a0e0283d1c1ee8a025b687fd40b5e3850`, data = the new `tickSeq` as a 32-byte big-endian word. A `sync` is the way to ask when there is nothing else to send; any sender with a registered key may send one, at any time.
2. **Answering.** The endpoint calls the trigger at the end of every successful `stateUpdate`. The trigger contract must do exactly this:
   - `getTrustProcessPayload`: look for the tick subtype in `appEventData`. If it is present with 32 bytes of data, return

     ```solidity
     abi.encode(uint256(1), block.chainid, address(processorEndpoint), block.number, block.timestamp, uint256(bytes32(data)))
     ```

     which is exactly 192 bytes. `block.timestamp` is therefore the timestamp of the block that committed the asking transition. With that subtype present it must never revert: the endpoint swallows a revert and the tick is silently lost.
   - Return empty bytes in every other case, and in particular for the clock subtype of step 4. A trigger that answered a tick's own record would loop.
   - `execute`: do nothing. `withdraw`: move nothing and return two empty arrays. The trigger is never meant to hold tokens; anything sent to it stays there and belongs to nobody.
   - Accept calls from the endpoint only.

   The hand-built 192-byte payload in the tests equals Foundry's `cast abi-encode` output for this tuple. `EvaluationClockTrigger` in `../stack/contracts` implements exactly this (the version-1 answer only, with no registry read), and the stack slice checks every clock record against the block that asked for it.
3. **Applying.** `trusted_request` accepts the payload only if all of these hold, else it fails and nothing changes:
   - length 192; version 1; `chainId` and `endpoint` equal the engine domain; every integer fits 64 bits; `1 ≤ timestamp ≤ 4,294,967,295`; `blockNumber ≤ 10^15` (`zedge: malformed trusted payload`);
   - `lastTick < tick ≤ tickSeq` (`zedge: stale or unknown tick`);
   - `timestamp ≥ clock` (`zedge: clock regression`).

   It then sets `clock`, `block` and `lastTick` and applies an engine `checkpoint` as the authority at the new `clock`, which releases expired orders. Ticks may be skipped; they may not be replayed or reordered. The block number is recorded and not compared with the previous one: the engine never reads it, and a second ordering rule would only be a second way to stop the clock. The timestamp cap is the largest time any engine round can use; a value in milliseconds is above it.
4. **Publishing.** The tick's result carries one public app event: subtype `SHA-256("zedge.vela.clock.v1")` = `0xfcec946954aa78965de9f0bba32063a87447ec772e05beb1e50c0e36f5f09460`, data = three 32-byte big-endian words, `tick`, `blockNumber`, `timestamp`, as applied. It carries no receipt, and never the tick subtype, so a tick cannot ask for another tick.

   This record is what makes the clock checkable from outside. The request for tick `k` is an app event in a transaction of some block `B`, so the only genuine record for `k` is `(k, B.number, B.timestamp)`. A record that says anything else proves the enclave was fed a payload the trigger did not produce. Missing tick numbers show ticks that were lost or withheld, and the block a record lands in shows how late it was applied. Each receipt also carries the clock it was judged at (§11). All of this detects; none of it prevents (see [What is trusted or unproven](#what-is-trusted-or-unproven)).

A lost tick (the trigger reverted, or its trusted request failed) is replaced by the tick of any later request.

One wrong tick that is accepted still moves the clock for good: after a tick stamped a year ahead, every genuine tick is a regression until real time catches up. The cap only rules out values that are not seconds at all.

Bootstrap: the deploy result cannot carry an app event, so a new deployment has no clock. One account registers a key (`ASSOCIATEKEY`) and sends a sync; the first applied tick sets the clock, and deposits and commands work from then on.

Cost: every `PROCESS` request is followed by one trusted request, so two transitions, and the endpoint stores each 192-byte payload on chain. That is the price of one request shape (§11) and of a clock that is as fresh as the last request.

### 9. Two-phase book commands (designed, not built)

`place_order`, `cancel_order` and `cancel_all` are the book commands. The rule is: **the order book changes only inside `trusted_request`, in tick order, at the tick's chain timestamp.** `process_request` and `deposit` never change it.

**Staging (`process_request`).**

- S1. The envelope and command pass §4, and the clock is set.
- S2. The account is registered and the command's nonce is its next engine nonce; otherwise a private refusal. (The account's latest accepted command, resent, is a retry as in §5.)
- S3. An account holds at most one staged command. While it holds one:
  - the same bytes again get the `staged` receipt again; the item keeps its original tick number;
  - any other command from that account is a private refusal;
  - a deposit by that account fails (and is refunded as a claim);
  - `sync` still works.
- S4. A `place_order` is a private refusal (`order capacity`) if the account already has `MaxAccountOrders` active orders.
- S5. Otherwise `{tick, command}` is appended to `staged`, where `tick` is the tick this very reply asks for (§5), and the receipt has `status: "staged"` and that tick. Nothing in the engine changes, nothing is reserved, and no nonce is consumed.

A staged command has the reply shape of every other request (§5): staging is not visible on chain.

**Activation (`trusted_request` for tick `k` at timestamp `T`).** After the checkpoint and the round mirror (§10), staged items with `tick ≤ k` are applied in ascending tick order, at most `MaxActivations` of them, each with the context `{principal: command.account, timestamp: T, system: false}`.

- A1. Accepted with at most `MaxFills` fills: the item is removed and the outcome `applied` is recorded for its owner.
- A2. Refused by the engine, or accepted with more than `MaxFills` fills (the adapter then drops the engine's result, as the engine itself does at 64): the item is removed and the outcome `rejected` is recorded with the reason (`matching work limit; split order` in the second case). The nonce is not consumed. A taker facing many one-lot orders has to split its order; that is the cost of a small cap.
- A3. Items with `tick > k` stay staged.
- A4. If items with `tick ≤ k` are left over because of the cap, the tick's result also carries one tick request (§8.1), so the trigger answers again and the next tick carries on. Each such tick removes at least one item, so the chain is at most ⌈staged ÷ `MaxActivations`⌉ ticks long. With nothing left over a tick never asks for a tick.

A tick sends **no receipt to anyone**. Every tick has the same public shape, the clock record of §8.4, whether it activated nothing, rested an order or filled twenty. Results are collected by each account with its own next request:

- **Outcome.** The state keeps at most one outcome per account, `{account, commandId, tick, status, reason}`, sorted by account. The account's next accepted request of any kind returns it in its receipt as `outcome` and removes it. For `applied`, `outcome.receipt` is `engine.ProjectReceipt` of the account's stored last receipt, read before that request's own command is applied; it holds the fills. It is there until the account's next ledger command, its own or a settlement sweep (§10), replaces the stored receipt.
- **View.** Every receipt carries `view`: `engine.AccountView` of its recipient after the request: cash, reserved cash, holdings, its own active orders with their filled quantity, filled notional and fee paid, and its nonce. A maker learns of fills and releases from its view. A maker's order trades only at its own price, so an order's fills follow from its filled quantity, and an order that is gone was either filled (the cash arrived) or released (the reservation came back). A client takes its next nonce from its latest view, never from its own count.

So neither the taker's request, nor the tick that activates it, nor the maker's next request shows that a trade happened, how many makers it touched or who they were. What stays public is the list in §11.

**Cutoff.** An item staged by the transition that asked for tick `k` was committed in the block whose timestamp is `T`. The engine admits a `place_order` only if the round is open, `round.start ≤ T < round.cutoff` and `T < expiry ≤ round.cutoff`. So `T = cutoff` is refused and `T = cutoff − 1` is admitted. Resting orders are released by the checkpoint of the first tick with `T ≥ cutoff` or `T ≥ expiry`, before any activation in that tick. No fill can happen at or after the cutoff.

This argument stands on two things that the guest cannot check:

- `T` is the endpoint chain's block timestamp, while the closing price is stamped in real time. The margin between the last admission and the result being knowable is the cutoff buffer minus however far that chain's timestamps can run behind real time. The engine allows a buffer of 1 to 299 seconds. On local Anvil the test sets the time, so any buffer works. For 2651420 and 84532 the lag was not measured: a minimum buffer has to be fixed per chain before either is used.
- The registry is on the endpoint's chain (§2.3), so the registry's own times and `T` are one clock.

**Sequencing.** Tick numbers are the order in which staging transitions were committed, so the book evolves as if each command ran at its commit time, in commit order, however late the ticks are processed. An item whose own tick was lost, or that waited behind the activation cap, is activated by a later tick at that later timestamp: never earlier than its commit, and its order among the others is unchanged. Such an item can miss its cutoff.

**Why an account is frozen while it holds a staged command.** If it could cancel, withdraw or top up before activation, a delayed activation would give it a free option: stage an order, watch, and keep it only if it turned out well. An exit that drops the staged item has the same flaw, so there is none. The price is liveness: **if no tick is ever applied again, an account holding a staged command cannot act and cannot withdraw.** Accounts without one still can. A tick needs only the trigger's clock answer, which depends on no other contract (§10). What stops ticks is then a broken trigger, or a manager that stops or withholds them; it is trusted with far more than that (see [What is trusted or unproven](#what-is-trusted-or-unproven)). This is accepted for the evaluation, not solved.

**Retry.**

- A replayed tick fails (§8), and activation removes the item in the same accepted transition, so nothing activates twice.
- A staged command resent while staged never creates a second item (S3).
- A refused command stays valid for its nonce until another command with that nonce is accepted. A client that no longer wants it must consume the nonce.

**Caps, and the state budget they come from.** The engine's own limits (256 accounts, 128 rounds, 1,024 orders, 64 fills kept in every account's stored last receipt) let a state grow to the engine's 8 MiB snapshot cap, and §3 allows 524,288 bytes. Worse, a state that grows past what the guest can serve cannot be shrunk again, because the requests that would shrink it fail too. So the order build enforces its own caps, in the adapter, and they are chosen so that a state with everything at its cap still fits:

| Cap | Value | Enforced by |
| --- | --- | --- |
| `MaxSliceAccounts` | 32 | A `register`, or a first deposit, for a 33rd account is refused. |
| `MaxSliceRounds` | 8 | The mirror creates no round while the engine holds 8 (§10). |
| `MaxAccountOrders` | 4 active orders per account, so 128 in the book | S4. |
| `MaxFills` | 4 fills per command | A2. |
| `MaxActivations`, `MaxSweeps` | 16 per tick each | A1–A4 and §10. |

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
| Staged commands: 32 × 520 | 16,640 |
| Outcomes: 32 × 300 | 9,600 |
| Deposit receipt counters: 32 × 85 | 2,720 |
| **Total** | **497,672** of 524,288 |

The per-item sizes are the engine's own JSON with wide numbers, rounded up; the outcome record does not exist yet and is an estimate. More than half the budget is the evidence set, and most of the rest is data the engine stores for every account. Two engine changes would free it: keeping adapter-issued ordinals as counters instead of 4,096 hashes, and keeping a digest of the last receipt instead of its fills. With those, the same bound serves well over a hundred accounts. That is the first decision below.

The order build is not done until two tests exist: one that builds a state with every cap reached and the widest values and checks it encodes under `MaxStateBytes`, and `TestGuestSoak` run on that state. `MaxActivations` and `MaxSweeps` come from one measurement, about 12 to 15 ms natively per engine command on a full book and roughly three times that in the wasm; they have to be confirmed on the real executor, whose bound is 30 s per request on v0.2.0 and 10 s on dev.

### 10. Registry rounds (designed, not built)

The engine's rounds mirror the `StreamsRoundRegistry` through the same trusted payload, version 2. The deployment gains one constructor parameter, `markets`: the list of `{asset, duration}` it mirrors. The first order build mirrors one market (BTC, 900 s); `MaxSliceRounds` is sized for that.

**Asking.** The tick request data becomes 32-byte words: `tick, s, o`, then `s` registry round IDs of the engine's `scheduled` rounds and `o` of its `open` rounds (`s + o ≤ 8`). Resolved and void rounds are not asked about.

**Answering.** The same trigger serves both builds: 32 bytes of data get the version-1 answer of §8, anything longer gets version 2. For version 2 it:

1. calls the registry's permissionless `createRound` for the next two slots of every market in its own immutable copy of `markets`, ignoring a failure (the round usually exists already). The registry round and the engine round are then created by the same tick, and no keeper has to win a race;
2. reads `getRound` for every asked ID and for those next slots, each read in its own `try`/`catch` with a gas limit, and skips a read that fails;
3. returns a record only where the registry is ahead of the engine: an asked `scheduled` round that now has `openedAt ≠ 0` or an outcome; an asked `open` round that now has an outcome; a next slot that was not asked about (the engine does not hold it yet);
4. returns, as 32-byte words, `2, block.chainid, endpoint, block.number, block.timestamp, tick, n`, then `n ≤ 16` records of 19 words each: `roundId, asset (0 BTC, 1 ETH), duration, start, openedAt, resolvedAt, outcome (0 pending, 1 Up, 2 Down, 3 Void)`, then the opening and the closing observation as `price, validFromTimestamp, observationsTimestamp, expiresAt, reportHash, decimals` each.

The clock words never depend on a registry read. If the data after the tick word is malformed or lists more than 16 IDs, the trigger returns the payload with `n = 0`, which is a plain clock tick. A registry that reverts, runs out of gas or is upgraded into something else can therefore delay rounds but cannot stop the clock, and with it cannot freeze a staged account (§9).

The record cap matters for more than the guest. The endpoint writes the payload into contract storage outside any `try`, so a payload too large to store would revert the asking transition on every attempt, and with it the endpoint's queue. Sixteen records are about 10 KB, roughly 7 million gas to store (an estimate, not measured). In normal running a payload has zero to three.

**Applying.** After the checkpoint, the guest applies, per record in `(start, asset, duration)` order, the first rule that fits and then re-examines the record:

- not in the engine, a configured market, `T < start`, and fewer than `MaxSliceRounds` rounds held: `create_round` with `engine.NewRoundSpec`; the derived `registryRoundId` must equal the record's;
- not in the engine and `T ≥ start`: nothing, for good (the engine cannot create a started round);
- `scheduled` and `openedAt ≠ 0`: `open_round` with `registryTime = openedAt`, the opening observation, and evidence = its `reportHash` without `0x`;
- `open` and outcome Up or Down: `resolve_round` with `registryTime = resolvedAt`, the closing observation, and evidence = its `reportHash` without `0x`; the engine's outcome must equal the registry's;
- `scheduled` or `open` and outcome Void: `void_round` with `registryTime = resolvedAt` and evidence = the registry round ID without `0x`.

A record the engine refuses, or whose outcome differs, is skipped and that round stays as it was. The tick still applies: one bad round must not stop the clock. So that a skip is visible, the clock record of §8.4 gains two words in this build: records applied and records skipped.

`registryTime` is always the registry's own recorded block timestamp, never `T` and never the guest's clock. The trigger reads the registry in the block at `T`, so `registryTime ≤ T`, as the engine requires. A void is mirrored only from a recorded `outcome == Void`.

**When a round exists in the engine.** A round with start `s` and duration `d` is created by any tick whose asking request is committed in `[s − 2d, s)`, provided that tick is applied before any tick stamped `s` or later. An honest manager serves ticks in order, so one request of any kind per round duration is enough; the keeper's sync provides it when nobody else does. A round that misses that window never exists in the engine, though it runs in the registry.

**Then, in the same tick, after activation (§9):**

1. **Settlement sweep.** For each resolved or void round, oldest first, and each account that still holds shares in it and holds no staged command, the adapter applies `redeem` for that round as that account: the one redeem command the account could have sent itself, with its next nonce, in its own user context at `T`, as §6.3 does for `register`. At most `MaxSweeps` per tick. The payout is the engine's and has only one possible value. The account's nonce advances by one, which is why a client reads its nonce from its view (§9). Without this, one lot left unredeemed in each round by an account that never returns would hold every round slot for ever, at almost no cost.
2. **Archive.** Each resolved or void round with no locked collateral and no supply left is removed with `archive_round`, as the authority; at most 4 per tick. The engine requires the archive record to be kept with the new state, so the tick's result carries it as a public app event: subtype `SHA-256("zedge.vela.archive.v1")` = `0xefe437757209e66cb09e68c2bfe69073f2740c38bea74805a8b00d3b3de3df7a`, data = the canonical JSON of `receipt.archive`. It is accepted in the same `stateUpdate` as the state root and holds only public round data. The trigger ignores it.

**Round budget.** Per market the engine then holds the next two rounds, the open one, and those that have ended but are not yet resolved, swept and archived: four or five in normal running. A round whose closing price never arrives stays until the registry voids it, at least a day later. If the 8 slots are full, no round is created until one is archived, and rounds whose window passes meanwhile are skipped for good. Four markets need about 24 slots, which the budget of §9 does not have with the engine as it is.

### 11. Receipts and what is public (built, except the rows marked)

A receipt is the envelope of §4 with `kind: "receipt"`, `account` = the recipient, and a `body`. The executor encrypts it to the recipient's registered key. Every receipt answers a request of the account it goes to and travels in that request's own transaction.

| `type` | `status` | When | `requestId` | Body |
| --- | --- | --- | --- | --- |
| `command` | `applied` | The sender's command was accepted | Command ID | `receipt`; `withdrawal` = ordinal, for a withdrawal |
| `command` | `retry` | Exact retry of its latest accepted command | Command ID | `receipt` (the original) |
| `command` | `rejected` | Refused after the checks in §4 | Command ID | `reason` |
| `sync` | `requested` | A sync | `<account>:sync` | — |
| `deposit` | `credited` | Deposit credited | Next notice ID | `receipt`; `deposit` = ordinal; `registered: true` if this deposit registered the account |
| `command` | `staged` | Book command staged (designed) | Command ID | — |

Every body also has:

- `at`: `{tick, block, timestamp}`, the trusted clock the request was judged at, which is the last tick applied before it. A client compares `timestamp` with the block that carried its request. A large gap means the clock was stale, or was held back.
- `tick`: the tick this request asked for (absent on a deposit receipt). The clock record for that tick or a later one (§8.4) tells the client when the clock passed its request.
- `pad`: zeros. **Every receipt's plaintext is padded to the next multiple of 2,048 bytes.** The largest receipt this build can produce is 1,472 bytes before padding (longest origin and application ID, every number at its cap), so every receipt is exactly 2,048 bytes and its ciphertext 2,076 (`TestReceiptsAreOneSize`). The executor encrypts without padding, so without this the length on chain gives away the refusal reason, the kind of command and the digits of every amount.
- designed, for the order build: `outcome` and `view` (§9). That build sets the size class from its own largest receipt in the same way.

Further:

- `receipt` is `engine.ProjectReceipt` for that account: its own status, amounts, fills (with its own side, role, price, size and fee) and released orders. It never names another account or another account's order.
- Notice IDs are `<account>:notice:<n>`, counting an account's deposit receipts from 1. A client that sees a gap has missed one.
- A command ID is `<account>:<nonce>`. `session.decryptReceipt(ciphertext, requestId)` accepts a receipt only under its exact `requestId`, account, epoch and domain.
- A tick produces no receipt. A request that fails with a public error produces no receipt at all.
- The guest gives every receipt one event subtype, `SHA-256("zedge.vela.receipt.v1")` = `0x124f25ec420301d96ad47008349df043146fa7ec26b5d9118962a276e3219968`. **That holds only for accounts that registered no subtype seed.** If an account's `ASSOCIATEKEY` payload carried a seed (the 226-byte form; the ZEDGE client sends the 133-byte form without one), the executor replaces the subtype with one of 50 values that belong to that account alone, and its receipts can be linked to each other and to its address. The guest cannot prevent that. Clients must trial-decrypt every `UserEvent` of the application and never filter by subtype.

**Public**, on chain, for every request: the sender; any deposit token and amount; any withdrawal destination and amount; the tick request and, for a tick, the clock record; the number of encrypted receipts (always one per `PROCESS` request and one per deposit) and their length (always the same); the error string of a failed request; and the new state root.

**The state root.** Vela publishes `SHA-256` of the application data after every request: its own request counter, the wasm hash, every registered key, and the guest state in clear. Everything in the guest state except the salt can be rebuilt from public data (deploy parameters are plaintext calldata; deposits, withdrawals and ticks are public). Without the salt an observer could therefore hash candidate commands until one matched the root; in review a staged order was recovered that way in seven seconds. The 256-bit salt of §2 removes that: no candidate state can be computed without it. It protects the root from chain observers only. The host sees the state anyway (below).

The public errors are exactly these, each prefixed `zedge: `:

`bad buffer`, `malformed parameters`, `invalid configuration`, `invalid state`, `wrong application`, `malformed sender`, `unsupported token`, `invalid amount`, `clock not initialised`, `deposit rejected`, `unsupported request type`, `malformed envelope`, `wrong context`, `sender mismatch`, `malformed command`, `malformed trusted payload`, `stale or unknown tick`, `clock regression`, `internal error`.

To these the host adds its own failure when the guest refuses a buffer (§1). On chain the host also prefixes the guest's error: `failed to process deposit: zedge: …` or `failed to process request: zedge: …` (seen on the stack).

## Limits

The engine's limits are 256 accounts, 4,096 evidence IDs and 10^15 lifetime deposited atoms, none of them reclaimable, and 128 retained rounds. In this adapter:

- **Accounts.** 256 `register` commands from distinct addresses fill the table. No deposit is needed, only a registered key and the request fee. After that no new account can be created, for good.
- **Evidence IDs.** A deposit uses one and a withdrawal two. The exit reserve of §7 keeps exhaustion from stranding anyone, but once the IDs are gone the deployment takes no deposit and gives each account one last withdrawal.
- **Lifetime deposits.** One deposit of 10^15 atoms (10^9 tokens) ends deposits for good. Withdrawals do not give the allowance back.
- **State size.** 524,288 bytes (§3). This build cannot exceed it; the order build has to be capped to stay under it (§9).
- **Rounds** (designed). 8 in the first order build, reused through the sweep and the archive of §10.

None of these is acceptable outside a local evaluation.

## What is trusted or unproven

On Vela v0.2.0 the enclave does not rebuild the on-chain request ID, so it cannot tell whether what the manager hands it is what the chain holds. Everything below follows from that or from the local setup.

- **Sender.** The `sender` the guest sees is whatever the manager supplied. Key registration is not bound either, so the manager can register its own key for any address and then send commands as that address. The manager can take every account's balance.
- **Amount and token.** Deposit amounts come from the manager. It can credit an account without a real deposit and withdraw other users' collateral through it, up to the app's custody.
- **Time.** A trusted payload is bytes from the manager. The guest checks its shape, that its tick number is pending and that its timestamp is not behind the clock; it cannot check that the trigger produced it. So the manager can:
  - move the clock forward at will;
  - hold it back: stamp any pending tick with any time from the current clock on, so that the guest's clock sits as far behind the chain as the manager likes. An order's `expiry` and a round's cutoff are compared with that clock, so neither bounds anything in real time;
  - withhold ticks, or fail one on purpose, while it goes on serving ordinary requests.

  With orders (§9) that is a free option on every staged order, and it needs no forged sender or amount, only an ordinary trading account. The manager can wait until a round's result is public and then admit its own order "before the cutoff" with a backdated tick; or, using genuine payloads only, apply or drop the ticks that would activate the orders staged before the cutoff, its own included, once it knows which way the round went. The clock record of §8.4 makes a fabricated payload provable and a withheld tick visible after the fact. It prevents neither.
- **Request identity.** The guest gets no request ID. Deposit and withdrawal evidence IDs are ordinals, not chain events. The manager can feed the enclave an account's earlier ciphertext in place of a later one; nonces limit that to a retry of the latest command or a previously refused command whose nonce is still unused.
- **Ordering.** The endpoint accepts the head of either queue, so the manager chooses whether a normal request or a pending tick runs first.
- **State freshness.** The enclave runs on whatever stored state the manager supplies. The chain refuses a transition from an old root, but the manager can still run old states to watch what comes out.
- **Trigger.** `trusted_request` has no sender. `engine.authority` being the trigger's address is a deployment promise, not something the guest verifies. The evaluation trigger is `../stack/contracts/src/EvaluationClockTrigger.sol`; its address is fixed for the application's life.
- **No attestation.** The local executor is an ordinary container with fixed development keys. Its signature says nothing about the code that ran. `applicationFingerprint` is a constructor parameter.
- **No chain or endpoint in the signed transition.** Replay of a signed transition across deployments is not excluded by upstream.
- **What the host sees.** v0.2.0 logs the raw `deposit` result at INFO: the whole state, salt included, in clear, in the executor log. The manager is handed the recipient of every receipt in clear, and sees the exact length of the state after every request. Nothing in this adapter hides anything from the host; the padding, the single request shape and the salt are against chain observers.
- **What chain observers still see.** Who sends requests and when; deposits and withdrawals with their amounts; that an address is active. Each receipt carries the engine's global sequence number, so an account learns how much the whole ledger moved between its receipts.
- **No exit.** If the manager stops, or its database is lost, private balances cannot be recovered or withdrawn. `claim` pays only what was already credited. Both happened to the v0.2.0 manager on the local stack (`../stack`): restarted in the second between its `stateUpdate` being mined and its seeing the inclusion, it rolls back its database and then refuses to start for good ("unrecoverable disalignment between DB and chain"); with its data volume removed it panics on every start. Either way no request is processed again and app custody has no way out.
- **Run on the stack as an evaluation only.** `../stack` ran key registration, deposit, withdrawal, claim, private refusals, event encryption and the trigger's clock on the local v0.2.0 Docker stack (software TEE with fixed keys, no attestation, test token, fixture oracle); its README says what that showed and what it did not. The executor took milliseconds per request there, on states of a few kilobytes only. At the size bound the guest was measured only through upstream's host runtime and under Node: tens of milliseconds per request with 256 accounts, up to about 125 ms at the bound on a busy laptop.
- **Memory.** The size bound was measured under Node's V8, not wasmtime, and on this wasm only (§3). The 2 GiB ceilings of the two upstream runtimes were not reached and not tested.
- **Stack.** The guest runs on TinyGo's fixed 64 KiB stack; `-stack-size` does not change it with `-scheduler=none`. The adapter keeps recursion depth independent of input (the nested-payload steps of the conformance script check that). In review at most 22.9 KB of it was used.
- **v0.3.0.** The guest passes the same test on unreleased dev `25af7d6`, which no longer calls `load_module`. That is an early warning, not support.

## Decisions for the owner

For the local evaluation all nine were settled on 2026-10-05, as marked **Evaluation** below; they can be revisited before anything public. The first two still shape the order build.

1. **How the order build fits the state bound.** Either the engine changes (adapter-issued evidence as counters, a digest in place of the stored last receipt's fills, and an authority-side settlement of terminal holdings), or the adapter caps of §9 stand: 32 accounts, 8 rounds, one market, 4 orders per account, 4 fills per command. This document is written for the caps, so that nothing waits on the engine. **Evaluation:** the caps; no engine redesign.
2. **Who redeems abandoned shares.** §10 has the adapter redeem for the account, in the account's own name, which advances its nonce. The alternative is an engine operation that settles a terminal round's holdings as the authority. Without one of the two, rounds cannot be reused. **Evaluation:** the adapter redeems in the account's own name (§10).
3. **The trigger contract.** §8 specifies an original implementation that holds and returns nothing. Extending upstream's `AbstractTrigger` instead means vendoring BSL code outside the public tree, and it sweeps stray tokens into the app's custody, which turns the custody equality of §7 into "at least". **Evaluation:** the original trigger, built at `../stack/contracts/src/EvaluationClockTrigger.sol`; no upstream code in the tree.
4. **Results by collection, not notification.** §9 sends no receipt from a tick, so a maker learns of a fill only with its next request. That is what keeps trades off the chain's metadata. Notices in the activating tick would be prompter and would show who traded with whom. **Evaluation:** collection.
5. **Networks.** The guest accepts 31337, 2651420 and 84532. For the two public testnets a minimum cutoff buffer has to be fixed first (§9). Limiting the slice to 31337 would be the simpler rule. **Evaluation:** the slice runs on 31337 only; the guest still accepts the two testnet ids, and nothing here targets them.
6. **Seeded key registration.** Forbid it for the evaluation (the client never sends a seed), or accept that such an account's receipts are linkable (§11). **Evaluation:** forbidden. The guest cannot enforce it: the executor handles `ASSOCIATEKEY` itself and never calls the guest, so the guest cannot tell a seeded account. Only the client enforces it: `../crypto/session.ts` builds the 133-byte form without a seed, and the stack slice checks that length.
7. **Private refusal** as the default: an on-chain `COMPLETED` no longer means the command was accepted. **Evaluation:** private refusal.
8. **The endpoint's claim credit counted as the engine's `confirm_claim`** (§7), instead of a one-step settlement operation in the engine. **Evaluation:** the claim credit counts.
9. **`MaxActivations` and `MaxSweeps`** (16 each) are estimates until measured on the executor. **Evaluation:** they stay 16. The stack slice measured the executor's time per request on small states only (milliseconds); a tick activating or sweeping orders on a full book near the state bound was not measured, because the order build does not exist. They are to be measured there.
