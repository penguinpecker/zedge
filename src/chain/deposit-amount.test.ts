import { strict as assert } from "node:assert";
import { test } from "node:test";
import { autoDeposit, depositAmount, sendForm, type Transfer } from "./deposit-amount.ts";

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

const me = "0x00000000000000000000000000000000000000aa", vault = "0x00000000000000000000000000000000000000bb", friend = "0x00000000000000000000000000000000000000cc";
const usd = (n: number) => BigInt(Math.round(n * 1e6));
const from = (who: string, n: number): Transfer => ({ from: who, to: me, value: usd(n) }), to = (who: string, n: number): Transfer => ({ from: me, to: who, value: usd(n) });
const auto = (history: Transfer[], balance: number) => autoDeposit(history, me, vault, usd(balance), limits);

test("the automatic deposit takes only USDC from outside the vault: payouts and refunds stay, sends spend them first", () => {
  assert.deepEqual(auto([from(friend, 25)], 25), { atoms: usd(25), held: 0n }, "a fresh deposit");
  assert.deepEqual(auto([from(friend, 0.5)], 0.5), { atoms: 0n, held: 0n }, "below the smallest deposit");
  assert.deepEqual(auto([from(friend, 600)], 600), { atoms: usd(500), held: 0n }, "capped at the largest");
  const withdrawn = [from(friend, 25), to(vault, 25), from(vault, 7)];
  assert.deepEqual(auto(withdrawn, 7), { atoms: 0n, held: usd(7) }, "a withdrawal is never swept back in");
  assert.deepEqual(auto([...withdrawn, from(friend, 3)], 10), { atoms: usd(3), held: usd(7) }, "only the new inflow");
  assert.deepEqual(auto([from(friend, 5), to(vault, 5), from(vault, 5)], 5), { atoms: 0n, held: usd(5) }, "a refund is not re-swept");
  assert.deepEqual(auto([...withdrawn, from(friend, 3), to(friend, 8)], 2), { atoms: usd(2), held: 0n }, "a send spends held first, then external");
  assert.deepEqual(auto([...withdrawn, to(friend, 5)], 2), { atoms: 0n, held: usd(2) });
  assert.deepEqual(auto([...withdrawn, from(friend, 3), to(vault, 5)], 5), { atoms: 0n, held: usd(5) }, "Move back to trading spends external first, then held");
  assert.deepEqual(auto([from(me, 4), to(me, 4), from(vault, 4)], 4), { atoms: 0n, held: usd(4) }, "a transfer to itself moves nothing");
  assert.equal(auto(withdrawn, 10), null, "the index is behind the balance: nothing is deposited");
  assert.equal(auto([...withdrawn, from(friend, 3)], 7), null, "or ahead of it");
});

test("the send form wants another Base address and 0.10 USDC to the balance, in any letter case", () => {
  const other = "0x52908400098527886E0F7030069857D2E4169EE7";
  assert.deepEqual(sendForm(` ${other} `, "1.5", usd(2), me, vault), { to: other.toLowerCase(), atoms: usd(1.5) });
  assert.deepEqual(sendForm(other, "0.1", usd(2), me, vault), { to: other.toLowerCase(), atoms: 100_000n });
  for (const [address, amount] of [["0x1234", "1"], [`0x${"0".repeat(40)}`, "1"], [vault, "1"], [me.toUpperCase().replace("0X", "0x"), "1"], [other, "0.09"], [other, "2.0000001"], [other, "2.01"], [other, "abc"]]) {
    assert.ok("error" in sendForm(address, amount, usd(2), me, vault), `${address} ${amount}`);
  }
});
