# ZEDGE public round contracts

Original Solidity foundations for BTC/ETH binary rounds. **Three noncustodial oracle contracts are live on Base and Horizen. The round registry deployed with them on 2026-10-04 is retired (it never held a round); its upgradeable replacement in this source tree is planned and not deployed. See the [mainnet deployment record](deployment/MAINNET.md).** The separate [public outcome vault](OUTCOME-VAULT.md) is implemented and tested but remains undeployed at this review. It holds collateral for public ERC1155 claims; it does not implement confidential custody, private matching or TEE admission. `test/mocks/` contains deliberately insecure test fixtures.

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

These are separate contracts and rules from the original Pyth implementation below. Schema-v3 prices remain signed 192-bit integers at their configured precision (the selected BTC/ETH streams use 18 decimals). There is no fabricated confidence interval or rounding before comparison. The registry accepts only the signed window containing the fixed round boundary. Up includes ties. A round that was never opened, or whose closing price never reaches Horizen, becomes eligible for the half-payout void described under [Streams registry rules](#streams-registry-rules). These four oracle/registry contracts do not transfer collateral or enable private trading.

The adapter validates DON signatures through the official Base verifier, feed identity, exact report shape, positive price, interval containment, observation delay and expiration at verification. The native route binds both chains, both messenger endpoints, the source adapter, publisher, receiver, feeds, precision and timing in one immutable hash. The receiver checks both the local messenger and `xDomainMessageSender()`. A matching duplicate is harmless; conflicting data cannot overwrite a cached observation. Anybody can resend a previously authenticated observation if delivery fails. Arrival after report expiry is allowed because authentication already occurred on Base; the registry's own opening deadline and void rule still apply.

#### Streams registry rules

`StreamsRoundRegistry` (`zedge-streams-round-registry-v2`) replaces the registry deployed on 2026-10-04. That contract let anyone void an opened round one hour after its end and pay 1/2 + 1/2, even when the closing price was already cached on Horizen or its delivery had been priced out on purpose. The planned profile is a 60-second observation window, 150-second opening grace, **5-minute (300-second) void grace** and 30-second cutoff buffer. All times are Horizen `block.timestamp`.

- **Scheduling** is unchanged: anyone may create a future round aligned to its 300- or 900-second duration.
- **Opening** must be recorded on the registry during `[start, openingDeadline]`, where `openingDeadline = start + observationWindow + openingGrace` (start + 210 s), strictly before a five-minute round's cutoff at start + 270 s. A round with no recorded opening can be voided by anyone strictly after `openingDeadline`, even if the opening price is cached. A late opening cannot start trading or extend the round.
- **Resolution** is accepted at any time at or after `end`, with **no deadline**, from the cached observation for `end`. Closing at or above opening pays Up, otherwise Down.
- **Void of an opened round** is accepted only strictly after `voidableAfter = end + observationWindow + voidGrace` (end + 60 s + 300 s, six minutes after the end) **and** only while the price cache holds no closing observation for that round's feed and `end`. If one is cached, `voidRound` reverts `ClosingEvidenceAvailable`: the round must be resolved. `initialize` accepts a void grace of 2 minutes to 21 days: at least two minutes to leave time to deliver a late closing price, at most 21 days because a Chainlink report can be verified on Base for 30 days.
- **`phase()`** reports `ResolutionPending` from `end` until the round is finalised, except `Voidable` once it is past `voidableAfter` with no cached closing observation. `Voidable` means only that: nothing is cached and the grace has passed. It does not mean the price can no longer arrive, because a report stays verifiable on Base for about 30 days and a message already sent takes time to land. From then on the first transaction wins, so an operator should first try to publish or resend the closing boundary and resolve, and void only when no report can be obtained. A recorded void is final; a price that arrives afterwards cannot reverse it.
- **Payouts** are Up `(2,0)/2`, Down `(0,2)/2` and void `(1,1)/2`. `payoutNumerators` returns denominator zero while pending.

These are explicit liveness choices, not a bridge/provider SLA. One observed native message took 24 seconds; reliable operation needs continuing measurement and independent keepers. A cached closing price can no longer be voided, and a price that arrives late still decides a round nobody has voided. Blocking delivery still forces a half payout if the block lasts the whole void grace. **Accepted risk (owner decision 2026-10-06, audit finding D4):** anyone can block Base-to-Horizen price delivery by pumping Horizen's deposit fee on Base, at a cost that grows with how long the block is held: at 2026-10-05 Base fees about 0.03–0.05 ETH for a few minutes and about 0.4 ETH per hour. One block stops every price message, so it voids every opened round that closes at that boundary at once (up to four at a quarter-hour: BTC and ETH, five and fifteen minutes). With the five-minute grace, a trader on the losing side with more than roughly that amount at stake across those rounds can profit by forcing the void, and the winners then receive half of what they were owed. The owner chose refunds within minutes over a seven-day grace knowingly. Before real money, stake limits on the total exposure of all rounds closing at the same boundary (or a test-only launch) are needed; that is an open item and is not built. Limits that remain: an opening not recorded within 210 seconds voids the round before any trading; a five-minute round may trade for as little as 60 seconds; and a Chainlink reporting gap longer than the observation window around a boundary leaves no report the route accepts. A round whose closing boundary can never be published can only be voided, and its one-sided Up or Down positions stay locked until `voidableAfter` (end + 360 s in the planned profile). Complete pairs can still be merged at any time.

#### Proxy and ownership

The registry is a UUPS implementation behind an unmodified OpenZeppelin 5.6.1 `ERC1967Proxy`. The proxy address is the registry address and is bound into every round ID. `initialize(config, owner)` runs once, in the proxy's constructor: it stores the configuration and `rulesHash` and requires the price cache to report the same feed IDs, decimals, observation window and chain, so that a cached closing observation can always resolve. The implementation contract cannot be initialised or upgraded and holds no configuration. It still answers `version()` and accepts `createRound` and `voidRound` on its own empty storage, so anything that finds the registry by version string or event topic must pin the proxy address; nothing at the implementation address is a registry round.

The owner (`Ownable2Step`) can do two things only: upgrade the implementation, or hand ownership to an address that then accepts it. `renounceOwnership()` always reverts with `RenounceDisabled`, so the upgrade path cannot be given up in one mistaken transaction. There is no pause, outcome setter or token handling. **An upgrade can change any rule and any stored result, so the owner key is a trust assumption that the retired immutable registry did not have.** It exists so the route can be repaired when an upstream dependency changes. The three live oracle contracts stay immutable.

Storage: every OpenZeppelin base keeps its state in ERC-7201 namespaced slots. The registry's own variables use slots 0-6, followed by a 43-slot gap; an upgrade may only append. `testProxyStorageLayoutIsPinned` reads the raw slots of a proxy and of a stored round, so a new implementation that moves any of them fails the suite.

See [the Base verifier and genuine report evidence](../research/chainlink-streams-base.md) and [native routing evidence](../research/hybrid-chain-routing.md). A Data Streams subscription remains necessary for reliable fresh report retrieval. Public historical report fixtures prove specific signatures, not continuing service access. The [engine/protocol](../engine/README.md) preserves exact positive int192 prices as canonical decimal strings; its mirror of these rules and round identities must match this registry's rules version (that README states the current protocol version). The chain interface has a configured Streams manifest and verifies current runtime, proxy, route and policy bindings. These consistency checks do not establish authenticated private order admission, Vela execution or confidential custody.

### Public collateral and outcome claims

`CollateralizedOutcomeVault` is a separate, undeployed ERC1155 primitive bound to one reviewed Streams registry (it accepts only the `zedge-streams-round-registry-v2` marker), its chain, rules hash and six-decimal collateral. It mints equal Up/Down claims only against exact caller funding, permits caller-owned pair merges before or after settlement, and redeems holdings at the registry's fixed winner/void ratio. Quantities are multiples of 1,000 atoms so half-payouts remain exact. There is no owner, privileged minter, fee collector or administrative withdrawal. Pair holders can merge without the oracle at any time; split holders need resolution or the registry's void, which for an opened round requires the void grace to pass with no closing price cached. The vault itself is immutable, but it follows whatever the upgradeable registry reports.

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

Requirements: Foundry, Node/npm and Python 3. Versions are pinned in `foundry.toml`, `package-lock.json` and `dependency-pins.json`: Solidity 0.8.30, Paris EVM target, OpenZeppelin Contracts 5.6.1 and Contracts Upgradeable 5.6.1, Pyth Solidity SDK 4.3.1 and forge-std commit `f3dae6e6ee381f25eb6a246f7da9b85c91a68219` (v1.17.0). The public vault's ERC1155 dependency closure separately uses the pinned `@openzeppelin/contracts-paris` alias for unchanged OpenZeppelin 5.4.0 source; newer `Arrays` requires Cancun. The upgradeable package is likewise imported by relative path, so no remapping changed: the three live contracts' sources, creation bytecode and compiler metadata are unchanged. See the [compatibility/advisory review](OUTCOME-VAULT.md#dependency-compatibility). OpenZeppelin's storage-based reentrancy guard avoids requiring transient storage and, because its flag lives in a namespaced slot whose initial zero means "not entered", works behind the proxy without an initializer. [OpenZeppelin utilities](https://docs.openzeppelin.com/contracts/5.x/api/utils)

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

`abi/*.json` are public compile-generated ABIs without addresses. Regenerate after source changes and check for drift. `getRound` returns the fixed schedule, accepted timestamps, outcome and full opening/closing observations; in the Streams registry the seventh field is `voidableAfter` (the retired registry and the Pyth registry call it `resolutionDeadline`). `payoutNumerators` returns denominator **zero while pending**; callers must not divide before finality.

| Enum | Values |
| --- | --- |
| Asset | BTC=0, ETH=1 |
| Outcome | Pending=0, Up=1, Down=2, Void=3 |
| Phase | Missing=0, Scheduled=1, OpeningPending=2, Trading=3, Closed=4, ResolutionPending=5, Resolved=6, Voided=7, Voidable=8 |

Round identity is `keccak256(abi.encode(deploymentChainId, registryAddress, rulesHash, asset:uint8, duration:uint32, start:uint64))`; for the Streams registry `registryAddress` is the proxy. It is **not the private engine's SHA-256 round ID**. The integration must verify and bind registry address, chain, rules hash, external round ID and exact metadata to its own internal round identity. Never infer equality because timestamps/assets match.

`version()` markers, with the status of each contract (addresses are in the [deployment record](deployment/MAINNET.md)):

| Contract | `version()` | Status |
| --- | --- | --- |
| `ChainlinkStreamsBoundaryOracle` | `zedge-chainlink-streams-boundary-v1` | Live on Base (8453) |
| `BaseStreamsPublisher` | `zedge-base-streams-publisher-v1` | Live on Base (8453) |
| `HorizenStreamsOracle` (price cache) | `zedge-horizen-streams-oracle-v1` | Live on Horizen (26514) |
| `StreamsRoundRegistry` behind its proxy | `zedge-streams-round-registry-v2` | Planned for Horizen (26514); not deployed |
| Retired `StreamsRoundRegistry` | `zedge-streams-round-registry-v1` | On Horizen since 2026-10-04, retired, zero rounds; do not integrate |
| `CollateralizedOutcomeVault` | `zedge-public-outcome-vault-v1` | Not deployed |
| `RoundRegistry`, `PythBoundaryOracle` | `zedge-round-registry-v1`, `zedge-pyth-boundary-v1` | Original Pyth foundation; not deployed |

Inspect runtime code and configuration independently: a malicious contract can return the same version string. At the proxied registry's address the runtime code is the generic `ERC1967Proxy`, which identifies neither the implementation nor who may replace it. Read the implementation from the ERC-1967 slot `0x360894a13ba1a3210667c828492db98dca3e2076cc3735a920a3ca505d382bbc`, hash that code, and read `owner()` and `pendingOwner()`. The three live Streams contracts and the Pyth contracts have no upgrade mechanism; the external verifier, messengers and collateral have their own governance.

## Security evidence and remaining limits

See [SECURITY-REVIEW.md](SECURITY-REVIEW.md) for exact local test/static-analysis evidence and limitations. Tests include deadline equality, invalid/late/future observations, exact fee handling, atomic verifier failure, authenticated-source interface constraints, reentrancy, terminal-state immutability, randomized prices/schedules and stateful invariants. No unsigned test fixture proves live Pyth proof verification, network availability, enclave confidentiality or custody correctness.

OpenZeppelin is MIT; Pyth SDK is Apache-2.0; forge-std is Apache-2.0/MIT under its distributed license. Dependency source and license files are installed from pinned packages/revisions, not copied into original source. No Vela restricted SDK is imported by these contracts.
