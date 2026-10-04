# Public outcome collateral primitive

`CollateralizedOutcomeVault` is a new, independently testable claim primitive. It does not change the four deployed oracle/registry contracts and has not been deployed by this implementation. It is **not the confidential exchange vault**: ERC1155 holdings, transfers, minting, merging and redemption amounts are public. No TEE result or operator signature authorizes movement of collateral.

## Interface and economic rules

Constructor: `(address registry, bytes32 expectedRulesHash)`. It requires the Streams registry version, current chain, matching nonzero rules hash and a contract collateral token reporting six decimals. It records the registry runtime code hash. These are consistency checks, not proof that an arbitrary supplied registry is honest or immutable: deployment must independently pin the reviewed registry address, exact runtime, rules, collateral and token governance. There is no owner, proxy, upgrade, administrative withdrawal or rescue method.

| Function | Effect |
| --- | --- |
| `mintCompleteSet(roundId, amount, recipient)` | During the registry's opened trading phase, pulls exactly `amount` collateral atoms from caller and mints the same number of Up and Down atoms. |
| `mergeCompleteSet(roundId, amount, recipient)` | Burns `amount` of each caller-owned outcome and returns exactly `amount` collateral atoms. Available before or after cutoff and settlement: a complete pair always pays one collateral unit. |
| `redeem(roundId, recipient)` | After registry settlement/void, burns all caller-owned shares for that round and pays its exact ratio. Losing-only positions can burn for zero. |
| `outcomeTokenId(roundId, outcome)` | Domain-separated ID binding chain, vault, registry, rules, round and outcome (`0=Up`, `1=Down`). |
| ERC1155 transfer/approval functions | Move publicly held shares. Operators can transfer approved shares; approval does not add an arbitrary-owner burn/redemption entrypoint. An approved operator can take shares and then redeem its own holdings. |

One share is 1,000,000 atoms. Every mint, merge, transfer and burn is a multiple of 1,000 atoms. Void payouts therefore have no fractional collateral atom or rounding residue. The only accepted settled ratios are Up `(2,0)`, Down `(0,2)` or Void `(1,1)`, with denominator 2. A pending `(0,0,0)` rejects redemption. The registry already defines tie-up and timeout rules; this vault never compares or truncates oracle prices.

For every round, remaining collateral is `UpSupply = DownSupply` while unresolved and `(upNumerator*UpSupply + downNumerator*DownSupply)/2` after settlement. Total tracked collateral is the sum of round backing. The token balance must cover that total before/after funding and payout, and exact payer/vault/recipient transfer deltas are checked. Current total backing is bounded at `uint128.max`; Solidity checked arithmetic remains active. There are no trading or withdrawal fees here.

Direct token donations create no shares or withdrawal right and remain unallocated permanently. Fee-on-transfer, surcharge and rebasing collateral is unsupported. Transfer-time delta checks detect the tested deviations; arbitrary token behavior cannot be certified by inspecting its decimals or transfers. A negative balance change causing a shortfall blocks new funding and payouts so early claimants cannot drain backing belonging to others. Token issuer pauses, blacklists or upgrades can still prevent transfers. Ordinary ERC20, ERC1155 and receiver calls share a reentrancy guard across mint/merge/redeem and share transfers. A receiver cannot immediately redeem or forward newly received shares from its callback; it can do so in a subsequent call. Failed transfers/receiver callbacks revert burns, funding and liabilities atomically.

Users holding pairs can always submit merge transactions independently of the matcher or oracle. Split holders need a resolved/voided registry round; anyone can call the registry's existing strict timeout void when allowed, then holders redeem directly. This is recovery of **public tokens**, not recovery of an encrypted ledger, a lost wallet, censored chain access or frozen collateral.

## Dependency compatibility

Global Solidity 0.8.30 / Paris and shared `@openzeppelin/contracts@5.6.1` are preserved. ERC1155/ERC1155Supply use the separately pinned npm alias `@openzeppelin/contracts-paris = npm:@openzeppelin/contracts@5.4.0`; its source is installed unchanged. Its ERC1155 dependency closure compiles for Paris. OpenZeppelin 5.5.0+ `Arrays` uses MCOPY, requiring Cancun. The alias is imported by an explicit relative path so existing remappings and deployed-contract settings do not change. `npm ci --ignore-scripts` already installs the lockfile alias; the installation script needs no new command.

The [official advisories](https://github.com/OpenZeppelin/openzeppelin-contracts/security/advisories) were checked on 2026-10-04: the historical [ERC1155Supply advisory](https://github.com/OpenZeppelin/openzeppelin-contracts/security/advisories/GHSA-wmpv-c2jp-j2xg) affects 4.2.0 through before 4.3.3; the [Bytes advisory](https://github.com/OpenZeppelin/openzeppelin-contracts/security/advisories/GHSA-9rcw-c2f9-2j55) is patched in 5.4.0 and Bytes is not imported by this vault's ERC1155 closure. Base64, multicall, governors, upgradeable contracts and signature helpers are not used by the vault. The dependency installation reported zero npm advisories; that does not replace contract review. The OpenZeppelin 5.4 batch-of-one receiver behavior is retained (it uses the single receiver hook); receivers should implement both ERC1155 hooks. [Official release notes](https://github.com/OpenZeppelin/openzeppelin-contracts/releases/tag/v5.6.0) document the later behavior change.

## Verification and unfinished confidential custody

Unit/fuzz tests use the actual local Streams registry with an explicitly unsigned oracle fixture, plus adversarial token/receiver and malformed-registry fixtures. Stateful invariants track three holders and two rounds through mint, transfer, merge, redeem, settlement, timeout and donations. They check per-round liabilities, holder/supply equality, exact total asset conservation and the deposited/withdrawn identity. Tests are not an external audit or a proof that an arbitrary production token/registry is safe.

The 2026-10-04 CI profile passed 24 unit/fuzz tests (including 4,096 randomized settlement/split/merge scenarios) and one stateful invariant test with 512 runs, 131,072 calls and zero handler reverts. Slither 0.11.5 ran all 101 detectors on the vault's 28-contract compilation closure, scoped findings to the new vault, and passed `--fail-medium`: zero High/Medium/Low findings and one informational mixed dependency-pragma finding. The compiler remains pinned at 0.8.30. No detectors were disabled. An independent agent reviewed the authorization and conservation paths and found no blocking issue; this is an internal review, not an external security audit.

```sh
forge test --match-contract 'CollateralizedOutcomeVault.*' -vv
FOUNDRY_PROFILE=ci forge test --match-contract 'CollateralizedOutcomeVault.*'
```

Confidential custody still needs a reviewed canonical transition verifier that binds application/code identity, chain, endpoint, prior root, next sequence, complete authorized requests, unique deposits and withdrawal nullifiers. It must enforce financial conservation, exact oracle/round identity and commitment-time cutoff rules. A TEE signing key alone is not that verifier. Recovery additionally needs independently available, authenticated latest-state witnesses and a unilateral spend/exit mechanism that cannot be combined with a concurrent private spend. A Merkle root without current user witnesses/data availability does not give users a usable exit. Any future adapter must atomically debit private collateral when issuing public claims; minting a public claim without removing the private claim would double-count backing. None of these confidential transition, proof, DA or recovery guarantees are supplied by this public-token primitive.
