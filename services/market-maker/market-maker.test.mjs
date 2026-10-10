// Offline checks of the house market maker: pricing, the guest's stake, what it sends next, and the start guards.
//   node --test services/market-maker/market-maker.test.mjs
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";
import { SHARE, apply, expire, fairUp, phi, plan, quotes, realizedSigma, spotCheck, worstStake } from "./pricing.mjs";
import { checkBase, checkNode, houseQuotes, mainnetDeployment, queueFull, settingsFrom, target } from "./main.mjs";

// The public fields of a configured order-book manifest the bot reads (public/deployments/26514-orderbook.json, schema 3).
const a = (n) => `0x${String(n).repeat(40)}`;
const configured = { kind: "zedge-private-orderbook", chainId: 26514, status: "configured",
  endpoint: { address: "0x0a2703d21b27757fdf27ab807eae9820788010f3", minFeePerRequestWei: "1000000000" }, authenticator: { address: a(2), teeSigner: a(6), enclavePublicKey: `0x04${"ab".repeat(132)}` },
  trigger: { address: a(3), registry: "0x4dd4aacdb7e8d2e6d06c5af38238f3deab836744" }, custody: { vault: { address: a(7) } },
  application: { id: "42", wasmSha256: "a".repeat(64), origin: "https://zedge-markets.vercel.app", epoch: "1", house: a(5), sessionRulesHash: "b".repeat(64) } };
const S = settingsFrom({}, "mainnet", configured); // the defaults

const EMPTY = { nonce: 0, cash: 0, reservedCash: 0, holdings: [], orders: [] };
const funded = (usdc) => ({ ...EMPTY, cash: usdc * SHARE });
const round = { id: "r", cutoff: 10_000 }, mint = { op: "mint", roundId: "r", quantity: 40 * SHARE };
let ids = 0;
/** Applies plan's commands until it returns null, each placed order under a fresh ID. */
function run(v, now, p, s = S, opts = {}) {
  const sent = [];
  for (let c; (c = plan(v, round, now, p, s, opts)); v = apply(v, { ...c, id: `h:${++ids}` })) {
    sent.push(c.op === "cancel_order" ? `cancel ${v.orders.find((o) => o.id === c.orderId).side} ${v.orders.find((o) => o.id === c.orderId).outcome}`
      : c.op === "place_order" ? `${c.side} ${c.outcome} ${c.price}¢ ${c.quantity / SHARE} until ${c.expiry}` : c.op);
  }
  return { v, sent };
}
const id = (v, side, outcome) => v.orders.find((o) => o.side === side && o.outcome === outcome).id;

test("fair value: 0.5 at the opening price, rising with spot, clamped, ties resolve Up", () => {
  assert.ok(Math.abs(phi(1.959964) - 0.975) < 1e-6 && Math.abs(phi(-0.7) + phi(0.7) - 1) < 1e-9);
  assert.ok(Math.abs(fairUp(85_000, 85_000, 0.6, 600) - 0.5) < 1e-8);
  let last = 0;
  for (let spot = 84_800; spot <= 85_200; spot += 10) {
    const p = fairUp(spot, 85_000, 0.6, 600);
    assert.ok(p > last, `p rises with S at ${spot}`);
    last = p;
  }
  assert.equal(fairUp(100_000, 85_000, 0.6, 600), 0.98);
  assert.equal(fairUp(70_000, 85_000, 0.6, 600), 0.02);
  assert.equal(fairUp(85_000, 85_000, 0.6, 0), 0.98);
  assert.equal(fairUp(84_999, 85_000, 0.6, 0), 0.02);
  assert.throws(() => fairUp(85_000, 0, 0.6, 600));
});

test("quotes: integer cents, bid below ask, never sells a set below 1 or buys one above 1", () => {
  for (const h of [1, 3, 5, 10]) {
    for (let i = 20; i <= 980; i++) {
      const p = i / 1000, q = quotes(p, h);
      for (const x of [q.up, q.down]) assert.ok(Number.isInteger(x.bid) && Number.isInteger(x.ask) && x.bid >= 1 && x.ask <= 99 && x.bid < x.ask, `p ${p} h ${h}`);
      assert.ok(q.up.ask + q.down.ask > 100 && q.up.bid + q.down.bid < 100, `p ${p} h ${h}`);
      if (q.up.ask < 99 && q.down.ask < 99) assert.ok(q.up.ask + q.down.ask >= 100 + 2 * h, `asks p ${p} h ${h}`);
      if (q.up.bid > 1 && q.down.bid > 1) assert.ok(q.up.bid + q.down.bid <= 100 - 2 * h, `bids p ${p} h ${h}`);
    }
  }
  assert.deepEqual(quotes(0.5, 3), { up: { bid: 47, ask: 53 }, down: { bid: 47, ask: 53 } });
  assert.deepEqual(quotes(0.57, 3), { up: { bid: 54, ask: 60 }, down: { bid: 40, ask: 46 } }); // 1 − 0.57 is 0.43000000000000005
});

test("volatility and spot: annualised 1-minute closes within [0.30, 1.50]; fresh, agreeing feeds only", () => {
  const closes = [100];
  for (let i = 0; i < 60; i++) closes.push(closes.at(-1) * Math.exp(i % 2 ? -0.001 : 0.001));
  assert.ok(Math.abs(realizedSigma(closes) - Math.sqrt(((60 * 1e-6) / 59) * 525_600)) < 1e-9);
  assert.equal(realizedSigma(Array(60).fill(85_000)), 0.3);
  assert.equal(realizedSigma(closes.map((_, i) => (i % 2 ? 80_000 : 90_000))), 1.5);
  assert.throws(() => realizedSigma([1, 2, 3]));
  const now = 1_000_000;
  assert.deepEqual(spotCheck({ mid: 85_000, at: now - 9_000 }, { mid: 85_200, at: now }, now), { ok: true, spot: 85_000 });
  assert.equal(spotCheck({ mid: 85_000, at: now - 10_001 }, { mid: 85_000, at: now }, now).reason, "spot stale");
  assert.equal(spotCheck({ mid: 85_000, at: now }, { mid: 85_300, at: now }, now).reason, "spot disputed");
  assert.equal(spotCheck({ mid: Number.NaN, at: now }, { mid: 85_000, at: now }, now).reason, "spot missing");
});

test("stake: fork-round's vector (mint 120, ask Up 50@55, ask Down 50@55, bid Up 50@45) is exactly 100 shares", () => {
  let v = apply(funded(200), { op: "mint", roundId: "a", quantity: 120 * SHARE });
  for (const [outcome, side, price] of [["up", "sell", 55], ["down", "sell", 55], ["up", "buy", 45]]) {
    v = apply(v, { op: "place_order", roundId: "a", outcome, side, price, quantity: 50 * SHARE, tif: "gtc", expiry: 1 });
  }
  assert.equal(worstStake(v), 100 * SHARE);
  assert.equal(v.cash, 57_500_000); // 200 − 120 − 50 × 0.45
  assert.equal(worstStake(apply(v, { op: "place_order", roundId: "a", outcome: "up", side: "buy", price: 45, quantity: SHARE, tif: "gtc", expiry: 1 })), 101 * SHARE);
  const cancelled = apply(v, { op: "cancel_all", roundId: "a" });
  assert.equal(worstStake(cancelled), 0);
  assert.equal(cancelled.cash, 80 * SHARE);
});

test("apply: cancel_order returns exactly that order's cash or shares; a placed order keeps its command ID", () => {
  const { v } = run(apply(funded(200), mint), 9_000, 0.5);
  const bid = v.orders.find((o) => o.side === "buy" && o.outcome === "up"), ask = v.orders.find((o) => o.side === "sell" && o.outcome === "down");
  assert.match(bid.id, /^h:/);
  const noBid = apply(v, { op: "cancel_order", orderId: bid.id });
  assert.deepEqual([noBid.orders.length, noBid.cash - v.cash, noBid.reservedCash - v.reservedCash], [3, 4_700_000, -4_700_000]);
  const noAsk = apply(v, { op: "cancel_order", orderId: ask.id }), h = (x) => x.holdings[0];
  assert.deepEqual([noAsk.orders.length, h(noAsk).down - h(v).down, h(noAsk).reservedDown - h(v).reservedDown, noAsk.cash], [3, 10 * SHARE, -10 * SHARE, v.cash]);
});

test("plan: a mint, the four quotes on their own expiry grids, rotation before expiry, the stake cap and the last two minutes", () => {
  const now = 9_000;
  assert.deepEqual(plan(funded(200), round, now, 0.5, S), mint);
  const { v, sent } = run(apply(funded(200), mint), now, 0.5);
  // Lifetime 60: each side on its own 15 s phase, 30 to 90 s ahead, so the four rotations fall due 15 s apart.
  assert.deepEqual(sent, ["sell up 53¢ 10 until 9060", "sell down 53¢ 10 until 9075", "buy up 47¢ 10 until 9030", "buy down 47¢ 10 until 9045"]);
  assert.equal(worstStake(v), 20 * SHARE);
  assert.equal(plan(v, round, 9_027, 0.5, S), null, "not yet at expiry − 3");
  const rotate = plan(v, round, 9_028, 0.5, S);
  assert.deepEqual([rotate.op, rotate.side, rotate.outcome, rotate.expiry], ["place_order", "buy", "up", 9_090], "at expiry − 2 the replacement goes out, one lifetime on");
  assert.equal(worstStake(expire(apply(v, rotate), 9_030)), 20 * SHARE, "the checkpoint releases the old bid before the new one activates");
  assert.equal(plan(apply(funded(200), mint), round, now, null, S), null, "no quotes while pricing is refused");

  const tight = { ...S, maxStakeUsdc: 15 };
  assert.equal(run(apply(funded(200), mint), now, 0.5, tight).v.orders.length, 2, "the bids would take the worst stake to 20 > 15");
  assert.deepEqual(plan(funded(30), round, now, 0.5, S), { op: "mint", roundId: "r", quantity: 10 * SHARE }, "short of a full mint: only the shares one ask lacks");
  assert.deepEqual(run(funded(20), now, 0.5).sent.map((x) => x.split(" ").slice(0, 2).join(" ")), ["mint", "sell up", "sell down", "buy up", "buy down"], "20 USDC rests all four quotes");
  assert.equal(plan(funded(5), round, now, 0.5, S).side, "buy", "no cash for even one ask's shares: the asks wait, a bid goes out");
  assert.deepEqual(plan({ ...funded(7), holdings: [{ roundId: "r", up: 5_500_000, down: 0, reservedUp: 0, reservedDown: 0 }] }, round, now, 0.5, S),
    { op: "mint", roundId: "r", quantity: 4_500_000 }, "a partial-fill leftover: mint only the rest");

  const withSets = apply(funded(200), mint);
  assert.equal(plan(withSets, round, 9_875, 0.5, S).expiry, 9_940, "no quote outlives cutoff − 60");
  const resting = apply(withSets, { ...plan(withSets, round, 9_875, 0.5, S), id: "x" });
  assert.equal(plan(resting, round, 9_880, 0.5, S), null, "nothing new from cutoff − 120");
  assert.deepEqual(plan(resting, round, 9_910, 0.5, S), { op: "cancel_all", roundId: "r" }, "cutoff − 90: cancel what rests");
  assert.equal(plan(resting, round, 9_938, 0.5, S), null, "all expired at cutoff − 60");
});

test("plan: drift pulls one quote by ID, the one in the trader's favour first, before any missing side is refilled", () => {
  const four = run(apply(funded(200), mint), 9_000, 0.5).v;
  assert.equal(plan(four, round, 9_000, 0.53, S), null, "3 cents of drift keeps the quotes");
  assert.deepEqual(plan(four, round, 9_000, 0.54, S), { op: "cancel_order", orderId: id(four, "sell", "up") }, "4 cents: the Up ask now sells below the fresh ask");
  assert.deepEqual(plan(four, round, 9_000, 0.46, S), { op: "cancel_order", orderId: id(four, "sell", "down") });
  // A user filled the Up bid, then p jumps: the quotes that lose the house money go before the empty side is refilled.
  const filled = { ...four, orders: four.orders.filter((o) => o.id !== id(four, "buy", "up")) };
  assert.deepEqual(plan(filled, round, 9_000, 0.54, S), { op: "cancel_order", orderId: id(four, "sell", "up") }, "the adverse cancel is the first command");
  assert.deepEqual(run(filled, 9_000, 0.54, S, { optional: false }).sent,
    ["cancel sell up", "cancel buy down", "sell up 57¢ 10 until 9060", "buy up 51¢ 10 until 9030", "buy down 43¢ 10 until 9045"]);
  // The two quotes drifted the house's way only overcharge users: optional, after every placeable side is quoted.
  const { v } = run(four, 9_000, 0.54, S, { optional: false });
  assert.equal(plan(v, round, 9_000, 0.54, S, { optional: false }), null);
  assert.deepEqual(plan(v, round, 9_021, 0.54, S), { op: "cancel_order", orderId: id(four, "sell", "down") }, "optional: the Down ask, 4 cents above the fresh ask");
  assert.equal(plan(v, round, 9_022, 0.54, S), null, "not while the Up bid's rotation (9030 − 2) falls due within one cycle");
  // An ask clamped at 99 is not a drift: no cancel-and-replace loop.
  const high = run(apply(funded(200), mint), 9_000, 0.98, { ...S, halfSpreadCents: 5 }).v;
  assert.equal(plan(high, round, 9_000, 0.97, { ...S, halfSpreadCents: 5 }), null);
});

test("plan: sides the house cannot place (here the stake cap skips both bids) do not block an optional requote", () => {
  const tight = { ...S, maxStakeUsdc: 15 };
  const { v, sent } = run(run(apply(funded(200), mint), 9_000, 0.5, tight).v, 9_000, 0.54, tight);
  assert.deepEqual(sent, ["cancel sell up", "sell up 57¢ 10 until 9060", "cancel sell down", "sell down 49¢ 10 until 9075"],
    "the Down ask, drifted the house's way, is pulled and re-placed at the fresh price although both bids are missing");
  assert.equal(v.orders.length, 2);
});

test("plan: no cancel for an order expiring within max(12, 2 cycles), the self-cross target included", () => {
  const four = run(apply(funded(200), mint), 9_000, 0.5).v; // expiries: ask Up 9060, ask Down 9075, bid Up 9030, bid Down 9045
  assert.equal(plan(four, round, 9_000, 0.46, S, { cycle: 6 }).orderId, id(four, "sell", "down"));
  assert.equal(plan(four, round, 9_000, 0.46, S, { cycle: 38 }), null, "both adverse quotes expire within 76 s: they rotate instead");
  // Half-spread 1, drift 4: a 3-cent move is no drift, but a refilled Up bid at 52 would cross the house's own Up ask at 51.
  const S1 = { ...S, halfSpreadCents: 1 }, q = run(apply(funded(200), mint), 9_000, 0.5, S1).v;
  const noBid = { ...q, orders: q.orders.filter((o) => o.id !== id(q, "buy", "up")) };
  assert.deepEqual(plan(noBid, round, 9_041, 0.53, S1, { cycle: 6 }), { op: "cancel_order", orderId: id(q, "sell", "up") }, "self-trade prevention would cancel the new bid");
  assert.equal(plan(noBid, round, 9_041, 0.53, S1, { cycle: 10 }), null, "the Up ask expires within 20 s: wait for it");
  // A slow queue: a refilled quote outlives two request cycles, or it could reach its commit already expired ("invalid order").
  const noAsk = { ...four, orders: four.orders.filter((o) => o.id !== id(four, "sell", "up")) };
  assert.equal(plan(noAsk, round, 9_001, 0.5, S).expiry, 9_060, "a normal cycle: the next grid slot, 59 s on");
  assert.equal(plan(noAsk, round, 9_029, 0.5, S).expiry, 9_060, "31 s on is still more than two 6 s cycles");
  assert.equal(plan(noAsk, round, 9_029, 0.5, S, { cycle: 20 }).expiry, 9_120, "20 s cycles: 31 s is too close, so the slot after");
});

/** The bot against a model exchange over one round: one request in flight at a time, each taking d() seconds; a command
 * applies at T = sent + d after the tick's checkpoint released orders with expiry ≤ T; idle, the bot looks again every
 * pollSeconds; an optional requote at most once per 15 s. Returns what the engine would refuse, the longest stretch any side
 * had no live order and the most sides empty at one time, from the first full set to cutoff − 120. */
function simulate(r, from, price, d, cycle) {
  let v = funded(200), t = from, last = -Infinity, requests = 0;
  const flags = [], live = new Map(); // order ID → [side, from, to)
  while (t < r.cutoff) {
    let c = plan(v, r, t, price(t), S, { cycle, optional: false });
    if (!c && t - last >= 15) { c = plan(v, r, t, price(t), S, { cycle }); if (c) last = t; }
    if (!c) { t += S.pollSeconds; continue; }
    const T = t + d(), side = `${c.side} ${c.outcome}`;
    v = expire(v, T);
    if (c.op === "place_order" && c.expiry <= T) flags.push(`${side} expired on arrival at ${T}`);
    if (c.op === "place_order" && v.orders.some((o) => o.outcome === c.outcome && o.side !== c.side && (c.side === "buy" ? c.price >= o.price : c.price <= o.price))) flags.push(`self-cross ${side} at ${T}`);
    if (c.op === "cancel_order" && !v.orders.some((o) => o.id === c.orderId)) flags.push(`unknown active order at ${T}`);
    for (const o of v.orders) if (c.op === "cancel_all" || o.id === c.orderId) live.get(o.id)[2] = Math.min(live.get(o.id)[2], T);
    v = apply(v, { ...c, id: `s:${++requests}` });
    if (c.op === "place_order") live.set(`s:${requests}`, [side, T, c.expiry]);
    if (v.orders.length > 4) flags.push(`order capacity at ${T}`);
    t = T;
  }
  const covered = (side, x) => [...live.values()].some(([s, a, b]) => s === side && a <= x && x < b), sides = ["sell up", "sell down", "buy up", "buy down"];
  let x = from;
  while (!sides.every((side) => covered(side, x))) x++;
  let gap = 0, most = 0;
  for (const side of sides) for (let y = x, empty = 0; y < r.cutoff - 120; y++) gap = Math.max(gap, (empty = covered(side, y) ? 0 : empty + 1));
  for (let y = x; y < r.cutoff - 120; y++) most = Math.max(most, sides.filter((side) => !covered(side, y)).length);
  return { flags, gap, requests, most };
}

test("rotation: a re-quote empties one side at a time, never longer than the request takes, and nothing is refused", () => {
  const r = { id: "r", cutoff: 870 }; // start 0, cutoff buffer 30
  for (const d of [2, 3, 6]) {
    const { flags, gap, requests, most } = simulate(r, 10, () => 0.5, () => d, d);
    assert.deepEqual(flags, [], `d ${d}`);
    // The old quote must be released before its replacement activates (four orders at most), and the replacement goes out
    // at expiry − 2 or, between 2 s polls, expiry − 1: a side is empty for the request's time beyond that, and only that side.
    assert.ok(most <= 1, `d ${d}: ${most} sides were empty at once`);
    assert.ok(gap <= d - 1, `d ${d}: a side was empty for ${gap} s`);
    assert.ok(requests >= 50 && requests <= 60, `d ${d}: ${requests} requests in a calm round`); // README gas estimate
  }
  // A seeded random walk (±1 cent steps, ±8 cent jumps), each request taking 2 to 8 s: no refusal of any kind.
  let seed = 7;
  const rand = () => ((seed = (seed * 48_271) % 2_147_483_647) / 2_147_483_647);
  for (let k = 0; k < 6; k++) {
    let p = 0.5, at = 0;
    const walk = (t) => { for (; at < t; at++) p = Math.min(0.9, Math.max(0.1, p + (rand() < 0.02 ? 0.08 : 0.01) * (rand() < 0.5 ? -1 : 1) * (rand() < 0.2 ? 1 : 0))); return p; };
    assert.deepEqual(simulate(r, 10, walk, () => 2 + Math.floor(rand() * 7), 6).flags, [], `walk ${k}`);
  }
});

test("guard: --mainnet or a loopback --fork, and --fork only against Anvil on chain 26514", async () => {
  assert.throws(() => target({}), /refusing to run without --mainnet or --fork/);
  assert.throws(() => target({ mainnet: true, fork: "http://127.0.0.1:8545" }), /not both/);
  for (const url of ["https://127.0.0.1:8545", "http://10.0.0.5:8545", "http://127.0.0.1.example.com:8545", "http://127.0.0.1@example.com:8545",
    "https://26514.rpc.thirdweb.com", "ws://127.0.0.1:8545", "not a url", ""]) assert.throws(() => target({ fork: url }), /--fork/, url);
  assert.deepEqual(target({ fork: "http://127.0.0.1:38945" }), { mode: "fork", rpc: "http://127.0.0.1:38945" });
  assert.equal(target({ fork: "http://localhost:8545" }).mode, "fork");
  assert.equal(target({ fork: "http://[::1]:8545" }).mode, "fork");
  assert.equal(target({ mainnet: true }).mode, "mainnet");
  const node = (version, chainId) => async (method) => (method === "web3_clientVersion" ? version : chainId);
  await assert.rejects(checkNode(node("Geth/v1.14.0", "0x6792"), "fork"), /not Anvil/);
  await assert.rejects(checkNode(node("anvil/v1.7.1", "0x1"), "fork"), /chain 1,/);
  await checkNode(node("anvil/v1.7.1", "0x6792"), "fork");
  await checkNode(async (method) => { assert.equal(method, "eth_chainId"); return "0x6792"; }, "mainnet");
  await assert.rejects(checkBase(node("Geth/v1.14.0", "0x2105"), "fork"), /not Anvil/);
  await assert.rejects(checkBase(node("anvil/v1.7.1", "0x6792"), "fork"), /not 8453/);
  await checkBase(node("anvil/v1.7.1", "0x2105"), "fork");
});

test("settings: the example parses; a fork deployment only with --fork; unknown or out-of-range fields refused", () => {
  const example = JSON.parse(readFileSync(new URL("settings.example.json", import.meta.url), "utf8"));
  const m = settingsFrom(example, "mainnet", configured);
  assert.equal(m.deployment.endpoint, "0x0a2703d21b27757fdf27ab807eae9820788010f3");
  assert.deepEqual([m.deployment.vault, m.deployment.trigger, m.deployment.minFeeWei], [a(7), a(3), 1_000_000_000n], "read from the manifest");
  assert.throws(() => mainnetDeployment({ kind: "zedge-private-orderbook", chainId: 26514, status: "planned", release: "x" }), /planned/);
  assert.equal(m.minEthWei, 200_000_000_000_000n);
  const fork = { keyFile: "house.key", endpoint: a(1), authenticator: a(2), trigger: a(3), registry: a(4), house: a(5), applicationId: "42",
    applicationFingerprint: "a".repeat(64), origin: "http://127.0.0.1:4189", epoch: "1", vault: a(7), baseRpc: "http://127.0.0.1:18545" };
  assert.throws(() => settingsFrom({ ...example, fork }, "mainnet", configured), /--fork only/);
  assert.throws(() => settingsFrom({ fork: { ...fork, baseRpc: "https://base-rpc.publicnode.com" } }, "fork"), /baseRpc/);
  assert.throws(() => settingsFrom(example, "fork"), /settings\.fork needs/);
  assert.equal(settingsFrom({ fork }, "fork").deployment.endpoint, a(1));
  assert.throws(() => settingsFrom({ fork: { ...fork, endpoint: a(1).toUpperCase() } }, "fork"), /lowercase/);
  assert.throws(() => settingsFrom({ maxStakeUSDC: 100 }, "mainnet", configured), /unknown field/);
  assert.throws(() => settingsFrom({ maxStakeUsdc: 5000 }, "mainnet", configured), /maxStakeUsdc/);
  assert.throws(() => settingsFrom({ quoteShares: 50, mintSets: 40 }, "mainnet", configured), /mintSets/);
  assert.deepEqual([m.quoteLifetimeSeconds, m.requoteDriftCents, m.maxRpcPerRound, m.pollSeconds], [60, 4, 6000, 2], "the example holds the defaults");
  assert.deepEqual(Object.entries(example).filter(([k, v]) => k !== "minEthWei" && S[k] !== v), []);
  assert.equal(settingsFrom({ maxRpcPerRound: 20_000 }, "mainnet", configured).maxRpcPerRound, 20_000);
  assert.throws(() => settingsFrom({ maxRpcPerRound: 20_001 }, "mainnet", configured), /maxRpcPerRound/);
  const railway = JSON.parse(readFileSync(new URL("railway.settings.json", import.meta.url), "utf8"));
  assert.deepEqual(settingsFrom(railway, "mainnet", configured), { ...S, quoteShares: 4, quoteLifetimeSeconds: 300, requoteDriftCents: 6 }, "Railway runs the default brake with 4-share quotes (the house holds 5 USDC since the switch-over) that last 5 min and move on 6¢: about a third of the requests, so of the gas");
});

test("the queue guard: quotes and syncs wait at 5 pending requests, a needed cancel goes out until 9, an optional one only into an empty queue", () => {
  assert.deepEqual([4n, 5n].map((q) => queueFull(q, "place_order")), [false, true]);
  assert.deepEqual([6n, 8n, 9n].map((q) => queueFull(q, "cancel_all")), [false, false, true]);
  assert.deepEqual([8n, 9n].map((q) => queueFull(q, "cancel_order")), [false, true]);
  assert.deepEqual([0n, 1n].map((q) => queueFull(q, "cancel_order", true)), [false, true]);
  assert.equal(queueFull(5n, "sync"), true);
});

test("quotes for the site: per outcome the lowest resting sell and the highest resting buy of the open round, in cents and shares", () => {
  const r = { id: "r", start: 9_000 }, o = (outcome, side, price, shares, more = {}) => ({ roundId: "r", outcome, side, price, remaining: shares * SHARE, reservedCash: 0, expiry: 9_500, ...more });
  const view = { ...EMPTY, orders: [o("up", "sell", 57, 10), o("up", "sell", 55, 4.5), o("up", "buy", 41, 10), o("up", "buy", 44, 2), o("up", "sell", 55, 1),
    o("down", "buy", 40, 10), o("down", "sell", 50, 3, { expiry: 9_100 }), o("down", "sell", 49, 3, { roundId: "q" }), o("down", "buy", 45, 0)] };
  assert.deepEqual(houseQuotes(view, r, 9_100, 123), { at: 123, start: 9_000,
    up: { ask: { cents: 55, shares: 5.5 }, bid: { cents: 44, shares: 2 } }, down: { ask: null, bid: { cents: 40, shares: 10 } } }, "expired, other-round and filled orders left out");
  assert.deepEqual(houseQuotes(EMPTY, { id: "s", start: 9_900 }, 9_900, 124), { at: 124, start: 9_900, up: { ask: null, bid: null }, down: { ask: null, bid: null } });
  // A rotation: at 9058 the Up ask (53¢ until 9060) counts as gone and its replacement is staged. A click sent now commits at
  // 9060 or later, after the checkpoint released the old ask, so it meets the replacement: that is the ask shown.
  const four = run(apply(funded(200), mint), 9_000, 0.5).v, next = plan(four, round, 9_058, 0.53, S), at = { ...round, start: 9_000 };
  assert.deepEqual([next.side, next.outcome, next.price], ["sell", "up", 56]);
  assert.deepEqual(houseQuotes(apply(four, { ...next, id: "n" }), at, 9_058, 1).up.ask, { cents: 56, shares: 10 });
  assert.equal(houseQuotes(four, at, 9_058, 1).up.ask, null, "no replacement sent yet: nothing a click can still reach");
  assert.deepEqual(houseQuotes(four, at, 9_057, 1).up.ask, { cents: 53, shares: 10 }, "3 s before its expiry the old ask still counts");
});
