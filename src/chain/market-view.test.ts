import { strict as assert } from "node:assert";
import { test } from "node:test";
import { askCents, clockPhase, countdownLine, HOUSE_STALE_MS, houseFor, ORDER_MARGIN, roundResults, sidePrice, tradable, versus } from "./market-view.ts";
import { sharesFor } from "./private/client.ts";
import type { ApiRound, House, SettleRef } from "./read-api.ts";

const house = await import(new URL("../../services/market-maker/pricing.mjs", import.meta.url).href) as {
  quotes(p: number, h: number): { up: { ask: number }; down: { ask: number } };
};
const round = { start: 900, cutoff: 1770, end: 1800 };

test("the phase follows the clock to the second at the start, the close of orders and the end", () => {
  assert.equal(clockPhase(1, round, 899.9), 1);
  assert.equal(clockPhase(1, round, 900), 2);
  // Closed when the ticket stops taking orders, ORDER_MARGIN before the registry's cutoff, so the badge never says trading when Buy refuses.
  assert.equal(clockPhase(3, round, 1770 - ORDER_MARGIN - 0.1), 3);
  assert.equal(clockPhase(3, round, 1770 - ORDER_MARGIN), 4);
  assert.equal(clockPhase(3, round, 1800), 5);
  // Only time moves a phase on: no opening price stays no opening price, and a result comes from the chain alone.
  assert.equal(clockPhase(2, round, 1790), 2);
  assert.equal(clockPhase(6, round, 5000), 6);
  assert.equal(clockPhase(0, round, 1000), 0);
});

test("the countdown ticks each second and calls out the close of orders when the ticket stops, ORDER_MARGIN before the cutoff", () => {
  const at = (now: number) => { const l = countdownLine(round, now); return [l.label, l.time, l.urgent]; };
  assert.equal(ORDER_MARGIN, 15);
  assert.deepEqual(at(899), ["Starts in", "00:01", false]);
  assert.deepEqual(at(1000), ["Ends in", "13:20", false]);
  assert.deepEqual(at(1001), ["Ends in", "13:19", false]);
  assert.deepEqual(at(1000.4), ["Ends in", "13:20", false]);
  assert.deepEqual(at(1724), ["Ends in", "01:16", false]);
  assert.deepEqual(at(1725), ["Orders close in 00:30", "01:15", true]);
  assert.deepEqual(at(1754), ["Orders close in 00:01", "00:46", true]);
  // The ticket refuses orders from cutoff - ORDER_MARGIN (ChainApp.tsx Ticket): the countdown says so from that same second.
  assert.deepEqual(at(round.cutoff - ORDER_MARGIN), ["Orders closed · ends in", "00:45", true]);
  assert.deepEqual(at(1770), ["Orders closed · ends in", "00:30", true]);
  assert.deepEqual(at(1800), ["Ended", "00:00", false]);
  assert.equal(countdownLine(round, 1350).progress, 0.5);
  assert.equal(countdownLine(round, 2000).progress, 1);
});

test("a price against the opening keeps its sign below a cent: only an exact tie reads Up", () => {
  assert.ok(versus(83056.371, "83056.375")! < 0, "Down by 0.4 of a cent is Down, not -0");
  assert.ok(!(versus(83056.371, "83056.375")! >= 0));
  assert.equal(versus(83056.375, "83056.375"), 0);
  assert.equal(versus(null, "1"), null);
  assert.equal(versus(1, null), null);
});

test("the price estimate is the house's ask for either side", () => {
  for (let i = 0; i < 100; i++) {
    const p = i / 100 + 0.004, q = house.quotes(p, 3);
    assert.equal(askCents(p), q.up.ask, `up at ${p}`);
    assert.equal(askCents(1 - p), q.down.ask, `down at ${p}`);
  }
  assert.equal(askCents(0.57), 60);
});

test("the ticket trades the registry's round in its window, and before the registry records the opening the engine's confirmed one, until its cutoff", () => {
  const engine = { times: round, opening: "100.5" }, registry = (phase: number, opening: string | null = null) => ({ phase, times: round, opening });
  assert.deepEqual(tradable(registry(2), engine, 911), { ...round, opening: "100.5" }, "the engine opened at +8 s; the registry has not yet");
  assert.deepEqual(tradable(null, engine, 911), { ...round, opening: "100.5" }, "no registry read at all");
  assert.equal(tradable(registry(2), null, 911), null, "nothing confirmed: nothing to trade");
  assert.deepEqual(tradable(registry(3, "100.4"), engine, 960), { ...round, opening: "100.4" }, "once the registry has it, the registry's");
  assert.equal(tradable(registry(2), engine, 1770 - ORDER_MARGIN), null, "orders close ORDER_MARGIN before the engine's cutoff");
  assert.equal(tradable(registry(2), engine, 899), null, "not before its start");
  assert.equal(tradable(registry(7), engine, 911), null, "a registry round past opening (here voided) is never overridden");
});

test("the results strip lists the rounds that ended in the last 24 hours, oldest first, the live read's newer records over the list", () => {
  const ref = (kind: number, outcome: number, price: bigint): SettleRef => ({ kind, outcome, price, observationsTimestamp: 0, reportHash: `0x${"0".repeat(64)}`, source: 1, block: 1, txHash: `0x${"1".repeat(64)}`, logIndex: 0 });
  const r = (start: number, settle: SettleRef | null): ApiRound => ({ start, registryRoundId: `0x${"2".repeat(64)}`, open: ref(1, 0, 10n), settle });
  const now = 100 * 900 + 30;
  const listed = [r(2 * 900, ref(2, 1, 11n)), r(98 * 900, ref(2, 2, 9n)), r(99 * 900, null), r(100 * 900, null)];
  assert.deepEqual(roundResults(listed, [r(99 * 900, ref(3, 3, 0n)), r(100 * 900, null), r(101 * 900, null)], now), [
    { start: 98 * 900, outcome: "down", open: 10n, close: 9n },
    { start: 99 * 900, outcome: "void", open: 10n, close: null },
  ], "older than a day and not yet ended are left out");
  assert.deepEqual(roundResults(listed, [], now).map((x) => x.outcome), ["down", null], "no result recorded yet");
});

test("with the house's quotes for the round the ticket trades at them: the ask is the buy's limit exactly, the bid the close's; else the estimate", () => {
  const house: House = { at: 1_000_000, start: 900, up: { ask: { cents: 14, shares: 50_000_000 }, bid: { cents: 12, shares: 20_000_000 } }, down: { ask: null, bid: { cents: 84, shares: 10_000_000 } } };
  const up = sidePrice(house, 0.57, "up");
  assert.deepEqual(up, { ask: 14, buy: 14, sell: 12, est: false }, "no slack over the shown price, whatever the fair value");
  // 5 USDC at 14¢: whole lots of shares whose cost at that limit stays within the stake.
  const quantity = sharesFor(5_000_000, up.buy!);
  assert.deepEqual([quantity, Math.floor(quantity / 100) * up.buy!], [35_714_000, 4_999_960]);
  assert.deepEqual(sidePrice(house, 0.57, "down"), { ask: null, buy: null, sell: 84, est: false }, "no seller: nothing to buy, not an estimate");
  // No quotes (the read API down, stale, or of another round): the estimate and the one-click slack, marked est.
  assert.deepEqual(sidePrice(null, 0.57, "up"), { ask: 60, buy: 65, sell: 49, est: true });
  assert.deepEqual(sidePrice(null, 0.57, "down"), { ask: 46, buy: 51, sell: 35, est: true });
  assert.deepEqual(sidePrice(null, null, "up"), { ask: null, buy: null, sell: null, est: true });
  assert.equal(houseFor(house, 900, 1_000_000 + HOUSE_STALE_MS), house);
  assert.equal(houseFor(house, 900, 1_000_001 + HOUSE_STALE_MS), null, "stale: a read API that stopped answering");
  assert.equal(houseFor(house, 1800, 1_000_000), null, "another round");
  assert.equal(houseFor(house, null, 1_000_000), null, "no round open");
  assert.equal(houseFor(null, 900, 1_000_000), null);
});
