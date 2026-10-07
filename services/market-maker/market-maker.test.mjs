// Offline checks of the house market maker: pricing, the guest's stake, what it sends next, and the start guards.
//   node --test services/market-maker/market-maker.test.mjs
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";
import { SHARE, apply, fairUp, phi, plan, quotes, realizedSigma, spotCheck, worstStake } from "./pricing.mjs";
import { checkBase, checkNode, mainnetDeployment, queueFull, settingsFrom, target } from "./main.mjs";

// The public fields of a configured order-book manifest the bot reads (public/deployments/26514-orderbook.json, schema 3).
const a = (n) => `0x${String(n).repeat(40)}`;
const configured = { kind: "zedge-private-orderbook", chainId: 26514, status: "configured",
  endpoint: { address: "0x0a2703d21b27757fdf27ab807eae9820788010f3", minFeePerRequestWei: "1000000000" }, authenticator: { address: a(2), teeSigner: a(6), enclavePublicKey: `0x04${"ab".repeat(132)}` },
  trigger: { address: a(3), registry: "0x4dd4aacdb7e8d2e6d06c5af38238f3deab836744" }, custody: { vault: { address: a(7) } },
  application: { id: "42", wasmSha256: "a".repeat(64), origin: "https://zedge-markets.vercel.app", epoch: "1", house: a(5), sessionRulesHash: "b".repeat(64) } };
const S = settingsFrom({}, "mainnet", configured); // the defaults

const EMPTY = { nonce: 0, cash: 0, reservedCash: 0, holdings: [], orders: [] };
const funded = (usdc) => ({ ...EMPTY, cash: usdc * SHARE });

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

test("plan: a mint, the four quotes, rotation, a cancel on drift, the stake cap and the last two minutes", () => {
  const round = { id: "r", cutoff: 10_000 }, now = 9_000, mint = { op: "mint", roundId: "r", quantity: 40 * SHARE };
  assert.deepEqual(plan(funded(200), round, now, 0.5, S), mint);
  let v = apply(funded(200), mint);
  const sent = [];
  for (let c; (c = plan(v, round, now, 0.5, S)); v = apply(v, c)) sent.push(`${c.side} ${c.outcome} ${c.price}¢ ${c.quantity / SHARE} until ${c.expiry}`);
  assert.deepEqual(sent, ["sell up 53¢ 10 until 9180", "sell down 53¢ 10 until 9180", "buy up 47¢ 10 until 9180", "buy down 47¢ 10 until 9180"]);
  assert.equal(worstStake(v), 20 * SHARE);
  assert.equal(plan(v, round, 9_180, 0.5, S)?.op, "place_order", "expired quotes are placed again");
  assert.equal(plan(v, round, now, 0.57, S), null, "7 cents of drift keeps the quotes");
  assert.deepEqual(plan(v, round, now, 0.58, S), { op: "cancel_all", roundId: "r" });
  assert.deepEqual(plan(v, round, now, 0.42, S), { op: "cancel_all", roundId: "r" });
  assert.equal(plan(apply(funded(200), mint), round, now, null, S), null, "no quotes while pricing is refused");

  const tight = { ...S, maxStakeUsdc: 15 };
  let u = apply(funded(200), mint);
  for (let c; (c = plan(u, round, now, 0.5, tight)); u = apply(u, c));
  assert.equal(u.orders.length, 2, "the bids would take the worst stake to 20 > 15");
  assert.deepEqual(plan(funded(30), round, now, 0.5, S), { op: "mint", roundId: "r", quantity: 10 * SHARE }, "short of a full mint: only the shares one ask lacks");
  let small = funded(20); const placed = [];
  for (let c; (c = plan(small, round, now, 0.5, S)); small = apply(small, c)) placed.push(c.op === "mint" ? `mint ${c.quantity / SHARE}` : `${c.side} ${c.outcome}`);
  assert.deepEqual(placed, ["mint 10", "sell up", "sell down", "buy up", "buy down"], "20 USDC rests all four quotes");
  assert.equal(plan(funded(5), round, now, 0.5, S).side, "buy", "no cash for even one ask's shares: the asks wait, a bid goes out");
  assert.deepEqual(plan({ ...funded(7), holdings: [{ roundId: "r", up: 5_500_000, down: 0, reservedUp: 0, reservedDown: 0 }] }, round, now, 0.5, S),
    { op: "mint", roundId: "r", quantity: 4_500_000 }, "a partial-fill leftover: mint only the rest");

  const withSets = apply(funded(200), mint);
  assert.equal(plan(withSets, round, 9_870, 0.5, S).expiry, 9_940, "no quote outlives cutoff − 60");
  const resting = apply(withSets, plan(withSets, round, 9_870, 0.5, S));
  assert.equal(plan(resting, round, 9_880, 0.5, S), null, "nothing new from cutoff − 120");
  assert.deepEqual(plan(resting, round, 9_910, 0.5, S), { op: "cancel_all", roundId: "r" }, "cutoff − 90: cancel what rests");
  assert.equal(plan(resting, round, 9_940, 0.5, S), null, "all expired at cutoff − 60");
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
});

test("the queue guard: quotes and syncs wait at 5 pending requests, a cancel_all goes out until 9", () => {
  assert.deepEqual([4n, 5n].map((q) => queueFull(q, "place_order")), [false, true]);
  assert.deepEqual([6n, 8n, 9n].map((q) => queueFull(q, "cancel_all")), [false, false, true]);
  assert.equal(queueFull(5n, "sync"), true);
});
