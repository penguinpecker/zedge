# Contract self-review and validation record

Reviewed 2026-10-04. This is an implementation self-review, internal peer review and automated test record, **not an independent security audit** or approval for real funds. Current source scope includes both Pyth contracts, the four Streams/native-route contracts, the public outcome vault, their interfaces and deployment helpers. External verifier/bridge/token implementations and Vela are dependencies, not contracts audited by this review. See the [whole-system review](../security/WHOLE-SYSTEM-REVIEW.md) for integration boundaries.

**Update 2026-10-05.** The Streams round registry deployed on 2026-10-04 is retired and replaced in source by an upgradeable registry with late resolution and a stricter void rule; the replacement is not deployed. Details and evidence are in [STREAMS-SECURITY-REVIEW.md](STREAMS-SECURITY-REVIEW.md#registry-replacement-2026-10-05). Where this record differs, the following supersedes it:

- Current suite: **152 passed, zero failed, eight skipped** across 14 suites / 160 entries; 13 fuzz functions; six stateful invariants. Slither 0.11.5 analysed 77 contracts/interfaces with the isolated build below (57 with the CI command, same findings): 18 Low (17 `timestamp`, one `reentrancy-benign`), two Informational on the registry's storage gap, zero Medium/High.
- "Immutable outcomes" below holds for the Pyth registry. In the Streams registry a recorded result is one-way under the current implementation, but its owner can replace the implementation, so that property now depends on the owner key. Resolution no longer has a deadline, and an opened round can be voided only after the void grace and only without a cached closing price.
- "Deployed artifact preservation" now covers the three live contracts (adapter, publisher, price cache): their sources, creation bytecode and metadata are unchanged. The registry artifact intentionally no longer matches the retired deployment.
- The public vault accepts only the new registry's version marker; its 24 tests and invariant pass against the proxied registry.

Four noncustodial contracts have been deployed on Base/Horizen using funded public transactions; a genuine historical BTC report also completed the native delivery route. Their addresses, canonical receipts, runtime/configuration checks, source-verification caveats and exact smoke scope are recorded in [MAINNET.md](deployment/MAINNET.md). The Pyth foundation remains undeployed. `CollateralizedOutcomeVault` is implemented and tested but remains **undeployed at this review**; it provides public claims, not private exchange custody.

## Current verification evidence

| Check | Observed result |
| --- | --- |
| Compiler / format | Solidity 0.8.30, optimizer 200, Paris EVM, metadata bytecode hash `none`; build and full `forge fmt --check` pass. |
| Full CI-profile Solidity suite | **131 passed, zero failed, seven skipped** across 12 suites / 138 entries. The skipped entries are the optional six Base-verifier fork tests and one two-chain native-route fork test; this run did not access RPC. |
| Fuzz tests | 12 fuzz functions each ran 4,096 cases: 49,152 cases total. This includes exact positive int192 prices, signed windows, route domains, schedules and arbitrary split/settle/merge accounting. |
| Stateful invariants | Five invariants each passed 512 runs × 256 calls = 131,072 reported handler calls, zero handler reverts. Aggregate reported calls are 655,360; separate invariant functions can reuse the same generated sequences, so this is not a claim of that many distinct scenarios. |
| Public vault subset | 24 unit/fuzz tests plus one stateful invariant passed. Covered exact funding, winner/void liabilities, transfers, arbitrary pair merges/redemption order, capacity boundaries, malicious transfer behavior and ERC20/ERC1155 callback reentrancy. |
| Slither 0.11.5, all production sources | All 101 detectors analyzed 61 contracts/interfaces in the compilation closure. With test/script/dependency findings filtered, **18 Low findings: 17 `timestamp`, one `reentrancy-benign`; zero Medium/High**. `--fail-medium` passed. No detector was disabled. |
| Focused vault Slither | All 101 detectors, 28-contract dependency closure; findings scoped to the new vault: zero High/Medium/Low and one informational mixed dependency-pragma finding. Compiler version is pinned. |
| ABI drift | All ten exported `abi/*.json` files exactly match the corresponding compiled ABI. The exporter includes the vault and settlement interface. |
| Deployed artifact preservation | All four deployed contracts' current creation-bytecode hashes still match the original deployment plan; Paris settings are preserved. The new ERC1155 dependency does not alter their sources or dependency closure. |
| npm dependency audit | `npm audit --omit=dev --json` reports zero vulnerabilities in this contract package at review time. This is not a Solidity or proxy-governance audit. |
| Earlier real-proof / native fork checks | Seven optional fork checks passed during the predeployment review using authentic public BTC/ETH signed fixtures and real pinned verifier/messenger code. They are distinct from the seven skips in this network-free CI run; see the linked evidence below. |

The original Pyth-only coverage run achieved 100% instrumented lines/statements/branches/functions for its registry and adapter. That historical result is **not** coverage evidence for the larger current source set; full current coverage was not rerun in this check. Passing tests, bounded fuzzing and source verification do not prove absence of exploits or continuous service availability.

## Static findings retained explicitly

Seventeen Low `timestamp` findings cover the two registries, two adapters and publisher. They reflect deliberate consensus-time observation/expiry/deadline rules, with real sequencer/inclusion assumptions. Proof submission is permitted at its deadline; timeout void is strictly afterward; trading ends exactly at cutoff. Tests cover equality cases. No timestamp is used as entropy. A public `canTrade` read does not authenticate when an encrypted order was committed.

The Low `reentrancy-benign` finding is in `BaseStreamsPublisher.publishBoundary`: it calls the immutable source oracle before caching the authenticated observation. The function and resend path share a reentrancy guard; adversarial tests attempt both nested operations and assert rejection. Source failure or native send failure rolls back the cache. The finding is retained, not suppressed. Upstream governance can still change verifier/bridge behavior and availability.

The vault's original divide-before-multiply and conservative ERC1155-burn callback flags were removed by making the three payout cases explicit and updating liabilities before burns, preserving checked arithmetic and atomic rollback. No source-level suppression was added. Lot constraints make both void halves exact.

## Reviewed contract properties

- **Immutable outcomes:** registry opening and final result are one-way; no administrator may change a result, extend deadlines or choose a fallback price. Creation fixes a future aligned schedule and grants no creator authority.
- **Exact Streams prices:** authenticated schema-v3 int192 prices remain positive integers at configured precision. One 18-decimal atom can change the winner. Bid/ask and legacy fee fields are not invented confidence bounds or application fees.
- **Authentic boundary evidence:** the Base adapter requires a fixed boundary inside the report's signed interval, bounded observation delay, correct feed/schema/body length, no future observation and unexpired authentication. It delegates cryptography to the pinned real verifier. Malformed, wrong-feed, tampered and expired reports reject without an unsigned fallback.
- **Native source authentication:** the cache requires the configured local messenger and authenticated remote publisher, plus matching immutable route/feed/scale/window. Exact duplicate delivery is idempotent; conflicting observations cannot overwrite. Anyone can resend a previously authenticated observation after source expiry. Destination registry deadlines independently reject late opening/resolution.
- **Domain and governance:** route identity binds chains, messenger endpoints, source oracle, publisher, destination cache, feed IDs, precision and delivery policy. Rules and round IDs bind registry/chain and schedule. Version strings and proxy runtime hashes alone do not authenticate implementations or future governance.
- **Collateral conservation:** the separate public vault creates equal claims only after exact collateral transfer, permits only caller-owned burns, and pays only `(2,0)/2`, `(0,2)/2` or `(1,1)/2`. It checks round/global liabilities and token solvency, quantities are lot constrained, and every transfer/mint/merge/redeem value path is guarded. Exact delta checks reject tested fee/rebase behavior; issuer freezes/upgrades remain outside its control.
- **Public-token recovery:** pair holders can merge independently of the oracle or matcher, including after settlement. Split holders require normal resolution or permissionless timeout void. This does not recover encrypted ledger balances, lost wallet keys, frozen tokens or unavailable chain access. Direct donations create no shares and have no rescue path. See [OUTCOME-VAULT.md](OUTCOME-VAULT.md).
- **Original Pyth semantics:** `parsePriceFeedUpdatesUnique` remains a separate first-update-at/after-boundary model with fixed exponents and confidence policy. It is not silently interchanged with Streams interval semantics. Exact proof fees are forwarded; verifier failure is atomic.
- **Bounded input / operational work:** proof sizes/counts are bounded. Scheduling and public token history grow over time; indexers must paginate canonical events. Invalid transaction gas is paid by the caller. Local tests do not establish capacity, finality or keeper uptime.

## Real evidence and test limitations

The [Base verifier evidence](../research/chainlink-streams-base.md) records genuine public BTC/ETH reports and exact source transactions; [native-route research](../research/hybrid-chain-routing.md) records pinned messenger/bridge dependencies. The mainnet smoke verified and delivered a real report for timestamp `1791100805`. That timestamp is **not an aligned five- or fifteen-minute boundary**: this smoke did not create/settle a round, fund a position or execute a private fill. One observed canonical relay took 24 seconds; it is not a delivery guarantee.

Ordinary unit tests use explicitly unsigned fixtures. The installed Pyth SDK 4.3.1 `MockPyth` does not enforce uniqueness in the reviewed unique method; the local fixture explicitly enforces predecessor ordering but still proves no signature. No supported current-Horizen Pyth deployment was established. These limitations do not negate the separate real Chainlink proof tests, and real Chainlink proofs do not establish Pyth support.

Both Base sources were accepted by the explorer; both Horizen sources are published and accepted but classified **partially verified**, not fully verified. Complete creation/runtime bytes and source inputs were independently matched. See the deployment record for the metadata-classification inference and its uncertainty.

## Remaining funded-exchange gates

1. Continuing Data Streams entitlement, fresh report capture, redundant keepers and measured inclusion/finality/censorship behavior. A historical public fixture does not provide a live feed service.
2. Authenticated confidential-order admission and fair sequencing, bound to chain, endpoint, application, account, request, round, prior root and fresh commit time. Recomputing a registry ID proves consistency, not provenance or timely admission.
3. Reviewed confidential custody conservation, idempotent deposit/withdrawal effects, replay nullifiers and canonical state/rollback handling. The public vault is not an enclave-signature withdrawal authority and is not connected to the private ledger.
4. Independent data availability and current account witnesses for unilateral private-state recovery, with exits preventing concurrent private spends. A root or KMS key recovery alone is insufficient.
5. Production Vela deployment/permission/license evidence, measured runtime identity, request-context verification and accurate output/logging privacy guarantees; see the [current Vela refresh](../research/vela-integration-refresh.md).
6. Version-scoped independent audit, operational rehearsal, legal eligibility and funded liquidity. This engineering review does not supply these approvals.

## Reproduce without broadcasting

```sh
bash scripts/install-deps.sh
forge fmt --check
FOUNDRY_PROFILE=ci forge test
python3 scripts/export-abi.py
npm audit --omit=dev --audit-level=low
forge build --skip test --skip script --build-info --ast \
  --out /tmp/zedge-contract-review-out --cache-path /tmp/zedge-contract-review-cache \
  --build-info-path /tmp/zedge-contract-review-out/build-info
slither . --foundry-ignore-compile --foundry-out-directory /tmp/zedge-contract-review-out \
  --filter-paths 'test/|script/|lib/|node_modules/' --fail-medium \
  --json /tmp/zedge-contract-review-slither.json
```

Use a fresh temporary output directory for the full build-info scan; this avoids cleaning or replacing recorded deployment artifacts. ABI JSON exports contain interfaces only. No command above signs or broadcasts. Existing explicitly invoked broadcast tools are separate and require their reviewed plan/configuration/checkpoint checks; CI does not deploy contracts. No deployment or transaction was performed by this review run.
