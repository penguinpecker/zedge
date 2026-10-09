// The read API (README.md) for node:http. JSON; big integers are decimal strings; hashes 0x hex; ciphertexts base64. The site
// reaches it same-origin through a Vercel rewrite, whose CDN shares the public GETs. An account is asked for in a POST body,
// never in the URL, and that answer is never cached. Nothing here logs an address, an IP, a body or a URL: only error codes.
import { gzipSync } from "node:zlib";
import { decodeClock, eventRound } from "../../adapters/vela/crypto/guest.ts";
import { engineRound } from "../../src/chain/orderbook-manifest.ts";
import { decodeSettle } from "../../src/chain/vault.ts";

export const ROUND = 900, MAX_ROUNDS = 200, RESULTS_ROUNDS = 96, PRICE_MINUTES = 120, MAX_MINUTES = 1_440, PAGE = 50, MAX_PAGE = 100, MAX_BODY = 1_024;
export const HOUSE_MS = 20_000; // the house's quotes are left out of /v1/live once the latest good copy was fetched longer ago than this
export const EVENT_MS = 60_000; // and the event house's, after this
/** Balances below these get an alert in /v1/status (wei). The relayer's: twice its refusal floor (server/relay.ts RELAY_MIN_BALANCE_WEI). */
export const LOW = { operator: 5_000_000_000_000_000n, house: 5_000_000_000_000_000n, relayer: 1_000_000_000_000_000n };
const SHORT = "public, max-age=0, s-maxage=1, stale-while-revalidate=4";
const FIXED = (s) => `public, max-age=0, s-maxage=${s}`;
const KEYS = new Set(["address", "before", "limit"]);
const refuse = (status, error) => Object.assign(new Error(error), { status });
const int = (v) => /^[0-9]{1,12}$/.test(v ?? "") ? Number(v) : NaN;
const count = (v) => Number.isSafeInteger(v) && v >= 0;

/** At most `limit` per key in each 10 s window. */
function windowed(limit, ms = 10_000) {
  let at = -1, seen = new Map();
  return (key, now) => {
    const w = Math.floor(now / ms);
    if (w !== at) { at = w; seen = new Map(); }
    const k = (seen.get(key) ?? 0) + 1;
    seen.set(key, k);
    return k <= limit;
  };
}

const exactly = (v, keys) => Boolean(v) && typeof v === "object" && !Array.isArray(v) && Object.keys(v).sort().join() === keys;
const shape = (code) => (ok) => { if (!ok) throw Object.assign(new Error(code), { code }); };
/** `up` and `down` of a /quotes answer: each { ask, bid }, each { cents 1-99, shares > 0 } or null. */
function sides(v, need) {
  const level = (q) => {
    if (q === null) return null;
    need(exactly(q, "cents,shares") && Number.isInteger(q.cents) && q.cents >= 1 && q.cents <= 99 && Number.isFinite(q.shares) && q.shares > 0);
    return { cents: q.cents, shares: q.shares };
  };
  const side = (x) => { need(exactly(x, "ask,bid")); return { ask: level(x.ask), bid: level(x.bid) }; };
  return { up: side(v.up), down: side(v.down) };
}
/** The house bot's /quotes answer (services/market-maker README), checked field by field: another service's output. Null when it has
 * none yet; anything malformed throws. */
export function parseHouse(v) {
  if (v === null) return null;
  const need = shape("INDEXER_HOUSE_SHAPE");
  need(exactly(v, "at,down,start,up") && Number.isSafeInteger(v.at) && v.at > 0 && Number.isSafeInteger(v.start));
  return { at: v.at, start: v.start, ...sides(v, need) };
}
/** The event house's /quotes answer, checked the same way: `round` (the event's engine round id, 0x and 64 lowercase hex) in place of
 * `start`; up is Yes, down is No. */
export function parseEventHouse(v) {
  if (v === null) return null;
  const need = shape("INDEXER_EVENT_HOUSE_SHAPE");
  need(exactly(v, "at,down,round,up") && Number.isSafeInteger(v.at) && v.at > 0 && typeof v.round === "string" && /^0x[0-9a-f]{64}$/.test(v.round));
  return { round: v.round, at: v.at, ...sides(v, need) };
}

/** This application's event from the events manifest (public/deployments/26514-events.json; null without one): its engine round id
 * (0x), the registry round id its settle records carry, and its cutoff. A manifest of another application, or with bad terms, throws. */
export function eventOf(manifest, book) {
  if (manifest === null) return null;
  const e = manifest?.event;
  if (!(manifest?.kind === "zedge-events" && manifest.schemaVersion === 1 && manifest.chainId === 26514 && manifest.application === book.application.id && e && typeof e === "object"
    && ["start", "cutoff", "end", "voidableAfter"].every((k) => Number.isSafeInteger(e[k])))) {
    throw new Error("the events manifest is not this application's");
  }
  const { id, spec } = eventRound(book.application.engineConfigJson, { question: e.questionHash, start: e.start, cutoff: e.cutoff, end: e.end, voidableAfter: e.voidableAfter });
  return { round: `0x${id}`, registryRoundId: spec.registryRoundId, cutoff: spec.cutoff };
}

function only(params, allowed) {
  for (const k of params.keys()) if (!allowed.includes(k) || params.getAll(k).length > 1) throw refuse(400, "Unknown or repeated parameter.");
}

function send(req, res, status, body, cache) {
  let data = Buffer.from(JSON.stringify(body));
  const headers = { "content-type": "application/json", "cache-control": cache, vary: "accept-encoding", "x-content-type-options": "nosniff" };
  if (data.length > 1_024 && /\bgzip\b/.test(String(req.headers["accept-encoding"] ?? ""))) { data = gzipSync(data); headers["content-encoding"] = "gzip"; }
  res.writeHead(status, headers).end(data);
}

function readBody(req) {
  return new Promise((resolve, reject) => {
    const chunks = [];
    let size = 0;
    req.on("data", (c) => { size += c.length; if (size <= MAX_BODY) chunks.push(c); });
    req.on("end", () => size > MAX_BODY ? reject(refuse(413, "Request too large.")) : resolve(Buffer.concat(chunks).toString("utf8")));
    req.on("error", reject);
  });
}

/** `deps`: { db (store.mjs reads), book, origin, now() in ms, chain() → { head, balances: { role: { address, wei } } }, log,
 * house?() → { copy (parseHouse's), at (ms it was fetched) }, event? (eventOf's), eventHouse?() → { copy (parseEventHouse's), at } }. */
export function handler(deps) {
  const perClient = { GET: windowed(120), POST: windowed(20) }, perEdge = windowed(2_000);
  const counted = new Set();
  const price = (p) => p && [p.minute, Number(p.price) / 1e18];
  // A stored settle record as served; null when it is not one.
  const settle = (r) => {
    const s = decodeSettle(r.data);
    return s && { kind: s.kind, outcome: s.outcome, price: s.price.toString(), observationsTimestamp: s.observationsTimestamp, reportHash: s.reportHash,
      source: s.source, block: r.block, txHash: r.txHash, logIndex: r.logIndex };
  };
  // Only these BTC rounds' records: the event's carry another registry round id and never land here.
  const rounds = async (starts) => {
    const ids = starts.map((s) => engineRound(deps.book, s).spec.registryRoundId), byRound = new Map(ids.map((id) => [id, []]));
    for (const r of await deps.db.settles(ids)) {
      const s = settle(r);
      if (s) byRound.get(r.roundId)?.push(s);
    }
    // Kind 1 opens a round; 2 resolves it and 3 voids it.
    return starts.map((start, i) => ({ start, registryRoundId: ids[i], open: byRound.get(ids[i]).find((s) => s.kind === 1) ?? null, settle: byRound.get(ids[i]).findLast((s) => s.kind !== 1) ?? null }));
  };
  const clock = (r) => {
    try { const c = decodeClock(r.data); return { tick: c.tick.toString(), block: Number(c.block), timestamp: c.timestamp, applied: c.applied, skipped: c.skipped, deposits: c.deposits, txHash: r.txHash, logIndex: r.logIndex }; }
    catch { return null; }
  };

  const routes = {
    async "GET /v1/live"(params, now) {
      only(params, []);
      const start = Math.floor(now / ROUND) * ROUND;
      const [head, last, list, latest] = await Promise.all([deps.db.head(), deps.db.clock(), rounds([start - ROUND, start, start + ROUND]), deps.db.latestPrice()]);
      const h = deps.house?.(), house = h && deps.now() - h.at <= HOUSE_MS && h.copy?.start === start ? h.copy : null;
      // The event house's quotes: for this application's event only, and only until its trading cutoff.
      const e = deps.eventHouse?.(), event = e && deps.event && deps.now() - e.at <= EVENT_MS && e.copy?.round === deps.event.round && now < deps.event.cutoff ? e.copy : null;
      return [{ head, clock: last && clock(last), rounds: list, price: price(latest), house, event }, SHORT];
    },
    async "GET /v1/event"(params) {
      only(params, []);
      if (!deps.event) throw refuse(404, "Not found.");
      const [head, records] = await Promise.all([deps.db.head(), deps.db.settles([deps.event.registryRoundId])]);
      // Kind 2 is the resolver's result (source 4), kind 3 the timeout void (source 3); null until then.
      const settled = records.map(settle).filter((s) => s && s.kind !== 1);
      return [{ head, round: deps.event.round, registryRoundId: deps.event.registryRoundId, settle: settled.at(-1) ?? null }, FIXED(5)];
    },
    async "GET /v1/btc"(params, now) {
      only(params, ["minutes", "from", "to"]);
      const minute = Math.floor(now / 60) * 60;
      let from, to;
      if (params.has("from") || params.has("to")) {
        if (params.has("minutes")) throw refuse(400, "Ask for minutes or for from and to.");
        from = int(params.get("from")); to = int(params.get("to"));
        if (!(from % 60 === 0 && to % 60 === 0 && from <= to && to - from <= MAX_MINUTES * 60)) throw refuse(400, `from and to: minute starts at most ${MAX_MINUTES} minutes apart.`);
      } else {
        const n = params.has("minutes") ? int(params.get("minutes")) : PRICE_MINUTES;
        if (!(n >= 1 && n <= MAX_MINUTES)) throw refuse(400, `minutes: 1 to ${MAX_MINUTES}.`);
        to = minute; from = minute - n * 60;
      }
      // The body /api/btc serves: { prices: [[unixSeconds, usd], …] }, oldest first. A past range is shared for an hour only once
      // the follower has read past it (it reads oldest first, and a report lands within a minute), never a backfill's or outage's gap.
      const [rows, latest] = await Promise.all([deps.db.prices(from, to), to < minute - 300 ? deps.db.latestPrice() : null]);
      return [{ prices: rows.map(price) }, latest && latest.minute >= to + 120 ? FIXED(3_600) : "public, max-age=0, s-maxage=2, stale-while-revalidate=30"];
    },
    async "GET /v1/rounds"(params, now) {
      only(params, ["from", "to"]);
      let from, to;
      if (params.has("from") || params.has("to")) {
        from = int(params.get("from")); to = int(params.get("to"));
        if (!(from % ROUND === 0 && to % ROUND === 0 && from <= to && (to - from) / ROUND < MAX_ROUNDS)) throw refuse(400, `from and to: round starts, at most ${MAX_ROUNDS} rounds.`);
      } else { to = Math.floor(now / ROUND) * ROUND; from = to - RESULTS_ROUNDS * ROUND; } // the last 24 hours and the current round
      const starts = Array.from({ length: (to - from) / ROUND + 1 }, (_, i) => from + i * ROUND);
      const [head, list] = await Promise.all([deps.db.head(), rounds(starts)]);
      // Rounds ended two hours before the indexed head (not the clock: a backfill's rounds are not final yet) are shared longer.
      return [{ head, rounds: list }, head && to + ROUND + 7_200 < head.time ? FIXED(300) : "public, max-age=0, s-maxage=1, stale-while-revalidate=5"];
    },
    async "GET /v1/status"(params, now) {
      only(params, []);
      const [s, chain] = await Promise.all([deps.db.status(), deps.chain().catch(() => null)]);
      const behindBlocks = chain && s.horizen ? chain.head - s.horizen.block : null, ageSeconds = s.minute === null ? null : now - s.minute;
      const balances = chain && Object.fromEntries(Object.entries(chain.balances).map(([role, b]) => [role, { address: b.address, wei: b.wei.toString(), low: b.wei < LOW[role] }]));
      // An uptime monitor can watch for `"alerts":[]`.
      const alerts = [...(chain ? [] : ["chain unread"]), ...(behindBlocks > 30 ? ["horizen indexing behind"] : []), ...(ageSeconds === null || ageSeconds > 180 ? ["prices behind"] : []),
        ...Object.entries(balances ?? {}).filter(([, b]) => b.low).map(([role]) => `${role} balance low`)];
      return [{ horizen: s.horizen && { ...s.horizen, chainHead: chain?.head ?? null, behindBlocks }, solana: { minute: s.minute, ageSeconds }, balances, dbBytes: s.dbBytes, alerts }, FIXED(5)];
    },
    async "POST /v1/account"(params, _now, req) {
      only(params, []);
      if (req.headers.origin !== deps.origin) throw refuse(403, "Origin not allowed.");
      let p;
      try { p = JSON.parse(await readBody(req)); } catch (e) { throw e.status ? e : refuse(400, "Malformed request."); }
      if (!p || typeof p !== "object" || Array.isArray(p) || Object.keys(p).some((k) => !KEYS.has(k))) throw refuse(400, "Expected { address, before?, limit? }.");
      if (typeof p.address !== "string" || !/^0x[0-9a-fA-F]{40}$/.test(p.address)) throw refuse(400, "address: 0x and 40 hex digits.");
      const b = p.before;
      if (b !== undefined && !(b && typeof b === "object" && Object.keys(b).sort().join() === "block,logIndex" && count(b.block) && count(b.logIndex))) throw refuse(400, "before: { block, logIndex }.");
      const limit = p.limit ?? PAGE;
      if (!(Number.isSafeInteger(limit) && limit >= 1 && limit <= MAX_PAGE)) throw refuse(400, `limit: 1 to ${MAX_PAGE}.`);
      const [head, items] = await Promise.all([deps.db.head(), deps.db.account(p.address.toLowerCase(), b, limit + 1)]);
      return [{ head, more: items.length > limit, requests: items.slice(0, limit) }, "no-store"];
    },
  };

  return async (req, res) => {
    const nowMs = deps.now(), method = req.method === "POST" ? "POST" : "GET";
    // Keys: Railway's edge appends the address that connected to it, so the last X-Forwarded-For entry cannot be forged (the
    // site's requests share Vercel's), and the one before it is the visitor as Vercel saw them (forgeable only by a direct
    // caller, whom the per-edge window still bounds). README: the header check after a deploy, from each new entry count logged.
    const xff = String(req.headers["x-forwarded-for"] ?? "").split(",").map((s) => s.trim()).filter(Boolean);
    if (!counted.has(xff.length) && counted.size < 8) { counted.add(xff.length); deps.log({ xffEntries: xff.length }); }
    const edge = xff.at(-1) ?? req.socket?.remoteAddress ?? "", client = xff.at(-2) ?? edge;
    let route = null;
    try {
      if (!perEdge(edge, nowMs) || !perClient[method](client, nowMs)) {
        res.setHeader("retry-after", String(10 - Math.floor(nowMs / 1_000) % 10));
        throw refuse(429, "Too many requests; slow down.");
      }
      const url = URL.parse(req.url ?? "/", "http://indexer");
      if (!url) throw refuse(400, "Malformed URL.");
      route = `${req.method} ${url.pathname}`;
      if (!routes[route]) throw refuse(Object.keys(routes).some((r) => r.endsWith(` ${url.pathname}`)) ? 405 : 404, "Not found.");
      const [body, cache] = await routes[route](url.searchParams, Math.floor(nowMs / 1_000), req);
      send(req, res, 200, body, cache);
    } catch (e) {
      // Only a known route gets here without a status: never caller text.
      if (!e.status) deps.log({ api: route, error: /^[A-Za-z0-9_]{1,40}$/.test(String(e?.code)) ? e.code : "UNKNOWN" });
      if (!res.headersSent) send(req, res, e.status ?? 503, { error: e.status ? e.message : "Unavailable." }, "no-store");
    }
  };
}
