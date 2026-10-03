# ZEDGE implementation and security verification

Reviewed 2026-10-04. This is an engineering verification record for the first on-chain/private-market implementation. It is **not an independent audit, production approval, or evidence of a deployed confidential exchange**. No funded public-chain transaction was submitted.

## Implemented boundaries

| Component | Implemented | Remaining boundary |
| --- | --- | --- |
| [Public contracts](../contracts/README.md) | Immutable BTC/ETH 5m/15m schedules, oracle evidence interface, concrete Pyth unique-boundary adapter, Up/Down resolution and timeout void | Supported verifier deployment on the actual Horizen L3; live oracle proof verification and availability |
| [Private ledger core](../engine/README.md) | Collateralized shares, real counterparty matching, reservations, partial fills, fee accounting, cancels, settlement, redemption and withdrawal accounting | Verified custody inputs, canonical commit time, durable encrypted state/journal, recovery, archival and measured capacity |
| [Protocol](../protocol/README.md) | Canonical command/state encoding, immutable domains, replay rules and scoped account receipts | Wallet authorization/admission verifier, binding external registry IDs to internal IDs, native Vela guest integration |
| [Vela crypto evaluation](../adapters/vela/crypto/README.md) | Actual pinned SDK encryption/decryption, domain-separated key derivation, epoch/context checks and lock-race handling | Deployed attestation, key registration/recovery, canonical event indexing, guest envelope handling and upstream privacy fixes |
| Chain interface `?mode=chain` | Real RPC and wallet reads, account/network handling, manifest/code/config checks, public registry round reads when configured, transaction inclusion lookup | Contracts are intentionally unconfigured; deposit, trading, private state and quote feeds are unavailable |
| [Conformance harness](../scripts/verify-protocol.mjs) | Four locally deployed EVM round lifecycles drive the Go ledger; native/TinyGo WASI output equality | Test oracle and token identity are fixtures. No real token transfer, signature verification or Vela execution is claimed |

The original paper UI remains available separately. Chain mode is selected before the demo component mounts, so it cannot seed or display a paper account as a real one. An unavailable private balance is never a zero balance. No UI toggle grants privacy or authorizes a transaction.

## Verification scope

- Solidity 0.8.30, OpenZeppelin 5.6.1, Pyth SDK 4.3.1 and forge-std are pinned. Foundry compilation, deterministic tests, fuzz tests, stateful invariants, instrumented coverage and Slither run on original contracts. See the [contract review](../contracts/SECURITY-REVIEW.md) for precise counts and test limitations.
- The dependency-free Go engine has financial conservation/serialization checks on every transition. Unit tests, race detection, `go vet`, randomized command sequences and malformed-snapshot fuzzing cover accounting, timeout equality, replay, cancel/fill behavior and participant-only projection. Bounded fuzz runs do not prove absence of exploits.
- Native CI uses Go 1.27.1. The Vela-compatible **evaluation compilation** pins TinyGo 0.39.0, Go 1.25.14 and Binaryen 133. Downloaded TinyGo/Binaryen/Gitleaks archives are SHA-256 pinned. The generated `scenario.wasm` is a standalone WASI conformance program, **not a Vela guest with the deployment ABI**.
- Real SDK cryptographic tests cover fresh nonces, tampered ciphertext, other accounts/keys, wrong domains/epochs/request IDs, deterministic key recovery under the same fixture wallet, payload limits and locking during asynchronous signature/account reads. Test wallets are generated in memory and never logged or saved.
- Frontend tests cover environment isolation, malformed manifests, bytecode/configuration mismatch, standard proxy rejection, wallet response validation and exact integer formatting. Browser checks exercise chain mode and the preserved demo.
- GitHub workflows run compilation/tests, Slither, Go vulnerability scanning, npm dependency audits, complete-history Gitleaks and CodeQL security-extended queries for TypeScript/JavaScript and Go. Actions are commit-pinned, default permissions are read-only, checkout credentials are not persisted, and no deployment/signing secrets are used. CodeQL does not analyze Solidity; Slither and Foundry cover that scope.
- GitHub secret scanning/push protection, dependency alerts, automatic dependency security updates and private vulnerability reporting are enabled. A clean scan only means that the selected scanner found no matching issue in that scope.

## Findings and dispositions

| Finding | Disposition |
| --- | --- |
| Slither reports block-timestamp comparisons in the round contracts | Eight Low findings retained and documented. Deadlines deliberately use consensus block time; sequencer/chain timing and outage assumptions still need deployment review. No broad detector suppression. |
| `@horizen/vela-common-ts@0.2.0` transitively requires `elliptic@6.6.1` with [GHSA-848j-6mx2-7j84](https://github.com/advisories/GHSA-848j-6mx2-7j84) | npm reports two Low entries (dependency plus affected parent), one underlying advisory with no offered fix. The SDK is isolated in the evaluation package and absent from the frontend bundle. CI records Low results and fails at Moderate for this package; frontend/contracts fail at Low. This is not a clean dependency audit for the SDK. Resolve/review before production adoption. |
| Lock could occur during the final asynchronous wallet-address check in the new crypto wrapper | Fixed by checking the generation after that awaited read. A targeted regression test verifies it cannot restore keys after lock. |
| Upstream key derivation appends the wallet address with caller-dependent casing | Fixed in the wrapper by supplying a canonical lowercase address for key derivation while checking the real wallet before/after signing. A recovery regression checks checksum/lowercase wallet implementations derive the same public key. |
| Receipt domain comparison depended on JSON property ordering | Fixed with exact field validation and canonical field comparison. Tests accept reordered identical fields and reject missing/extra/domain-mismatched fields. |
| Registry and initial engine scheduling/window rules differed | Aligned epoch scheduling, creation-before-start, opening/resolution deadlines, observation windows and timeout equality. External Keccak round IDs and internal SHA-256 IDs remain distinct; the adapter must bind them explicitly. |
| Exact retry returns the original withdrawal description | Documented/tested sequence-based effect suppression. Every custody adapter must check that the state sequence changed before emitting any external effect. The core itself performs no token transfer. |
| A proxy's runtime hash can stay constant across implementation upgrades | Chain configuration rejects nonzero standard EIP-1967 implementation/beacon slots. This is not universal proxy detection. External provider/token governance still requires review; no privacy or security audit badge is issued. |
| Reviewed upstream Pyth mock skips uniqueness in its “unique” method | Contract tests use an explicitly insecure local fixture that enforces predecessor ordering. It tests adapter/registry behavior, not actual oracle cryptography or provider deployment. |
| Engine state/work capacity is bounded | Limits are explicit in the engine/protocol docs. Round/evidence archival, migration, restoration and sustained-load benchmarks are mandatory before a continuously operating exchange. Increasing constants alone is not a capacity design. |
| Upstream Vela recipient metadata and raw-result logging | Remain unresolved deployment/runtime gates recorded in [learnings.txt](../learnings.txt). This build does not modify upstream executor/manager code or claim operator-oblivious fills. |

## Production blockers — beyond a funded signer

1. **Supported Vela environment and terms:** actual endpoint/authenticator/authority/allowlist deployments, enclave measurements, application artifact, governance and applicable production rights. No local example addresses may substitute for that manifest.
2. **Verified admission and guest integration:** bind sender, deposit, request identity, chain/application/round, ordering and fresh execution/commit time. The stock guest ABI has no directly authenticated request time; a user timestamp or historical checkpoint cannot close that gap. The encrypted envelope wrapper and pure engine still need a reviewed native guest adapter.
3. **Oracle deployment and services:** a real supported unique-boundary verifier, authentic feed identities, evidence capture and permissionless submission before deadlines. Stork's latest-price interface cannot silently replace the stronger contract semantics.
4. **Custody and recovery:** reconcile real endpoint collateral against accepted ledger roots, implement idempotent withdrawal/claim effects, restore the latest canonical encrypted state, handle reorgs/queued key changes and provide a reviewed exit if the operator stops. The core's withdrawal accounting is not a live custody vault.
5. **Operations and privacy:** scoped encrypted history and public quote/indexing services, upstream output hardening, keys/backup policy, archival, rate limits, capacity/finality measurements, durable transaction reconciliation and funded LP liquidity.
6. **Independent assurance:** version-scoped review of contracts, ledger, client cryptography, guest/admission/custody, oracle, enclave/KMS/IAM and recovery; findings must be resolved and deployment rehearsed before real funds.

## Reproduce

```sh
npm ci
npm run check
cd contracts
bash scripts/install-deps.sh
FOUNDRY_PROFILE=ci forge test
slither . --filter-paths 'node_modules|lib|test|script' --fail-medium
cd ..
GOTOOLCHAIN=go1.27.1 npm run test:engine
npm --prefix adapters/vela/crypto ci --ignore-scripts
npm run test:crypto
npm run test:protocol
```

For cross-runtime conformance, install tools to a task-specific temporary directory with `scripts/install-wasm-tools.py`, set `ZEDGE_WASM_TOOL_ROOT` and run `bash scripts/build-wasm.sh`. Then run `ZEDGE_SCENARIO_WASM=adapters/vela/build/scenario.wasm npm run test:protocol`. Anvil listens only on loopback; the script checks chain ID 31337. The test does not need a private key or a public RPC.

`contracts/script/LocalDryRun.s.sol` is a nonbroadcast simulation. No provided CI workflow publishes the site or deploys contracts. A future release must add reviewed deployment configuration and local-signer execution after the blockers are closed.
