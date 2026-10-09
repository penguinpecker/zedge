// The cutover's own checks (cutover.mjs), which deploy-book.mjs also relies on. node --test adapters/vela/stack/cutover.test.mjs
import { strict as assert } from "node:assert";
import { test } from "node:test";
import { keccak256, stringToBytes } from "viem";
import { EVENT, INBOX, RAILWAY, blobInPlace, chooseDepositsFrom, codeName, depositsFromProblem, eventSpec, othersCrediting, proveDepositsFrom, resolverProblem, runtimeOf, thawProblems } from "./cutover.mjs";

test("runtimeOf fills every immutable slot with the contract's own address", () => {
  const art = { deployedBytecode: { object: `0x60${"00".repeat(32)}61${"00".repeat(32)}5b`, immutableReferences: { 7: [{ start: 1, length: 32 }, { start: 34, length: 32 }] } } };
  const at = "0x6F8500186CcB07E3c14FF7BBf1c9b5c05b8ca9A8", word = `${"0".repeat(24)}6f8500186ccb07e3c14ff7bbf1c9b5c05b8ca9a8`;
  assert.equal(runtimeOf(art, at), `0x60${word}61${word}5b`);
  assert.equal(runtimeOf({ deployedBytecode: { object: "0xAB5B", immutableReferences: {} } }, at), "0xab5b");
});

const credits = (...indexes) => indexes.map((i) => ({ index: BigInt(i) }));
const proof = (over) => ({ frozen: true, freezeBlock: 100n, lastClockBlock: 101n, credits: credits(1, 2, 3), highest: 5n, ...over });

test("N is proven only once the trigger is frozen and a tick asked after the freeze applied, from contiguous credit records", () => {
  assert.equal(proveDepositsFrom(proof()), 3n);
  assert.equal(proveDepositsFrom(proof({ credits: credits(3, 1, 2) })), 3n, "log order does not matter");
  assert.equal(proveDepositsFrom(proof({ credits: [] })), 0n);
  assert.throws(() => proveDepositsFrom(proof({ frozen: false })), /not WithdrawOnlyBookClockTrigger/);
  assert.throws(() => proveDepositsFrom(proof({ freezeBlock: undefined })), /no Upgraded event dates the freeze/);
  assert.throws(() => proveDepositsFrom(proof({ lastClockBlock: 100n })), /no tick asked after the freeze/);
  assert.throws(() => proveDepositsFrom(proof({ lastClockBlock: undefined })), /no tick asked after the freeze/);
  assert.throws(() => proveDepositsFrom(proof({ credits: credits(1, 3) })), /skip or repeat index 2/);
  assert.throws(() => proveDepositsFrom(proof({ credits: credits(1, 2, 2) })), /skip or repeat index 3/);
  assert.throws(() => proveDepositsFrom(proof({ highest: 2n })), /above the inbox's highest/);
});

test("deploy-book takes N from the proof; mainnet needs --deposits-from to repeat it; only a fork may go without a proof", () => {
  const missing = new Error("not proven");
  assert.equal(chooseDepositsFrom({ fork: false, given: 8n, proven: 8n }), 8n);
  assert.throws(() => chooseDepositsFrom({ fork: false, given: undefined, proven: 8n }), /required on mainnet/);
  assert.throws(() => chooseDepositsFrom({ fork: false, given: 7n, proven: 8n }), /is not the proven 8/);
  assert.throws(() => chooseDepositsFrom({ fork: true, given: 7n, proven: 8n }), /is not the proven 8/);
  assert.throws(() => chooseDepositsFrom({ fork: false, given: 8n, proven: missing }), /not proven/);
  assert.equal(chooseDepositsFrom({ fork: true, given: 8n, proven: missing }), 8n);
  assert.throws(() => chooseDepositsFrom({ fork: true, given: undefined, proven: missing }), /not proven/);
  assert.equal(chooseDepositsFrom({ fork: true, given: undefined, proven: 8n }), 8n);
});

test("the event parameter: the owner's times and the rules text's Keccak-256", () => {
  assert.deepEqual(EVENT, { cutoff: 1793743200, end: 1793743201, voidableAfter: 1801439999 });
  assert.equal(new Date(EVENT.cutoff * 1000).toISOString(), "2026-11-03T22:00:00.000Z");
  assert.equal(new Date(EVENT.voidableAfter * 1000).toISOString(), "2027-01-31T23:59:59.000Z");
  assert.equal(EVENT.end % 900, 1, "off the 900 s grid: no shared all-accounts limit with a BTC round");
  const rules = stringToBytes("Resolves Yes if ...\n");
  // The guest's EventTerms names and order exactly: it refuses constructor parameters that do not re-encode byte for byte.
  assert.equal(JSON.stringify(eventSpec(rules, 1791532800)),
    `{"question":"${keccak256(rules)}","start":1791532800,"cutoff":1793743200,"end":1793743201,"voidableAfter":1801439999}`);
  assert.throws(() => eventSpec(rules, EVENT.cutoff), /start before its cutoff/);
  assert.throws(() => eventSpec(rules, 0), /start before its cutoff/);
  assert.throws(() => eventSpec(new Uint8Array(), 1791532800), /rules text is empty/);
});

test("the resolver is a new dedicated wallet", () => {
  const roles = { house: "0xac8dfcbfbb5907634fe2bcea58e59e4c55441ab5", deployer: "0x279173ac297ad146bc92f877552c8c2b78334d07" };
  const fresh = "0x1111111111111111111111111111111111111111";
  assert.equal(resolverProblem(fresh, roles, 0), null);
  assert.match(resolverProblem(undefined, roles, 0), /lowercase 0x address/);
  assert.match(resolverProblem("0xAc8dfcbfbb5907634fe2bcea58e59e4c55441ab5", roles, 0), /lowercase 0x address/);
  assert.match(resolverProblem(`0x${"0".repeat(40)}`, roles, 0), /lowercase 0x address/);
  assert.match(resolverProblem(roles.house, roles, 0), /is the house/);
  assert.match(resolverProblem(fresh, roles, 1), /has sent 1 Horizen transactions/);
});

test("the guest is in the manager's artifact store only if sha256sum prints its SHA-256 for that exact path", () => {
  const sha = "ab".repeat(32), path = `${RAILWAY.blobs}/${sha}.wasm`;
  const calls = [];
  const run = (stdout, status = 0) => (cmd, args) => { calls.push([cmd, ...args]); return { status, stdout }; };
  const project = "zedge-vela-project-id";
  assert.equal(blobInPlace(sha, { project, run: run(`${sha}  ${path}\n`) }), true);
  assert.deepEqual(calls[0], ["railway", "ssh", "-p", project, "-s", RAILWAY.manager, "sha256sum", path]);
  assert.equal(blobInPlace(sha, { project, run: run(`${"cd".repeat(32)}  ${path}\n`) }), false, "another file's hash");
  assert.equal(blobInPlace(sha, { project, run: run(`${sha}  /tmp/${sha}.wasm\n`) }), false, "another path");
  assert.equal(blobInPlace(sha, { project, run: run("", 1) }), false, "missing file");
  assert.equal(blobInPlace(sha, { project, run: run(`${sha}  ${path}\n`, 1) }), false, "a failed command");
  assert.equal(blobInPlace(sha, { project, blobs: "/other", run: run(`${sha}  /other/${sha}.wasm\n`) }), true, "a confirmed SHARED_DATA_FOLDER elsewhere");
  assert.throws(() => blobInPlace(sha, { run: run(`${sha}  ${path}\n`) }), /--railway-project/);
});

test("the new application's first ticks show depositsFrom at work: nothing at or below N credited, the next index after its credits", () => {
  const c = (...xs) => xs.map((index) => ({ index: BigInt(index) }));
  assert.equal(depositsFromProblem(8n, 9n, []), null);
  assert.equal(depositsFromProblem(8n, 11n, c(10, 9)), null, "deposits that reached the inbox after the freeze, credited by the first tick");
  assert.match(depositsFromProblem(8n, 9n, c(1, 2, 3, 4, 5, 6, 7, 8)), /credited inbox index 1, at or below depositsFrom 8/, "a replay from index 1 still asks for N + 1");
  assert.match(depositsFromProblem(8n, 10n, []), /no credit record for 9/);
  assert.match(depositsFromProblem(8n, 1n, []), /asks for deposit 1, not one above depositsFrom 8/);
});

test("another application on the inbox credits deposits unless its trigger is withdraw-only (deploy-book refuses to add a second)", () => {
  const self = "0x9ca46470b05350384c31c8b236af4df638cbb30d", other = "0x243cd8d89755f73ebfbe0c6c32add4188fe0d293";
  const t = (app, trigger, over) => ({ app, trigger, inbox: INBOX.toUpperCase().replace("0X", "0x"), withdrawOnly: false, ...over });
  assert.deepEqual(othersCrediting([t(1n, self), t(2n, other, { withdrawOnly: true }), t(3n, "0x" + "0".repeat(40), { inbox: null })], self), []);
  assert.deepEqual(othersCrediting([t(1n, self), t(2n, other)], self), [`application 2 (trigger ${other})`]);
  assert.deepEqual(othersCrediting([t(4n, "0x" + "1".repeat(40), { inbox: "0x" + "2".repeat(40) })], self), [], "a trigger on another inbox credits nothing here");
});

test("a thaw is refused while another application on the inbox credits, has credited, or may still apply a payload from before its freeze", () => {
  const self = "0x9ca46470b05350384c31c8b236af4df638cbb30d", other = "0x243cd8d89755f73ebfbe0c6c32add4188fe0d293";
  const t = (over) => ({ app: 2n, trigger: other, inbox: INBOX.toLowerCase(), withdrawOnly: true, freezeBlock: 100n, lastClockBlock: 101n, credits: 0, ...over });
  const old = { app: 1n, trigger: self, inbox: INBOX.toLowerCase(), withdrawOnly: false, credits: 8 };
  assert.deepEqual(thawProblems([old, t()], self), [], "frozen, settled after its freeze, never credited: the rollback is safe");
  assert.deepEqual(thawProblems([old, t({ inbox: "0x" + "2".repeat(40), withdrawOnly: false, credits: 3, lastClockBlock: undefined })], self), [], "another inbox");
  assert.deepEqual(thawProblems([old, t({ withdrawOnly: false })], self), [`application 2 (trigger ${other}) credits deposits: freeze it first`]);
  assert.deepEqual(thawProblems([old, t({ credits: 1 })], self), ["application 2 has credited 1 deposits: forward-fix only, never thaw"]);
  assert.deepEqual(thawProblems([old, t({ lastClockBlock: 100n })], self), ["application 2 has applied no tick asked after its freeze: send it a sync"]);
  assert.deepEqual(thawProblems([old, t({ lastClockBlock: undefined })], self), ["application 2 has applied no tick asked after its freeze: send it a sync"]);
});

test("a trigger reads as withdraw-only only if its code is WithdrawOnlyBookClockTrigger's and not BookClockTrigger's", () => {
  assert.equal(codeName(true, false), "BookClockTrigger");
  assert.equal(codeName(false, true), "WithdrawOnlyBookClockTrigger");
  assert.equal(codeName(false, false), "unknown");
  assert.throws(() => codeName(true, true), /build to the same code: rebuild/, "a stale build would prove a freeze that never happened");
});
