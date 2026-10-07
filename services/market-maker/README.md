# House market maker

The bot quotes both sides of the private BTC 15-minute order book as the house (`0xac8d…1ab5`, the address the deployment exempts from the per-account and all-accounts stake limits). Every 15-minute round it mints a stock of sets and rests four GTC quotes: an ask and a bid on Up, and an ask and a bid on Down. It replaces each quote when it expires and pulls everything before the cutoff.

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

- **`--mainnet`** uses the deployment in the committed order-book manifest, `public/deployments/26514-orderbook.json` (read at start; refused while it is `planned`). It sends through `https://26514.rpc.thirdweb.com` and reads Base through `https://base-rpc.publicnode.com`. An opening taken from the registry (the fallback) is checked once more on `https://horizen.calderachain.xyz/http`: one read per round, at most three tries.
- **`--fork <url>`** takes only `http://127.0.0.1`, `localhost` or `[::1]`. The node must answer `web3_clientVersion` as Anvil and serve chain 26514, so a real node is refused even on a loopback address. A fork needs a settings file with a `fork` section.

Run with Node 22 or later. The bot imports `adapters/vela/crypto` (`session.ts`, `guest.ts`, `pad.ts`, and their `ethers` and `@horizen/vela-common-ts`) the same way `demo-house.mjs` and `fork-round.mjs` do, so run `npm ci` in `adapters/vela/crypto` first.

### Before the first `run` on mainnet

1. **Fund the house wallet.**
   - About 0.005 ETH on Horizen. One request costs about 0.0000017 ETH, and the bot stops quoting below `minEthWei`.
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
| `mintSets` | 40 | ≥ `quoteShares` | sets minted when an ask lacks shares, if cash allows |
| `maxStakeUsdc` | 100 | 1–2,000 | local cap on the house's worst stake over all rounds (the on-chain `houseTotal` is 2,000) |
| `quoteLifetimeSeconds` | 180 | 60–600 | each quote expires at min(now + this, cutoff − 60) |
| `requoteDriftCents` | 8 | 1–50 | `cancel_all` when a resting quote is this far from 100p |
| `minEthWei` | `"200000000000000"` | — | no new quotes below this house ETH balance (a cancel still goes out) |
| `maxRpcPerRound` | 300 | 50–5,000 | above this many JSON-RPC calls in a round, no new quotes until the next round |
| `pollSeconds` | 10 | 2–60 | idle loop interval |

With `--fork`, also give the fork's deployment. Every address must be lowercase.

```json
{ "fork": { "keyFile": "…/house.key", "house": "0x…", "endpoint": "0x…", "authenticator": "0x…", "trigger": "0x…",
            "registry": "0x4dd4aacdb7e8d2e6d06c5af38238f3deab836744", "applicationId": "…", "applicationFingerprint": "<wasm sha256>",
            "origin": "http://127.0.0.1:4189", "epoch": "1", "vault": "0x…", "baseRpc": "http://127.0.0.1:<Base Anvil port>" } }
```

## Pricing

- **Fair value.** p = Φ(ln(S/S0) / (σ√τ)), clamped to [0.02, 0.98]. Ties resolve Up. The chance of a void is not priced in.
  - **τ** is (round end − chain time) / 31,536,000. Chain time is the head block's timestamp, never the wall clock, so time jumps on a fork are followed.
- **S, the BTC spot price.** The bot uses the mid of the Coinbase Exchange `BTC-USD` ticker and checks it against the Kraken `XBTUSD` ticker. It reads both before every decision. It does not quote if either is older than 10 s or if they differ by more than 0.3 %.
- **S0, the opening price.** The engine's own opening: the guest's public `settle` event (kind 1) for the round, from the exact Chainlink report, seconds after the boundary. Fallback: the registry's recorded opening, `getRound(id).opening.price`, confirmed on mainnet on the second RPC before the first quote of the round.
- **σ, the volatility.** Realised volatility of the last 60 Coinbase 1-minute closes, annualised (×√525,600) and clamped to [0.30, 1.50]. It is read once per round.
- **Quotes, in integer cents.**
  - Up: bid = clamp(⌊100p⌋ − h, 1, 97) and ask = clamp(⌈100p⌉ + h, 3, 99).
  - Down: the same with 1 − p.
  - The two asks always add up to more than 100 and the two bids to less than 100. So the house never sells a complete set below 1 USDC or buys one above 1 USDC.

## One round

1. **The opening.** The engine opens the round itself from the exact Chainlink report (the keeper relays it); the bot quotes once it sees the `settle` event. Only when the opening comes from the registry (fallback) does it send one sync, whose tick mirrors the opening into the engine.
2. **Mint.** When an ask lacks shares, it mints `mintSets` sets if its cash allows.
3. **Quote.** It places each missing quote in this order: ask Up, ask Down, bid Up, bid Down. Each is GTC and expires at min(now + 180, cutoff − 60). The engine releases expired orders in the checkpoint that runs before any activation, so **no house quote can fill after cutoff − 60, even when the queue is jammed**.
4. **Rotate.** It places a quote again once it has expired or filled, and sends a `cancel_all` when the price moves `requoteDriftCents` from a resting quote.
5. **Wind down.** From cutoff − 120 it places nothing new. Between cutoff − 90 and cutoff − 60 it sends a `cancel_all` if anything still rests, as a backstop.
6. **Settle.** The engine's settlement sweep redeems the house's shares in the round. The house's next command after a sweep is usually refused for its nonce. That refusal is private and costs one request, and its receipt carries the right nonce for the next one.

### How it tracks what it holds

- **The view.** The bot's view of the house is the `view` from its latest receipt.
- **Book commands not yet confirmed.** A book command (`place_order`, `cancel_all`) is staged first and activated by its tick. Until its result comes back with the next request, the bot assumes it was applied whole. The operator processes the tick before the house's next request, because the trigger queue goes first.
- **Nonces.** The next nonce is the view's nonce plus one, plus one more while a book command is staged. A wrong guess is a private refusal whose receipt carries the right view.

### What it refuses to do

- **Pinned values.** On mainnet the bot refuses to start if any of these differ from the pins: the operator's enclave key, the operator's signer, the request fee (1 gwei), or the engine configuration rebuilt from the registry (session rules hash `8670678e…a21c`). At every round it checks the trigger binding, the state root, the keys and the fee again, and if any changed it quotes nothing that round.
- **No price.** It does not quote while the spot price is stale or disputed, the opening price is missing or unconfirmed, or σ is unavailable.
- **The stake cap.** It does not place an order that would take the house's worst stake (guest README §9), summed over every round it holds, above `maxStakeUsdc`.
- **Busy queue.** It does not send while the endpoint queue holds 5 or more requests, except a `cancel_all`, which goes out until 9 (the endpoint refuses at 10). It keeps one request in flight at a time.
- **Low ETH.** It sends no new quotes below `minEthWei`.
- **Too many refusals.** After 3 refusals or failures in a round it places nothing new until the next round. Cancels still go out.
- **No completion.** If a request has not completed after 15 minutes, the bot exits. It never resends.
- **Errors.** Five network errors in a row stop the bot.
- **Stopping.** On the first SIGTERM or SIGINT the bot finishes the request in flight, sends `cancel_all` if quotes still rest in the open round, and exits. A second signal exits at once.

## Logs

Logs are one JSON line per event. They include the house's private view (cash, orders, holdings, stake), which is the operator's own data, so do not send these logs to a third party. A `round done` line records the round's requests, refusals, JSON-RPC calls and the house's ETH before and after.

## Check

```
node --test services/market-maker/market-maker.test.mjs
```

The test runs offline in under a second. It checks:

- **Fair value:** it is 0.5 at the opening price and rises with spot.
- **Quotes:** the bid and ask rules hold across p from 0.02 to 0.98.
- **Stake:** the fork-round stake case gives exactly 100 shares. That case is mint 120, ask Up 50 at 55¢, ask Down 50 at 55¢ and bid Up 50 at 45¢.
- **Round behaviour:** the mint, the four quotes, re-placing expired quotes, the drift cancel, the stake cap, and the last two minutes.
- **The start guard:** a non-loopback or HTTPS fork URL, a loopback node that is not Anvil, no target named, and both targets named are each refused.
- **The settings example.**

## Not yet proven

- **No full run yet.** The bot has not run against a fork stack with an operator, so no request of the bot has completed and no quote has rested on any chain. The integration spec's fork run (§6, step 2 and step 5) is that proof.
- **What has been checked on an Anvil fork of mainnet** (no operator; nothing sent to a public chain):
  - The session rules hash comes out as `8670678e…a21c`, which confirms the engine configuration and round IDs.
  - The deployment checks pass.
  - `status` and `run --dry-run` work.
  - The startup sync reached the real endpoint code as a 2,076-byte PROCESS request.
  - The lock and the signal handling work.
- **Not measured yet:**
  - JSON-RPC calls per round. The estimate is about 15 per request (send, completion polls, receipt and guards) plus one head read per loop, around 300 for 20 requests. The `round done` line measures it.
  - Requests and ETH per round.
- **Drift cancels will be frequent.** Near the end of a round a $10 move shifts p by about 7¢ at σ = 0.34. Expect more cancels, and so more than about 20 requests per round, late in each round.
- **Fixed gas fee cap.** The gas fee is fixed at Horizen's usual level (max fee 2,000,504 wei, tip 1,000,000 wei), as `demo-house.mjs` pays it. If the base fee rose above about 1,000,000 wei, the bot's transactions would not be mined. The 15-minute completion limit would then stop the bot.
