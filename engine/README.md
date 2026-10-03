# ZEDGE deterministic exchange core

Original Go implementation; standard-library dependencies only. It implements an actual funded two-sided binary-share exchange ledger. It is **bounded evaluation software, not an audited production exchange**, an oracle verifier, custody contract or privacy system.

## API

```go
state, err := engine.New(config)
next, receipt, err := engine.Apply(state, command, verifiedContext)
snapshot, err := engine.Encode(next)
restored, err := engine.Decode(snapshot)
view, err := engine.AccountView(next, authenticatedAccount)
privateReceipt, relevant := engine.ProjectReceipt(receipt, authenticatedAccount)
```

`Apply` clones the input and checks accounting invariants before and after execution. Rejected commands never mutate it. The same canonical state, command and authenticated context produce identical state bytes, journal hash and receipt. There is no network, random source, wall clock, floating-point accounting or Vela dependency.

The context type is a trust boundary, **not authentication**. Only an adapter that has verified the sender, deployment domain and fresh canonical execution/commit time may construct it. Setting `System: true` does not verify a trigger or oracle. A user must never supply or override this struct. If an adapter cannot establish these facts, it must reject the mutation. The current Vela ABI gaps must not be papered over with the browser time or an unverified manager timestamp.

## Implemented behavior

- Registration, evidence-deduplicated deposits, funded complete-set mint and merge.
- Separate Up and Down buy/sell books; strict price-time priority; resting maker price; partial fills.
- Limit GTC and price-protected IOC orders. No synthetic counterparty, unbacked shares, leverage or naked selling.
- Reservations for worst-case buy cash plus fees and sell inventory; cancellation, cancel-all, expiry and round cutoff release.
- Self-trade prevention cancels the incoming order's remainder when the best eligible maker belongs to that account. Earlier matches against other traders remain valid; that maker stays on the book.
- Immutable BTC/ETH 300/900-second rounds; explicit opening/closing observation windows and deadlines; Up on a tie; timeout void paying half of each outcome.
- Winner redemption burns both owned outcome balances and pays only the winner; void burns both and pays half. Complete sets remain fully backed.
- Withdraw intent → export to public claim → externally verified claim confirmation. Pending intents may be cancelled; exported claims may not.
- Sequential user/authority nonces, latest-command exact retries, domain separation, persisted external-evidence deduplication.
- Canonical JSON snapshots, SHA-256 snapshot/round/command digests and a deterministic hash-chained journal tip.
- Account and receipt projections exclude counterparties and unrelated account details.

## Units and fees

One collateral unit and one whole share both have 1,000,000 atoms. One share lot is 1,000 atoms. Prices are integer cents 1–99, yielding exact integer notional `shareAtoms / 100 * priceCents`. The collateral must be independently verified to use six decimals; the core does not interrogate token contracts.

The configured 0–1,000 basis-point fee is charged to **both** buyer and seller. Per-order total fees are `ceil(cumulativeFilledNotional * feeBps / 10,000)`; each fill charges the difference from the prior cumulative fee. Buy reservations include worst-price notional and remaining cumulative fee. Sell fees are deducted from proceeds. A sell can execute above its limit, increasing its absolute fee: callers should authorize the documented worst case up to 99¢ or accept an atomic `execution fee cap exceeded` rejection. Fees stay in the private ledger; this version has no fee treasury withdrawal command. Platform gas/fuel fees are outside this ledger.

## Oracle policy

The configured feed's **first unique canonical observation** in `[boundary, boundary + observationWindow]` is required, with a consistent integer price scale for opening and close. This engine checks numeric/timing rules and records evidence hashes; the adapter must verify the actual feed, signed observation, uniqueness, first-update selection and finality. A hash-shaped string is not proof.

Opening proof is accepted from `start` through `openingDeadline`, inclusive. That deadline is before the cutoff. Closing proof is accepted from `end` through `resolutionDeadline`, inclusive. Void is allowed strictly after the opening deadline if no opening was recorded; otherwise strictly after the resolution deadline. All times are trusted integer UTC seconds. Orders cannot match at or after cutoff, even if an old order would have crossed. All state transitions sweep expired orders. Expiration becomes visible only when a transition is accepted; the adapter still needs a reliable checkpoint scheduler.

The registry's Keccak round ID and this engine's SHA-256 `RoundID` are different domains. An adapter must explicitly bind and verify the registry address/chain/rules/round ID and all corresponding engine metadata. Never interchange those IDs.

## Retry, effects and recovery

For each principal, the next new nonce must be exactly the prior accepted nonce plus one. The command ID is `lowercaseAddress:decimalNonce`. Only the latest accepted command can be retried to return its original receipt without a state change. Conflicting reuse and older nonces reject. Rejected commands do not consume a nonce. Authority commands use their own global ordered stream; the configured authority cannot register as a trader.

**A retry returns the original receipt, including any public withdrawal description. The adapter must compare input/output sequence and suppress every repeated external effect when they are equal.** It must persist state, receipt and effect idempotency keys atomically with canonical commitment. Exporting a withdrawal is only an instruction: the matching public custody debit/claim credit must occur in the same accepted external transition. A submitted transaction is not a confirmed claim.

`ExternalEvidence` consumes canonical unique source IDs for deposit, export and claim confirmation. The adapter must bind those IDs to verified chain events and their amounts/beneficiaries. For example, a deposit identifier should bind chain, endpoint, application, transaction hash and log index. Inventing a fresh hash for a repeated deposit bypasses the intent of this check. A claim observation must refer to this exact exported claim; a token transfer or pooled `PaymentWithdrawn` event without reliable allocation is insufficient.

The journal retains its authenticated tip, not a full durable event log. The adapter must durably retain canonical commands, verified contexts, confidential receipts and accepted snapshot commitments for replay/recovery. Snapshot validation detects internal inconsistencies; **it cannot establish that a snapshot is genuine or current**. The adapter must authenticate its prior canonical root, detect rollback and handle reorgs before passing state to `Apply`.

## Capacity and deployment limits

Work and state are deliberately bounded: 256 accounts, 128 lifetime rounds, 1,024 active orders, 64 fills per request, 256 pending/exported withdrawals, 4,096 consumed external evidence IDs, 8 MiB canonical snapshot. Total lifetime deposits are capped at 10^15 atoms; sequence/nonce/time also stay within 10^15 to remain exactly representable in JSON consumers. Closed orders/withdrawals are removed; historical rounds/evidence are retained to prevent replay. Reaching a bound rejects atomically.

These are engineering evaluation limits, not measured throughput or recommended production parameters. **Continuous operation requires a reviewed archival/migration/replay design before these limits are reached.** Raising constants alone is not a production scaling plan: validation scans the bounded ledger, snapshot serialization copies it, and matching must be benchmarked under the actual enclave runtime.

No forced withdrawal, operator-failure recovery, chain proof verification, signatures, key recovery, encryption, authenticated WebSocket service, fair ordering proof, oracle integration or attestation is claimed. Account/receipt projections must still be authorized, encrypted and padded by an audited adapter. Internal `State` and `Receipt` contain all participant identities; never log or publicly emit them.

## Verification

```sh
go test ./...
go test -race ./...
go vet ./...
go test -run '^$' -fuzz FuzzCommandSequences -fuzztime 30s
go test -run '^$' -fuzz FuzzSnapshotDecoder -fuzztime 30s
```

Tests cover funding conservation, exact fee fragmentation, maker price/time priority, partial fills, IOC/slippage protection, self-trade prevention, cancellation/expiry, settlement/void, replay, trusted-input rejection, withdrawal stages, canonical parsing, privacy projection, arithmetic bounds and atomic matching work limits. Fuzz targets check arbitrary command sequences and untrusted snapshots. These checks are not an independent audit.
