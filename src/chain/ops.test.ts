import { strict as assert } from "node:assert";
import { test } from "node:test";
import { HOUSE_FLOOR_WEI, KEEPER_LOW_BASE_WEI, KEEPER_LOW_WEI, OPERATOR_FLOOR_WEI, opsNotices } from "./ops.ts";
const K = "0xaa6ae3c5aa0c561d67f0247835d884bb5db191d7" as const;

test("a low operator or house names its gas shortfall; a voided round names the missing price; a healthy pair says nothing", () => {
  const operator = opsNotices({ houseEth: HOUSE_FLOOR_WEI, operatorEth: 5_000_000_000_000n, keeper: null }, null);
  assert.equal(operator.operator, "Private trading paused: the operator wallet is out of gas (0.00001 ETH on Horizen). Orders cannot be processed until it is topped up.");
  assert.equal(operator.house, null);
  const house = opsNotices({ houseEth: HOUSE_FLOOR_WEI - 1n, operatorEth: OPERATOR_FLOOR_WEI, keeper: { address: K, eth: KEEPER_LOW_WEI, baseEth: KEEPER_LOW_BASE_WEI } }, null);
  assert.equal(house.house, "The house is out of gas (0.0002 ETH on Horizen) and is not quoting.");
  assert.equal(house.operator, null);
  assert.deepEqual(opsNotices({ houseEth: null, operatorEth: null, keeper: null }, null), { keeper: null, operator: null, house: null, voidCause: null });
  assert.equal(opsNotices(null, { outcome: 3, opened: false }).voidCause, "No opening price was published before the deadline.");
  assert.equal(opsNotices(null, { outcome: 3, opened: true }).voidCause, "No closing price was delivered in time.");
  assert.deepEqual(opsNotices({ houseEth: 10n ** 18n, operatorEth: 10n ** 18n, keeper: { address: K, eth: 10n ** 18n, baseEth: 10n ** 18n } }, { outcome: 1, opened: true }), { keeper: null, operator: null, house: null, voidCause: null });
  // Round #432, 2026-10-11: the keeper with 0.00002 ETH on Base refused the report publish and voided the round.
  const starved = opsNotices({ houseEth: 10n ** 18n, operatorEth: 10n ** 18n, keeper: { address: K, eth: 10n ** 18n, baseEth: 23_740_989_276_079n } }, { outcome: 3, opened: false });
  assert.equal(starved.keeper, "Settlement paused: the keeper wallet is out of gas (0.00002 ETH on Base). Price reports cannot be published until it is topped up.");
  const dry = opsNotices({ houseEth: 10n ** 18n, operatorEth: 10n ** 18n, keeper: { address: K, eth: 7_000_000_000_000n, baseEth: 10n ** 18n } }, null);
  assert.equal(dry.keeper, "Settlement paused: the keeper wallet is out of gas (0.00001 ETH on Horizen). Rounds cannot open or settle until it is topped up.");
  assert.equal(opsNotices({ houseEth: null, operatorEth: null, keeper: { address: K, eth: null, baseEth: null } }, null).keeper, null);
  assert.equal(starved.voidCause, "No opening price was published before the deadline. The keeper wallet is out of gas.");
});
