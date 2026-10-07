// The Solana follower (README.md): every transaction of the round program that posts Chainlink BTC/USD each minute (the keeper's
// backup source, the one /api/btc reads) is read once, oldest first, from PRICES_FROM on. Each verified report of the feed becomes
// its minute's price. All chain and database access is in `deps`.
import { reportsIn } from "../keeper/solana.mjs";
import { decodeReport } from "../keeper/streams.mjs";

export const PRICES_FROM = 1_791_331_200; // 2026-10-07 00:00 UTC, the day the application was deployed
const SLACK = 300; // seconds before the cursor's block time a listing stops: a dropped cursor transaction cannot make it page back forever
const READS = 200; // transactions read per step at most; the next step goes on from the cursor
const PAGE = 1_000;
const fail = (code) => Object.assign(new Error(code), { code });

/** One step. `deps`: { rpc(method, params), cursor() → { sig, time }, held(fromMinute) → Set of minutes, write(expect, next, minutes),
 * program, feed }. Returns { more } while listed transactions are left for the next step, and `latest`, the newest minute held. */
export async function pricesStep(deps) {
  const cur = await deps.cursor(), floor = cur.sig ? cur.time - SLACK : PRICES_FROM, list = [];
  for (let before = null; ;) { // newest first, down to the cursor
    const page = await deps.rpc("getSignaturesForAddress", [deps.program, { limit: PAGE, commitment: "confirmed", ...(cur.sig && { until: cur.sig }), ...(before && { before }) }]);
    if (!Array.isArray(page)) throw fail("INDEXER_SOLANA_SHAPE");
    const end = page.findIndex((e) => e.signature === cur.sig || (typeof e.blockTime === "number" && e.blockTime < floor));
    list.push(...(end < 0 ? page : page.slice(0, end)));
    if (end >= 0 || page.length < PAGE) break;
    before = page.at(-1).signature;
  }
  const held = await deps.held(floor - 60), minutes = new Map();
  let last = null, reads = 0, more = false;
  for (const e of list.reverse()) {
    const t = e.blockTime, m = t - t % 60;
    // A report lands 0-33 s after its minute, so a transaction carries the minute it landed in or the one before: when both are
    // held it is passed over unread. Failed transactions carry no verified report.
    if (e.err == null && typeof t === "number" && !(held.has(m) && held.has(m - 60))) {
      if (reads++ === READS) { more = true; break; }
      const tx = await deps.rpc("getTransaction", [e.signature, { encoding: "json", maxSupportedTransactionVersion: 0, commitment: "confirmed" }]);
      if (tx === null) break; // this node does not serve it yet: read again on the next step, the cursor stays before it
      for (const payload of reportsIn(tx)) {
        let o;
        try { o = decodeReport(payload, deps.feed); } catch { continue; } // another feed
        const at = Number(o.observationsTimestamp), minute = at - at % 60;
        if (!(minutes.get(minute)?.observed_at <= at)) minutes.set(minute, { minute, price: o.price.toString(), observed_at: at, signature: e.signature });
        held.add(minute);
      }
    }
    last = e;
  }
  if (last) await deps.write(cur, { sig: last.signature, time: last.blockTime ?? cur.time ?? PRICES_FROM }, [...minutes.values()]);
  return { more, latest: Math.max(0, ...held) };
}
