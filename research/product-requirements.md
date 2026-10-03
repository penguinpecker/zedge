# ZEDGE product requirements and interaction inventory

Reviewed 2026-10-04. This document turns the selected V1 interface and the privacy research into an implementation inventory. It specifies proposed product behavior; it does not claim these features are deployed. The public application remains a paper-trading demo. Requirements are original ZEDGE product decisions unless explicitly marked open or conditional.

## Reading this inventory

- **P0:** required before a real-money release of the affected flow. A dependent feature stays disabled until its gate closes.
- **P1:** required for the complete four-market experience, after the first BTC 15-minute test slice; not a reason to bypass P0 financial/privacy gates.
- **Later:** optional expansion, enabled only with its own reviewed protocol and product support.
- **Demo:** a visible approximation exists in V1. It is not a production implementation.
- **New:** absent from V1 and required to build.
- **Conditional:** depends on an explicit product, deployment, provider, or operating decision. No dormant button should imply availability.
- **Backend:** an authoritative service, contract, ledger, or verified encrypted receipt is required. Browser state cannot grant balances, fills, cancellations, or settlement.

Requirement IDs are stable. `REQ-*` defines behavior; `UI-*` defines a route or screen; `DLG-*` defines a dialog or drawer; `INT-*` defines a small interaction; `STATE-*` defines a reusable state; `QA-*` defines acceptance scenarios. A dialog inherits the shared interaction contract below and adds its specific validations and outcomes.

Source baseline: [current V1 README](../README.md), [App.tsx](../src/App.tsx), [TradeTicket.tsx](../src/components/TradeTicket.tsx), [MarketBoard.tsx](../src/components/MarketBoard.tsx), [AccountPanels.tsx](../src/components/AccountPanels.tsx), [Primitives.tsx](../src/components/Primitives.tsx), [market.ts](../src/lib/market.ts), [architecture](private-orderbook-architecture.md), [Vela review](vela-protocol.md), [latest SDK learnings](../learnings.txt). Read the latest learnings alongside the older research: recipient metadata and the raw-result logging path add privacy gates.

## What actually exists in V1

| Existing surface | Current behavior | Production gap |
| --- | --- | --- |
| Markets, Portfolio, History | Three navigable hash-route views; direct market/round selection | Authoritative pagination, authentication, account synchronization, malformed and missing round handling |
| Four market cards | BTC/ETH × 5m/15m, watchlist, current prices/countdowns | Real published market manifests, availability and freshness |
| Round detail | Price-to-beat, price/probability chart, previous rounds, optional two-sided book | Chart is synthetic; book is synthetic; historical result is locally calculated |
| Ticket | Buy/sell, market/limit, amount presets, balances, fees and payout estimate | No real matching, slippage, partial fills, wallet authorization, queue or confirmation handling |
| Positions and orders | Simulated reserved funds/shares, cancellation, sale, expiry, claim | Local reducer is authority; fills execute whole orders against simulated prices |
| Portfolio/history | Totals, settled positions, claim-all, filters, CSV | Verified private state, cost-basis policy, reconciliation, receipt/key failures |
| Activity | Simulated outside traders or own paper activity | Must not become fabricated live trades or publish private trading relationships |
| Dialogs | Search, demo funds, rules, help, demo settings, reset, order review | Wallet, keys, real deposit/withdrawal, claims, recovery and transaction lifecycle are absent |
| Storage and account | Browser local storage, seeded $1,000 demo account including sample positions | No wallet, custody, backend or real funds; preserve a separate demo environment |
| Accessibility/mobile | Native dialogs, focus handling, skip link, reduced motion, responsive layouts | Every new async and financial flow needs equivalent behavior and verification |

The demo's 1% fee, five-second cutoff, three-second resolution delay, seed balances, playback controls, and synthetic probability model are not production parameters. Retain the chosen charcoal/lime ZEDGE V1 identity; this inventory is not a redesign request.

## Product contract and explicit boundaries

| ID | Priority / baseline | Required behavior and acceptance criterion |
| --- | --- | --- |
| REQ-001 | P0 / Demo + Backend | Trade binary **Up/Down shares**, not leveraged directional positions. For valid resolution, one winning share redeems for one collateral unit and the loser for zero. Show collateral symbol, decimals and contract identity; do not imply its market peg is guaranteed. |
| REQ-002 | P0 / New + Backend | Initial vertical slice is one BTC 15m test market. Four-market target is BTC/ETH × 5m/15m. Unsupported networks/assets/durations are not selectable as funded markets. |
| REQ-003 | P0 / New + Backend | Separate environment status (`Demo`, `Testnet`, `Production`) from privacy status (`Unavailable`, `Unverified`, `Verifying`, `Verified for this deployment`, `Failed`). A production network alone never earns a privacy badge; an emulator never earns hardware-attested status. |
| REQ-004 | P0 / Demo + Backend | Use distinct immutable round identity: chain, endpoint/application, collateral, asset/feed, start/end and rules version. `btc-5m` identifies a template, not a funded round. Every ticket, order, receipt and position references the exact round. |
| REQ-005 | P0 / New + Backend | Fully fund buys with collateral and fees and sells with owned available shares. No naked sales, margin, leverage, liquidations, funding-rate widgets, or perpetual-futures terminology. |
| REQ-006 | P0 / New | A persistent environment label and actual data-source labels remain visible at trading decisions. Demo controls and balances cannot appear in a production account. |
| REQ-007 | P0 / New + Backend | Never report browser success as execution. Submission, admission, acceptance, execution, ledger confirmation and chain finality are separately represented where applicable. Unknown state remains unknown until reconciled. |
| REQ-008 | P0 / New | Keep trading accessible without popups on every market selection. Reading prices/rules does not require a wallet. Request signatures only for an explicit action and explain their actual purpose. |

### Privacy matrix: target behavior and current limitations

This is the proposed information policy. “Private” below means confidential within a verified, hardened deployment; it does not describe today's demo. Public order-by-order data can make fills reconstructable even when receipts are encrypted.

| Information | Public observers | Outside-enclave operator | User |
| --- | --- | --- | --- |
| Published market rules, times, oracle result, selected bid/ask quotes | Visible by design | Visible | Visible |
| Approved aggregate depth/volume | Visible only if explicitly enabled under a publication policy | Same public data, plus observable operational metadata | Same public data |
| Exact resting private order, limit, quantity and personal remainder | Intended encrypted; timing/size patterns may leak | Intended unreadable after encryption/logging gates; no blanket anonymity claim | Own orders decrypt locally |
| Personal fill price, quantity, fees and ledger balances | Intended encrypted; may be inferred from public books/funding | Intended encrypted contents, but reviewed runtime exposes receipt recipient IDs to manager | Own receipts and state decrypt locally |
| Maker/taker relationship | Could be inferred from public orders, exact depth changes or transaction correlations | Current recipient metadata can reveal relationships; hiding it needs runtime changes | Own receipt; counterparty identity not automatically shown |
| Wallet sender, facilitator, request timing, deposits, public pending claims/withdrawals | Public chain footprint in standard flow | Also visible | Visible; explain before funding |
| IP address, browser/session/network timing | Not inherently published to everyone | Relays/hosts may observe them according to actual routing/logging | Disclosed data policy; TEE does not hide them |
| Support export or voluntary account report | Not public by default | Only explicitly chosen recipients should receive chosen data | Preview fields and consent before export/disclosure |

**Privacy launch gates:** remove/harden the raw WASM deposit-result INFO logging path and inspect deployed logs; decide and document recipient metadata exposure; verify actual browser encryption, enclave identity, application fingerprint, key handling and upgrade policy. Encrypted receipts alone do not justify “anonymous trades,” “invisible fills,” “operator cannot see who traded,” or “no data leakage.” These are code findings and requirements, not a demonstrated exploit or completed fix. See [learnings.txt](../learnings.txt).

## Screens and navigation

Paths below describe logical routes; the implementation may retain hash routing. A round URL must resolve the same immutable round after refresh or sharing.

| ID | Priority / baseline | Route or surface | Required content and acceptance |
| --- | --- | --- | --- |
| UI-01 | P0 / Demo | Markets `/markets` | Four launch templates when enabled; asset/duration filters, watchlist, market status, next/current round and selected quotes with timestamps. No synthetic live liquidity in funded mode. |
| UI-02 | P0 / Demo | Round `/markets/:template/rounds/:roundId` | Exact round rules, price-to-beat, source, chart, cutoff/end, public quote panel, ticket and own account context. Historical/upcoming states are explicit. |
| UI-03 | P0 / Demo | Portfolio `/portfolio` | Available collateral, order reservations, positions, pending settlement, redemption/withdrawal balances and method-labeled P&L. Locked private data is not represented as zero. |
| UI-04 | P0 / Demo | History `/history` | Orders, individual fills, transfers, mint/merge, resolutions, redemption and claims; filters, pagination and receipt details. Each item links to exact round and command. |
| UI-05 | P0 / New | Funding `/account/funding` | Token/network balances, deposit, withdrawal and pending-claim tracker. Keep bridge transfer separate. Resume any unfinished step after refresh. |
| UI-06 | P0 / New | Account/privacy `/account/security` | Wallet, chain, encryption-key epoch, deployment verification, session state, local lock, recovery route and disclosure policy. No secret key displayed by default. |
| UI-07 | P1 / New | Settings `/settings` | Appearance, time/number display, trading defaults, privacy of balance display, notifications, accessibility and local-cache controls. Defaults never change signed orders already in flight. |
| UI-08 | P0 / Demo | Rules/help `/help` and per-round rules | Binary payoff explanation, fee example, sell-before-close explanation, no-fill risk, cutoff, oracle, privacy boundary, funding/claim separation and known failures. |
| UI-09 | P0 / New | Status `/status` | Market-data, oracle, request queue, ledger, chain/indexer and withdrawal health with last check. An independent status location remains reachable when app backend fails. |
| UI-10 | P0 / New | Receipt `/account/activity/:commandId` | Own authorized operation lifecycle, fills, fees, canonical references, reason codes and next valid action; no public route that decrypts by URL alone. |
| UI-11 | P0 / Conditional | Liquidity `/liquidity` | Funded mint/merge and private inventory controls for approved LP workflow; omit from retail navigation if restricted, but liquidity operations still require a supported audited interface. |
| UI-12 | P0 / New | Unknown/deep-link failure | Distinguish invalid URL, valid unavailable round, wrong environment, not authorized and archived data unavailable. Offer return to markets without silently substituting another round. |
| UI-13 | P0 / New, internal | Operations console | Separate authenticated role-restricted application; no admin controls in the public trading bundle. See operations requirements below. |

## Functional requirements

### Discovery, round identity and market data

| ID | Priority / baseline | Behavior and acceptance criterion |
| --- | --- | --- |
| REQ-010 | P0 / Demo + Backend | Market card shows asset, duration, exact current round, open/closed/pending status and executable-side quote age. Search accepts Bitcoin/BTC, Ethereum/ETH and 5m/15m; empty matches offer clear filters. |
| REQ-011 | P1 / Demo | Watchlist changes are immediate, reversible and account/environment scoped. A missing favorite remains “unavailable” until removed, not replaced by a different market. |
| REQ-012 | P0 / Demo + Backend | Header distinguishes trading cutoff from round end and resolution pending. Countdown uses synchronized time as a display estimate; only canonical admission rules decide whether an order is valid. Show UTC timestamps and optional local-time equivalent. |
| REQ-013 | P0 / New + Backend | Publish immutable feed ID, collateral, opening/closing boundary rule, precision, tie behavior, cutoff, fees, expiry and failure policy before trading. An edited template affects future rounds only; every historical round retains its own rules hash/version. |
| REQ-014 | P0 / New + Backend | Trading cannot begin without a verified canonical opening observation. “Opening price pending” has no guessed price-to-beat and disables funded orders. |
| REQ-015 | P0 / Demo + Backend | Price chart identifies display provider and last observation; settlement source appears separately. Display-feed price crossing does not assert resolution or execution. Chart gaps remain gaps; no invented candles or interpolation labeled as observed data. |
| REQ-016 | P0 / Demo + Backend | Probability/outcome-price chart identifies whether it uses bid, ask, midpoint or eligible trade data. Missing data is blank/unavailable, not a fabricated 50%; thin spreads or invalid quotes do not produce misleading certainty. |
| REQ-017 | P0 / New + Backend | Snapshot plus incremental feed uses sequence numbers, round ID and source timestamps. Duplicates are ignored; gaps trigger resnapshot; out-of-order and previous-round messages cannot move current prices backwards. |
| REQ-018 | P0 / Demo | Chart includes open/reference line, observation timestamp, pointer and keyboard inspection, readable units, round bounds, current/closing label and non-color outcome indication. Zoom/inspection never changes the trading round. |
| REQ-019 | P0 / New | Initial card/ticker load and reconnect show distinct placeholders, then the first real snapshot. Set measured frontend freshness/render budgets per actual provider; do not animate old numbers to imply fresh ticks. |
| REQ-020 | P0 / Demo + Backend | Current, next and historical navigation preserves selected round identity. An upcoming round is inspectable but cannot accept orders until enabled by protocol. History shows verified settled/pending/void status rather than recalculating from chart data. |
| REQ-021 | P0 / New | Safe rollover: a pristine live view may follow the next round, but a nonempty ticket, open review, wallet signature or pending submission remains pinned to its original round. Show “This round closed” and an explicit “Open next round”; never sign or submit to a silently substituted round. |
| REQ-022 | P0 / New | Reject old-round submissions after cutoff under canonical policy, even if browser clock is wrong or tab slept. Refreshing, changing timezone or device-clock changes cannot reopen trading. |

### Public market display and private account display

| ID | Priority / baseline | Behavior and acceptance criterion |
| --- | --- | --- |
| REQ-030 | P0 / Demo replacement + Backend | Default public panel shows selected bid/ask quotes, spread, timestamp and quote validity. It does not label a selected quote as guaranteed executable quantity or a complete order book. |
| REQ-031 | P1 / Conditional + Backend | Aggregate depth is optional and explicitly labeled coarse/delayed if applicable. Specify price buckets, size buckets, cadence, minimum participation and suppression policy; leakage review precedes enablement. No individual wallet/order IDs in public depth. |
| REQ-032 | P0 / Demo replacement | Replace synthetic outside-trader feed in funded mode. Prefer public market events plus a private “Your activity” tab. A public fill tape is a separate disclosure decision and cannot be assumed compatible with hidden fills. |
| REQ-033 | P0 / New | Own orders show exact signed price/size, filled/remainder, reserved assets, expiry, status and receipts only after authorized decryption. Masked/locked/unreadable accounts have explicit states, never zero holdings. |
| REQ-034 | P0 / New | Privacy details describe public chain footprint, operator recipient metadata, inference from visible quotes/depth, and authorized disclosure. No anonymity guarantee appears in onboarding, badges, tooltips, support copy or marketing. |
| REQ-035 | P0 / New + Backend | All unpublished order inputs and decrypted account data stay out of public analytics, request URLs, crash payloads and ordinary logs. Error tracking uses allowlisted reason codes and public operation IDs. Verify actual network requests, logs, sourcemaps and telemetry configuration. |
| REQ-036 | P0 / New + Backend | Enclave measurement, application version, key epoch and deployment identity are verified before confidential submissions. Failed verification blocks new private mutation; never fall back silently to plaintext or a software emulator. Read-only public data remains usable. |
| REQ-037 | P0 / New | Wallet disconnect/local lock hides decrypted account state and clears appropriate in-memory caches, but explicitly does not cancel accepted orders, revoke sessions or withdraw assets. Notification bodies obey the chosen privacy setting. |
| REQ-038 | P0 / New + Backend | Historical encrypted events are recoverable only under an explicit key-epoch policy. Distinguish missing indexer data, key mismatch, lost key and corrupt receipt; do not tell the user an unreadable history means no trades. |

### Trading, matching and order lifecycle

| ID | Priority / baseline | Behavior and acceptance criterion |
| --- | --- | --- |
| REQ-040 | P0 / Demo + Backend | Ticket always shows exact asset, duration, UTC round, Up/Down, buy/sell, quantity unit and collateral token. Buy budget and share quantity are separate modes; sell input is owned available shares. Switching mode explains recalculation and never changes an order under review. |
| REQ-041 | P0 / Demo + Backend | Support resting limit and price-protected immediate-or-cancel orders initially. “Buy now/Sell now” explains it may partially fill or not fill. No unbounded market execution and no invented liquidity. |
| REQ-042 | P0 / New + Backend | Deterministic matcher uses eligible best price, then canonical accepted sequence, at maker price. Define self-trade prevention and maximum traversal/work; receipts expose own execution facts without requiring counterparty identity. |
| REQ-043 | P0 / Demo + Backend | Parse decimal input as bounded integers. Validate nonempty finite decimal syntax, precision, positive lot, valid tick, min/max size/notional, maximum active orders, valid outcome and market status. Reject unsupported scientific notation and integer overflow consistently in UI and engine. |
| REQ-044 | P0 / New + Backend | Price, lot size, fee schedule and hard limits come from versioned market configuration. Proposed 1¢ tick and 0.001-share lot are not hard-coded before collateral/precision review. Near-zero/near-one prices must remain within the chosen valid range. |
| REQ-045 | P0 / Demo + Backend | Buy reserves worst permitted notional plus fee cap; sell reserves available shares. Max-buy includes all trade costs within budget; separate ETH gas/application fees do not reduce collateral silently. Cross-market tabs cannot reserve the same money twice. |
| REQ-046 | P0 / Demo + Backend | Review separates estimated execution price, worst acceptable price, quantity, maximum spend/minimum proceeds, trading fee, network/application charges, winning payout and maximum loss. A payout is not profit; net profit subtracts actual cost and fees. |
| REQ-047 | P0 / New + Backend | Slippage protection is an explicit limit, not a promise. Requote when review materially changes and require a new confirmation of changed signed fields. Quote expiry, fee-cap changes or cutoff disable confirmation with a precise reason. |
| REQ-048 | P0 / New + Backend | Intent binds domain, account, round, side, outcome, type, tick/quantity, expiry, fee cap, authorization epoch and unique client ID. Wallet message is human-readable; encrypted order submission never leaks its plaintext into an untrusted relay body. |
| REQ-049 | P0 / New + Backend | Duplicate clicks, wallet retries, refresh and transport timeouts produce at most one order for the same intent ID. First query the prior operation after an unknown outcome; a new signed intent is not used as an automatic retry. |
| REQ-050 | P0 / New + Backend | Show draft → awaiting signature → submitting → submitted/queued → accepted/open → partially filled → filled, plus cancelled, expired, rejected and failed. Expose stage-specific reasons; chain submission success is not matching acceptance. |
| REQ-051 | P0 / New + Backend | Each partial fill updates cumulative quantity, average price, actual fees, remainder and reservations atomically. Fill receipts sum to totals; no rounded display value is fed back into ledger arithmetic. |
| REQ-052 | P0 / Demo + Backend | Cancel is a separate authorized command. Until confirmed show “Cancel requested”; a fill ordered earlier remains valid. Cancel only the remaining quantity and release its correct reserve once; zero remainder returns an informative final state. |
| REQ-053 | P1 / New + Backend | Cancel-all declares scope (this round, this market, or all account orders), count and affected reserve. Report per-order results/accepted epoch, including filled-before-cancel cases. Never imply disconnect is cancel-all. |
| REQ-054 | P1 / New + Backend | Replace order is cancel-and-replace unless a different audited mechanism is selected. Explain lost queue priority. If cancel succeeds but replacement fails, show cancelled old order plus failed new attempt; do not restore it locally. |
| REQ-055 | P0 / New + Backend | IOC cancels unfilled remainder; resting orders expire no later than market cutoff and their signed expiry. Show partial+expired and partial+cancelled explicitly; fulfilled quantity is retained and remainder released. |
| REQ-056 | P0 / Demo + Backend | Sell a position only from available inventory before trading closes. “Sell all” excludes reserved shares and previews possible partial fill. Holding through resolution is redemption, not a sell at an assumed executable price. |
| REQ-057 | P0 / New + Backend | Accounting uses integer collateral/share atoms, cumulative per-order fee rounding and explicit dust policy. Ledger conservation, no negatives, no double credit, no oversell and replay invariants pass model tests. |
| REQ-058 | P0 / New + Backend | Canonical cutoff/order sequencing handles delayed pre-cutoff intent, queue saturation, cancel races and observed outcome without a hindsight option. A browser countdown or historical time checkpoint alone is insufficient. Block production while this remains unresolved. |
| REQ-059 | Later / Conditional | Stop/conditional orders, fill-or-kill, post-only, batch auctions, scoped session trading, APIs and strategies require separate semantics, data inputs, authorization, capacity and leakage tests. Do not expose these as nonfunctional ticket options. |

### Collateral, liquidity, wallet and keys

| ID | Priority / baseline | Behavior and acceptance criterion |
| --- | --- | --- |
| REQ-060 | P0 / New + Backend | Deposit flow specifies exact network, accepted token address, decimals, minimum/maximum and required gas. Unsupported assets/networks are rejected before signing. Token ticker alone is not identity. |
| REQ-061 | P0 / New + Backend | Token approval/permit and actual deposit are distinct steps with spender, allowance, expiry and gas clearly shown. Prefer a bounded amount; unlimited approvals require explicit opt-in if offered. Wallet rejection is recoverable without an automatic new request. |
| REQ-062 | P0 / New + Backend | Deposit progress distinguishes wallet broadcast, canonical chain confirmation and private-ledger credit. Crediting is idempotent per accepted deposit. Failed processing and public refund/pending-claim paths are trackable. |
| REQ-063 | P0 / New + Backend | Withdrawal preview displays destination, network, amount, available amount after reservations, fees and public metadata. Approved private-ledger debit, public pending claim and final wallet transfer are separate steps; each is counted once. |
| REQ-064 | P0 / New + Backend | Claims panel distinguishes winning-share redemption into the internal balance from claiming already authorized on-chain funds. “Claim all” states exactly which operation it batches; partial failures leave succeeded items complete and retryable items explicit. |
| REQ-065 | P0 / New + Backend | Bridge funding/exit is a separate external or integrated flow with its own network/token, fees, finality and recovery. Never label internal withdrawal time as bridge completion time or treat a bridge deposit as already spendable. |
| REQ-066 | P0 / New + Backend | Mint a complete set by locking one collateral unit for one Up and one Down share of the same round. Merge only a fully owned available pair from that round. Show locked collateral, quantities, fees, supply and effect on free inventory. |
| REQ-067 | P0 / New + Backend | A funded LP workflow must create executable inventory and two-sided offers. Monitor no-liquidity and one-sided liquidity states; automated quotes may not overreserve shares/cash. Private inventory is not advertised as guaranteed depth. |
| REQ-068 | P0 / New + Backend | Wallet connection lists supported providers only, reads chain/account and handles provider absence, rejection, timeout and mobile return. Switching account clears old decrypted UI and rebinds pending operations to their original account. |
| REQ-069 | P0 / New + Backend | Wrong-chain recovery asks to switch to the configured chain and verifies the result. Any add-network request uses verified configuration. No arbitrary chain settings or RPC URL supplied by an untrusted route. |
| REQ-070 | P0 / New + Backend | Separate wallet authentication, encryption-key association, transaction approval and optional session delegation. Explain whether signing costs gas and what it authorizes; do not present a broad authorization as “just logging in.” |
| REQ-071 | P0 / New + Backend | Key setup binds deployment/application and key epoch under reviewed derivation/storage rules. Backup/recovery policy is established before funded use. Never request a wallet seed phrase or send decryption keys to the server/support. |
| REQ-072 | P0 / New + Backend | Rotation tracks old and new epochs, queued requests and historical receipt access. Completion requires authoritative association; an old request cannot silently be decrypted with a guessed key. Lost-key recovery states exactly what can/cannot be restored. |
| REQ-073 | P0 / New + Backend | Reject requests for a mismatched account, domain, nonce or revoked epoch. Refresh and multiple devices reconcile accepted state. A stale session cannot grant authority by reading cached local storage. |
| REQ-074 | P0 / New + Backend | Publish tested operator-outage withdrawal/recovery behavior before real funds. If no unilateral exit exists, disclose the dependency and keep production gated until a reviewed custody/recovery model is selected. Do not invent a “force withdraw” button. |
| REQ-075 | Later / Conditional + Backend | Scoped session keys define exposure, markets, token, expiry and allowed actions; withdrawal disabled by default. Separate local disconnect from on-chain/ledger revocation and show pending revocation honestly. |

### Settlement, portfolio and history

| ID | Priority / baseline | Behavior and acceptance criterion |
| --- | --- | --- |
| REQ-080 | P0 / Demo + Backend | Market lifecycle is scheduled → opening pending → trading → closed → resolution pending → resolved, with explicit paused/failure/void branches. The result comes from canonical committed observations, never the chart or browser clock. |
| REQ-081 | P0 / New + Backend | Rules define feed, observation-selection window, precision, ties, lateness/confidence policy, finality, allowed dispute and missing-evidence response. Freeze opening evidence before trading and capture required history at boundaries. |
| REQ-082 | P0 / New + Backend | Close and expire/cancel remaining orders before redemption. Replayed resolution is idempotent. User sees exact opening/closing values, timestamps, source and verification reference. |
| REQ-083 | P0 / New + Backend | Oracle outage remains pending with reason and next review condition. No operator may select a favorable replacement after the outcome is known. The UI cannot offer a claim while resolution is nonfinal. |
| REQ-084 | P0 / Conditional + Backend | Predeclare whether disputes exist, who may raise them, evidence/deadline/fee if any, authorized decision process and settlement effect. If protocol has no dispute mechanism, show rules/evidence/support instead of a fictitious “challenge” transaction. |
| REQ-085 | P0 / Conditional + Backend | Void policy is fixed before trading and conserves collateral. A 0.5/0.5 payout is only a candidate exception, not an adopted rule; last-purchase-price refunds are not assumed valid. Show void payout separately from normal 1/0 outcomes. |
| REQ-086 | P0 / Demo + Backend | Portfolio separates available funds, reserved funds, shares, estimated position value, unresolved/claimable redemption, pending withdrawal and wallet balance. Do not double-count locked collateral or public claims. |
| REQ-087 | P0 / Demo + Backend | P&L uses a declared cost-basis/fee method and a labeled valuation source. Display realized and unrealized separately; no executable bid means “valuation unavailable” or an explicitly marked estimate. Deposits/withdrawals are not profit/loss. |
| REQ-088 | P0 / New + Backend | Position aggregates retain fill-level cost/fee history and exact round identity. Combining BTC 5m rounds into one holding must not allow selling/claiming the wrong instrument. Losing outcomes remain visible with zero redemption. |
| REQ-089 | P0 / Demo + Backend | History filters by asset, duration, round, date, operation, status and account. Filled order count differs from number of fills. Stable pagination/cursors prevent duplicate/missing entries during live updates. |
| REQ-090 | P0 / New + Backend | Activity detail shows intent ID, order/fill IDs, signed limits, execution, reason codes, timestamps, fee breakdown, reserve changes and canonical transaction/root reference where relevant. Private fields remain client-decrypted. |
| REQ-091 | P1 / Demo | CSV export previews scope/date range and includes environment, token/units, UTC timestamps, operations, actual fees and IDs. It exports only decrypted authorized records, escapes spreadsheet formula values, and warns it contains private financial data. Never exports keys. |
| REQ-092 | P0 / New + Backend | Account reconciliation shows “Updating / state uncertain” when ledger, chain/indexer or key epoch disagree. Do not fabricate a balancing transaction or silently overwrite authoritative values with local cache. |

### Notifications, preferences, support and accessibility

| ID | Priority / baseline | Behavior and acceptance criterion |
| --- | --- | --- |
| REQ-100 | P0 / New | Durable operation status exists independently of toasts. Transient messages notify; receipt/history owns the truth. Group partial fills without losing individual receipts; never show “Trade completed” for mere submission. |
| REQ-101 | P1 / New | Notification center supports read/unread, market/result/fill/cancel/funding/service filters and safe deep links. Balance/amount visibility follows privacy setting; defaults avoid disclosing sensitive details on lock screens. |
| REQ-102 | Later / Conditional | Browser push/email/other channels are opt-in and implemented only with a data-retention policy. Ask permission after a clear user action; no secret keys or precise private trading fields in third-party payloads by default. |
| REQ-103 | P1 / New | Settings support dark/light/system, reduced motion, compact spacing, local/UTC display and numeric format where tested. Input parsing remains unambiguous; display locale never changes serialized order amounts. |
| REQ-104 | P0 / Demo + New | Keyboard supports navigation, inputs, chart inspection, dialogs, tabs and visible focus. Cmd/Ctrl+K opens search. No single-key shortcut submits a trade; Enter respects form validation and confirmation stage. |
| REQ-105 | P0 / Demo + New | Dialogs trap focus, label fields/errors, return focus to opener, work with zoom and screen readers, and never hide primary action behind virtual keyboard. Color is not the only indicator of Up/Down, gain/loss, error or status. |
| REQ-106 | P0 / Demo + New | Phone layout keeps round identity/cutoff and review totals visible. Trade drawer preserves draft across chart navigation; no overlapping fixed bars or horizontal page overflow at 320px. Tables become readable rows or labeled horizontal tables. |
| REQ-107 | P0 / New | Reduced-motion mode removes unnecessary tick flashes, transitions and smooth scrolling. Announce meaningful state changes politely; do not announce every price tick or countdown second. Critical failures are persistent and reachable. |
| REQ-108 | P0 / New | Help explains shares, limit/IOC, partial fills, fees, cancellation race, resolution, collateral, privacy and recovery with worked examples. Support accepts public operation IDs and optional user-previewed redacted diagnostics; never seeds or keys. |
| REQ-109 | P0 / Conditional | If operating requirements impose eligibility, age, location, KYC or account restrictions, implement explicit states and the actual applicable policy. Do not invent approval requirements or promise legal eligibility from wallet connection. Restrictions must retain documented access to history and lawful fund recovery. |
| REQ-110 | P0 / New | Local reset/cache clear explains scope. Clearing browser cache is not deletion of chain history, private server/enclave state or live orders. Paper-account reset is available only in demo mode. |
| REQ-111 | P0 / New | Every error has a stable code, plain-language reason and a valid next step. Retry only when safe; neither offline handling nor support tools expose sensitive payloads. Request/operation IDs can be copied without including full decrypted receipt by accident. |

### Internal operations and launch controls

| ID | Priority / baseline | Behavior and acceptance criterion |
| --- | --- | --- |
| REQ-120 | P0 / New + Backend | Authenticated role separation covers market scheduling, oracle operation, protocol deployment, fee configuration, custody reconciliation and incident response. Privileged actions are auditable; public UI receives only permitted status. |
| REQ-121 | P0 / New + Backend | Deployment registry pins environment, chain/addresses, bytecode, enclave measurement, WASM fingerprint, key epochs, permitted collateral and upgrade governance. Changing them creates a reviewed version and user-visible verification transition. |
| REQ-122 | P0 / New + Backend | Monitor queue age, request failures, cancel latency, oracle freshness, state growth, gas, indexer lag, feed gaps and withdrawal backlog. Alerts use public metadata/aggregates; secret order or raw state dumps are prohibited. |
| REQ-123 | P0 / New + Backend | Reconcile canonical custody, deposits pending execution, private liabilities, locked outcome collateral, fees and public pending claims at a consistent root/block. Mismatch stops affected new risk and triggers documented review. |
| REQ-124 | P0 / New + Backend | Separate pause-new-orders, pause-new-rounds, pause-deposits and withdrawal impairment where protocol permits. A pause is visible with scope/reason; it must not silently alter round resolution or confiscate balances. |
| REQ-125 | P0 / New + Backend | Define state backup/restore, enclave/key rotation, reorg/restart replay, data retention and operator-outage recovery. Rehearse using test funds; record exact restored canonical state and users' historical decryption capability. |
| REQ-126 | P0 / New + Backend | Capacity test actual order/cancel/mint/settlement bursts at four-market concurrency. Specify and measure p50/p95/p99 latency and cost; derive cutoff buffer from evidence. No 5m launch based solely on a fast visual ticker. |
| REQ-127 | P0 / New | Release approval requires applicable production licenses, supported deployment, reviewed request/time binding, audits/remediation, logging/metadata decisions, tested exit behavior and actual liquidity. Current research leaves these open. |
| REQ-128 | P1 / New + Backend | Internal analytics distinguish executable volume, funding, fills, active accounts, no-fill rate and churn without exposing private strategies. Any published volume/participation statistic follows the same disclosure policy as book data. |
| REQ-129 | P0 / Conditional + Backend | User-consented support exports are separate from protocol-authorized audit/deanonymization. Define eligible requestors, allowed fields, authorization/governance, logged request/result, retention and user notification policy for audit access. The support consent dialog neither grants nor blocks authority that the actual protocol governs separately. |

## Dialog, drawer and popup inventory

### Shared interaction contract (applies to every DLG)

**Modal mechanics:** one active task dialog; transitions replace its step rather than stacking arbitrary popups. A secondary explanation can be a nonmodal popover. Use a drawer/full-screen presentation on small screens with identical semantics. Title, close control, active step, primary/secondary actions, focus trap/restore and keyboard behavior are required.

**Fields:** labels include units; required/optional status and errors are associated programmatically. Preserve valid user input through recoverable errors. Validate locally for feedback and authoritatively before mutation. Disable duplicate submission while preserving a readable reason. A loading spinner never hides amount, destination, market or chosen action.

**Async states:** every operation supports idle, validation error, awaiting wallet, rejected by wallet, submitted/unknown, pending, confirmed, rejected/failed and reconciliation as relevant. Read-only dialogs support loading, data, empty, stale and unavailable. A receipt/operation ID survives dialog dismissal and refresh. The user can close a pending dialog to return to the app; closing does not cancel a broadcast/accepted operation.

**Dismissal:** Escape/backdrop closes ordinary read-only views; explicit close/back are always available. Warn only when discarding meaningful unsent input. For a pending wallet/chain action, explain it continues and offer “View activity.” Do not trap users in indefinite spinners. Reopening restores the correct account/round/operation, not a new submission. Browser back and mobile back behave consistently.

**Completion:** success copy names the confirmed stage. Preserve transaction/reference links and next action. On failure state whether any funds/order change happened, retain safe retry context, and query unknown outcomes before resubmitting. No automatic wallet request when a dialog is reopened. User-facing errors omit secret payloads.

All entries below inherit those loading, error, dismissal and resume requirements. “Read-only” means no ledger mutation, not a bypass of account authorization. Fields omitted explicitly are absent rather than placeholders.

### Connection and privacy setup

**DLG-01 — Market search** · P0 · Demo (`dialog === search`) · REQ-008/010, UI-01

- Open: header search or Cmd/Ctrl+K. Fields: search term; asset/duration/watchlist filters if present. Actions: select a result, clear search, close. Results identify asset, duration and availability.
- Guard/result: no wallet required; keyboard arrows/Enter select only focused valid result. Empty results suggest clearing filters. Loading/error pertains to market catalog, not personal balances. Selecting opens the round without a second confirmation dialog.
- Resume: preserve term while open; closing has no financial effect. A dirty pinned ticket follows REQ-021 rather than silently migrating to the searched round.

**DLG-02 — Connect wallet** · P0 · New · REQ-068/070

- Open: Connect or a funded action while disconnected. Fields: supported provider list and environment; optional mobile QR/connection code only for the selected supported connector. Actions: choose provider, retry provider, cancel.
- Guard/result: detect missing extension, blocked popup, unsupported connector, user rejection and timeout. Show “Connected” only after account and chain are returned; private-key setup is a separate step. No balance seeded from connection success.
- Resume: return to original draft after connection. Cancel leaves public browsing usable. Expired QR creates a new connection session, never repeats a funded operation.

**DLG-03 — Switch network** · P0 · New · REQ-069

- Open: explicit action on wrong chain. Content: current/required network, verified chain ID and reason. Actions: switch, manual instructions, cancel.
- Guard/result: missing provider capability, add-network rejection and switch failure are distinct. Re-read provider chain before continuation. Keep pending operations attached to their original chain.
- Resume: return to requested flow after verified switch; cancel leaves the funded CTA blocked with its reason and preserves the draft.

**DLG-04 — Account menu and disconnect** · P0 · New · REQ-037/068/073

- Open: account button. Content: address, network, local privacy lock, connection state and pending-operation count. Actions: copy address, explorer, lock, account/security, disconnect.
- Guard/result: copy is acknowledged; explorer uses the correct network. Explain that disconnect leaves accepted orders active. Wallet account change immediately hides previous account's decrypted data and revalidates the new account.
- Resume: close freely; reconnect restores only the matching account's authorized state. No cancel-all side effect.

**DLG-05 — Signature handoff** · P0 · New · REQ-048/070

- Open: an explicit action requiring a signature. Content: purpose, wallet, app/domain, round if relevant, permission scope, expiry, amount/fee caps and whether gas is required. Actions: open wallet, cancel unsent request.
- Guard/result: distinguish login, encryption association, order authorization and transaction signing. Changed fields invalidate the prior review. User rejection returns editable draft; timeout queries provider/operation state before retry.
- Resume: mobile wallet return restores the exact intent ID. Closing ZEDGE's view does not revoke a signature already submitted; tracking remains available.

**DLG-06 — First-use privacy explanation** · P0 · New · REQ-003/034/071

- Open: first confidential account setup, not every visit or market click. Content: private order/account contents, public wallet/funding footprint, operator metadata limits, key-recovery policy, environment and deployment status. Actions: continue setup, read details, cancel.
- Guard/result: copy must match actual deployed guarantees; an acknowledgement is not proof of cryptographic verification or a waiver for broken privacy. No funds requested in this explanation.
- Resume: remember the acknowledged policy version per account; material changes reopen once before affected action. Cancellation leaves public browsing and demo available.

**DLG-07 — Deployment verification detail** · P0 · New · REQ-036/121

- Open: privacy-status control or failed verification. Content: chain/application, pinned measurement/fingerprint, enclave/key epoch, verification timestamp, supported status and public evidence references. Actions: retry verification, copy public diagnostic ID, view status.
- Guard/result: show verifying, verified, expired/unavailable or mismatch distinctly. Failure blocks confidential submission; “Continue anyway” cannot route production inputs to an unverified target.
- Resume: close for public browsing. Retry does not resubmit orders or trust a new deployment silently; any approved upgrade requires policy-driven verification.

**DLG-08 — Encryption-key setup** · P0 · New · REQ-071

- Open: verified environment and connected account without required key association. Content: derivation/creation purpose, storage/recovery policy, account and epoch. Actions: initialize, perform required wallet signature, back.
- Guard/result: key generation, association submission and confirmed readiness are distinct. Validate account/deployment binding. Do not expose secrets in UI logs/analytics or make an unencrypted backup the default.
- Resume: an unknown association result is reconciled before generating a competing epoch. Continue original flow only when the exact required epoch is ready.

**DLG-09 — Unlock private account** · P0 · New · REQ-037/038

- Open: locked account view or private action. Fields depend on selected reviewed local protection (wallet signature or local secure unlock), not an invented backend password. Actions: unlock, recovery help, cancel.
- Guard/result: wrong account/epoch, rejected signature, unavailable local key and decrypt failure are distinct. A failure does not clear holdings or create a new empty account.
- Resume: cancel keeps values hidden. Successful unlock decrypts/reconciles before showing balances as current; private cache remains scoped to account/environment.

**DLG-10 — Rotate encryption key** · P0 capability / New · REQ-072

- Open: account security when supported. Content: current/new epoch, queued requests, historical-read implications and reviewed recovery/backup steps. Actions: review rotation, authorize, postpone.
- Guard/result: reject wrong account, invalid association and conflicting rotation. Show pending association, active new epoch and historical access check separately. Never promise old receipts become readable under a new key automatically.
- Resume: after dismissal/reload, query the authoritative active epoch and pending operation. Retain old required key material according to policy until its safely defined retirement condition.

**DLG-11 — Recovery guide and status** · P0 · New/Conditional · REQ-072/074

- Open: lost key, unreadable history or operator outage. Content: diagnosed condition, wallet access, known epochs, actual supported recovery route and what remains unrecoverable. Actions: restore via supported method, verify account, status/support, copy public references.
- Guard/result: never request seed phrases or claim a reset reconstructs lost historical encryption. Recovery may restore current account authorization without historical receipts; display both results. Outage recovery cannot imply an undeployed forced-exit contract.
- Resume: save nonsecret progress and accepted recovery IDs. No destructive replacement key or withdrawal request without explicit review.

**DLG-12 — Trading-session permission** · Later · Conditional · REQ-075

- Open: user opts into implemented scoped delegation. Fields: allowed actions/markets, token, maximum exposure, expiry; withdrawals disabled by default. Actions: authorize, revoke existing session, cancel.
- Guard/result: limits validated by authoritative protocol; show pending/active/expired/revocation-pending/revoked distinctly. Local logout is not revocation.
- Resume: list active grants after reconnect; hide this feature entirely until scope enforcement and revocation are implemented and tested.

### Funding, custody and liquidity

**DLG-13 — Choose funding method** · P0 · New · REQ-060/065

- Open: Add funds in funded environment. Content: accepted token/network, wallet balance, gas balance, limits, direct deposit and supported bridge route if any. Actions: select asset/method, connect/switch network, continue.
- Guard/result: unsupported token, wrong chain, insufficient asset/gas and unavailable route are separate. No fiat card/on-ramp choice without a real integration.
- Resume: preserve selection; never reuse the demo funds control. A completed external bridge resumes only after destination balance is verified.

**DLG-14 — Token approval/permit** · P0 · New · REQ-061

- Open: allowance is required for a chosen deposit. Fields: token, verified spender, bounded amount, permit deadline if used, estimated gas. Actions: approve/sign, edit allowed allowance, cancel.
- Guard/result: token/permit compatibility and current allowance verified; wallet denial or on-chain revert does not trigger deposit. Approval success means allowance granted, not balance credited.
- Resume: allowance can remain after cancellation; disclose and offer supported revocation instructions. Re-read allowance before retry or continuing.

**DLG-15 — Deposit review** · P0 · New · REQ-060/062

- Open: chosen asset and amount. Fields: amount/presets/max, source wallet, destination application, token/network, fees and expected processing stages. Actions: review/confirm deposit, back.
- Guard/result: validate atomic precision, balance, limits, allowance, gas and deposit availability. Freeze reviewed amount/token/account for the signed action. Pending wallet state preserves all values.
- Resume: cancelled unsent draft is reusable; submitted deposit opens DLG-16 and cannot be resent by reopening review.

**DLG-16 — Deposit progress** · P0 · New · REQ-062

- Open: submitted deposit or funding history item. Read-only fields: operation ID, transaction, chain confirmations/policy, private processing state, credited amount or refund claim. Actions: explorer, receipt, retry only an explicitly failed stage, claim approved refund if applicable.
- Guard/result: awaiting ledger credit is not failed and not spendable. Reorg, failed processing and duplicate credit are handled by canonical state. Final success requires usable ledger balance.
- Resume: dismiss freely and track from funding/history; refresh reconnects to same operation. Unknown transaction queries precede any retransmission.

**DLG-17 — Withdrawal review** · P0 · New · REQ-063

- Open: Withdraw. Fields: exact token/network, amount/max, allowed destination, available funds, reserved funds, fees and public footprint. Actions: review, authorize withdrawal, back.
- Guard/result: validate destination under actual custody policy, positive supported precision, spendable balance, request limits and enabled withdrawal path. Show the full/checksummed destination for verification; never silently substitute the wallet's newly switched account.
- Resume: accepted request goes to DLG-18. Closing leaves accepted debit/request intact; unsent edits can be preserved safely without treating them as authorized.

**DLG-18 — Withdrawal progress** · P0 · New · REQ-063/074

- Open: withdrawal submitted or history item. Content: internal processing, authorized public pending claim and token transfer steps. Actions: claim when required, view receipt/explorer, status/support.
- Guard/result: “Debited,” “Ready to claim,” and “Sent to wallet” are different. Operator unavailability shows known state and documented recovery options, not an unsupported cancel/force button.
- Resume: track same request across sessions; no second debit when claiming. Reconcile pending claim before allowing retry.

**DLG-19 — Claim on-chain funds** · P0 · New · REQ-064

- Open: actual pending claim, including withdrawal/refund as applicable. Fields: claim owner, token, amount, recipient, chain and gas; selectable claims only if supported batching exists. Actions: claim, switch/connect, back.
- Guard/result: re-read available claim; zero/already claimed resolves with existing receipt. Transaction confirmation and wallet balance update are reconciled separately.
- Resume: pending claim remains after dismissal and can be resumed without recreating withdrawal/deposit. Partial batch results are itemized.

**DLG-20 — Bridge handoff/status** · P0 when bridging offered · Conditional · REQ-065

- Open: explicit bridge choice. Fields: verified provider/route, source/destination chain, exact asset mapping, amount, fees and provider-backed timing. Actions: continue to supported bridge, monitor transfer, cancel before submission.
- Guard/result: unsupported route and liquidity/quote expiry are visible. State that bridge and ZEDGE deposit/withdrawal are different operations. Do not fabricate a completion estimate.
- Resume: store public transfer reference without sensitive payload; destination receipt is verified before enabling deposit. External failure provides the actual provider recovery route.

**DLG-21 — Complete-set mint/merge** · P0 for liquidity · New · REQ-066

- Open: inventory control. Fields: immutable round, collateral, pair quantity, lock/release amount, fees and available Up/Down inventory. Actions: mint or merge, review, authorize.
- Guard/result: mint requires collateral; merge requires both available outcomes in equal quantity and a permitted market stage. Reserved shares cannot merge; pairs from different rounds never combine.
- Resume: operation is idempotent and tracked like orders. Completion updates inventory only from authoritative receipt; failed operation leaves prior balances intact.

**DLG-22 — LP inventory/quote drawer** · P0 operational / Conditional audience · REQ-067

- Open: approved liquidity workspace. Content: private cash, Up/Down free/reserved inventory by exact round, active offers, spread/size limits and current publishing policy. Actions: mint/merge, place/cancel offers, disable strategy if implemented.
- Guard/result: quoting respects shared reservations and risk/lot limits. Empty inventory does not create virtual depth. Automation permissions and outstanding orders remain visible when strategy stops.
- Resume: closing does not cancel offers or stop server strategy. A separate explicit stop/cancel action reports its true completion.

### Trading and round workflows

**DLG-23 — Order review** · P0 · Demo (separate `review` state) · REQ-040–049

- Open: validated ticket Review. Content: exact round/time, side/outcome, type, quantity, requested limit/IOC protection, expiry, maximum cost/minimum proceeds, fee components, reserves and conditional winning payout/net profit. Actions: confirm, edit/back, fee explanation.
- Guard/result: revalidate account, key, deployment, balance, applicable quote validity and cutoff. Changed signed values require a new review. Disable with precise reason for closed round, unknown balance, fee change or unavailable execution. A resting limit can be accepted without current crossing liquidity. A protected immediate order follows the selected no-quote policy and can return zero/partial fill; an absent executable quote must not block a valid resting order.
- Resume: unsent close returns draft; submission transitions to DLG-24. Rollover never swaps market/round while review or wallet is open.

**DLG-24 — Order progress** · P0 · New · REQ-049/050/058

- Open: confirmed intent, pending orders notification or receipt link. Content: intent/order ID, immutable order summary, signature/submission/admission/acceptance states, queue freshness and actual fills. Actions: view order, close, safe retry after known failure, request cancel only when permitted.
- Guard/result: “Submitted” does not read “Filled.” Transport timeout shows unknown state pending lookup. Reject reasons distinguish invalid order, expired, insufficient balance, no fill within limit, privacy failure and service failure.
- Resume: dismiss with activity link; restore by ID after reload/account return. Do not generate a new intent automatically.

**DLG-25 — Order/fill detail drawer** · P0 · New · REQ-051/052/090

- Open: own order/history row. Content: original size, individual fills and fees, filled/remaining, average price, reservations, expiry, accepted sequence, status trail and own encrypted receipt verification. Actions: cancel remaining, copy public reference, view round, replace if supported.
- Guard/result: authorized decryption required; undecryptable is not empty. A cancel button becomes pending, then reports cancelled remainder or fill-before-cancel. Do not invent counterparty identity or expose it by default.
- Resume: close freely; live changes preserve scroll and announce status once. A completed order remains viewable after round rollover.

**DLG-26 — Cancel-all review** · P1 · New · REQ-053

- Open: explicit cancel-all control. Fields: chosen scope, included count and estimated reserve release; list exceptions. Actions: confirm cancellation, change scope, back.
- Guard/result: scope binds account/round set or accepted epoch, not whatever happens to be on screen later. Show partial results when fills beat cancellation; reserved balance releases only after authoritative confirmation.
- Resume: track cancellation command after close. New orders outside the defined scope are not silently cancelled; retries query prior result.

**DLG-27 — Replace order review** · P1 · New · REQ-054

- Open: Replace on eligible order. Fields: existing order/remainder, new size/price/expiry and extra reserve requirement. Actions: review replacement, confirm cancel-and-replace, back.
- Guard/result: disclose loss of queue priority and cancel/fill race. Reject already completed order; reconcile partial fill before sizing replacement. Report cancel success/new-order failure as two separate facts.
- Resume: never resurrect cancelled old order locally. Reopening shows authoritative old/new command IDs and allows a fresh explicitly reviewed new order if appropriate.

**DLG-28 — Sell position drawer** · P0 · Demo ticket prefill · REQ-056/088

- Open: Sell from own position. Fields: exact round/outcome, total/available/reserved shares, quantity/percent presets and protected price. Actions: select size, review sale, release relevant reservation through cancel workflow if desired.
- Guard/result: only free shares are sellable and only before cutoff. “All” cannot include reserved inventory. Stale/no bid does not guarantee exit. Closed markets link to settlement rather than a fake sell.
- Resume: draft stays pinned to selected holding; changing global market does not silently sell another round. Confirmation uses DLG-23.

**DLG-29 — Market rules** · P0 · Demo (`dialog === rules`) · REQ-013/081

- Open: Rules from card/detail/review/result. Read-only fields: exact rules version, opening/closing method, tie, collateral payout, fees, cutoff, expiry, oracle/failure/void/dispute rules and evidence links. Actions: copy round/rules reference, open glossary, close.
- Guard/result: unavailable verified rules blocks new funded order for that round; do not show another round's defaults. Highlight explicit exceptions such as a selected void policy.
- Resume: return to same view/draft without resetting input. Historical rules remain accessible even after template changes.

**DLG-30 — Resolution detail** · P0 · New · REQ-080–085

- Open: round result/status. Content: status, exact opening/closing observations with units/timestamps, selected rule, winner or pending/void reason, finality and public verification reference. Actions: own positions, eligible redemption, rules, dispute only if real.
- Guard/result: pending data never renders a guessed winner. Display-feed chart disagreement links to source explanation. A disputed/provisional result cannot enable final payout until the actual protocol allows it.
- Resume: close freely; resolution notification deep-links here. Reorg or revised provisional status follows canonical policy and is visibly recorded.

**DLG-31 — Challenge/dispute** · Conditional · New · REQ-084

- Open: only when a deployed dispute mechanism permits it. Fields: contested round/result, valid grounds, bounded evidence, deadline, bond/fee and published decision process. Actions: preview, submit authenticated challenge, cancel.
- Guard/result: eligibility, deadline and evidence validated under actual protocol; no implied guarantee of reversal. Sensitive evidence is not sent to public chain without disclosure. Show accepted challenge vs decided outcome separately.
- Resume: durable case/transaction reference. If no dispute mechanism is selected, omit this dialog and offer evidence/support instead.

**DLG-32 — Redeem winning/void shares** · P0 · New (demo claim exists) · REQ-064/082/085

- Open: finalized redeemable position or Redeem all. Fields: exact rounds/outcomes, share quantity, final payout per share, resulting internal credit and any fees. Actions: redeem selected/all supported positions, back.
- Guard/result: finality and unspent claims verified; losing shares have no positive payout. Identify void exception explicitly. This is internal outcome redemption unless actual implementation combines a separate on-chain transfer, which must be stated.
- Resume: per-item authoritative completion survives close; retries omit completed claims and cannot double-credit. Withdrawal remains a distinct next action.

### Account, support and optional access

**DLG-33 — Privacy and data disclosure details** · P0 · New · REQ-034–038/129

- Open: privacy badge, help, funding or account security. Content: environment and verified status separately; public/operator/user matrix, recipient metadata limitations, deployment version, logging status, controlled audit policy and recovery limits. Actions: verification detail, relevant documentation, close.
- Guard/result: claims come from an approved deployment capability manifest and policy version. Do not let front-end copy imply a runtime issue is fixed without evidence. Distinguish confidential contents from anonymity.
- Resume: read-only; no signatures or consent inferred from opening. User-consented export and protocol-governed disclosure remain separate flows.

**DLG-34 — Notification center** · P1 · New · REQ-100/101

- Open: notifications button. Fields: unread/all and event filters. Content: status-specific messages, time, originating account/round and safe receipt links. Actions: mark read, open detail, preferences.
- Guard/result: unlocked private content only; duplicate events deduplicated by ID and updates attached to the same operation. Stale alerts must not override current final state.
- Resume: preserve unread state and scroll; dismissing an alert never dismisses a pending order or frees funds. Critical service banners remain visible outside the center.

**DLG-35 — Preferences** · P1 · New (current settings are demo controls) · REQ-103/107

- Open: Settings. Fields: supported theme, display density, reduced motion, time zone, number formatting, balance masking, reviewed default order size/protection and notification preferences. Actions: save or immediate reversible change, reset preferences.
- Guard/result: bounds on order defaults and parsing; no changing existing orders or privacy guarantees. Sound/push default off unless chosen. Saving errors retain values with retry.
- Resume: harmless appearance changes can save immediately; consequential trading defaults are visibly confirmed. Account and device scopes are labeled; no backend deletion implied by reset.

**DLG-36 — Export history/report** · P1 · Demo CSV expanded · REQ-091

- Open: Export in authorized history. Fields: date/round/operation scope, supported file format and selected fields. Content: record count, environment, private-data warning. Actions: preview, download, cancel.
- Guard/result: require successful authorized decryption; report excluded/unreadable rows rather than silently producing a “complete” report. Escape spreadsheet formula cells, include token units/fees and never key material.
- Resume: allow cancellation during preparation. Closing must not upload anything. Large server-assisted export is conditional and must never require sending decrypted data without explicit policy/consent.

**DLG-37 — Support request / redacted diagnostics** · P0 · New · REQ-108/111/129

- Open: Help, operation failure or contact support. Fields: topic, optional public operation ID, description and optional attachment. Preview every diagnostic field before sending. Actions: send via actual supported channel, copy diagnostics, cancel.
- Guard/result: no seed/private-key request; scrub auth tokens and decrypted trade data by default. An optional sensitive receipt attachment requires explicit field preview and recipient disclosure. File type/size and upload failures are handled safely.
- Resume: unsent draft can be saved locally according to privacy setting; sent case gets durable reference. Support export consent does not authorize general account auditing or on-chain deanonymization.

**DLG-38 — Clear local data / lock account** · P0 · New · REQ-037/110

- Open: security/local data settings. Content: exactly which preferences, public caches, decrypted caches and key material would be cleared; historical-decryption consequences. Actions: lock only, clear selected cache, back; key deletion is a separate explicit reviewed action.
- Guard/result: never say “Delete account/trades” for browser cleanup. Warn about irreversible local key loss under actual recovery design; do not delete required keys alongside innocuous theme reset.
- Resume: live orders/funds remain and must be stated. After clear, show locked/reconnect state, not a fresh funded balance. Demo reset is DLG-41.

**DLG-39 — Add demo funds** · Demo only · Existing (`dialog === funds`)

- Open: Add funds in Demo. Fields: simulated amount and presets; current implementation accepts $1–$10,000 per addition. Actions: add demo funds, close.
- Guard/result: no wallet or real payment; validate finite amount/range and label balance as simulated. Success is a local paper-account credit, not a blockchain deposit.
- Resume: local storage failure is shown. This dialog is unreachable from Testnet/Production and shares no authoritative balance state with them.

**DLG-40 — Demo playback controls** · Demo only · Existing (`dialog === settings`)

- Open: Customize demo. Content/actions: pause/resume, 1×/5×/15× speed, finish selected round, reset entry. Each explains it affects the browser's simulator.
- Guard/result: finishing a demo round is clearly local simulation. No controls can alter production reference prices, cutoff or outcome.
- Resume: close preserves current local simulator state; frontend environment separation prevents accidental availability in funded mode.

**DLG-41 — Reset paper account** · Demo only · Existing (`dialog === reset`)

- Open: Reset from demo controls. Content: simulated balances, orders, history and sample positions that will reset in this browser. Actions: reset, keep account.
- Guard/result: explicit destructive confirmation; no wallet/chain action and no production caches/keys touched. Report storage failure rather than claiming reset persisted.
- Resume: cancel returns to demo settings. Successful reset uses the documented demo seed only; it never looks like real financial compensation.

**DLG-42 — Getting started / how it works** · P0 · Demo (`dialog === help`)

- Open: Help or optional first visit. Content: choose round/outcome, buy shares, possible partial/no fill, sell before cutoff or hold, 1/0 payout, fees, funding and actual privacy. Include one simple cost/payout example with fees identified.
- Guard/result: distinguish demo from actual environment and available features. No required onboarding carousel before every trade and no automatic acceptance of legal or signing permissions.
- Resume: dismiss freely, remember optional progress/version and reopen from Help. Links return to the correct original round.

**DLG-43 — Eligibility/restricted access** · Conditional · New · REQ-109

- Open: only when actual operating requirements or an authoritative restricted status apply. Content/fields: actual reason, necessary eligibility verification, provider and privacy terms if used; actions: supported verification, read policy, leave funded flow.
- Guard/result: pending/rejected/unavailable verification are distinct. Do not collect excessive identity data or imply a wallet proves eligibility. Restriction copy must describe history/fund-recovery access accurately.
- Resume: persist approved status only from the authoritative system. Never loop users through repetitive modals on public market browsing when policy permits viewing.

**DLG-44 — Audit/disclosure request record** · P0 if disclosure enabled · Conditional · REQ-129

- Open: authorized audit console; user notification/access view only as the adopted policy permits. Content: verified requestor/authority, legal or protocol basis where applicable, application/account scope, permitted fields, key/role path, retention and audit ID. Actions are role-specific: approve/reject under governance, execute authorized disclosure, inspect record.
- Guard/result: this is not a support consent popup. Enforce deployed access rules, authorization thresholds and field minimization. Unauthorized request cannot obtain a report by UI role alone; sensitive reports never become public application events accidentally.
- Resume: durable authorized request/result audit trail. Clearly state if users cannot veto an independently authorized request; notifications follow the real policy rather than an invented promise.

**DLG-45 — Operational change confirmation** · P0 · New, internal · REQ-120–127

- Open: role-authorized operator changes a deployment, future market template, pause scope, fee version, collateral policy or recovery step. Fields: precise target/version, before/after, affected rounds/users, reason and required approvals. Actions: validate, submit under governance, cancel.
- Guard/result: cannot rewrite existing funded-round rules through a generic admin form. Dry-run/policy checks and authorization happen backend-side; show queued approval vs executed change separately. No raw private state in diffs/logs.
- Resume: retain audit/change ID after close; verify canonical effect. A failed proposal cannot display a successful pause or migration.

## Small interactions, popovers, tooltips and toasts

Use inline explanation for information needed to decide; a tooltip cannot be the only place that reveals a cost or financial consequence. Popovers open by click/keyboard as well as pointer, remain within viewport, close on Escape/outside click and return focus. No tooltip requests a signature.

| ID | Priority / baseline | Trigger/content/actions | Required states and acceptance |
| --- | --- | --- | --- |
| INT-01 | P0 / Demo | Asset/duration selector | Selected state remains explicit; changing template follows safe rollover/draft rules and never mutates an open review. |
| INT-02 | P0 / Demo | Round strip/date selector | Shows UTC range, current/next/historical status and selected round. Unavailable history has reason and retry, not a fake result. |
| INT-03 | P1 / Demo | Watchlist star | Optimistic reversible toggle with accessible name; storage/sync failure restores state and explains. No success popup required. |
| INT-04 | P0 / Demo + New | Price-to-beat explanation | Names canonical opening value, timestamp, source and tie condition; pending opening never displays a fabricated target. |
| INT-05 | P0 / New | Countdown/cutoff detail | Explains order admission cutoff vs round end vs settlement; exposes absolute times, not only a ticking number. |
| INT-06 | P0 / New | Feed status | Source, observation/receive time and stale threshold/status. Refresh cannot manufacture new observations. |
| INT-07 | P0 / Demo + New | Chart crosshair/keyboard cursor | Price/outcome unit and timestamp; no action changes ticket. Touch inspection does not trap scrolling indefinitely. |
| INT-08 | P0 / New | Public quote/depth explanation | Describes published selection/aggregation, timestamp and inference limitations. Quote is not reserved liquidity or guaranteed fill. |
| INT-09 | P0 / New | Click eligible quote/level | Prefills a limit only after clear affordance; never submits. Preserve side/outcome/round, validate tick, and surface stale quote. |
| INT-10 | P0 / Demo + New | Fee breakdown | Trading fee, maker/taker policy if selected, network/application charges, sponsored portions and caps. Unknown fee blocks only the affected action, not read-only browsing. |
| INT-11 | P0 / New | Price protection/slippage explanation | Shows worst acceptable price in cents and how it differs from estimate. Partial/no fill possibility is explicit; settings changes require new review. |
| INT-12 | P0 / Demo + New | Max / amount presets | Uses available balance after reserve/fees or unreserved shares; validates lot/dust. No preset exceeds cap or overwrites a wallet-pending intent. |
| INT-13 | P0 / Demo + New | Payout/profit explanation | Winning gross payout, actual/estimated total cost, fees and net profit; losing case can lose full purchase cost. Conditional estimates labeled. |
| INT-14 | P0 / New | Reserved balance explanation | Lists own orders locking cash/shares, links to cancel and explains asynchronous release. Reserved funds never look withdrawable. |
| INT-15 | P0 / Demo + New | Individual cancel button | One explicit action may request cancel without an extra confirmation popup. Pending spinner belongs to that row; duplicate click disabled; fill-before-cancel message remains in receipt. |
| INT-16 | P0 / New | Status chip on order/funding/result | Opens relevant detail drawer; color plus text/icon. Exact pending stage and age shown; no green success for submission alone. |
| INT-17 | P0 / New | Copy address/ID and explorer link | Copies only intended public value, acknowledges success/failure, uses correct network, and warns before public sharing of a private receipt if such sharing is added. |
| INT-18 | P0 / Demo + New | Hide balances | Masks account amounts consistently across header, portfolio, ticket and notifications; does not erase state or hide error context. |
| INT-19 | P0 / New | P&L valuation explanation | Method, fee treatment, as-of time and missing-liquidity condition. USD conversion/peg estimates are not collateral guarantees. |
| INT-20 | P0 / New | Reconnect/offline banner | Last good snapshot, disabled actions and retry. Reads remain available from labeled cache; writes are never silently queued for later auto-submission. |
| INT-21 | P0 / New | Round-closed banner | Keeps draft pinned, explains expiry and offers explicit next round. Do not auto-submit preserved quantity to the next round. |
| INT-22 | P0 / New | Service/privacy failure banner | Scope, known reason, status link and allowed actions. Cannot be dismissed into an active confidential submit button. |
| INT-23 | P0 / Demo + New | Toast for action result | Accurate stage, concise reason and receipt link. Dismissible; pausing on hover/focus where timed. Financial failure remains available in durable activity after toast disappears. |
| INT-24 | P0 / New | Partial-fill notifications | Aggregate rapid updates accessibly, preserve each receipt, show total/remainder, and do not leak private sizes while account is locked. |
| INT-25 | P1 / New | Sound/desktop notification toggle | Explicit permission request and sample only after opt-in; denial has no effect on trading. Private content preview policy applied. |
| INT-26 | P0 / New | Keyboard shortcut/help popover | Lists supported shortcuts, allows closure without side effect; no trade-execution hotkey enabled accidentally in text inputs. |
| INT-27 | P0 / New | Mobile sticky trade button | Includes selected outcome/round context, opens/focuses existing ticket, does not create second draft or obscure wallet-return messages. |
| INT-28 | P0 / New | Pagination/filter chips | URL or scoped state preserves filters; loading shows previous results with explicit stale indicator or skeleton. Clear filters is reversible and never changes account authorization. |

## Reusable empty, pending and failure states

| ID | Scope | User sees / allowed next action | Critical prohibition |
| --- | --- | --- | --- |
| STATE-01 | Initial public load | Honest skeleton, environment and retry after service error | No seeded “live” prices or balances in funded mode |
| STATE-02 | No market matches | Search/filter summary and clear filters | Do not imply exchange outage |
| STATE-03 | No funded liquidity | No quote/one-sided quote, valid limit option if supported, explanation | No synthetic fill or guaranteed sale |
| STATE-04 | Stale display feed | Last timestamp and reconnect; separate settlement status | Stale ticker does not determine outcome |
| STATE-05 | Sequence gap/indexer behind | Resyncing and last verified state; write gating appropriate to operation | Do not merge unknown deltas into balances |
| STATE-06 | Offline/browser resumed | Cached read-only data labeled with age; reconnect and reconcile | No automatically submitted offline trade queue |
| STATE-07 | Wallet disconnected | Public browsing, Connect for own data/action | Disconnect does not cancel orders |
| STATE-08 | Wrong account/network | Expected/current context and switch/reconnect | Never sign for newly selected account without re-review |
| STATE-09 | Locked/unreadable private state | Unlock, choose key/recovery, reason-specific help | Not a zero balance or empty trade history |
| STATE-10 | No positions/orders/history | Correct empty state with direct market navigation | No sample positions in funded environment |
| STATE-11 | Insufficient collateral/shares/gas | Exact deficient resource; deposit/cancel reserve/reduce size as relevant | No leverage or hidden token substitution |
| STATE-12 | Wallet rejected | Draft retained, explicit retry | No auto-reprompt loop |
| STATE-13 | Submission outcome unknown | Operation ID, reconciliation and status link | No new intent retry until prior outcome is established |
| STATE-14 | Queued/backlogged | Pending stage, elapsed time, known service health and legitimate cancel path | No promised completion timer without basis |
| STATE-15 | Partial fill | Filled/remainder/fees and remaining status | Not labeled wholly filled or wholly failed |
| STATE-16 | Cancel race | Actual fills retained; remainder cancelled or already completed | No local reserve release ahead of result |
| STATE-17 | Cutoff during review/signature | Original round closed; reject or canonical existing result; next-round action | Never change signed market behind user |
| STATE-18 | Opening observation absent | Opening pending and rules/status link | No funded matching against guessed reference |
| STATE-19 | Closed/resolution pending | Trading disabled, explanation and evidence status | No winner inferred from chart |
| STATE-20 | Oracle outage/dispute/void | Exact adopted status/policy, timing known vs unknown, verified next step | No discretionary substituted result or invented refund |
| STATE-21 | Privacy verification/logging gate failed | Affected confidential action blocked; public browsing/status available | No silent plaintext fallback or verified badge |
| STATE-22 | Deposit awaiting private credit | Chain stage complete, ledger stage pending, traceable ID | No double spend/duplicate deposit retry |
| STATE-23 | Withdrawal/claim pending | Current stage and actual next transaction if required | Internal debit is not receipt in wallet |
| STATE-24 | Operator halted/recovery | Last accepted state, affected actions and actual supported recovery/status | No nonexistent unilateral exit promise |
| STATE-25 | Reorg/canonical rollback | Revalidating operation, previous provisional status and confirmed policy | No duplicate credit or hiding changed confirmation state |
| STATE-26 | Storage unavailable/full | Session still usable where safe; persistence/key-storage consequence explicit | No silent claim that keys/history are backed up |
| STATE-27 | Account restricted | Actual policy, support and preserved permitted history/exit access | No blanket deletion of financial records |
| STATE-28 | Rate limit/session expiry | Retry time if supplied, reauthorization if needed, preserved draft | No repeated signatures or auto trading after session restore |
| STATE-29 | Maintenance/partial outage | Scope and allowed operations; status reference | A chart being live does not mean matching/withdrawals work |
| STATE-30 | Export/support failure | Safe retry/download/copy, retained scope and redacted preview | No accidental private-data upload on retry |

## Authoritative data and backend dependencies

The UI should integrate against versioned interfaces, not directly reuse the demo reducer as financial authority. This is a requirements contract, not a claim that these endpoints exist.

| Data/operation | Minimum required fields or guarantees | Consumers |
| --- | --- | --- |
| Deployment/capability manifest | Environment, chain and addresses, application/rules versions, verified measurement/fingerprint, key epoch, approved token identities, enabled features, fee/limit versions, public/private publication policy | REQ-003/036/044/121; all funded dialogs |
| Market/round manifest | Immutable round ID; asset/feed and quote units; opening/end/cutoff; lifecycle; canonical rules hash; opening/closing evidence and finality; configured tick/lot; adopted dispute/void policy | UI-01/02, DLG-23/29/30 |
| Public market snapshot/update | Round ID, quote type, price/size only as publication policy permits, source/observation/receive timestamps, sequence, validity, signed provenance if selected | REQ-015–019/030/031; INT-06/08/09 |
| Private account snapshot | Authorized account and key epoch, accepted ledger sequence/root, available/reserved collateral, per-round outcome inventory, claim/redemption/withdrawal status, as-of reference | UI-03/05/06; REQ-033/086/092 |
| Signed command envelope | Unique client intent ID, versioned domain, account, immutable round, action-specific integer fields, max fees, expiry, nonce/authorization epoch; canonical encoding | REQ-048/049; DLG-05/23 |
| Operation status | Same ID across transport and execution, source-of-truth stage, prior/current state, timestamps, canonical reference, safe reason code, permitted next actions, final vs provisional | DLG-16/18/24/25; REQ-050/100 |
| Private order and fills | Original signed parameters, accepted sequence, cumulative fill/remainder, fill IDs/prices/fees, reservation deltas, expiry, final status, encrypted receipt/proof references | REQ-051/057/090; UI-04/10 |
| Funding records | Token/decimals, exact source/destination/network, approval reference, deposit ID, processing result, withdrawal debit, pending claim and final transfer as separate idempotent records | REQ-060–065; UI-05 |
| Settlement/redemption | Canonical result, observation selection evidence, finality, payout rule, shares consumed, credited amount/fee, unique redemption ID | REQ-081–085; DLG-30/32 |
| Health and restrictions | Component-level status, last update, affected operations, reason and policy version, maintenance/incident reference; no sensitive raw data | UI-09; STATE-21/24/27/29 |
| Disclosure/audit | Actual authorized roles, request/result references, permitted scope/fields, retention and notification policy; no public plaintext leakage | REQ-129; DLG-33/44/45 |

Client-side state may cache snapshots and unsent drafts. It cannot restore a pending request by assuming success, mark funds available before credit, select a settlement observation, or validate its own enclave merely from a server-supplied green status string. At every account/network/epoch switch, cancel stale reads/subscriptions and prevent old responses from overwriting the new context.

### State ownership and transactional acceptance

- **Draft ownership:** device-local, scoped by environment/account/round. Saving a draft does not authorize it. Do not retain sensitive drafts beyond selected policy or restore them across accounts.
- **Authoritative order lifecycle:** the signed command and accepted ledger sequence own status. Indexers/relays provide transport and cached observations; they are not free to invent acceptance or fill receipts.
- **Reservation ownership:** the ledger changes available/reserved amounts atomically with acceptance, partial fills, cancellation, expiry and withdrawal. A UI spinner or modal dismissal cannot change reserves.
- **Settlement ownership:** the selected oracle/round contract and reviewed confidential admission path determine outcome and redemption. A fast external chart remains informational.
- **Notification ownership:** deduplicate by operation/event ID, reconcile to current state, and keep private content encrypted until an authorized user views it.
- **Publication ownership:** public quotes/aggregates are explicit outputs with reviewed leakage policy. Confidential event transport does not permit copying decrypted receipts into a public activity feed.

## Acceptance scenarios and release evidence

These are end-to-end acceptance requirements for future implementation, not claims that current V1 passes production checks.

| ID | Scenario | Passing evidence / related requirements |
| --- | --- | --- |
| QA-01 | Browse all four templates without wallet; open upcoming, live and historical deep links | Stable exact round IDs, real source/status labels, correct missing-round state and no forced connect popup. REQ-004/008/010–022; UI-01/02/12. |
| QA-02 | Start BTC 5m order review, let cutoff/rollover occur, change wallet account, then return from wallet | Original intent never targets next round/new account; canonical rejection or prior accepted result shown, draft requires re-review. REQ-021/022/048/068; DLG-23/24. |
| QA-03 | Buy/sell with malformed decimals, excess precision, integer extremes, reserved cash/shares and insufficient gas | Both UI and engine reject consistently; no negative/overflow balances, no naked sale, safe max calculation. REQ-043–046/057/060. |
| QA-04 | Submit resting non-crossing limit into an empty book, then later funded counterparty order | Resting order can be accepted without matching liquidity; deterministic later fill respects limits and maker price. REQ-041/042/045. |
| QA-05 | Protected immediate order crosses insufficient depth | Zero or partial fills within signed cap; remainder cancelled and actual fees/reserves reconciled. No synthetic liquidity or full-fill claim. REQ-041/047/051/055. |
| QA-06 | Many small partial fills and cancel/fill race | Cumulative fees remain within cap; correct filled/remainder totals and reserve release; fill preceding cancellation retained. REQ-051–057. |
| QA-07 | Double click, retry after dropped response, refresh while queued and reconnect on another device | Single intent accepted at most once; unknown outcomes queried before new intent; no duplicate deposit/order/redemption. REQ-049/062/073/082. |
| QA-08 | Tampered domain/round/nonce/key epoch, stale chain response and revoked session | Reject wrong authorization and replay; old account data never overwrites new account state. REQ-048/072/073/075. |
| QA-09 | Frontend traffic/log/telemetry inspection through order, deposit, receipt and support flows | No plaintext private order/account state or key material escapes allowed boundary; operator recipient exposure matches disclosure; raw-result logging fix verified in actual runtime. REQ-034–038/071/129. |
| QA-10 | Emulated/unverified/mismatched enclave and changed application fingerprint | Environment and privacy badges remain independent; confidential submit blocked; no plaintext fallback. REQ-003/036/121; DLG-07. |
| QA-11 | Key rotation/loss while requests pending and historical receipts exist | Old/new epochs reconciled; historical access truthfully reported; no false empty balances or automatic unsafe regeneration. REQ-038/071/072. |
| QA-12 | Approve then cancel deposit; deposit confirms while processing fails; retry after reconnect | Approval is not credit; failed processing/refund claim tracked; exactly one credit/refund outcome. REQ-061/062; DLG-14–16/19. |
| QA-13 | Redeem winner, withdraw internal credit, claim publicly and optionally bridge | Every stage clearly distinct; no double debit/credit; wallet receipt and bridge completion are separately verified. REQ-063–066/082/085. |
| QA-14 | Missing opening, invalid/wrong-feed closing, tie, delayed observation and oracle outage | No funded trading without opening; deterministic adopted rule; pending/void/dispute status exactly matches protocol; no chart-based result. REQ-014/080–085. |
| QA-15 | Delay pre-cutoff order processing until outcome visible; interleave cancellation/priority queue; reorg | Reviewed admission/commitment policy prevents hindsight option and maintains canonical replay. Production remains blocked until this passes. REQ-058/125/126. |
| QA-16 | Random complete-set mint/merge/trade/settle/redeem/withdraw sequences | No negative assets; unresolved locked collateral equals each outcome supply separately; custody/private liabilities/public claims reconcile. REQ-057/066/123. |
| QA-17 | Operator stop, indexer lag, chain outage, corrupted/missing snapshot and restore | Accurate partial outage; no fake availability; documented recovery reproduces canonical root and true balances; actual exit behavior demonstrated. REQ-074/092/122–125. |
| QA-18 | Phone wallet handoff, virtual keyboard, 320px viewport, zoom, keyboard-only and screen reader | Key identity/totals visible, focus restored, no hidden CTA, no repeated tick announcements, motion preference honored. REQ-104–107; shared DLG contract. |
| QA-19 | Locked account gets fills/notifications; exports and support attachment previews | No sensitive lock-screen leakage; authorized export only; skipped unreadable rows explicit; support consent separate from audit authorization. REQ-091/100–102/108/129. |
| QA-20 | Four simultaneous markets under placement/cancel bursts and settlements | Measured tail latency/throughput, backpressure and costs satisfy chosen limits; safety cutoff justified; no assumed capacity from UI frame rate. REQ-058/126. |
| QA-21 | Restricted/maintenance account, independent status route and pending withdrawal | Actual policy and unaffected actions remain available; no hidden freeze scope or pretend deletion; support references safe. REQ-109/111/124. |
| QA-22 | Attempt production with simulator balances, unsupported features or unfinished privacy/custody gates | Feature/environment checks prevent activation; no demo reset/finish-round/seed activity in production. REQ-002/003/006/059/127. |

## Delivery sequence

1. **M1 — Specify and implement the original engine:** immutable round rules, integer complete-set ledger, funded limit/IOC matching, reservation/partial-fill/cancel/expiry, deterministic resolution/redemption and model tests. Build corresponding UI status adapters against a test harness; preserve the live demo as clearly separated.
2. **M2 — BTC 15m confidential test slice:** actual wallet/key lifecycle, verified deployment, encrypted order/receipt path, real test-counterparty liquidity, protected order review, complete funding/claim chain and private portfolio. Close logging/metadata and input-binding issues for the claims made by the test deployment.
3. **M3 — Failure and recovery qualification:** key rotation, stale data, unknown submissions, reorg/restart, oracle outage, cancelled/partial orders, audits/disclosures and tested custody/exit behavior. Complete all applicable P0 dialogs, empty/error states and accessibility flows.
4. **M4 — Full four-market experience:** BTC/ETH 5m/15m only after measured sequencing, latency, oracle and liquidity gates; finish P1 bulk actions, filters, preferences, notification center and exports. Enable aggregate public depth only after the disclosure review.
5. **M5 — Capped production:** applicable licenses, supported deployment, audit/remediation evidence, actual liquidity and an approved operating model. Publish only claims the hardened deployed system supports; monitor limits and reopen gates when code/deployment changes.

This sequence is gate-based. No delivery dates, oracle addresses, mainnet availability, response SLA or wallet/recovery integration are asserted by this document.

## Decisions that must be closed before implementation is treated as production

| Decision | Current position | Required output / dependent requirements |
| --- | --- | --- |
| Settlement oracle and observation selection | Candidate research only; display feed is separate | Chosen network/provider/verifier, exact boundary and missing-data policy, evidence availability. REQ-013–015/081–085. |
| Collateral/token | No production token finalized | Exact token/network/decimals/allowlist, custody and bridge behavior, approved atomic/tick/lot model. REQ-001/044/060–067. |
| Canonical ordering/cutoff | Upstream/integration gap remains | Audited request binding, authenticated time/commitment, delayed-order/cancel/reorg semantics. REQ-042/048/058. |
| Published market information | Selected public quotes first | Exact quote fields/cadence/validity; decision on aggregate depth/volume and inference budget. REQ-030–034/128. |
| TEE privacy posture | Recipient metadata and logging findings unresolved in reviewed code | Runtime changes or accurate limited claims, attestation/client verification and deployed leak checks. REQ-034–038/071/121. |
| Key storage and recovery | Must be selected and tested | Domain-separated key lifecycle, association/rotation, backup/loss policy and historical receipt expectations. REQ-070–075. |
| Fees and limits | Demo 1% is not adopted | Versioned maker/taker/application/gas/sponsorship policies, rounding, min/max notional/lot, caps. REQ-043–047/057. |
| Outcome failure/disputes | No final void/dispute choice | Precommitted conservation-preserving rule, authority and deadlines, public evidence/notice behavior. REQ-084/085. |
| Emergency exit/custody | Normal pending claims are not generic forced withdrawal | Tested selected recovery design and exact operator-dependence disclosure. REQ-063/074/125. |
| Controlled disclosure | Must match actual app/protocol governance | Authorized roles, field scope, retention, request record and notice; independent from support exports. REQ-129. |
| Production availability/licensing/audit | Not established by public testnet SDK | Applicable rights, supported deployment manifest, reviewed versions and remediation evidence. REQ-121/127. |
| Product operating restrictions | Depends on actual launch operator/markets | Applicable eligibility/access/support rules and recovery access; no invented policy. REQ-109. |

## Deliberately outside the launch scope

No perps, leverage, margin, liquidation, funding payments, naked short sales or liquidation-price calculators. No guaranteed fills, guaranteed profits, martingale/automatic loss recovery, unreviewed auto-rollover orders, public user leaderboards derived from private trades, copied-trade feed, wallet anonymity claims, fictional insurance/guaranteed recovery, unimplemented on-ramps, or placeholder buttons for future integrations.

Social profiles, comments, leaderboards, referrals/rewards, shareable positions, arbitrary market creation, additional asset classes, advanced conditional orders, public APIs and automated strategies are later candidates with separate product/security/privacy requirements. They are not needed to make the first ZEDGE binary market financially complete and must not delay the essential funding → funded order → execution → resolution → redemption → withdrawal lifecycle.
