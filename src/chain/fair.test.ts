import { strict as assert } from "node:assert";
import { test } from "node:test";
import { buyLimit, fairUp, phi, realizedSigma, sellLimit, stakeRoom } from "./fair.ts";
import { sharesFor } from "./private/client.ts";

// The house's own rules, loaded by path: the browser copy must price exactly as the house does.
const house = await import(new URL("../../services/market-maker/pricing.mjs", import.meta.url).href) as {
  phi(x: number): number; fairUp(s: number, o: number, sigma: number, t: number): number; realizedSigma(c: number[]): number;
  quotes(p: number, h: number): { up: { bid: number; ask: number }; down: { bid: number; ask: number } };
  worstStake(view: { holdings: unknown[]; orders: unknown[] }): number;
};

test("fair value and volatility are the house's, value for value", () => {
  for (let x = -6; x <= 6; x += 0.37) assert.equal(phi(x), house.phi(x));
  for (const [spot, open, sigma, left] of [[86_100, 86_000, 0.5, 600], [85_000, 86_000, 1.5, 30], [86_000, 86_000, 0.3, 899], [90_000, 86_000, 0.8, 0], [80_000, 86_000, 0.8, -5]]) {
    assert.equal(fairUp(spot, open, sigma, left), house.fairUp(spot, open, sigma, left));
  }
  const closes = Array.from({ length: 61 }, (_, i) => 86_000 + 40 * Math.sin(i * 1.7) + i * 3);
  assert.equal(realizedSigma(closes), house.realizedSigma(closes));
  assert.throws(() => realizedSigma(closes.slice(0, 9)));
});

test("one-click limits are the house's ask plus 5¢ and its bid less 5¢, within 1–99¢", () => {
  for (let i = 2; i <= 98; i++) {
    const p = i / 100 + 0.004, q = house.quotes(p, 3);
    assert.equal(buyLimit(p), Math.min(99, q.up.ask + 5), `buy up at ${p}`);
    assert.equal(buyLimit(1 - p), Math.min(99, q.down.ask + 5), `buy down at ${p}`);
    if (q.up.bid > 1 && q.up.bid < 97) assert.equal(sellLimit(p), Math.max(1, q.up.bid - 5), `sell up at ${p}`);
  }
  // The worked example: stake 10 USDC.e at p(Up) 0.55 is a limit of 63¢ and 15.873 shares, costing at most 9.99999 USDC.e.
  assert.equal(buyLimit(0.55), 63);
  assert.equal(sharesFor(10_000_000, 63), 15_873_000);
  assert.equal(Math.floor(15_873_000 / 100) * 63, 9_999_990);
  assert.equal(buyLimit(0.97), 99);
  assert.equal(sellLimit(0.05), 1);
});

test("stake room is exactly what keeps the guest's worst stake within the limit", () => {
  const limit = 50_000_000, round = "r1";
  const views = [
    { holdings: [], orders: [] },
    { holdings: [{ roundId: round, up: 20_000_000, down: 0, reservedUp: 0, reservedDown: 0 }], orders: [] },
    { holdings: [{ roundId: round, up: 5_000_000, down: 12_000_000, reservedUp: 3_000_000, reservedDown: 0 }], orders: [{ roundId: round, outcome: "up", side: "buy", remaining: 4_000_000 }] },
    { holdings: [{ roundId: round, up: 0, down: 30_000_000, reservedUp: 0, reservedDown: 0 }, { roundId: "other", up: 49_000_000, down: 0, reservedUp: 0, reservedDown: 0 }], orders: [] },
  ];
  for (const view of views) for (const outcome of ["up", "down"] as const) {
    const room = stakeRoom(view as never, round, outcome, limit);
    assert.equal(room % 1000, 0);
    // As if the buy rested whole, which counts the same as filled: only this round's stake is the account's per-round stake.
    const after = (q: number) => house.worstStake({ holdings: view.holdings.filter((h) => h.roundId === round), orders: [...view.orders, { roundId: round, outcome, side: "buy", remaining: q }] });
    assert.ok(after(room) <= limit, `${outcome} room ${room} fits`);
    assert.ok(after(room + 1000) > limit, `${outcome} one more lot passes the limit`);
  }
});
