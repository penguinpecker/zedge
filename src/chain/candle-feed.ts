// Coinbase Exchange BTC-USD one-minute candles: the bodies and wicks of the candle chart, read straight from the browser (public,
// cross-origin, no key). Display only: rounds settle on Chainlink (price-feed.ts), whose one report a minute gives a minute no
// high or low, so the price to beat, the header price and the fair value keep coming from there.
import type { Candle, FeedStatus } from "./price-feed.ts";
export type { Candle };

const CANDLES_URL = "https://api.exchange.coinbase.com/products/BTC-USD/candles?granularity=60";
const POLL_MS = 5_000;
/** Each refresh re-reads the last three minutes: the live candle and two closed ones a slow read may have missed. */
const REFRESH_MS = 180_000;
/** The newest candle older than this means the source is behind (a minute closes, then its successor should be a candle at once). */
const STALE_MS = 150_000;
/** Simplification: Coinbase answers at most 300 candles (five hours) a request and the history is read as one page, so a round
 * shows nothing further back than that when the viewer scrolls. */
const PAGE_MS = 300 * 60_000;

/** Candles from a Coinbase reply: rows of [time (seconds, a minute's start), low, high, open, close, volume], newest first.
 * A row that is not an array, has a non-finite field, a time off the minute or a low above its high is dropped; the rest come
 * back oldest first. */
export function toOhlc(body: unknown): Candle[] {
  if (!Array.isArray(body)) return [];
  const out: Candle[] = [];
  for (const row of body) {
    if (!Array.isArray(row) || row.length < 5 || !row.slice(0, 5).every((v) => typeof v === "number" && Number.isFinite(v))) continue;
    const [time, low, high, open, close] = row as number[];
    if (time % 60 !== 0 || low > high) continue;
    out.push({ time, open, high, low, close });
  }
  return out.sort((a, b) => a.time - b.time);
}

type Timer = ReturnType<typeof setTimeout>;
export type CandleEnv = {
  fetch: (url: string, init: RequestInit) => Promise<{ ok: boolean; json(): Promise<unknown> }>;
  now: () => number;
  setTimeout: (fn: () => void, ms: number) => Timer;
  clearTimeout: (timer: Timer | undefined) => void;
};
const browser = (): CandleEnv => ({ fetch: globalThis.fetch.bind(globalThis), now: Date.now, setTimeout: globalThis.setTimeout.bind(globalThis), clearTimeout: globalThis.clearTimeout.bind(globalThis) });

export type CandleFeed = ReturnType<typeof createCandleFeed>;
/** Reads every 5 s while resumed, until two minutes after `end` (ms); `pause()` stops it and drops the read in flight. History
 * once per resume (one page up to `end`), then the last three minutes each time; a newer copy of a minute replaces the older, so
 * the live candle keeps updating. The whole page before `end` is kept, so the viewer can zoom out and drag back through it. `version` changes whenever the candles or status change. */
export function createCandleFeed(from: number, end: number, env: CandleEnv = browser()) {
  let version = 0, status: FeedStatus = "connecting", timer: Timer | undefined, request: AbortController | null = null, primed = false;
  const held = new Map<number, Candle>();
  const read = async (start: number, stop: number, signal: AbortSignal) => {
    const response = await env.fetch(`${CANDLES_URL}&start=${new Date(start).toISOString()}&end=${new Date(stop).toISOString()}`, { signal, credentials: "omit", referrerPolicy: "no-referrer" });
    if (!response.ok) throw new Error("Candle read failed.");
    return toOhlc(await response.json());
  };
  async function poll() {
    const controller = request = new AbortController();
    try {
      const now = env.now();
      const rows = primed ? await read(now - REFRESH_MS, now, controller.signal) : await read(end - PAGE_MS, end, controller.signal);
      if (controller.signal.aborted) return;
      primed = true;
      for (const c of rows) if (c.time * 1000 >= end - PAGE_MS && c.time * 1000 <= end) held.set(c.time, c);
      const newest = Math.max(-Infinity, ...held.keys());
      status = held.size && env.now() - newest * 1000 < STALE_MS ? "live" : "reconnecting";
    } catch {
      if (controller.signal.aborted) return;
      status = "reconnecting";
    }
    version++;
    if (env.now() < end + 120_000) timer = env.setTimeout(poll, POLL_MS);
  }
  function pause() {
    env.clearTimeout(timer);
    timer = undefined;
    request?.abort();
  }
  const candles = () => [...held.values()].sort((a, b) => a.time - b.time);
  return {
    get version() { return version; },
    get status() { return status; },
    source: "Coinbase BTC-USD",
    /** The held candles, oldest first. */
    candles,
    /** `candles()` with an empty slot for each missing minute in [from, end], so the time axis reaches END as the line's does
     * (price-feed.ts toPoints); the chart only places a mark on a time it holds. */
    slots: (): (Candle | { time: number })[] => { const out: (Candle | { time: number })[] = []; for (let t = Math.ceil(from / 60_000) * 60; t * 1000 <= end; t += 60) out.push(held.get(t) ?? { time: t }); return out; },
    /** The newest candle's close as a tick (ms), or null before the first read. */
    last: (): { t: number; p: number } | null => { const c = candles().at(-1); return c ? { t: c.time * 1000, p: c.close } : null; },
    resume() { pause(); primed = false; void poll(); },
    pause,
  };
}
