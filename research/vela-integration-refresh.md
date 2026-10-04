# Vela and fresh-report integration refresh

Rechecked official sources and public repository metadata on **2026-10-04** after the public mainnet oracle route was deployed. This is a source-based integration assessment, not a Vela audit or permission to activate confidential trading.

## Current release and supported environments

The latest public core release remains [v0.2.0](https://github.com/HorizenOfficial/vela/releases/tag/v0.2.0), published 2026-07-03. Core `main` remains `335724c95ba7b58d64ec97bbb67d18640123278e`; the [npm SDK](https://registry.npmjs.org/@horizen%2fvela-common-ts) remains `@horizen/vela-common-ts@0.2.0`, published 2026-07-02, with git head `c9d28e4107d08ed4a570449a577ac07089891344`. No newer public release closes the earlier integration findings.

The [official roadmap](https://docs.horizen.io/vela/roadmap/) still lists the local software enclave and coordinated Base Sepolia access; Base mainnet and self-service deployment are future items. The [introduction](https://docs.horizen.io/vela/introduction/) also names Horizen testnet. Neither source supplies an authenticated production deployment manifest for this project.

Self-hosting is technically represented in the code: the [executor entrypoint](https://github.com/HorizenOfficial/vela/blob/335724c95ba7b58d64ec97bbb67d18640123278e/cmd/executor/main.go) initializes Nitro/vsock and AWS KMS recovery; Type 1 requires a real Nitro environment. This does not establish a supported turnkey production service, tested recovery, or deployment rights. The [core license](https://github.com/HorizenOfficial/vela/blob/335724c95ba7b58d64ec97bbb67d18640123278e/LICENSE) and [SDK license](https://github.com/HorizenOfficial/vela-common-ts/blob/c9d28e4107d08ed4a570449a577ac07089891344/LICENSE) remain BSL 1.1 with no production grant in the inspected terms. [Hosted-service terms](https://horizenlabs.io/terms) exclude real financial assets and production data from test environments.

## Concrete integration boundaries

| Boundary | Current evidence | Implementable response |
| --- | --- | --- |
| Canonical request binding | Executor `validateRequest` still contains the request-ID reconstruction TODO; the manager supplies sender, token, amount, type, and payload. | Do not promote those fields into funded engine authority through a thin wrapper. Require an authenticated request/deposit witness verified inside the measured runtime and bound to the accepted request ID. |
| Time and admission | `process_request` receives application ID, sender, type, payload, and state; no authenticated request ID or chain timestamp enters this guest call. | A wallet signature can authorize intent, but cannot prove timely admission or prevent post-outcome execution. A reviewed runtime/contract protocol is required; browser time, a server clock, or an old checkpoint is insufficient. |
| State and code | Encrypted state is checked against its root and WASM fingerprint. The transition signature does not explicitly include chain ID and endpoint address. | Domain-bind original guest commands, retain canonical event/root provenance, and verify rollback/reorg handling. A local journal alone does not prove freshest state or prevent cross-deployment ambiguity. |
| Recovery | KMS recovery restores enclave key material using attestation and retained recovery data. Endpoint claims release already credited pending claims. | Separate key restoration, encrypted history restoration, canonical state availability, and forced user exit. No arbitrary private-balance exit during permanent operator failure was established. |
| Privacy outputs | Previously identified event-recipient metadata and raw deposit-result logging remain in the unchanged runtime. | Keep production privacy activation gated on reviewed output/logging policy and tests; SDK encryption cannot remove these host-visible outputs. |

Code references: [executor validation/state/deposits](https://github.com/HorizenOfficial/vela/blob/335724c95ba7b58d64ec97bbb67d18640123278e/pkg/executor/executor.go#L522), [guest call](https://github.com/HorizenOfficial/vela/blob/335724c95ba7b58d64ec97bbb67d18640123278e/pkg/wasm/wasmtime_runtime.go#L699), [transition signature](https://github.com/HorizenOfficial/vela/blob/335724c95ba7b58d64ec97bbb67d18640123278e/contracts/contracts/AbstractTeeAuthenticator.sol), [claims](https://github.com/HorizenOfficial/vela/blob/335724c95ba7b58d64ec97bbb67d18640123278e/contracts/contracts/ProcessorEndpoint.sol#L908), [KMS recovery](https://github.com/HorizenOfficial/vela/blob/335724c95ba7b58d64ec97bbb67d18640123278e/pkg/executor/kms/kms_client.go).

## Chainlink access and work that can run now

The [current official signup flow](https://docs.chain.link/data-streams/sign-up) is self-service, requires payment for stream subscriptions, and has no free tier. Core report access uses the account username plus HMAC secret; candlestick credentials are separate and not interchangeable. Credential rotation immediately invalidates the previous secrets. The [authentication reference](https://docs.chain.link/data-streams/reference/data-streams-api/authentication) specifies signed REST/WebSocket requests. Explorer API credentials do not provide Data Streams access. No account, subscription, purchase, credentials, or entitlement was inspected or created in this review.

A server-side fresh-report client and public round keeper can be implemented against the already deployed Base publisher and Horizen registry, with account access injected separately. Exact signed validity windows and contract deadlines remain authoritative. The historical public smoke report demonstrates verification and native delivery; it is not a continuing source of fresh boundary observations.

The frontend now has an independent schema-2 reader for the deployed Streams route. It verifies both chains, all four deployed runtimes, upstream code/proxy bindings, immutable feeds and rules, and exact 18-decimal observations. It reads real round state, including absent markets, while trading, funding, custody, recovery claims, and private-account access remain unavailable. The original schema-1 checks and paper-trading mode remain separate.
