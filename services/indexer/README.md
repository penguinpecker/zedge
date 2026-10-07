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

Each Horizen step reads the cursor block's header (reorg check: a changed hash rewinds 600 blocks, the reorg ceiling), then the
range's last header and its logs in one batch. Logs marked `removed` are skipped; every log in a block still inside the rewind
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
| `GET /v1/live` | `{ head: {block,time}, clock: {tick,block,timestamp,applied,skipped,deposits,txHash,logIndex} \| null, rounds: [previous, current, next], price: [minute, usd] \| null }` | `s-maxage=1, stale-while-revalidate=4` |
| `GET /v1/btc` · `?minutes=N` (≤ 1,440) · `?from=&to=` (minute starts, ≤ 1,440 minutes apart) | `{ prices: [[minute, usd], …] }`, oldest first: `/api/btc`'s body; the default is its 120 minutes | `s-maxage=2, stale-while-revalidate=30`; a range ending over 5 min ago `s-maxage=3600` |
| `GET /v1/rounds` · `?from=&to=` (round starts, ≤ 200 rounds) | `{ head, rounds }`; the default is the last 24 h and the current round | `s-maxage=1, stale-while-revalidate=5`; rounds ended over 2 h ago `s-maxage=300` |
| `POST /v1/account` `{ address, before?: {block,logIndex}, limit? }` (≤ 100, default 50; `Origin` must be the site's; body ≤ 1 KB) | `{ head, more, requests: [{ requestId, block, logIndex, txHash, completed: {block,txHash,status,errorCode,errorMessage} \| null, ciphertexts: [base64] }] }`, newest first | `no-store` |
| `GET /v1/status` | `{ horizen: {block,time,chainHead,behindBlocks}, solana: {minute,ageSeconds}, balances: {operator,house,relayer: {address,wei,low}}, dbBytes, alerts: [] }`; 503 if the database does not answer (the health check) | `s-maxage=5` |

A round is `{ start, registryRoundId, open, settle }`; `open` (kind 1) and `settle` (kind 2 resolved, 3 voided) are the guest's
`settle` records `{ kind, outcome, price, observationsTimestamp, reportHash, source, block, txHash, logIndex }`. An uptime
monitor on `/v1/status` can alert on anything but `"alerts":[]` (low balances: operator and house below 0.005 ETH, relayer below
0.001 ETH; indexing more than 30 blocks behind; prices older than 3 minutes).

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
```

Railway service `indexer`: `ZEDGE_SERVICE=indexer`, `DATABASE_URL` (reference), `ZEDGE_HORIZEN_RPC`, `ZEDGE_SOLANA_RPC` (sealed),
health check `/v1/status`, a public domain on `$PORT`, no volume. Addresses come from `public/deployments/26514-orderbook.json`;
the allowed origin is its `application.origin`. The site reaches the API through a Vercel rewrite of `/v1/*`.

## Run and test

```
node --experimental-strip-types services/indexer/main.mjs --settings FILE
node --experimental-strip-types --test services/indexer/*.test.mjs
```

`store.test.mjs` needs a throwaway Postgres in `TEST_DATABASE_URL` (CI starts one) and skips without it.
