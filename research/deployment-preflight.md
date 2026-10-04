# Mainnet deployment preflight

Checked 2026-10-04 against ZEDGE commit `63c9f457978830d1749b4ac2db6509b4b10b90d3`. The user authorized deployment and source verification. No deployment, approval or token-transfer transaction was submitted during these checks.

The two existing MIT contracts are a noncustodial public registry and its oracle adapter. Missing Vela admission, custody and recovery integrations block exchange launch, but are not themselves prerequisites for deploying those two public contracts. Their immediate blocker on Horizen is a verified compatible oracle and an explicit immutable configuration.

## Oracle checks

| Candidate | Current Horizen L3, chain 26514 | Boundary-price implications |
| --- | --- | --- |
| Pyth Core | No supported current-L3 verifier established. Official catalogs list legacy Horizen EON only. Its listed address has no code on chain 26514. | Existing adapter requires `parsePriceFeedUpdatesUnique`; a latest-price API is insufficient. |
| Chainlink Data Feeds | No Horizen feed in the full official network/feed catalog. | Historical `getRoundData` authenticates an observation, but a generic interface does not establish first-at-boundary selection. |
| Chainlink Data Streams | No Horizen entry in the 56-network official verifier catalog inspected. | Authenticated nonoverlapping report windows are a promising canonical boundary mechanism on a supported network. A new adapter and oracle policy are required. |
| Stork | Documented native deployment exists. | Authentic signed price/timestamp inputs do not by themselves prove that a selected observation is the first after a boundary. A separate selection protocol must be designed and reviewed. |

Absence from the published catalogs does not prove that a private integration cannot exist. It does mean there is no established dependency we can safely invent or permanently bind in this release. Base and Horizen are separate networks; Base addresses cannot be reused merely because Horizen settles to Base.

Pyth sources: [current contracts](https://docs.pyth.network/price-feeds/core/contract-addresses/evm), [upgraded contracts](https://docs.pyth.network/price-feeds/core/upgrade/contracts). Chainlink sources: [Data Feeds](https://docs.chain.link/data-feeds/price-feeds/addresses), [Streams networks](https://docs.chain.link/data-streams/supported-networks), [pinned verifier catalog](https://github.com/smartcontractkit/documentation/blob/2c185d063e24e62e13e2827dfd5e5d7257466078/src/features/feeds/data/StreamsNetworksData.ts). [Horizen's Stork integration](https://docs.horizen.io/horizen-chain/integrations/stork-oracle/).

## Why a generic Chainlink substitution is insufficient

The standard Base BTC/USD and ETH/USD feed metadata specifies a 1,200-second heartbeat, with respective deviation thresholds of 0.1% and 0.15%. Price movements can cause earlier updates, but an update within our maximum 60-second boundary window is not guaranteed. Read-only sampling of recent BTC reports found intervals of 240, 958, 1,234, 1,230 and 1,230 seconds. These are observations, not a delivery SLA.

The standard Base proxies inspected were BTC/USD `0x64c911996D3c6aC71f9b455B1E8E7266BcbD848F` and ETH/USD `0x71041dddad3595F9CEd3DcCFBe3D1F4b0a16Bb70`. Both had no code when checked on Horizen at block 27,698,004. The documented Base Streams verifier `0xDE1A28D87Afd0f546505B28AB50410A5c3a7387a` also had no code on Horizen at that block. Catalog metadata: [official reference directory](https://reference-data-directory.vercel.app/feeds-ethereum-mainnet-base-1.json) and the pinned verifier catalog above.

Chainlink proxy round IDs contain phase and aggregator round identity. A generic adapter cannot assume every prior numerical ID is valid or that subtracting one crosses upgrades correctly. Implementations also differ in observation/transmission timestamp semantics. Changing from an observation boundary to the first on-chain transmission after that boundary would change the market rule. See [historical data](https://docs.chain.link/data-feeds/historical-data) and [OCR2 aggregator source](https://github.com/smartcontractkit/libocr/blob/master/contract2/OCR2Aggregator.sol).

For Data Streams, the documented report windows are contiguous and nonoverlapping. A candidate checks `validFromTimestamp <= boundary <= observationsTimestamp`, limits `observationsTimestamp <= boundary + observationWindow`, and authenticates the correct feed/schema through the supported verifier. This is a candidate design, not implemented or proven by the current tests. It must address report validity, missing data, precise price representation, duplicate/conflicting evidence and allowed execution times. [Timestamp semantics](https://docs.chain.link/data-streams/how-report-timestamps-work).

Chainlink does not supply Pyth's confidence interval. Returning a synthetic zero confidence while claiming the existing confidence filter still measures quality would be misleading. Streams prices may also require more precision/range than the current `int64` representation. Select explicit oracle rules and a new rules identity; do not silently truncate prices, since rounding can change ties.

Streams requires separate subscription/API access with HMAC credentials. Current documentation describes subscription billing and no per-verification LINK payment; do not copy deprecated fee assumptions. The Etherscan key is unrelated to oracle access. [Signup](https://docs.chain.link/data-streams/sign-up), [verification](https://docs.chain.link/data-streams/reference/data-streams-api/onchain-verification).

## Collateral and proxy identity

The documented Horizen collateral token is **USDC.e**, `0xDF7108f8B10F9b9eC1aba01CCa057268cbf86B6c`, with six decimals confirmed by RPC. `0x3a1293Bdb83bBbDd5Ebf4fAc96605aD2021BbC0f` is the separate OFT bridge, whose `token()` returns that ERC-20. This is bridged USDC, not Circle-native USDC. [Official token documentation](https://docs.horizen.io/horizen-chain/tokens-and-gas/usdc/).

The token is an upgradeable `FiatTokenProxy` using legacy Zeppelin slots. Standard EIP-1967 slots being zero does not establish immutability. At inspection, implementation was `0x824D8FcDC36E81618377D140BEC12c3B7E4e4cbA` and proxy admin/owner was `0x643cfBC837ed1382F5AC4Cb1B821AAeb00b65c75`. Any release manifest must explicitly account for implementation and governance, not only proxy runtime bytecode. No frontend capability was enabled by this inspection.

## Source verification readiness

- Current contracts compile with Solidity `0.8.30`, Paris EVM, optimizer 200, metadata bytecode hash `none`. Exact Standard JSON compiler-input bundles were generated locally in ignored `evidence/verification/`; they do not establish deployment or explorer verification.
- Horizen's explorer is [Blockscout](https://explorer.horizen.io/). Its `/api/v2/smart-contracts/verification/config` endpoint advertises Standard JSON and the required compiler/EVM version. The per-instance verification URL is `https://explorer.horizen.io/api/`; no Etherscan key is required for that route. [Foundry instructions](https://docs.blockscout.com/devs/verification/foundry-verification#verifying-against-a-specific-instance).
- The live Etherscan V2 chain list did not include chain 26514 or 2651420. Credentials cannot add unsupported-chain coverage. A Base read rejected by an API-plan restriction is not proof that contract source verification is unavailable; no verification submission was attempted for an undeployed address.
- Existing deployment tooling is simulation-only. A funded broadcast must validate exact chain, dependency implementation/configuration, constructor parameters, cost bounds and resulting runtime/getters, then verify the exact source with actual constructor arguments.

No mainnet exchange launch, oracle substitution, network change or privacy guarantee follows from a successful compile or a funded wallet.
