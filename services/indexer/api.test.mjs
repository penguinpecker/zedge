// api.mjs with a stand-in database: routes, validation, cache headers, the account POST and the rate limits.
import { strict as assert } from "node:assert";
import { readFileSync } from "node:fs";
import { Readable } from "node:stream";
import { test } from "node:test";
import { engineRound, parseOrderbookManifest } from "../../src/chain/orderbook-manifest.ts";
import { handler } from "./api.mjs";

const book = parseOrderbookManifest(JSON.parse(readFileSync(new URL("../../public/deployments/26514-orderbook.json", import.meta.url), "utf8")));
const origin = book.application.origin, now = 1_791_400_000, start = Math.floor(now / 900) * 900, minute = Math.floor(now / 60) * 60;
const words = (...n) => `0x${n.map((x) => BigInt(x).toString(16).padStart(64, "0")).join("")}`;
const tx = `0x${"ab".repeat(32)}`, current = engineRound(book, start).spec.registryRoundId;
const asked = {};
const db = {
  head: async () => ({ block: 28_012_345, time: now - 2 }),
  clock: async () => ({ block: 28_012_340, logIndex: 4, txHash: tx, data: words(8123, 28_012_339, now - 5, 1, 0, 0, 9) }),
  settles: async (ids) => { asked.settles = ids; return [
    { block: 28_011_000, logIndex: 2, txHash: tx, roundId: current, data: words(current, 1, 0, 83102826982247930000000n, start + 1, 7, 1) },
    { block: 28_011_001, logIndex: 1, txHash: tx, roundId: current, data: "0x00" }, // not a settle record: ignored
  ]; },
  prices: async (from, to) => { asked.prices = [from, to]; return [{ minute: to, price: "83102826982247930000000" }]; },
  latestPrice: async () => ({ minute, price: "83254692225164660000000" }),
  account: async (address, before, limit) => { asked.account = { address, before, limit };
    return Array.from({ length: limit }, (_, i) => ({ requestId: `0x${"11".repeat(32)}`, block: 100 - i, logIndex: 0, txHash: tx, completed: null, ciphertexts: ["AQI="] })); },
  status: async () => ({ horizen: { block: 28_012_345, time: now - 2 }, minute: minute - 60, dbBytes: 12_345 }),
};
const chain = async () => ({ head: 28_012_349, balances: { operator: { address: book.endpoint.operator, wei: 4_780_000_000_000_000n }, relayer: { address: book.relayer.facilitator, wei: 10n ** 16n } } });

function call(h, { method = "GET", url, headers = {}, body, xff = "198.51.100.7, 76.76.21.1" }) {
  const req = Object.assign(Readable.from(body === undefined ? [] : [Buffer.from(body)]), { method, url, headers: { "x-forwarded-for": xff, ...headers }, socket: {} });
  return new Promise((resolve) => {
    const out = { headers: {} };
    h(req, { headersSent: false, setHeader: (k, v) => { out.headers[k] = v; },
      writeHead(status, headers) { out.status = status; Object.assign(out.headers, headers); this.headersSent = true; return this; },
      end(data) { out.body = JSON.parse(data.toString()); resolve(out); } });
  });
}
const fresh = () => handler({ db, book, origin, now: () => now * 1_000, chain, log: () => {} });

test("GET /v1/btc: /api/btc's body for the last 120 minutes, shared briefly; ranges are bounded and unknown parameters refused", async () => {
  const h = fresh(), r = await call(h, { url: "/v1/btc" });
  assert.equal(r.status, 200);
  assert.deepEqual(r.body, { prices: [[minute, 83102.82698224793]] });
  assert.deepEqual(asked.prices, [minute - 7_200, minute]);
  assert.equal(r.headers["cache-control"], "public, max-age=0, s-maxage=2, stale-while-revalidate=30");
  assert.equal((await call(h, { url: `/v1/btc?from=${minute - 86_400}&to=${minute - 3_600}` })).headers["cache-control"], "public, max-age=0, s-maxage=3600");
  // A follower still behind that range (a backfill, a Solana outage): its gap is not shared for an hour.
  const behind = handler({ db: { ...db, latestPrice: async () => ({ minute: minute - 3_600, price: "1" }) }, book, origin, now: () => now * 1_000, chain, log: () => {} });
  assert.equal((await call(behind, { url: `/v1/btc?from=${minute - 86_400}&to=${minute - 3_600}` })).headers["cache-control"], "public, max-age=0, s-maxage=2, stale-while-revalidate=30");
  for (const url of ["/v1/btc?minutes=1441", "/v1/btc?from=60&to=59", `/v1/btc?from=0&to=${1_441 * 60}`, "/v1/btc?from=61&to=120", "/v1/btc?x=1", "/v1/btc?minutes=5&minutes=6"]) {
    const bad = await call(h, { url });
    assert.equal(bad.status, 400, url);
    assert.equal(bad.headers["cache-control"], "no-store");
  }
});

test("GET /v1/live: head, clock, the previous, current and next rounds with settle references, and the latest price", async () => {
  const r = await call(fresh(), { url: "/v1/live" });
  assert.equal(r.headers["cache-control"], "public, max-age=0, s-maxage=1, stale-while-revalidate=4");
  assert.deepEqual(r.body.rounds.map((x) => x.start), [start - 900, start, start + 900]);
  assert.deepEqual(asked.settles, [start - 900, start, start + 900].map((s) => engineRound(book, s).spec.registryRoundId));
  assert.deepEqual(r.body.rounds[1], { start, registryRoundId: current, settle: null,
    open: { kind: 1, outcome: 0, price: "83102826982247930000000", observationsTimestamp: start + 1, reportHash: words(7), source: 1, block: 28_011_000, txHash: tx, logIndex: 2 } });
  assert.deepEqual(r.body.clock, { tick: "8123", block: 28_012_339, timestamp: now - 5, applied: 1, skipped: 0, deposits: 0, txHash: tx, logIndex: 4 });
  assert.deepEqual(r.body.price, [minute, 83254.69222516466]);
  assert.deepEqual(r.body.head, { block: 28_012_345, time: now - 2 });
});

test("GET /v1/rounds: the last 24 hours by default; at most 200 rounds", async () => {
  const h = fresh(), r = await call(h, { url: "/v1/rounds" });
  assert.equal(r.body.rounds.length, 97);
  assert.equal(r.body.rounds.at(-1).start, start);
  assert.equal(Object.keys(r.body.rounds[0]).join(), "start,registryRoundId,open,settle");
  assert.equal((await call(h, { url: `/v1/rounds?from=${start - 199 * 900}&to=${start}` })).status, 200);
  assert.equal((await call(h, { url: `/v1/rounds?from=${start - 200 * 900}&to=${start}` })).status, 400);
  assert.equal((await call(h, { url: `/v1/rounds?from=${start + 1}&to=${start + 901}` })).status, 400);
  const old = `/v1/rounds?from=${start - 13 * 900}&to=${start - 12 * 900}`; // ended 2 h 45 min before the head
  assert.equal(r.headers["cache-control"], "public, max-age=0, s-maxage=1, stale-while-revalidate=5");
  assert.equal((await call(h, { url: old })).headers["cache-control"], "public, max-age=0, s-maxage=300");
  const backfilling = handler({ db: { ...db, head: async () => ({ block: 28_000_000, time: start - 11 * 900 }) }, book, origin, now: () => now * 1_000, chain, log: () => {} });
  assert.equal((await call(backfilling, { url: old })).headers["cache-control"], "public, max-age=0, s-maxage=1, stale-while-revalidate=5");
});

test("POST /v1/account: our origin only, a strict body, never cached, paged; 20 a window per visitor", async () => {
  const h = fresh(), address = "0x44A2F7238002CF6B16719F5E0AD6C080CF3E1419";
  const post = (body, headers = { origin }, xff) => call(h, { method: "POST", url: "/v1/account", headers, body: JSON.stringify(body), xff });
  assert.equal((await post({ address }, { origin: "https://example.com" })).status, 403);
  assert.equal((await post({ address: "0x12" })).status, 400);
  assert.equal((await post({ address, limit: 101 })).status, 400);
  assert.equal((await post({ address, before: { block: -1, logIndex: 0 } })).status, 400);
  assert.equal((await post({ address, account: address })).status, 400);
  assert.equal((await call(h, { method: "POST", url: "/v1/account", headers: { origin }, body: "x".repeat(1_025) })).status, 413);
  assert.equal((await call(h, { method: "GET", url: "/v1/account" })).status, 405);
  const r = await post({ address, before: { block: 28_000_000, logIndex: 3 }, limit: 2 });
  assert.equal(r.status, 200);
  assert.equal(r.headers["cache-control"], "no-store");
  assert.deepEqual(asked.account, { address: address.toLowerCase(), before: { block: 28_000_000, logIndex: 3 }, limit: 3 });
  assert.deepEqual({ more: r.body.more, n: r.body.requests.length, c: r.body.requests[0].ciphertexts }, { more: true, n: 2, c: ["AQI="] });
  assert.equal((await post({ address })).status, 200); // the 8th
  for (let i = 0; i < 12; i++) await post({ address }); // up to the 20th
  const limited = await post({ address });
  assert.equal(limited.status, 429);
  assert.ok(Number(limited.headers["retry-after"]) >= 1);
  // Keyed by the visitor Vercel saw (the entry before the edge's own), not by the edge every visitor shares.
  assert.equal((await post({ address }, { origin }, "203.0.113.9, 76.76.21.1")).status, 200);
});

test("GET /v1/status: lag per chain, public balances, and an alert per low balance", async () => {
  const r = await call(fresh(), { url: "/v1/status" });
  assert.equal(r.status, 200);
  assert.deepEqual(r.body.horizen, { block: 28_012_345, time: now - 2, chainHead: 28_012_349, behindBlocks: 4 });
  assert.deepEqual(r.body.solana, { minute: minute - 60, ageSeconds: now - minute + 60 });
  assert.deepEqual(r.body.balances.operator, { address: book.endpoint.operator, wei: "4780000000000000", low: true });
  assert.deepEqual(r.body.alerts, ["operator balance low"]);
});
