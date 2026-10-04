# Streams and native-routing review

Scope: `ChainlinkStreamsBoundaryOracle`, `BaseStreamsPublisher`, `HorizenStreamsOracle`, `StreamsRoundRegistry`, their interfaces and route library. Reviewed 2026-10-04. This records implementation review and automated evidence; it is **not an independent security audit**, a custody implementation, or approval to launch a funded exchange.

## Financial and authentication invariants

- Only the official configured verifier authenticates DON reports. Unsigned report decoding, an operator signature and a recent chart price cannot substitute for verification. BTC/ETH feed IDs and precision are immutable.
- The report's signed interval must contain the fixed boundary; the observation cannot exceed the allowed delay or the source-chain clock. Source verification rejects expired reports. Prices remain positive exact `int192` values; bid/ask are not treated as confidence intervals. A one-atom decline at 18 decimals resolves Down.
- A native delivery must come from the pinned destination messenger, report the pinned Base publisher as its cross-domain sender and carry the exact route hash. That hash binds both chains, both messengers, source adapter, publisher, receiver, feeds, precision, observation window and minimum delivery gas.
- Source observations and destination cache entries cannot be overwritten with conflicting content. Exact duplicate delivery is idempotent. Permissionless resending uses the already authenticated source observation. An external source-send failure rolls back source storage.
- An arrival after report expiry does not imply new signature verification: Base performed verification before expiry. The registry independently enforces opening/closing submission deadlines. Neither delayed messages nor retries extend a round or rewrite a terminal result.
- Only future aligned 300/900-second rounds may be scheduled, and both boundaries must fit schema-v3 timestamps. Opening deadline remains before cutoff. Equal closing/opening resolves Up; a timeout resolves half to each outcome. Pending payouts have denominator zero. These are ratios, not token transfers or a dollar-peg promise.
- All new application contracts lack admin/upgrades and asset-transfer methods. External oracle, bridge and collateral dependencies retain their own governance and must be checked independently.

## Tests and explicit limits

The local suites cover invalid feeds/schema/precision, malformed and oversized evidence, wrong/future/expired windows, price sign/range, caller forgery, route/chain/counterpart mismatch, duplicates/conflicts, retry after destination failure, atomic source-send failure, reentrancy, exact cutoff/deadline equality, terminal immutability and exact-price outcome comparison. Stateful registry invariants check payout conservation, immutable opening/terminal states and trading gates. The full offline run passed 106 tests, with six adapter fork tests explicitly skipped; the subsequently added native fork case also skips without the required fork. CI uses 4,096 fuzz runs and 512 invariant runs at depth 256.

`ChainlinkStreamsBoundaryOracle.fork.t.sol` separately verifies genuine public BTC and ETH reports against the official Base verifier at block 52,156,042. Six tests passed: exact values authenticate; altered price/signatures, wrong feeds/boundaries and expired reports reject. Fixtures include their public transaction provenance. Those report times are not aligned market boundaries, so this is not evidence of an operated five-minute round. Fork tests are opt-in and explicitly skipped during offline tests; a skipped test is not reported as a passed network integration.

All seven real-fork checks passed: six adapter checks and one native-routing scenario. The latter exercises actual messenger implementations in isolated forks. Foundry 1.7.1 panics in its mixed-OP-fork fee executor; this scenario was run successfully with checksum-verified official Forge 1.4.4 using separate temporary output/cache directories. Production compilation remains Solidity 0.8.30 targeting Paris. A locally impersonated deposit alias models OP derivation; such a test cannot establish live delivery latency, reorg finality or ongoing report availability. Actual publication and destination receipts are separate evidence, recorded in the [mainnet deployment record](deployment/MAINNET.md#verification-and-smoke-status).

The two Node signing/receipt regression suites passed **34 tests**: 30 deployment/recovery tests and four smoke-receipt tests. They cover independently reconstructed constructors; mutually consistent tampered arguments, creation data and hashes; nonce/address/deployer mismatches; five-minute first-signing and fifteen-minute deployment-run boundaries; frozen-plan recovery; conservative recovered fee bounds; and canonical receipt identity, confirmation count, block hashes/numbers, transaction fields and fee caps. Zero, absent and conflicting block hashes reject. These tests use public fixtures and mocked readers: they do not load signing keys, sign transactions or establish live RPC correctness. Both suites run in CI, separately from the Solidity counts above.

## Static analysis dispositions

Slither 0.11.5 ran all 101 default detectors across the six production contracts and dependencies, filtering test/script/vendor findings. The reviewed `--fail-medium` run passed with **17 Low timestamp findings** and **one Low benign-reentrancy finding**. The original Pyth contracts remain included in these counts.

- Timestamp comparisons are deliberate expiry, deadline and scheduling rules. They retain chain/sequencer clock and inclusion assumptions; they do not prove private order admission time.
- The publisher writes an authenticated observation after its oracle call. Both publisher mutation methods have OpenZeppelin `nonReentrant`; the regression test attempts both reentrant publish and resend and checks the exact guard error. State remains unchanged by nested attempts. The Low finding remains visible.
- Slither marked exact zero hash/epoch sentinels and fixed decimal-unit matching in `StreamsRoundRegistry._verify` as Medium strict-equality risks because its timestamp argument taints the whole returned observation. A second reviewer confirmed these are required identity/missing-data checks, not equality against a changing timestamp. One narrowly placed `incorrect-equality` annotation covers only that condition. All validation remains enforced, with negative regression cases. The detector is not globally disabled; raw findings were retained locally before annotation.
- A branch-local precision variable was replaced by an explicit feed-lookup helper after Slither's uninitialized-local warning. Unsupported feeds revert; no default precision is assumed.

## Deployment and operation requirements

### Mainnet deployment evidence

All four reviewed contracts are now deployed: `ChainlinkStreamsBoundaryOracle` and `BaseStreamsPublisher` on Base (8453), and `HorizenStreamsOracle` and `StreamsRoundRegistry` on Horizen (26514). The four-contract live check recorded at `2026-10-04T09:06:31.204Z` compared successful canonical creation receipts, sender/nonces, exact creation inputs, runtime code hashes, version markers, immutable configuration, route/rules hashes and upstream proxy bindings. The deployed runtime hashes matched the simulated artifacts. Canonical receipt recovery checked transaction/receipt/header agreement and at least two confirmations. Addresses, transactions, blocks, full fingerprints, build settings and source-verification results are published in [MAINNET.md](deployment/MAINNET.md#confirmed-deployments).

These are deployment consistency checks. Two confirmations do not establish rollup finality. Explorer acceptance does not add an audit: Base reported successful source verification; Horizen reported verification success while its API classified the contracts as partially verified. The deployment record retains that distinction instead of treating partial verification as a full/perfect match.

### Receipt-provider failure and recovery

During deployment, PublicNode restricted the first adapter's receipt lookup even though the creation succeeded. A later Base publisher receipt response contained an all-zero block hash despite the transaction being included. The run retained its deterministic transaction hashes and original plan. Recovery used official Base transaction, receipt and header reads to establish the canonical records; the anomalous response and correction were preserved locally. Existing transactions were inspected, not resubmitted.

The deployment and smoke broadcasters now treat `waitForTransactionReceipt` as a notification to verify, not sufficient confirmation. They require nonzero matching receipt/transaction/header hashes, matching block numbers, at least two confirmations, the exact sender/nonce/chain/value/input and gas/fee fields, and the expected created address/runtime for deployments. New confirmation paths retry incomplete zero-hash reads within a bounded wait; unresolved or mismatched evidence stops without resending. Recovery validates the exact checkpoint/plan hash and ordered intent prefix, preserves the original nonces, addresses and fifteen-minute run start, and cannot silently create a replacement plan.

Both broadcasters persist the deterministic public transaction hash before their sole submission attempt, use exclusive checkpoints, and suppress raw signing/provider exceptions. Per-transaction conservative fee bounds are saved before sending; recovery preserves the greatest recorded, planned or historical estimate. Rollup data/operator fee estimates and buffers are not an enforceable total-fee cap. The smoke publisher is separately single-use, binds the reviewed public BTC payload and exact destination calldata, and requires a fresh five-minute unsigned plan. Neither broadcaster's receipt status proves native-message delivery; authenticated destination cache evidence is checked separately.

Check the exact runtime and resolved implementation of the Chainlink verifier route, Base AddressManager messenger proxy, portal, Horizen messenger and legacy USDC.e proxy. Their runtime proxy hashes alone do not establish implementation identity. Record current owners/configuration; these are snapshots, not promises against future upgrades.

Publisher/receiver constructors bind their own predicted addresses and the peer endpoint. Freeze and recheck each chain's deployer nonce before every broadcast. Do not recover from a nonce mismatch by silently constructing different addresses. Simulate all four exact constructors on isolated mainnet forks, then compare real receipt addresses, runtime fingerprints and every immutable binding.

Opening on Horizen requires a transaction to record the cached observation after message delivery; cache arrival alone does not start trading. The 210-second opening deadline therefore budgets report delivery, Base inclusion, native derivation and the subsequent Horizen transaction. One observed native bridge transfer took 23 seconds, which is not an operational SLA. Monitor failed native messages and keep permissionless retries available.

The genuine BTC smoke fixture uses an already-public report at an unaligned historical second. Its actual publication/delivery status and receipts belong in [MAINNET.md](deployment/MAINNET.md#verification-and-smoke-status). Even successful delivery would establish only that report's public route, not an aligned 5m/15m round, ongoing fresh-report access, funded trading or privacy.

Before exchange launch, the following work remains:

- A paid subscription and keepers for fresh reports.
- Reorg handling and a finality policy.
- Engine and frontend integration for exact 18-decimal prices.
- Confidential admission, collateral custody, redemption and recovery.
- Operational testing and an independent audit.

Deploying these public noncustodial contracts does not complete those components.
