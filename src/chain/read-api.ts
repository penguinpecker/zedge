/** The read API (services/indexer/README.md), same-origin through the site's /v1 rewrite: this application's public Horizen records
 * and the Chainlink minute prices, already indexed. Display only: it can drop, delay or replay rows, so whatever changes what a user
 * signs is checked on chain first (confirmSettle). Every read answers its checked value, or null for anything else (no answer, a
 * timeout, a refusal, a malformed field): null is the signal to read the chain as before. An address goes only in a POST body. */
import { parseEventLogs, type Hex, type PublicClient } from "viem";
import { endpointAbi, LOT, SHARE, type VerifiedOrderbook } from "./orderbook-manifest.ts";
import { SUBTYPES, decodeSettle } from "./vault.ts";

/** A price observation: `t` in milliseconds since the epoch (the report's observation time), `p` in USD. */
export type Tick = { t: number; p: number };
/** A guest `settle` record (kind 1 opens a round, 2 resolves it, 3 voids it; outcome 1 Up, 2 Down, 3 Void) and where it is on chain. */
export type SettleRef = { kind: number; outcome: number; price: bigint; observationsTimestamp: number; reportHash: Hex; source: number; block: number; txHash: Hex; logIndex: number };
export type ApiRound = { start: number; registryRoundId: Hex; open: SettleRef | null; settle: SettleRef | null };
export type Head = { block: number; time: number };
/** A resting price level: cents, and share atoms (whole lots). The wire sends whole shares, e.g. 5.5 (services/market-maker houseQuotes). */
export type Quote = { cents: number; shares: number };
/** The house's lowest resting sell (`ask`) and highest resting buy (`bid`) on each side, null where it has none, for the round that
 * starts at `start` (unix seconds), as of `at` (ms, the house bot's latest order state). */
export type House = { at: number; start: number; up: { ask: Quote | null; bid: Quote | null }; down: { ask: Quote | null; bid: Quote | null } };
/** The previous, current and next rounds, the latest minute price and the house's quotes (null when the indexer's copy is over 20 s
 * old or of another round). */
export type Live = { head: Head; rounds: ApiRound[]; price: Tick | null; house: House | null };
export type ApiRequest = { requestId: Hex; block: bigint; logIndex: number; txHash: Hex; completed: { block: bigint; txHash: Hex; status: number } | null; ciphertexts: Uint8Array[] };
/** One page of an account's requests, newest first; `more` when older ones exist. */
export type AccountPage = { head: Head; more: boolean; requests: ApiRequest[] };
type Fetcher = (url: string, init: RequestInit) => Promise<{ ok: boolean; json(): Promise<unknown> }>;

/** /api/btc's and /v1/btc's body ({ prices: [[unixSeconds, usd], …] }) as minute ticks, oldest first; anything malformed is dropped. */
export function toTicks(body: unknown): Tick[] {
  const rows = (body as { prices?: unknown } | null)?.prices;
  if (!Array.isArray(rows)) return [];
  return rows.filter((r): r is [number, number] => Array.isArray(r) && Number.isSafeInteger(r[0]) && r[0] % 60 === 0 && typeof r[1] === "number" && Number.isFinite(r[1]) && r[1] > 0)
    .map(([t, p]) => ({ t: t * 1000, p })).sort((a, b) => a.t - b.t);
}

// Field checks: any failure throws, and `read` turns that into null.
const need = (ok: unknown) => { if (!ok) throw new Error("Malformed read API answer."); };
const obj = (v: unknown) => { need(v && typeof v === "object" && !Array.isArray(v)); return v as Record<string, unknown>; };
const count = (v: unknown) => { need(Number.isSafeInteger(v) && (v as number) >= 0); return v as number; };
const hash = (v: unknown) => { need(typeof v === "string" && /^0x[0-9a-fA-F]{64}$/.test(v)); return (v as string).toLowerCase() as Hex; };
const list = (v: unknown, max: number) => { need(Array.isArray(v) && v.length <= max); return v as unknown[]; };
const head = (v: unknown): Head => { const h = obj(v); return { block: count(h.block), time: count(h.time) }; };
/** A receipt: base64 of at most 16 KiB (one is 8,220 bytes). */
const bytes = (v: unknown) => {
  need(typeof v === "string" && v.length <= 21_848 && v.length % 4 === 0 && /^[A-Za-z0-9+/]*={0,2}$/.test(v));
  const out = Uint8Array.from(atob(v as string), (c) => c.charCodeAt(0));
  need(out.length <= 16_384);
  return out;
};
function settleRef(value: unknown): SettleRef | null {
  if (value === null) return null;
  const v = obj(value);
  need([1, 2, 3].includes(v.kind as number) && typeof v.price === "string" && /^[0-9]{1,78}$/.test(v.price));
  return { kind: count(v.kind), outcome: count(v.outcome), price: BigInt(v.price as string), observationsTimestamp: count(v.observationsTimestamp), reportHash: hash(v.reportHash),
    source: count(v.source), block: count(v.block), txHash: hash(v.txHash), logIndex: count(v.logIndex) };
}
const rounds = (v: unknown, max: number): ApiRound[] => list(v, max).map((x) => {
  const r = obj(x), start = count(r.start);
  need(start % 900 === 0);
  return { start, registryRoundId: hash(r.registryRoundId), open: settleRef(r.open), settle: settleRef(r.settle) };
});
const quote = (value: unknown): Quote | null => {
  if (value === null) return null;
  const q = obj(value), atoms = typeof q.shares === "number" ? Math.round(q.shares * SHARE) : NaN;
  // Whole lots only, and exactly: atoms / SHARE gives back the very number the house sent.
  need(Number.isSafeInteger(q.cents) && (q.cents as number) >= 1 && (q.cents as number) <= 99 && Number.isSafeInteger(atoms) && atoms > 0 && atoms % LOT === 0 && atoms / SHARE === q.shares);
  return { cents: q.cents as number, shares: atoms };
};
const quotes = (value: unknown) => {
  const s = obj(value), ask = quote(s.ask), bid = quote(s.bid);
  need(!ask || !bid || bid.cents < ask.cents);
  return { ask, bid };
};
/** The house's quotes, or null: when absent, and when malformed, which costs only the quotes (the ticket then estimates), not the read. */
function house(value: unknown): House | null {
  if (value === null || value === undefined) return null;
  try {
    const h = obj(value), start = count(h.start);
    need(start % 900 === 0 && Number.isSafeInteger(h.at) && (h.at as number) > 0);
    return { at: h.at as number, start, up: quotes(h.up), down: quotes(h.down) };
  } catch { return null; }
}
function live(body: unknown): Live {
  const v = obj(body), price = v.price === null ? null : toTicks({ prices: [v.price] })[0];
  need(price !== undefined);
  return { head: head(v.head), rounds: rounds(v.rounds, 4), price, house: house(v.house) };
}
function page(body: unknown): AccountPage {
  const v = obj(body);
  need(typeof v.more === "boolean");
  return { head: head(v.head), more: v.more as boolean, requests: list(v.requests, 100).map((x) => {
    const r = obj(x), c = r.completed === null ? null : obj(r.completed);
    return { requestId: hash(r.requestId), block: BigInt(count(r.block)), logIndex: count(r.logIndex), txHash: hash(r.txHash),
      completed: c && { block: BigInt(count(c.block)), txHash: hash(c.txHash), status: count(c.status) }, ciphertexts: list(r.ciphertexts, 8).map(bytes) };
  }) };
}

async function read<T>(fetcher: Fetcher, url: string, ms: number, parse: (body: unknown) => T, init: RequestInit = {}): Promise<T | null> {
  try {
    const response = await fetcher(url, { credentials: "omit", referrerPolicy: "no-referrer", ...init, signal: AbortSignal.timeout(ms) });
    return response.ok ? parse(await response.json()) : null;
  } catch { return null; }
}

export function readApi(fetcher: Fetcher = (url, init) => fetch(url, init)) {
  return {
    live: () => read(fetcher, "/v1/live", 3_000, live),
    /** Minute prices for the minute starts `from` to `to` (unix seconds, at most 1,440 minutes apart), oldest first. */
    btc: (from: number, to: number) => read(fetcher, `/v1/btc?from=${from}&to=${to}`, 5_000, (b) => { need(Array.isArray(obj(b).prices)); return toTicks(b); }),
    /** The last 24 hours of rounds and the current one. */
    rounds: () => read(fetcher, "/v1/rounds", 3_000, (b) => { const v = obj(b); return { head: head(v.head), rounds: rounds(v.rounds, 200) }; }),
    /** One page of this account's requests, newest first, below `before` (the last one of the page above). */
    account: (address: string, before?: { block: number; logIndex: number }, limit = 50) => read(fetcher, "/v1/account", 8_000, page,
      { method: "POST", cache: "no-store", headers: { "content-type": "application/json" }, body: JSON.stringify({ address, ...(before ? { before } : {}), limit }) }),
  };
}
export type ReadApi = ReturnType<typeof readApi>;

/** A /v1/live read shared by the whole page: an answer younger than 1.5 s, or the one in flight, is reused, so the market page's
 * 2 s poll, the price feeds and the round results look-ups cost one request between them. */
export function sharedLive(read: () => Promise<Live | null>, now: () => number = Date.now) {
  let last: { at: number; answer: Promise<Live | null> } | null = null;
  return () => {
    const t = now();
    if (!last || t - last.at >= 1_500) last = { at: t, answer: read() };
    return last.answer;
  };
}
export const liveNow = sharedLive(() => readApi().live());

/** The API says where an engine record is; the chain says what it holds. True only when that transaction succeeded in that block and
 * its log at `logIndex` is this endpoint's AppEvent of this application, `settle` subtype, with exactly these words for this round.
 * One receipt read. */
export async function confirmSettle(client: Pick<PublicClient, "getTransactionReceipt">, book: VerifiedOrderbook["manifest"], ref: SettleRef, registryRoundId: Hex): Promise<boolean> {
  const receipt = await client.getTransactionReceipt({ hash: ref.txHash });
  const log = receipt.status === "success" && receipt.blockNumber === BigInt(ref.block)
    ? receipt.logs.find((l) => l.logIndex === ref.logIndex && l.address.toLowerCase() === book.endpoint.address.toLowerCase()) : undefined;
  if (!log) return false;
  const [event] = parseEventLogs({ abi: endpointAbi, logs: [log], eventName: "AppEvent" });
  const s = event && event.args.applicationId === BigInt(book.application.id) && event.args.eventSubType.toLowerCase() === SUBTYPES.settle ? decodeSettle(event.args.data) : null;
  return Boolean(s && s.roundId === registryRoundId.toLowerCase() && s.kind === ref.kind && s.outcome === ref.outcome && s.price === ref.price &&
    s.observationsTimestamp === ref.observationsTimestamp && s.reportHash === ref.reportHash && s.source === ref.source);
}
