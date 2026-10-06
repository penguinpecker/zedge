# ZEDGE — Your next move

A complete interactive interface for short-duration Bitcoin and Ethereum prediction markets. Built with React, TypeScript, Vite, self-hosted Manrope and IBM Plex Mono, and Phosphor icons.

**Live:** https://zedge-markets.vercel.app

**Implementation work:** [Contracts](contracts/README.md), [the collateralized Go matching engine](engine/README.md), [protocol](protocol/README.md), and [security checks and remaining release work](security/README.md) are in development. Three public oracle contracts are deployed and unchanged: Chainlink verification and publication on Base, and the price cache on Horizen. The round registry deployed with them on 2026-10-04 was retired on 2026-10-05, before any round was created, because anyone could force a half-payout void one hour after a round's end. Its replacement resolves a round whenever the closing price arrives, lets anyone void an opened round (half a unit to each side, not a refund of the price paid) from six minutes after its end while no closing price has been delivered, and can be upgraded by its owner; the keeper voids such a round about eight to nine minutes after its end unless the closing window was provably skipped. The owner chose that short window on 2026-10-06 knowing that anyone can block price delivery for those minutes, for about 0.03–0.05 ETH at 2026-10-05 Base fees. One block voids every opened round closing at that time (up to four at a quarter-hour), so a trader on the losing side of those rounds with more than that at stake can force the void and halve what the winners receive; stake limits on the total exposure of all rounds closing at the same boundary, or a test-only launch, are needed before real money. The replacement is planned and not yet deployed. See the [mainnet deployment record](contracts/deployment/MAINNET.md). These deployments do not enable custody or private trading. The separate `?mode=chain` interface reads Horizen and supports wallet connection; it shows round state only after verifying the pinned Streams release and its upstream dependencies on both chains, and there are no mainnet rounds to show until the replacement registry is deployed. Funding and trading remain unavailable. The [public round keeper](services/keeper/README.md) implements scheduling, authenticated report retrieval, native delivery tracking, resolution and void handling; it has not been run on mainnet, does not sign while the release is only planned, has been rehearsed only on local forks with stand-ins for the report service and the bridge, and live operation requires Chainlink subscription credentials. The [public outcome collateral primitive](contracts/OUTCOME-VAULT.md) implements backed ERC1155 claims and payouts, is tested but undeployed, and does not provide confidential custody.

**Privacy architecture:** [Horizen/Vela research and production build plan](research/README.md), including private order books, collateral accounting, settlement, recovery, and Builder Fund research. The public application below remains a paper-trading demo; the new foundations do not yet constitute a deployed confidential exchange. An [evaluation-only Vela guest](adapters/vela/guest/README.md) runs the engine on Horizen's local Vela stack, through deposits, withdrawals, the clock, a two-phase private order book and a round mirrored from the registry, with a software enclave, no attestation and a test token; it is not private, secure or production-ready.

**Whole-system review:** [Current findings, tests, trust boundaries and release blockers](security/WHOLE-SYSTEM-REVIEW.md). Internal testing and internal review are not an independent security audit.

**SDK learnings:** [learnings.txt](learnings.txt) records supported primitives, public-order/private-fill limits, operator metadata, sensitive logging, and the implementation work still required.

**Product specification:** [Features, screens, popups, and interaction requirements](research/product-requirements.md) distinguishes existing demo behavior from the production work required.

## Run

Use Node.js 22.12 or newer. No API keys or environment variables are required.

```sh
npm ci
npm run dev
```

Open **http://127.0.0.1:4188/**.

```sh
npm run build
npm run preview
npm run lint
npm test
```

## Included

- BTC and ETH, each with 5-minute and 15-minute recurring rounds.
- Market discovery, asset/duration search, and a saved watchlist.
- Reference-price and probability charts, pointer inspection, opening price, countdown, historical rounds, and a two-sided outcome order book.
- Buy and sell tickets with market or limit orders, amount presets, available balances/shares, fees, potential profit, payout, and review before confirmation.
- Limit orders reserve cash or shares, can be cancelled, and automatically fill when the simulated quote reaches the limit or expire at the trading cutoff.
- Positions, partial or full sales, settlement, claimable winnings, and claimed/lost states.
- Portfolio accounting, open orders, filterable history, and CSV export.
- A demo wallet, local persistence, market rules, onboarding guide, and demo controls for pause, playback speed, finishing a round, and account reset.
- Responsive desktop, tablet, and phone layouts, keyboard-operable controls, native focus-trapped dialogs, reduced-motion support, and a mobile trade shortcut.

## Paper-trading scope

**This is a frontend product prototype, not a live exchange.** Prices, order-book liquidity, outside traders, fills, and funds are simulated and identified in the interface. A fresh paper account starts with $1,000 total, of which $60 is allocated to two sample positions. No credentials, wallet signature, real payment, external order submission, or blockchain transaction is requested.

The simulator uses the same deterministic asset price function for both timeframes, charts, and settlement. Up wins when the closing observation is at or above the opening observation; Down wins below it. Orders stop five seconds before the end. Resolution finalizes three seconds after the end. Winning shares pay $1 and losing shares pay $0. A 1% demo fee is rounded up to whole cents on each fill; payouts are rounded down to whole cents. Cash is stored as integer cents; share quantities have three decimals. Fills are whole-order executions at the available simulated price, with no modeled slippage or partial fills. Hidden tabs advance by elapsed time when the clock resumes; missed intra-tick limit crossings are not reconstructed. Closing the app pauses its persisted clock until the next session.

The demo wallet, rules, clock, and accounting are replaceable modules, not a production custody, pricing, matching, or settlement service. Live launch would require authenticated backend state, actual liquidity and execution, a specified and verified price source, finality handling, funding/withdrawal infrastructure, and the relevant operational controls.

## Design

ZEDGE combines charcoal, mineral green, acid lime, and coral outcome colors. The visual emphasis is on the round and its price boundary: the four launch markets are directly accessible, time is prominent, and the chart and trading decision stay adjacent on desktop. Order-book depth is optional. Buy/sell, open/filled orders, positions, and resolved/claimable payouts are distinct states.

The interface uses an original visual design informed by prediction-market interface research. The recurring round and price-to-beat model can also be seen in [Polymarket’s published BTC round rules](https://polymarket.com/event/btc-updown-5m-1766162400). ZEDGE's demo rules above are its own explicitly defined simulation; they are not a claim about the current rules of any external venue.

## Structure

```text
src/App.tsx                       Navigation, account lifecycle, dialogs
src/lib/market.ts                 Pure exchange model and accounting
src/lib/market.test.ts            Financial-state and round-boundary tests
src/components/MarketBoard.tsx    Market cards, round detail, order book
src/components/PriceChart.tsx     Responsive SVG charts
src/components/TradeTicket.tsx    Buying, selling, quote and validation
src/components/AccountPanels.tsx  Positions, portfolio, history, activity
src/components/Primitives.tsx    Native dialogs and shared controls
src/styles.css                   Responsive design system
scripts/verify-browser.js        Complete browser flow verification
```

Run the browser checks with the local dev server running:

```sh
opera-browser-cli open http://127.0.0.1:4188/
opera-browser-cli emulate --viewport '1440x1050x1' --color-scheme dark
opera-browser-cli run < scripts/verify-browser.js
```

The browser script resets only this app's local paper account, exercises its order lifecycle, and exports a local CSV.

## Help and policy pages

Both interfaces link to `/terms`, `/privacy`, `/risk-disclosure`, `/market-rules` and `/support`. These are separate, directly addressable pages; `?mode=chain` preserves the return path to the chain interface. Reading them never initializes a demo account or connects a wallet. Vercel rewrites support direct visits and reloads.

The Terms and Privacy Policy describe the current preview. They are not final terms for a funded exchange. Before launch, confirm the operator's legal identity, applicable jurisdictions and eligibility, a working private support/privacy contact, actual providers and retention periods, and the final trading/custody policies with qualified counsel. No operator, license, legal venue or email address is invented in the preview.

## Local data and credentials

The demo account stays in browser local storage. It uses the legacy `edge-paper-exchange-v1` key to preserve existing accounts. It does not sync account data to a server.

Environment files, deployment state, private keys, package-manager credentials, local evidence, and generated archives are excluded from Git. Never add credentials to frontend code: values bundled into a browser application are public.
