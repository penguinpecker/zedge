// node --test services/payout-signer/*.test.mjs
import assert from "node:assert/strict";
import test from "node:test";
import { decodeFunctionData, encodeAbiParameters, keccak256, parseTransaction, recoverTypedDataAddress } from "viem";
import { generatePrivateKey, privateKeyToAccount } from "viem/accounts";
import { payoutTypedData, vaultAbi } from "../../src/chain/vault.ts";
import { checkPayout, step } from "./main.mjs";

const APP = 7225536188967924955n, VAULT = "0xf07b81d96b572007c8ea500db1f8095cf0c73d29", REQ = `0x${"ab".repeat(32)}`, TX = `0x${"cd".repeat(32)}`;
const USER = "0x00000000000000000000000000000000000000aa", TO = "0x00000000000000000000000000000000000000bb";
const book = { application: { id: APP.toString(), deployBlock: 100 }, endpoint: { address: "0x0a2703d21b27757fdf27ab807eae9820788010f3" }, custody: { vault: { address: VAULT } } };
const words = (...w) => encodeAbiParameters(w.map(() => ({ type: "uint256" })), w.map(BigInt));
const payoutData = (ordinal, amount, { app = APP, kind = 1, to = TO } = {}) => words(app, ordinal, kind, USER, to, amount);
const completed = (status = 0) => [
  { eventName: "StateRootUpdate", args: { applicationId: APP, requestId: REQ } },
  { eventName: "RequestCompleted", args: { applicationId: APP, requestId: REQ, status } },
];
const ctx = (over = {}) => ({ applicationId: APP, vault: VAULT, txLogs: completed(), paid: false, paidToday: 0n, vaultBalance: 10_000_000_000n, maxPayout: 1_000_000_000n, dailyCap: 10_000_000_000n, ...over });
const log = (data, app = APP) => ({ data, args: { applicationId: app, requestId: REQ } });

test("checkPayout: only a completed, well-formed payout of this application within the vault's limits", () => {
  assert.deepEqual(checkPayout(log(payoutData(3, 5_000_000n)), ctx()).payout, { applicationId: APP, ordinal: 3n, account: USER, to: TO, amount: 5_000_000n });
  assert.equal(checkPayout(log(payoutData(3, 5n, { kind: 2 })), ctx()).kind, 2);
  const refuse = (l, c) => checkPayout(l, c).refuse;
  assert.ok(refuse(log(`${payoutData(3, 5n)}00`), ctx()), "not six words");
  assert.ok(refuse(log(payoutData(3, 5n, { app: APP + 1n })), ctx()), "another application in the data");
  assert.ok(refuse(log(payoutData(3, 5n), APP + 1n), ctx()), "another application in the topic");
  assert.ok(refuse(log(payoutData(3, 5n, { kind: 3 })), ctx()), "unknown kind");
  assert.ok(refuse(log(payoutData(3, 5n)), ctx({ txLogs: completed(1) })), "a failed request");
  assert.ok(refuse(log(payoutData(3, 5n)), ctx({ txLogs: completed().slice(1) })), "no state update");
  assert.ok(refuse(log(payoutData(3, 5n)), ctx({ txLogs: completed().map((l) => ({ ...l, args: { ...l.args, requestId: `0x${"ee".repeat(32)}` } })) })), "another request's completion");
  assert.ok(refuse(log(payoutData(3, 5n, { to: VAULT })), ctx()), "to the vault");
  assert.ok(refuse(log(payoutData(3, 5n, { to: `0x${"0".repeat(40)}` })), ctx()), "to nobody");
  assert.ok(refuse(log(payoutData(3, 0n)), ctx()), "zero amount");
  assert.equal(checkPayout(log(payoutData(3, 5n)), ctx({ paid: true })).done, "already paid");
  assert.ok(checkPayout(log(payoutData(3, 1_000_000_001n)), ctx()).wait, "above the maximum");
  assert.ok(checkPayout(log(payoutData(3, 6n)), ctx({ paidToday: 9_999_999_995n })).wait, "daily cap");
  assert.ok(checkPayout(log(payoutData(3, 6n)), ctx({ vaultBalance: 5n })).wait, "vault short");
});

function harness({ events = [], nonce = 7 } = {}) {
  const account = privateKeyToAccount(generatePrivateKey());
  const chain = { head: 120n, logs: events, receipts: new Map(), paid: new Set(), nonce: { latest: nonce, pending: nonce }, sent: [], now: 1_791_320_000_000 };
  const state = { cursor: "99", payouts: {} };
  const deps = {
    book, now: () => chain.now, log: () => {}, save: async () => { deps.saves++; }, saves: 0,
    horizen: {
      head: async () => chain.head,
      payoutLogs: async (from, to) => chain.logs.filter((l) => l.blockNumber >= from && l.blockNumber <= to),
      endpointLogs: async () => completed(),
    },
    base: {
      paid: async (app, ordinal) => chain.paid.has(`${app}:${ordinal}`), paidOnDay: async () => 0n, balance: async () => 10_000_000_000n,
      limits: async () => ({ maxPayout: 1_000_000_000n, dailyPayoutCap: 10_000_000_000n }), estimate: async () => 85_000n, baseFee: async () => 5_000_000n,
      nonce: async (tag) => chain.nonce[tag], send: async (raw) => { chain.sent.push(raw); }, receipt: async (hash) => chain.receipts.get(hash) ?? null,
    },
    sign: { typedData: (d) => account.signTypedData(d), transaction: (tx) => account.signTransaction(tx) },
  };
  return { account, chain, state, deps };
}
// As viem returns an AppEvent log: `data` is the ABI encoding of the event's `bytes data`, `args.data` the record itself.
const event = (ordinal, amount, block) => ({ data: encodeAbiParameters([{ type: "bytes" }], [payoutData(ordinal, amount)]),
  args: { applicationId: APP, requestId: REQ, data: payoutData(ordinal, amount) }, transactionHash: TX, logIndex: 0, blockNumber: block });

test("step: signs the payout the vault will accept and sends it once, one in flight, then settles it", async () => {
  const { account, chain, state, deps } = harness({ events: [event(1, 120_000_000n, 105n), event(2, 3_000_000n, 110n)] });
  const first = await step(deps, state);
  assert.equal(state.cursor, "120");
  assert.equal(chain.sent.length, 1);
  assert.deepEqual(first.map((x) => x.status), ["sent"]);
  const tx = parseTransaction(chain.sent[0]);
  assert.equal(tx.to, VAULT);
  assert.equal(tx.chainId, 8453);
  assert.equal(tx.nonce, 7);
  assert.ok(tx.gas <= 250_000n && tx.maxFeePerGas <= 100_000_000n);
  const { args: [p, signature] } = decodeFunctionData({ abi: vaultAbi, data: tx.data });
  assert.deepEqual({ ...p, account: p.account.toLowerCase(), to: p.to.toLowerCase() }, { applicationId: APP, ordinal: 1n, account: USER, to: TO, amount: 120_000_000n });
  assert.equal(await recoverTypedDataAddress({ ...payoutTypedData(book.custody, p), signature }), account.address);
  assert.equal(state.payouts[`${APP}:1`].hash, keccak256(chain.sent[0]));

  // In flight: nothing new is sent, ordinal 2 waits its turn.
  assert.deepEqual(await step(deps, state), [{ waiting: `${APP}:1` }]);
  assert.equal(chain.sent.length, 1);
  // Mined: settled as paid; then ordinal 2 goes out at the next nonce. The same events read again change nothing.
  chain.receipts.set(state.payouts[`${APP}:1`].hash, { status: "success", blockNumber: 9n });
  chain.paid.add(`${APP}:1`); chain.nonce = { latest: 8, pending: 8 };
  const third = await step(deps, state);
  assert.deepEqual(third.map((x) => x.status), ["paid", "sent"]);
  assert.equal(parseTransaction(chain.sent[1]).nonce, 8);
  state.cursor = "99";
  await step(deps, state);
  assert.equal(Object.keys(state.payouts).length, 2);
});

test("step: after a restart a journalled payout is found on chain or its same bytes are sent again, never a second signature", async () => {
  const { chain, state, deps } = harness({ events: [event(1, 5_000_000n, 105n)] });
  await step(deps, state);
  const raw = chain.sent[0], hash = state.payouts[`${APP}:1`].hash;
  const restarted = JSON.parse(JSON.stringify(state)); // what the journal file holds
  chain.now += 31_000;
  assert.deepEqual((await step(deps, restarted)).map((x) => x.status), ["rebroadcast"]);
  assert.equal(chain.sent.at(-1), raw);
  assert.equal(restarted.payouts[`${APP}:1`].hash, hash);
  // Paid meanwhile (by anyone holding the signature): settled, nothing sent.
  chain.paid.add(`${APP}:1`);
  const sends = chain.sent.length;
  assert.deepEqual((await step(deps, restarted)).map((x) => x.status), ["paid"]);
  assert.equal(chain.sent.length, sends);
});

test("step: a payout whose nonce went to another transaction is signed again at a new nonce", async () => {
  const { chain, state, deps } = harness({ events: [event(4, 5_000_000n, 105n)] });
  await step(deps, state);
  chain.nonce = { latest: 8, pending: 8 };
  const out = await step(deps, state);
  assert.deepEqual(out.map((x) => x.status), ["dropped", "sent"]);
  assert.equal(parseTransaction(chain.sent.at(-1)).nonce, 8);
});
