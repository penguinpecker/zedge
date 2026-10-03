# ZEDGE: Horizen ecosystem, builder funding, and production dependencies

Accessed: **2026-10-04 (Asia/Kolkata)**. Sources are official project documentation, project repositories, the published funding application, and a limited read-only RPC check. This is a research and planning record; no applications, messages, deployments, payments, or funding commitments were made.

## Recommendation

Build a **testnet private-orderbook proof first**, with an explicit path to audited production. Treat access to a supported Vela deployment, its security evidence, and measured order latency as dependencies that must be resolved before committing to a mainnet launch date. A working Horizen mainnet does not establish that Vela mainnet is available. The reviewed Vela documentation and product site still describe early access and testnet availability, with mainnet forthcoming. [Vela introduction](https://docs.horizen.io/vela/introduction/), [Vela product status](https://horizenlabs.io/vela/)

**Our assessment:** ZEDGE should initially present itself as a new project/prototype with a specific confidential matching problem. A hosted interface by itself is not evidence of a deployed financial protocol or production traction. Funding should be requested against demonstrable engineering and actual demand, without assuming the largest grant tier.

## Funding: what the current program actually offers

Season 2 applications are open with rolling review; initial decisions could begin September 17, 2026. Funding is described as USD-denominated grants paid in USDC, without a published equity-investment term sheet. Agreements control the obligations.

Typical payouts are 10% at approval, 20% after the technical milestone, and the remainder for audit and mainnet usage. Audit payment is split equally before and after passing. Most recipients negotiate a ZEN-staking contribution; existing participants generally contribute 15–20% of protocol fees, with exceptions.

Vela is preferred for TEE projects. Demand evidence, delivery capability and founder KYC matter. Scoped DevRel support has limited slots. The page guarantees neither funding nor prediction-market acceptance. [Builder Ecosystem Fund, Season 2](https://horizen.io/builder-fund/)

### What the requested `#why` section means for ZEDGE

It combines Vela confidential execution, zkVerify proof verification, EVM development on Base, selectable privacy tools, PureFi gating, and coordinated ecosystem/engineering support. **Our interpretation:** use Vela for private matching; evaluate the other components separately rather than assuming they are bundled privacy or compliance guarantees. [Why build on Horizen](https://horizen.io/builder-fund/#why)

### Application and eligibility evidence

The linked application contains 85 questions, including conditional sections. Indicative funding ranges are $100–150k for core/RFP proposals, $30–100k for complementary applications, and $10–25k for new/wildcard projects; these are guidance, not fixed limits. Applicants disclose team location/size, product stage, entity status, prior work, current funding/runway, and a named engineer responsible for privacy-critical implementation.

It asks what is confidential and from whom, why privacy matters, technical tradeoffs, the hardest unresolved problem, competitor analysis, demand evidence, monetization, first-user acquisition, and long-term operation. The budget separates development, audit, growth, operations, and other costs. Applicants propose dated technical, audit, and usage milestones; most face a live technical discussion. The support section asks whether delivery remains possible without DevRel help. Incorporation is not assumed by the form: incorporated, in formation, and not incorporated are choices, but the form does not establish final eligibility for every jurisdiction. [Official application preview](https://docs.google.com/document/d/1Eze2ufM-kXYnUaxKNRh_PunZsDvAR8Ggiz8j_rtm-Y8/edit), [Live application](https://tally.so/r/MeQGxl)

The two explicitly requested core applications are confidential agentic trading vaults and confidential lending. A third comparably important proposal can be argued, but ZEDGE is not automatically within those two RFPs. [Core application RFPs](https://blog.horizen.io/a-call-for-new-horizen-projects)

### Proposed ZEDGE application position — our recommendation

Use the **new project** route unless verified existing protocol deployments and users support a complementary/migrator case. Describe the product as fully collateralized BTC/ETH binary outcome markets with confidential order intent and account state, rather than a perpetual exchange. Identify the first users and evidence that they value protected orderflow enough to overcome a new venue's liquidity constraints.

The existing UI is a useful demo artifact. It must be accompanied by the following evidence before it is described as a privacy implementation:

| Proposed milestone | ZEDGE deliverable and acceptance evidence |
| --- | --- |
| M1: confidential order lifecycle | A pinned Vela testnet deployment accepts encrypted signed orders, reserves collateral, matches deterministically, supports cancellation/partial fills, and returns decryptable receipts. Demonstrate replay rejection, no overspending, no plaintext order leakage in logs/events, and deadline handling under load. |
| M2: security and operational readiness | Audit the contracts, WASM matching/accounting, client key lifecycle, attestation configuration, oracle settlement, and recovery paths. Resolve material findings and rehearse interruption/restart/reorg procedures. Scope and quotes precede any audit commitment. |
| M3: bounded real usage | After platform and legal launch gates are satisfied, run capped markets and report verified retained traders, executable liquidity, successful redemptions, incidents, and organic fees. Avoid treating wash volume as success. |

Dates should depend on confirmed Vela availability and auditor capacity. A private matcher is only part of the build; cash management, reliable market resolution, market makers, key recovery, and withdrawals must be funded too. Do not promise a percentage of fees, a ZEDGE token, or founder information before the user chooses the agreement terms.

## Vela availability: distinguish published software from supported deployments

| Item | Evidence as accessed | Production implication |
| --- | --- | --- |
| Documented Vela version | Introduction describes v0.2.0. | Pin all contracts, services, WASM ABI and SDKs; do not use moving `latest` tags for validation. |
| Testnets | Introduction names Base Sepolia and Horizen testnet. Roadmap lists Base Sepolia with coordinated access. | Confirm exact environment, contract addresses, permissions and owner before integration. |
| Mainnet | Roadmap says Base mainnet is next. Product site similarly presents promotion to mainnet as a future step. | No supported Vela mainnet deployment was established by this review. |
| Multi-app | Roadmap and local-setup docs say one app per environment. Current repository README says isolated multi-app support exists. | This is a documentation/repository mismatch, not proof the hosted version supports multi-app. Confirm deployed release and test isolation. |
| Self-service | Roadmap lists shared self-service deployment as forthcoming; contract reference requires `DEPLOYER_ROLE` for deployment. | A normal wallet cannot be assumed to deploy an app into the managed environment. |

Sources: [Introduction](https://docs.horizen.io/vela/introduction/), [Roadmap](https://docs.horizen.io/vela/roadmap/), [Local setup](https://docs.horizen.io/vela/getting-started/local-environment-setup/), [Current repository README](https://github.com/HorizenOfficial/vela/blob/main/README.md), [Contract permissions](https://docs.horizen.io/vela/reference/smart-contracts/).

The launch post says a dedicated Horizen testnet instance can be arranged after starter-kit work. The product site offers bespoke enclave capacity. Neither reviewed source provides a public production SLA, throughput benchmark, or binding hosting price. [Vela launch and testnet access](https://blog.horizen.io/introducing-vela-the-confidential-compute-layer-on-horizen), [Dedicated capacity](https://horizenlabs.io/vela/)

The public early-access form requests contact identity, company, role, business email and use case, plus project stage. It was read only. [Vela early-access form](https://docs.google.com/forms/d/e/1FAIpQLSeinLfK91qorn7tUwie5h0Ax-D7-dTi-A0SKGZnyh1auNxtJw/viewform)

The separate Crecimiento acceleration cohort's published application deadline was August 24, 2026, with an August 31 start and October 8 Demo Day. It should **not** be represented as currently accepting applications. Its announced support includes engineering pairing and office hours; that does not establish access for ZEDGE outside that cohort. [Acceleration announcement](https://blog.horizen.io/horizen-acceleration-season-six-weeks-to-build-on-vela)

## Infrastructure that can be used now

Horizen is an EVM-compatible OP Stack L3 settling on Base. Privacy is implemented at the application layer; deploying ordinary Solidity on Horizen does not make the contract's data private. [Chain overview](https://docs.horizen.io/horizen-chain/overview/what-is-horizen/)

| Network | Chain ID / gas | HTTPS RPC | WebSocket | Explorer / hub |
| --- | --- | --- | --- | --- |
| Horizen mainnet | `26514` / ETH | `https://horizen.calderachain.xyz/http` | `wss://horizen.calderachain.xyz/ws` | [Explorer](https://explorer.horizen.io/) / [Hub](https://hub.horizen.io/) |
| Horizen testnet | `2651420` / test ETH | `https://horizen-testnet.rpc.caldera.xyz/http` | `wss://horizen-testnet.rpc.caldera.xyz/ws` | [Explorer](https://explorer-testnet.horizen.io/) / [Hub and faucet](https://hub-testnet.horizen.io/) |

Network values come from the [mainnet configuration](https://docs.horizen.io/horizen-chain/network/mainnet/) and [testnet configuration](https://docs.horizen.io/horizen-chain/network/testnet/). The [faucet documentation](https://docs.horizen.io/horizen-chain/network/faucet/) also describes Base Sepolia bridging if faucet limits are insufficient. No faucet funds were requested.

### Read-only observation

At **2026-10-03 18:51:54 UTC / 2026-10-04 00:21:54 IST**, unauthenticated JSON-RPC calls to the documented HTTPS endpoints returned:

| Network | Returned chain ID | Latest block | Block timestamp UTC | Gas price | Stork address runtime code |
| --- | --- | --- | --- | --- | --- |
| Mainnet | 26514 | 27,656,231 | 2026-10-03 18:51:54 | 1,000,252 wei | 170 bytes |
| Testnet | 2651420 | 29,464,324 | 2026-10-03 18:51:54 | 1,000,252 wei | 170 bytes |

Methods: `eth_chainId`, `eth_blockNumber`, `eth_getBlockByNumber`, `eth_gasPrice`, `eth_getCode`. The probed Stork address was `0xacC0a0cF13571d30B4b8637996F5D6D774d4fd62`, listed for both networks by [Horizen](https://docs.horizen.io/horizen-chain/integrations/stork-oracle/) and [Stork](https://docs.stork.network/resources/contract-addresses/evm). This confirms endpoint responses and bytecode presence at that moment, not oracle freshness, proxy implementation correctness, chain decentralization, or Vela availability.

### Collateral and cash movement

Horizen's documented stablecoin is **USDC.e**, the Stargate-bridged representation, not Circle-native USDC. Its ERC-20 address is `0xDF7108f8B10F9b9eC1aba01CCa057268cbf86B6c`, with **6 decimals**. The separate OFT address is a bridge mechanism and must not be used as the collateral token. The docs list no official testnet USDC.e deployment. A testnet mock needs explicit labeling and separate configuration. Circle-native upgrade is a possibility, not a promise. [USDC.e documentation](https://docs.horizen.io/horizen-chain/tokens-and-gas/usdc/)

Vela only accepts allowlisted ERC-20 deposits. Verify the chosen collateral through the actual `TokenAllowlist` deployment; ERC-20 support alone does not establish that USDC.e is accepted. Its meta-transaction path can sponsor user gas, but the documented request event still identifies sender and facilitator. That is confidential payload processing, not automatic transaction anonymity. [Vela contract reference](https://docs.horizen.io/vela/reference/smart-contracts/)

The canonical ETH bridge documents a minimum seven-day withdrawal delay from Horizen to Base, while deposits take minutes. Other assets use separate bridge infrastructure. ZEDGE must distinguish withdrawing from its private ledger to a Horizen wallet from bridging funds off the chain; a five-minute market does not imply a five-minute cross-chain exit. [Native bridge mechanics](https://docs.horizen.io/horizen-chain/bridging/how-bridging-works/)

### Supporting services

Goldsky's integration guide establishes the testnet slug `horizen-testnet`, but this review did not establish a contracted mainnet indexing SLA or price. Index only intentionally public data; a subgraph should not become a parallel plaintext order store. [Goldsky integration](https://docs.horizen.io/horizen-chain/integrations/goldsky/)

PureFi provides off-chain screening plus a signed payload that contracts validate before execution. It is an optional integration primitive, not a license to operate financial or prediction markets. Which users and jurisdictions can be served must be determined separately. [PureFi integration](https://docs.horizen.io/horizen-chain/integrations/purefi/), [Application-defined compliance](https://docs.horizen.io/horizen-chain/compliance/)

## BTC/ETH five- and fifteen-minute rounds

Stork is the documented pull-oracle integration. Applications fetch signed observations, submit them to the on-chain verifier, and pay the returned update fee. It supports freshness checks, but the feed does not automatically define a prediction market's settlement rules. [Horizen Stork guide](https://docs.horizen.io/horizen-chain/integrations/stork-oracle/)

The asset registry distinguishes spot/index feeds such as `BTCUSD` and `ETHUSD` from perpetual mark feeds such as `BTCUSDMARK`. Select and disclose the appropriate feed for the contract wording. A prediction share's price is also separate from the underlying BTC/ETH price. [Stork feed registry](https://docs.stork.network/resources/asset-id-registry)

Stork's REST documentation requires an API authorization token, gives a default rate limit of five requests per second, and exposes signed recent observations within the **last ten minutes**. Its historical OHLC response is separate and does not provide the same signed observation evidence. Therefore a fifteen-minute round cannot assume it can fetch its opening signed price only when the round closes. Capture and retain opening evidence promptly; keep the API credential on the service side. [Stork REST API](https://docs.stork.network/api-reference/rest-api)

**Our proposed settlement requirements:** publish immutable round start/end timestamps, a deterministic observation-selection policy, precision and tie behavior, a maximum admissible observation delay, treatment of missing data, and the exact finality policy. Reject late orders using trusted protocol time, not the browser countdown. A failed oracle update should produce a defined pending/void state, not whichever exchange quote the server happens to fetch later. Preserve signed inputs so participants can verify the resolution.

Vela's enclave has no external network access; external data must arrive in requests. Hardware attestation establishes the executed identity and signed result, not that the application's matching logic or external price is economically correct. [Vela execution model](https://docs.horizen.io/vela/introduction/)

**Calculated workload:** continuous non-overlapping rounds across two assets and two durations produce `2 × (288 + 96) = 768` markets/day. If all starts are aligned to five-minute boundaries and the same signed observation is valid under every affected round's rules, boundary observations can be reused across adjacent and fifteen-minute rounds. This reduces redundant oracle work, but must not relax timestamp rules. Order and cancellation traffic, not round creation alone, will determine throughput demand.

**Benchmark before committing to a continuous orderbook:** measure end-to-end time from signed order submission to confirmed reservation/match/receipt at p50/p95/p99, cancellation races near expiry, recovery from manager/indexer/RPC interruption, and backlog under adversarial small-order load. The reviewed public sources do not establish a latency ceiling compatible with the desired experience. A rapid UI acknowledgement must not claim a final fill.

### Oracle selection remains unresolved

**Stork deployment availability does not establish a unique boundary price.** The reviewed V1 source verifies a signature over the feed, timestamp, value, publisher root and algorithm hash; it updates storage when the supplied timestamp exceeds the stored timestamp. Neither the input format nor that condition proves that no earlier signed observation exists after the round boundary. A caller can select among authentic observations: if `T+1` and `T+2` are both valid and newer than storage, accepting `T+2` does not prove it was the first observation after `T`. A freshness window alone does not remove this selection risk. [Stork signature verification](https://github.com/Stork-Oracle/stork-external/blob/b68dfcc298d6d3f15dbb281d98c51ea19089fbc3/chains/evm/contracts/stork/contracts/StorkVerify.sol), [Input structs](https://github.com/Stork-Oracle/stork-external/blob/b68dfcc298d6d3f15dbb281d98c51ea19089fbc3/chains/evm/sdks/stork_evm_sdk/StorkStructs.sol), [Storage update rule](https://github.com/Stork-Oracle/stork-external/blob/b68dfcc298d6d3f15dbb281d98c51ea19089fbc3/chains/evm/contracts/stork/contracts/StorkSetters.sol)

Pyth Core's `parsePriceFeedUpdatesUnique` documents the stronger condition `prevPublishTime < minPublishTime <= publishTime <= maxPublishTime`, establishing a unique first update inside that interval. This is a **candidate semantic**, not a selected ZEDGE dependency. Stork's Pyth-compatible adapter explicitly rejects that function; interface compatibility does not supply this guarantee. [Pyth unique-update API](https://api-reference.pyth.network/price-feeds/evm/parsePriceFeedUpdatesUnique), [Stork Pyth adapter](https://github.com/Stork-Oracle/stork-external/blob/b68dfcc298d6d3f15dbb281d98c51ea19089fbc3/chains/evm/contracts/stork_pyth_adapter/contracts/StorkPythAdapter.sol)

The official Pyth EVM and all-contract catalogs list **Horizen EON Mainnet**, but this review found no explicitly identified deployment for the current Horizen L3 (`26514`) or its testnet (`2651420`). EON is the legacy chain covered by the migration documentation. Base and Base Sepolia deployments do not imply deployments on a Base L3. [Pyth EVM catalog](https://docs.pyth.network/price-feeds/core/contract-addresses/evm), [All Pyth contracts](https://docs.pyth.network/price-feeds/core/upgrade/contracts), [Horizen migration](https://docs.horizen.io/migration/overview/)

**Launch gate:** either verify a supported unique-observation verifier on the chosen deployment, or design and audit an explicit boundary-publication/selection protocol with its own trust and omission assumptions. Persisting authentic Stork observations is necessary for recovery but does not prove completeness. Do not silently swap settlement providers or select a favorable timestamp when a feed fails.

## Examples: evidence is narrower than ecosystem marketing

| Example | What the primary material establishes | What remains unproven here |
| --- | --- | --- |
| Vela Nova | An official runnable confidential account/transfer example, useful for deposit, private state, withdrawal and report plumbing. [Tutorial](https://docs.horizen.io/vela/getting-started/first-confidential-app/) | Production matching performance, trading safety, and live third-party financial usage. |
| Amaanah | Horizen describes confidential yield/vault development and future deeper Vela integration. [Official project article](https://blog.horizen.io/amaanah-labs-is-building-on-horizen) | The article does not establish an audited mainnet Vela deployment or reusable orderbook. |
| Reveal Market | The ecosystem directory lists a confidential prediction-market concept as coming soon. [Ecosystem directory](https://www.horizen.io/ecosystem) | Its Vela implementation, mainnet status, and security evidence were not established. Do not claim ZEDGE is the first or only such project. |
| ZENDEX / DarkSwap | The same directory lists these trading projects as coming soon. | Ecosystem membership is not proof of a production Vela integration or liquidity available to ZEDGE. |

These are useful discovery leads, not integration assurances. A private orderbook still needs its own matching specification, collateral accounting, deadline policy and liquidity providers.

## Operating budget and production gates

There is no supported dollar-per-order estimate from the reviewed material. Chain gas, confidential execution, oracle data, redundancy, and audit cost must be budgeted separately:

| Cost or constraint | Established evidence | What ZEDGE must obtain or measure |
| --- | --- | --- |
| Chain transactions | ETH execution fees plus Base data-publication fees. [Gas guide](https://docs.horizen.io/horizen-chain/tokens-and-gas/gas-on-horizen/) | Receipts for representative deposits, orders, cancellation, settlement and withdrawal; behavior during fee spikes. |
| Vela execution | Introduction says application-assigned fuel, without automatic metering. [Introduction](https://docs.horizen.io/vela/introduction/) | Actual fee schedule, supported operation limits, state-size ceilings, and whether capacity is shared or dedicated. |
| Nitro hosting | AWS charges for EC2 and related services, with no additional Nitro Enclaves feature charge. Enclave lifetime depends on the parent instance. [AWS Nitro documentation](https://docs.aws.amazon.com/enclaves/latest/user/nitro-enclave.html#nitro-enclave-pricing) | Instance sizing, failover design, state/key recovery, backup policy and commercial operator quote. |
| Oracle | Signed REST access is authenticated; on-chain update fee is queried dynamically. [REST API](https://docs.stork.network/api-reference/rest-api), [Integration guide](https://docs.horizen.io/horizen-chain/integrations/stork-oracle/) | Contracted data/API pricing, historical retention, delivery guarantees, and costs of redundant capture. |
| Public RPC/indexing | Public endpoints respond; testnet indexing is documented. | Rate limits, mainnet support, archive/reorg behavior, redundancy and SLA. |
| Economic alignment | Funding may include ongoing protocol-fee contribution. | Model grant terms inside net unit economics; do not count gross trading fees as retained revenue. |

Before any real-money launch, obtain precise answers to these project-specific blockers:

1. Which Vela network, deployed release, addresses and attested measurements will ZEDGE use, and who can upgrade or revoke them?
2. Can the project independently reproduce builds and verify code/measurement binding?
3. What is the supported state-recovery and key-rotation procedure, and how are rollback and duplicate execution prevented?
4. What happens to queued requests and user withdrawals during a prolonged enclave/operator outage?
5. Which contracts are audited, which version did the audit cover, and are all material findings resolved?
6. Is USDC.e allowlisted; are permit, fee-token and decimal assumptions verified against actual contracts?
7. What are the measured order/cancel throughput and tail latencies under peak load?
8. How are requests sequenced, and what prevents censorship, priority abuse or late execution around round boundaries?
9. Which account/order metadata remain public, and what aggregate depth disclosures will the UI intentionally make?
10. Who may request selective disclosure, who administers that role, and exactly what information is retained?
11. Can authoritative signed BTC/ETH boundary observations be captured and recovered reliably for every round?
12. What are the commercial deployment terms, support scope, launch dependencies, legal operating requirements and ongoing costs?

The answers should be written into ZEDGE's deployment record, test plan, user privacy disclosures and funding milestones. The current research supports a serious testnet build; it does not certify an available production private-orderbook service.
