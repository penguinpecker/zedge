import assert from "node:assert/strict";
import { test } from "node:test";
import { Wallet } from "ethers";
import type { Signer } from "ethers";
import { decrypt, encrypt, exportPublicKeyToHex, generateKeyPair, importPublicKeyFromHex } from "@horizen/vela-common-ts";
import { EvaluationSession } from "./session.ts";
import type { EvaluationDomain, PrivateEnvelope } from "./session.ts";

const domain: EvaluationDomain = { chainId: 2651420,
  endpoint: `0x${"1".repeat(40)}`, applicationId: "1",
  applicationFingerprint: "a".repeat(64), rulesHash: "b".repeat(64), origin: "https://zedge.example" };
const encoder = new TextEncoder();
async function setup() {
  const wallet = Wallet.createRandom();
  const enclave = await generateKeyPair();
  const epoch = { id: "1", enclavePublicKey: await exportPublicKeyToHex(enclave.publicKey) };
  const session = new EvaluationSession(domain, wallet.address.toLowerCase(), epoch);
  await session.unlock(wallet);
  const association = await session.associationPayload();
  const userPublicKey = await importPublicKeyFromHex(Buffer.from(association).toString("hex"));
  const receipt: PrivateEnvelope = { version: 1, domain: session.domain, account: session.account,
    epoch: "1", requestId: "order-1", kind: "receipt", body: { status: "accepted" } };
  const seal = (body: unknown) => encrypt(enclave.privateKey, userPublicKey, encoder.encode(JSON.stringify(body)));
  return { wallet, enclave, epoch, session, association, userPublicKey, receipt, seal };
}

test("actual pinned SDK encrypts command and preserves domain; uses fresh nonce", async () => {
  const { session, enclave, userPublicKey, association } = await setup();
  assert.equal(association.length, 133);
  const first = await session.encryptCommand("order-1", { price: 55, quantity: "1000000" });
  const second = await session.encryptCommand("order-1", { price: 55, quantity: "1000000" });
  assert.notDeepEqual(first, second);
  const clear = await decrypt(enclave.privateKey, userPublicKey, first);
  const decoded = JSON.parse(new TextDecoder().decode(clear));
  assert.deepEqual(decoded.domain, domain);
  assert.equal(decoded.account, session.account);
  assert.equal(decoded.kind, "command");
  assert.equal(decoded.body.price, 55);
});

test("receipt requires exact account, epoch, request, deployment and receipt kind", async () => {
  const { session, receipt, seal } = await setup();
  assert.equal((await session.decryptReceipt(await seal(receipt), "order-1")).status, "readable");
  for (const change of [ { account: `0x${"2".repeat(40)}` }, { epoch: "2" },
    { requestId: "order-2" }, { kind: "command" }, { version: 2 }, { domain: { ...domain, applicationId: "2" } },
    { unexpected: true }, { domain: { ...domain, unexpected: true } }, { domain: { chainId: domain.chainId } } ]) {
    assert.equal((await session.decryptReceipt(await seal({ ...receipt, ...change }), "order-1")).status, "context-mismatch");
  }
  const reversed = Object.fromEntries(Object.entries(receipt.domain).reverse());
  assert.equal((await session.decryptReceipt(await seal({ ...receipt, domain: reversed }), "order-1")).status, "readable");
});

test("tampering, foreign keys and malformed receipts are unreadable, not empty", async () => {
  const { session, receipt, seal } = await setup();
  const bytes = await seal(receipt);
  bytes[bytes.length - 1] ^= 1;
  assert.equal((await session.decryptReceipt(bytes, "order-1")).status, "unreadable");
  assert.equal((await session.decryptReceipt(await seal(null), "order-1")).status, "unreadable");
  const other = await setup();
  assert.equal((await session.decryptReceipt(await other.seal(other.receipt), "order-1")).status, "unreadable");
});

test("locked account cannot encrypt or expose association material", async () => {
  const { session, receipt, seal } = await setup();
  session.lock();
  assert.equal(session.unlocked, false);
  await assert.rejects(session.encryptCommand("order-1", {}), /locked/);
  await assert.rejects(session.associationPayload(), /locked/);
  assert.equal((await session.decryptReceipt(await seal(receipt), "order-1")).status, "locked");
});

test("same domain and wallet restore keys; different epoch and origin do not", async () => {
  const { wallet, session, epoch, association } = await setup();
  session.lock(); await session.unlock(wallet);
  assert.deepEqual(await session.associationPayload(), association);
  const lowercaseWallet = { getAddress: async () => wallet.address.toLowerCase(), signMessage: wallet.signMessage.bind(wallet) } as unknown as Signer;
  await session.unlock(lowercaseWallet);
  assert.deepEqual(await session.associationPayload(), association, "Address casing must not change derived keys.");
  for (const [d, e] of [[{ ...domain, origin: "https://other.example" }, epoch], [domain, { ...epoch, id: "2" }]] as const) {
    const other = new EvaluationSession(d, session.account, e); await other.unlock(wallet);
    assert.notDeepEqual(await other.associationPayload(), association);
  }
});

test("lock during wallet signature cannot reopen session after cancellation", async () => {
  const { wallet, session } = await setup();
  const original = wallet.signMessage.bind(wallet);
  const delayed = { getAddress: () => wallet.getAddress(), signMessage: async (message: string) => {
    session.lock(); return original(message);
  } } as unknown as Signer;
  await assert.rejects(session.unlock(delayed), /locked while signing/);
  assert.equal(session.unlocked, false);
});

test("unsupported chains, malformed domains and wrong wallet are rejected", async () => {
  const { session, epoch } = await setup();
  assert.equal(new EvaluationSession({ ...domain, chainId: 26514 }, session.account, epoch).domain.chainId, 26514);
  for (const chainId of [1, 8453, 26515]) {
    assert.throws(() => new EvaluationSession({ ...domain, chainId } as unknown as EvaluationDomain, session.account, epoch), /supported networks/);
  }
  assert.throws(() => new EvaluationSession({ ...domain, origin: "https://zedge.example/path" }, session.account, epoch), /canonical/);
  assert.throws(() => new EvaluationSession({ ...domain, applicationId: "18446744073709551616" }, session.account, epoch), /domain/);
  assert.throws(() => new EvaluationSession({ ...domain, applicationId: 1 } as unknown as EvaluationDomain, session.account, epoch), /domain/);
  await assert.rejects(session.unlock(Wallet.createRandom()), /Wrong signer/);
  assert.equal(session.unlocked, false);
});

test("lock during the final account check cannot restore keys", async () => {
  const { wallet, session } = await setup();
  let reads = 0;
  const delayed = { getAddress: async () => {
    if (++reads === 2) session.lock();
    return wallet.address;
  }, signMessage: wallet.signMessage.bind(wallet) } as unknown as Signer;
  await assert.rejects(session.unlock(delayed), /locked while signing/);
  assert.equal(session.unlocked, false);
});

test("oversized command is rejected before encryption", async () => {
  const { session } = await setup();
  await assert.rejects(session.encryptCommand("order-1", "x".repeat(20_000)), /payload limit/);
});
