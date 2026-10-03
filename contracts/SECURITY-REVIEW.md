# Contract self-review and validation record

Reviewed 2026-10-04. This is an implementation self-review and automated test record, **not an independent security audit** or approval for real funds. Scope is original `src/RoundRegistry.sol`, `src/PythBoundaryOracle.sol`, their boundary interface and local-only construction scripts. Vela, custody, private matching, oracle cryptography and external deployed contracts are outside this validation boundary.

## Evidence

| Check | Observed result |
| --- | --- |
| Solidity compile / format | Solidity 0.8.30, optimizer 200, Paris EVM; compilation and `forge fmt --check` pass. |
| Unit and fuzz suite | 37 passing test entries, zero failures/skips: 35 unit/fuzz functions plus 2 stateful invariants. CI profile runs each of 3 fuzz functions 4,096 times. |
| Stateful invariants | Each invariant passes 512 runs × 256 handler calls (131,072 calls), zero handler reverts. Handler actions include scheduling, time advance, opening, resolving, timeout and attempted terminal rewrite. Inapplicable actions are explicit no-ops; this is bounded randomized testing, not exhaustive proof. |
| Coverage | Original registry and adapter: 100% instrumented lines, statements, branches and functions in the local suite. This does not establish complete path coverage, real proof correctness or security. Coverage compilation disables optimizer; optimized CI tests run separately. |
| Reentrancy regression | Test oracle sends the correct nested fee and attempts a second opening before the first commits; guard rejects it. The test does not rely on an invalid-fee failure. |
| Local construction simulation | `forge script script/LocalDryRun.s.sol:LocalDryRun -vv` succeeds with clearly labeled unsigned fixtures on local chain ID 31337. No `startBroadcast`, RPC or signing key. |
| npm dependency audit | Pinned dependency installation reports zero known npm vulnerabilities at review time. This is not an audit of Solidity/proxy governance. |
| Slither 0.11.5 | All 101 enabled detectors analyze original contracts with test/script/dependency findings filtered. Eight Low-severity `timestamp` findings (Medium confidence), no Medium/High-severity findings. `--fail-medium` passes; unfiltered severity exit policy correctly reports the Low findings. |

Reproduction:

```sh
bash scripts/install-deps.sh
forge fmt --check
forge build --sizes
FOUNDRY_PROFILE=ci forge test
forge coverage --report summary --exclude-tests
mkdir -p reports
slither . --filter-paths 'test/|script/|lib/|node_modules/' --fail-medium --json reports/slither-review.json
npm audit --audit-level=low
python3 scripts/export-abi.py
forge script script/LocalDryRun.s.sol:LocalDryRun -vv
```

Generated scan reports, dependency trees, cache and local simulation outputs are ignored by Git. Public `abi/*.json` exports contain interfaces only, with no deployment identity or credentials.

## Static-analysis findings retained explicitly

Slither identifies timestamp dependence in `PythBoundaryOracle.verifyBoundary` and registry `createRound`, `recordOpening`, `resolveRound`, `voidRound`, `phase`, `_verify` and `_timestamp`. These checks are intentional protocol rules, but they retain a real trust assumption: the chain/sequencer determines block time and inclusion. A contract cannot substitute wall-clock time or prove a confidential request arrived before cutoff from these reads alone.

The code uses strict/non-strict deadline boundaries deliberately: observation submission is permitted at its deadline, void only afterward; trading ends exactly at cutoff. Tests cover each equality. No timestamp is used as entropy. Slither's taint propagation also flags price and integer-bound comparisons inside time-dependent functions; those comparisons are not alternative time sources. The eight findings are not suppressed in source or falsely described as absent. Safety margins and canonical finality must be selected for the actual target chain and validated under load.

## Reviewed failure/abuse cases

- **Outcome changes:** no privileged setter; opening and final result are one-way; repeated resolution/void and late opening are rejected.
- **Cherry-picked observation:** adapter uses the unique-boundary API; an authentic but later observation with predecessor at/after boundary cannot replace the first. Negative/zero, wrong exponent, excessive confidence, wrong feed, future, missing and out-of-window updates reject.
- **Invalid-first-price behavior:** the unique first observation failing confidence/price policy does not authorize selection of a later price. Timeout void remains the predeclared fallback.
- **Fee leakage:** exact fee required at registry and adapter. No refund callback and no retained user balance. Provider revert rolls back registry writes and ETH transfers. Forced ETH can still be sent by EVM mechanisms; no custody/accounting claim is made for unsolicited funds.
- **Reentrancy:** guarded opening/resolution/void and adapter verification prevent nested transition calls. Scheduling independently fixes deterministic future rules and grants no creator powers.
- **Overflow/precision:** positive int64 oracle prices, uint64 confidence and bounded BPS products fit uint256; fixed exponent comparisons avoid rounding. Derived timestamps are checked before narrowing to uint64.
- **Domain collision:** round ID includes chain, registry address, policy hash, asset, duration and start. Private engine identity is a separate hash domain requiring explicit binding.
- **Input exhaustion:** proof envelope length/update-count bounds limit accepted evidence; the caller pays for invalid calldata. Scheduling/storage growth is permissionless and unbounded by count; indexers must paginate/filter canonical events rather than scan all historical rounds in a transaction.
- **Deployment mistakes:** dry-run input checks expected chain and actual code hashes. A version string or matching proxy runtime hash alone cannot authenticate a provider implementation, upgrade governance or feed policy.

## Oracle testing limitations

Tests intentionally do not use the SDK's `MockPyth` as a uniqueness oracle: in installed Pyth Solidity SDK 4.3.1 its `parsePriceFeedUpdatesUnique` path passes `checkUniqueness=false` to the mock parser. The local `MockUniquePyth` fixture explicitly checks predecessor time instead. **Both are unsigned mocks.** Passing these tests verifies ZEDGE's invocation, validation and state behavior, not Pyth signature/Merkle/Wormhole verification. A supported deployed verifier and real signed historical fixtures/fork tests are mandatory before network activation.

There is no configured native Pyth Core verifier on current Horizen L3 chains 2651420/26514 in this package. The adapter must stay unconfigured until deployment support and exact unique-boundary functionality are established. No substitute signed-reporter or latest-price fallback was added.

## Unresolved funded-integration gates

1. Supported canonical verifier, actual BTC/ETH feed IDs/exponents, provider governance, real-proof tests and independent evidence availability.
2. Public registry → confidential engine binding: exact external round ID, rules hash, immutable observations, current chain/finality and the separately defined internal round ID.
3. Authenticated order admission/commitment deadline and fair sequencing under delayed execution/cancellation. `canTrade` does not provide this.
4. Actual collateral identity/decimals, TEE ledger conservation, claim/redemption integration and operator-outage recovery. These contracts never hold trading collateral or mint shares.
5. Production Vela permission/deployment/audit evidence and the documented runtime logging/recipient metadata fixes or accurate limited privacy claims.
6. Measured cutoff/opening/settlement timing, submission redundancy, censorship/reorg behavior and the economics of timeout half-payouts. No mock test establishes a throughput or uptime SLA.
7. Independent contract/integration audit. Automated tool success and full instrumented coverage are not independent audit evidence.

No public-network transaction or funded deployment was performed.
