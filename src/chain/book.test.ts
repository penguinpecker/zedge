import { strict as assert } from "node:assert";
import { test } from "node:test";
import { bookLevels } from "./book.ts";

test("the book shows only the chosen outcome's levels, with cumulative USDC totals, the spread and the mid", () => {
  const house = { up: { ask: { cents: 54, shares: 10_000_000 }, bid: { cents: 52, shares: 2_500_000 } }, down: { ask: { cents: 47, shares: 1_000_000 }, bid: null } };
  const up = bookLevels(house, "up");
  assert.deepEqual(up.asks, [{ cents: 54, shares: 10_000_000, total: 5_400_000 }]);
  assert.deepEqual(up.bids, [{ cents: 52, shares: 2_500_000, total: 1_300_000 }]);
  assert.deepEqual([up.spread, up.mid, up.max], [2, 53, 5_400_000]);
  // Down's Up-side orders never appear here: the engine matches within one outcome only.
  const down = bookLevels(house, "down");
  assert.deepEqual([down.asks.length, down.bids.length, down.spread, down.mid, down.max], [1, 0, null, null, 470_000]);
  assert.deepEqual(bookLevels(null, "up"), { asks: [], bids: [], spread: null, mid: null, max: 1 });
});
