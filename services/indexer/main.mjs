#!/usr/bin/env node
// ZEDGE indexer and read API (README.md). Follows this application's endpoint events on Horizen and Chainlink BTC/USD on Solana
// into Postgres, and serves them over HTTP on $PORT. Every instance serves the API; only the holder of the advisory lock writes.
// Public chain data only; it holds no key. Settings (secrets) come from a 0600 file and are never printed.
//
//   node --experimental-strip-types services/indexer/main.mjs --settings FILE
import { readFile } from "node:fs/promises";
import { createServer } from "node:http";
import { resolve } from "node:path";
import { parseArgs, parseEnv } from "node:util";
import { pathToFileURL } from "node:url";
import postgres from "postgres";
import { privateFile } from "../keeper/journal.mjs";
import { SOLANA_RPC, SOURCES } from "../keeper/solana.mjs";
import { parseOrderbookManifest } from "../../src/chain/orderbook-manifest.ts";
import { eventOf, handler, parseEventHouse, parseHouse } from "./api.mjs";
import { RANGE, step } from "./follow.mjs";
import { pricesStep } from "./prices.mjs";
import { rows } from "./rows.mjs";
import { lockKey, prepare, reads, writes } from "./store.mjs";

const POLL_MS = 1_000; // Horizen makes a block about every second
const DEPTH = 3, REWIND = 600; // confirmation depth, and how far a reorg rewinds (~10 min: the reorg ceiling)
const fail = (message) => { throw Object.assign(new Error(message), { refused: true }); };
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const log = (x) => console.log(JSON.stringify({ t: new Date().toISOString(), ...x }));
// Fixed codes only (or a JavaScript error's name), never provider or database text.
const codeOf = (e) => /^[A-Za-z0-9_]{1,40}$/.test(String(e?.code)) ? e.code : /^[A-Za-z]{1,40}Error$/.test(String(e?.name)) ? e.name : "UNKNOWN";

/** JSON-RPC over fetch: `calls` go out as one batch; any call's error throws with its code (its text is kept for tooLarge only). */
function jsonRpc(url) {
  let id = 0;
  return async (calls) => {
    const batch = calls.map((c) => ({ jsonrpc: "2.0", id: ++id, ...c }));
    const coded = (code, extra) => Object.assign(new Error(code), { code, ...extra });
    let response;
    try { response = await fetch(url, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(batch), redirect: "error", signal: AbortSignal.timeout(15_000) }); }
    catch { throw coded("RPC_TRANSPORT"); }
    if (response.status !== 200) { await response.body?.cancel().catch(() => {}); throw coded(`RPC_HTTP_${response.status}`, response.status === 413 ? { rpcCode: -32005 } : {}); }
    const answer = await response.json().catch(() => null), byId = new Map((Array.isArray(answer) ? answer : [answer]).map((a) => [a?.id, a]));
    return batch.map(({ id: key }) => {
      const a = byId.get(key);
      if (!a || !("result" in a || "error" in a)) throw coded("RPC_SHAPE");
      if (a.error) throw coded(`RPC_${Math.abs(Number(a.error.code)) || "ERROR"}`, { rpcCode: a.error.code, rpcMessage: String(a.error.message ?? "") });
      return a.result;
    });
  };
}

/** The latest good answer of a quotes URL (null: none) and when it was fetched: one request at a time, about once a second, 800 ms
 * each. `name` labels its log lines, which say only when reading starts or stops working. */
function quotes(url, parse, name, state) {
  const latest = { copy: null, at: 0 };
  if (url) (async () => {
    for (let ok = null; !state.stopping;) {
      const t = Date.now();
      try {
        const r = await fetch(url, { redirect: "error", signal: AbortSignal.timeout(800) });
        if (r.status !== 200) { await r.body?.cancel().catch(() => {}); throw Object.assign(new Error(name), { code: `${name.toUpperCase()}_HTTP_${r.status}` }); }
        Object.assign(latest, { copy: parse(await r.json()), at: Date.now() });
        if (ok !== true) log({ [name]: "reading" });
        ok = true;
      } catch (e) { if (ok !== false) log({ [name]: "unread", error: codeOf(e) }); ok = false; } // a change of state only, not every second
      await sleep(t + 1_000 - Date.now());
    }
  })();
  return () => latest;
}

/** The value of `fn` for `ms`, failures included, so a burst of status reads costs one RPC batch. */
function memo(ms, fn) {
  let at = 0, value = null;
  return () => {
    if (!value || Date.now() - at > ms) { at = Date.now(); value = fn(); value.catch(() => {}); }
    return value;
  };
}

async function main(argv) {
  const { values: a } = parseArgs({ args: argv, options: { settings: { type: "string" } } });
  if (!a.settings) fail("--settings FILE is required");
  const bytes = await privateFile(resolve(a.settings)).catch(() => fail(`${a.settings}: a private (0600) settings file is required`));
  const env = parseEnv(bytes.toString()); bytes.fill(0);
  if (!/^postgres(ql)?:\/\/\S+$/.test(env.DATABASE_URL ?? "")) fail("DATABASE_URL: a postgres:// URL is required");
  if (!/^https:\/\/\S+$/.test(env.INDEXER_HORIZEN_RPC_URL ?? "")) fail("INDEXER_HORIZEN_RPC_URL: an https:// endpoint is required");
  // Caldera's public endpoint limits by IP and the operator depends on it; a keyed partner endpoint has its own limits.
  if (/calderachain/i.test(env.INDEXER_HORIZEN_RPC_URL) && !/\/infra-partner-http\//.test(env.INDEXER_HORIZEN_RPC_URL)) fail("use a private endpoint, never the operator's Caldera endpoint");
  const solanaUrl = env.INDEXER_SOLANA_RPC_URL || SOLANA_RPC;
  if (!/^https:\/\/\S+$/.test(solanaUrl)) fail("INDEXER_SOLANA_RPC_URL: an https:// endpoint");
  const houseUrl = env.INDEXER_HOUSE_URL || null; // optional: the house bot's GET /quotes on the private network
  if (houseUrl && !/^https?:\/\/\S+$/.test(houseUrl)) fail("INDEXER_HOUSE_URL: an http:// or https:// URL");
  const eventHouseUrl = env.INDEXER_EVENT_HOUSE_URL || null; // optional: the event house's GET /quotes on the private network
  if (eventHouseUrl && !/^https?:\/\/\S+$/.test(eventHouseUrl)) fail("INDEXER_EVENT_HOUSE_URL: an http:// or https:// URL");
  // The application followed is the one these manifests in the image name: a switch-over ships new ones (README).
  const book = parseOrderbookManifest(JSON.parse(await readFile(new URL("../../public/deployments/26514-orderbook.json", import.meta.url), "utf8")));
  if (book.status !== "configured") fail("the order-book manifest is planned: nothing to index yet");
  const event = eventOf(await readFile(new URL("../../public/deployments/26514-events.json", import.meta.url), "utf8")
    .then(JSON.parse, (e) => e.code === "ENOENT" ? null : Promise.reject(e)), book);
  const horizen = jsonRpc(env.INDEXER_HORIZEN_RPC_URL), solana = jsonRpc(solanaUrl);
  if (Number((await horizen([{ method: "eth_chainId", params: [] }]))[0]) !== 26514) fail("INDEXER_HORIZEN_RPC_URL: wrong chain");

  const app = BigInt(book.application.id), endpoint = book.endpoint.address, start = book.application.deployBlock - 1;
  const state = { held: false, stopping: false };
  const sql = postgres(env.DATABASE_URL, { max: 8, idle_timeout: 30, connect_timeout: 5, onnotice: () => {}, connection: { application_name: "zedge-indexer-api", statement_timeout: 2_000 } });
  // The writer: one connection, never recycled, that holds the advisory lock for as long as it lives. If it closes, the lock went
  // with it: exit, and Railway's restart takes the lock again (the cursor compare-and-set covers the moment in between).
  const writer = postgres(env.DATABASE_URL, { max: 1, max_lifetime: 0, idle_timeout: 0, connect_timeout: 10, onnotice: () => {}, connection: { application_name: "zedge-indexer-writer" },
    onclose: () => { if (state.held && !state.stopping) { log({ status: "lock-lost" }); process.exit(1); } } });

  // Public balances for the low-balance alert: the operator's transitions, the house's requests, the relayer's sends.
  const roles = { operator: book.endpoint.operator, house: book.application.house, relayer: book.relayer.facilitator };
  const chain = memo(15_000, async () => {
    const [head, ...wei] = await horizen([{ method: "eth_blockNumber", params: [] }, ...Object.values(roles).map((r) => ({ method: "eth_getBalance", params: [r, "latest"] }))]);
    return { head: Number(head), balances: Object.fromEntries(Object.entries(roles).map(([role, address], i) => [role, { address, wei: BigInt(wei[i]) }])) };
  });
  // The house's and the event house's resting quotes for /v1/live. Every instance reads them.
  const house = quotes(houseUrl, parseHouse, "house", state), eventHouse = quotes(eventHouseUrl, parseEventHouse, "eventHouse", state);
  const server = createServer(handler({ db: reads(sql), book, origin: book.application.origin, now: Date.now, chain, log, house, event, eventHouse }));
  server.requestTimeout = 15_000;
  server.listen(Number(process.env.PORT) || 8080);

  const loops = [];
  for (const s of ["SIGINT", "SIGTERM"]) process.once(s, async () => {
    state.stopping = true; server.close();
    await Promise.race([Promise.allSettled(loops), sleep(5_000)]); // a write cut short rolls back and is read again from its cursor
    await Promise.allSettled([sql.end({ timeout: 5 }), writer.end({ timeout: 5 })]);
    process.exit(0);
  });
  log({ status: "serving", application: book.application.id, event: event?.round ?? null });

  // Railway's deploy overlap: the old container holds the lock until it stops.
  const locked = () => writer`select pg_try_advisory_lock(${lockKey(book.application.id)}::bigint) as ok`.then(([r]) => r.ok, (e) => { log({ status: "database", error: codeOf(e) }); return false; });
  while (!state.stopping && !(await locked())) await sleep(5_000);
  if (state.stopping) return;
  state.held = true;
  const store = writes(writer);
  // Rows of another application (a database not yet reset after a switch-over, README) are never written over: wait for the reset.
  for (let waiting = false; ;) {
    const foreign = await prepare(writer, start).then(() => store.foreign(start)).catch((e) => { log({ status: "database", error: codeOf(e) }); return null; });
    if (foreign === false) break;
    if (foreign && !waiting) { waiting = true; log({ status: "waiting", reason: "rows of another application: reset the database (README)" }); }
    await sleep(5_000);
    if (state.stopping) return;
  }
  log({ status: "indexing", from: (await store.cursor("horizen")).block });

  const run = async (name, once) => {
    for (let errors = 0; !state.stopping;) {
      let wait;
      try { wait = await once(); errors = 0; }
      catch (e) {
        if (e.lost) { log({ status: "lock-lost", chain: name }); process.exit(1); } // another writer moved the cursor
        wait = Math.min(15_000, 1_000 * 2 ** errors++);
        log({ chain: name, error: codeOf(e) });
      }
      await sleep(wait);
    }
  };
  const c = { name: "horizen", start, depth: DEPTH, rewind: REWIND, span: RANGE, filter: { address: endpoint, topics: [null, `0x${app.toString(16).padStart(64, "0")}`] } };
  const follow = { rpc: horizen, cursor: store.cursor, write: store.write, rewind: store.rewind, rows: (logs) => rows(logs, endpoint, app) };
  let seen = { at: Date.now(), ranges: 0, logs: 0 };
  loops.push(run("horizen", async () => {
    const r = await step(follow, c);
    if (r.reorg || r.span) log({ chain: "horizen", ...r });
    if (r.to) { seen.ranges++; seen.logs += r.logs; seen.block = r.to; seen.behind = r.behind; }
    if (Date.now() - seen.at >= 60_000) { log({ chain: "horizen", ranges: seen.ranges, logs: seen.logs, block: seen.block, behind: seen.behind }); seen = { at: Date.now(), ranges: 0, logs: 0 }; }
    return r.behind > 0 || r.reorg || r.span ? 0 : POLL_MS;
  }));
  const prices = { rpc: async (method, params) => (await solana([{ method, params }]))[0], cursor: () => store.cursor("solana"), held: store.held, write: store.prices,
    program: SOURCES.backup, feed: book.application.engine.oracle.btcFeedId };
  loops.push(run("solana", async () => {
    const r = await pricesStep(prices), now = Date.now(), minute = Math.floor(now / 60_000) * 60;
    // While this minute's report is out, every 2 s; once it is in, nothing new lands before the next minute.
    return r.more ? 0 : r.latest >= minute ? (minute + 62) * 1_000 - now : 2_000;
  }));
}

if (process.argv[1] && import.meta.url === pathToFileURL(resolve(process.argv[1])).href) {
  main(process.argv.slice(2)).catch((e) => { console.error(`indexer: ${e.refused ? e.message : e.code ? codeOf(e) : (e.stack ?? e.message)}`); process.exit(1); });
}
