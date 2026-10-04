# ZEDGE implementation and security verification

Reviewed 2026-10-04. This is an engineering verification record, **not an independent audit, production approval or evidence of a deployed confidential exchange**. Four public oracle/registry contracts are deployed on Base and Horizen, and a genuine historical BTC report completed native delivery. Funded deployment and smoke transactions are recorded in [the mainnet evidence](../contracts/deployment/MAINNET.md). The new public outcome vault remains undeployed at this review.

Read the [whole-system review](WHOLE-SYSTEM-REVIEW.md) for the current risk register and launch boundaries. A working public oracle route, deterministic matching engine and encrypted SDK messages do not together establish authenticated private custody or recovery.

## Implemented boundaries

| Component | Implemented | Remaining boundary |
| --- | --- | --- |
| [Public oracle contracts](../contracts/README.md) | Deployed Base Chainlink Streams authentication/publisher and Horizen native-message cache/registry; fixed BTC/ETH 5m/15m schedules, exact 18-decimal prices, tie-Up and timeout Void. Original Pyth contracts remain separate and undeployed. | Fresh report entitlement, redundant keepers, sustained delivery/availability measurement and finality policy. The historical smoke was not a round lifecycle. |
| [Public outcome vault](../contracts/OUTCOME-VAULT.md) | Undeployed ERC1155 complete-set mint/merge and registry-bound redemption; exact collateral deltas, lot constraints, solvency and callback guards; no operator/admin withdrawal authority. | Public holdings only. Requires a separately reviewed deployment plan; does not custody or recover private ledger balances. Token/bridge governance remains external. |
| [Private ledger core v2](../engine/README.md) | Fully collateralized shares, counterparty matching, reservations, partial fills, cumulative fees, cancels, exact Streams identity/price comparisons, settlement/redemption/withdrawal accounting and terminal-round archival. | Verified custody inputs and canonical fresh admission time; durable authenticated encrypted state/history, unilateral recovery, account/evidence migration and measured capacity. |
| [Protocol v2](../protocol/README.md) | Canonical commands/snapshots, immutable domains, replay rules, participant-scoped receipts, exact registry/rules/round-ID reproduction and signed observation fields. | An actual provenance/admission verifier and measured native guest integration. Internal consistency is not proof of chain facts, request authorization or freshness. |
| [Vela crypto evaluation](../adapters/vela/crypto/README.md) | Actual pinned SDK encryption/decryption, domain-separated key derivation, epoch/context checks and lock-race protection. | Production rights/deployment/attestation, verified key registration, guest envelope/context verification, canonical event indexing and upstream privacy fixes. |
| Chain interface `?mode=chain` | Configured Horizen Streams deployment, public round/RPC/wallet reads, exact price formatting and current runtime/proxy/route/configuration verification. | Private deposits, orders, fills and balances remain unavailable. Public readiness/configuration checks cannot enable them. |
| [Conformance harness](../scripts/verify-protocol.mjs) | Four local Streams-registry lifecycles drive the Go ledger; native/TinyGo WASI output equality. | Local oracle/token fixtures are deliberately unsigned; no real collateral transfer, enclave execution or production request admission is established. |
| [Public report/keeper service](../services/keeper/README.md) | Server-side report retrieval and public round maintenance tooling, with explicit signing/configuration controls. | Live entitlement, secret provisioning, supervised operation, durable reconciliation and measured availability; service implementation is not an uptime claim. |

The demo interface remains separate. Chain mode does not seed a paper account as a real balance. An unavailable private balance is not zero; an enabled wallet connection is not a private exchange account. The mainnet registry denominates Horizen Stargate-bridged USDC.e, **not Circle-native USDC**. No UI toggle grants confidentiality or authorizes a contract deployment.

## Verification scope

- **Solidity:** the current full CI profile passed 131 tests, zero failed, with seven optional network fork tests skipped. Twelve fuzz functions each ran 4,096 cases. Five stateful invariants each reported 131,072 calls and zero handler reverts. The earlier real Base-signature/native-messenger fork checks and the actual mainnet smoke are separate evidence, not silently counted as this run. All ten public ABIs match compiled artifacts. See the [contract review](../contracts/SECURITY-REVIEW.md).
- **Static analysis:** Slither 0.11.5 ran all 101 detectors over 61 contracts/interfaces; test/script/vendor findings were filtered. It retained 18 Low findings, zero Medium/High, and passed `--fail-medium`. No detector was disabled. The focused vault scan had zero High/Medium/Low findings and one informational dependency-pragma finding.
- **Contract dependencies:** Solidity 0.8.30 / Paris, OpenZeppelin 5.6.1, Pyth SDK 4.3.1 and forge-std are pinned. The public vault alone imports the pinned OpenZeppelin 5.4.0 ERC1155 alias whose dependency closure supports Paris; the four deployed creation-bytecode hashes remain unchanged. The contract npm audit reports zero vulnerabilities; see the [advisory and compatibility review](../contracts/OUTCOME-VAULT.md#dependency-compatibility).
- **Engine:** financial conservation/serialization validation runs before and after transitions. Unit/race/vet checks and bounded fuzzing cover matching, fees, replays, snapshots, exact int192 comparison, registry hash binding and archival. The engine now imports pinned `golang.org/x/crypto/sha3` for Solidity-compatible Keccak; it is no longer dependency-free. The [engine record](../engine/README.md) distinguishes zero reachable/imported-package vulnerability results from advisories in unused packages of its pinned module.
- **Runtime conformance:** native CI uses Go 1.27.1. Evaluation compilation pins TinyGo 0.39.0, Go 1.25.14 and Binaryen 133, with downloaded tool archives SHA-256 pinned. `scenario.wasm` is a standalone WASI conformance program, **not a deployed Vela guest**. Native/WASM equality does not establish enclave confidentiality or hardware attestation.
- **SDK/client cryptography:** actual SDK tests cover fresh nonces, modified ciphertext, other accounts/keys, wrong domains/epochs/request IDs, deterministic fixture-wallet recovery, payload limits and asynchronous locking. Fixture keys are generated in memory. The evaluation SDK is absent from the frontend bundle.
- **Frontend:** tests exercise demo/chain separation, malformed manifests, exact integer handling, dependency runtime/configuration/proxy mismatch, wallet responses and validated explorer links. Public contract identity checks do not certify a provider's future governance or universal proxy immutability.
- **CI and repository controls:** workflows run compilation/tests, Slither, Go vulnerability checks, npm audits, complete-history Gitleaks and CodeQL security-extended queries for TypeScript/JavaScript and Go. Actions are commit-pinned, default permissions read-only, checkout credentials not persisted, and CI uses no deployment/signing secrets. CodeQL does not analyze Solidity. Repository secret scanning/push protection and private vulnerability reporting were enabled during setup; a clean selected scan is not proof no secret or vulnerability exists.

## Findings and dispositions

| Finding | Disposition |
| --- | --- |
| Consensus-time dependence | Seventeen Low Slither findings retained. Cutoff/deadline/expiry rules intentionally use chain time; sequencer/inclusion/finality assumptions remain. A registry time read cannot prove a private request arrived before cutoff. |
| Publisher calls its source oracle before caching | One Low `reentrancy-benign` finding retained. Publish/resend share a guard; adversarial nested calls reject and failures roll back. Upstream availability/governance risk remains. |
| Vela SDK transitively uses `elliptic@6.6.1` with [GHSA-848j-6mx2-7j84](https://github.com/advisories/GHSA-848j-6mx2-7j84) | Two Low npm entries represent the dependency plus affected parent, one underlying advisory with no offered fix. Evaluation package is isolated; CI records Low results and fails at Moderate there, while frontend/contracts fail at Low. This is not a clean SDK dependency audit. |
| Crypto lock during asynchronous address verification | Fixed by checking generation after the awaited read; regression prevents restoring keys after lock. |
| Caller-dependent wallet address casing in upstream key derivation | Wrapper canonicalizes lowercase while checking actual wallet identity before/after signing; recovery regression covers checksum/lowercase wallet providers. |
| Receipt domain comparison depended on JSON property order | Fixed with exact field validation and canonical comparison; reordered equivalent fields pass, missing/extra/mismatched fields reject. |
| Earlier CodeQL link/test-script injection alerts | Explorer links use validated transaction hashes and literal official origins; browser tests use static functions/selectors. No alert was suppressed. Current workflow results must be checked for the exact release. |
| Legacy price width could truncate Streams precision | Engine/protocol v2 uses canonical positive int192 decimal strings at 18 decimals and independently derives public registry IDs/rules. Version-1 snapshots/domains reject; migration must be authenticated, not an implicit rescale. Provenance of supplied facts remains adapter-owned. |
| Exact retries repeat withdrawal descriptions | Sequence-based effect suppression is documented and tested: external custody effects must only execute when accepted state sequence changes. The pure core itself transfers no collateral. |
| A proxy runtime can stay unchanged after implementation updates | Streams release checks pin current proxy implementations, admins, source mappings and selected governance getters. They are point-in-time checks; custom upgrade patterns/future governance cannot be universally eliminated by a code hash. |
| Pyth SDK mock skips uniqueness | Local Pyth fixture tests predecessor ordering but is unsigned. It does not prove Pyth cryptography or Horizen support. Separate real Chainlink proof/route evidence does not change that limitation. |
| Finite private-state capacity | Terminal-round archival reuses round slots only after zero holdings/supply/backing. Account nonces and external evidence remain retained; the 256-account, 4,096-evidence and lifetime-deposit limits still need reviewed migration or persistent proof structures for continuous scale. |
| Public outcome claims expose holdings | Explicitly documented, independently reviewed accounting primitive. It does not promise private fills/positions or accept a TEE signer as authority over pooled private funds. |
| Upstream Vela metadata, logging and request-context gaps | Unchanged source gates documented in the [fresh Vela review](../research/vela-integration-refresh.md). SDK encryption cannot remove runtime metadata or authenticate omitted request context. No operator-oblivious fill claim is made. |

## Remaining confidential-exchange gates

1. **Production environment and rights:** authenticated endpoint/authenticator/authority/allowlist manifest, enclave measurements, application artifact, governance and applicable Vela production rights. Public oracle deployment does not satisfy these requirements.
2. **Admission and guest integration:** verify sender, unique deposits, request identity, chain/application/round, ordering, prior state and fresh canonical commitment time inside the trusted boundary. The stock ABI omits directly authenticated request time; a wallet signature, browser/server clock or historical checkpoint is insufficient.
3. **Custody and unilateral recovery:** reconcile real collateral with accepted canonical roots, enforce conservation and withdrawal nullifiers, survive reorg/retry/key transitions, and make current authenticated account witnesses independently available. A root, encrypted backup or KMS key recovery alone does not let users exit during permanent operator failure.
4. **Oracle operations:** continuing paid Data Streams entitlement, fresh signed evidence and redundant deadline-aware submission/relay handling. Mainnet historical verification establishes one route execution, not continuous aligned-round availability.
5. **Services and privacy:** encrypted participant history, safe public quotes, reviewed logging/metadata policy, durable journals/archives, rate limits, capacity/finality measurement, restart reconciliation and funded liquidity. Public-token recovery does not recover encrypted engine balances.
6. **Independent assurance and launch review:** version-scoped external review of contracts, ledger, client crypto, guest/admission/custody, provider/bridge, enclave/KMS/IAM and recovery, plus deployment rehearsal and legally eligible operation. Internal multi-agent review and automated tools do not replace this.

## Reproduce locally

```sh
npm ci
npm run check
npm run test:keeper
cd contracts
bash scripts/install-deps.sh
FOUNDRY_PROFILE=ci forge test
python3 scripts/export-abi.py
cd ..
GOTOOLCHAIN=go1.27.1 npm run test:engine
npm --prefix adapters/vela/crypto ci --ignore-scripts
npm run test:crypto
npm run test:protocol
```

The [contract review](../contracts/SECURITY-REVIEW.md#reproduce-without-broadcasting) includes a Slither command using isolated build-info output so existing deployment artifacts are not cleaned. To reproduce native/WASM conformance, install pinned tools with `scripts/install-wasm-tools.py`, set `ZEDGE_WASM_TOOL_ROOT`, run `bash scripts/build-wasm.sh`, then `ZEDGE_SCENARIO_WASM=adapters/vela/build/scenario.wasm npm run test:protocol`. The local Anvil harness listens on loopback and enforces chain ID 31337; it needs no wallet key or public RPC.

CI and local construction simulations do not broadcast. Separately authorized deployment tools exist and were used for the public four-contract release; they require reviewed immutable plans, constructor/nonce/dependency binding and canonical receipt/runtime reconciliation. Further vault/exchange deployments require their own reviewed release scope, not reuse of the oracle deployment approval as proof of safety.
