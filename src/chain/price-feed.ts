// Chainlink BTC/USD (Data Streams), the price that settles rounds: one report a minute, from public Solana transactions, served by
// the read API (/v1/btc, and the latest in /v1/live) or by /api/btc. Display and the one-click fair value only; the keeper checks
// every settlement report itself.
import { liveNow, readApi, toTicks, type Live, type Tick } from "./read-api.ts";
export { toTicks, type Tick };

/** A chart point, `time` in seconds since the epoch; no `value` is a minute with no report (an empty slot on the time axis). */
export type Point = { time: number; value?: number };
/** A one-minute candle; `time` is the minute's start in seconds since the epoch. */
export type Candle = { time: number; open: number; high: number; low: number; close: number };
export type FeedStatus = "connecting" | "live" | "reconnecting";

const POLL_MS = 2_000;
/** /api/btc, the fallback, is read no more often than before. */
const FALLBACK_MS = 5_000;
/** A report lands about 2 s after each minute; none for this long means the source is behind. */
const STALE_MS = 150_000;
/** The candles before the shown window that the volatility estimate reads (60 one-minute closes). */
export const SIGMA_WINDOW_MS = 3_600_000;
/** How far back from its end the chart can scroll: /v1/btc answers up to 1,440 minutes at once. */
export const HISTORY_MS = 86_400_000;

/** Candles for the minutes starting inside [from, to): a minute opens at its report and closes at the next minute's.
 * A minute missing either report has no candle. */
export function toCandles(ticks: Tick[], from: number, to: number): Candle[] {
  const out: Candle[] = [];
  for (let i = 1; i < ticks.length; i++) {
    const a = ticks[i - 1], b = ticks[i];
    if (b.t - a.t === 60_000 && a.t >= from && a.t < to) out.push({ time: a.t / 1000, open: a.p, high: Math.max(a.p, b.p), low: Math.min(a.p, b.p), close: b.p });
  }
  return out;
}

/** One point per minute in [from, to] (ms): that minute's report, or an empty slot when it is missing. A missing minute
 * costs only its own point, and the time axis keeps one slot per minute. */
export function toPoints(ticks: Tick[], from: number, to: number): Point[] {
  const at = new Map(ticks.map((x) => [x.t, x.p]));
  const out: Point[] = [];
  for (let t = Math.ceil(from / 60_000) * 60_000; t <= to; t += 60_000) { const p = at.get(t); out.push(p === undefined ? { time: t / 1000 } : { time: t / 1000, value: p }); }
  return out;
}

type Timer = ReturnType<typeof setTimeout>;
export type FeedEnv = {
  fetch: (url: string, init: RequestInit) => Promise<{ ok: boolean; json(): Promise<unknown> }>;
  now: () => number;
  setTimeout: (fn: () => void, ms: number) => Timer;
  clearTimeout: (timer: Timer | undefined) => void;
  /** The page's shared /v1/live read (read-api.ts liveNow). */
  live: () => Promise<Live | null>;
};
const browser = (): FeedEnv => ({ fetch: globalThis.fetch.bind(globalThis), now: Date.now, setTimeout: globalThis.setTimeout.bind(globalThis), clearTimeout: globalThis.clearTimeout.bind(globalThis), live: liveNow });

export type PriceFeed = ReturnType<typeof createPriceFeed>;
/** Reads every 2 s while resumed, until two minutes after `end`; `pause()` stops it. The read API first: the day up to `end` from
 * /v1/btc once (again on resuming, or after a minute the live read skipped), then each new minute from the shared /v1/live read.
 * Once the read API fails or falls behind, /api/btc every 5 s for the rest of this feed. `version` changes whenever the points or
 * status change. Each read is merged into the reports already held, so a short reply never shrinks the series. Points are shown from
 * `from`, or from the oldest report held when that is earlier (the chart scrolls back through them); the hour before `from` is the
 * volatility estimate's. */
export function createPriceFeed(from: number, end: number, env: FeedEnv = browser()) {
  const since = from - SIGMA_WINDOW_MS, oldest = end - HISTORY_MS;
  let version = 0, status: FeedStatus = "connecting", ticks: Tick[] = [], timer: Timer | undefined, request: AbortController | null = null;
  let primed = false, fallback = false, fallbackAt = -Infinity;
  const api = readApi(env.fetch);
  const merge = (next: Tick[]) => {
    if (next.length) ticks = [...new Map([...ticks, ...next.filter((x) => x.t >= oldest && x.t <= end)].map((x) => [x.t, x])).values()].sort((a, b) => a.t - b.t);
  };
  async function poll() {
    const controller = request = new AbortController();
    try {
      if (!fallback) {
        const [window, live] = await Promise.all([primed ? null : api.btc(oldest / 1000, end / 1000), env.live()]);
        if (controller.signal.aborted) return;
        const p = live?.price ?? null, last = ticks[ticks.length - 1];
        if (window) primed = true;
        // The read API down or behind (no window, no live price, or one older than STALE_MS): /api/btc for the rest of this feed.
        fallback = !primed || !p || env.now() - p.t >= STALE_MS;
        // A minute the live read skipped (the indexer caught up by more than one): the window again at the next read.
        if (!window && p && last && p.t - last.t > 60_000) primed = false;
        merge([...window ?? [], ...p ? [p] : []]);
      }
      if (fallback && env.now() - fallbackAt >= FALLBACK_MS) {
        fallbackAt = env.now();
        const response = await env.fetch("/api/btc", { signal: controller.signal, credentials: "omit", referrerPolicy: "no-referrer" });
        const next = response.ok ? toTicks(await response.json()) : null;
        if (controller.signal.aborted) return;
        if (!next) throw new Error("Price read failed.");
        merge(next);
      }
      status = ticks.length && env.now() - ticks[ticks.length - 1].t < STALE_MS ? "live" : "reconnecting";
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
  return {
    from,
    get version() { return version; },
    get status() { return status; },
    source: "Chainlink BTC/USD",
    /** The shown points, one a minute from `from` (or the oldest report held, if earlier) to `end`. */
    points: () => toPoints(ticks, Math.min(from, ticks[0]?.t ?? from), end),
    /** Up to the last 60 closes of completed minutes, oldest first: the volatility input. */
    closes: () => toCandles(ticks, since, end).slice(-60).map((c) => c.close),
    /** The latest report, or null before the first read. */
    last: (): Tick | null => ticks[ticks.length - 1] ?? null,
    /** The report observed at `t` (ms, a whole minute), or null if it has not been read. */
    at: (t: number): Tick | null => ticks.find((x) => x.t === t) ?? null,
    resume() { pause(); primed = false; void poll(); },
    pause,
  };
}
