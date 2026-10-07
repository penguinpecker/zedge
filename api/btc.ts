/** Vercel function: GET /api/btc. Chainlink BTC/USD (Data Streams), the price that settles rounds, one report a minute, read
 * from the public Solana transactions of the round program that verifies them there (the keeper's backup source,
 * services/keeper/solana.mjs). Display and fair value only: the keeper checks every settlement report itself.
 * Body: { prices: [[unixSeconds, usd], …] }, oldest first. SOLANA_RPC_URL (optional, may carry a key) is never sent out. */
import { reportsIn } from "../services/keeper/solana.mjs";
import { decodeReport } from "../services/keeper/streams.mjs";

const PROGRAM = "2DeGBCAiEJd1MgMuPGDKh7svBikZa9izbnTn5p7ESzPt"; // posts the BTC/USD report 0–5 s after every minute
const BTC = "0x00039d9e45394f473ab1f050a1b963e6b05351e52d71e507509ada0c95ed75b8";
const KEEP = 120; // minutes kept; the chart reads at most 90 (two rounds and the hour before for volatility)
const LATE = 15; // seconds into a minute its report is looked for (seen 0–5)
const FETCH = 40; // transactions read per refresh at most; a cold instance fills the rest over the next refreshes
const REFRESH_MS = 3_000; // at most one Solana refresh per instance per 3 s, whatever the traffic
// ponytail: memory per warm instance; move `prices` to the Upstash Redis the relay already uses if cold starts show.
const prices = new Map<number, number>(); // minute (unix s) → USD
const checked = new Set<string>(); // transactions read: one does not change
let backfilled = false, refreshed = 0, running: Promise<void> | null = null;

async function rpc(method: string, params: unknown[]): Promise<unknown> {
  const response = await fetch(process.env.SOLANA_RPC_URL || "https://api.mainnet-beta.solana.com", { method: "POST", headers: { "content-type": "application/json" },
    body: JSON.stringify({ jsonrpc: "2.0", id: 1, method, params }), redirect: "error", signal: AbortSignal.timeout(8_000) });
  const data = response.ok ? await response.json() as { result?: unknown } : null;
  if (!data || !("result" in data)) throw new Error(`SOLANA_${response.status}`);
  return data.result;
}

async function refresh() {
  const now = Math.floor(Date.now() / 60_000) * 60, oldest = now - KEEP * 60;
  if (!prices.has(now - 180)) backfilled = false; // idle for minutes, or cold: list far enough back to close the gap
  // Until the window is filled, the last 1,000 transactions (about 90 minutes); then the last 50 (about 4).
  const list = await rpc("getSignaturesForAddress", [PROGRAM, { limit: backfilled ? 50 : 1000, commitment: "confirmed" }]) as { signature: string; err: unknown; blockTime: number | null }[];
  const byMinute = new Map<number, string[]>();
  for (const e of list.toReversed()) { // oldest first: each minute's candidates in landing order
    if (e.err !== null || e.blockTime === null || e.blockTime % 60 > LATE || checked.has(e.signature)) continue;
    const minute = e.blockTime - e.blockTime % 60;
    if (minute >= oldest && !prices.has(minute)) byMinute.set(minute, [...byMinute.get(minute) ?? [], e.signature]);
  }
  let budget = FETCH;
  const minutes = [...byMinute.keys()].sort((a, b) => b - a); // newest first
  for (let i = 0; i < minutes.length && budget > 0; i += 8) await Promise.all(minutes.slice(i, i + 8).map(async (minute) => {
    for (const signature of byMinute.get(minute)!) {
      if (prices.has(minute) || budget-- <= 0) return;
      const tx = await rpc("getTransaction", [signature, { encoding: "json", maxSupportedTransactionVersion: 0, commitment: "confirmed" }]);
      if (tx === null) return; // this node does not serve it yet: asked again on the next refresh
      checked.add(signature);
      // Only a verifying instruction of a transaction that succeeded: its report passed Chainlink's verifier on Solana.
      for (const payload of reportsIn(tx)) {
        try { const o = decodeReport(payload, BTC), t = Number(o.observationsTimestamp); if (t % 60 === 0 && t >= oldest) prices.set(t, Number(o.price) / 1e18); } catch { /* another feed */ }
      }
    }
  }));
  if (budget > 0) backfilled = true;
  for (const minute of prices.keys()) if (minute < oldest) prices.delete(minute);
  for (const signature of checked) { if (checked.size <= 10_000) break; checked.delete(signature); }
}

export async function GET(): Promise<Response> {
  // Once this minute's report is in, nothing new lands until the next minute: no Solana call until then.
  const minute = Math.floor(Date.now() / 60_000) * 60;
  if (!running && Date.now() - refreshed >= REFRESH_MS && !(backfilled && prices.has(minute))) {
    // 3 s after a refresh ends; 15 s after one failed (a 429 above all).
    running = refresh().then(() => { refreshed = Date.now(); }, (error) => {
      refreshed = Date.now() + 12_000;
      console.log(JSON.stringify({ btc: "refresh-failed", code: String((error as Error)?.message).slice(0, 40) }));
    }).finally(() => { running = null; });
  }
  await running;
  // Shared through the CDN: one function call per region per 5 s however many people watch.
  return Response.json({ prices: [...prices].sort((a, b) => a[0] - b[0]) }, { headers: { "cache-control": "public, max-age=0, s-maxage=5, stale-while-revalidate=30" } });
}
