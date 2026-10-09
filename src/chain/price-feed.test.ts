import { strict as assert } from "node:assert";
import { test } from "node:test";
import { createPriceFeed, toCandleSlots, toCandles, toPoints, toTicks, type FeedEnv } from "./price-feed.ts";

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

test("the feed reads its day from /v1/btc once, then each minute from the shared live read; a read API that fails or falls behind hands the rest of the feed to /api/btc", async () => {
  let now = (M + 125) * 1000, price: [number, number] | null = [M + 120, 103], ok = true;
  const urls: string[] = [], timers: (() => void)[] = [];
  const bodies: Record<string, unknown> = { "/api/btc": { prices: [[M + 180, 104]] } };
  const env: FeedEnv = { fetch: async (url) => { urls.push(url); return { ok: ok || url !== "/api/btc", json: async () => bodies[url] ?? { prices: [[M, 101], [M + 60, 102]] } }; }, now: () => now,
    setTimeout: (fn) => { timers.push(fn); return 0 as unknown as ReturnType<typeof setTimeout> }, clearTimeout: () => { timers.length = 0; },
    live: async () => ({ head: { block: 1, time: M }, rounds: [], price: price && { t: price[0] * 1000, p: price[1] }, house: null, event: null }) };
  const next = async () => { timers.shift()!(); await new Promise((r) => setImmediate(r)); };
  const feed = createPriceFeed(M * 1000, (M + 900) * 1000, env);
  feed.resume(); await new Promise((r) => setImmediate(r));
  assert.deepEqual(urls, [`/v1/btc?from=${M + 900 - 86_400}&to=${M + 900}`], "one window, a day back from the end");
  assert.equal(feed.status, "live");
  assert.deepEqual(feed.points().filter((p) => p.value !== undefined).map((p) => p.value), [101, 102, 103]);
  assert.deepEqual(feed.closes(), [102, 103]);
  // A day of history scrolls back past the shown window.
  bodies[urls[0]] = { prices: [[M - 7_200, 99], [M, 101]] };
  feed.pause(); feed.resume(); await new Promise((r) => setImmediate(r));
  assert.equal(feed.points()[0].time, M - 7_200, "the points start at the oldest report held");
  urls.length = 0;
  await next();
  assert.deepEqual(urls, [], "the next minute comes from the shared live read: no request of its own");
  // The live read falls behind (its newest report is older than 150 s): /api/btc from now on, at most every 5 s.
  now += 200_000; ok = false;
  await next();
  assert.deepEqual([urls, feed.status], [["/api/btc"], "reconnecting"]);
  assert.equal(feed.points().filter((p) => p.value !== undefined).length, 4, "a failed read keeps the points");
  await next();
  assert.deepEqual(urls, ["/api/btc"], "not again within 5 s");
  now += 5_000; ok = true; price = [M + 400, 1];
  await next();
  assert.deepEqual(urls, ["/api/btc", "/api/btc"], "the read API is not read again for this feed");
  assert.deepEqual(feed.last(), { t: (M + 180) * 1000, p: 104 });
  feed.pause();
  assert.equal(timers.length, 0);
});

test("a missing minute costs one point, not two, and merging reads never shrinks the series", async () => {
  // M + 120 is missing: the round keeps one slot a minute from start to end, only that slot is empty.
  const ticks = toTicks({ prices: [[M, 101], [M + 60, 102], [M + 180, 104], [M + 240, 105]] });
  assert.deepEqual(toPoints(ticks, M * 1000, (M + 300) * 1000), [
    { time: M, value: 101 }, { time: M + 60, value: 102 }, { time: M + 120 }, { time: M + 180, value: 104 }, { time: M + 240, value: 105 }, { time: M + 300 },
  ]);
  // The window, then a live read that has only the newest minute: it adds to the series and drops nothing.
  let price = { t: (M + 180) * 1000, p: 104 };
  const timers: (() => void)[] = [];
  const env: FeedEnv = { fetch: async () => ({ ok: true, json: async () => ({ prices: [[M, 101], [M + 60, 102], [M + 180, 104]] }) }), now: () => (M + 245) * 1000,
    setTimeout: (fn) => { timers.push(fn); return 0 as unknown as ReturnType<typeof setTimeout> }, clearTimeout: () => {}, live: async () => ({ head: { block: 1, time: M }, rounds: [], price, house: null, event: null }) };
  const feed = createPriceFeed(M * 1000, (M + 300) * 1000, env);
  feed.resume(); await new Promise((r) => setImmediate(r));
  price = { t: (M + 240) * 1000, p: 105 };
  timers.shift()!(); await new Promise((r) => setImmediate(r));
  assert.deepEqual(feed.points().map((p) => p.value ?? null), [101, 102, null, 104, 105, null]);
  assert.deepEqual(feed.last(), { t: (M + 240) * 1000, p: 105 });
  assert.deepEqual(feed.at(M * 1000), { t: M * 1000, p: 101 });
  assert.equal(feed.at((M + 120) * 1000), null);
});

test("candles sit on the line's minute slots: a minute without both reports, and the last minute, are empty slots", () => {
  const ticks = toTicks({ prices: [[M, 101], [M + 60, 99], [M + 180, 104], [M + 240, 105]] });
  assert.deepEqual(toCandleSlots(ticks, M * 1000, (M + 300) * 1000), [
    { time: M, open: 101, high: 101, low: 99, close: 99 }, { time: M + 60 }, { time: M + 120 },
    { time: M + 180, open: 104, high: 105, low: 104, close: 105 }, { time: M + 240 }, { time: M + 300 },
  ]);
});
