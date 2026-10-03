import { describe, it } from "node:test";
import assert from "node:assert/strict";
import {
  accountTotals,
  advanceState,
  availableShares,
  cancelOrder,
  claimPosition,
  emptyState,
  exchangeReducer,
  marketSnapshot,
  quoteOrder,
  roundAt,
  spotAt,
  submitOrder,
} from "./market.ts";
import type { MarketId, OrderInput } from "./market.ts";

const now = Date.UTC(2026, 9, 2, 14, 32, 18);
const input = (overrides: Partial<OrderInput> = {}): OrderInput => ({
  marketId: "btc-5m",
  roundStart: roundAt("btc-5m", now).start,
  outcome: "up",
  side: "buy",
  type: "market",
  value: 25,
  limitPrice: 50,
  ...overrides,
});

describe("paper-exchange accounting", () => {
  it("never charges more than a buy budget, including rounded fees", () => {
    for (let cents = 1; cents <= 99; cents++) {
      for (const budget of [0.01, 0.02, 0.5, 1, 10, 25.99, 940]) {
        const quote = quoteOrder(
          input({ value: budget, type: "limit", limitPrice: cents }),
          now,
        );
        assert.ok(
          quote.totalCents <= Math.floor(budget * 100),
          `exceeds budget at ${cents} cents / $${budget}`,
        );
        assert.ok(quote.feeCents >= 0);
      }
    }
  });
  it("rejects invalid amounts, negative values, and out-of-range limit prices", () => {
    for (const value of [NaN, Infinity, -1, 0])
      assert.ok(quoteOrder(input({ value }), now).error);
    for (const limitPrice of [0, 100, 40.4, NaN, Infinity])
      assert.ok(quoteOrder(input({ type: "limit", limitPrice }), now).error);
  });
  it("debits exactly the filled buy total and creates a matching position", () => {
    const state = submitOrder(emptyState(now), input(), "buy-1");
    assert.equal(state.orders[0].status, "filled");
    assert.equal(state.cashCents + state.orders[0].totalCents, 100_000);
    assert.equal(state.positions[0].quantity, state.orders[0].quantity);
    assert.equal(state.positions[0].costCents, state.orders[0].totalCents);
    assert.equal(state.orders[0].reservedCents, 0);
  });
  it("does not spend money twice for a duplicated submit id", () => {
    const state = submitOrder(emptyState(now), input(), "dedupe");
    assert.deepEqual(submitOrder(state, input(), "dedupe"), state);
  });
  it("rejects spending beyond available cash", () => {
    const state = submitOrder(
      emptyState(now),
      input({ value: 1001 }),
      "overspend",
    );
    assert.equal(state.orders.length, 0);
    assert.equal(state.cashCents, 100_000);
    assert.equal(state.notice?.kind, "error");
  });
  it("reserves limit-buy funds and releases them exactly once on cancellation", () => {
    const state = submitOrder(
      emptyState(now),
      input({ type: "limit", limitPrice: 1 }),
      "limit-buy",
    );
    assert.equal(state.orders[0].status, "open");
    assert.equal(state.cashCents + state.orders[0].reservedCents, 100_000);
    assert.equal(accountTotals(state).total, 100_000);
    const cancelled = cancelOrder(state, "limit-buy");
    assert.equal(cancelled.cashCents, 100_000);
    assert.equal(cancelled.orders[0].status, "cancelled");
    assert.equal(cancelOrder(cancelled, "limit-buy").cashCents, 100_000);
  });
  it("fills a marketable limit at the better price and returns unused reserves", () => {
    const state = submitOrder(
      emptyState(now),
      input({ type: "limit", limitPrice: 99 }),
      "marketable",
    );
    assert.equal(state.orders[0].status, "filled");
    assert.ok(state.orders[0].priceCents < 99);
    assert.equal(state.cashCents + state.orders[0].totalCents, 100_000);
    assert.equal(state.orders[0].reservedCents, 0);
  });
  it("expires limit orders at the cutoff, before considering a fill", () => {
    let state = submitOrder(
      emptyState(now),
      input({ type: "limit", limitPrice: 1 }),
      "expire",
    );
    state = advanceState(state, roundAt("btc-5m", now).end - 5000);
    assert.equal(state.orders[0].status, "expired");
    assert.equal(state.cashCents, 100_000);
    assert.equal(state.positions.length, 0);
  });
  it("rejects early, cutoff, and historical round orders", () => {
    const round = roundAt("btc-5m", now);
    for (const time of [
      round.start - 1,
      round.end - 5000,
      round.end,
      round.end + 20_000,
    ]) {
      const state = submitOrder(emptyState(time), input(), "closed");
      assert.equal(state.orders.length, 0);
      assert.equal(state.notice?.kind, "error");
    }
  });
  it("reserves sell shares and prevents an overlapping sell from overselling", () => {
    let state = submitOrder(emptyState(now), input(), "buy");
    const quantity = state.positions[0].quantity;
    state = submitOrder(
      state,
      input({ side: "sell", type: "limit", limitPrice: 99, value: quantity }),
      "sell-limit",
    );
    assert.equal(state.orders[0].status, "open");
    assert.equal(availableShares(state, "btc-5m", input().roundStart, "up"), 0);
    const rejected = submitOrder(
      state,
      input({ side: "sell", value: 1 }),
      "oversell",
    );
    assert.equal(rejected.orders.length, 2);
    assert.equal(rejected.notice?.kind, "error");
    state = cancelOrder(state, "sell-limit");
    assert.equal(
      availableShares(state, "btc-5m", input().roundStart, "up"),
      quantity,
    );
  });
  it("reduces cost basis on a partial sale and keeps balance conservation", () => {
    let state = submitOrder(emptyState(now), input(), "buy");
    const before = structuredClone(state);
    const soldQuantity = 10;
    state = submitOrder(
      state,
      input({ side: "sell", value: soldQuantity }),
      "sell",
    );
    const sell = state.orders[0];
    assert.equal(sell.status, "filled");
    assert.equal(state.cashCents, before.cashCents + sell.totalCents);
    assert.ok(
      Math.abs(
        state.positions[0].quantity -
          (before.positions[0].quantity - soldQuantity),
      ) < 0.001,
    );
    const removedCost =
      before.positions[0].costCents - state.positions[0].costCents;
    assert.equal(state.realizedCents, sell.totalCents - removedCost);
  });
  it("resolves both sides consistently, waits for finality, and pays only once", () => {
    const round = roundAt("btc-5m", now);
    let state = submitOrder(emptyState(now), input({ outcome: "up" }), "up");
    state = submitOrder(state, input({ outcome: "down" }), "down");
    const atClose = advanceState(state, round.end);
    assert.ok(atClose.positions.every((p) => p.status === "open"));
    state = advanceState(atClose, round.end + 3000);
    assert.equal(state.positions.filter((p) => p.status === "won").length, 1);
    assert.equal(state.positions.filter((p) => p.status === "lost").length, 1);
    const winner = state.positions.find((p) => p.status === "won")!;
    const loser = state.positions.find((p) => p.status === "lost")!;
    assert.equal(loser.payoutCents, 0);
    const beforeCash = state.cashCents;
    const beforeTotal = accountTotals(state).total;
    const realised = state.realizedCents;
    state = claimPosition(state, winner.id);
    assert.equal(state.cashCents, beforeCash + winner.payoutCents);
    assert.equal(accountTotals(state).total, beforeTotal);
    state = claimPosition(state, winner.id);
    assert.equal(state.cashCents, beforeCash + winner.payoutCents);
    state = advanceState(state, round.end + 5000);
    assert.equal(state.realizedCents, realised);
  });
  it("uses a single asset feed across 5m and 15m charts", () => {
    for (const asset of ["btc", "eth"]) {
      assert.equal(
        marketSnapshot(`${asset}-5m` as MarketId, now).current,
        marketSnapshot(`${asset}-15m` as MarketId, now).current,
      );
    }
    assert.equal(spotAt("BTC", now), spotAt("BTC", now));
  });
  it("validates top-ups and keeps deposits separate from trading returns", () => {
    const start = emptyState(now);
    for (const cents of [NaN, -100, 0, 1, 1.1, Infinity, 1_000_001])
      assert.equal(
        exchangeReducer(start, { type: "deposit", cents }).cashCents,
        start.cashCents,
      );
    const next = exchangeReducer(start, { type: "deposit", cents: 50_000 });
    assert.equal(next.cashCents, 150_000);
    assert.equal(next.depositedCents, 150_000);
    assert.equal(accountTotals(next).pnl, 0);
  });
  it("supports pause, accelerated time, and monotonic clocks", () => {
    const state = emptyState(now);
    assert.equal(
      exchangeReducer(
        { ...state, paused: true },
        { type: "tick", elapsed: 1000 },
      ).now,
      now,
    );
    assert.equal(
      exchangeReducer({ ...state, speed: 15 }, { type: "tick", elapsed: 1000 })
        .now,
      now + 15_000,
    );
    assert.equal(advanceState(state, now - 1000).now, now);
  });
});
