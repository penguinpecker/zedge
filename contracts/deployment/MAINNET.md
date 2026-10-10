# ZEDGE hybrid mainnet deployment

Status on 2026-10-06: the replacement round registry is **deployed** on Horizen with the owner's approval: proxy (the registry address) `0x4DD4aacDb7E8D2e6D06c5af38238F3dEAB836744`, implementation `0xA8abACbD25c9795C3Ef0701184B18Aad6F98C006`, owner the deployment account. The live checker verified it against the release, Horizen's explorer accepted both sources, and it holds no rounds yet. [`mainnet-addresses.json`](./mainnet-addresses.json) now has `status: "deployed"`. See [Registry replacement](#registry-replacement).

Status on 2026-10-05: the three route contracts (Base verifier adapter, Base publisher, Horizen price cache) are live and unchanged. The `StreamsRoundRegistry` deployed on 2026-10-04 at Horizen `0xdD3bEAA92E5819333A5D5ccD185704427fAB0e91` is **retired**. Its replacement is **planned and not deployed**; see [Registry replacement](#registry-replacement). The machine-readable record is [`mainnet-addresses.json`](./mainnet-addresses.json) (schema 2, `status: "planned"`).

Status on 2026-10-04 (kept as the record of that deployment): **all four contracts deployed, runtime and immutable configuration checked, and explorer source submissions accepted**. This record covers the public oracle/round infrastructure. A genuine historical BTC report was verified and published on Base, then delivered through the native messenger and authenticated in the Horizen cache.

## Scope

Four noncustodial contracts form one public oracle route: Chainlink report verification and publication on Base (8453), followed by the authenticated native-message cache and BTC/ETH round registry on Horizen (26514). These contracts do not hold trading collateral, accept orders, execute private fills, or deploy Vela.

The public [deployment profile](./hybrid-mainnet.json) pins the upstream code and proxy implementations. The [Base oracle preflight](../../research/chainlink-streams-base.md) and [native-route research](../../research/hybrid-chain-routing.md) contain the dependency evidence. The deployment account was `0x279173ac297aD146bc92f877552C8C2B78334d07`.

## Registry replacement

Deployed on 2026-10-06 (06:39 UTC) after the owner's approval, at the planned addresses and with the planned code; the creations are listed under [Confirmed deployments](#confirmed-deployments). This section kept its planning record below.

**Why.** The retired registry let anyone void an opened round 3,660 seconds after its end if no closing price had been recorded by then. Anyone can raise Horizen's deposit fee on Base high enough that no price message is relayed in that hour, so a losing side could force the 1/2 + 1/2 refund. The retired registry never held a round (zero rounds were created) and holds no funds; it stays on chain and must not be used.

| Contract | Horizen 26514 address | Created by |
| --- | --- | --- |
| StreamsRoundRegistry implementation (UUPS) | `0xA8abACbD25c9795C3Ef0701184B18Aad6F98C006` | deployer nonce 2 |
| StreamsRoundRegistry proxy (OpenZeppelin 5.6.1 `ERC1967Proxy`), the registry address | `0x4DD4aacDb7E8D2e6D06c5af38238F3dEAB836744` | deployer nonce 3 |

The implementation address has the same hex as the Base publisher because the same account uses the same nonce on another chain; the two are unrelated. Both addresses hold only while the deployer's Horizen nonce is 2: any other transaction from the deployer on Horizen moves them, and the planner then refuses to continue unless `--acknowledge-new-addresses` is given.

- Proxy runtime code hash: `0x11e207b629c698e2df1db36c1a5400f670db529ea0461174531deb02e9ad5d56`.
- Implementation runtime code hash at the planned address: `0x5642fc3d45228605d5e0d432ade8910a54a0efe77073a4716b3e65ae5054b3d6`. The implementation embeds its own address, so this hash is different at any other address.
- Creation code hashes: implementation `0x30a43874d1063a0bd1de32c0db919a7d4c0a7be20f7c720d00a1fb5fa5289501`; proxy without constructor arguments `0x81a32a802843b7b7f90cade5b01329ac28faf66d0d0f71fc04ace8311036a4d1`.
- Rules hash: `0x65e485f8468fda2de9d8681ee9fbbff779acabf1451e29a3d2cb2248b2a30ba6`.
- Profile hash (`configHash`): `0xfebe8908e5a7b70fdeeb3ab5b4601ffe5a4e615b41a4c21ccda0f1fc50b5b324`.
- Superseded by the void-grace change below (seven-day profile and its build): implementation runtime `0x731b4e783a2e0f3dbfe2403e899a0e814b55b383083b4489045455a331eb3869`, implementation creation `0x04854b28f7b0b1284490a965dfdc9c35dabf6157acdf80ee37a30926191c0310`, rules hash `0x17258005a90dc55ca45ae167eb0310278363a2ca89d8204437e1d21cc79ac45d`, profile hash `0x11b11575a0a72f35be000e973894266fefbbe8aff2fef024d9878f642308d2bd`.

**Owner and upgradeability.** The proxy's owner is the deployment account `0x279173ac297aD146bc92f877552C8C2B78334d07`. The owner can replace the implementation (`upgradeToAndCall`) and hand ownership over in two steps (`transferOwnership`, then `acceptOwnership` by the new owner). An upgrade can change every rule and the state of every round, so the registry is exactly as trustworthy as that one key. The owner cannot renounce ownership. There is no pause, no outcome setter and no token handling. The three route contracts have no owner and cannot be changed.

**Rules fixed at initialisation.** Price cache `0xc800C3F18D35D492aE6b07655D7f31bFE98A4B6B` (the live, kept one); collateral denomination USDC.e `0xDF7108f8B10F9b9eC1aba01CCa057268cbf86B6c` (stored only); the two stream IDs below at 18 decimals; observation window 60 s; opening grace 150 s; void grace 300 s (five minutes; `initialize` accepts 2 minutes to 21 days); cutoff buffer 30 s. The timing rules are in [Market policy](#market-policy).

**Accepted risk: a short refund window (owner decision 2026-10-06).** The replacement was first planned with a seven-day void grace. The owner chose, knowingly, that an opened round whose closing price has not been cached six minutes after its end can be voided (1/2 + 1/2, not a refund of the price paid): `voidableAfter = end + 60 + 300`. Normal rounds are unaffected: they resolve as soon as the closing price is cached (30 to 40 seconds after the end in the rehearsal), and a cached closing price still blocks any void. The rule also catches ordinary failures: an outage of the report service, the keeper's endpoints or the bridge lasting about eight minutes now voids the round too (the keeper voids about eight to nine minutes after the end), and the void is final even though the report could still be published later. Audit finding D4 is therefore an accepted risk, not a fixed one: anyone can block Base-to-Horizen price delivery by pumping Horizen's deposit fee on Base, and the cost grows with how long the block must be held. At 2026-10-05 Base fees that is about 0.03–0.05 ETH for a few minutes and about 0.4 ETH per hour. One block stops every price message, so it voids every opened round that closes at that boundary at once (up to four at a quarter-hour: BTC and ETH, five and fifteen minutes). With a five-minute window, a trader on the losing side with more than roughly that amount at stake across those rounds can profit by forcing the void, and the winners then receive half of what they were owed. Before real money, stake limits on the total exposure of all rounds closing at the same boundary (or a test-only launch) are needed; that is an open item and is not built.

**What was simulated on 2026-10-05.** The planner executed both creations on a local Anvil fork of Horizen, for the current five-minute profile and build at block 27836281 (20:53 UTC, run with `--acknowledge-release-mismatch` because the profile and build had changed; the release and the website manifest were regenerated from that plan) and earlier for the seven-day ones at block 27808492, each time with the deployer's real account state (nonce 2, real balance, no state or balance overrides) and account impersonation instead of a key. On that fork it then checked: both runtime code hashes against the build, the ERC-1967 implementation slot, `version`, `rulesHash`, `owner`, no `pendingOwner`, all ten configuration getters, `deploymentChainId`, `roundIdFor` for one sample round (BTC, 300 s, start 1791100800: `0xb4bcd96751ad786a84e0a2e4483daddd84a64109509e08578dd779ddbe5814d9`; `0xd6ddd89dd7e2fa4749102c193d25b9ef2c50e0f2ed44769b64f56bd0c1f62e52` under the seven-day rules), and that the bare implementation refuses `initialize`. The broadcaster was then rehearsed, with the seven-day profile and build (not yet repeated with the five-minute ones), on fresh local forks in its rehearsal mode (same steps as the real mode, impersonation instead of signing; fork pinned at Horizen block 27809739, Base read through a pinned local fork), four times with the tools as they stand:

- straight through, followed by the release writer, the live checker and the source-verification packets, all passing against the fork;
- refused before the first signature (the deployer's balance set to zero on the fork): nothing was written, and after the balance was restored the same command planned and completed;
- every send request for the proxy dropped before it reached the fork: the run stopped with the implementation confirmed and the proxy recorded as awaiting submission, and `--resume` verified the implementation from the chain, sent the proxy and completed; the release writer and the live checker then passed;
- with a registry source changed after review and rebuilt (in a scratch copy): the planner stopped, naming the implementation runtime hash; with `--acknowledge-release-mismatch` it planned, and the broadcaster then refused that plan and sent nothing.

No round was created in these runs. The round lifecycle on a Horizen fork was run by the contract fork test on 2026-10-05 and again after the void-grace change, with the five-minute configuration ([`STREAMS-SECURITY-REVIEW.md`](../STREAMS-SECURITY-REVIEW.md); the test is skipped offline and in CI, and its prices are test values). On 2026-10-05 a dress rehearsal ([`scripts/rehearsal/README.md`](../../scripts/rehearsal/README.md)), also with the seven-day profile, deployed the registry the same way on fresh local forks of both chains, at the planned addresses, and ran the keeper through whole rounds and five injected faults with a test verifier, a local report-service stand-in and a harness relay in place of the bridge; no opened round was voided, including one whose closing price was delivered five minutes late. It used no real report, bridge delivery or mainnet fee, and nothing was sent to a public chain.

| Creation | Simulated gas | Gas limit (+25%) | Expected fee at 1,000,252 wei/gas | Signing-time maximum |
| --- | ---: | ---: | ---: | ---: |
| Implementation | 2,765,106 | 3,456,383 | 0.000002767 ETH | 0.000006916 ETH |
| Proxy and `initialize` | 337,007 | 421,259 | 0.000000337 ETH | 0.000000843 ETH |
| Total | 3,102,113 | | 0.000003104 ETH | 0.000007759 ETH |

The profile's hard ceiling for Horizen is 0.00012 ETH; the deployer held 0.000458 ETH there. The maximum counts execution at the fee cap (2,000,504 wei per gas) plus twice the quoted L1 data fee bound.

On 2026-10-06, just before the broadcast, the broadcaster's fork rehearsal was repeated with the five-minute profile and build (Horizen fork at block 27871005): the planner, the broadcaster, the release writer, the live checker and the verification packets all passed, and the fork's registry reported the release's rules hash and a 300-second void grace.

**Procedure once approved** (run on 2026-10-06; see below). Run from the repository root with dependencies installed and `forge build` output present:

```sh
node contracts/scripts/plan-registry.mjs && node contracts/scripts/broadcast-registry.mjs --broadcast-mainnet
node contracts/scripts/write-release.mjs --deployed
node scripts/write-deployment-manifest.mjs
node contracts/scripts/check-hybrid-live.mjs
node contracts/scripts/verify-hybrid.mjs --check-deployed
```

The first line plans afresh (a plan is accepted for five minutes) and sends the two creations; it is the only step that reads the deployer key. The broadcaster re-checks the chain, nonce, balance, fees and upstream bindings before each signature, records each signed transaction in a checkpoint before sending it, verifies each receipt and finally the whole registry. The second line rewrites `mainnet-addresses.json` with status `deployed` and the creation transactions; it only adds those facts and refuses a broadcast of anything other than the registry that file planned. The third regenerates the website's manifest `public/deployments/26514.json` from that release (no RPC, no keys); `npm run check` fails until it has been regenerated, because a test compares the committed manifest with this output. The fourth verifies the release against the chains; the fifth prepares the two Blockscout source-verification packets (it submits nothing).

**Only the reviewed registry is created.** `mainnet-addresses.json` as committed is the record of what was reviewed. Before anything else, the planner and the broadcaster compare what they are about to create with it: the profile hash, the rules hash, the owner, both addresses and both runtime code hashes (the implementation's is recomputed from the current build at the recorded address). If the profile, a contract source or the build output is not what that file records, the planner stops and the broadcaster refuses to sign. The broadcaster has no flag to override this. CI makes the same comparison against a fresh build in the protocol-conformance job.

**Changing what is planned.** To change the profile or the registry source before the deployment: rebuild, run `node contracts/scripts/plan-registry.mjs --acknowledge-release-mismatch` (it names the recorded values that differ), then `node contracts/scripts/write-release.mjs` and `node scripts/write-deployment-manifest.mjs`, and have the resulting change to `mainnet-addresses.json` (and the website manifest generated from it) reviewed together with its cause; update the hashes in this file. Only then will the first line of the procedure run. `configHash` covers every byte of `hybrid-mainnet.json`, endpoints and prose included, so any edit of that file goes through this path, and after the deployment the profile cannot change without a new release record.

**If the run stops.** Nothing wrong can be sent in any of these states; they differ in how to continue.

| What happened | What is left | How to continue |
| --- | --- | --- |
| Refused or failed before the first signature: key file, an endpoint error, fees above the cap, balance, a changed dependency, a release mismatch | No checkpoint; nothing was signed or sent | Remove the cause and run the first line again. |
| Stopped after a transaction was signed | `evidence/registry-broadcast.json` | `node contracts/scripts/broadcast-registry.mjs --resume-mainnet`. Recorded creations are verified on chain. A recorded transaction that never reached the chain (the deployer's nonce is still its nonce and nothing is pending) is signed again, to the same bytes and the same hash, and sent. One that is still pending is left alone: run the command again a little later. |
| Resume answers that the signing window has passed (the first creation is signed within five minutes of the plan, the second within fifteen minutes of the start of the run) | The checkpoint; after this point resume only verifies | If the implementation never reached the chain (the deployer's Horizen nonce is still 2): move `evidence/registry-plan.json` and `evidence/registry-broadcast.json` aside and run the first line again; the addresses do not change. If the implementation is on chain and the proxy is not, see below. |
| A creation that was confirmed is gone again (a chain reorganisation) | The checkpoint; resume stops and signs nothing | Read the deployer's nonce on the explorer and decide by hand; the tool does not send a confirmed creation twice. |

If the implementation was created and the proxy was not sent within the window, the planned addresses are lost. Move both files aside and run `node contracts/scripts/plan-registry.mjs --acknowledge-new-addresses`: the implementation moves to the deployer's nonce 3 and the proxy to nonce 4. Nonce 3 creates `0x4DD4aacDb7E8D2e6D06c5af38238F3dEAB836744`, the address every current record names as the registry, so that address would then hold a bare implementation and must not be used as a registry by anything. Regenerate the release with `node contracts/scripts/write-release.mjs`, have it reviewed, regenerate every record that names the old addresses (the website manifest, the keeper's fixtures, the engine's known round ids), and only then run the first line again, with `--acknowledge-new-addresses` added to the planner. The broadcaster refuses until the committed release names the new addresses.

The same flow can be rehearsed against a local fork without any key: start `anvil --fork-url <Horizen RPC> --chain-id 26514 --block-time 2`, then pass `--rehearsal http://127.0.0.1:8545 --evidence <directory>` to the planner, the broadcaster, the checker and the verifier, and `--evidence <directory>` to the release writer. A rehearsal writes only inside that directory and sends only to the fork; it still reads fee quotes and the Base contracts from the public endpoints.

## Confirmed deployments

| Contract | Chain | Address / verified source | Creation transaction | Block |
| --- | --- | --- | --- | --- |
| ChainlinkStreamsBoundaryOracle | Base 8453 | [0xdD3bEAA92E5819333A5D5ccD185704427fAB0e91](https://basescan.org/address/0xdD3bEAA92E5819333A5D5ccD185704427fAB0e91#code) | [0x8d2fbf2d87150233914cd0dc30927ce3c3c26db2d799193b9887ada3bf8f53ac](https://basescan.org/tx/0x8d2fbf2d87150233914cd0dc30927ce3c3c26db2d799193b9887ada3bf8f53ac) | 52157229 |
| BaseStreamsPublisher | Base 8453 | [0xA8abACbD25c9795C3Ef0701184B18Aad6F98C006](https://basescan.org/address/0xA8abACbD25c9795C3Ef0701184B18Aad6F98C006#code) | [0x203f72b2900bbf586923708a4dd94eba37864e2ac0a4c3a47c19cfdd76be6b1b](https://basescan.org/tx/0x203f72b2900bbf586923708a4dd94eba37864e2ac0a4c3a47c19cfdd76be6b1b) | 52157512 |
| HorizenStreamsOracle | Horizen 26514 | [0xc800C3F18D35D492aE6b07655D7f31bFE98A4B6B](https://explorer.horizen.io/address/0xc800C3F18D35D492aE6b07655D7f31bFE98A4B6B?tab=contract) | [0x4c2c4d101fcf8cb871a30dc3a867f5f54b7ee6ba0de941af36b54b10cd09f6c4](https://explorer.horizen.io/tx/0x4c2c4d101fcf8cb871a30dc3a867f5f54b7ee6ba0de941af36b54b10cd09f6c4) | 27707106 |
| StreamsRoundRegistry implementation (UUPS) | Horizen 26514 | [0xA8abACbD25c9795C3Ef0701184B18Aad6F98C006](https://explorer.horizen.io/address/0xA8abACbD25c9795C3Ef0701184B18Aad6F98C006?tab=contract) | [0x82bb9aeed5ad8fe68bf1293b55e429f423efeb7e777b1217ccbf36084fac98ac](https://explorer.horizen.io/tx/0x82bb9aeed5ad8fe68bf1293b55e429f423efeb7e777b1217ccbf36084fac98ac) | 27871487 |
| ERC1967Proxy = StreamsRoundRegistry (2026-10-06) | Horizen 26514 | [0x4DD4aacDb7E8D2e6D06c5af38238F3dEAB836744](https://explorer.horizen.io/address/0x4DD4aacDb7E8D2e6D06c5af38238F3dEAB836744?tab=contract) | [0x28663ea069e03c53f4cd13ea6d2fa6277dbaf97ffe00e3366836e6eb304f7307](https://explorer.horizen.io/tx/0x28663ea069e03c53f4cd13ea6d2fa6277dbaf97ffe00e3366836e6eb304f7307) | 27871502 |
| StreamsRoundRegistry (**retired 2026-10-05**) | Horizen 26514 | [0xdD3bEAA92E5819333A5D5ccD185704427fAB0e91](https://explorer.horizen.io/address/0xdD3bEAA92E5819333A5D5ccD185704427fAB0e91?tab=contract) | [0x189badafcdaf0e08053f819da006509616ad2621f78f69ffff4acaf6ce13cf8f](https://explorer.horizen.io/tx/0x189badafcdaf0e08053f819da006509616ad2621f78f69ffff4acaf6ce13cf8f) | 27707121 |

The identical address on Base and Horizen is intentional: the same account used the same creation nonce on different chains. The two contracts have different bytecode and roles. Only the Horizen one (the registry) is retired; the Base contract at that address is the live verifier adapter.

### Source verification of the custody, book and Vela contracts (2026-10-11)

Horizen through its Blockscout API without credentials (`forge verify-contract --verifier blockscout`, and the v2 standard-input endpoint for the Vela contracts with the Vela deployer's own compiler input: 0.8.30, viaIR, optimizer runs 0); Base through Sourcify (no key) and then Basescan with the owner's Etherscan API key (`forge verify-contract --verifier etherscan`).

| Contract | Chain | Address / verified source | Creation transaction | Result |
| --- | --- | --- | --- | --- |
| HorizenDepositInbox implementation | Horizen 26514 | [0xfb692fb6346f91edfd3f7903e0d36b7be05d7cd7](https://explorer.horizen.io/address/0xfb692fb6346f91edfd3f7903e0d36b7be05d7cd7?tab=contract) | [0xbaaf988c…22eec](https://explorer.horizen.io/tx/0xbaaf988cfce0a6cd96e9d14cc0351100ff523457af70fa9852f4c01708222eec) | Pass - Verified |
| BookClockTrigger implementation | Horizen 26514 | [0x6f8500186ccb07e3c14ff7bbf1c9b5c05b8ca9a8](https://explorer.horizen.io/address/0x6f8500186ccb07e3c14ff7bbf1c9b5c05b8ca9a8?tab=contract) | [0xb2919007…a979c](https://explorer.horizen.io/tx/0xb291900740edd697bc58b9840632dc31440f6e812917c3f9d9fed660667a979c) | Pass - Verified |
| WithdrawOnlyBookClockTrigger implementation | Horizen 26514 | [0x2bb67a7177ef9351df8a0ce61b4194d34f06da3d](https://explorer.horizen.io/address/0x2bb67a7177ef9351df8a0ce61b4194d34f06da3d?tab=contract) | [0xb165b1db…c05bb](https://explorer.horizen.io/tx/0xb165b1dbc0ae859e14edffcaa28a04d8b46504ef0eecc1e41ac816653afc05bb) | Pass - Verified |
| ERC1967Proxy = BookClockTrigger (application 3714533467436544392) | Horizen 26514 | [0xe8122afba04f763d3f0ab43304e8be335efc0e7c](https://explorer.horizen.io/address/0xe8122afba04f763d3f0ab43304e8be335efc0e7c?tab=contract) | [0x9765a460…301dc](https://explorer.horizen.io/tx/0x9765a4604bb74ad9fa3a26db87b1b3a5a535b7bc3a00c8dc8f023990e4f301dc) | verified |
| ProcessorEndpoint (Vela, self-hosted) | Horizen 26514 | [0x0a2703d21b27757fdf27ab807eae9820788010f3](https://explorer.horizen.io/address/0x0a2703d21b27757fdf27ab807eae9820788010f3?tab=contract) | [0x97cbf496…83a40](https://explorer.horizen.io/tx/0x97cbf496172e235046faeb2471543133704621ac7a45a86ceac4459b78783a40) | fully verified |
| NoAttestationTeeAuthenticator (Vela, self-hosted) | Horizen 26514 | [0x82a388c040d5b9e557364cc891094470ca090ecc](https://explorer.horizen.io/address/0x82a388c040d5b9e557364cc891094470ca090ecc?tab=contract) | [0xa8f85cb0…6700e](https://explorer.horizen.io/tx/0xa8f85cb01a17078d3d47dffa7279c2f632967b83ee7b2d95aad1708c78c6700e) | fully verified |
| TokenAllowlist (Vela, self-hosted) | Horizen 26514 | [0xc122da1bbe2a6c45062cda8ee2c5bf16c6cafe73](https://explorer.horizen.io/address/0xc122da1bbe2a6c45062cda8ee2c5bf16c6cafe73?tab=contract) | [0x5cf10552…0fc4f](https://explorer.horizen.io/tx/0x5cf10552d2ed4b4567dbb03c5557be651a203d84d87826afe2ce81d13450fc4f) | fully verified |
| BaseCustodyVault implementation | Base 8453 | [0xfe5298605390519a9fc0264eefa90c395b9b83a6](https://basescan.org/address/0xfe5298605390519a9fc0264eefa90c395b9b83a6#code) | [0x8cc302ba…62ef1](https://basescan.org/tx/0x8cc302ba75f9c03db5f1c392113675bada90399ed361e169ca43ef2d3df62ef1) | Basescan Pass - Verified; Sourcify exact match |
| ERC1967Proxy = BaseCustodyVault | Base 8453 | [0xf07b81d96b572007c8ea500db1f8095cf0c73d29](https://basescan.org/address/0xf07b81d96b572007c8ea500db1f8095cf0c73d29#code) | [0x1a5a1b87…0e3c9](https://basescan.org/tx/0x1a5a1b87c0e605b14f1fd6a4c166c34281a9eae5b98b6c561a9d8fdc5bf0e3c9) | Basescan Pass - Verified; Sourcify exact match |

The deployed authenticator is Vela's `NoAttestationTeeAuthenticator` (bytes-identical to the deployer's artifact), not `TeeAuthenticator`: the self-hosted operator is not attested. The inbox proxy `0x7003…441d` and the old trigger proxy `0x9ca4…b30d` were already verified as `ERC1967Proxy`.

All four creation receipts succeeded. The live checker compared creation inputs, sender/nonces, deployed runtime hashes, version markers, immutable getters, route and rules, and current upstream bindings. These checks establish consistency with the reviewed deployment artifacts at the recorded blocks; they are not an independent security audit or a finality guarantee.

Build settings: Solidity `0.8.30`, EVM `paris`, optimizer enabled with `200` runs, metadata bytecode hash `none`.

| Contract | Runtime code hash (keccak256) | Creation block hash |
| --- | --- | --- |
| ChainlinkStreamsBoundaryOracle | `0x106db1660240d4c3536f1f62e273b0559db4066af69bbc80db985b57f6d653f8` | `0xe97fa20efcf2f8bf34f2d5aa8c0c8d20c544f69126995c04a6a347c27cf19873` |
| BaseStreamsPublisher | `0x28d74cd48c995b7c396bb75642c3d82d8c3f6b20fe217e09bd2763c38b112d62` | `0xa0e69e00698d0cd587f327a20405ee6cd13bf8771f4533674035156f5fb2ab7b` |
| HorizenStreamsOracle | `0x3996abf69236d59a30795bc2c4262771bf342cd47d76c99c15e4e48d4c50c459` | `0xd8ba088e5c9776e109286dd2df13239b73769f77b15461417a0f4df3627ec894` |
| StreamsRoundRegistry (retired) | `0x901625cddce4c3945fed51c4ee2dd77289ebb69f8e401068f6c2bc9362660a66` | `0xc068b166421addc499312b3181e6812e6fd226a6a80709b689ace8030afd9454` |
| StreamsRoundRegistry implementation (2026-10-06) | `0x5642fc3d45228605d5e0d432ade8910a54a0efe77073a4716b3e65ae5054b3d6` | `0x9acbce4472141225016f75eaf9a3e3be4e35ee9351f65863e5fd17bbdf6795f8` |
| ERC1967Proxy (registry, 2026-10-06) | `0x11e207b629c698e2df1db36c1a5400f670db529ea0461174531deb02e9ad5d56` | `0x86fd244910cd8429838447058d1623a1934667a74d6309bba8c6eb4ab951542c` |

- Route hash: `0xdd0243acfe5c168f4189af435f907cd3dd4a26085faf228e721ddee4e87ac36b`.
- Rules hash of the retired registry: `0x591860792894f856c548d908b50aac9bbecd793794da13ac995bf9d248aa7d7c`.
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

Registry replacement, 2026-10-06, read from the canonical receipts after confirmation:

| Contract | Gas used | Effective gas price (wei) | Execution fee (wei) | L1 data fee (wei) | Observed total (ETH) |
| --- | ---: | ---: | ---: | ---: | ---: |
| StreamsRoundRegistry implementation | 2765106 | 1000252 | 2765802806712 | 581043001 | 0.000002766383849713 |
| ERC1967Proxy and `initialize` | 337007 | 1000252 | 337091925764 | 78549002 | 0.000000337170474766 |

- Horizen total: **0.000003103554324479 ETH**, exactly the deployer's balance change (0.000458256213490358 to 0.000455152659165879 ETH). `getOperatorFee` returned zero. The simulated expectation was 0.000003104 ETH.

The receipts did not expose explicit operator-fee fields. The public `GasPriceOracle.getOperatorFee(gasUsed)` call at each creation block returned zero for all four transactions, so no operator fee is added. No separate blob fee is added on top of `l1Fee`. These totals exclude bridging the account balance, subscriptions, keepers, and any future exchange/custody infrastructure.

The separate Base smoke publication consumed `1,178,694` gas at `6,000,000` wei per gas plus `7,058,681,872` wei L1 data fee, for **0.000007079222681872 ETH**. Its receipt omitted operator-fee fields; the historical operator getter returned zero. Combined creation transactions plus this Base smoke cost **0.000019910990268441 ETH**. The native Horizen relay was a deposited transaction (`type 0x7e`) using `162,474` gas, with receipt `effectiveGasPrice=0` and `l1Fee=0`; it was not a separate transaction signed by the deployment account. No additional destination fee is added to the total.

## Market policy

The route rows are fixed in immutable contracts. The round rows are those of the replacement registry: they are set once at initialisation and can change only through an upgrade by its owner. The retired registry differed in two rows, as noted.

| Rule | Value |
| --- | --- |
| Assets and durations | BTC/USD and ETH/USD; 300 or 900 seconds |
| Schedule | Future start, aligned to the selected duration |
| Price precision | Exact signed `int192` prices, 18 decimals; no price rounding |
| Boundary selection | The fixed start/end must lie inside the verified report's signed validity interval |
| Observation window | At most 60 seconds after the fixed boundary |
| Opening grace | 150 seconds after the observation window; opening deadline is start + 210 seconds |
| Trading cutoff | End − 30 seconds; this public clock does not admit or timestamp private orders |
| Resolution | Any time at or after end, as soon as the closing price is in the Horizen cache; no deadline. (Retired registry: only until end + 3,660 seconds.) |
| Winner | Closing price ≥ opening price resolves Up; otherwise Down |
| Void | Permissionless and terminal. A round whose opening was never recorded: strictly after start + 210 seconds. An opened round: strictly after end + 60 + 300 seconds (six minutes after the end) and only while the cache holds no closing price; once that price is cached the round can only be resolved. Blocking delivery for those six minutes forces this void: an [accepted risk](#registry-replacement). (Retired registry: any opened round strictly after end + 3,660 seconds.) |
| Payout numerators | Up `(2,0)/2`, Down `(0,2)/2`, Void `(1,1)/2`; ratios only, no asset transfer |
| Native delivery gas | 600,000 minimum destination gas |
| Registry collateral denomination | Horizen Stargate-bridged USDC.e, 6 decimals, `0xDF7108f8B10F9b9eC1aba01CCa057268cbf86B6c`; not Circle-native USDC |

Chainlink schema-v3 stream IDs (both 18 decimals):

- BTC/USD: `0x00039d9e45394f473ab1f050a1b963e6b05351e52d71e507509ada0c95ed75b8`.
- ETH/USD: `0x000362205e10b3a147d02792eccee483dca6c7b44ecce7012cb8c6e0b68b3ae9`.

A delayed bridge message cannot replace a fixed boundary with a later price or override an already final outcome; under the replacement registry's rules a late closing price still resolves its round. No ZEDGE contract has an outcome setter. The planned registry's owner can, however, replace its implementation, which is a power over every rule and outcome of that registry; the three route contracts have no such power. Chainlink verification/access/fee configuration, native-bridge proxies, and the collateral proxy remain governed by their upstream owners; the deployment checks pin their current configuration, not future immutability.

## Verification and smoke status

- Registry replacement (2026-10-06): the live checker reported the route and the registry verified (both creation transactions, runtime hashes, implementation slot, owner, no pending owner, every configuration getter, rules hash). Horizen's explorer returned `Pass - Verified` for the implementation and the proxy; as with the 2026-10-04 contracts it classifies both as partially verified (`bytecode_hash none`), and it recognises the proxy as EIP-1967 pointing at the implementation.
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

The checker reads the committed `mainnet-addresses.json` and `hybrid-mainnet.json` and the local build output; it never reads private keys or sends transactions. For the three route contracts it verifies chain IDs, successful canonical creation receipts, that the creation data is exactly the current build with the reviewed constructor arguments, runtime code hashes, immutable configuration, the route hash and the upstream proxy bindings. It also requires the release label, the retired-registry record and, while the status is `planned`, the absence of any recorded creation. For the registry it follows the release status: while `planned`, the planned addresses must still follow from the deployer's nonce and the current build and must hold no code; once `deployed`, it verifies both creation transactions, the proxy and implementation runtime hashes, the implementation slot, the owner, the absence of a pending owner, every configuration getter and the rules hash. On 2026-10-05 it reported the three route contracts verified and the registry planned and not deployed. The public addresses, code hashes, rules, costs, and explorer links needed to inspect the deployment independently are recorded above. The complete constructor/dependency profile is committed in `hybrid-mainnet.json`. The original 2026-10-04 plan and checkpoint under `evidence/` are historical records and are never rewritten by the current tools.

Registry tooling writes its own ignored files: `evidence/registry-plan.json`, `evidence/registry-broadcast.json`, `evidence/streams-live-check.json` and `evidence/registry-verification/`.

Local evidence files of the 2026-10-04 deployment (ignored, public information only): `evidence/hybrid-plan.json`, `evidence/hybrid-broadcast.json`, `evidence/hybrid-live-check.json`, `evidence/hybrid-receipt-costs.json`, `evidence/hybrid-smoke-plan.json`, `evidence/hybrid-smoke-costs.json`, `evidence/hybrid-smoke-result.json`, `evidence/hybrid-smoke-destination-costs.json`, and `evidence/verification/`. A receipt-cost calculation can be reproduced with `eth_getTransactionReceipt`, multiplying `gasUsed` by `effectiveGasPrice`, adding `l1Fee`, and querying `getOperatorFee(uint256)` on `0x420000000000000000000000000000000000000F` at the receipt block. Historical Base reads used `https://mainnet.base.org`; Horizen reads used `https://horizen.calderachain.xyz/http`.

## Remaining operational limits

Ongoing fresh reports require Chainlink Data Streams entitlement and server-side credentials. The bridge’s timing is not a delivery guarantee; the opening deadline and the void rules remain binding, and with the five-minute void grace a delivery blocked on purpose for six minutes voids every opened round closing at that boundary at 1/2 + 1/2 (the accepted risk above; stake limits on the total exposure of all rounds closing at the same boundary, or a test-only launch, are needed before real money). Production private order admission, fills, balances, custody, recovery, Vela availability, and legally eligible operation are separate work. Compilation, automated tests, source verification, and a public-message smoke test do not establish that the full exchange is production ready.
