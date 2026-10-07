// Live BTC/USD display price from a public exchange feed. Display only: settlement uses Chainlink Data Streams.
// Nothing is sent except the public subscription and candle requests; no keys, cookies or referrer.

/** A price observation: `t` in milliseconds since the epoch (exchange time), `p` in USD. */
export type Tick = { t: number; p: number };
/** A one-minute candle; `time` is the minute's start in seconds since the epoch. */
export type Candle = { time: number; open: number; high: number; low: number; close: number };
type LiveCandle = Candle & { at: number };
export type FeedStatus = "connecting" | "live" | "reconnecting";
type Source = {
  name: string;
  url: string;
  subscribe: unknown;
  parse: (data: unknown) => Tick | null;
  candlesUrl: (from: number, to: number) => string;
  /** Rows normalized to [startSeconds, open, high, low, close]. */
  candleRows: (body: unknown) => unknown[][];
};

const STALE_MS = 15_000;
/** The candles before the shown window that the volatility estimate reads (60 one-minute closes). */
export const SIGMA_WINDOW_MS = 3_600_000;

const json = (data: unknown): Record<string, unknown> | null => {
  try { const value: unknown = JSON.parse(String(data)); return value && typeof value === "object" ? value as Record<string, unknown> : null; } catch { return null; }
};
const number = (value: unknown) => typeof value === "number" || typeof value === "string" ? Number(value) : NaN;
function tick(time: unknown, price: unknown): Tick | null {
  const t = typeof time === "string" ? Date.parse(time) : NaN, p = number(price);
  return Number.isFinite(t) && Number.isFinite(p) && p > 0 ? { t, p } : null;
}

export const SOURCES: readonly Source[] = [
  {
    name: "Coinbase Exchange",
    url: "wss://ws-feed.exchange.coinbase.com",
    // The ticker fires on every match; the heartbeat (each second) proves the socket is alive between trades.
    subscribe: { type: "subscribe", product_ids: ["BTC-USD"], channels: ["ticker", "heartbeat"] },
    parse: (data) => { const m = json(data); return m?.type === "ticker" && m.product_id === "BTC-USD" ? tick(m.time, m.price) : null; },
    candlesUrl: (from, to) => `https://api.exchange.coinbase.com/products/BTC-USD/candles?granularity=60&start=${new Date(from).toISOString()}&end=${new Date(to).toISOString()}`,
    // [time, low, high, open, close, volume], newest first.
    candleRows: (body) => Array.isArray(body) ? body.filter(Array.isArray).map((r: unknown[]) => [r[0], r[3], r[2], r[1], r[4]]) : [],
  },
  {
    name: "Kraken",
    url: "wss://ws.kraken.com/v2",
    subscribe: { method: "subscribe", params: { channel: "trade", symbol: ["BTC/USD"], snapshot: false } },
    parse: (data) => {
      const m = json(data);
      if (m?.channel !== "trade" || !Array.isArray(m.data)) return null;
      const last = (m.data as Record<string, unknown>[]).findLast((trade) => trade?.symbol === "BTC/USD");
      return last ? tick(last.timestamp, last.price) : null;
    },
    candlesUrl: (from) => `https://api.kraken.com/0/public/OHLC?pair=XBTUSD&interval=1&since=${Math.floor(from / 1000) - 60}`,
    // {error: [], result: {XXBTZUSD: [[time, open, high, low, close, vwap, volume, count]], last}}
    candleRows: (body) => {
      const result = (body as { result?: Record<string, unknown> } | null)?.result;
      const rows = result && Object.values(result).find(Array.isArray);
      return rows ? rows.filter(Array.isArray).map((r: unknown[]) => r.slice(0, 5)) : [];
    },
  },
];

/** Either source's rows as one-minute candles starting inside [from, to) (milliseconds), oldest first, one per minute.
 * A row that is not a whole, consistent candle (low ≤ open, close ≤ high) is dropped. */
export function toCandles(rows: unknown[][], from: number, to: number): Candle[] {
  const byTime = new Map<number, Candle>();
  for (const [time, open, high, low, close] of rows) {
    const c = { time: number(time), open: number(open), high: number(high), low: number(low), close: number(close) };
    if (!Number.isSafeInteger(c.time) || c.time % 60 || c.time * 1000 < from || c.time * 1000 >= to) continue;
    if (!(c.low > 0 && c.low <= Math.min(c.open, c.close) && c.high >= Math.max(c.open, c.close))) continue;
    byTime.set(c.time, c);
  }
  return [...byTime.values()].sort((a, b) => a.time - b.time);
}

/** Adds a live tick to its minute's candle in place: a new minute opens a new candle. Ticks older than `last` (the latest
 * accepted) and ticks outside [from, end) are ignored. Returns whether the tick was taken. */
export function addTick(live: Map<number, LiveCandle>, last: Tick | null, next: Tick, from: number, end: number): boolean {
  if (next.t < from || next.t >= end || (last && next.t < last.t)) return false;
  const time = Math.floor(next.t / 60_000) * 60, c = live.get(time);
  if (c) Object.assign(c, { high: Math.max(c.high, next.p), low: Math.min(c.low, next.p), close: next.p, at: next.t });
  else live.set(time, { time, open: next.p, high: next.p, low: next.p, close: next.p, at: next.t });
  return true;
}

/** History (fetched as of `asOf`, ms) and live candles by minute. A minute both have keeps the history's open, the wider high
 * and low, and the newer close: the live one only if its last tick came after what the history could see. A minute only one
 * has is taken whole, so the backfill fills a hidden-tab gap. */
export function mergeCandles(history: Candle[], asOf: number, live: Map<number, LiveCandle>): Candle[] {
  const out = new Map(history.map((c) => [c.time, c]));
  for (const c of live.values()) {
    const h = out.get(c.time);
    out.set(c.time, h ? { time: c.time, open: h.open, high: Math.max(h.high, c.high), low: Math.min(h.low, c.low), close: c.at > Math.min(asOf, (c.time + 60) * 1000) ? c.close : h.close }
      : { time: c.time, open: c.open, high: c.high, low: c.low, close: c.close });
  }
  return [...out.values()].sort((a, b) => a.time - b.time);
}

/** Reconnect delay after `failures` consecutive attempts without a price: 0.5 s, 1 s, 2 s … capped at 30 s. */
export const backoff = (failures: number) => Math.min(30_000, 500 * 2 ** failures);

type SocketLike = { send(data: string): void; close(): void; onopen: (() => void) | null; onmessage: ((event: { data: unknown }) => void) | null; onclose: (() => void) | null };
type Timer = ReturnType<typeof setTimeout>;
export type FeedEnv = {
  WebSocket: new (url: string) => SocketLike;
  fetch: (url: string, init: RequestInit) => Promise<{ ok: boolean; json(): Promise<unknown> }>;
  now: () => number;
  setTimeout: (fn: () => void, ms: number) => Timer;
  clearTimeout: (timer: Timer | undefined) => void;
};
const browser = (): FeedEnv => ({ WebSocket: globalThis.WebSocket as unknown as FeedEnv["WebSocket"], fetch: globalThis.fetch.bind(globalThis), now: Date.now, setTimeout: globalThis.setTimeout.bind(globalThis), clearTimeout: globalThis.clearTimeout.bind(globalThis) });

export type PriceFeed = ReturnType<typeof createPriceFeed>;
/** Starts on Coinbase; two consecutive attempts without a price switch to the other source, which starts a clean series.
 * Idle until `resume()`; `pause()` quiesces it completely. `version` changes whenever the candles or status change.
 * Candles are shown from `from`; the hour before it is read too, for the volatility estimate only. */
export function createPriceFeed(from: number, end: number, env: FeedEnv = browser()) {
  const since = from - SIGMA_WINDOW_MS;
  let source = 0, failures = 0, generation = 0, version = 0, priced = false;
  let status: FeedStatus = "connecting";
  let socket: SocketLike | null = null, retry: Timer | undefined, stale: Timer | undefined, request: AbortController | null = null;
  let live = new Map<number, LiveCandle>(), history: Candle[] = [], asOf = 0, last: Tick | null = null;
  const changed = () => { version++; };
  const merged = () => mergeCandles(history, asOf, live);

  async function backfill() {
    const to = Math.min(env.now(), end), current = SOURCES[source], ticket = generation;
    if (to <= since) return;
    request?.abort();
    const controller = request = new AbortController();
    try {
      // One request each: at most 60 + 30 one-minute candles, inside both sources' page sizes.
      const response = await env.fetch(current.candlesUrl(since, to), { signal: controller.signal, credentials: "omit", referrerPolicy: "no-referrer", cache: "no-store" });
      const body = response.ok ? await response.json() : null;
      // A response for an older source or a paused feed is dropped.
      if (!body || ticket !== generation || controller.signal.aborted) return;
      history = toCandles(current.candleRows(body), since, to);
      asOf = to;
      changed();
    } catch { /* The live socket still draws; the next connection retries the backfill. */ }
  }
  function detach() {
    env.clearTimeout(stale);
    const ws = socket;
    socket = null;
    ws?.close();
  }
  function dropped() {
    detach();
    if (!priced && ++failures % 2 === 0) { source = 1 - source; generation++; live = new Map(); history = []; last = null; }
    status = "reconnecting";
    changed();
    retry = env.setTimeout(connect, backoff(failures));
  }
  function connect() {
    retry = undefined;
    void backfill();
    // A window that has ended needs no socket: its candles are complete.
    if (env.now() >= end) return;
    const current = SOURCES[source], ws = socket = new env.WebSocket(current.url);
    priced = false;
    const watch = () => { env.clearTimeout(stale); stale = env.setTimeout(() => { if (socket === ws) dropped(); }, STALE_MS); };
    watch();
    ws.onopen = () => ws.send(JSON.stringify(current.subscribe));
    ws.onmessage = (event) => {
      if (socket !== ws) return;
      watch();
      const next = current.parse(event.data);
      if (!next) return;
      if (!priced) { priced = true; failures = 0; status = "live"; }
      if (addTick(live, last, next, since, end)) last = next;
      changed();
    };
    ws.onclose = () => { if (socket === ws) dropped(); };
  }
  function pause() {
    env.clearTimeout(retry);
    retry = undefined;
    request?.abort();
    detach();
  }
  return {
    from,
    get version() { return version; },
    get status() { return status; },
    get source() { return SOURCES[source].name; },
    /** The shown candles, from `from`. */
    candles: () => merged().filter((c) => c.time * 1000 >= from),
    /** Up to the last 60 closes of completed minutes, oldest first: the volatility input. */
    closes: () => merged().filter((c) => (c.time + 60) * 1000 <= env.now()).slice(-60).map((c) => c.close),
    /** The latest live tick (exchange time), or null before the socket priced. */
    last: () => last,
    resume() { if (socket) return; pause(); connect(); },
    pause,
  };
}
