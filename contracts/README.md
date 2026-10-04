# ZEDGE public round contracts

Original Solidity foundations for BTC/ETH binary rounds. **Four noncustodial oracle/registry contracts are deployed on Horizen and Base; see the [mainnet deployment record](deployment/MAINNET.md).** The separate [public outcome vault](OUTCOME-VAULT.md) is implemented and tested but remains undeployed at this review. It holds collateral for public ERC1155 claims; it does not implement confidential custody, private matching or TEE admission. `test/mocks/` contains deliberately insecure test fixtures.

## Implemented contracts

### Chainlink and the Horizen-first route

The user's approved deployment policy is to keep supported components on Horizen and use Base for missing dependencies. The new Streams contracts implement this split without treating a Base address as a Horizen contract:

```text
Chainlink signed BTC/ETH report
  -> Base: ChainlinkStreamsBoundaryOracle authenticates the exact boundary window
  -> Base: BaseStreamsPublisher sends the verified observation through the native messenger
  -> Horizen: HorizenStreamsOracle authenticates messenger + Base sender + route, then caches it
  -> Horizen: StreamsRoundRegistry records opening/closing and resolves the round
```

These are separate contracts and rules from the original Pyth implementation below. Schema-v3 prices remain signed 192-bit integers at their configured precision (the selected BTC/ETH streams use 18 decimals). There is no fabricated confidence interval or rounding before comparison. The registry accepts only the signed window containing the fixed round boundary. Up includes ties; an unresolvable round becomes eligible for the existing half-payout timeout policy. These four oracle/registry contracts do not transfer collateral or enable private trading.

The adapter validates DON signatures through the official Base verifier, feed identity, exact report shape, positive price, interval containment, observation delay and expiration at verification. The native route binds both chains, both messenger endpoints, the source adapter, publisher, receiver, feeds, precision and timing in one immutable hash. The receiver checks both the local messenger and `xDomainMessageSender()`. A matching duplicate is harmless; conflicting data cannot overwrite a cached observation. Anybody can resend a previously authenticated observation if delivery fails. Arrival after report expiry is allowed because authentication already occurred on Base; the registry's independent opening/resolution deadlines still apply.

The initial public deployment profile is a 60-second observation limit, 150-second opening submission grace, 3,600-second settlement grace and 30-second cutoff buffer. Thus opening must be recorded by start + 210 seconds, strictly before a five-minute round's cutoff at start + 270. These are explicit liveness choices, not a bridge/provider SLA. One observed native message took 24 seconds; reliable operation needs continuing measurement and independent keepers. A late opening cannot start trading, extend the round or change the timeout.

See [the Base verifier and genuine report evidence](../research/chainlink-streams-base.md) and [native routing evidence](../research/hybrid-chain-routing.md). A Data Streams subscription remains necessary for reliable fresh report retrieval. Public historical report fixtures prove specific signatures, not continuing service access. [Engine/protocol version 2](../engine/README.md) now preserves exact positive int192 prices as canonical decimal strings and reproduces Streams rules/round identities; version-1 state is not silently converted. The chain interface has a configured Streams manifest and verifies current runtime, proxy, route and policy bindings. These consistency checks do not establish authenticated private order admission, Vela execution or confidential custody.

### Public collateral and outcome claims

`CollateralizedOutcomeVault` is a separate, undeployed ERC1155 primitive bound to one reviewed Streams registry, its chain, rules hash and six-decimal collateral. It mints equal Up/Down claims only against exact caller funding, permits caller-owned pair merges before or after settlement, and redeems holdings at the registry's fixed winner/void ratio. Quantities are multiples of 1,000 atoms so half-payouts remain exact. There is no owner, privileged minter, fee collector or administrative withdrawal. Pair holders can merge without the oracle; split holders need resolution or the registry's permissionless timeout void.

All positions, transfers and collateral movements in this primitive are public. ERC1155 approval permits the approved operator to move shares, including to itself for redemption. The vault does not hold the engine's private balances or accept enclave-signed withdrawals. Exact-transfer and solvency checks reject tested fee/rebase deviations, but token issuer freezes/upgrades remain upstream risks. Donations are permanently unallocated. See [OUTCOME-VAULT.md](OUTCOME-VAULT.md) for complete units, invariants, callback restrictions, dependency review and missing confidential recovery guarantees. Deployment requires its own reviewed address/runtime/constructor plan and is not enabled by the existing four-contract manifest.

### Original Pyth foundation

`RoundRegistry` fixes rules at construction, allows anyone to pre-schedule aligned BTC/ETH 300/900-second rounds, commits canonical opening evidence, resolves from canonical closing evidence and permits deterministic timeout voiding. There is no owner, upgrade hook, outcome override, pause or asset-transfer function. Scheduling a round gives its creator no power over it.

`IBoundaryOracle` requires proof of the first update for the specified feed at or after the boundary, within the configured window. A caller-selected signed latest price is not sufficient.

`PythBoundaryOracle` is a concrete adapter to Pyth Core `parsePriceFeedUpdatesUnique`. It forwards the exact quoted proof fee and validates response count/feed/timestamp. Evidence is `abi.encode(bytes[] updateData)`. It does not substitute a reporter, another price method or another provider when verification fails. [Pyth unique historical-update semantics](https://api-reference.pyth.network/price-feeds/evm/parsePriceFeedUpdatesUnique)

Pyth support on the **current Horizen L3** was not established; old Horizen EON support is not sufficient. The original Pyth foundation remains undeployed. The new mainnet route uses Chainlink Streams on Base. A Pyth-compatible-looking provider without the unique historical method is incompatible. See the [oracle research](../research/private-orderbook-architecture.md#oracle-and-exact-round-boundaries).

## Original Pyth foundation rules

Constructor `Config` fixes the oracle, collateral contract identity, separate BTC/ETH feed IDs and exponents, observation window, opening/settlement submission grace, cutoff buffer and confidence threshold. These parameters are hashed with chain identity and a policy version into `rulesHash`. They cannot be edited for existing or future rounds on that registry; changed policy requires a new deployment/application binding.

The shared initial engine profile caps the observation window at 60 seconds and the total post-end resolution window at 86,400 seconds. Opening and settlement grace must be positive; the opening deadline must remain strictly before cutoff. Actual selected values require operational measurement; the test fixture's 10/20/60/30-second values are not a production recommendation.

- Round start is a future timestamp aligned to its 300- or 900-second duration. No backdated/current round creation. A scheduler must create rounds in advance; any caller can do so with the same deterministic parameters.
- The opening observation is the **first update at or after `start`**, with publication time in `[start, start + observationWindow]`. Evidence must be recorded during `[start, openingDeadline]`, where `openingDeadline = start + observationWindow + openingGrace`.
- Trading status starts only after that opening is recorded and ends strictly at `cutoff = end - cutoffBuffer`. Constructor validation keeps the opening deadline strictly before the shortest round's cutoff.
- The closing observation is the first update at or after `end`, published in `[end, end + observationWindow]`. Evidence can resolve during `[end, resolutionDeadline]`, where `resolutionDeadline = end + observationWindow + settlementGrace`.
- Both observations must have positive prices, the exact configured exponent, no future publication time, and `confidence × 10,000 <= price × maxConfidenceBps`. **If the first update fails policy, a later update cannot be selected instead.** Eventually the predeclared timeout applies.
- Closing price greater than or equal to opening pays Up; lower pays Down. Exact fixed exponents avoid truncation, normalization or floating-point comparisons.
- Missing opening permits voiding strictly **after** the opening deadline. Once opened, missing resolution permits voiding strictly after the resolution deadline. Proof submission at the exact deadline is allowed; voiding at that same timestamp is not.
- Up pays `(2,0)/2`, Down `(0,2)/2`; a timeout void pays `(1,1)/2`. This is a deliberate policy choice for this contract version and an exception to normal 1/0 payoff. The registry specifies ratios only: the private ledger must implement redemption, rounding/dust and collateral conservation consistently.
- Final resolution/void cannot be rewritten. No administrator can pick a price or invalidate an already finalized round. Outcomes require canonical-chain finality appropriate to the actual deployment; these contracts do not solve reorg finality themselves.

The timeout rule introduces liveness incentives: withholding/losing all valid submissions can cause a half-payout void. Permissionless proof submission helps availability but does not guarantee it. Operate independent evidence capture/submission and disclose censorship/sequencer/provider dependencies before funded use.

### What `canTrade` does not prove

`canTrade(roundId)` reports **current registry time/status only**. Reading it before or after an encrypted request does not bind that request, sender, sequence or commitment time to an enclave transition. There is deliberately no incomplete order-commitment or TEE-signature vault masquerading as a solution. The reviewed Vela request-binding/cutoff/recovery gates still apply. A funded integration must establish canonical admission, cancellation races and no late hindsight option independently.

## Reproduce locally

Requirements: Foundry, Node/npm and Python 3. Versions are pinned in `foundry.toml`, `package-lock.json` and `dependency-pins.json`: Solidity 0.8.30, Paris EVM target, OpenZeppelin Contracts 5.6.1, Pyth Solidity SDK 4.3.1 and forge-std commit `f3dae6e6ee381f25eb6a246f7da9b85c91a68219` (v1.17.0). The public vault's ERC1155 dependency closure separately uses the pinned `@openzeppelin/contracts-paris` alias for unchanged OpenZeppelin 5.4.0 source; newer `Arrays` requires Cancun. Shared dependencies and all four deployed creation bytecodes remain unchanged. See the [compatibility/advisory review](OUTCOME-VAULT.md#dependency-compatibility). OpenZeppelin's storage-based reentrancy guard avoids requiring transient storage. [OpenZeppelin utilities](https://docs.openzeppelin.com/contracts/5.x/api/utils)

```sh
cd contracts
bash scripts/install-deps.sh
forge fmt --check
forge build --sizes
forge test
FOUNDRY_PROFILE=ci forge test
python3 scripts/export-abi.py
forge script script/LocalDryRun.s.sol:LocalDryRun -vv
```

The original Pyth local dry run uses unsigned fixture observations and a dummy token on chain ID 31337. It has **no broadcast calls** and needs no RPC or private key. Its printed addresses are simulated, not network deployments. `DeployRoundRegistry.s.sol` validates expected chain and supplied verifier/collateral runtime-code hashes before constructing contracts in simulation. It permits only local/Horizen network IDs, but does not establish that a provider is genuinely supported or immutable. This Pyth deployment remains deferred.

The separate Chainlink route uses `scripts/preflight-hybrid.mjs --simulate` and `scripts/broadcast-hybrid.mjs --broadcast` under the explicitly authorized public profile in `deployment/hybrid-mainnet.json`. A frozen plan binds bytecode, constructors, chain IDs, nonces, dependencies and cost ceilings. `--resume` inspects every recorded transaction on chain and never resends a recorded hash; it preserves the original signing deadline. Local evidence is ignored by Git. `scripts/verify-hybrid.mjs --check-deployed` reproduces Standard JSON and checks live creation data/runtime before emitting public source-verification packets. These tools do not deploy a confidential exchange.

## ABI and integration

`abi/*.json` are public compile-generated ABIs without addresses. Regenerate after source changes and check for drift. `getRound` returns the immutable schedule, accepted timestamps, outcome and full opening/closing observations. `payoutNumerators` returns denominator **zero while pending**; callers must not divide before finality.

| Enum | Values |
| --- | --- |
| Asset | BTC=0, ETH=1 |
| Outcome | Pending=0, Up=1, Down=2, Void=3 |
| Phase | Missing=0, Scheduled=1, OpeningPending=2, Trading=3, Closed=4, ResolutionPending=5, Resolved=6, Voided=7, Voidable=8 |

Round identity is `keccak256(abi.encode(deploymentChainId, registryAddress, rulesHash, asset:uint8, duration:uint32, start:uint64))`. It is **not the private engine's SHA-256 round ID**. The integration must verify and bind registry address, chain, rules hash, external round ID and exact metadata to its own internal round identity. Never infer equality because timestamps/assets match.

`version()` markers are `zedge-round-registry-v1` and `zedge-pyth-boundary-v1`. Inspect runtime code/implementation and immutable configuration independently: a malicious contract can return the same version string. A runtime code hash of a proxy does not establish the immutability of its implementation or upgrade governance. The original registry/adapter have no upgrade mechanisms; the external verifier and collateral may have their own governance.

## Security evidence and remaining limits

See [SECURITY-REVIEW.md](SECURITY-REVIEW.md) for exact local test/static-analysis evidence and limitations. Tests include deadline equality, invalid/late/future observations, exact fee handling, atomic verifier failure, authenticated-source interface constraints, reentrancy, terminal-state immutability, randomized prices/schedules and stateful invariants. No unsigned test fixture proves live Pyth proof verification, network availability, enclave confidentiality or custody correctness.

OpenZeppelin is MIT; Pyth SDK is Apache-2.0; forge-std is Apache-2.0/MIT under its distributed license. Dependency source and license files are installed from pinned packages/revisions, not copied into original source. No Vela restricted SDK is imported by these contracts.
