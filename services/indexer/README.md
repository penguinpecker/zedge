# Indexer and read API

Follows this application's endpoint events on Horizen and Chainlink BTC/USD on Solana into Postgres, and serves them to the
site, so a browser no longer rebuilds history and prices from the chain itself.

- **Public data only.** Requests, completions, the guest's public records and the encrypted receipts exactly as they are on
  chain, and minute prices. The indexer holds no key and decrypts nothing; receipts are opened in the browser as before.
- **Display only.** The money paths (payout signer, keeper, house) never read this database. The API can drop, delay or
  replay rows, so the site treats its answers as display data and checks on chain whatever changes what a user signs.
  Receipts are tied to the exchange's command id, not to the on-chain request, and all syncs share `<account>:sync`.
- **No address in a URL or a log.** An account is asked for in a POST body; logs carry counts and fixed error codes only.

## What it follows

| Source | Read | Cursor |
| --- | --- | --- |
| Horizen endpoint, logs of this application (`topic1` = application id) | `RequestSubmitted`, `RequestCompleted`, `UserEvent`, `AppEvent` | last block + hash; 3 blocks behind the head; 1 s polls |
| Solana round program (`2DeGBCAi…`, as `/api/btc`) | every transaction since 2026-10-07 00:00 UTC, oldest first; each verified BTC/USD report is its minute's price | last signature + its block time |

Each Horizen step reads the head, then in one batch the cursor block's header (reorg check: a changed hash rewinds 600 blocks,
the reorg ceiling), the range's last header and its logs. Logs marked `removed` are skipped; every log in a block still inside the rewind
window must carry that block's hash; a size refusal halves the range. Each write is one transaction that moves the cursor
compare-and-set, on the one connection that holds the advisory lock, so a second writer (a deploy overlap, a dropped
connection) can never interleave. Losing that connection exits the process; Railway restarts it. Every instance serves the API.

Receipts are kept forever (owner decision, 2026-10-07). At about 14,000 requests a day that is roughly 120 MB a day; watch
`dbBytes` in `/v1/status`.

## API

JSON; big integers are decimal strings; hashes and addresses 0x hex; ciphertexts base64. Errors are `{ error }` with
`no-store`. Unknown or repeated query parameters are refused, so the CDN keys stay few.

| Route | Body | Cache-Control |
| --- | --- | --- |
| `GET /v1/live` | `{ head: {block,time}, clock: {tick,block,timestamp,applied,skipped,deposits,txHash,logIndex} \| null, rounds: [previous, current, next], price: [minute, usd] \| null, house, event }` | `s-maxage=1, stale-while-revalidate=4` |
| `GET /v1/btc` · `?minutes=N` (≤ 1,440) · `?from=&to=` (minute starts, ≤ 1,440 minutes apart) | `{ prices: [[minute, usd], …] }`, oldest first: `/api/btc`'s body; the default is its 120 minutes | `s-maxage=2, stale-while-revalidate=30`; a range ending over 5 min ago that the follower has read past (a price held 2 min after its end) `s-maxage=3600` |
| `GET /v1/rounds` · `?from=&to=` (round starts, ≤ 200 rounds) | `{ head, rounds }`; the default is the last 24 h and the current round | `s-maxage=1, stale-while-revalidate=5`; rounds ended over 2 h before the indexed head `s-maxage=300` |
| `POST /v1/account` `{ address, before?: {block,logIndex}, limit? }` (≤ 100, default 50; `Origin` must be the site's; body ≤ 1 KB) | `{ head, more, requests: [{ requestId, block, logIndex, txHash, completed: {block,txHash,status,errorCode,errorMessage} \| null, ciphertexts: [base64] }] }`, newest first | `no-store` |
| `GET /v1/event` | `{ head, round, registryRoundId, settle }`: the event's engine round id (0x), the registry round id its records carry, and its settle record or `null`; 404 when the image has no events manifest | `s-maxage=5` |
| `GET /v1/status` | `{ horizen: {block,time,chainHead,behindBlocks}, solana: {minute,ageSeconds}, balances: {operator,house,relayer: {address,wei,low}}, dbBytes, alerts: [] }`; 503 if the database does not answer (the health check) | `s-maxage=5` |

A round is `{ start, registryRoundId, open, settle }`; `open` (kind 1) and `settle` (kind 2 resolved, 3 voided) are the guest's
`settle` records `{ kind, outcome, price, observationsTimestamp, reportHash, source, block, txHash, logIndex }`. An uptime
monitor on `/v1/status` can alert on anything but `"alerts":[]` (low balances: operator and house below 0.005 ETH, relayer below
0.001 ETH; indexing more than 30 blocks behind; prices older than 3 minutes).

`house` is the house's resting quotes, `null | { at, start, up: { ask, bid }, down: { ask, bid } }`: `at` the time (ms) of the house
bot's latest order state, `start` the round they belong to, `ask` its lowest resting sell and `bid` its highest resting buy on that
side, each `{ cents, shares }` or `null`. Every instance reads the bot's `GET /quotes` (services/market-maker README) once a second
with an 800 ms timeout, checks each field (cents an integer 1 to 99, shares above 0, start an integer, no other field) and keeps the
latest good answer. `house` is `null` when that answer was fetched over 20 s ago, belongs to another round, or `INDEXER_HOUSE_URL`
is not set. Display only, like the rest of this API.

`event` is the event house's resting quotes, `null | { round, at, up: { ask, bid }, down: { ask, bid } }`, up = Yes and down = No:
the same checks and polling as `house` (`INDEXER_EVENT_HOUSE_URL`), with `round` (the event's engine round id, `0x` and 64 lowercase
hex) in place of `start`. It is `null` when the latest good answer was fetched over 60 s ago, names another round than the events
manifest's event, the trading cutoff has passed, or either the URL or the events manifest is missing.

The event is the one in `public/deployments/26514-events.json` (written with the order-book manifest at a switch-over); its ids are
derived as the guest does (`eventRound`, adapters/vela/crypto/guest.ts). Its settle record is stored like a BTC round's, keyed by the
registry round id: the resolver's result is kind 2, outcome 1 (Yes) or 2 (No), source 4, with price, time and report hash zero; the
timeout void is kind 3, outcome 3, source 3. It never appears in `/v1/live` or `/v1/rounds`, which only ask for BTC rounds' ids.
Requests and receipts of the event (orders, the resolver's result) are an account's like any other, in `/v1/account`.

Rate limits, per 10 s window: 120 GETs and 20 POSTs per visitor, 2,000 requests per edge address. The edge address is the
last `X-Forwarded-For` entry (the one Railway's proxy appends, which a caller cannot forge); the visitor is the entry before
it (the client as Vercel saw it). The real ceilings behind those are the pool (8 connections) and a 2 s statement timeout.

**Header check after the first deploy.** A process logs `{"xffEntries": n}` the first time it serves a request with n
`X-Forwarded-For` entries (a count, never an address). After one page load of the site, the log should show 2 (visitor,
Vercel); a direct `curl -H 'X-Forwarded-For: 203.0.113.1'` to the Railway domain should show 2 as well. If the site's requests
show 1, Railway does not append and every visitor shares one key: key on the last entry only and rely on a Vercel Firewall
rate-limit rule for `/v1/account`, which is recommended in any case.

## Settings

A 0600 file, written by `deploy/railway/start.sh` from Railway variables:

```
DATABASE_URL=postgresql://…@postgres.railway.internal:5432/railway   # ${{Postgres.DATABASE_URL}}: private network only
INDEXER_HORIZEN_RPC_URL=https://…                                      # a private endpoint, never the operator's Caldera one
INDEXER_SOLANA_RPC_URL=https://…                                       # optional; the public mainnet endpoint otherwise
INDEXER_HOUSE_URL=http://house-bot.railway.internal:8080/quotes        # optional; /v1/live's house is null without it
INDEXER_EVENT_HOUSE_URL=http://…railway.internal:…/quotes              # optional; /v1/live's event is null without it
```

Railway service `indexer`: `ZEDGE_SERVICE=indexer`, `DATABASE_URL` (reference), `ZEDGE_HORIZEN_RPC`, `ZEDGE_SOLANA_RPC` (sealed),
`ZEDGE_HOUSE_QUOTES_URL` and `ZEDGE_EVENT_HOUSE_QUOTES_URL` (optional, not secrets: they become `INDEXER_HOUSE_URL` and
`INDEXER_EVENT_HOUSE_URL`),
health check `/v1/status`, a public domain on `$PORT`, no volume. Addresses come from `public/deployments/26514-orderbook.json`;
the allowed origin is its `application.origin`. The site reaches the API through a Vercel rewrite of `/v1/*`.

## Switch-over to a new application

The indexer follows the application named by `public/deployments/26514-orderbook.json` in its image, and that application's event
from `26514-events.json` beside it. A switch-over (docs/cutover-politics.md) commits both; the indexer is redeployed from that
export with the other services. The tables have no application column, so the database is reset for the new application. The BTC
price history (`btc_minutes` and the `solana` cursor) stays. The old application's requests, completions, receipts and records move
to a schema of their own and are kept, like every receipt.

1. Deploy the indexer from the switch-over's export. It serves the API at once, still from the old rows. It writes nothing while
   the database holds a request from before the new application's deploy block: it logs `{"status":"waiting",…}` once and looks
   again every 5 s. Meanwhile `/v1/status` shows `horizen indexing behind`, and prices are not followed.
2. Wait until Railway shows the old indexer deployment as removed. Its process holds the old application's lock until it exits.
3. Run this once against the indexer's Postgres. Use `railway connect Postgres` (it needs a local `psql`, for example
   `brew install libpq`), or paste it into the Postgres service's query tab. The id is the application being left: 7408397676477227659
   at the 2026 switch-over. For a later switch-over, replace every 7408397676477227659 in it with the id being left.

   ```sql
   DO $$
   BEGIN
     IF NOT pg_try_advisory_xact_lock(7408397676477227659) THEN
       RAISE EXCEPTION 'the indexer of application 7408397676477227659 is still running: wait until its deployment is removed';
     END IF;
     CREATE SCHEMA app_7408397676477227659;
     ALTER TABLE requests SET SCHEMA app_7408397676477227659;
     ALTER TABLE completions SET SCHEMA app_7408397676477227659;
     ALTER TABLE receipts SET SCHEMA app_7408397676477227659;
     ALTER TABLE records SET SCHEMA app_7408397676477227659;
     DELETE FROM cursors WHERE name = 'horizen';
   END $$;
   ```

   It is one statement, so it applies in full or not at all. While an indexer of the old application still holds its lock, it
   refuses and changes nothing.
4. Within 5 s the new indexer recreates the four tables and the `horizen` cursor at its deploy block − 1, and logs
   `{"status":"indexing",…}`. It reads from the deploy block in 1,000-block ranges; `/v1/status` `behindBlocks` falls back to about 3.
   In those few seconds `/v1/live`, `/v1/rounds`, `/v1/event` and `/v1/account` answer 503; `/v1/status` keeps answering.

Check:

```sql
SELECT name, block FROM cursors;                        -- horizen: the new deploy block − 1, then rising; solana unchanged
SELECT count(*) FROM app_7408397676477227659.requests;  -- the old application's requests, kept
SELECT count(*), max(minute) FROM btc_minutes;          -- unchanged, then rising again
```

Afterwards, never redeploy an indexer image from before the switch-over: it does not wait, and it would write the old application's
rows into the new tables. The wait in step 1 only sees rows older than the followed application's deployment. So an indexer pointed
back at an older application (a rollback) needs this reset first, with the newer application's id.

## Run and test

```
node --experimental-strip-types services/indexer/main.mjs --settings FILE
node --experimental-strip-types --test services/indexer/*.test.mjs
```

`store.test.mjs` needs a throwaway Postgres in `TEST_DATABASE_URL` (CI starts one) and skips without it.
