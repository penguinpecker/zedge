// Offline checks of the event house: the price feeds and their rules, the quotes, what it sends up to the cutoff, its
// /quotes body, its settings and which wallet may send.
//   node --test services/market-maker/event.test.mjs
import assert from "node:assert/strict";
import { mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import * as codec from "../../adapters/vela/crypto/guest.ts";
import { deploymentEvent, eventPlan, eventPrice, kalshiYes, polymarketMid, polymarketSpread } from "./event.mjs";
import { brakes, checkSender, eventQuotes, main, settingsFrom } from "./main.mjs";
import { SHARE, apply, quotes, worstStake } from "./pricing.mjs";

const book = JSON.parse(readFileSync(new URL("../../public/deployments/26514-orderbook.json", import.meta.url), "utf8"));
const S = settingsFrom({}, "mainnet", book, true); // the event house's defaults
const EMPTY = { nonce: 0, cash: 0, reservedCash: 0, holdings: [], orders: [] };
const funded = (usdc) => ({ ...EMPTY, cash: usdc * SHARE });
const round = { id: "e".repeat(64), start: 10_000, cutoff: 200_000 };
const yes = { ok: true, p: 0.905, source: "polymarket" }, none = { ok: false, reason: "Polymarket and Kalshi differ by more than 3 cents" };
let ids = 0;
/** Applies eventPlan's commands until it returns null, each under a fresh ID. */
function run(v, now, price, s = S) {
  const sent = [];
  for (let c; (c = eventPlan(v, round, now, price, s, { optional: false })); v = apply(v, { ...c, id: `h:${++ids}` })) {
    sent.push(c.op === "place_order" ? `${c.side} ${c.outcome} ${c.price}¢ ${c.quantity / SHARE} until ${c.expiry}` : `${c.op}${c.quantity ? ` ${c.quantity / SHARE}` : ""}`);
    assert.ok(worstStake(apply(v, { ...c, id: "x" })) <= s.maxStakeUsdc * SHARE, "never past the stake cap");
  }
  return { v, sent };
}

// Kalshi's answer of 2026-10-09 (GET .../markets?series_ticker=CONTROLH&status=open), trimmed to the fields read.
const kalshi = { cursor: "", markets: [
  { ticker: "CONTROLH-2028-D", status: "active", yes_bid_dollars: "0.7400", yes_ask_dollars: "0.7600" },
  { ticker: "CONTROLH-2026-R", status: "active", yes_bid_dollars: "0.0990", yes_ask_dollars: "0.1000" },
  { ticker: "CONTROLH-2026-D", status: "active", yes_bid_dollars: "0.9000", yes_ask_dollars: "0.9010" }] };
const only = (fields) => ({ markets: [{ ...kalshi.markets[2], ...fields }] });

test("feeds: Polymarket's midpoint and Kalshi's CONTROLH-2026-D, as their APIs answer, and nothing else", () => {
  assert.equal(polymarketMid({ mid: "0.905" }), 0.905);
  assert.equal(polymarketSpread({ spread: "0.01" }), 0.01);
  for (const bad of [{ spread: 0.01 }, { spread: "-0.01" }, { spread: "1" }, {}, null]) assert.equal(polymarketSpread(bad), null, JSON.stringify(bad));
  for (const bad of [{ mid: 0.905 }, { mid: "0" }, { mid: "1" }, { mid: "x" }, {}, null, "0.905"]) assert.equal(polymarketMid(bad), null, JSON.stringify(bad));
  assert.deepEqual(kalshiYes(kalshi), { bid: 0.9, ask: 0.901 });
  assert.equal(kalshiYes({ markets: kalshi.markets.slice(0, 2) }), null, "the Republican and the 2028 markets are not this one");
  for (const bad of [{ status: "closed" }, { yes_bid_dollars: "0.0000" }, { yes_ask_dollars: "1.0000" }, { yes_bid_dollars: "0.9100" }, { yes_ask_dollars: undefined }]) {
    assert.equal(kalshiYes(only(bad)), null, JSON.stringify(bad));
  }
  assert.equal(kalshiYes({ markets: "x" }), null);
});

test("price rules: Polymarket checked against Kalshi, Kalshi alone when Polymarket is down, otherwise no price", () => {
  const now = 1_000_000, k = { bid: 0.9, ask: 0.901, at: now }, pm = { mid: 0.905, at: now };
  assert.deepEqual(eventPrice(pm, k, now), { ok: true, p: 0.905, source: "polymarket" }, "both up: Polymarket's midpoint");
  for (const down of [undefined, { ...pm, at: now - 60_001 }]) assert.deepEqual(eventPrice(down, k, now), { ok: true, p: 0.9005, source: "kalshi" }, "Polymarket down: Kalshi's mid");
  assert.equal(eventPrice(pm, { ...k, at: now - 60_000 }, now).ok, true, "a read counts for 60 s");
  const kDown = { ...k, at: now - 60_001 };
  assert.deepEqual(eventPrice({ ...pm, spread: 0.01 }, kDown, now), { ok: true, p: 0.905, source: "polymarket" }, "Kalshi down: Polymarket alone, with its spread");
  assert.equal(eventPrice({ ...pm, spread: 0.05 }, kDown, now).ok, true, "a 5-cent Polymarket spread is still a price");
  for (const spread of [undefined, null, 0.0501]) assert.match(eventPrice({ ...pm, spread }, kDown, now).reason, /Kalshi unavailable, and Polymarket's spread/, `spread ${spread}`);
  assert.match(eventPrice(undefined, undefined, now).reason, /unavailable/, "both down");
  assert.equal(eventPrice({ mid: 0.9305, at: now }, k, now).ok, true, "3 cents apart is still a price");
  assert.match(eventPrice({ mid: 0.9306, at: now }, k, now).reason, /differ by more than 3 cents/);
  assert.match(eventPrice({ mid: 0.87, at: now }, k, now).reason, /differ/);
  assert.equal(eventPrice(pm, { bid: 0.88, ask: 0.93, at: now }, now).ok, true, "a 5-cent spread is still a price");
  assert.match(eventPrice(pm, { bid: 0.88, ask: 0.9301, at: now }, now).reason, /spread/, "wide, with Polymarket up");
  assert.match(eventPrice(undefined, { bid: 0.88, ask: 0.9301, at: now }, now).reason, /spread/, "wide, on Kalshi alone");
});

test("quotes: Yes 88/93 and No 7/12 at Polymarket's 0.905 and at Kalshi's 0.9005, half-spread 2", () => {
  for (const p of [0.905, 0.9005]) assert.deepEqual(quotes(p, S.halfSpreadCents), { up: { bid: 88, ask: 93 }, down: { bid: 7, ask: 12 } }, `p ${p}`);
});

test("plan: nothing before the start; then a mint and the four quotes, hours long on their own grid, within the stake cap", () => {
  assert.equal(eventPlan(funded(20), round, 9_999, yes, S), null, "the engine takes orders from the start");
  const { v, sent } = run(funded(20), 10_000, yes);
  // Lifetime 4 h: each side on its own hour of the 4-hour grid, 2 to 6 h ahead.
  assert.deepEqual(sent, ["mint 10", "sell up 93¢ 5 until 28800", "sell down 12¢ 5 until 18000", "buy up 88¢ 5 until 21600", "buy down 7¢ 5 until 25200"]);
  assert.equal(worstStake(v), 10 * SHARE);
  assert.equal(v.cash, 20 * SHARE - 10 * SHARE - 5 * 88 * 10_000 - 5 * 7 * 10_000, "10 sets minted, the bids' cash reserved");
  // Users take the Yes ask again and again: the house sells Yes only while its worst stake stays within 20 USDC.
  let w = v, asks = 0;
  for (let i = 0; i < 10; i++) {
    const ask = w.orders.find((o) => o.side === "sell" && o.outcome === "up");
    if (!ask) break;
    asks++;
    const h = w.holdings[0];
    w = { ...w, cash: w.cash + 5 * 93 * 10_000, orders: w.orders.filter((o) => o !== ask), holdings: [{ ...h, reservedUp: h.reservedUp - ask.remaining }] };
    w = run(w, 10_000, yes).v;
  }
  assert.equal(asks, 3, "15 Yes sold, then the next ask would pass the 20 USDC cap");
});

test("plan: no price pulls every resting quote; the house stops at the cutoff", () => {
  const { v } = run(funded(20), 10_000, yes);
  assert.deepEqual(eventPlan(v, round, 10_100, none, S), { op: "cancel_all", roundId: round.id }, "a quote lasts hours: none stays up with no price behind it");
  assert.equal(eventPlan(apply(v, { op: "cancel_all", roundId: round.id }), round, 10_100, none, S), null, "nothing rests: nothing to send");
  assert.equal(eventPlan(v, round, 28_797, none, S).op, "cancel_all");
  assert.equal(eventPlan(v, round, 28_798, none, S), null, "all gone by the time a cancel could land");
  // The cutoff.
  const late = run(funded(20), round.cutoff - 300, yes).v;
  assert.ok(late.orders.every((o) => o.expiry === round.cutoff - 60), "no quote outlives cutoff − 60");
  assert.equal(eventPlan(funded(20), round, round.cutoff - 120, yes, S), null, "nothing new from cutoff − 120");
  assert.equal(eventPlan(late, round, round.cutoff - 100, yes, S), null);
  assert.deepEqual(eventPlan(late, round, round.cutoff - 90, yes, S), { op: "cancel_all", roundId: round.id }, "cutoff − 90: the backstop cancel");
  assert.equal(eventPlan(late, round, round.cutoff, yes, S), null);
  assert.equal(eventPlan(late, round, round.cutoff, none, S), null, "after the cutoff, nothing, with or without a price");
});

test("/quotes: { at, round, up, down } of the event round, Up for Yes and Down for No", () => {
  const { v } = run(funded(20), 10_000, yes);
  const body = eventQuotes(v, round, 10_002, 1_793_000_000_000);
  assert.deepEqual(body, { at: 1_793_000_000_000, round: `0x${round.id}`,
    up: { ask: { cents: 93, shares: 5 }, bid: { cents: 88, shares: 5 } }, down: { ask: { cents: 12, shares: 5 }, bid: { cents: 7, shares: 5 } } });
  assert.deepEqual(Object.keys(body), ["at", "round", "up", "down"]);
  assert.match(body.round, /^0x[0-9a-f]{64}$/);
  assert.deepEqual(eventQuotes(EMPTY, round, 10_002, 1).up, { ask: null, bid: null });
  assert.deepEqual(eventQuotes(v, round, 17_998, 1).down.ask, null, "a quote expiring within 2 s is left out");
});

test("settings: the event house's own defaults and key file; its stake cap no higher than the guest's 50 USDC per account", () => {
  assert.deepEqual([S.halfSpreadCents, S.quoteShares, S.mintSets, S.maxStakeUsdc, S.quoteLifetimeSeconds, S.requoteDriftCents, S.pollSeconds, S.maxRpcPerRound],
    [2, 5, 10, 20, 14_400, 3, 20, 300]);
  assert.match(S.deployment.keyFile, /\/\.config\/zedge\/event-house\.key$/);
  assert.match(settingsFrom({}, "mainnet", book).deployment.keyFile, /\/\.config\/zedge\/house\.key$/, "the BTC house keeps its own");
  assert.equal(settingsFrom({ maxStakeUsdc: 50 }, "mainnet", book, true).maxStakeUsdc, 50);
  for (const bad of [{ maxStakeUsdc: 51 }, { pollSeconds: 14 }, { pollSeconds: 31 }, { quoteLifetimeSeconds: 599 }]) {
    assert.throws(() => settingsFrom(bad, "mainnet", book, true), new RegExp(Object.keys(bad)[0]), JSON.stringify(bad));
  }
  assert.equal(settingsFrom({ pollSeconds: 2 }, "mainnet", book).pollSeconds, 2, "the BTC ranges are unchanged");
});

test("brakes: a needed cancel passes them, the event house's only until 3 of its cancels are refused in a window", () => {
  const cancel = { op: "cancel_all", roundId: round.id }, place = { op: "place_order" }, r = (refusals, cancelRefusals) => ({ refusals, cancelRefusals });
  assert.equal(brakes(cancel, false, r(3, 2), 0, 300, true), null);
  assert.match(brakes(cancel, false, r(3, 3), 0, 300, true), /3 cancels refused this window/, "a cancel that keeps failing waits for the next window");
  assert.equal(brakes(cancel, false, r(5, 0), 999, 300, true), null, "place refusals and the RPC budget never hold a needed cancel");
  assert.equal(brakes(cancel, false, r(3, 3), 999, 300), null, "the BTC house's needed cancels pass as before");
  assert.match(brakes(cancel, true, r(3, 0), 0, 300, true), /3 refusals/, "an optional requote is no needed cancel");
  for (const event of [false, true]) {
    assert.equal(brakes(place, false, r(2, 0), 300, 300, event), null);
    assert.match(brakes(place, false, r(3, 0), 0, 300, event), /3 refusals this round/);
    assert.match(brakes(place, false, r(0, 0), 301, 300, event), /RPC budget of 300/);
  }
});

test("senders: the BTC house only as itself, the event house never as it, and never the resolver", () => {
  const dep = { house: `0x${"1".repeat(40)}`, keyFile: "k" }, other = `0x${"2".repeat(40)}`, resolver = `0x${"3".repeat(40)}`;
  checkSender(dep.house, dep, false, resolver);
  checkSender(other, dep, true, resolver);
  assert.throws(() => checkSender(other, dep, false, resolver), /not the house/);
  assert.throws(() => checkSender(dep.house, dep, true, resolver), /needs its own wallet/);
  assert.throws(() => checkSender(resolver, { ...dep, house: resolver }, false, resolver), /resolver/);
  assert.throws(() => checkSender(resolver, dep, true, resolver), /resolver/);
});

test("the command line: the events manifest is the committed one on mainnet, and --events is required on a fork", async () => {
  await assert.rejects(main(["run", "--event", "--mainnet", "--events", "x.json"]), /--events goes with --fork/);
  const settings = join(mkdtempSync(join(tmpdir(), "zedge-event-")), "settings.json"), a = (n) => `0x${String(n).repeat(40)}`;
  writeFileSync(settings, JSON.stringify({ fork: { keyFile: "eh.key", house: a(5), endpoint: a(1), authenticator: a(2), trigger: a(3), registry: a(4), applicationId: "42",
    applicationFingerprint: "a".repeat(64), origin: "http://127.0.0.1:4189", epoch: "1", vault: a(7), baseRpc: "http://127.0.0.1:18545" } }));
  for (const cmd of [["run", "--event"], ["resolve", "result.json"]]) await assert.rejects(main([...cmd, "--fork", "http://127.0.0.1:1", "--settings", settings]), /--fork needs --events/);
  await assert.rejects(main(["resolve", "--mainnet"]), /usage/);
});

test("the event from the manifests: the guest's round, for this application only", () => {
  const v = JSON.parse(readFileSync(new URL("../../adapters/vela/guest/testdata/vectors.json", import.meta.url), "utf8")).event;
  const events = { schemaVersion: 1, kind: "zedge-events", chainId: 31337, release: "test", application: "17429726349691885448", deployTx: `0x${"0".repeat(64)}`,
    resolver: v.resolver, depositsFrom: 8, event: { rules: "/events/test.txt", questionHash: v.event.question, start: v.event.start, cutoff: v.event.cutoff, end: v.event.end, voidableAfter: v.event.voidableAfter } };
  const e = deploymentEvent(v.engineConfig, events, codec);
  assert.deepEqual([e.id, e.spec, e.terms, e.resolver], [v.roundId, v.spec, v.event, v.resolver], "the round the Go guest creates");
  assert.throws(() => deploymentEvent(v.engineConfig, { ...events, application: "1" }, codec), /application 1's/);
  assert.throws(() => deploymentEvent(v.engineConfig, { ...events, chainId: 26514 }, codec), /events manifest/);
  assert.throws(() => deploymentEvent(v.engineConfig, { ...events, kind: "zedge-private-orderbook" }, codec), /events manifest/);
  assert.throws(() => deploymentEvent(v.engineConfig, { ...events, resolver: v.resolver.toUpperCase() }, codec), /resolver/);
  assert.throws(() => deploymentEvent(v.engineConfig, { ...events, event: { ...events.event, end: v.event.start } }, codec), /Invalid event terms/);
});
