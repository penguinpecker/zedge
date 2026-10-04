# Chainlink Data Streams: Base preflight

Checked 2026-10-04 UTC. Scope: public read-only documentation, verified deployed source, and RPC calls. No private credentials read, subscription purchased, transaction signed, or transaction broadcast. This is evidence for an adapter integration, not a claim that ZEDGE settlement is deployed or production ready.

## Finding

Base mainnet (8453) has an official deployed Streams verifier. At the inspected snapshot its proxy has no access controller, and its fee manager is a no-op. A new consumer address therefore does not presently need proxy allowlisting or LINK approval. This conclusion concerns the currently deployed onchain access/fee checks. Fetching continuing fresh signed reports still requires authenticated, entitled Data Streams access. The verifier owner can change access/fee configuration, and report signature verification is separate from deciding whether a report is appropriate for a ZEDGE round.

No official native Data Streams deployment on current Horizen L3 (26514) was established from Chainlink's supported-network list. The Base address has no code at that same address on Horizen at the earlier checked block 27,698,004. Base verification plus an authenticated native cross-domain messaging path to Horizen is a separate architecture that needs its own integration review; this document does not attest that messaging path.

## Exact public deployment snapshot

RPC: `https://mainnet.base.org`. Runtime-code snapshot: Base block **52,155,979**, fetched **2026-10-04T08:08:25Z**. Access-controller, fee-manager, and owner getters were rechecked at block **52,156,042** with the same results. Repeat configuration checks at the actual deployment preflight block.

| Component / getter | Observed result |
| --- | --- |
| Official verifier proxy | `0xDE1A28D87Afd0f546505B28AB50410A5c3a7387a` |
| `typeAndVersion()` | `VerifierProxy 2.0.0` |
| `owner()` | `0xd8DeDf4AaE4f319F2667dcB44CE51EB6e838B61b` |
| `s_accessController()` | `0x0000000000000000000000000000000000000000` |
| `s_feeManager()` | `0xb86d1B8a3Bb1c5d7809F5E9EB009311D51d933c6` |
| Proxy runtime size / keccak256 | 7,009 bytes / `0x6a40f4a110509bd2933855d7994b8e1bdf1b1ce7b38c2f2657b7bb335283461a` |
| Fee-manager `typeAndVersion()` | `NoOpFeeManager 0.5.1` |
| Fee-manager runtime size / keccak256 | 3,066 bytes / `0x136464f49592d624e2457e9ddf1cae291d36719708f65d5ea047d77ec3850e05` |

The verified proxy source compiles with Solidity `v0.8.16+commit.07a7930e`, file `src/v0.8/llo-feeds/VerifierProxy.sol`. Its `checkAccess` rejects a caller only when a nonzero access controller rejects `hasAccess(msg.sender,msg.data)`. `verify` and `verifyBulk` call the configured fee manager then route the report's first 32 bytes (configuration digest) to `getVerifier(digest)`. Its owner can change the access controller and fee manager, initialize verifiers, and unset digest routing.

The verified fee-manager source uses Solidity `v0.8.19+commit.7dd6d404`, file `src/v0.8/llo-feeds/v0.5.1/NoOpFeeManager.sol`. `processFee` and `processFeeBulk` collect no fees and perform no subscriber authorization; nonzero ETH is merely refunded. Use zero value. Getter `owner()` reverts because that fee manager does not implement an owner getter. The proxy can still replace it.

Read-only probes from arbitrary sender `0x0000000000000000000000000000000000001234`:

- `verifyBulk([], 0x)` returned an empty array with zero ETH.
- `verify(0x, 0x)` reached `VerifierNotFound(bytes32(0))`, selector `0xb151802b`; it did not fail an access or fee check.

These probes establish reachable access/fee paths only; an empty batch or malformed report does not prove any genuine signature or active feed configuration.

## Canonical BTC/USD and ETH/USD streams

Public discovery request returned exactly these two live mainnet Crypto/CexPrice V3 streams, both with no scheduled decommission date:

```text
https://api.dataengine.chain.link/api/v1/discovery?base_asset=BTC,ETH&quote_asset=USD&asset_class=Crypto&attribute_type=CexPrice&status=live&network_type=mainnet
```

| Asset | Mainnet V3 stream ID | Price decimals |
| --- | --- | --- |
| BTC/USD | `0x00039d9e45394f473ab1f050a1b963e6b05351e52d71e507509ada0c95ed75b8` | **18** |
| ETH/USD | `0x000362205e10b3a147d02792eccee483dca6c7b44ecce7012cb8c6e0b68b3ae9` | **18** |

Discovery confirms IDs/schema/status, but does not include precision. The official Cryptocurrency Data Streams page's rendered metadata contains `decimals:18` alongside each exact feed ID, `sourceChain:42161`, `status:live`, and product name `BTC/USD-RefPrice-DS-Premium-Global-003` / `ETH/USD-RefPrice-DS-Premium-Global-003`. The source chain is report configuration provenance, not evidence that the report can only be verified there. Supported destination proxy configuration must be checked separately.

V3 report layout:

```solidity
struct ReportV3 {
    bytes32 feedId;
    uint32 validFromTimestamp;
    uint32 observationsTimestamp;
    uint192 nativeFee;
    uint192 linkFee;
    uint32 expiresAt;
    int192 price;
    int192 bid;
    int192 ask;
}
```

The `price` is the DON consensus median. Bid/ask are liquidity impact prices, not Pyth confidence intervals. A V3 report carries no exponent field; precision must be bound to the exact stream ID. Fee fields are legacy and do not imply a current per-report fee under the inspected no-op configuration.

Current ZEDGE's `int64` observation cannot hold typical BTC or ETH prices scaled by 1e18. A new adapter must use an explicit normalization and overflow policy, or preserve the full precision in a revised interface. Silently truncating both prices before Up/Down comparison can turn a small real decline into a tie and incorrectly resolve Up. Do not label a zero placeholder or bid/ask spread as a verified Pyth confidence measure.

## Boundary selection and service requirements

Chainlink documents signed validity windows `[validFromTimestamp, observationsTimestamp]` with contiguous, non-overlapping intervals. A boundary adapter can require the fixed boundary timestamp to lie in that signed interval and require the observations timestamp to satisfy the round's maximum delay. It must also require the configured feed ID, supported schema, positive price, valid interval ordering, and defined expiry policy. Accepting any recent report would let a submitter choose an outcome. Normal roughly one-second reporting and typical delivery are not an SLA.

API access is distinct from onchain verification:

- Public Discovery requires no authentication, but returns metadata only.
- Fresh/historical signed report API requests use Data Streams username/API identity, millisecond timestamp, and HMAC secret authentication, plus feed entitlement.
- Current official sign-up docs say subscriptions are paid with no free tier; the portal uses Stripe and 30-day billing periods. Public generic pricing starts at $150/month per selected feed, but this is **not a confirmed BTC+ETH quote**.
- Current EVM tutorial uses `verify(payload, bytes(""))` and does not require consumer LINK balances or FeeManager approval. Onchain transaction gas still costs ETH.
- No Data Streams credentials or subscription entitlement were supplied or inspected in this work. Operating a keeper reliably remains an external setup prerequisite. An old report already published onchain can test cryptographic integration, but cannot replace ongoing API access.

## Minimal integration ABI

```solidity
function verify(bytes calldata payload, bytes calldata parameterPayload)
    external payable returns (bytes memory);
function verifyBulk(bytes[] calldata payloads, bytes calldata parameterPayload)
    external payable returns (bytes[] memory);
function getVerifier(bytes32 configDigest) external view returns (address);
function typeAndVersion() external view returns (string memory);
function s_accessController() external view returns (address);
function s_feeManager() external view returns (address);
function owner() external view returns (address);
```

## Reproduction and sources

Public RPC calls can be reproduced without any wallet:

```sh
cast call 0xDE1A28D87Afd0f546505B28AB50410A5c3a7387a 's_accessController()(address)' --rpc-url https://mainnet.base.org
cast call 0xDE1A28D87Afd0f546505B28AB50410A5c3a7387a 's_feeManager()(address)' --rpc-url https://mainnet.base.org
cast call 0xb86d1B8a3Bb1c5d7809F5E9EB009311D51d933c6 'typeAndVersion()(string)' --rpc-url https://mainnet.base.org
cast call 0xDE1A28D87Afd0f546505B28AB50410A5c3a7387a 'verifyBulk(bytes[],bytes)(bytes[])' '[]' 0x --from 0x0000000000000000000000000000000000001234 --rpc-url https://mainnet.base.org
```

- [Official supported networks](https://docs.chain.link/data-streams/supported-networks) and [official network-list source](https://github.com/smartcontractkit/documentation/blob/main/src/features/feeds/data/StreamsNetworksData.ts).
- [Official crypto streams and precision metadata](https://docs.chain.link/data-streams/crypto-streams).
- [Official public Discovery specification](https://docs.chain.link/data-streams/reference/data-streams-api/discovery-endpoint).
- [Official V3 schema](https://docs.chain.link/data-streams/reference/report-schema-v3).
- [Official report timestamp semantics](https://docs.chain.link/data-streams/how-report-timestamps-work).
- [Official onchain verification interface](https://docs.chain.link/data-streams/reference/data-streams-api/onchain-verification) and [EVM tutorial](https://docs.chain.link/data-streams/tutorials/evm-onchain-report-verification).
- [Official authentication](https://docs.chain.link/data-streams/reference/data-streams-api/authentication), [sign-up](https://docs.chain.link/data-streams/sign-up), and [billing](https://docs.chain.link/data-streams/billing).
- [Actual deployed proxy verified source/ABI](https://base.blockscout.com/api/v2/smart-contracts/0xDE1A28D87Afd0f546505B28AB50410A5c3a7387a).
- [Actual deployed no-op fee-manager verified source/ABI](https://base.blockscout.com/api/v2/smart-contracts/0xb86d1B8a3Bb1c5d7809F5E9EB009311D51d933c6).

The successful genuine-report checks and active digest routing are recorded below.

## Genuine report verification from existing public transaction calldata

Both reports below were obtained from already-public Base transaction inputs, decoded locally, and reverified through the official Base proxy using `eth_call`, zero ETH, empty fee metadata, and arbitrary unregistered sender `0x0000000000000000000000000000000000001234`. No signed-report API access was used. The verified return bytes exactly matched the embedded report. This proves current signature/configuration reachability for these particular reports; it is not a fresh-report service or a ZEDGE adapter integration test.

At the same call block **52,156,042**, `getVerifier(0x00094baebfda9b87680d8e59aa20a3e565126640ee7caeab3cd965e5568b17ee)` returned **`0x223752Eb475098e79d10937480DF93864D7EfB83`**, whose `typeAndVersion()` is **`Verifier 2.0.0`**. Its runtime is 7,285 bytes, keccak256 **`0x148a4acd329ff1e45aa61b6daab662112b6f37788033c7e502c024e25d98c827`**. Its owner is the same `0xd8DeDf4AaE4f319F2667dcB44CE51EB6e838B61b`; `latestConfigDetails(digest)` returns configuration block **30,184,132**. This digest is proven active by successful report verification; it is not claimed to be the newest digest deployed for every stream.

[Verified deployed verifier source](https://base.blockscout.com/api/v2/smart-contracts/0x223752Eb475098e79d10937480DF93864D7EfB83) is Solidity `v0.8.19+commit.7dd6d404`, file `src/v0.8/llo-feeds/v0.5.0/Verifier.sol`. It requires its caller to be the designated proxy, validates the active digest and signer quorum, and returns signed report bytes. It does not impose a second consumer-address subscription gate. Its owner can update signers or deactivate a digest. The verifier does not apply the ZEDGE feed, expiry, interval, precision, or boundary policy for us.

Reproduction: obtain each `eth_getTransactionByHash` input, decode its `verifyReport(bytes)` argument, then call the official proxy's `verify(payload,0x)` through `eth_call` at block `0x31bd68a` (52,156,042), with `value:0` and the arbitrary sender above. Decode the returned `bytes` as the V3 struct. The payloads are also included directly below, so a local fork test can run without a private API credential. Their signed validity windows are single seconds and are **not aligned 5m/15m round boundaries**; do not present them as valid opening/closing observations for a differently timed round.

```json
[
  {
    "chainId": 8453,
    "sourceTransaction": "0xc9d24c37c8676210bc9d69c38dc11cf950d0bd6f9b0e7baa9ae682b25096aa33",
    "sourceBlock": 52155731,
    "callBlock": 52156042,
    "configDigest": "0x00094baebfda9b87680d8e59aa20a3e565126640ee7caeab3cd965e5568b17ee",
    "feedId": "0x00039d9e45394f473ab1f050a1b963e6b05351e52d71e507509ada0c95ed75b8",
    "validFrom": 1791100805,
    "observationsTimestamp": 1791100805,
    "expiresAt": 1793692805,
    "price": "85106875216891330000000",
    "bid": "85103286211105955000000",
    "ask": "85107571670104655000000",
    "decimals": 18,
    "payloadHash": "0x9f8b2e1e8114e38f2b52db9de9236373c294135c2207408c3244289926de17eb",
    "payload": "0x00094baebfda9b87680d8e59aa20a3e565126640ee7caeab3cd965e5568b17ee0000000000000000000000000000000000000000000000000000000003dea9da000000000000000000000000000000000000000000000000000000040000000100000000000000000000000000000000000000000000000000000000000000e0000000000000000000000000000000000000000000000000000000000000022000000000000000000000000000000000000000000000000000000000000003000100010100000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000012000039d9e45394f473ab1f050a1b963e6b05351e52d71e507509ada0c95ed75b8000000000000000000000000000000000000000000000000000000006ac20785000000000000000000000000000000000000000000000000000000006ac2078500000000000000000000000000000000000000000000000000006b84081be0ab0000000000000000000000000000000000000000000000000050a4b25699f805000000000000000000000000000000000000000000000000000000006ae99485000000000000000000000000000000000000000000001205a727be365fad74800000000000000000000000000000000000000000000012057559087749942ec0000000000000000000000000000000000000000000001205b0d20ab84e97f1c00000000000000000000000000000000000000000000000000000000000000006efddf039017510795e7b0f7279063347c56d0dad4631ea457a6f33a94513ae3b2622067aed12ae3ec56fdb64078082091921b1e68af58afb907e44698965d715c5c02c6775746639fce06463553f14e4f1bb1449ba0f3ddccef822fd036680d0c71b3030130d060774331349e776e06da2184570f4a5e8ba1eb77cdb5467a26ac925a886bb878352f453eebc68791619138e69fe9ea943199e15f0bcf5bb6d692f908d08cda1f9e14ed39c51f5184bceebc01ed3944d134c37714cbabaa30ce700000000000000000000000000000000000000000000000000000000000000061c2ac96c09f97c2afb5b3dd55caa75491016494ebe5b6e84d06891ed9959e4a60c9314fa79ba02ab29cb2cb1d450ab5e8f4dfb5f1175ef7edde174557cf5d6f051536597abc4248ce7703c0a80a1ce4ea3349c2a85947514257b04fb4f055ebe120477ac4a1eb3f060041e312130fa72159bc20603183dd3bea0bae72374cc306cae995f2c7706bf869bbf702ed5cde9eb4ed430a0755450e3b158a6ffd68a682ae8c4252444d828015d841398d19a794b358cb30ff90fc03fca695b8aae3925",
    "verificationEqualsReport": true
  },
  {
    "chainId": 8453,
    "sourceTransaction": "0x7e3a19867d7ea0a9f630483a622c6febb9bbfbcf6ef389633218eb73d2d23753",
    "sourceBlock": 52155733,
    "callBlock": 52156042,
    "configDigest": "0x00094baebfda9b87680d8e59aa20a3e565126640ee7caeab3cd965e5568b17ee",
    "feedId": "0x000362205e10b3a147d02792eccee483dca6c7b44ecce7012cb8c6e0b68b3ae9",
    "validFrom": 1791100809,
    "observationsTimestamp": 1791100809,
    "expiresAt": 1793692809,
    "price": "2705204390745000000000",
    "bid": "2704982555236671500000",
    "ask": "2705392498001387650000",
    "decimals": 18,
    "payloadHash": "0xde80470c7e250193802e5af6ef350f4f98ab0661be19acafce7bb69545fe1080",
    "payload": "0x00094baebfda9b87680d8e59aa20a3e565126640ee7caeab3cd965e5568b17ee0000000000000000000000000000000000000000000000000000000003dea9df000000000000000000000000000000000000000000000000000000040000000100000000000000000000000000000000000000000000000000000000000000e00000000000000000000000000000000000000000000000000000000000000220000000000000000000000000000000000000000000000000000000000000030001000001010000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000120000362205e10b3a147d02792eccee483dca6c7b44ecce7012cb8c6e0b68b3ae9000000000000000000000000000000000000000000000000000000006ac20789000000000000000000000000000000000000000000000000000000006ac2078900000000000000000000000000000000000000000000000000006b94fcadac580000000000000000000000000000000000000000000000000050aee36fa4a532000000000000000000000000000000000000000000000000000000006ae99489000000000000000000000000000000000000000000000092a640a4986ebe3a00000000000000000000000000000000000000000000000092a32c86603e412ee0000000000000000000000000000000000000000000000092a8dcef260366fbd000000000000000000000000000000000000000000000000000000000000000068a3b4131db07cff7f9ffb95e526289a7192190d999183d84f96a964af427453fd9b85e01bd084147fa3af366f05a6e0befe2b745dd636d7cf575c223dc4b31e8147b93db99679f1fd00fbe663834e301c36dde8a365fbdf61135719f3e87ac0314742ea1ba7b93dde2f90228499305b1853c5f5dda64c0e471279dabcb4b05c5f11baca07a3cfec1a1a4e6f9dc064d4508afb68896ec1ff068e3b259c90d7e8d22e732e436f16b6701796a13b630eb17374df437542a9d8345cd3053af264eed000000000000000000000000000000000000000000000000000000000000000616ae58a21c782270b49dd5f9c749e4d73aecaaba357470d33f19458ae6960c7670fd9d10883d4248baac57ac3f66df89073729b4bd9bc643a7dd14cc38c4dcae4af3e666a1471defa22691a12d0659c2ba5af2368ae728b11538134ffbcbd30a330e21f935e670e871bfc49e69825237a79cadaa90c147f83fa8818dc3888ce32c1004572919c9c11a546d0db5863c5a3bffb500714908c469e32e7582e5f6110ce91233be157df54dcebe86e65b70d0455e4b1f2f06e495d8fb5c50481bce34",
    "verificationEqualsReport": true
  }
]
```
