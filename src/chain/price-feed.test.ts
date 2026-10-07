import { strict as assert } from "node:assert";
import { test } from "node:test";
import { createPriceFeed, toCandles, toTicks, type FeedEnv } from "./price-feed.ts";

const M = 1_791_309_600; // a minute, unix seconds

test("minute reports become candles that open at one report and close at the next; malformed rows are dropped", () => {
  const ticks = toTicks({ prices: [[M + 120, 103], [M, 101], [M + 60, 102], [M + 240, 99], [M + 30, 5], [M + 180, -1], ["x", 1], null] });
  assert.deepEqual(ticks.map((x) => x.t / 1000), [M, M + 60, M + 120, M + 240]);
  // M + 180 is missing, so neither M + 120 nor M + 180 has a candle.
  assert.deepEqual(toCandles(ticks, M * 1000, (M + 600) * 1000), [
    { time: M, open: 101, high: 102, low: 101, close: 102 },
    { time: M + 60, open: 102, high: 103, low: 102, close: 103 },
  ]);
  assert.deepEqual(toTicks({ error: "x" }), []);
});

test("the feed reads /api/btc, is live while the last report is fresh, keeps its candles on a failed read, and pause stops it", async () => {
  let now = (M + 125) * 1000, body: unknown = { prices: [[M, 101], [M + 60, 102], [M + 120, 103]] }, ok = true;
  const urls: string[] = [], timers: (() => void)[] = [];
  const env: FeedEnv = { fetch: async (url) => { urls.push(url); return { ok, json: async () => body }; }, now: () => now,
    setTimeout: (fn) => { timers.push(fn); return 0 as unknown as ReturnType<typeof setTimeout> }, clearTimeout: () => { timers.length = 0; } };
  const feed = createPriceFeed(M * 1000, (M + 900) * 1000, env);
  feed.resume(); await new Promise((r) => setImmediate(r));
  assert.deepEqual(urls, ["/api/btc"]);
  assert.equal(feed.status, "live");
  assert.equal(feed.candles().length, 2);
  assert.deepEqual(feed.last(), { t: (M + 120) * 1000, p: 103 });
  assert.deepEqual(feed.closes(), [102, 103]);
  ok = false; now += 200_000; timers.shift()!(); await new Promise((r) => setImmediate(r));
  assert.equal(feed.status, "reconnecting");
  assert.equal(feed.candles().length, 2);
  feed.pause();
  assert.equal(timers.length, 0);
});
