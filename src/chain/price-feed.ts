// Chainlink BTC/USD (Data Streams), the price that settles rounds: one report a minute, served by /api/btc from public
// Solana transactions. Display and the one-click fair value only; the keeper checks every settlement report itself.

/** A price observation: `t` in milliseconds since the epoch (the report's observation time), `p` in USD. */
export type Tick = { t: number; p: number };
/** A chart point, `time` in seconds since the epoch; no `value` is a minute with no report (an empty slot on the time axis). */
export type Point = { time: number; value?: number };
/** A one-minute candle; `time` is the minute's start in seconds since the epoch. */
export type Candle = { time: number; open: number; high: number; low: number; close: number };
export type FeedStatus = "connecting" | "live" | "reconnecting";

const POLL_MS = 5_000;
/** A report lands about 2 s after each minute; none for this long means the source is behind. */
const STALE_MS = 150_000;
/** The candles before the shown window that the volatility estimate reads (60 one-minute closes). */
export const SIGMA_WINDOW_MS = 3_600_000;

/** /api/btc's body ({ prices: [[unixSeconds, usd], …] }) as minute ticks, oldest first; anything malformed is dropped. */
export function toTicks(body: unknown): Tick[] {
  const rows = (body as { prices?: unknown } | null)?.prices;
  if (!Array.isArray(rows)) return [];
  return rows.filter((r): r is [number, number] => Array.isArray(r) && Number.isSafeInteger(r[0]) && r[0] % 60 === 0 && typeof r[1] === "number" && Number.isFinite(r[1]) && r[1] > 0)
    .map(([t, p]) => ({ t: t * 1000, p })).sort((a, b) => a.t - b.t);
}

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
};
const browser = (): FeedEnv => ({ fetch: globalThis.fetch.bind(globalThis), now: Date.now, setTimeout: globalThis.setTimeout.bind(globalThis), clearTimeout: globalThis.clearTimeout.bind(globalThis) });

export type PriceFeed = ReturnType<typeof createPriceFeed>;
/** Reads /api/btc every 5 s while resumed, until two minutes after `end`; `pause()` stops it. `version` changes whenever the
 * points or status change. Each read is merged into the reports already held, so a short reply never shrinks the series.
 * Points are shown from `from`; the hour before it is read too, for the volatility estimate only. */
export function createPriceFeed(from: number, end: number, env: FeedEnv = browser()) {
  const since = from - SIGMA_WINDOW_MS;
  let version = 0, status: FeedStatus = "connecting", ticks: Tick[] = [], timer: Timer | undefined, request: AbortController | null = null;
  async function poll() {
    const controller = request = new AbortController();
    try {
      const response = await env.fetch("/api/btc", { signal: controller.signal, credentials: "omit", referrerPolicy: "no-referrer" });
      const next = response.ok ? toTicks(await response.json()) : [];
      if (controller.signal.aborted) return;
      if (next.length) ticks = [...new Map([...ticks, ...next.filter((x) => x.t >= since && x.t <= end)].map((x) => [x.t, x])).values()].sort((a, b) => a.t - b.t);
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
    /** The shown points, one a minute from `from` to `end`. */
    points: () => toPoints(ticks, from, end),
    /** Up to the last 60 closes of completed minutes, oldest first: the volatility input. */
    closes: () => toCandles(ticks, since, end).slice(-60).map((c) => c.close),
    /** The latest report, or null before the first read. */
    last: (): Tick | null => ticks[ticks.length - 1] ?? null,
    /** The report observed at `t` (ms, a whole minute), or null if it has not been read. */
    at: (t: number): Tick | null => ticks.find((x) => x.t === t) ?? null,
    resume() { pause(); void poll(); },
    pause,
  };
}
