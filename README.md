# ZEDGE

ZEDGE is a private order book with two markets: Bitcoin 15-minute Up/Down rounds and one event, "Will Democrats win control of the US House in the 3 November 2026 midterms?" (Yes is Up, No is Down). You deposit native USDC on Base into the ZEDGE vault, trade from a private balance, and withdraw back to Base. Orders are encrypted before they reach the public chain (Horizen, through a Vela application), so other users and chain observers cannot read them. BTC rounds settle on Chainlink's BTC/USD Data Streams reports; the event settles on a signed result under its published rules. A public round registry on Horizen records every round.

Live at **https://zedge-markets.vercel.app**. A separate paper-trading demo with simulated funds is at [`?mode=demo`](https://zedge-markets.vercel.app/?mode=demo).

ZEDGE trades real USDC. Its contracts and engine have not had an independent security audit, and the operator can read every order and balance (see [Trust model](#trust-model)). Read the [Risk Disclosure](https://zedge-markets.vercel.app/risk-disclosure) and [Market Rules](https://zedge-markets.vercel.app/market-rules) before depositing.

## The markets

**BTC 15-minute rounds**

- Every 15 minutes a new BTC round opens. Its opening and closing prices are the Chainlink BTC/USD reports for the exact boundary seconds. If one of those reports is missing, the round uses the round registry's record of that boundary instead.
- Rounds are numbered. Round #1 opened at 06:45 UTC on 7 October 2026 (the first slot after the registry went live) and the number goes up by one every 15 minutes; the site shows it in the round header.
- You buy Up or Down shares at 1 to 99 cents each, and can sell them back before the cutoff. Any part of an order that cannot fill at your price is cancelled.
- Trading stops 30 seconds before the round ends. When the order book's queue is busy, an order sent in the last minute before the cutoff can be refused.
- If the closing price is at or above the opening price, Up wins; otherwise Down wins. A winning share pays 1 USDC into your private balance, and a losing share pays nothing.
- A voided round pays 0.5 USDC per share, Up or Down. It does not refund the price you paid.
- The order book charges no trading fee.

**US House 2026 (the event)**

- The rules are the plain-text file [`public/events/us-house-2026.txt`](public/events/us-house-2026.txt). Its Keccak-256 hash is pinned in the events manifest and in the site, so the rules cannot change under you.
- Trading is open until 3 November 2026 22:00:00 UTC. The result is sent to the order book as an EIP-712 signature by the resolver named in the manifest, under the rules' sources and deadlines; the signature is checked by the guest, and the resolver never needs to send a transaction itself.
- If no result has been posted by 31 January 2027 23:59:59 UTC, the event is void and every Yes and No share pays 0.50 USDC.
- Stake limits, from the rules: for each account, the gap between what it would be paid if Yes wins and if No wins may not pass 50 USDC; added up over all accounts, including the event house, 200 USDC.

## Architecture

```mermaid
flowchart LR
  subgraph Browser
    W["ZEDGE site (src/)<br/>Privy wallet, request encryption"]
  end
  subgraph Vercel
    R["/api/relay<br/>relayer"]
    H["/api/horizen<br/>read proxy"]
    P["/api/btc<br/>price feed"]
  end
  subgraph Base
    V["BaseCustodyVault<br/>holds USDC"]
    SO["Chainlink report check<br/>+ publisher"]
  end
  subgraph Horizen
    I["HorizenDepositInbox"]
    E["Vela endpoint"]
    T["BookClockTrigger"]
    C["HorizenStreamsOracle<br/>price cache"]
    G["StreamsRoundRegistry<br/>public round record"]
  end
  O["Operator: Vela manager + executor<br/>running the ZEDGE guest"]
  S[("Solana: public copies of<br/>Chainlink BTC/USD reports")]
  K["keeper"]
  PS["payout signer"]
  MM["market maker (house)<br/>BTC house + event house"]
  RS["event resolver<br/>(signs the result)"]
  IX[("indexer + Postgres<br/>/v1 read API")]

  W -->|signed permit, signed request| R
  W -->|reads| H
  H -.-> E
  H -.-> G
  P -.->|reads| S
  R -->|depositWithPermit| V
  R -->|submitRequestFor| E
  V -->|native message| I
  E <-->|requests, state updates| O
  E -->|after each update| T
  I -.->|deposit records| T
  G -.->|round records| T
  S --> K
  K -->|exact-boundary report| E
  K -->|publish| SO -->|native message| C --> G
  RS -.->|signed result, relayed by the house| E
  E -.->|payout records| PS
  PS -->|withdraw| V
  MM -->|own requests| E
  MM -.->|quotes, private network| IX
  IX -.->|reads| E
  IX -.->|reads| S
  W -->|reads /v1| IX
```

**Site** ([`src/`](src)). A React and Vite app. Signing in with Google or X through Privy creates an embedded wallet; its address is your deposit address on Base. The site derives a trading key from one wallet signature, registers its public key with the order book, encrypts each request in the browser, and decrypts your receipts. It verifies the pinned deployment manifests in [`public/deployments/`](public/deployments) against both chains before showing round state. The paper demo and the help and policy pages (`/terms`, `/privacy`, `/risk-disclosure`, `/market-rules`, `/support`) are part of the same app.

**Vercel functions** ([`api/`](api) with logic and tests in [`server/`](server)).
- `/api/relay` is the relayer. It checks your Privy sign-in, your own EIP-712 signature and the exact request shape, then sends your USDC permit to the vault on Base, a USDC transfer you confirmed in your wallet from your Base address to another address, or your key registration or encrypted request to the Vela endpoint on Horizen. It pays the gas and the request fee. It never signs for you, and it rate-limits per user and overall. By default it serves only invited accounts.
- `/api/btc` serves recent Chainlink BTC/USD prices, read from public Solana transactions, for the chart when the read API is behind. It does not settle anything.
- `/api/horizen` is a read-only Horizen RPC proxy for the site: allowed methods only, this site's origin only, and a per-visitor budget.

**Matching engine** ([`engine/`](engine)). A deterministic Go ledger for fully collateralized binary shares: deposits, complete-set mint and merge, separate Up and Down books with price-time priority, partial fills, GTC and IOC orders, reservations, settlement, voids, withdrawals and round archival. It has no clock, network access or randomness: time and identity come from the adapter that calls it. See [engine/README.md](engine/README.md) and the command schema in [`protocol/`](protocol).

**Vela guest** ([`adapters/vela/guest/`](adapters/vela/guest)). The engine and a Vela adapter, compiled with TinyGo to a WebAssembly module that Horizen's Vela executor runs. It checks request envelopes, stages book commands until the next chain-time tick, credits Base deposits from the inbox exactly once, publishes payout records for withdrawals, verifies Chainlink report signatures and the event resolver's signature itself, and pads every request and receipt to fixed lengths. Its README is the protocol specification, including what is public and what is trusted.

**Client crypto** ([`adapters/vela/crypto/`](adapters/vela/crypto)). The TypeScript side used by the site and the services: key derivation bound to the deployment, request encryption with Horizen's Vela SDK, the canonical command encoder, request padding and decoders for the guest's public records. Both languages check one shared set of test vectors.

**Contracts** ([`contracts/`](contracts), Foundry).
- On Base: `BaseCustodyVault` holds deposited USDC, numbers each deposit and pays withdrawals signed by the payout signer, within per-payout and daily caps. `ChainlinkStreamsBoundaryOracle` verifies a Chainlink Data Streams report for an exact round boundary through Chainlink's verifier, and `BaseStreamsPublisher` sends the verified price to Horizen over Horizen's native messenger.
- On Horizen: `HorizenDepositInbox` records each vault deposit once for the order book. `HorizenStreamsOracle` caches prices that arrive from the publisher. `StreamsRoundRegistry` schedules, opens, resolves and voids rounds, and is the public record.
- The order book's clock trigger, `BookClockTrigger`, is in [`adapters/vela/stack/contracts/`](adapters/vela/stack/contracts). The Vela endpoint calls it after each state update, and it answers with the chain time, new deposit records from the inbox and round records from the registry. It holds no tokens. `WithdrawOnlyBookClockTrigger` is the implementation a retired application is switched to: it stops crediting deposits and opening rounds, so the old book can only pay out.
- The tree also holds earlier Pyth-based contracts and a public ERC1155 outcome vault. Neither is part of the live system.

**Keeper** ([`services/keeper/`](services/keeper)). At each boundary it takes the exact-second Chainlink report, from the free copies in public Solana transactions or from Chainlink's paid API, and sends it to the order book, where the guest resolves the round, pays winners and opens the next round in one transition. It also publishes the report through the Base contracts so the registry records the round, and creates, opens, resolves or voids registry rounds as their rules require. Every call it makes is permissionless.

**Payout signer** ([`services/payout-signer/`](services/payout-signer)). Reads the guest's public payout records on Horizen and accepts only records from a completed state update of this application. It checks the destination, the amount and the vault's caps, then signs the payout and sends `withdraw` to the vault on Base, paying the gas. The vault pays each payout once.

**Market maker** ([`services/market-maker/`](services/market-maker)). The house liquidity bot, run twice: the BTC house quotes a bid and an ask on Up and Down each round from a fair value based on the BTC spot price, the round's opening price and recent volatility, and pulls its quotes before the cutoff; the event house (the same program with `--event`, its own wallet and its own balance) quotes Yes and No from a public prediction-market price. Both send their own requests and pay their own gas; neither uses the relayer. Their resting quotes are served on Railway's private network to the indexer, and the site shows them as the public order book. The event house also relays the resolver's signed result when it exists.

**Indexer** ([`services/indexer/`](services/indexer)). Follows Horizen and the Solana price copies into Postgres and serves the site's read API under `/v1`: the live round, the latest price and the houses' quotes, a day of minute prices, the last 24 hours of round results, and an account's encrypted receipts, which only that account's key can read. Receipts are kept. It is display only: the site reads the chains when the indexer lags, and nothing settles or moves money through it.

**Container images** ([`deploy/railway/`](deploy/railway)). One Node image runs the keeper, the payout signer, either house or the indexer. The operator runs Horizen's Vela manager and executor images, pinned by digest and unmodified; the manager's container adds a small RPC guard that makes its transaction sends idempotent.

**Scripts, security and research.** [`scripts/`](scripts) builds the WebAssembly, writes the public deployment manifests, runs the protocol conformance check and holds the browser checks and the keeper rehearsal on local forks. [`adapters/vela/stack/`](adapters/vela/stack) holds the operator's own tools: the facts checker, the freeze and the switch-over deployer ([`docs/cutover-politics.md`](docs/cutover-politics.md)). [`security/`](security) holds the internal review records, and [`research/`](research) the design research.

## Life of a trade

Every step below happened on mainnet for one real round and can be followed on the explorers; the hashes are in [contracts/deployment/MAINNET.md](contracts/deployment/MAINNET.md) and the public manifests. Steps 1 to 4 and 14 to 16 move money on Base and are public. Everything between them is a private ledger change inside the operator's executor; the chain only sees fixed-size ciphertext and the public records named in the diagram.

```mermaid
sequenceDiagram
  autonumber
  actor U as You (browser + Privy wallet)
  participant R as Relayer (/api/relay)
  participant V as Vault (Base)
  participant I as Deposit inbox (Horizen, via the native bridge)
  participant E as Vela endpoint (Horizen)
  participant O as Operator executor (runs the guest)
  participant K as Keeper
  participant P as Payout signer

  U->>R: USDC permit, signed in your wallet
  R->>V: depositWithPermit → Deposited(index, your address, amount)
  V-->>I: native message → DepositReceived(index, your address, amount)
  K->>E: tick (encrypted sync request)
  E->>O: run the guest with the new inbox records
  O-->>E: credit record (public: index, address, amount) — your private balance is now funded
  U->>R: encrypted order (2,076 bytes on chain, same as every request)
  R->>E: submitRequestFor(you) — the chain sees your address and the time
  E->>O: run the guest: the order matches against the book (for example the house's ask)
  O-->>E: receipt, 8,220 bytes, encrypted to your key — your fill, position and balance
  K->>E: closing Chainlink report (encrypted request, same size)
  O-->>E: settle record (public: opening and closing price, outcome), and every winning share is credited 1 USDC inside the ledger
  U->>R: encrypted withdrawal request
  O-->>E: payout record (public: your address, amount, ordinal)
  P->>V: withdraw(payout, signature) → Paid(your address, amount)
  V-->>U: USDC arrives at your Base address
```

| Step | What happens | Who pays gas |
| --- | --- | --- |
| Fund | Send native USDC on Base to your deposit address (your Privy wallet). USDC on other networks and other tokens are not credited. | You, from wherever you send it |
| Deposit | Automatic while the site is open and you are signed in: USDC that reached your deposit address from anyone but the vault is deposited (withdrawals and refunds stay on Base). Your wallet signs a USDC permit. The relayer calls `depositWithPermit`; the vault takes 1 to 500 USDC, numbers the deposit and sends a native message to the Horizen inbox. The bridge delivers it in about 20 seconds. | Relayer |
| Credit | On the next tick the trigger hands new inbox records to the guest, which credits each deposit to your private balance exactly once, or refunds it to Base if it cannot be credited. This usually takes about a minute. | Keeper and operator |
| Trade | Your browser encrypts the order and pads it to one fixed length, and your wallet signs the request. The relayer submits it to the Vela endpoint. The guest stages it and applies it at the next tick's chain time. Your receipt comes back encrypted to your key. One-click buys are immediate-or-cancel: they fill against the public quotes or are cancelled, so they never rest in "My orders". | Relayer (gas and request fee) |
| Settle | At the boundary the keeper sends the Chainlink report. The guest checks the signatures, resolves the round and pays winning shares into private balances in the same transition. If that report does not arrive, the round settles from the registry's record. The event settles from the resolver's signed result instead. | Keeper |
| Withdraw | You send a private withdrawal request through the relayer. The guest publishes a payout record. The payout signer checks it and the vault pays USDC to your address on Base, up to 1,000 USDC per withdrawal. | Relayer, then payout signer |
| Send | From your Base address to any other address: you confirm the destination and amount in your wallet (a USDC `transferWithAuthorization`), and the relayer sends it. At least 0.10 USDC. | Relayer |

The operator pays for every state update on Horizen. Once your USDC is at your deposit address, you pay no network fees. USDC never leaves the Base vault except through a payout: the Horizen side holds no tokens, only the encrypted ledger and its public records.

## Privacy: what is encrypted, where, and who holds the keys

```mermaid
flowchart TB
  subgraph You["Your browser (keys live in memory only)"]
    S1["One wallet signature"] --> K1["Trading key pair (P-521)<br/>bound to this deployment, your address and a key epoch"]
    K1 -->|"once, public by design (133 bytes)"| REG["Key registration request"]
    O1["Order / sync / withdrawal as canonical JSON"] --> PAD["Pad to exactly 2,048 bytes"]
    PAD --> ENC["Encrypt (ECDH P-521 + AES-GCM)<br/>to the operator's application key"]
    K1 -.-> ENC
    ENC --> SIG["Sign the request with your wallet (EIP-712)"]
  end
  SIG -->|"2,076-byte ciphertext"| REL["Relayer: checks sign-in and signature,<br/>pays gas, submits for you"]
  REL --> RQ
  subgraph CHAIN["Horizen, public"]
    RQ["RequestSubmitted: your address, time, ciphertext<br/>(every request the same size, whoever sends it)"]
    RC["RequestCompleted + public records:<br/>state root, tick clock, Chainlink report,<br/>deposit credits, settle, payout"]
    UE["UserEvent: 8,220-byte ciphertext per receipt"]
  end
  RQ --> DEC
  subgraph EXEC["Operator's Vela executor (not attested)"]
    DEC["Decrypt with the application key"] --> GUEST["Guest: check envelope, stage until the tick,<br/>run the engine on the encrypted ledger"]
    GUEST --> RCPT["Encrypt the receipt to your registered key"]
  end
  GUEST --> RC
  RCPT --> UE
  UE --> IDX["Indexer stores the ciphertext<br/>(/v1/account returns it unchanged)"]
  IDX --> DEC2["Your browser decrypts:<br/>fills, position, balance, 'You won'"]
  K1 -.-> DEC2
```

Measured on the live chain, not taken from the docs: every request from every sender (you, the house, the keeper, the deployer) is 2,076 bytes of ciphertext on chain (2,048 bytes of padded plaintext inside); every receipt is 8,220 bytes; a key registration is 133 bytes and is the only readable payload. No request can be told apart by its size or shape, so a sync, a buy, a cancel and a withdrawal look identical.

| Anyone reading Base and Horizen can see | Encrypted on chain (readable by you and the operator) |
| --- | --- |
| Deposits and withdrawals on Base, with addresses and amounts; a withdrawal names the account and the destination | Your orders and cancellations |
| Which addresses send requests to the order book, and when | Your balance and positions |
| Each round's prices, result and settlement records; the event's result | Your fills and receipts, and who traded against whom |
| Every request and receipt, at one fixed length, and each new state root | |

Encryption does not hide this metadata or your network traffic. Some smaller channels remain, such as timing and certain refusal reasons; the guest README lists them under "Residual channels" in section 11.

Off chain, the relayer logs each request's type and your wallet address, and Privy, the RPC providers and the web host receive ordinary request data such as your IP address. The [Privacy Policy](https://zedge-markets.vercel.app/privacy) has the details.

## Trust model

- **The operator can read everything private.** The operator runs the Vela manager and executor that hold the order book, and can read every order, balance, position and fill for every account. The public cannot.
- **Nothing proves which code ran.** The executor does not run on attested hardware: the live Vela authenticator contract is Vela's no-attestation variant, and its verified source says so. On this Vela version the manager also supplies the sender, the time and the deposit records the guest sees, so it could impersonate an account, hold back the clock or credit a deposit that never happened. The guest publishes a hash of every trusted input it applied, so a forged input can be proven afterwards, but nothing prevents it. Details: the guest README, "What is trusted or unproven".
- **The operator controls custody.** It signs every withdrawal and owns the vault. Nothing in the software stops the operator from misusing that access.
- **Payout caps.** The vault pays at most 1,000 USDC per withdrawal and 10,000 USDC per UTC day in total. The caps limit what a compromised signer can take in a day, and they mean a withdrawal can wait.
- **Upgradeable contracts.** The vault, the deposit inbox, the round registry and the clock trigger are upgradeable proxies, and their owner can replace their code. The three contracts that verify and deliver prices cannot be upgraded; they rely on Chainlink's verifier and the networks' messenger contracts.
- **The house is the operator.** The operator trades as the house (and as the event house) and is often the other side of your trade. Stake limits apply to each account in each round and to all accounts together at each closing time. The house is exempt from both and has its own total limit.
- **The event's result is one signature.** The resolver named in the events manifest signs Yes or No under the rules file. The guest checks that signature; nobody else can resolve the event, and if no result is posted in time the event voids at 0.50 USDC per share. The operator cannot void it any other way, but it can cause a void by not posting.
- **Forced voids.** Anyone willing to pay network fees can hold back price delivery long enough to void a BTC round, which halves what winning shares pay (see the [Market Rules](https://zedge-markets.vercel.app/market-rules)). The all-accounts stake limit caps how much one closing time can move.
- **Availability.** If the engine, the relayer, the keeper or either network stops, orders, settlement, deposits and withdrawals stop until it recovers. If the operator's engine data were lost, private balances might not be recoverable. When no house is running there are no public quotes, and one-click buys find no counterparty.
- **Current limits.** Two markets (BTC 15-minute rounds and the US House 2026 event), at most 32 accounts in the current application, deposits of 1 to 500 USDC. The full list is under "Limits" in the guest README.

## Repository layout

| Path | Contents |
| --- | --- |
| [`src/`](src) | React site: live market (`chain/`), paper demo (`lib/`, `components/`), help and policy pages (`pages/`) |
| [`api/`](api), [`server/`](server) | Vercel functions (relayer, BTC price feed, Horizen read proxy) and their logic and tests |
| [`engine/`](engine) | Go matching engine and ledger |
| [`adapters/vela/guest/`](adapters/vela/guest) | Vela guest (TinyGo WebAssembly) and its protocol specification |
| [`adapters/vela/crypto/`](adapters/vela/crypto) | TypeScript key derivation, encryption, command encoding and padding |
| [`adapters/vela/stack/`](adapters/vela/stack) | Local Vela stack test harness, the clock trigger contracts and the operator's switch-over tools |
| [`contracts/`](contracts) | Solidity contracts, ABIs, deployment records and deployment scripts |
| [`protocol/`](protocol) | Engine command and configuration JSON schemas |
| [`services/`](services) | Keeper, payout signer, market maker (both houses) and indexer |
| [`deploy/railway/`](deploy/railway) | Container images for the services and the operator |
| [`docs/`](docs) | Operator runbooks, including the Politics switch-over |
| [`scripts/`](scripts) | WebAssembly build, manifest writers, protocol conformance, browser checks, keeper rehearsal |
| [`public/deployments/`](public/deployments) | Public deployment manifests read by the site and the services |
| [`public/events/`](public/events) | The event's rules text, hashed into the events manifest |
| [`security/`](security) | Internal review and verification records |
| [`research/`](research) | Design research |

## Deployed contracts

Everything runs on Base mainnet (chain ID 8453) and Horizen mainnet (chain ID 26514). Contract addresses, code hashes and owners are in the public manifests, which the site checks against the chains:

- [`public/deployments/26514-orderbook.json`](public/deployments/26514-orderbook.json): the Vela endpoint, the application and its WebAssembly hash, the clock trigger, the Base vault, the Horizen inbox, the vault's limits and the stake limits.
- [`public/deployments/26514-events.json`](public/deployments/26514-events.json): the event's rules hash, times and resolver, tied to the same application.
- [`public/deployments/26514.json`](public/deployments/26514.json): the round registry, the Horizen price cache and the Base report contracts, with their upstream dependencies.

Every contract below has its source verified on the chain's explorer (Basescan and Sourcify for Base, Blockscout for Horizen), so the published code can be read against this repository.

| Contract | Chain | Address |
| --- | --- | --- |
| USDC vault (proxy; implementation `BaseCustodyVault`) | Base | [0xf07b81d96b572007c8ea500db1f8095cf0c73d29](https://basescan.org/address/0xf07b81d96b572007c8ea500db1f8095cf0c73d29#code) |
| Chainlink report publisher `BaseStreamsPublisher` | Base | [0xA8abACbD25c9795C3Ef0701184B18Aad6F98C006](https://basescan.org/address/0xA8abACbD25c9795C3Ef0701184B18Aad6F98C006#code) |
| Chainlink verifier adapter `ChainlinkStreamsBoundaryOracle` | Base | [0xdD3bEAA92E5819333A5D5ccD185704427fAB0e91](https://basescan.org/address/0xdD3bEAA92E5819333A5D5ccD185704427fAB0e91#code) |
| Round registry (proxy; implementation `StreamsRoundRegistry`) | Horizen | [0x4DD4aacDb7E8D2e6D06c5af38238F3dEAB836744](https://explorer.horizen.io/address/0x4DD4aacDb7E8D2e6D06c5af38238F3dEAB836744?tab=contract) |
| Price cache `HorizenStreamsOracle` | Horizen | [0xc800C3F18D35D492aE6b07655D7f31bFE98A4B6B](https://explorer.horizen.io/address/0xc800C3F18D35D492aE6b07655D7f31bFE98A4B6B?tab=contract) |
| Deposit inbox (proxy; implementation `HorizenDepositInbox`) | Horizen | [0x7003baebdb7d60d63a219294f4ebad211bbd441d](https://explorer.horizen.io/address/0x7003baebdb7d60d63a219294f4ebad211bbd441d?tab=contract) |
| Clock trigger of the live application (proxy; implementation `BookClockTrigger`) | Horizen | [0xe8122afba04f763d3f0ab43304e8be335efc0e7c](https://explorer.horizen.io/address/0xe8122afba04f763d3f0ab43304e8be335efc0e7c?tab=contract) |
| Clock trigger of the retired application (proxy; implementation `WithdrawOnlyBookClockTrigger`) | Horizen | [0x9ca46470b05350384c31c8b236af4df638cbb30d](https://explorer.horizen.io/address/0x9ca46470b05350384c31c8b236af4df638cbb30d?tab=contract) |
| Vela endpoint `ProcessorEndpoint` (self-hosted) | Horizen | [0x0a2703d21b27757fdf27ab807eae9820788010f3](https://explorer.horizen.io/address/0x0a2703d21b27757fdf27ab807eae9820788010f3?tab=contract) |
| Vela authenticator `NoAttestationTeeAuthenticator` (self-hosted) | Horizen | [0x82a388c040d5b9e557364cc891094470ca090ecc](https://explorer.horizen.io/address/0x82a388c040d5b9e557364cc891094470ca090ecc?tab=contract) |
| Vela token allowlist `TokenAllowlist` (self-hosted) | Horizen | [0xc122da1bbe2a6c45062cda8ee2c5bf16c6cafe73](https://explorer.horizen.io/address/0xc122da1bbe2a6c45062cda8ee2c5bf16c6cafe73?tab=contract) |

The deployment history, creation transactions and verification results are in [contracts/deployment/MAINNET.md](contracts/deployment/MAINNET.md).

## Run the site locally

Use Node.js 22.12 or newer (CI uses 22.22.2).

```sh
npm ci
npm run dev        # http://127.0.0.1:4188/
```

The live market reads Horizen and Base through public RPC endpoints. Vite does not serve the `api/` functions, so locally the price chart has no data and requests cannot be relayed. Sign-in stays closed unless the build sets a Privy app ID (`VITE_PRIVY_APP_ID`). The paper demo at `http://127.0.0.1:4188/?mode=demo` needs no network services.

```sh
npm run build && npm run preview   # production build, same port
```

## Tests

```sh
npm run check                                   # lint, site and server tests, production build, build-output check
npm run test:keeper
node --test services/market-maker/*.test.mjs
node --test services/payout-signer/*.test.mjs
node --test services/indexer/*.test.mjs
npm run test:engine                             # Go 1.25 or newer (CI uses 1.27): race tests and vet
(cd adapters/vela/guest && go test ./...)       # guest, native tests
npm --prefix adapters/vela/crypto ci && npm run test:crypto
bash contracts/scripts/install-deps.sh && npm run test:contracts   # Foundry 1.7
forge build --root contracts && npm run test:protocol              # local EVM rounds against the engine (needs anvil and Go)
```

The guest's WebAssembly and upstream conformance tests skip until the module is built with the pinned toolchain; see [adapters/vela/guest/README.md](adapters/vela/guest/README.md#build-and-test).

## Continuous integration

[`.github/workflows/ci.yml`](.github/workflows/ci.yml) runs on every push and pull request:

- **frontend**: `npm run check`, the keeper, market maker, payout signer and deployment-script tests, and `npm audit`.
- **engine**: `gofmt`, `go vet`, race tests, two fuzz targets and `govulncheck`.
- **contracts**: `forge fmt`, build with sizes, tests, an ABI drift check, `npm audit` and Slither.
- **sdk-crypto-evaluation**: the client crypto tests and `npm audit`.
- **vela-guest**: the guest's native Go tests and the clock trigger's Foundry tests.
- **protocol-conformance**: local EVM rounds through the real registry, with native and TinyGo WebAssembly results compared.
- **secrets**: Gitleaks over the full history.

[`.github/workflows/codeql.yml`](.github/workflows/codeql.yml) runs CodeQL for JavaScript/TypeScript and Go on every push and pull request and weekly. Dependabot checks npm, Go modules and GitHub Actions weekly.

## Security

Report vulnerabilities privately through this repository's **Security → Report a vulnerability** page. See [SECURITY.md](SECURITY.md). Never send a seed phrase or private key, and do not test against another user's account or funds.

## Licence and third-party notices

This repository does not include a licence file. [THIRD_PARTY_NOTICES.md](THIRD_PARTY_NOTICES.md) covers React, Phosphor icons, the Manrope and IBM Plex Mono fonts and TradingView Lightweight Charts; the React, Phosphor and font licence texts are in [`public/licenses/`](public/licenses). Horizen's Vela SDK is an npm dependency, and the operator runs Horizen's published Vela images; no upstream Vela source is copied into this repository.

## Further reading

| Document | Covers |
| --- | --- |
| [adapters/vela/guest/README.md](adapters/vela/guest/README.md) | The order-book protocol: envelopes, ticks, deposits, payouts, Chainlink checks, the event, privacy, trust and limits |
| [adapters/vela/crypto/README.md](adapters/vela/crypto/README.md) | Client key derivation and encryption |
| [adapters/vela/stack/README.md](adapters/vela/stack/README.md) | The local Vela stack test harness and the operator's tools |
| [docs/cutover-politics.md](docs/cutover-politics.md) | The switch-over runbook: freezing one application and starting the next without a pause |
| [engine/README.md](engine/README.md) | Engine API, matching, units and fees, limits and verification |
| [protocol/README.md](protocol/README.md) | Engine command protocol |
| [contracts/README.md](contracts/README.md) | Contracts, registry rules and custody |
| [contracts/deployment/MAINNET.md](contracts/deployment/MAINNET.md) | Mainnet deployment and source-verification record |
| [services/keeper/README.md](services/keeper/README.md) | Round keeper |
| [services/payout-signer/README.md](services/payout-signer/README.md) | Payout signer |
| [services/market-maker/README.md](services/market-maker/README.md) | House market maker, the event house and their pricing |
| [services/indexer/README.md](services/indexer/README.md) | Indexer and the `/v1` read API |
| [security/README.md](security/README.md) | Verification record |
| [security/WHOLE-SYSTEM-REVIEW.md](security/WHOLE-SYSTEM-REVIEW.md) | Internal whole-system review |
| [research/README.md](research/README.md) | Design research |
