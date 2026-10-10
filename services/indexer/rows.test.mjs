// rows.mjs: endpoint logs built with viem's encoders (as eth_getLogs returns them) map to this application's rows only.
import { strict as assert } from "node:assert";
import { readFileSync } from "node:fs";
import { test } from "node:test";
import { encodeAbiParameters, encodeEventTopics, getAbiItem } from "viem";
import { endpointAbi } from "../../src/chain/orderbook-manifest.ts";
import { SUBTYPES, decodeSettle } from "../../src/chain/vault.ts";
import { hex, rows } from "./rows.mjs";

const endpoint = "0x0a2703d21b27757fdf27ab807eae9820788010f3", app = 3714533467436544392n;
const id = `0x${"11".repeat(32)}`, tx = `0x${"ab".repeat(32)}`, sender = "0x44a2f7238002cf6b16719f5e0ad6c080cf3e1419";
const words = (...n) => `0x${n.map((x) => BigInt(x).toString(16).padStart(64, "0")).join("")}`;
let next = 0;
function endpointLog(eventName, args, extra = {}) {
  const inputs = getAbiItem({ abi: endpointAbi, name: eventName }).inputs.filter((i) => !i.indexed);
  return { address: endpoint, topics: encodeEventTopics({ abi: endpointAbi, eventName, args }), data: encodeAbiParameters(inputs, inputs.map((i) => args[i.name])),
    blockNumber: "0x1aa9c25", logIndex: `0x${(next++).toString(16)}`, transactionHash: tx, blockHash: `0x${"cd".repeat(32)}`, removed: false, ...extra };
}

test("each endpoint event of this application becomes its row; other applications, addresses and events are dropped", () => {
  const round = `0x${"22".repeat(32)}`, settle = words(round, 1, 0, 83102826982247930000000n, 1791399601, 5, 1);
  const out = rows([
    endpointLog("RequestSubmitted", { applicationId: app, requestId: id, sender, facilitator: sender }),
    endpointLog("RequestCompleted", { applicationId: app, requestId: id, applicationFees: 0n, status: 1, errorCode: 7, errorMessage: "zedge: refused\0" }),
    endpointLog("UserEvent", { applicationId: app, requestId: id, eventSubType: `0x${"33".repeat(32)}`, encryptedData: "0x0102" }),
    endpointLog("AppEvent", { applicationId: app, requestId: id, eventSubType: SUBTYPES.settle, data: settle }),
    endpointLog("AppEvent", { applicationId: app, requestId: id, eventSubType: SUBTYPES.clock, data: words(1, 2, 3, 0, 0, 0, 4) }),
    endpointLog("AppEvent", { applicationId: app, requestId: id, eventSubType: `0x${"44".repeat(32)}`, data: "0x" }),
    endpointLog("RequestSubmitted", { applicationId: app + 1n, requestId: id, sender, facilitator: sender }), // another application
    endpointLog("RequestSubmitted", { applicationId: app, requestId: id, sender, facilitator: sender }, { address: `0x${"99".repeat(20)}` }), // not the endpoint
    endpointLog("Refund", { applicationId: app, requestId: id, to: sender, tokenAddress: sender, amount: 1n }), // not indexed
    { ...endpointLog("UserEvent", { applicationId: app, requestId: id, eventSubType: id, encryptedData: "0x01" }), data: "0x12" }, // malformed
  ], endpoint, app);
  assert.deepEqual(out.requests.map((r) => [hex(r.request_id), hex(r.sender), r.block, r.log_index, hex(r.tx)]), [[id, sender, 27958309, 0, tx]]);
  assert.deepEqual(out.completions.map((c) => [hex(c.request_id), c.block, c.log_index, c.status, c.error_code, c.error_message]), [[id, 27958309, 1, 1, 7, "zedge: refused"]]);
  assert.deepEqual(out.receipts.map((r) => [hex(r.request_id), hex(r.data), r.log_index]), [[id, "0x0102", 2]]);
  assert.deepEqual(out.records.map((r) => [r.kind, r.round_id && hex(r.round_id), hex(r.data)]), [
    ["settle", round, settle], ["clock", null, words(1, 2, 3, 0, 0, 0, 4)], [`0x${"44".repeat(32)}`, null, "0x"]]);
});

test("the event's settle records, the resolver's result (kind 2, source 4) and the timeout void (kind 3, source 3), keep its registry round id", () => {
  const { records } = JSON.parse(readFileSync(new URL("../../adapters/vela/guest/testdata/vectors.json", import.meta.url), "utf8"));
  const result = records.find((r) => r.name.startsWith("events:")).data, eventId = result.slice(0, 66), voided = words(eventId, 3, 3, 0, 0, 0, 3);
  const out = rows([result, voided].map((data) => endpointLog("AppEvent", { applicationId: app, requestId: id, eventSubType: SUBTYPES.settle, data })), endpoint, app);
  assert.deepEqual(out.records.map((r) => [r.kind, hex(r.round_id), hex(r.data)]), [["settle", eventId, result], ["settle", eventId, voided]]);
  assert.deepEqual(out.records.map((r) => decodeSettle(hex(r.data))).map(({ kind, outcome, price, observationsTimestamp, reportHash, source }) => [kind, outcome, price, observationsTimestamp, BigInt(reportHash), source]),
    [[2, 2, 0n, 0, 0n, 4], [3, 3, 0n, 0, 0n, 3]]);
});
