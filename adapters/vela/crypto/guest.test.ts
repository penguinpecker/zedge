import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { test } from "node:test";
import { Wallet, keccak256, toUtf8Bytes } from "ethers";
import { decrypt, encrypt, exportPublicKeyToHex, generateKeyPair, importPublicKeyFromHex } from "@horizen/vela-common-ts";
import { EvaluationSession } from "./session.ts";
import type { EvaluationDomain } from "./session.ts";
import { RECEIPT_BYTES, commandBody, commandId, encodeCommand, noticeRequestId, syncBody, syncRequestId } from "./guest.ts";
import type { EngineCommand, ReceiptBody } from "./guest.ts";

// Written by the Go adapter's own tests (go test -run TestVectors -update . in
// ../guest), which also require every string in it to be what the engine and
// the guest produce and accept. Both sides hold to the same file.
interface Vectors {
  domain: EvaluationDomain;
  epoch: string;
  accounts: Record<string, string>;
  commands: { name: string; command: EngineCommand; canonical: string }[];
  requests: { name: string; account: string; requestId: string; body: { type: string; command?: string }; plaintext: string }[];
  receipts: { name: string; account: string; requestId: string; type: string; status: string; plaintext: string }[];
}
const vectors: Vectors = JSON.parse(readFileSync(new URL("../guest/testdata/vectors.json", import.meta.url), "utf8"));
const encoder = new TextEncoder();

// Test-only wallets derived from a public label. Never fund them.
const wallet = (name: string) => new Wallet(keccak256(toUtf8Bytes(`zedge-vela-guest-vector:${name}`)));

async function open(name: string) {
  const enclave = await generateKeyPair();
  const session = new EvaluationSession(vectors.domain, vectors.accounts[name]!,
    { id: vectors.epoch, enclavePublicKey: await exportPublicKeyToHex(enclave.publicKey) });
  await session.unlock(wallet(name));
  const userPublicKey = await importPublicKeyFromHex(Buffer.from(await session.associationPayload()).toString("hex"));
  // What the executor does with a guest event: encrypt its data to the recipient's registered key.
  const seal = (plaintext: string) => encrypt(enclave.privateKey, userPublicKey, encoder.encode(plaintext));
  return { enclave, session, userPublicKey, seal };
}

test("vector accounts are the derived test wallets", () => {
  for (const name of ["alice", "bob"]) assert.equal(wallet(name).address.toLowerCase(), vectors.accounts[name]);
});

test("encoder output is the engine's canonical command, byte for byte", () => {
  assert.ok(vectors.commands.length >= 13);
  for (const vector of vectors.commands) {
    assert.equal(encodeCommand(vector.command), vector.canonical, vector.name);
    assert.equal(encodeCommand(JSON.parse(vector.canonical)), vector.canonical, `${vector.name} re-encoded`);
  }
});

test("encoder refuses what the engine would read differently", () => {
  const base = JSON.parse(vectors.commands[1]!.canonical) as EngineCommand;
  assert.equal(encodeCommand(base), vectors.commands[1]!.canonical);
  for (const change of [{ amount: 1.5 }, { amount: -1 }, { amount: 2 ** 53 }, { amount: 1e15 + 1 }, { amount: "50000000" },
    { nonce: Number.NaN }, { nonce: "2" }, { destination: 5 }, { destination: 'a"b' }, { destination: "a\\b" },
    { destination: "<b>" }, { destination: "café" }, { destination: "line\nbreak" }, { memo: "x" }, { id: undefined },
    { domain: { ...base.domain, rulesVersion: 2 ** 32 } }, { domain: { ...base.domain, extra: 1 } }, { domain: [] },
    { observation: { price: 97000 } },
    // An empty value of the wrong type is a mistake, not an absent field.
    { roundId: 0 }, { orderId: 0 }, { amount: "" }, { expiry: "" }, { round: 0 }, { round: "" }, { observation: 0 }, { observation: "" }]) {
    assert.throws(() => encodeCommand({ ...base, ...change } as unknown as EngineCommand), JSON.stringify(change));
  }
  // An unset round on cancel_all must not turn into "cancel in every round".
  const cancelAll = JSON.parse(vectors.commands.find(vector => vector.name === "cancel_all")!.canonical) as EngineCommand;
  assert.throws(() => encodeCommand({ ...cancelAll, roundId: 0 } as unknown as EngineCommand));
  // Empty values of the right type are what Go omits, and still are.
  assert.equal(encodeCommand({ ...base, roundId: "", expiry: 0 }), vectors.commands[1]!.canonical);
});

test("session.ts produces exactly the plaintext the guest accepts", async () => {
  const { enclave, session, userPublicKey } = await open("alice");
  assert.equal(vectors.requests.length, 3);
  for (const vector of vectors.requests) {
    assert.equal(vector.account, session.account);
    let body: unknown = syncBody();
    let requestId = syncRequestId(session.account);
    if (vector.body.type === "command") {
      const command = JSON.parse(vector.body.command!) as EngineCommand;
      body = commandBody(command);
      requestId = commandId(session.account, command.nonce);
      assert.equal(command.id, requestId);
    }
    assert.deepEqual(body, vector.body, vector.name);
    assert.equal(requestId, vector.requestId, vector.name);
    const ciphertext = await session.encryptCommand(requestId, body);
    const plaintext = new TextDecoder().decode(await decrypt(enclave.privateKey, userPublicKey, ciphertext));
    assert.equal(plaintext, vector.plaintext, vector.name);
  }
});

test("guest receipts pass the session's context checks", async () => {
  const alice = await open("alice");
  const bob = await open("bob");
  assert.ok(vectors.receipts.length >= 7);
  assert.ok(vectors.receipts.some(vector => vector.type === "sync" && vector.requestId === syncRequestId(vector.account)));
  assert.equal(vectors.receipts[0]!.requestId, noticeRequestId(alice.session.account, 1));
  for (const vector of vectors.receipts) {
    const [owner, other] = vector.account === alice.session.account ? [alice, bob] : [bob, alice];
    const result = await owner.session.decryptReceipt(await owner.seal(vector.plaintext), vector.requestId);
    assert.equal(result.status, "readable", vector.name);
    if (result.status !== "readable") continue;
    const body = result.envelope.body as ReceiptBody;
    assert.equal(body.type, vector.type, vector.name);
    assert.equal(body.status, vector.status, vector.name);
    assert.equal(body.status === "rejected", typeof body.reason === "string", vector.name);
    // One size for every receipt, whatever it says; and the clock it was judged at.
    assert.equal(encoder.encode(vector.plaintext).length, RECEIPT_BYTES, vector.name);
    assert.match(body.pad, /^0+$/, vector.name);
    assert.ok(body.at.tick >= 1 && body.at.timestamp >= 1_800_000_000, vector.name);
    assert.equal(typeof body.tick === "number", body.type !== "deposit", vector.name);
    // The same receipt under any other expectation is refused, never shown as empty.
    assert.equal((await owner.session.decryptReceipt(await owner.seal(vector.plaintext), `${vector.requestId}0`)).status, "context-mismatch");
    assert.equal((await other.session.decryptReceipt(await other.seal(vector.plaintext), vector.requestId)).status, "context-mismatch");
    assert.equal((await other.session.decryptReceipt(await owner.seal(vector.plaintext), vector.requestId)).status, "unreadable");
  }
});
