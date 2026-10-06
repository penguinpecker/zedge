# ZEDGE engine protocol v3

Authoritative implementation types: [`engine/types.go`](../engine/types.go). Serialization/validation: [`engine/codec.go`](../engine/codec.go), [Streams identity/price rules](../engine/oracle.go). Structural schemas: [commands](commands.schema.json), [bootstrap config](config.schema.json). This protocol describes original ZEDGE application logic, not a Vela SDK endpoint. Version 1 and version 2 snapshots, domains and commands reject: nothing is migrated or reinterpreted implicitly.

## Canonical envelope and authorization

Every command has `domain`, `id`, `nonce`, `op`; user commands also require `account`. Domain is `{ chainId, endpoint, applicationId, rulesVersion }`. Addresses are nonzero lowercase `0x` plus 40 hex digits. `rulesVersion` is 3. `applicationId` is 1–64 letters, digits, `_`, `-` or `.`. Streams feed IDs are canonical lowercase `0x` plus 64 hexadecimal digits, beginning `0x0003`. Command ID equals `principal + ":" + decimal nonce` with no leading zeroes.

`engine.DecodeCommand` accepts canonical compact JSON in the field order defined by the Go struct, with omitted optional zero-valued fields. Unknown fields, duplicate keys, alternate ordering/whitespace, trailing documents, fractional/exponent numbers and out-of-range integers reject. For interoperable clients, construct objects in this order and omit zero-valued optional fields:

```text
domain, id, nonce, op, account, roundId, round, amount, outcome, side,
price, quantity, tif, expiry, maxFee, orderId, withdrawalId, destination,
evidence, registryTime, observation
```

Domain field order: `chainId, endpoint, applicationId, rulesVersion`.
Round field order: `asset, feed, registryRoundId, start, end, cutoff, observationWindow, openingDeadline, voidableAfter`.
Observation field order: `feedId, price, validFromTimestamp, observationsTimestamp, expiresAt, reportHash, decimals`.

Amounts, quantities, **order** prices, nonces and times are integers. Amount/share atom scale is 10^6; share lot is 1,000 atoms; order price is cents 1–99. The engine caps amounts/nonces/times at 10^15, below JavaScript's exact integer bound. Reject unsafe numbers before encoding. Authenticated timestamps use UTC seconds, never milliseconds. Streams observation timestamps are `uint32`.

**Oracle prices are decimal strings**, strictly `1..3138550867693340381917894711603833208051177722232017256447` (positive `int192`) at exactly 18 decimals. No leading zero, sign, decimal point, exponent, whitespace or JSON number is accepted. For example, `"97000000000000000000000"` is $97,000 at 18 decimals. Use `BigInt`/exact decimal arithmetic in services and frontend; never convert authoritative prices through `Number`, a display-rounded string or collateral atoms. `reportHash` is a nonzero canonical lowercase `0x` bytes32.

The application digest is `SHA256(canonicalCommandJSON)`. This is not by itself an EIP-712 or wallet signature scheme. An adapter must bind this digest and the complete domain to validated wallet authorization before constructing `AuthenticatedContext`. The context (principal, timestamp and system capability) is never a client-controlled envelope field.

## Commands

Only the relevant fields below may be present/nonzero. Commands reject additional operation fields even if they are recognized envelope fields.

| Operation | Authorization | Additional fields | Accepted effect |
| --- | --- | --- | --- |
| `register` | User | `account` | Register the principal with zero funds. |
| `deposit` | Verified authority | `account, amount, evidence` | Credit a verified unique external deposit. |
| `create_round` | Verified authority | `round` | Create immutable market terms before start. Receipt returns engine round ID. |
| `open_round` | Verified authority | `roundId, evidence, registryTime, observation` | Fix opening from validated Streams boundary observation recorded by the registry inside the opening window. |
| `checkpoint` | Verified authority | None | Advance authenticated time and release expired orders. |
| `mint` | User | `account, roundId, quantity` | Lock collateral and create equal Up/Down shares. |
| `merge` | User | `account, roundId, quantity` | Burn equal unreserved Up/Down shares for one collateral unit per pair, at any time (before or after cutoff or settlement). |
| `place_order` | User | `account, roundId, outcome, side, price, quantity, tif, expiry, maxFee` | Reserve/match, then rest (`gtc`) or cancel remainder (`ioc`). |
| `cancel_order` | User | `account, orderId` | Cancel owned active remainder. |
| `cancel_all` | User | `account`, optional `roundId` | Cancel owned active orders in scope. |
| `resolve_round` | Verified authority | `roundId, evidence, registryTime, observation` | Fix Up if exact close >= exact open, otherwise Down. Any registry time at or after end; no deadline. |
| `void_round` | Verified authority | `roundId, evidence, registryTime` | Void strictly after the opening deadline (never opened) or strictly after `voidableAfter` (opened). |
| `archive_round` | Verified authority | `roundId` | Commit/archive a terminal round only after all supplies, collateral and holdings are zero. |
| `redeem` | User | `account, roundId` | Burn all owned settled shares and credit payout. |
| `request_withdrawal` | User | `account, amount, destination` | Reserve available cash as pending intent. |
| `cancel_withdrawal` | User | `account, withdrawalId` | Release an unexported intent. |
| `export_withdrawal` | Verified authority | `withdrawalId, evidence` | Produce public claim instruction and debit private custody. |
| `confirm_claim` | Verified authority | `withdrawalId, evidence` | Record verified external claim completion. |

`evidence` is exactly 64 lowercase hexadecimal characters identifying a verified canonical fact. It is deliberately not accepted as proof merely because it has the right shape. Deposit/export/claim IDs are persisted and deduplicated. Open/close feed evidence may legitimately be reused across aligned rounds, so verification and binding to each round are adapter responsibilities.

`registryTime` is required on `open_round`, `resolve_round` and `void_round` and rejected on every other command. It is the registry block timestamp (UTC seconds) that included the mirrored `recordOpening` / `resolveRound` / `voidRound`: `getRound().openedAt` for an opening, `getRound().resolvedAt` for a resolution or void. The adapter authenticates it with the rest of the chain evidence. The engine judges the round's windows at this time and only requires it not to be ahead of the authenticated context time, so an event mined inside its window stays valid however late it is processed, and the engine's own clock passing a deadline never makes a void valid.

## Round and custody binding

`Config.Oracle` field order is `chainId, registry, oracle, rulesHash, btcFeedId, ethFeedId, decimals, observationWindow, openingGrace, voidGrace, cutoffBuffer`. The feed IDs must differ and use schema 3; precision is fixed at 18. The registry oracle and collateral addresses, feeds, precision and timing parameters reproduce Solidity's exact `rulesHash` with the registry's rules version string. An adapter must authenticate those values against the actual contract and its upstream dependencies before creating engine state.

Round duration is 300 or 900 seconds; asset is `BTC` or `ETH`. Start aligns to its UTC epoch duration; creation is strictly before start. `NewRoundSpec` derives `end=start+duration`, `cutoff=end-cutoffBuffer`, `openingDeadline=start+window+openingGrace` and `voidableAfter=end+window+voidGrace`. Window is at most 60; opening grace is positive; void grace is 120–1,814,400 seconds (2 minutes to 21 days, the registry `initialize` bound; the planned mainnet profile uses 300, so `voidableAfter` is end + 360 s there); window+openingGrace is strictly less than 300-cutoffBuffer. End+window must fit `uint32`. Supplied round fields must exactly match this derivation. `create_round` is the one registry-related command judged on the engine's own authenticated time: processed at or after `start` it rejects for good, and that round then never exists in the engine. Terms and IDs are deterministic, so an adapter creates each engine round well ahead of its start, together with its registry round, instead of waiting to mirror a `RoundCreated` event that may be mined in the last second. An engine round whose registry round was never created cannot be opened, voided from a recorded event or archived, and keeps one of the 128 round slots.

Observations require the configured feed, valid positive int192 price, precision 18, nonzero report hash and `0 < validFrom <= boundary <= observed <= boundary+window`, `observed <= registryTime`, `expiresAt >= observed`. **Arrival after expiry remains valid** when Base authenticated the report before expiry; this engine does not repeat source verification. The registry's opening window still applies at `registryTime` (`start..openingDeadline`, inclusive); resolution is accepted at any `registryTime >= end`. Missing opening may void strictly after opening deadline; an opened round may void strictly after `voidableAfter`, and on chain only while the price cache holds no closing observation (the engine cannot see the cache and accepts any void after `voidableAfter`, so an adapter mirrors a void only once the registry has recorded it: a `RoundVoided` event or `getRound().outcome == Void`, never its own clock or an earlier `phase() == Voidable` read, because the closing price can still arrive and resolve the round). **Accepted risk (owner decision 2026-10-06, audit finding D4):** anyone can block Base-to-Horizen price delivery by pumping Horizen's deposit fee on Base, at about 0.03–0.05 ETH for a few minutes and about 0.4 ETH per hour at 2026-10-05 Base fees. With the 5-minute grace, a trader on the losing side with more than roughly that amount at stake can profit by forcing the void, and the winners then receive half of what they were owed. Per-round stake limits (or a test-only launch) are needed before real money; they are not built (see `contracts/README.md`). A public price ticker cannot substitute for these authenticated observations.

The engine round ID hashes `{config, round}` with SHA-256 (64 lowercase hex characters, no `0x`). The required `registryRoundId` is independently computed as `keccak256(abi.encode(registryChainId, registryAddress, rulesHash, assetEnum, duration, start))`, with Solidity widths and BTC=0/ETH=1 (canonical `0x` bytes32). The entire registry policy and this ID are committed in the engine identity. Never treat one hash format as the other. Recomputing IDs proves consistency, not the authenticity or finality of a submitted chain fact.

Collateral is one pinned six-decimal token. `custody` equals user available/reserved cash + round collateral + private fees + pending withdrawal intents. `deposited = custody + claimable + paidOut`. The adapter must reconcile these values against matching canonical contract state and handle pending, unprocessed chain deposits separately. Export and public custody movement must be atomically accepted; retries with unchanged state sequence must never re-emit effects.

## Terminal-round archives and capacity

`archive_round` emits `receipt.archive` in field order `{count, previousRoot, round, hash}`. `hash = SHA256(canonicalJSON({domain:"ZEDGE_ROUND_ARCHIVE_V3", count, previousRoot, round}))`; the initial root is `SHA256("ZEDGE_ARCHIVES_V3")`. State commits `archivedRounds` and `archiveRoot`. The receipt's full round must be stored atomically with that accepted state. The hash chain detects substituted history when checked against an authenticated root; it neither stores the history nor guarantees its availability.

Only resolved/void rounds with zero Up and Down supplies, locked collateral, holdings and reservations can be archived. Zero holdings and the round are then removed; cash, fees and account nonces remain. This reuses the 128 retained-round slots. Exact nonce retry repeats the same receipt with unchanged state, so archive writes must be idempotent. Recreating a past schedule rejects under monotonic authenticated time and future-only round creation.

The engine still caps registered accounts at 256, consumed external evidence at 4,096 and lifetime deposited atoms at 10^15. Those entries are not pruned: removing accounts/evidence would reopen nonce or deposit/claim replay. A reviewed authenticated migration or persistent nullifier/membership-proof system remains necessary before these limits. Unredeemed shares can also keep a terminal round retained. Neither larger constants nor a backup of an unauthenticated snapshot solves these limits.

## Confidential outputs

`State` and full `Receipt` are internal confidential objects. Use `AccountView` and `ProjectReceipt` to form authorized personal outputs. These projections remove counterparties and unrelated orders; they do not encrypt, authenticate a requester, hide event metadata or prevent inference. System exports intentionally reveal destination/token/amount through the public withdrawal path. No public depth/tape projection is implemented in this core.

Adapter acceptance checklist: authenticated principal; fresh authenticated time with commitment freshness; canonical state/rollback protection; unique deposits; verified signed Streams observations and chain/registry binding; `open_round`, `resolve_round` and `void_round` sent only for an event the registry has already recorded, with that block's time as `registryTime` (a void only from `RoundVoided` or `getRound().outcome == Void`); every engine round created before its start alongside its registry round; exact-once public effects and archive persistence; encrypted/padded personal output; no raw state/receipt logging; independent audit and capacity/recovery plan. A missing required verifier is an unavailable operation, not an option to trust user input. Native Go/WASM output equality does not establish TEE confidentiality or production Vela availability.
