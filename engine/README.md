# ZEDGE deterministic exchange core

Original Go implementation with pinned `golang.org/x/crypto v0.54.0` and `golang.org/x/sys v0.47.0` for Ethereum-compatible Keccak. It implements a funded two-sided binary-share exchange ledger. It is **bounded software, not an independently audited production exchange**, an oracle signature verifier, custody contract or privacy system.

Engine/protocol version **2** uses exact 18-decimal Streams observations. Version-1 snapshots and command domains reject; no legacy price is silently rescaled. Existing state needs a separately reviewed, authenticated migration before adoption. Matching, collateral atoms and fee units are unchanged.

## API

```go
state, err := engine.New(config)
next, receipt, err := engine.Apply(state, command, verifiedContext)
snapshot, err := engine.Encode(next)
restored, err := engine.Decode(snapshot)
view, err := engine.AccountView(next, authenticatedAccount)
privateReceipt, relevant := engine.ProjectReceipt(receipt, authenticatedAccount)
spec, err := engine.NewRoundSpec(config, "BTC", 300, alignedStart)
registryID, err := engine.RegistryRoundID(config, "BTC", 300, alignedStart)
```

`Apply` clones the input and checks accounting invariants before and after execution. Rejected commands never mutate it. The same canonical state, command and authenticated context produce identical state bytes, journal hash and receipt. There is no network, random source, wall clock, floating-point accounting or Vela dependency.

The context type is a trust boundary, **not authentication**. Only an adapter that has verified the sender, deployment domain and fresh canonical execution/commit time may construct it. Setting `System: true` does not verify a trigger or oracle. A user must never supply or override this struct. If an adapter cannot establish these facts, it must reject the mutation. The current Vela ABI gaps must not be papered over with the browser time or an unverified manager timestamp.

## Implemented behavior

- Registration, evidence-deduplicated deposits, funded complete-set mint and merge.
- Separate Up and Down buy/sell books; strict price-time priority; resting maker price; partial fills.
- Limit GTC and price-protected IOC orders. No synthetic counterparty, unbacked shares, leverage or naked selling.
- Reservations for worst-case buy cash plus fees and sell inventory; cancellation, cancel-all, expiry and round cutoff release.
- Self-trade prevention cancels the incoming order's remainder when the best eligible maker belongs to that account. Earlier matches against other traders remain valid; that maker stays on the book.
- Immutable BTC/ETH 300/900-second rounds; exact signed `int192` price values as decimal text at 18 decimals; signed validity intervals, observation windows and deadlines; Up on a tie; timeout void paying half of each outcome.
- Winner redemption burns both owned outcome balances and pays only the winner; void burns both and pays half. Complete sets remain fully backed.
- Withdraw intent → export to public claim → externally verified claim confirmation. Pending intents may be cancelled; exported claims may not.
- Sequential user/authority nonces, latest-command exact retries, domain separation, persisted external-evidence deduplication.
- Canonical JSON snapshots, SHA-256 snapshot/round/command digests and a deterministic hash-chained journal tip.
- Independent ABI/Keccak reproduction of the public Streams registry rules hash and round IDs, including chain, endpoints, feeds, precision, collateral and timing policy.
- Archival of fully redeemed terminal rounds, with a committed archive hash chain, zero-holding removal and no reuse of past round schedules.
- Account and receipt projections exclude counterparties and unrelated account details.

## Units and fees

One collateral unit and one whole share both have 1,000,000 atoms. One share lot is 1,000 atoms. Prices are integer cents 1–99, yielding exact integer notional `shareAtoms / 100 * priceCents`. The collateral must be independently verified to use six decimals; the core does not interrogate token contracts.

The configured 0–1,000 basis-point fee is charged to **both** buyer and seller. Per-order total fees are `ceil(cumulativeFilledNotional * feeBps / 10,000)`; each fill charges the difference from the prior cumulative fee. Buy reservations include worst-price notional and remaining cumulative fee. Sell fees are deducted from proceeds. A sell can execute above its limit, increasing its absolute fee: callers should authorize the documented worst case up to 99¢ or accept an atomic `execution fee cap exceeded` rejection. Fees stay in the private ledger; this version has no fee treasury withdrawal command. Platform gas/fuel fees are outside this ledger.

## Oracle policy

`Config.Oracle` pins the registry chain/address, oracle address, rules hash, BTC/ETH schema-v3 feed IDs, fixed precision 18 and timing parameters. The engine reproduces the deployed `StreamsRoundRegistry` rules hash from the exact Solidity ABI/version string and derives every round field. Altering a copied round ID, feed, schedule or deadline rejects. This proves internal consistency; the adapter must authenticate the real deployment, code, immutable getters, provider and bridge state.

Open/resolve commands carry `observation: { feedId, price, validFromTimestamp, observationsTimestamp, expiresAt, reportHash, decimals }`. Price is a canonical decimal **string**, strictly positive and at most `2^191-1`; JSON numbers, signs, leading zeroes, exponent notation and fractions reject. Prices never pass through `uint64`, `float64`, JavaScript `Number`, collateral-scale conversion or rounding. An 18-decimal atom changes the outcome. Client display formatting must preserve the original string for comparison and submission.

The signed interval must contain the fixed boundary: `0 < validFrom <= boundary <= observed <= boundary + observationWindow`; observed must not be in the future and expiry must be at least observed. The feed must equal the round's configured feed. The adapter must establish actual DON verification, authenticity of the committed Base observation, native-message sender/route, and canonical/finality policy. Hash-shaped strings and `System: true` do not establish these facts.

The engine does **not** reapply `arrivalTime <= expiresAt`. Base verifies the report before expiry; an authenticated cached observation may arrive later. Registry opening/resolution deadlines remain binding. This is Streams signed-window selection, not the former Pyth predecessor/first-update API.

Opening proof is accepted from `start` through `openingDeadline`, inclusive. That deadline is before the cutoff. Closing proof is accepted from `end` through `resolutionDeadline`, inclusive. Void is allowed strictly after the opening deadline if no opening was recorded; otherwise strictly after the resolution deadline. All times are trusted integer UTC seconds. Orders cannot match at or after cutoff, even if an old order would have crossed. All state transitions sweep expired orders. Expiration becomes visible only when a transition is accepted; the adapter still needs a reliable checkpoint scheduler.

The registry's `0x`-prefixed Keccak round ID and this engine's unprefixed SHA-256 `RoundID` remain different domains. The engine recomputes the registry ID and includes it and the complete oracle configuration in its own round commitment. Adapters must still authenticate the external chain evidence; never interchange the two IDs.

## Retry, effects and recovery

For each principal, the next new nonce must be exactly the prior accepted nonce plus one. The command ID is `lowercaseAddress:decimalNonce`. Only the latest accepted command can be retried to return its original receipt without a state change. Conflicting reuse and older nonces reject. Rejected commands do not consume a nonce. Authority commands use their own global ordered stream; the configured authority cannot register as a trader.

**A retry returns the original receipt, including any public withdrawal description. The adapter must compare input/output sequence and suppress every repeated external effect when they are equal.** It must persist state, receipt and effect idempotency keys atomically with canonical commitment. Exporting a withdrawal is only an instruction: the matching public custody debit/claim credit must occur in the same accepted external transition. A submitted transaction is not a confirmed claim.

`ExternalEvidence` consumes canonical unique source IDs for deposit, export and claim confirmation. The adapter must bind those IDs to verified chain events and their amounts/beneficiaries. For example, a deposit identifier should bind chain, endpoint, application, transaction hash and log index. Inventing a fresh hash for a repeated deposit bypasses the intent of this check. A claim observation must refer to this exact exported claim; a token transfer or pooled `PaymentWithdrawn` event without reliable allocation is insufficient.

The journal retains its authenticated tip, not a full durable event log. The adapter must durably retain canonical commands, verified contexts, confidential receipts and accepted snapshot commitments for replay/recovery. Snapshot validation detects internal inconsistencies; **it cannot establish that a snapshot is genuine or current**. The adapter must authenticate its prior canonical root, detect rollback and handle reorgs before passing state to `Apply`.

## Capacity and deployment limits

Work and state are deliberately bounded: 256 registered accounts, 128 retained rounds, 1,024 active orders, 64 fills per request, 256 pending/exported withdrawals, 4,096 consumed external evidence IDs, 8 MiB canonical snapshot. Total lifetime deposits are capped at 10^15 atoms; sequence/nonce/time also stay within 10^15 to remain exactly representable in JSON consumers. Schema-v3 observation timestamps are additionally bounded to `uint32`. Closed orders/withdrawals are removed. Reaching any bound rejects atomically.

`archive_round` is an authority operation for a resolved/void round with **zero** locked collateral, Up/Down supply, holdings and reservations. The receipt contains the complete terminal round, archive ordinal, prior root and digest; `ArchiveDigest` reproduces it. State commits `archiveRoot` and `archivedRounds` and removes that round and its zero holdings. The adapter must atomically retain this receipt with the new canonical state; history cannot be reconstructed from the root alone. Exact command retry returns the same record without advancing the archive counter. Recreating an archived schedule rejects because creation requires a future start and authenticated time cannot move backward. Unredeemed winners **and losers** must burn their remaining shares before a round can be archived.

Round slots can therefore be reused beyond 128 lifetime rounds. Registered accounts and external evidence remain retained: deleting them would reset nonces or permit duplicate deposit/claim credit. Continuous operation beyond **256 accounts, 4,096 external evidence facts or 10^15 lifetime deposit atoms** still requires a reviewed authenticated migration or persistent membership/nullifier-proof design. These are remaining implementation limits, not limits solved by round archival. No limit has been silently raised.

These are engineering limits, not measured throughput or production capacity claims. Raising constants alone is not a scaling plan: validation scans the bounded ledger, snapshot serialization copies it, and matching plus Keccak policy checks must be benchmarked under the actual enclave runtime.

No forced withdrawal, operator-failure recovery, chain proof verification, signatures, key recovery, encryption, authenticated WebSocket service, fair ordering proof or attestation is provided by the engine. Account/receipt projections must still be authorized, encrypted and padded by a reviewed adapter. Internal `State` and `Receipt` contain participant identities; never log or publicly emit them.

## Verification

```sh
go test ./...
go test -race ./...
go vet ./...
go test -run '^$' -fuzz FuzzCommandSequences -fuzztime 30s
go test -run '^$' -fuzz FuzzSnapshotDecoder -fuzztime 30s
go test -run '^$' -fuzz FuzzExactOraclePriceComparison -fuzztime 30s
```

Tests cover funding conservation, fee fragmentation, matching, reservations, settlement/void, replay, withdrawal stages, canonical parsing, privacy projection and bounded matching work. Additional regressions cover deployed rules-hash and independent ABI round-ID vectors, all four BTC/ETH schedules, signed validity/expiry distinctions, cross-feed rejection, one-atom outcomes, positive-int192 boundaries, exact JSON/snapshot persistence, archive replay and slot reuse. Fuzz targets check command sequences, snapshots and price comparisons against arbitrary-precision reference arithmetic. The local EVM harness exercises the real Streams registry with explicitly unsigned oracle fixtures; native/TinyGo equality is a separate runtime check, not TEE confidentiality. These checks are not an independent audit.

Verification on 2026-10-04: race tests and `go vet` passed; engine statement coverage was 82.8%. The exact-price differential fuzzer ran about 1.97 million cases in 20 seconds; command-sequence fuzzing ran 4,736 cases in 21 seconds. All four local Streams-registry scenarios produced identical native Go 1.27.1 and TinyGo 0.39.0 / Go 1.25.14 / Binaryen 133 results. This is bounded test evidence, not sustained-load or enclave deployment evidence.

`govulncheck` with Go 1.27.1 found **zero reachable vulnerabilities and zero vulnerabilities in imported packages**, but reported four advisories elsewhere in the required `x/crypto v0.54.0` module: unused SSH packages [GO-2026-6355](https://pkg.go.dev/vuln/GO-2026-6355), [GO-2026-6354](https://pkg.go.dev/vuln/GO-2026-6354), [GO-2026-6303](https://pkg.go.dev/vuln/GO-2026-6303), and unused/unmaintained OpenPGP [GO-2026-5932](https://pkg.go.dev/vuln/GO-2026-5932). The engine imports `sha3`, not SSH or OpenPGP. The current patched `x/crypto v0.56.0` requires Go 1.26; this engine retains the exact v0.54.0 pin for the tested Vela-compatible Go 1.25.14 TinyGo toolchain. Reassess the pin when the supported compiler changes; a passing reachable-symbol scan is not a claim that every package in the dependency module is vulnerability-free.
