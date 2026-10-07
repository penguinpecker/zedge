import { strict as assert } from "node:assert";
import { test } from "node:test";
import { depositAmount } from "./deposit-amount.ts";

const limits = { minDeposit: "1000000", maxDeposit: "500000000" };

test("the untyped deposit is the whole wallet up to the largest deposit, with no error below the minimum", () => {
  assert.deepEqual(depositAmount("", 3_000_000n, limits), { atoms: 3_000_000n, error: "", short: false });
  assert.deepEqual(depositAmount("", 900_000_000n, limits), { atoms: 500_000_000n, error: "", short: false });
  assert.deepEqual(depositAmount("", 0n, limits), { atoms: 0n, error: "", short: true });
  assert.deepEqual(depositAmount("", 500_000n, limits), { atoms: 0n, error: "", short: true });
  assert.deepEqual(depositAmount("", null, limits), { atoms: 0n, error: "", short: false });
});

test("a typed deposit is checked for format, the limits and the wallet balance", () => {
  assert.deepEqual(depositAmount("2.5", 3_000_000n, limits), { atoms: 2_500_000n, error: "", short: false });
  assert.deepEqual(depositAmount("2", null, limits), { atoms: 2_000_000n, error: "", short: false });
  assert.equal(depositAmount("abc", 3_000_000n, limits).error, "format");
  assert.equal(depositAmount("0.5", 3_000_000n, limits).error, "range");
  assert.equal(depositAmount("4", 3_000_000n, limits).error, "range");
  assert.equal(depositAmount("501", 900_000_000n, limits).error, "range");
  assert.equal(depositAmount("4", 3_000_000n, limits).atoms, 0n);
});
