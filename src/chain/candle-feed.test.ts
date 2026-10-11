import { strict as assert } from "node:assert";
import { test } from "node:test";
import { createCandleFeed, toOhlc, type CandleEnv } from "./candle-feed.ts";

const M = 1_791_309_600; // a minute, unix seconds
const iso = (s: number) => new Date(s * 1000).toISOString();

test("Coinbase rows become candles oldest first; malformed rows are dropped", () => {
  assert.deepEqual(toOhlc([
    [M + 120, 100, 110, 104, 108, 1.5], [M, 101, 103, 102, 101, 2], [M + 60, 99, 105, 101, 104, 0],
    [M + 30, 1, 2, 1, 2, 0], [M + 180, 110, 100, 105, 105, 0], [M + 240, "x", 1, 1, 1, 0], [M + 300, 1, Infinity, 1, 1, 0], [M + 360, 1, 2], null, "row",
  ]), [
    { time: M, open: 102, high: 103, low: 101, close: 101 },
    { time: M + 60, open: 101, high: 105, low: 99, close: 104 },
    { time: M + 120, open: 104, high: 110, low: 100, close: 108 },
  ]);
  assert.deepEqual(toOhlc({ message: "rate limited" }), []);
});

test("the feed reads one page of history, then the last three minutes on the timer; a newer copy of a minute replaces the older", async () => {
  let now = (M + 125) * 1000;
  const urls: string[] = [], timers: (() => void)[] = [];
  let body: unknown = [[M + 120, 100, 110, 104, 108, 1], [M + 60, 99, 105, 101, 104, 1], [M - 60, 1, 2, 1, 2, 1]];
  const env: CandleEnv = { fetch: async (url) => { urls.push(url); return { ok: true, json: async () => body }; }, now: () => now,
    setTimeout: (fn) => { timers.push(fn); return 0 as unknown as ReturnType<typeof setTimeout> }, clearTimeout: () => { timers.length = 0; } };
  const from = M * 1000, end = (M + 900) * 1000;
  const feed = createCandleFeed(from, end, env);
  feed.resume(); await new Promise((r) => setImmediate(r));
  assert.deepEqual(urls, [`https://api.exchange.coinbase.com/products/BTC-USD/candles?granularity=60&start=${iso(M + 900 - 300 * 60)}&end=${iso(M + 900)}`], "one page of 300 minutes up to the end");
  assert.equal(feed.status, "live");
  assert.deepEqual(feed.candles().map((c) => c.time), [M - 60, M + 60, M + 120], "the minute before from is kept for zooming out");
  assert.deepEqual(feed.last(), { t: (M + 120) * 1000, p: 108 });
  const slots = feed.slots();
  assert.deepEqual([slots.length, slots[0], slots[2], slots.at(-1)], [16, { time: M }, { time: M + 120, open: 104, high: 110, low: 100, close: 108 }, { time: M + 900 }], "one slot a minute from `from` to `end`, empty where no candle");
  assert.equal(timers.length, 1);
  // The live candle moved: the refresh reads the last three minutes and its newer copy replaces the older.
  now = (M + 130) * 1000; body = [[M + 120, 98, 112, 104, 111, 2]];
  const before = feed.version;
  timers.shift()!(); await new Promise((r) => setImmediate(r));
  assert.deepEqual(urls[1], `https://api.exchange.coinbase.com/products/BTC-USD/candles?granularity=60&start=${iso(M + 130 - 180)}&end=${iso(M + 130)}`);
  assert.deepEqual(feed.candles().at(-1), { time: M + 120, open: 104, high: 112, low: 98, close: 111 });
  assert.ok(feed.version > before);
  // No new candle for 150 s: behind.
  now = (M + 120 + 151) * 1000; body = [];
  timers.shift()!(); await new Promise((r) => setImmediate(r));
  assert.equal(feed.status, "reconnecting");
  assert.equal(feed.candles().length, 3, "an empty read keeps the candles");
  feed.pause();
  assert.equal(timers.length, 0);
});
