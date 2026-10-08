# House market maker

The bot quotes both sides of the private BTC 15-minute order book as the house (`0xac8d…1ab5`, the address the deployment exempts from the per-account and all-accounts stake limits). Every 15-minute round it mints a stock of sets and rests four GTC quotes: an ask and a bid on Up, and an ask and a bid on Down. It replaces each quote just before it expires, pulls a stale quote one at a time, and pulls everything before the cutoff.

It sends its own `submitRequest` transactions from the house wallet and pays its own gas and request fee. It never goes through the relayer, for these reasons:

- **No second way in.** The relayer accepts only Privy users, and a path for the bot would be a second way in to the service that pays.
- **User limits stay for users.** The house sends more requests than anyone and would use up the per-user, global and daily limits.
- **Separate costs.** The house's costs stay in the house's own balance.
- **Cancels keep working.** The house can still cancel while Vercel or Redis is down.
- **The facilitator field keeps its meaning.** On chain it says "ZEDGE relayed a user request", and the house's requests have none.

## Running it

```
node --experimental-strip-types services/market-maker/main.mjs <command> (--mainnet | --fork http://127.0.0.1:<port>) [--settings <file>]

  run [--dry-run]   the quoting loop; --dry-run prices and decides against a simulated 200 USDC, signs and sends nothing
  status            read-only: balances (Horizen ETH, Base ETH and USDC), queue, the current round, spot, σ, fair value and the quotes it would rest
  deposit <usdc>    moves Base USDC from the house wallet into the ZEDGE vault with a permit (the house sends it and pays the Base gas);
                    the order book credits it about a minute later
  withdraw <usdc>   asks the order book to pay free private cash to the house on Base; the payout signer pays it
```

The bot refuses to start unless exactly one target is named:

- **`--mainnet`** uses the deployment in the committed order-book manifest, `public/deployments/26514-orderbook.json` (read at start; refused while it is `planned`). It sends through `https://26514.rpc.thirdweb.com` (keyed with `~/.config/zedge/thirdweb.id` when present) and reads Base through Alchemy (`~/.config/zedge/alchemy.key`) or `https://mainnet.base.org`. An opening taken from the registry is not cross-checked on a second endpoint: Caldera's public one refused the operator's network and the bot skipped every round.
- **`--fork <url>`** takes only `http://127.0.0.1`, `localhost` or `[::1]`. The node must answer `web3_clientVersion` as Anvil and serve chain 26514, so a real node is refused even on a loopback address. A fork needs a settings file with a `fork` section.

Run with Node 22 or later. The bot imports `adapters/vela/crypto` (`session.ts`, `guest.ts`, `pad.ts`, and their `ethers` and `@horizen/vela-common-ts`) the same way `demo-house.mjs` and `fork-round.mjs` do, so run `npm ci` in `adapters/vela/crypto` first.

### Before the first `run` on mainnet

1. **Fund the house wallet.**
   - At least 0.1 ETH on Horizen. One request costs about 0.0000017 ETH, a round takes 53 to about 250 requests ([Gas](#gas)), and the bot stops quoting below `minEthWei`. The operator wallet pays for two transitions per house request, so it needs about 0.6 times the house's figure again.
   - A little ETH on Base (a deposit is about 0.6 M gas) and 100 to 200 USDC on Base (the vault takes 1 to 500 per deposit).
2. **Run `deposit <usdc>`.** The engine registers the house when it credits the first deposit. If the house key was never registered with the operator, the bot registers it at its first `run` or `withdraw` (`ASSOCIATEKEY`).
3. **Run `status`, then `run --dry-run` for a few minutes, and read the decisions.**

It is better to run the bot on a different machine from the operator, so the bot's RPC traffic and restarts stay away from the manager.

## The key

- **Where it is read from.** On mainnet the bot reads `~/.config/zedge/house.key`. On a fork it reads the file named by `fork.keyFile`.
- **What the file must be.** A regular file (not a link), mode `600`, holding `0x` and 64 hex digits. The bot checks that the key's address is the house, the pinned one on mainnet or `fork.house` on a fork.
- **It is never shown.** The key is never printed or logged. Only the address is.
- **One process per key.** Every command that sends holds `<keyFile>.lock` with its process ID, and a second process is refused. A lock left by a process that has died is taken over.
- **Unlocking.** The private-data key is derived once per process from one local signature with the same challenge as the website. It is kept in memory only.

## Settings

The settings file is optional with `--mainnet` (`settings.example.json` holds the defaults) and required with `--fork`. Unknown fields are refused.

| Field | Default | Range | Meaning |
| --- | --- | --- | --- |
| `halfSpreadCents` | 3 | 1–20 | h: bid = ⌊100p⌋ − h, ask = ⌈100p⌉ + h |
| `quoteShares` | 10 | 1–1,000 | size of each quote, in shares |
| `mintSets` | 40 | ≥ `quoteShares` | sets minted when an ask lacks shares; with less cash, only the shares that ask lacks |
| `maxStakeUsdc` | 100 | 1–2,000 | local cap on the house's worst stake over all rounds (the on-chain `houseTotal` is 2,000) |
| `quoteLifetimeSeconds` | 60 | 60–600 | L: each side's quote expires on that side's own L-second grid, 0.5 L to 1.5 L after it is placed (and at least two request cycles), and never after cutoff − 60 |
| `requoteDriftCents` | 4 | 1–50 | a resting quote this far from the price it would get now is stale and is pulled with `cancel_order` |
| `minEthWei` | `"200000000000000"` | — | no new quotes below this house ETH balance (a needed cancel still goes out) |
| `maxRpcPerRound` | 6,000 | 50–20,000 | a runaway brake: above this many JSON-RPC calls in a round, no new quotes until the next round |
| `pollSeconds` | 2 | 2–60 | idle loop interval |

With `--fork`, also give the fork's deployment. Every address must be lowercase.

```json
{ "fork": { "keyFile": "…/house.key", "house": "0x…", "endpoint": "0x…", "authenticator": "0x…", "trigger": "0x…",
            "registry": "0x4dd4aacdb7e8d2e6d06c5af38238f3deab836744", "applicationId": "…", "applicationFingerprint": "<wasm sha256>",
            "origin": "http://127.0.0.1:4189", "epoch": "1", "vault": "0x…", "baseRpc": "http://127.0.0.1:<Base Anvil port>" } }
```

## Pricing

- **Fair value.** p = Φ(ln(S/S0) / (σ√τ)), clamped to [0.02, 0.98]. Ties resolve Up. The chance of a void is not priced in.
  - **τ** is (round end − chain time) / 31,536,000. Chain time is the later of the head block's timestamp and the exchange clock its latest receipt was judged at (`at`; a Chainlink report can move that clock ahead of the block time, guest README §8.3), never the wall clock, so time jumps on a fork are followed.
- **S, the BTC spot price.** The bot uses the mid of the Coinbase Exchange `BTC-USD` ticker and checks it against the Kraken `XBTUSD` ticker. It reads both before every decision. It does not quote if either is older than 10 s or if they differ by more than 0.3 %.
- **S0, the opening price.** The engine's own opening: the guest's public `settle` event (kind 1) for the round, from the exact Chainlink report, seconds after the boundary. Fallback: the registry's recorded opening, `getRound(id).opening.price`, confirmed on mainnet on the second RPC before the first quote of the round.
- **σ, the volatility.** Realised volatility of the last 60 Coinbase 1-minute closes, annualised (×√525,600) and clamped to [0.30, 1.50]. It is read once per round.
- **Quotes, in integer cents.**
  - Up: bid = clamp(⌊100p⌋ − h, 1, 97) and ask = clamp(⌈100p⌉ + h, 3, 99).
  - Down: the same with 1 − p.
  - The two asks always add up to more than 100 and the two bids to less than 100. So the house never sells a complete set below 1 USDC or buys one above 1 USDC.

## One round

1. **The opening.** The engine opens the round itself from the exact Chainlink report (the keeper relays it); the bot quotes once it sees the `settle` event. Only when the opening comes from the registry (fallback) does it send one sync, whose tick mirrors the opening into the engine.
2. **Mint.** When an ask lacks shares, it mints `mintSets` sets, or with less cash than that only the shares the ask lacks, so a small house still rests asks.
3. **Quote.** It places each missing quote in this order: ask Up, ask Down, bid Up, bid Down. Each is GTC. Side k (k = 0 to 3 in that order) expires at a time ≡ k·L/4 modulo L (k·15 s modulo 60 s at the default lifetime L), 0.5 L to 1.5 L after it is placed, so the four rotations fall due 15 s apart and never queue behind each other; no quote outlives cutoff − 60. A new quote also lives at least two request cycles, so a slow queue cannot commit it already expired (`invalid order`, a counted refusal). The engine releases expired orders in the checkpoint that runs before any activation, so **no house quote can fill after cutoff − 60, even when the queue is jammed**.
4. **Rotate.** The guest allows four resting orders per account, house included, so the bot never places a fifth and cancels after. It treats a quote expiring within 2 s as gone and sends the replacement then: the request is committed at least 2 s later (Horizen stamps blocks 1 s apart), so the tick's checkpoint releases the old quote and then activates the new one. One request per rotation, no cancel, and the side is empty only for the house's own queue latency. The replacement expires one lifetime after the old one.
5. **Pull a stale quote.** Each decision, in this order:
   - **A quote in the trader's favour** by `requoteDriftCents` or more (an ask below the price it would get now, a bid above it) is pulled first with `cancel_order`, the furthest first, even before an empty side is refilled.
   - **Empty sides** are then refilled. If the new quote would meet the house's own quote on the other side of that book, that quote is pulled instead: the engine's self-trade prevention would cancel the new one.
   - **A quote drifted the house's way** (users pay above the fresh price for it) is pulled only when no side is empty (even one the stake cap or cash leaves empty), no rotation falls due within one request cycle, at most once per 15 s, and only while the endpoint queue is empty, so user trades are not queued behind it.
   - **Near expiry, nothing is cancelled.** No quote expiring within max(12 s, 2 request cycles) is cancelled: the cancel would land after it is gone and be refused (`unknown active order`), and since a refusal uses no nonce, the next command would be refused too. It rotates instead. The request cycle is a moving average of submission to completion (the `round done` line prints it).
6. **Wind down.** From cutoff − 120 it places nothing new. Between cutoff − 90 and cutoff − 60 it sends a `cancel_all` if anything still rests, as a backstop.
7. **Settle.** The engine's settlement sweep redeems the house's shares in the round. The house's next command after a sweep is usually refused for its nonce. That refusal is private and costs one request, and its receipt carries the right nonce for the next one.

### How it tracks what it holds

- **The view.** The bot's view of the house is the `view` from its latest receipt.
- **Book commands not yet confirmed.** A book command (`place_order`, `cancel_order`, `cancel_all`) is staged first and activated by its tick. Until its result comes back with the next request, the bot assumes it was applied whole. A staged order rests under its command ID (`<account>:<nonce>`), so it can be cancelled before its result comes back. The operator processes the tick before the house's next request, because the trigger queue goes first.
- **Nonces.** The next nonce is the view's nonce plus one, plus one more while a book command is staged. A wrong guess is a private refusal whose receipt carries the right view.

### What it refuses to do

- **Pinned values.** On mainnet the bot refuses to start if any of these differ from the pins: the operator's enclave key, the operator's signer, the request fee (1 gwei), or the engine configuration rebuilt from the registry (session rules hash `8670678e…a21c`). At every round it checks the trigger binding, the state root, the keys and the fee again, and if any changed it quotes nothing that round.
- **No price.** It does not quote while the spot price is stale or disputed, the opening price is missing or unconfirmed, or σ is unavailable.
- **The stake cap.** It does not place an order that would take the house's worst stake (guest README §9), summed over every round it holds, above `maxStakeUsdc`.
- **Busy queue.** It does not send while the endpoint queue holds 5 or more requests, except a needed cancel (`cancel_all`, or a `cancel_order` of a quote in the trader's favour or in the way of a refill), which goes out until 9 (the endpoint refuses at 10). An optional requote waits for an empty queue. It keeps one request in flight at a time.
- **Low ETH.** It sends no new quotes below `minEthWei`. Needed cancels still go out.
- **Too many refusals.** After 3 refusals or failures in a round it places nothing new until the next round. Needed cancels still go out. Two refusals are not counted, because the view was stale and the receipt brings the true one: "insufficient available" cash or shares (a user filled a house quote since the last receipt) and "unknown active order" (a quote being cancelled was filled or expired first). An `order capacity` refusal is counted.
- **No completion.** If a request has not completed after 15 minutes, the bot exits. It never resends.
- **Errors.** Five network errors in a row stop the bot.
- **Stopping.** On the first SIGTERM or SIGINT the bot finishes the request in flight, sends `cancel_all` if quotes still rest in the open round, and exits. A second signal exits at once.

## Quotes for the site

With `HOUSE_QUOTES_PORT` set (`deploy/railway/start.sh` sets 8080 unless it is set already), `run` serves `GET /quotes` on that port
on every interface (`::`, so Railway's private network reaches it); anything else is a 404. The indexer reads it every second
(`INDEXER_HOUSE_URL`) and passes it on as `house` in `/v1/live`, so the site shows the house's real prices.

```
{ "at": 1791400003000, "start": 1791399600,
  "up":   { "ask": { "cents": 55, "shares": 10 }, "bid": { "cents": 47, "shares": 10 } },
  "down": { "ask": { "cents": 53, "shares": 10 }, "bid": null } }
```

- **What it holds.** The house's resting orders in the open round as the bot knows them (its latest receipt, a staged command
  applied whole). An order expiring within 2 s is left out, as the bot counts it gone ([One round](#one-round), step 4): no
  order sent now can reach it, and its replacement, once sent, is in the view. Per outcome, `ask` is the lowest resting sell and
  `bid` the highest resting buy, with the shares left at that price, or `null`. `at` is the time (ms) of the bot's latest
  decision, `start` the round. No balances, holdings or keys.
- **When it changes.** It is built at each request from the bot's latest view, so it changes right after every receipt (placed,
  cancelled, a fill it learns about) and at each round change, when it starts empty. Expiry is checked at the chain time now (the
  latest read plus the time since), so a quote drops out 2 s before it expires even while the bot waits on a request. It is
  `null` until the first decision.
- **Never in the way.** Not served under `--dry-run`, whose orders are simulated. A server error (a port in use, a bad port) is
  logged as `quotes server error` and the bot quotes on without it.

## Logs

Logs are one JSON line per event. They include the house's private view (cash, orders, holdings, stake), which is the operator's own data, so do not send these logs to a third party. A `round done` line records the round's requests, refusals, JSON-RPC calls, the house's ETH before and after, and the request cycle in seconds.

## Check

```
node --test services/market-maker/market-maker.test.mjs
```

The test runs offline in under a second. It checks:

- **Fair value:** it is 0.5 at the opening price and rises with spot.
- **Quotes:** the bid and ask rules hold across p from 0.02 to 0.98.
- **Stake:** the fork-round stake case gives exactly 100 shares. That case is mint 120, ask Up 50 at 55¢, ask Down 50 at 55¢ and bid Up 50 at 45¢.
- **Round behaviour:** the mint, the four quotes on their expiry grids, the rotation sent at expiry − 2 (not − 3), the stake cap, and the last two minutes.
- **Stale quotes:** 3¢ of drift keeps the quotes and 4¢ pulls one by ID; after a jump with one side filled, the cancel of the quote in the trader's favour is the first command; quotes drifted the house's way are optional and wait while a rotation is due within one cycle or a side is empty (also one the stake cap leaves empty); nothing expiring within max(12, 2 cycles) is cancelled, the self-cross target included; an ask clamped at 99¢ never loops.
- **A simulated round** (one request in flight, each taking d seconds, the checkpoint before activation): at a constant price only one side is empty at a time, for at most d − 1 s (d = 2, 3 and 6) and a round takes 50 to 60 requests; over seeded random walks with requests taking 2 to 8 s, no `order capacity`, self-cross, `unknown active order` or expired-on-arrival activation.
- **Guards:** `cancel_order` passes the queue guard like `cancel_all`, an optional requote only into an empty queue.
- **The start guard:** a non-loopback or HTTPS fork URL, a loopback node that is not Anvil, no target named, and both targets named are each refused.
- **The settings example** holds the defaults; `maxRpcPerRound` takes up to 20,000.
- **Quotes for the site:** the lowest resting sell and the highest resting buy per outcome, expired, filled and other-round orders left out; during a rotation, the staged replacement, not the ask expiring within 2 s.

## Not yet proven

- **No full run yet.** The bot has not run against a fork stack with an operator, so no request of the bot has completed and no quote has rested on any chain. The integration spec's fork run (§6, step 2 and step 5) is that proof.
- **What has been checked on an Anvil fork of mainnet** (no operator; nothing sent to a public chain):
  - The session rules hash comes out as `8670678e…a21c`, which confirms the engine configuration and round IDs.
  - The deployment checks pass.
  - `status` and `run --dry-run` work.
  - The startup sync reached the real endpoint code as a 2,076-byte PROCESS request.
  - The lock and the signal handling work.
- **Not measured yet:** JSON-RPC calls, requests and ETH per round with these defaults. The `round done` line measures all three, and the request cycle. The estimate is about 12 calls per request plus one head read per 2 s loop: about 1,100 calls in a calm round, about 3,500 at the ceiling below.
- **One side can still be empty for about one request cycle per stale quote,** and a quote in the trader's favour is pulled before an empty side is refilled. In a fast market the single request in flight is the limit: in the simulator, with p stepping 1¢ in a fifth of the seconds plus occasional 8¢ jumps, a side was empty for up to about 50 s at 6 s per request and about 12 to 18 s at 3 s per request.
- **Drift cancels will be frequent.** Near the end of a round a $10 move shifts p by about 7¢ at σ = 0.34.
- **Fixed gas fee cap.** The gas fee is fixed at Horizen's usual level (max fee 2,000,504 wei, tip 1,000,000 wei), as `demo-house.mjs` pays it. If the base fee rose above about 1,000,000 wei, the bot's transactions would not be mined. The 15-minute completion limit would then stop the bot.

### Gas

A house request costs 1,684,953 to 1,685,044 gas at 1,000,252 wei, about **0.0000017 ETH** (measured on chain; the L1 fee is negligible). Each one also costs the operator two transitions, about 0.0000008 to 0.0000012 ETH. With the defaults, at 96 rounds a day:

| Round | House requests per round | House ETH per round | House ETH per day |
| --- | --- | --- | --- |
| Calm: 1 mint, 4 quotes, about 47 rotations, the wind-down `cancel_all` (simulated) | ~53 | ~0.00009 | ~0.009 |
| Busy: the simulator's random walks above, 2 to 8 s per request | 70 to 100 | 0.00012 to 0.00017 | 0.011 to 0.017 |
| Ceiling: one request in flight for the whole round at the measured 3.1 s per request | ~250 | ~0.00042 | ~0.040 |

The operator pays about 0.5 to 0.7 times these figures again. At least 0.1 ETH in the house wallet lasts about 2.5 days at the ceiling and about 11 days in calm rounds; the `minEthWei` floor (0.0002 ETH) leaves room for about 100 cancels.
