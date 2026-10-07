import { strict as assert } from "node:assert";
import { test } from "node:test";
import { askCents, clockPhase, countdownLine } from "./market-view.ts";

const house = await import(new URL("../../services/market-maker/pricing.mjs", import.meta.url).href) as {
  quotes(p: number, h: number): { up: { ask: number }; down: { ask: number } };
};
const round = { start: 900, cutoff: 1770, end: 1800 };

test("the phase follows the clock to the second at the start, the cutoff and the end", () => {
  assert.equal(clockPhase(1, round, 899.9), 1);
  assert.equal(clockPhase(1, round, 900), 2);
  assert.equal(clockPhase(3, round, 1769.9), 3);
  assert.equal(clockPhase(3, round, 1770), 4);
  assert.equal(clockPhase(3, round, 1800), 5);
  // Only time moves a phase on: no opening price stays no opening price, and a result comes from the chain alone.
  assert.equal(clockPhase(2, round, 1790), 2);
  assert.equal(clockPhase(6, round, 5000), 6);
  assert.equal(clockPhase(0, round, 1000), 0);
});

test("the countdown ticks each second and calls out the order cutoff", () => {
  const at = (now: number) => { const l = countdownLine(round, now); return [l.label, l.time, l.urgent]; };
  assert.deepEqual(at(899), ["Starts in", "00:01", false]);
  assert.deepEqual(at(1000), ["Ends in", "13:20", false]);
  assert.deepEqual(at(1001), ["Ends in", "13:19", false]);
  assert.deepEqual(at(1000.4), ["Ends in", "13:20", false]);
  assert.deepEqual(at(1739), ["Ends in", "01:01", false]);
  assert.deepEqual(at(1740), ["Orders close in 00:30", "01:00", true]);
  assert.deepEqual(at(1769), ["Orders close in 00:01", "00:31", true]);
  assert.deepEqual(at(1770), ["Orders closed · ends in", "00:30", true]);
  assert.deepEqual(at(1800), ["Ended", "00:00", false]);
  assert.equal(countdownLine(round, 1350).progress, 0.5);
  assert.equal(countdownLine(round, 2000).progress, 1);
});

test("the price estimate is the house's ask for either side", () => {
  for (let i = 0; i < 100; i++) {
    const p = i / 100 + 0.004, q = house.quotes(p, 3);
    assert.equal(askCents(p), q.up.ask, `up at ${p}`);
    assert.equal(askCents(1 - p), q.down.ask, `down at ${p}`);
  }
  assert.equal(askCents(0.57), 60);
});
