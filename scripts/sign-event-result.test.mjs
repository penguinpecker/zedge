// The resolver's tools: a new key file, the signed result round trip, the guest's own vector, and the refusals.
//   node --test scripts/sign-event-result.test.mjs
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { mkdtempSync, readFileSync, statSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { Wallet, keccak256, toUtf8Bytes, verifyTypedData } from "ethers";
import * as codec from "../adapters/vela/crypto/guest.ts";
import { checkResult, deploymentEvent, resultTypedData } from "../services/market-maker/event.mjs";
import { readKey, writeKey } from "../services/market-maker/keyfile.mjs";
import { checkKey, signResult } from "./sign-event-result.mjs";

const dir = mkdtempSync(join(tmpdir(), "zedge-resolver-"));
const node = (script, ...args) => spawnSync(process.execPath, [new URL(script, import.meta.url).pathname, ...args], { encoding: "utf8" });
const book = JSON.parse(readFileSync(new URL("../public/deployments/26514-orderbook.json", import.meta.url), "utf8"));
// An events manifest for the committed application, as the manifest writer would write it for the House event.
const eventsFor = (resolver) => ({ schemaVersion: 1, kind: "zedge-events", chainId: 26514, release: "test", application: book.application.id, deployTx: `0x${"0".repeat(64)}`,
  resolver, depositsFrom: 8, event: { rules: "/events/us-house-2026.txt", questionHash: keccak256(toUtf8Bytes("rules")), start: 1_791_500_400, cutoff: 1_793_743_200, end: 1_793_743_201, voidableAfter: 1_801_439_999 } });

test("new-key: a mode 600 key file, its address alone on stdout, never over a file", () => {
  const file = join(dir, "new", "resolver.key"), r = node("new-key.mjs", file);
  assert.equal(r.status, 0, r.stderr);
  assert.match(r.stdout, /^0x[0-9a-f]{40}\n$/);
  assert.equal(statSync(file).mode & 0o777, 0o600);
  const key = readKey(file);
  assert.equal(new Wallet(key).address.toLowerCase(), r.stdout.trim());
  assert.ok(!r.stdout.includes(key.slice(2)) && !r.stderr.includes(key.slice(2)), "the key is not printed");
  const again = node("new-key.mjs", file);
  assert.equal(again.status, 1);
  assert.match(again.stderr, /never replaced/);
  assert.equal(readKey(file), key, "the first key is kept");
});

test("sign: the result recovers to the resolver, in the format the guest takes; only yes or no", async () => {
  const file = join(dir, "resolver.key"), wallet = Wallet.createRandom(), resolver = wallet.address.toLowerCase();
  writeKey(file, wallet.privateKey);
  const events = eventsFor(resolver), event = deploymentEvent(book.application.engineConfigJson, events, codec);
  const result = await signResult(file, "Yes", book, events);
  assert.deepEqual([result.outcome, result.answer, result.round, result.applicationId, result.resolver], [1, "Yes", `0x${event.id}`, book.application.id, resolver]);
  assert.equal(verifyTypedData(...resultTypedData(event, 1, codec), result.signature).toLowerCase(), resolver);
  assert.deepEqual(codec.resolveBody(result.outcome, result.signature), { type: "resolve", outcome: 1, signature: result.signature });
  assert.equal((await signResult(file, "no", book, events)).outcome, 2);
  for (const answer of ["maybe", "", "1", "yes ", "void", "constructor"]) await assert.rejects(signResult(file, answer, book, events), /yes or no/, answer);
  await assert.rejects(signResult(file, "yes", book, eventsFor(`0x${"4".repeat(40)}`)), /not by the resolver/, "a key that is not the pinned resolver");

  // What the submit step checks before it spends a request.
  const ethers = { verifyTypedData };
  assert.equal(checkResult(result, event, { ethers, codec }), 1);
  const no = await signResult(file, "no", book, events);
  assert.throws(() => checkResult({ ...result, outcome: 2, answer: "No" }, event, { ethers, codec }), /signed by/, "Yes's signature on a No");
  assert.throws(() => checkResult({ ...no, outcome: 1 }, event, { ethers, codec }), /not a signed result/, "an outcome that does not match its answer");
  assert.throws(() => checkResult({ ...no, outcome: 3 }, event, { ethers, codec }), /not a signed result/, "a void is not a result");
  assert.throws(() => checkResult({ ...result, round: `0x${"ab".repeat(32)}` }, event, { ethers, codec }), /not a signed result/);
  assert.throws(() => checkResult({ ...result, signature: result.signature.toUpperCase() }, event, { ethers, codec }), /not a signed result/);
  assert.throws(() => checkResult({ ...result, extra: 1 }, event, { ethers, codec }), /not a signed result/);
  const other = deploymentEvent(book.application.engineConfigJson, { ...events, event: { ...events.event, start: events.event.start + 900 } }, codec);
  assert.throws(() => checkResult(result, other, { ethers, codec }), /not a signed result/, "another event of the same application");
  assert.throws(() => checkResult(result, event, { ethers, codec }, events.event.end - 1), /event's end/, "before the end the engine would refuse it");
  assert.equal(checkResult(result, event, { ethers, codec }, events.event.end), 1);
});

test("sign: the guest's own vector, byte for byte", async () => {
  const v = JSON.parse(readFileSync(new URL("../adapters/vela/guest/testdata/vectors.json", import.meta.url), "utf8")).event;
  const file = join(dir, "vector.key");
  writeKey(file, keccak256(toUtf8Bytes("zedge-vela-guest-vector:resolver"))); // the vectors' resolver key
  const events = { ...eventsFor(v.resolver), chainId: 31337, application: "17429726349691885448",
    event: { rules: "/events/test.txt", questionHash: v.event.question, start: v.event.start, cutoff: v.event.cutoff, end: v.event.end, voidableAfter: v.event.voidableAfter } };
  const result = await signResult(file, "no", { application: { engineConfigJson: v.engineConfig } }, events);
  assert.deepEqual([result.round, result.outcome, result.signature], [`0x${v.roundId}`, v.outcome, v.signature]);
});

test("--check: a test signature that recovers to the key's address; the CLI prints only that", async () => {
  const file = join(dir, "check.key"), wallet = Wallet.createRandom();
  writeKey(file, wallet.privateKey);
  assert.equal(await checkKey(file), wallet.address.toLowerCase());
  const r = node("sign-event-result.mjs", file, "--check");
  assert.equal(r.status, 0, r.stderr);
  assert.deepEqual(JSON.parse(r.stdout), { recovered: wallet.address.toLowerCase() });
  assert.ok(!r.stdout.includes(wallet.privateKey.slice(2)));
  const bad = node("sign-event-result.mjs", file, "maybe");
  assert.equal(bad.status, 1);
  assert.match(bad.stderr, /yes or no/);
});

test("the CLI: --out writes what it prints, never over a file", () => {
  const file = join(dir, "cli.key"), wallet = Wallet.createRandom(), events = join(dir, "events.json"), out = join(dir, "result.json");
  writeKey(file, wallet.privateKey);
  writeFileSync(events, JSON.stringify(eventsFor(wallet.address.toLowerCase())));
  const r = node("sign-event-result.mjs", file, "no", "--events", events, "--out", out);
  assert.equal(r.status, 0, r.stderr);
  assert.equal(readFileSync(out, "utf8"), r.stdout);
  assert.equal(JSON.parse(r.stdout).answer, "No");
  const again = node("sign-event-result.mjs", file, "yes", "--events", events, "--out", out);
  assert.equal(again.status, 1);
  assert.equal(JSON.parse(readFileSync(out, "utf8")).answer, "No", "the first result is kept");
});
