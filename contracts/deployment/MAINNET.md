# ZEDGE hybrid mainnet deployment

Status on 2026-10-04: **all four contracts deployed, runtime and immutable configuration checked, and explorer source submissions accepted**. This record covers the public oracle/round infrastructure. A genuine historical BTC report was verified and published on Base, then delivered through the native messenger and authenticated in the Horizen cache.

## Scope

Four noncustodial contracts form one public oracle route: Chainlink report verification and publication on Base (8453), followed by the authenticated native-message cache and BTC/ETH round registry on Horizen (26514). These contracts do not hold trading collateral, accept orders, execute private fills, or deploy Vela.

The public [deployment profile](./hybrid-mainnet.json) pins the upstream code and proxy implementations. The [Base oracle preflight](../../research/chainlink-streams-base.md) and [native-route research](../../research/hybrid-chain-routing.md) contain the dependency evidence. The deployment account was `0x279173ac297aD146bc92f877552C8C2B78334d07`.

## Confirmed deployments

| Contract | Chain | Address / verified source | Creation transaction | Block |
| --- | --- | --- | --- | --- |
| ChainlinkStreamsBoundaryOracle | Base 8453 | [0xdD3bEAA92E5819333A5D5ccD185704427fAB0e91](https://basescan.org/address/0xdD3bEAA92E5819333A5D5ccD185704427fAB0e91#code) | [0x8d2fbf2d87150233914cd0dc30927ce3c3c26db2d799193b9887ada3bf8f53ac](https://basescan.org/tx/0x8d2fbf2d87150233914cd0dc30927ce3c3c26db2d799193b9887ada3bf8f53ac) | 52157229 |
| BaseStreamsPublisher | Base 8453 | [0xA8abACbD25c9795C3Ef0701184B18Aad6F98C006](https://basescan.org/address/0xA8abACbD25c9795C3Ef0701184B18Aad6F98C006#code) | [0x203f72b2900bbf586923708a4dd94eba37864e2ac0a4c3a47c19cfdd76be6b1b](https://basescan.org/tx/0x203f72b2900bbf586923708a4dd94eba37864e2ac0a4c3a47c19cfdd76be6b1b) | 52157512 |
| HorizenStreamsOracle | Horizen 26514 | [0xc800C3F18D35D492aE6b07655D7f31bFE98A4B6B](https://explorer.horizen.io/address/0xc800C3F18D35D492aE6b07655D7f31bFE98A4B6B?tab=contract) | [0x4c2c4d101fcf8cb871a30dc3a867f5f54b7ee6ba0de941af36b54b10cd09f6c4](https://explorer.horizen.io/tx/0x4c2c4d101fcf8cb871a30dc3a867f5f54b7ee6ba0de941af36b54b10cd09f6c4) | 27707106 |
| StreamsRoundRegistry | Horizen 26514 | [0xdD3bEAA92E5819333A5D5ccD185704427fAB0e91](https://explorer.horizen.io/address/0xdD3bEAA92E5819333A5D5ccD185704427fAB0e91?tab=contract) | [0x189badafcdaf0e08053f819da006509616ad2621f78f69ffff4acaf6ce13cf8f](https://explorer.horizen.io/tx/0x189badafcdaf0e08053f819da006509616ad2621f78f69ffff4acaf6ce13cf8f) | 27707121 |

The identical address on Base and Horizen is intentional: the same account used the same creation nonce on different chains. The two contracts have different bytecode and roles.

All four creation receipts succeeded. The live checker compared creation inputs, sender/nonces, deployed runtime hashes, version markers, immutable getters, route and rules, and current upstream bindings. These checks establish consistency with the reviewed deployment artifacts at the recorded blocks; they are not an independent security audit or a finality guarantee.

Build settings: Solidity `0.8.30`, EVM `paris`, optimizer enabled with `200` runs, metadata bytecode hash `none`.

| Contract | Runtime code hash (keccak256) | Creation block hash |
| --- | --- | --- |
| ChainlinkStreamsBoundaryOracle | `0x106db1660240d4c3536f1f62e273b0559db4066af69bbc80db985b57f6d653f8` | `0xe97fa20efcf2f8bf34f2d5aa8c0c8d20c544f69126995c04a6a347c27cf19873` |
| BaseStreamsPublisher | `0x28d74cd48c995b7c396bb75642c3d82d8c3f6b20fe217e09bd2763c38b112d62` | `0xa0e69e00698d0cd587f327a20405ee6cd13bf8771f4533674035156f5fb2ab7b` |
| HorizenStreamsOracle | `0x3996abf69236d59a30795bc2c4262771bf342cd47d76c99c15e4e48d4c50c459` | `0xd8ba088e5c9776e109286dd2df13239b73769f77b15461417a0f4df3627ec894` |
| StreamsRoundRegistry | `0x901625cddce4c3945fed51c4ee2dd77289ebb69f8e401068f6c2bc9362660a66` | `0xc068b166421addc499312b3181e6812e6fd226a6a80709b689ace8030afd9454` |

- Route hash: `0xdd0243acfe5c168f4189af435f907cd3dd4a26085faf228e721ddee4e87ac36b`.
- Rules hash: `0x591860792894f856c548d908b50aac9bbecd793794da13ac995bf9d248aa7d7c`.
- Four-contract live check: `2026-10-04T09:06:31.204Z`.
- Source verification: both Horizen contracts returned `Pass - Verified` at 09:03:32 UTC; both Base contracts returned it at 09:03:45 UTC on 2026-10-04. Horizen published source files, constructor arguments, compiler, EVM target, and optimizer settings match the submitted inputs. Its explorer currently marks both contracts `is_verified=true`, `is_partially_verified=true`, `is_fully_verified=false`; this is a partial verification classification, not a full/perfect match. The explorer’s complete creation bytecode exactly matches the planned initialization code, and its deployed bytecode and independently checked live runtime hashes match the simulated artifacts. The compiled CBOR trailer contains only Solidity version information because `bytecode_hash=none` omits the source metadata hash. Reviewed upstream Blockscout classification logic supports this missing metadata match as the explanation for its partial label; the explorer’s exact deployed backend version is unknown, so that explanation remains an inference. This is not evidence of an incomplete source upload or a bytecode mismatch.

## Actual deployment fees

These are observed creation costs, not the conservative signing ceilings. Values were read from canonical public receipts at 09:01:59 UTC on 2026-10-04. Execution fee is `gasUsed × effectiveGasPrice`; `l1Fee` is the additional rollup data fee exposed by the receipt.

| Contract | Gas used | Effective gas price (wei) | Execution fee (wei) | L1 data fee (wei) | Observed total (ETH) |
| --- | ---: | ---: | ---: | ---: | ---: |
| ChainlinkStreamsBoundaryOracle | 645164 | 6000000 | 3870984000000 | 22060614687 | 0.000003893044614687 |
| BaseStreamsPublisher | 1034115 | 6000000 | 6204690000000 | 66427425167 | 0.000006271117425167 |
| HorizenStreamsOracle | 990906 | 1000252 | 991155708312 | 269599873 | 0.000000991425308185 |
| StreamsRoundRegistry | 1675338 | 1000252 | 1675760185176 | 420053354 | 0.00000167618023853 |

- Base creation total: **0.000010164162039854 ETH**.
- Horizen creation total: **0.000002667605546715 ETH**.
- Combined four-contract total: **0.000012831767586569 ETH**.

The receipts did not expose explicit operator-fee fields. The public `GasPriceOracle.getOperatorFee(gasUsed)` call at each creation block returned zero for all four transactions, so no operator fee is added. No separate blob fee is added on top of `l1Fee`. These totals exclude bridging the account balance, subscriptions, keepers, and any future exchange/custody infrastructure.

The separate Base smoke publication consumed `1,178,694` gas at `6,000,000` wei per gas plus `7,058,681,872` wei L1 data fee, for **0.000007079222681872 ETH**. Its receipt omitted operator-fee fields; the historical operator getter returned zero. Combined creation transactions plus this Base smoke cost **0.000019910990268441 ETH**. The native Horizen relay was a deposited transaction (`type 0x7e`) using `162,474` gas, with receipt `effectiveGasPrice=0` and `l1Fee=0`; it was not a separate transaction signed by the deployment account. No additional destination fee is added to the total.

## Immutable market policy

| Rule | Value |
| --- | --- |
| Assets and durations | BTC/USD and ETH/USD; 300 or 900 seconds |
| Schedule | Future start, aligned to the selected duration |
| Price precision | Exact signed `int192` prices, 18 decimals; no price rounding |
| Boundary selection | The fixed start/end must lie inside the verified report's signed validity interval |
| Observation window | At most 60 seconds after the fixed boundary |
| Opening grace | 150 seconds after the observation window; opening deadline is start + 210 seconds |
| Trading cutoff | End − 30 seconds; this public clock does not admit or timestamp private orders |
| Settlement grace | 3,600 seconds after the observation window; resolution deadline is end + 3,660 seconds |
| Winner | Closing price ≥ opening price resolves Up; otherwise Down |
| Missing evidence | Permissionless terminal void strictly after the applicable deadline |
| Payout numerators | Up `(2,0)/2`, Down `(0,2)/2`, Void `(1,1)/2`; ratios only, no asset transfer |
| Native delivery gas | 600,000 minimum destination gas |
| Registry collateral denomination | Horizen Stargate-bridged USDC.e, 6 decimals, `0xDF7108f8B10F9b9eC1aba01CCa057268cbf86B6c`; not Circle-native USDC |

Chainlink schema-v3 stream IDs (both 18 decimals):

- BTC/USD: `0x00039d9e45394f473ab1f050a1b963e6b05351e52d71e507509ada0c95ed75b8`.
- ETH/USD: `0x000362205e10b3a147d02792eccee483dca6c7b44ecce7012cb8c6e0b68b3ae9`.

A delayed bridge message cannot replace a fixed boundary with a later price, reopen a timed-out round, or override an already final outcome. The ZEDGE contracts provide no administrator outcome override. Chainlink verification/access/fee configuration, native-bridge proxies, and the collateral proxy remain governed by their upstream owners; the deployment checks pin their current configuration, not future immutability.

## Verification and smoke status

- Explorer source verification: Base returned `Pass - Verified` for both contracts. Horizen returned `Pass - Verified` and publishes matching source/constructor inputs, but its v2 API classifies both as **partially verified**, not fully verified. Exact creation/runtime bytecode and complete published source inputs were checked separately; the metadata-related classification caveat is explained above.
- Four-contract live receipt, runtime, immutable getter and route/rules check: **passed**.
- Genuine public BTC smoke preparation: **passed**, using the real deployed verifier adapter and publisher in `eth_call`; unsigned intent generated.
- Actual Base smoke publication: **succeeded**, [transaction `0xadb72f7a…d91707e`](https://basescan.org/tx/0xadb72f7a07f02938520c1849099dc7279e6340f79e3f05ab79297c385d91707e), block `52157728`, timestamp `1791104803`; canonical successful receipt observed with at least two confirmations.
- Authenticated Horizen cache delivery: **succeeded**, [transaction `0xe1ceefb5…fdc0e9e`](https://explorer.horizen.io/tx/0xe1ceefb58e8ab41e4a4a5d2f335a8ebfb6034701de8c067d78fb318c4fdc0e9e), block `27707544`, timestamp `1791104827`; 29 destination confirmations observed at 09:07:40 UTC. The observation was newly recorded and matched the full expected price, timestamp interval, expiry, report hash, and 18-decimal precision.

The smoke fixture is the already-public signed BTC report from [Base transaction `0xc9d24c37…096aa33`](https://basescan.org/tx/0xc9d24c37c8676210bc9d69c38dc11cf950d0bd6f9b0e7baa9ae682b25096aa33), at its exact single-second timestamp `1791100805`, with signed price `85106875216891330000000` at 18 decimals. Its complete payload hash is `0x9f8b2e1e8114e38f2b52db9de9236373c294135c2207408c3244289926de17eb`. This timestamp is **not an aligned 5m/15m round boundary**. The completed test proves only that historical observation’s public oracle/message route. It did not create or settle a 5m/15m round, execute a funded order, verify a private fill or custody, or establish ongoing keeper availability.

The authenticated OP message hash was `0xf6a44cede02fc2e3d964beb0b76d1bbd5e93b6a45ef35659a9d16a21caf15a57`. The cached decoded-report hash was `0x4f5705284f2365615f2012914d4a86f6f10f13e38536e1ef64cf4628cbe72873` (distinct from the complete signed-payload hash above). Native inclusion took **24 seconds** in this one test. The checker matched the source messenger events, reconstructed message hash, successful destination relay and canonical receipt, and exact cache observation. No failed relay was observed. This is an observed canonical inclusion result, not finalized-chain proof or a delivery-time guarantee.

## Reproducible public checks

Run from the repository root after dependencies and matching artifacts are installed:

```sh
node contracts/scripts/check-hybrid-live.mjs
```

The checker requires the local public deployment plan and confirmed checkpoint under ignored `evidence/`; it never reads private keys or sends transactions. It verifies chain IDs, successful canonical creation receipts, expected creation data, bytecode and immutable configuration, including upstream proxy bindings. The public addresses, code hashes, rules, costs, and explorer links needed to inspect this deployment independently are recorded above. The complete constructor/dependency profile is committed in `hybrid-mainnet.json`. Do not regenerate or overwrite the original deployment plan after broadcasts.

Local evidence files (ignored, public information only): `evidence/hybrid-broadcast.json`, `evidence/hybrid-live-check.json`, `evidence/hybrid-receipt-costs.json`, `evidence/hybrid-smoke-plan.json`, `evidence/hybrid-smoke-costs.json`, `evidence/hybrid-smoke-result.json`, `evidence/hybrid-smoke-destination-costs.json`, and `evidence/verification/`. A receipt-cost calculation can be reproduced with `eth_getTransactionReceipt`, multiplying `gasUsed` by `effectiveGasPrice`, adding `l1Fee`, and querying `getOperatorFee(uint256)` on `0x420000000000000000000000000000000000000F` at the receipt block. Historical Base reads used `https://mainnet.base.org`; Horizen reads used `https://horizen.calderachain.xyz/http`.

## Remaining operational limits

Ongoing fresh reports require Chainlink Data Streams entitlement and server-side credentials. The bridge’s timing is not a delivery guarantee; the round deadlines and timeout rules remain binding. Production private order admission, fills, balances, custody, recovery, Vela availability, and legally eligible operation are separate work. Compilation, automated tests, source verification, and a public-message smoke test do not establish that the full exchange is production ready.
