# Horizen-first oracle routing

Reviewed 2026-10-04; corrected on 2026-10-05 where marked, with an [audit note](#audit-note-2026-10-05) at the end. The user approved deploying supported components on Horizen and using Base for dependencies absent on Horizen. This is an explicit two-chain architecture, not a claim that a Base address exists on Horizen.

## Verified native route

Horizen is an OP Stack L3 whose parent is Base. Its native bridge uses parent-to-child deposits; Horizen documents deposits arriving within minutes without the reverse-direction seven-day withdrawal window. The general OP Stack cross-domain messenger transports arbitrary contract calls, not just token transfers. [Horizen architecture](https://docs.horizen.io/horizen-chain/overview/architecture/), [native bridge](https://docs.horizen.io/horizen-chain/bridging/how-bridging-works/), [messenger specification](https://specs.optimism.io/protocol/messengers.html).

Read-only RPC calls to `https://mainnet.base.org` and `https://horizen.calderachain.xyz/http` returned chain IDs 8453 and 26514. Starting from Horizen's [official Base standard-bridge address](https://docs.horizen.io/tutorials/horizen-chain/bridge-assets/), reciprocal getters established this specific route:

| Component | Chain | Address | Observed binding |
| --- | --- | --- | --- |
| Native standard bridge | Base 8453 | `0xF4A6Cc4171FdA694439f856D912777AA6Ab05369` | `messenger()` is the Base messenger below; `otherBridge()` is Horizen's standard bridge |
| Parent cross-domain messenger | Base 8453 | `0x9F5e33f901ad50B50d6A27f63aDaBEA4c81e953c` | `otherMessenger()` is `0x4200000000000000000000000000000000000007`; version `2.6.0`; `paused()` false at the sampled block |
| Optimism portal | Base 8453 | `0x78e794d10a355468A0e7A14AA1a9F9A253D78784` | Returned by Base messenger's `portal()` / `PORTAL()` |
| Child cross-domain messenger | Horizen 26514 | `0x4200000000000000000000000000000000000007` | `otherMessenger()` and `OTHER_MESSENGER()` both return the Base messenger above; version `2.2.0` |
| Child standard bridge | Horizen 26514 | `0x4200000000000000000000000000000000000010` | `messenger()` is the child messenger; `otherBridge()` returns the Base standard bridge above |

The messenger identities are discovered from deployed reciprocal bindings, not inferred solely from a predeploy address. [OP predeploy specification](https://specs.optimism.io/protocol/predeploys.html).

## Concrete delivery sample

Scanning 10,000 recent Base blocks found one native bridge message. Its version-1 message hash was reconstructed from the `SentMessage` and `SentMessageExtension1` logs, then matched to Horizen's `RelayedMessage` event:

- [Base transaction](https://basescan.org/tx/0x100621485521ae2429ab2bcbecc89f358bce4a148c766acfc9b0dce4f2ed1cf2), block 52,152,549, timestamp 1791094445.
- [Horizen transaction](https://explorer.horizen.io/tx/0x0d5a2059b080706f00b707adc8308778e771fd3362eb0463a277f47057b81a64), block 27,697,185, timestamp 1791094468.
- Message hash `0xa3b5e1c9aa565cb0f611a72ed1e2adb84ea35fdf187260da1d178787db39ad8a`.
- Observed inclusion-to-inclusion delay: **23 seconds**.

This is one successful ETH-bridge message, not a ZEDGE oracle delivery, percentile, finality measurement, or availability guarantee. It demonstrates a functioning native route. It does not establish that every five-minute opening will arrive before its deadline. The 60-second observation bound must remain separate from delivery grace; a delayed message must not gain permission to substitute a later price. Current registry limits require `observationWindow + openingGrace < 300 - cutoffBuffer`. Measure actual oracle publication and delivery before funding markets, and retain deterministic timeout/void handling.

**Correction, 2026-10-05.** The sampled message was not third-party traffic. Its Base transaction is the deployment account's own first transaction, a `bridgeETH` deposit that funded the same account on Horizen. The only other timing on record, the 24-second smoke publication in the [deployment record](../contracts/deployment/MAINNET.md#verification-and-smoke-status), was also sent by that account. All route-latency evidence is therefore two self-generated messages. They show that the route works. They do not show how long delivery takes for other senders, under load, or while the deposit fee is being pushed up.

## Deployment partition

1. **Base:** Chainlink's existing supported Streams verifier; ZEDGE's Streams boundary adapter; a permissionless publisher that verifies a signed report, binds its feed and time window, stores its authenticated observation, and sends it through the native Base messenger.
2. **Horizen:** an authenticated observation cache; the BTC/ETH five-minute/fifteen-minute registry; future custody and settlement contracts only when independently implemented and verified.
3. **Application service:** fetch paid Streams reports, submit/retry publication and observe receipts. A submitter has availability responsibility, not authority to invent a price: the Base verifier and destination messenger authentication enforce the payload's provenance.

The destination accepts calls only from its pinned local messenger **and** requires `xDomainMessageSender()` to equal the pinned Base publisher. The route binds source/destination chain IDs, publisher, receiver, adapter, both messengers, feed IDs, decimals, observation window and destination gas allowance. Successful observations are immutable by feed/boundary; exact duplicates are harmless, conflicting observations revert. Native messenger replay protection is additional to application-level duplicate handling. [Authentication pattern](https://docs.optimism.io/app-developers/guides/bridging/messaging#accessing-msgsender).

The publisher/cache constructors bind their own predicted addresses as well as their peers. Deployment planning must use ordinary CREATE with frozen, rechecked per-chain deployer nonces. CREATE2 would make this design's own-address prediction circular because the initcode embeds that address. Any unexpected nonce movement requires aborting and rebuilding the complete route plan. Constructor checks also require the locally deployed messenger's `otherMessenger()` to match the declared remote messenger. The publisher checks that its adapter's feed IDs and decimal metadata equal the route. The registry deployment preflight must independently match those same settings and observation window.

The canonical interface is `sendMessage(address target, bytes message, uint32 minGasLimit)` payable. Version-1 delivery invokes `relayMessage(uint256 nonce,address sender,address target,uint256 value,uint256 minGasLimit,bytes message)`. Successful and failed hashes are tracked separately. Parent-to-child messages execute through derivation automatically; a failed message can be retried according to messenger rules. Set sufficient destination gas; a source receipt alone is not proof of destination success. Monitor `RelayedMessage` / `FailedRelayedMessage`, then the receiver's stored observation. [Messenger ABI and behavior](https://specs.optimism.io/protocol/messengers.html).

The destination must not reapply the report's verification-expiry check to bridge arrival: Base already authenticated the report while usable. It must still validate the signed window, positive price, configured scale, nonzero report hash, and expiry not preceding observation. The registry separately enforces its own opening deadline. A native delivery cannot authorize late opening, alter a settled result, or make an old report fresh. (Corrected 2026-10-05: the registry deployed on 2026-10-04 also had a closing deadline, one hour after the observation window, and is retired for that reason. Its replacement accepts the closing observation whenever it arrives.) Arrival populates the cache; recording the round's opening or resolution is a separate permissionless Horizen transaction, so the delivery budget must include that transaction too.

## Local implementation evidence

The original `BaseStreamsPublisher`, `HorizenStreamsOracle`, shared route validation and messenger interfaces are implemented. `forge test --match-contract NativeStreamsRoutingTest -vv` passed **24 tests**, including four fuzz cases at 1,024 runs each. Cases cover exact signed-192-bit price preservation, source expiry versus delayed delivery, double sender authentication, wrong route/chain/feed, immutable conflicting results, idempotent duplicates, missing/unsigned evidence, constructor identity/counterpart binding, atomic failed sends, retry after destination rejection, and oracle reentrancy into both publication and resend.

These isolated routing tests use explicitly unsigned oracle/messenger fixtures. They prove application checks under those fixtures, not DON signatures, live bridge derivation or mainnet availability. The fixed message gas allowance is immutable and bounded at 200,000–2,000,000; a 600,000 deployment setting remains subject to actual native-path gas verification. No deployment or transaction was performed by this research/implementation task.

## Runtime fingerprints and governance

Read-only samples at Base block 52,155,975 (messenger resolution at 52,156,021) and Horizen block 27,704,018:

| Contract | Runtime code hash |
| --- | --- |
| Base messenger proxy | `0x06643e7d44538ba353995b6b77634e1c5bd1282ae7902f2b1aceaec97cf572ed` |
| Base messenger implementation `0x5D5a095665886119693F0B41d8DFeE78da033e8B` | `0x13a19b3f05901a5bdae8022c7161f99fd1b8705cbd15b36889ff7b3cea782bdf` |
| Base portal proxy and Horizen messenger proxy | `0xfa8c9db6c6cab7108dea276f4cd09d575674eb0852c0fa3187e59e98ef977998` |
| Base portal implementation `0xb443da3e07052204a02d630a8933dac05a0d6fb4` | `0x12efb70e224279a1f7dad360030ee3366b7b551978281908e0d99bcf834d9667` |
| Horizen messenger implementation `0xc0d3c0d3c0d3c0d3c0d3c0d3c0d3c0d3c0d30007` | `0x76cd7dfa97d24622c7c50b51d58fd3658cf1bb0378b3d217d014a82474d90f5a` |

The Base messenger is a `ResolvedDelegateProxy`, not an EIP-1967 implementation-slot proxy. Its zero EIP-1967 slots do **not** establish immutability. Its mapping resolves `OVM_L1CrossDomainMessenger` through AddressManager `0x23e9345926ef161027292d60f80be43ad01bdf8f`. The AddressManager owner is ProxyAdmin `0xee07dA11d10452E0BA0670b2AaA317C5178b5cF0`, whose owner is `0x87Ef0aB1189F76eBCaEe736A5EB8F639a8cF156d`. [Verified proxy source](https://base.blockscout.com/address/0x9F5e33f901ad50B50d6A27f63aDaBEA4c81e953c?tab=contract).

Horizen messenger uses EIP-1967 implementation/admin slots. Its ProxyAdmin is `0x4200000000000000000000000000000000000018`, with observed owner `0x99000aB1189F76EbcaEe736A5EB8F639a8cf267e`. These fingerprints are time-specific evidence, not a governance audit. Native routing inherits parent/child consensus, sequencer availability, reorg, bridge and upgrade-governance assumptions. Proxy code hashes alone do not pin implementations or future behavior.

## State-proof alternative and remaining boundaries

Horizen's `L1Block` predeploy at `0x4200000000000000000000000000000000000015` exposes parent context. Its sampled `hash()` was `0x5e7d3d435cbcc9f81ff8029687ff386f0eb8c4070df53b110da18bda2eaf7eda`, independently found as Base block 52,155,886. This provides an authenticated parent-block anchor within the OP derivation trust model; it is not an existing arbitrary Base-storage-reading API or turnkey oracle proof verifier. A storage-proof route would require additional header, ancestry/history, account/storage-trie and finality handling. The deployed native messenger is the simpler established primitive for this project. [L1 attributes](https://specs.optimism.io/protocol/deposits.html), [L1Block predeploy](https://specs.optimism.io/protocol/predeploys.html#l1block).

No official turnkey Base-Streams-to-Horizen oracle relay was found. ZEDGE's publisher/cache remains custom application code requiring tests and actual end-to-end confirmation. An isolated public registry on Base would avoid messaging but would not settle Horizen custody without a similarly authenticated link; do not create independent authoritative registries with divergent outcomes.

Privacy/custody cannot be marked live just because the public oracle path works. Vela's current published environments remain local and access-gated Base Sepolia; Base mainnet is listed as forthcoming, and a production Horizen Vela deployment is not established by that page. Neither native messaging nor a public registry supplies confidential order admission, custody, recovery or an attested production guest. [Vela availability](https://docs.horizen.io/vela/roadmap/).

## Audit note (2026-10-05)

An internal audit showed that this document's risk model was incomplete: native delivery is not only slow or fast, it is a priced resource that an outsider can make unaffordable.

- Every publication or resend buys a fixed 924,355 gas of Horizen deposit capacity on the Base portal. That figure follows from the route's immutable 600,000 minimum gas limit; the one real relay used 162,474 gas. The portal burns that amount, multiplied by its own deposit base fee, inside the publishing transaction.
- The deposit base fee has a floor of 1 gwei and no practical ceiling. It rises by up to about 2.1 times per full block, and on an idle deposit market any Base account can raise it and hold it there.
- Above roughly 18 to 20 gwei a publication needs more gas than Base's limit of 2^24 per transaction, so nobody can publish or resend, and the price cache has no other way in. On a fork of Base on 2026-10-05, raising the fee that far cost about 0.0017 ETH and holding it cost about 0.37 ETH per hour.
- `resendBoundary` is permissionless and unlimited. Duplicate deliveries are harmless on Horizen, but each one is a new deposit and is one way to push the fee up.

The registry deployed on 2026-10-04 turned such a hold into money: an opened round could be voided at 1/2 + 1/2 one hour after its end, moving value from winners to losers. That registry is retired. The replacement has no deadline for the closing price and allows a void of an opened round only once its void grace has passed with no closing price in the cache. It was first planned with a seven-day grace, so a hold would have had to last the whole seven days. By owner decision on 2026-10-06 the grace is 300 seconds (a void six minutes after the end), so a hold of a few minutes, about 0.03–0.05 ETH at 2026-10-05 Base fees, forces the half payout again. That is an accepted risk (audit finding D4): one hold voids every opened round closing at that boundary (up to four at a quarter-hour), so a trader on the losing side with more than roughly that amount at stake across those rounds can profit from it, and stake limits on the total exposure of all rounds closing at the same boundary, or a test-only launch, are needed before real money. Openings are still exposed: a round whose opening price is not recorded within 210 seconds is voided before it trades, which moves no value. The route contracts themselves are unchanged and immutable; a lower per-message gas limit or a second delivery path would need a new publisher and cache.
