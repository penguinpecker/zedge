import { strict as assert } from "node:assert";
import { test } from "node:test";
import { addTick, backoff, createPriceFeed, mergeCandles, SIGMA_WINDOW_MS, SOURCES, toCandles, type Candle, type FeedEnv, type Tick } from "./price-feed.ts";

const [coinbase, kraken] = SOURCES;
// Captured from the live feeds on 2026-10-06.
const COINBASE_TICKER = '{"type":"ticker","sequence":137333645494,"product_id":"BTC-USD","price":"85776.96","open_24h":"85658.32","best_bid":"85776.95","best_ask":"85776.96","side":"buy","time":"2026-10-06T18:14:42.403338Z","trade_id":1103088332,"last_size":"0.00023055"}';
const KRAKEN_TRADES = '{"channel":"trade","type":"update","data":[{"symbol":"BTC/USD","side":"buy","price":85772.4,"qty":0.00043721,"ord_type":"limit","trade_id":110386729,"timestamp":"2026-10-06T18:14:44.947782Z"},{"symbol":"BTC/USD","side":"buy","price":85772.5,"qty":0.01898593,"ord_type":"limit","trade_id":110386730,"timestamp":"2026-10-06T18:14:45.000000Z"}]}';

test("parsers accept only BTC/USD prices with exchange timestamps", () => {
  assert.deepEqual(coinbase.parse(COINBASE_TICKER), { t: Date.parse("2026-10-06T18:14:42.403338Z"), p: 85776.96 });
  for (const message of [
    '{"type":"subscriptions","channels":[{"name":"ticker","product_ids":["BTC-USD"]}]}',
    '{"type":"heartbeat","product_id":"BTC-USD","time":"2026-10-06T18:14:42Z"}',
    '{"type":"error","message":"Failed to subscribe"}',
    COINBASE_TICKER.replace('"BTC-USD"', '"ETH-USD"'),
    COINBASE_TICKER.replace('"85776.96"', '"0"'),
    COINBASE_TICKER.replace('"85776.96"', '"abc"'),
    COINBASE_TICKER.replace('"85776.96"', "true"),
    COINBASE_TICKER.replace('"2026-10-06T18:14:42.403338Z"', '"yesterday"'),
    "not json", "null", "42",
  ]) assert.equal(coinbase.parse(message), null, message);
  assert.deepEqual(kraken.parse(KRAKEN_TRADES), { t: Date.parse("2026-10-06T18:14:45.000000Z"), p: 85772.5 });
  for (const message of [
    '{"channel":"heartbeat"}',
    '{"channel":"status","type":"update","data":[{"system":"online"}]}',
    '{"method":"subscribe","result":{"channel":"trade","symbol":"BTC/USD"},"success":true}',
    KRAKEN_TRADES.replaceAll('"BTC/USD"', '"ETH/USD"'),
    '{"channel":"trade","type":"update","data":[null, 5]}',
  ]) assert.equal(kraken.parse(message), null, message);
});

test("candles from either source become the same one-minute OHLC candles, inside the window, oldest first", () => {
  const from = 1_791_309_600_000, to = from + 150_000;
  // Coinbase: [time, low, high, open, close, volume], newest first; junk, an inconsistent row and a candle before the window are dropped.
  const coinbaseBody = [[1_791_309_720, 102, 105, 103, 104, 1], [1_791_309_660, 101, 104, 102, 103, 1], [1_791_309_600, 100, 103, 101, 102, 1],
    [1_791_309_540, 98, 101, 99, 100, 1], [1_791_309_690, 1, 1, 1, 1, 1], [1_791_309_780, 110, 100, 105, 105, 1], ["junk"], "x"];
  const expected: Candle[] = [{ time: 1_791_309_600, open: 101, high: 103, low: 100, close: 102 }, { time: 1_791_309_660, open: 102, high: 104, low: 101, close: 103 }, { time: 1_791_309_720, open: 103, high: 105, low: 102, close: 104 }];
  assert.deepEqual(toCandles(coinbase.candleRows(coinbaseBody), from, to), expected);
  // Kraken: [time, open, high, low, close, vwap, volume, count] as strings, keyed by its pair name, oldest first.
  const krakenBody = { error: [], result: { XXBTZUSD: [[1_791_309_540, "99", "101", "98", "100", "1", "1", 1], [1_791_309_600, "101", "103", "100", "102", "1", "1", 1], [1_791_309_660, "102", "104", "101", "103", "1", "1", 1], [1_791_309_720, "103", "105", "102", "104", "1", "1", 1]], last: 1_791_309_720 } };
  assert.deepEqual(toCandles(kraken.candleRows(krakenBody), from, to), expected);
  assert.deepEqual(toCandles(coinbase.candleRows({ message: "rate limited" }), from, to), []);
  assert.deepEqual(toCandles(kraken.candleRows({ error: ["EGeneral:Too many requests"] }), from, to), []);
  assert.match(coinbase.candlesUrl(from, to), /granularity=60&start=2026-10-06T18:00:00\.000Z&end=2026-10-06T18:02:30\.000Z$/);
  assert.match(kraken.candlesUrl(from, to), /pair=XBTUSD&interval=1&since=1791309540$/);
});

test("live ticks build the current candle: a new minute opens one, an older tick or one outside the window is ignored", () => {
  const live = new Map<number, Candle & { at: number }>();
  let last: Tick | null = null;
  for (const [t, p] of [[59_999, 1], [60_000, 10], [61_000, 12], [60_500, 99], [62_000, 8], [119_999, 9], [120_000, 11], [180_000, 50]]) {
    if (addTick(live, last, { t, p }, 60_000, 180_000)) last = { t, p };
  }
  assert.deepEqual([...live.values()], [{ time: 60, open: 10, high: 12, low: 8, close: 9, at: 119_999 }, { time: 120, open: 11, high: 11, low: 11, close: 11, at: 120_000 }]);
  assert.deepEqual(last, { t: 120_000, p: 11 });
});

test("the backfill fills a gap whole and, in a minute both have, keeps its open and gives the close to the newer side", () => {
  const history: Candle[] = [{ time: 0, open: 1, high: 2, low: 1, close: 2 }, { time: 60, open: 5, high: 6, low: 4, close: 5 }, { time: 120, open: 7, high: 9, low: 7, close: 8 }];
  const live = new Map([
    [60, { time: 60, open: 5.5, high: 7, low: 5.5, close: 6.5, at: 100_000 }],     // history saw the whole minute (asOf 150 s): its close
    [120, { time: 120, open: 8, high: 8.5, low: 6.5, close: 6.6, at: 155_000 }],   // a tick after the history: the live close
    [180, { time: 180, open: 9, high: 9, low: 9, close: 9, at: 181_000 }],          // only live
  ]);
  assert.deepEqual(mergeCandles(history, 150_000, live), [history[0], { time: 60, open: 5, high: 7, low: 4, close: 5 }, { time: 120, open: 7, high: 9, low: 6.5, close: 6.6 }, { time: 180, open: 9, high: 9, low: 9, close: 9 }]);
  assert.deepEqual(mergeCandles(history, 150_000, new Map()), history);
});

class FakeSocket {
  static all: FakeSocket[] = [];
  url: string; sent: string[] = []; closed = false;
  onopen: (() => void) | null = null; onmessage: ((event: { data: unknown }) => void) | null = null; onclose: (() => void) | null = null;
  constructor(url: string) { this.url = url; FakeSocket.all.push(this); }
  send(data: string) { this.sent.push(data); }
  close() { this.closed = true; }
  /** The server or network ends the connection. */
  drop() { this.closed = true; this.onclose?.(); }
}
function fakeEnv(start: number) {
  FakeSocket.all = [];
  let clock = start, id = 0;
  const timers = new Map<number, { at: number; fn: () => void }>();
  const requests: { url: string; init: RequestInit; resolve: (body: unknown) => void }[] = [];
  const env: FeedEnv = {
    WebSocket: FakeSocket,
    fetch: (url, init) => new Promise((resolve, reject) => {
      init.signal?.addEventListener("abort", () => reject(new Error("aborted")));
      requests.push({ url, init, resolve: (body) => resolve({ ok: true, json: async () => body }) });
    }),
    now: () => clock,
    setTimeout: (fn, ms) => { timers.set(++id, { at: clock + ms, fn }); return id as unknown as ReturnType<typeof setTimeout>; },
    clearTimeout: (timer) => { timers.delete(timer as unknown as number); },
  };
  const advance = (ms: number) => {
    const until = clock + ms;
    for (;;) {
      const due = [...timers].filter(([, timer]) => timer.at <= until).sort((a, b) => a[1].at - b[1].at)[0];
      if (!due) break;
      timers.delete(due[0]); clock = due[1].at; due[1].fn();
    }
    clock = until;
  };
  return { env, advance, requests, pending: () => timers.size, sockets: () => FakeSocket.all, last: () => FakeSocket.all.at(-1)! };
}
const flush = () => new Promise((resolve) => setImmediate(resolve));
const T0 = Date.parse("2026-10-06T18:14:40Z"), FROM = Date.parse("2026-10-06T18:00:00Z"), END = Date.parse("2026-10-06T18:15:00Z");

test("reconnects with backoff, switches to the fallback after two attempts without a price, and stays there", async () => {
  assert.deepEqual([0, 1, 2, 3, 6, 20].map(backoff), [500, 1_000, 2_000, 4_000, 30_000, 30_000]);
  const fake = fakeEnv(T0);
  const feed = createPriceFeed(FROM, END, fake.env);
  assert.equal(fake.sockets().length, 0, "idle until resumed");
  feed.resume();
  assert.equal(fake.last().url, "wss://ws-feed.exchange.coinbase.com");
  fake.last().onopen?.();
  assert.deepEqual(JSON.parse(fake.last().sent[0]), coinbase.subscribe);
  assert.equal(fake.requests[0].init.credentials, "omit");
  assert.equal(fake.requests[0].init.referrerPolicy, "no-referrer");

  fake.last().drop();
  assert.equal(feed.status, "reconnecting");
  fake.advance(999);
  assert.equal(fake.sockets().length, 1);
  fake.advance(1);
  assert.equal(fake.sockets().length, 2);
  assert.equal(fake.last().url, "wss://ws-feed.exchange.coinbase.com");

  fake.last().drop();
  assert.equal(feed.source, "Kraken");
  // The second Coinbase backfill answers after the switch: it must not be drawn under the Kraken label.
  fake.requests[1].resolve([[FROM / 1000, 1, 1, 1, 1, 1]]);
  await flush();
  assert.deepEqual(feed.candles(), []);
  fake.advance(1_999);
  assert.equal(fake.sockets().length, 2);
  fake.advance(1);
  assert.equal(fake.last().url, "wss://ws.kraken.com/v2");
  fake.last().onopen?.();
  assert.deepEqual(JSON.parse(fake.last().sent[0]), kraken.subscribe);
  assert.match(fake.requests.at(-1)!.url, /^https:\/\/api\.kraken\.com\//);

  const before = feed.version;
  fake.last().onmessage?.({ data: KRAKEN_TRADES });
  assert.equal(feed.status, "live");
  assert.ok(feed.version > before);
  assert.deepEqual(feed.last(), { t: Date.parse("2026-10-06T18:14:45Z"), p: 85772.5 });
  assert.deepEqual(feed.candles(), [{ time: Date.parse("2026-10-06T18:14:00Z") / 1000, open: 85772.5, high: 85772.5, low: 85772.5, close: 85772.5 }]);
  // A session that delivered prices reconnects quickly to the same source.
  fake.last().drop();
  fake.advance(500);
  assert.equal(fake.sockets().length, 4);
  assert.equal(fake.last().url, "wss://ws.kraken.com/v2");
  assert.equal(feed.candles().length, 1, "same source keeps its series");
  feed.pause();
});

test("a silent socket is replaced, a hidden tab closes it, and the backfill lands under live ticks", async () => {
  const fake = fakeEnv(Date.parse("2026-10-06T18:10:00Z"));
  const feed = createPriceFeed(FROM, END, fake.env);
  feed.resume();
  const first = fake.last();
  first.onopen?.();
  first.onmessage?.({ data: COINBASE_TICKER.replace("18:14:42", "18:14:41") });
  // The backfill starts an hour before the shown window: those candles feed the volatility estimate only.
  assert.match(fake.requests[0].url, /start=2026-10-06T17:00:00\.000Z&end=2026-10-06T18:10:00\.000Z$/);
  fake.requests[0].resolve([[1_791_309_660, 69_900, 70_002, 70_000, 70_001, 1], [1_791_309_600, 68_900, 69_002, 69_000, 69_001, 1], [1_791_309_540, 68_000, 68_200, 68_100, 68_100, 1]]);
  await flush();
  assert.deepEqual(feed.candles().map((c) => [c.open, c.close]), [[69_000, 69_001], [70_000, 70_001], [85776.96, 85776.96]]);
  assert.deepEqual(feed.closes(), [68_100, 69_001, 70_001], "completed minutes only, the hour before included");

  // Heartbeats keep it alive; fifteen seconds of silence replace it.
  fake.advance(14_000);
  first.onmessage?.({ data: '{"type":"heartbeat","product_id":"BTC-USD"}' });
  fake.advance(14_999);
  assert.equal(first.closed, false);
  fake.advance(1);
  assert.equal(first.closed, true);
  assert.equal(feed.status, "reconnecting");
  first.drop(); // the late close event of a replaced socket is ignored
  fake.advance(500);
  assert.equal(fake.sockets().length, 2);
  assert.equal(fake.last().url, "wss://ws-feed.exchange.coinbase.com", "a socket that had priced is not a failure");

  feed.pause();
  assert.equal(fake.last().closed, true);
  assert.equal(fake.pending(), 0, "nothing is scheduled while hidden");
  fake.advance(120_000);
  assert.equal(fake.sockets().length, 2);
  feed.resume();
  assert.equal(fake.sockets().length, 3);
  feed.resume();
  assert.equal(fake.sockets().length, 3, "resume is idempotent");
  feed.pause();
});

test("a window that has ended reads its candles and opens no socket", async () => {
  const fake = fakeEnv(END + 60_000);
  const feed = createPriceFeed(FROM, END, fake.env);
  feed.resume();
  assert.equal(fake.sockets().length, 0);
  assert.match(fake.requests[0].url, /end=2026-10-06T18:15:00\.000Z$/);
  fake.requests[0].resolve([[1_791_310_440, 85_700, 85_800, 85_764.36, 85_778.16, 1]]);
  await flush();
  assert.deepEqual(feed.candles().at(-1), { time: 1_791_310_440, open: 85_764.36, high: 85_800, low: 85_700, close: 85_778.16 });
  assert.equal(SIGMA_WINDOW_MS, 3_600_000);
});
