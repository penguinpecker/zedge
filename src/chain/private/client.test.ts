import { strict as assert } from "node:assert";
import { readFile } from "node:fs/promises";
import { test } from "node:test";
import { encodeAbiParameters, hexToBytes, keccak256, parseAbiParameters, recoverTypedDataAddress, toHex, type Address, type Hex, type PublicClient } from "viem";
import { generatePrivateKey, privateKeyToAccount } from "viem/accounts";
import { decrypt, encrypt, exportPublicKeyToHex, generateKeyPair, importPublicKeyFromHex } from "@horizen/vela-common-ts";
import { KEY_CHALLENGE_START, engineRound, parseOrderbookManifest, requestTypedData, signable, type VerifiedOrderbook } from "../orderbook-manifest.ts";
import { usdcPermitTypedData } from "../vault.ts";
import { KEY_CHANGED, NOT_SUBMITTED, PrivateAccount, PublicError, describeOutcome, fetchRelay, readView, relayText, sharesFor, viemChain, type Chain, type Completion, type Relay, type RelayBody, type Settled, type Signer, type Snapshot, type Submission } from "./client.ts";

const RELAYER: Address = "0x5555555555555555555555555555555555555555";
const fixture = JSON.parse(await readFile(new URL("../testdata/orderbook-configured.json", import.meta.url), "utf8"));
const encoder = new TextEncoder(), decoder = new TextDecoder();
const ROUND = 1_791_301_500;

/** The operator and the chain in one: it decrypts requests with its own enclave key, keeps each account's view, and answers with
 * encrypted receipts in the guest's shapes. The relay checks each signature as submitRequestFor would. */
async function stack(options: { relayRefuses?: (body: RelayBody) => { code: string; retryAfter?: number } | null; keyChanged?: boolean; activateAfter?: number; noReceipt?: boolean } = {}) {
  const enclave = await generateKeyPair();
  const hex = await exportPublicKeyToHex(enclave.publicKey);
  const enclaveKey = (hex.startsWith("0x") ? hex : `0x${hex}`).toLowerCase() as Hex;
  const raw = structuredClone(fixture);
  raw.authenticator.enclavePublicKey = enclaveKey;
  const book = parseOrderbookManifest(raw) as VerifiedOrderbook["manifest"];
  const keys = new Map<string, CryptoKey>(), nonces = new Map<string, bigint>(), permitNonces = new Map<string, bigint>();
  type Account = { nonce: number; cash: number; up: number; down: number; round?: string; staged?: { command: Record<string, never>; wait: number }; outcome?: unknown };
  const views = new Map<string, Account>();
  // Submissions by signature: the chain answers settle() from the calldata, whatever the relayer said.
  const submissions = new Map<string, Submission>(), completions = new Map<Hex, Completion>();
  const sent: RelayBody[] = [], log: string[] = [];
  let block = 100n, ticks = 0, time = 1_791_301_500n, sequence = 1;
  // Base and the vault: deposits by index, the guest's credits and payouts, the vault's payments.
  let baseBlock = 500n, wallet = 50_000_000n, ordinals = 0n;
  const deposits: { owner: string; amount: bigint; block: bigint; txHash: Hex }[] = [], credits = new Map<bigint, { status: number; amount: bigint }>();
  const approved = new Set<bigint>(), paid = new Map<bigint, Hex>(), settles: Settled[] = [];
  const seal = async (account: string, requestId: string, domain: unknown, body: unknown) => {
    const env = { version: 1, domain, account, epoch: "1", requestId, kind: "receipt", body };
    return encrypt(enclave.privateKey, keys.get(account)!, encoder.encode(JSON.stringify(env)));
  };
  const viewOf = (account: string) => {
    const v = views.get(account)!;
    return { account, sequence, nonce: v.nonce, cash: v.cash, reservedCash: 0, holdings: v.up || v.down ? [{ roundId: v.round ?? "r", up: v.up, down: v.down, reservedUp: 0, reservedDown: 0 }] : [], orders: [], withdrawals: [] };
  };
  // A tick activates the staged order against a house ask of 55; its result waits for the account's next request.
  const activate = (account: string, v: Account) => {
    const c = v.staged!.command as Record<string, never>;
    v.staged = undefined; v.nonce++; sequence++;
    const fills = c.side === "buy" && c.price >= 55 ? [{ orderId: c.id, role: "taker", side: "buy", roundId: c.roundId, outcome: c.outcome, price: 55, quantity: c.quantity, fee: 0 }] : [];
    if (fills.length) { v.round = c.roundId; v[c.outcome === "up" ? "up" : "down"] += c.quantity; v.cash -= Math.floor(c.quantity / 100) * 55; }
    const receipt = { sequence: 2, commandId: c.id, status: fills.length ? "filled" : c.tif === "ioc" ? "ioc_complete" : "resting", fills };
    v.outcome = { account, commandId: c.id, tick: ticks, status: "applied", ...(options.noReceipt ? {} : { receipt }) };
  };
  const at = { tick: 1, block: 1, timestamp: 1 };

  async function process(requestId: Hex, sender: string, type: number, payload: Hex): Promise<Completion> {
    const done = (status: number, errorCode: number, errorMessage: string, ciphertexts: Uint8Array[], tick: Hex | null = null): Completion =>
      ({ requestId, status, errorCode, errorMessage, txHash: keccak256(toHex(`done:${requestId}`)), block: ++block, ciphertexts, tick });
    if (type === 3) { keys.set(sender, await importPublicKeyFromHex(payload.slice(2))); views.set(sender, views.get(sender) ?? { nonce: 0, cash: 0, up: 0, down: 0 }); log.push("associate"); return done(0, 0, "", []); }
    if (!keys.has(sender)) { log.push("no key"); return done(1, 9, "no Secp521r1_PubKey found", []); }
    const v = views.get(sender)!;
    const env = JSON.parse(decoder.decode(await decrypt(enclave.privateKey, keys.get(sender)!, hexToBytes(payload))));
    assert.equal(hexToBytes(payload).length, 2076, "every request is one size");
    const tick = keccak256(toHex(`tick:${++ticks}`));
    // A collected outcome comes back once, with the account's next request of any kind (guest §9).
    const collected = v.outcome;
    v.outcome = undefined;
    const reply = async (body: Record<string, unknown>) => {
      const receipt = await seal(sender, env.requestId, env.domain, { ...body, ...(collected ? { outcome: collected } : {}), view: viewOf(sender), at, tick: ticks, pad: "" });
      // This request's own tick activates a command whose tick never came (`activateAfter`).
      if (v.staged && --v.staged.wait < 0) activate(sender, v);
      return done(0, 0, "", [receipt], tick);
    };
    if (env.body.type === "sync") {
      log.push("sync");
      return reply({ type: "sync", status: "requested" });
    }
    const c = JSON.parse(env.body.command);
    log.push(c.op);
    if (c.nonce !== v.nonce + 1) return reply({ type: "command", status: "rejected", reason: "replayed, conflicting or out-of-order nonce" });
    if (["place_order", "cancel_order", "cancel_all"].includes(c.op)) {
      v.staged = { command: c, wait: options.activateAfter ?? 0 };
      if (!options.activateAfter) completions.set(tick, { requestId: tick, status: 0, errorCode: 0, errorMessage: "", txHash: keccak256(toHex(`t:${tick}`)), block: block + 1n, ciphertexts: [], tick: null });
      return reply({ type: "command", status: "staged" });
    }
    v.nonce++; sequence++;
    if (c.op === "mint") { v.cash -= c.quantity; v.up += c.quantity; v.down += c.quantity; v.round = c.roundId; }
    // A withdrawal is a public payout the signer pays from the vault on Base.
    if (c.op === "request_withdrawal") { v.cash -= c.amount; approved.add(++ordinals); paid.set(ordinals, keccak256(toHex(`paid:${ordinals}`))); }
    return reply({ type: "command", status: "applied", receipt: { sequence: 3, commandId: c.id, status: "applied", amount: c.amount }, ...(c.op === "request_withdrawal" ? { withdrawal: Number(ordinals) } : {}) });
  }

  const chain: Chain = {
    async context(sender) {
      return { block, nonce: nonces.get(sender) ?? 0n, timestamp: time, teeSigner: book.authenticator.teeSigner, enclaveKey: options.keyChanged ? `0x04${"7".repeat(264)}` : enclaveKey };
    },
    async settle(_sender, signature, _nonce, deadline) {
      const s = submissions.get(signature.toLowerCase());
      if (s) return s;
      if (time > deadline) return "absent";
      time += 10n; // every poll reads a later block
      return "pending";
    },
    async completion(requestId) { return completions.get(requestId) ?? null; },
    async history() { return []; },
    async head() { return block; },
    async wallet() { return wallet; },
    async baseContext(owner) { return { block: baseBlock, timestamp: time, permitNonce: permitNonces.get(owner) ?? 0n, balance: wallet }; },
    async deposited(owner, fromBlock) {
      const d = deposits.findIndex((x) => x.owner === owner && x.block > fromBlock);
      return d < 0 ? null : { index: BigInt(d + 1), txHash: deposits[d].txHash };
    },
    async arrived(index) { return index <= BigInt(deposits.length); },
    async credited(index) { return credits.get(index) ?? null; },
    async approved(ordinal) { return approved.has(ordinal); },
    async paid(ordinal) { return paid.get(ordinal) ?? null; },
    async settled(ids) { return settles.filter((x) => ids.includes(x.roundId)); },
  };
  const relay: Relay = {
    async post(body) {
      sent.push(body);
      const refusal = options.relayRefuses?.(body);
      if (refusal) return { ok: false, status: 503, message: "", ...refusal };
      if (body.kind === "base-deposit") {
        // The vault's permit check: the owner's, to the vault, for this amount and deadline; then the messenger and the guest credit it.
        const permit = usdcPermitTypedData(book.custody, { owner: body.owner, value: BigInt(body.amount), nonce: permitNonces.get(body.owner) ?? 0n, deadline: BigInt(body.deadline) });
        assert.equal((await recoverTypedDataAddress({ ...permit, signature: body.permit })).toLowerCase(), body.owner, "the permit is the owner's, to the vault");
        permitNonces.set(body.owner, (permitNonces.get(body.owner) ?? 0n) + 1n);
        const txHash = keccak256(toHex(`base:${sent.length}`));
        deposits.push({ owner: body.owner, amount: BigInt(body.amount), block: ++baseBlock, txHash });
        wallet -= BigInt(body.amount);
        const v = views.get(body.owner);
        if (v) { v.cash += Number(body.amount); sequence++; }
        credits.set(BigInt(deposits.length), { status: v ? 1 : 2, amount: BigInt(body.amount) });
        log.push(`deposit ${body.amount}`);
        return { ok: true, status: 200, txHash };
      }
      const nonce = nonces.get(body.sender) ?? 0n;
      const typed = requestTypedData(book, { sender: body.sender, requestType: body.requestType as 1 | 3, payload: body.payload, tokenAddress: body.tokenAddress, assetAmount: BigInt(body.assetAmount), nonce, deadline: BigInt(body.deadline) });
      assert.equal((await recoverTypedDataAddress({ ...typed, signature: body.signature })).toLowerCase(), body.sender, "the relay recovers the sender at the on-chain nonce");
      assert.deepEqual([body.tokenAddress, body.assetAmount, body.permit], ["0x0000000000000000000000000000000000000000", "0", "0x"], "no asset rides on a request");
      nonces.set(body.sender, nonce + 1n);
      const txHash = keccak256(toHex(`tx:${sent.length}`)), requestId = keccak256(toHex(`req:${sent.length}`));
      submissions.set(body.signature.toLowerCase(), { requestId, block, txHash });
      completions.set(requestId, await process(requestId, body.sender, body.requestType, body.payload));
      return { ok: true, status: 200, txHash, requestId };
    },
  };
  /** Cash credited outside this client (a deposit made earlier); the account sees it with its next receipt. */
  const fund = (account: string, amount: number) => { views.get(account)!.cash += amount; sequence++; };
  return { book, chain, relay, sent, log, views, fund, settles, nonces, wallet: () => wallet };
}

function wallet(key = generatePrivateKey(), sign?: (m: string) => Promise<Hex>): Signer & { calls: number } {
  const account = privateKeyToAccount(key);
  const s = { address: account.address.toLowerCase() as Address, calls: 0,
    signMessage: async (message: string) => { s.calls++; return sign ? sign(message) : account.signMessage({ message }); },
    signTypedData: async (data: Parameters<typeof account.signTypedData>[0]) => { s.calls++; return account.signTypedData(data); } };
  return s as Signer & { calls: number };
}
const memory = () => { const m = new Map<string, string>(); return { get: (k: string) => m.get(k) ?? null, set: (k: string, v: string) => void m.set(k, v), m }; };
const open = (s: Awaited<ReturnType<typeof stack>>, signer: Signer, hints = memory()) => {
  const snapshots: Snapshot[] = [];
  let t = 0;
  const account = new PrivateAccount(s.book, signer, s.chain, s.relay, { hints, onChange: (x) => snapshots.push(x), now: () => (t += 1000), sleep: async () => {} });
  const phases = (action: string) => snapshots.flatMap((x) => x.actions.filter((a) => a.action === action).slice(0, 1)).map((a) => a.text).filter((text, i, all) => text !== all[i - 1]);
  return { account, snapshots, phases, hints };
};

test("unlock derives the key silently, registers it only when the chain has none, and the view arrives with the sync", async () => {
  const s = await stack(), signer = wallet();
  const { account, phases, hints } = open(s, signer);
  await account.unlock();
  assert.deepEqual(s.log, ["associate", "sync"], "request nonce 0: no request ever, so no key; no sync that can only fail");
  assert.equal(account.snapshot.registered, true);
  assert.equal(account.snapshot.view?.nonce, 0);
  assert.equal(s.sent[0].kind === "request" && (s.sent[0].payload.length - 2) / 2, 133, "ASSOCIATEKEY carries the 133-byte key, never a seed");
  const register = phases("Register key");
  assert.deepEqual([register[0], register[1], register[3], register[4]], ["Signing", "Sending", "Waiting for the operator", "Key registered"]);
  assert.match(register[2], /^Submitted · 0x[0-9a-f]{8}…$/);
  assert.ok(phases("Unlock").includes("Up to date"));
  assert.equal(hints.m.size, 1);
  // A second unlock with the same wallet derives the same key and registers nothing.
  const again = open(s, signer, hints);
  await again.account.unlock();
  assert.deepEqual(s.log.slice(2), ["sync"]);
  // An account that sent requests but has no key (a refused registration) learns it from its first sync.
  const other = wallet();
  s.nonces.set(other.address, 1n);
  await open(s, other).account.unlock();
  assert.deepEqual(s.log.slice(3), ["no key", "associate", "sync"]);
});

test("a wallet that derives a different key than before is stopped before any request, and nothing re-registers", async () => {
  const s = await stack(), key = generatePrivateKey();
  const first = open(s, wallet(key));
  await first.account.unlock();
  const sentBefore = s.sent.length;
  // The same address, but its signature of the challenge differs: a non-deterministic wallet.
  const other = open(s, wallet(key, async () => `0x${"ab".repeat(64)}1b` as Hex), first.hints);
  await assert.rejects(other.account.unlock(), (e: Error) => e instanceof PublicError && e.message === KEY_CHANGED);
  assert.equal(s.sent.length, sentBefore);
});

test("a Base deposit needs no unlock and sends nothing on Horizen; once credited, the account unlocks itself", async () => {
  const s = await stack(), signer = wallet();
  const { account } = open(s, signer);
  // This stack's engine refunds a deposit for an account it has never seen, so the deposit stops at its second stage.
  assert.equal(await account.depositFromBase(20_000_000n), "refunded");
  assert.equal(account.snapshot.actions.find((x) => x.action === "Deposit")?.stage, 2);
  assert.deepEqual(s.sent.map((x) => x.kind), ["base-deposit"]);
  // Credited to a known account that this page has not unlocked: it unlocks (one silent signature, a sync), so a buy can follow.
  const reload = open(s, signer);
  await open(s, signer).account.unlock();
  assert.equal(await reload.account.depositFromBase(20_000_000n), "credited");
  assert.deepEqual([reload.account.snapshot.unlocked, reload.account.snapshot.view?.cash], [true, 20_000_000]);
});

test("one-click deposit: a silent permit to the vault, sent by the relayer, then Sent on Base, Reached Horizen, Credited, and the new balance", async () => {
  const s = await stack(), signer = wallet();
  const { account, phases } = open(s, signer);
  await account.unlock();
  await account.depositFromBase(20_000_000n);
  const deposit = s.sent.at(-2)!;
  assert.ok(deposit.kind === "base-deposit" && deposit.owner === signer.address && deposit.amount === "20000000" && (deposit.permit.length - 2) / 2 === 65);
  const seen = phases("Deposit");
  assert.deepEqual(seen, ["Signing", "Sending", "Sent on Base", "Reaching Horizen (about 25 s)", "Reached Horizen · crediting", "Credited · 20 USDC"]);
  assert.equal(account.snapshot.actions.find((x) => x.action === "Deposit")?.stage, 3);
  assert.equal(account.snapshot.actions.find((x) => x.action === "Deposit")?.chain, 8453, "the transaction link is Base's");
  assert.equal(account.snapshot.view?.cash, 20_000_000, "the sync after the credit reads the new balance");
  assert.equal(account.snapshot.wallet, 30_000_000n);
  await assert.rejects(account.depositFromBase(999_999n), /Deposits are 1 USDC to 500 USDC/);
  await assert.rejects(account.depositFromBase(40_000_000n), /holds less than this deposit/);
  assert.equal(s.log.filter((x) => x.startsWith("deposit")).length, 1);
});

test("a book order goes Signing, Sending, Submitted, Waiting, Staged, Matching, Collecting result, then its fills", async () => {
  const s = await stack(), signer = wallet();
  const { account, phases } = open(s, signer);
  await account.unlock();
  s.fund(account.account, 20_000_000);
  const quantity = sharesFor(5_000_000, 99);
  assert.equal(quantity, 5_050_000);
  const result = await account.placeOrder({ roundStart: ROUND, outcome: "up", side: "buy", price: 99, quantity, tif: "ioc", expiry: ROUND + 870 });
  const seen = phases("Buy Up");
  assert.equal(seen[0], "Signing");
  assert.equal(seen[1], "Sending");
  assert.match(seen[2], /^Submitted · 0x/);
  assert.deepEqual(seen.slice(3), ["Waiting for the operator", "Staged", "Matching", "Collecting result", "Filled"]);
  assert.equal(result.outcome?.status, "applied");
  assert.equal(account.snapshot.view?.nonce, 1, "the next nonce comes from the view");
  const resting = await account.placeOrder({ roundStart: ROUND, outcome: "down", side: "buy", price: 10, quantity: 1_000_000, tif: "gtc", expiry: ROUND + 870 });
  assert.equal(resting.outcome?.receipt?.status, "resting");
  assert.equal(phases("Buy Down").at(-1), "Resting");
  assert.throws(() => account.placeOrder({ roundStart: ROUND, outcome: "up", side: "buy", price: 50, quantity: 1000, tif: "gtc", expiry: ROUND + 871 }), /cutoff/);
});

test("a nonce the sweep spent is re-signed once with a fresh authorization; a refusal is shown as such", async () => {
  const s = await stack(), signer = wallet();
  const { account, phases } = open(s, signer);
  await account.unlock();
  s.fund(account.account, 5_000_000);
  s.views.get(account.account)!.nonce = 3; // the settlement sweep redeemed in this account's name
  const signaturesBefore = s.sent.length;
  await account.mint(ROUND, 1_000_000);
  const mints = s.sent.slice(signaturesBefore).filter((b) => b.kind === "request");
  assert.equal(mints.length, 3, "mint, sync, mint again");
  assert.notEqual((mints[0] as { signature: Hex }).signature, (mints[2] as { signature: Hex }).signature, "a new signature, not a resend");
  assert.equal(phases("Mint").at(-1), "Applied");
  assert.equal(s.views.get(account.account)!.up, 1_000_000);
});

test("one-click withdrawal: the whole balance to this address on Base, Requested, Approved, Paid on Base", async () => {
  const s = await stack(), signer = wallet();
  const { account, phases } = open(s, signer);
  await account.unlock();
  s.fund(account.account, 5_000_000);
  await account.sync();
  await account.withdraw();
  assert.equal(phases("Withdraw").at(-1), "Applied");
  assert.deepEqual(phases("Payout"), ["Requested · 5 USDC", "Approved · paying on Base", "Paid on Base · 5 USDC"]);
  assert.equal(account.snapshot.actions.find((x) => x.action === "Payout")?.chain, 8453);
  assert.equal(s.views.get(account.account)!.cash, 0);
  await assert.rejects(account.withdraw(), /balance is empty/);
});

test("a changed operator key stops before the wallet is asked to sign anything", async () => {
  const s = await stack({ keyChanged: true }), signer = wallet();
  const { account } = open(s, signer);
  await assert.rejects(account.unlock(), /operator keys changed/);
  assert.equal(signer.calls, 1, "only the key derivation signature, no request authorization");
  assert.equal(s.sent.length, 0);
});

test("relayer refusals map to short sentences with a retry time, and nothing retries by itself", async () => {
  const s = await stack({ relayRefuses: () => ({ code: "RATE_LIMITED", retryAfter: 20 }) });
  const { account, phases } = open(s, wallet());
  await assert.rejects(account.unlock(), /Too many requests\. Try again in 20s\./);
  assert.equal(s.sent.length, 1);
  assert.equal(phases("Register key").at(-1), "Too many requests. Try again in 20s.");
  assert.equal(relayText({ code: "QUEUE_BUSY", retryAfter: 20 }), "The exchange queue is busy. Try again in 20s.");
  assert.equal(relayText({ code: "BUDGET_EXHAUSTED", retryAfter: 7200 }, Date.UTC(2026, 9, 6, 22, 0)), "ZEDGE's network-fee budget for today is used up. Try again at 00:00 UTC.");
  assert.equal(relayText({ code: "SOMETHING_NEW" }), "ZEDGE's relayer refused the request.");
});

test("the private view is read field by field; outcomes map to the drawer's words", () => {
  const view = { account: "0x1", sequence: 1, nonce: 2, cash: 3, reservedCash: 0, holdings: [{ roundId: "a", up: 1000, down: 0, reservedUp: 0, reservedDown: 0 }], withdrawals: [],
    orders: [{ id: "x", roundId: "a", outcome: "up", side: "buy", price: 55, original: 1000, remaining: 1000, filled: 0, filledNotional: 0, feePaid: 0, maxFee: 0, reservedCash: 550, sequence: 1, expiry: 5 }] };
  assert.equal(readView(view)?.orders[0].price, 55);
  assert.equal(readView(undefined), null);
  for (const bad of [{ ...view, cash: -1 }, { ...view, nonce: 1.5 }, { ...view, holdings: "x" }, { ...view, orders: [{ ...view.orders[0], price: 100 }] }, { ...view, orders: [{ ...view.orders[0], outcome: "sideways" }] }, null]) {
    assert.throws(() => readView(bad), PublicError);
  }
  const receipt = (status: string, fills: number[]) => ({ account: "a", commandId: "c", tick: 1, status: "applied" as const, receipt: { sequence: 1, status, fills: fills.map((quantity) => ({ orderId: "o", role: "taker", side: "buy", roundId: "r", outcome: "up", price: 55, quantity, fee: 0 })) } });
  assert.equal(describeOutcome(receipt("filled", [1000]), 1000).text, "Filled");
  assert.equal(describeOutcome(receipt("ioc_complete", [1000]), 2000).text, "Partly filled");
  assert.equal(describeOutcome(receipt("resting", [1000]), 2000).text, "Partly filled · rest resting");
  assert.equal(describeOutcome(receipt("resting", []), 2000).text, "Resting");
  assert.equal(describeOutcome(receipt("ioc_complete", []), 2000).text, "Not filled: nothing at this price or better");
  assert.deepEqual(describeOutcome({ account: "a", commandId: "c", tick: 1, status: "rejected", reason: "stake limit: account per round" }, 1), { phase: "refused", text: "Refused: stake limit: account per round" });
  assert.equal(sharesFor(550_000, 55), 1_000_000);
  assert.equal(sharesFor(1, 99), 0);
});

const ORDER = { roundStart: ROUND, outcome: "up" as const, side: "buy" as const, price: 60, quantity: 1_000_000, tif: "ioc" as const, expiry: ROUND + 870 };
const LOST = { ok: false as const, status: 504, code: "UNKNOWN", message: "unreadable answer" };

test("a relayer answer lost after the send is settled from the chain: the order and the deposit happen once, and nothing is signed again", async () => {
  const s = await stack(), signer = wallet();
  const { account, phases } = open(s, signer);
  await account.unlock();
  const post = s.relay.post.bind(s.relay);
  let lose: (b: RelayBody) => boolean = () => false;
  s.relay.post = async (b) => { const a = await post(b); return lose(b) ? LOST : a; };
  lose = (b) => b.kind === "base-deposit";
  await account.depositFromBase(20_000_000n);
  assert.ok(phases("Deposit").includes("Outcome unknown — checking the chain"));
  assert.equal(phases("Deposit").at(-1), "Credited · 20 USDC");
  lose = (b) => b.kind === "request" && s.log.at(-1) !== "sync";
  const signatures = s.sent.length;
  await account.placeOrder(ORDER);
  assert.equal(phases("Buy Up").at(-1), "Filled");
  assert.deepEqual([s.log.filter((x) => x === "place_order").length, s.log.filter((x) => x.startsWith("deposit")).length], [1, 1]);
  assert.equal(s.sent.length - signatures, 2, "the order and its collect sync: no second signature");
});

test("'nothing was submitted' only once the chain proves it: the signed deadline passed with the request nonce unused", async () => {
  const s = await stack(), signer = wallet();
  const { account, phases } = open(s, signer);
  await account.unlock();
  // A lost answer for a request that never went out, then a relayer that claims a send the chain never sees (a lost transaction).
  for (const answer of [LOST, { ok: true as const, status: 202, txHash: keccak256(toHex("never mined")) }]) {
    const post = s.relay.post;
    s.relay.post = async (b) => { s.sent.push(b); return answer; };
    await assert.rejects(account.mint(ROUND, 1_000_000), (e: Error) => e.message === NOT_SUBMITTED);
    s.relay.post = post;
    assert.ok(!phases("Mint").some((t) => /on chain/.test(t)), "never said to be on chain");
  }
  assert.equal(s.log.includes("mint"), false);
});

test("the relayer transport: a lost or unreadable answer is unknown, a relayer refusal is kept, a missing session sends nothing", async () => {
  const real = globalThis.fetch;
  let calls = 0;
  const answers: (() => Promise<Response>)[] = [
    async () => new Response("FUNCTION_INVOCATION_TIMEOUT", { status: 504, headers: { "content-type": "text/plain" } }),
    async () => { throw new TypeError("network"); },
    async () => Response.json({ ok: false, code: "QUEUE_BUSY", message: "", retryAfter: 20 }, { status: 503 }),
  ];
  globalThis.fetch = (async () => answers[calls++]()) as typeof fetch;
  try {
    const relay = fetchRelay("/api/relay", async () => ({}));
    const claim = { kind: "base-deposit" as const, owner: RELAYER, amount: "1000000", deadline: "1", permit: `0x${"11".repeat(65)}` as Hex };
    assert.deepEqual([(await relay.post(claim) as { code: string }).code, (await relay.post(claim) as { code: string }).code, (await relay.post(claim) as { code: string }).code], ["UNKNOWN", "UNKNOWN", "QUEUE_BUSY"]);
    const signedOut = fetchRelay("/api/relay", async () => { throw new Error("Sign in again to continue."); });
    assert.equal((await signedOut.post(claim) as { code: string }).code, "UNAUTHENTICATED");
    assert.equal(calls, 3, "nothing is posted without a session");
  } finally { globalThis.fetch = real; }
});

test("a failed read while waiting is waited out: a request on chain is never shown as failed", async () => {
  const s = await stack(), { account, phases } = open(s, wallet());
  await account.unlock();
  s.fund(account.account, 10_000_000);
  const real = s.chain.completion;
  let calls = 0;
  s.chain.completion = async (id, from) => { if (++calls <= 2) throw new Error("HTTP request failed. Status: 429"); return real(id, from); };
  await account.mint(ROUND, 1_000_000);
  assert.ok(phases("Mint").includes("Waiting (network busy)"));
  assert.equal(phases("Mint").at(-1), "Applied");
});

test("a refused first setup leaves the account locked with Set up in place; the next try registers and unlocks", async () => {
  let refuse = true;
  const s = await stack({ relayRefuses: () => refuse ? { code: "NOT_INVITED" } : null });
  const { account } = open(s, wallet());
  await assert.rejects(account.unlock(), /invite-only/);
  assert.deepEqual([account.snapshot.unlocked, account.snapshot.registered, account.snapshot.view], [false, false, null]);
  refuse = false;
  await account.unlock();
  assert.deepEqual([account.snapshot.unlocked, account.snapshot.registered, account.snapshot.view?.nonce], [true, true, 0]);
  assert.deepEqual(s.log, ["associate", "sync"]);
});

test("a book result that is not back is never shown as applied: a second collect, then the line finishes when it does come back", async () => {
  // The staging's tick was lost: the collect sync's own tick activates the order, and the next sync collects it.
  const lost = await stack({ activateAfter: 1 }), a = open(lost, wallet());
  await a.account.unlock();
  lost.fund(a.account.account, 10_000_000);
  const result = await a.account.placeOrder(ORDER);
  assert.deepEqual([a.phases("Buy Up").at(-1), result.outcome?.receipt?.status], ["Filled", "filled"]);
  assert.deepEqual(lost.log.slice(-3), ["place_order", "sync", "sync"], "collected by the second sync");
  // Still not back after two collects: the line says so, stays open, and the next request's result finishes it.
  const later = await stack({ activateAfter: 2 }), b = open(later, wallet());
  await b.account.unlock();
  later.fund(b.account.account, 10_000_000);
  assert.equal((await b.account.placeOrder(ORDER)).outcome, undefined);
  assert.equal(b.phases("Buy Up").at(-1), "Result not back yet · it comes with your next request");
  assert.equal(b.account.snapshot.actions.find((x) => x.action === "Buy Up")?.final, false);
  await b.account.sync();
  assert.equal(b.phases("Buy Up").at(-1), "Filled");
  // Without its receipt (a sweep replaced it), the fill is read from the change in the round's shares.
  const swept = await stack({ noReceipt: true }), c = open(swept, wallet());
  await c.account.unlock();
  swept.fund(c.account.account, 10_000_000);
  await c.account.placeOrder(ORDER);
  assert.equal(c.phases("Buy Up").at(-1), "Filled");
  await c.account.placeOrder({ ...ORDER, price: 10 });
  assert.equal(c.phases("Buy Up").at(-1), "Not filled: nothing at this price or better");
});

test("a result collected by another request is shown: after a reload mid-order the unlock brings the fill back", async () => {
  let refuseCollect = false;
  const s = await stack({ relayRefuses: (b) => refuseCollect && b.kind === "request" && b.payload.length > 2 ? { code: "RATE_LIMITED", retryAfter: 30 } : null });
  const signer = wallet(), hints = memory();
  const first = open(s, signer, hints);
  await first.account.unlock();
  s.fund(first.account.account, 10_000_000);
  const post = s.relay.post.bind(s.relay);
  s.relay.post = async (b) => { const a = await post(b); if (s.log.at(-1) === "place_order") refuseCollect = true; return a; };
  await assert.rejects(first.account.placeOrder(ORDER), /Too many requests/);
  first.account.lock();
  refuseCollect = false;
  s.relay.post = post;
  const second = open(s, signer, hints); // the reload: a new account object, the same key
  await second.account.unlock();
  assert.equal(second.phases("Order result").at(-1), "Filled · buy 1 up at 55¢");
});

test("an earlier attempt that turns out applied stops the automatic re-sign: one order, not two", async () => {
  const s = await stack(), signer = wallet();
  const { account, phases } = open(s, signer);
  await account.unlock();
  s.fund(account.account, 10_000_000);
  const settle = s.chain.settle;
  s.chain.settle = async () => "pending"; // this page never learns where the first order went
  await assert.rejects(account.placeOrder(ORDER), /still unknown/);
  s.chain.settle = settle;
  await account.placeOrder({ ...ORDER, price: 70 }); // the user tries again, at another price
  assert.equal(s.log.filter((x) => x === "place_order").length, 2, "the second was refused for its nonce and not signed again");
  assert.equal(s.log.at(-1), "place_order", "nor synced: the refusal itself brought the first order's result");
  assert.equal(s.views.get(account.account)!.nonce, 1);
  assert.equal(phases("Buy Up").at(-1), "Filled");
});

test("a replayed older receipt is not read: every sync shares one ID, so the view only moves forward", async () => {
  const s = await stack(), signer = wallet();
  const real = s.chain.completion.bind(s.chain);
  let first: Uint8Array[] | null = null, replay = false;
  s.chain.completion = async (id, from) => {
    const c = await real(id, from);
    if (c?.ciphertexts.length && !first) first = c.ciphertexts;
    return c && replay ? { ...c, ciphertexts: first! } : c;
  };
  const { account } = open(s, signer);
  await account.unlock();
  s.fund(account.account, 20_000_000);
  await account.sync();
  replay = true;
  await assert.rejects(account.sync(), /older record/);
  assert.equal(account.snapshot.view?.cash, 20_000_000);
});

test("opening Portfolio syncs only when something could have changed, at most once a minute", async () => {
  const s = await stack();
  let t = 0;
  const account = new PrivateAccount(s.book, wallet(), s.chain, s.relay, { hints: memory(), now: () => t, sleep: async () => {} });
  await account.unlock();
  s.fund(account.account, 5_000_000);
  const syncs = () => s.log.filter((x) => x === "sync").length, before = syncs();
  t += 120_000;
  await account.refresh();
  assert.equal(syncs(), before, "an account with no orders and no positions has nothing to refresh");
  await account.mint(ROUND, 1_000_000);
  await account.refresh();
  assert.equal(syncs(), before, "a receipt was just read");
  t += 61_000;
  await account.refresh();
  assert.equal(syncs(), before + 1);
});

test("the wallet is asked only for this book's requests, Base USDC permits to its vault up to the largest deposit, and the key challenge", async () => {
  const s = await stack(), inner = wallet();
  const guarded: Signer = { address: inner.address,
    signMessage: async (m) => { assert.ok(m.startsWith(KEY_CHALLENGE_START), "only the key challenge"); return inner.signMessage(m); },
    signTypedData: async (d) => { assert.ok(signable(s.book, d), `refused ${d.primaryType}`); return inner.signTypedData(d); } };
  const { account, phases } = open(s, guarded);
  await account.unlock();
  await account.depositFromBase(20_000_000n);
  await account.placeOrder(ORDER);
  assert.equal(phases("Buy Up").at(-1), "Filled");
  const owner = inner.address, permit = (over: Partial<{ spender: Address; value: bigint }>, domain: Record<string, unknown> = {}) => {
    const p = usdcPermitTypedData(s.book.custody, { owner, value: over.value ?? 1_000_000n, nonce: 0n, deadline: 1n });
    return { ...p, domain: { ...p.domain, ...domain }, message: { ...p.message, ...over } };
  };
  assert.equal(signable(s.book, permit({})), true);
  assert.equal(signable(s.book, permit({ spender: RELAYER })), false, "a permit to anyone else");
  assert.equal(signable(s.book, permit({ value: 500_000_001n })), false, "more than the largest deposit");
  assert.equal(signable(s.book, permit({ value: 2n ** 256n - 1n })), false, "an unlimited permit");
  assert.equal(signable(s.book, permit({}, { chainId: 26514n })), false, "the same token address on another chain");
  assert.equal(signable(s.book, permit({}, { verifyingContract: "0xdf7108f8b10f9b9ec1aba01cca057268cbf86b6c" })), false, "another token");
  const request = requestTypedData(s.book, { sender: owner, requestType: 1, payload: "0x", tokenAddress: RELAYER, assetAmount: 0n, nonce: 0n, deadline: 1n });
  assert.equal(signable(s.book, request), true);
  assert.equal(signable(s.book, { ...request, domain: { ...request.domain, verifyingContract: RELAYER } }), false, "another endpoint");
  assert.equal(signable(s.book, { ...request, domain: { ...request.domain, chainId: 1n } }), false, "another chain");
  assert.equal(signable(s.book, { ...request, primaryType: "Mail" }), false);
});

test("a held round's public result is shown once, with what it paid, and the balance is read again", async () => {
  const s = await stack();
  const t = (ROUND + 900 + 30) * 1000;
  const account = new PrivateAccount(s.book, wallet(), s.chain, s.relay, { hints: memory(), now: () => t, sleep: async () => {} });
  await account.unlock();
  s.fund(account.account, 10_000_000);
  await account.mint(ROUND, 2_000_000);
  const syncs = () => s.log.filter((x) => x === "sync").length, before = syncs();
  await account.checkResults();
  assert.equal(syncs(), before, "nothing public yet: no request");
  s.settles.push({ roundId: engineRound(s.book, ROUND).spec.registryRoundId, outcome: 2 }); // the guest names the registry round
  await account.checkResults();
  assert.equal(account.snapshot.actions.find((x) => x.action === "Round result")?.text, "Down won · 2 USDC credited");
  assert.equal(syncs(), before + 1);
  await account.checkResults();
  assert.equal(syncs(), before + 1, "shown once");
  // A failing read is said once and spaced out; a minute after the end the round gets one sync anyway; the result still shows.
  const f = await stack(), settled = f.chain.settled;
  let now = (ROUND + 900 + 20) * 1000, reads = 0, fail = true;
  f.chain.settled = async (ids, from) => { reads++; if (fail) throw new Error("HTTP request failed. Status: 429"); return settled(ids, from); };
  const b = new PrivateAccount(f.book, wallet(), f.chain, f.relay, { hints: memory(), now: () => now, sleep: async () => {} });
  await b.unlock();
  f.fund(b.account, 10_000_000);
  await b.mint(ROUND, 2_000_000);
  const bSyncs = () => f.log.filter((x) => x === "sync").length, bBefore = bSyncs(), lines = () => b.snapshot.actions.filter((x) => x.action === "Round result");
  await b.checkResults();
  await b.checkResults();
  assert.deepEqual([reads, lines().map((x) => x.text)], [1, ["Round results could not be read. Trying again."]], "the next read waits 10 s");
  now += 45_000;
  await b.checkResults();
  assert.deepEqual([reads, bSyncs(), lines().length], [2, bBefore + 1, 1], "failed again a minute after the end: one sync, still one line");
  now += 30_000; fail = false;
  f.settles.push({ roundId: engineRound(f.book, ROUND).spec.registryRoundId, outcome: 1 });
  await b.checkResults();
  assert.deepEqual([lines().map((x) => x.text), bSyncs()], [["Up won · 2 USDC credited"], bBefore + 2]);
});

test("settling from the chain: the request nonce first, then the calldata that carried the signature; 'absent' only past the deadline", async () => {
  const s = await stack();
  const mine = `0x${"ab".repeat(65)}` as Hex, theirs = `0x${"cd".repeat(65)}` as Hex, ours = keccak256(toHex("ours")), other = keccak256(toHex("other"));
  let next = 3n, timestamp = 1_000n, logs: { args: { requestId: Hex }; blockNumber: bigint; transactionHash: Hex }[] = [];
  const client = {
    getBlock: async () => ({ number: 50n, timestamp }),
    readContract: async () => next,
    getLogs: async () => logs,
    getTransaction: async ({ hash }: { hash: Hex }) => ({ input: `0x9a1b2c3d00${(hash === ours ? mine : theirs).slice(2)}00` }),
  } as unknown as PublicClient;
  const settle = () => viemChain(client, s.book, client).settle(RELAYER, mine, 3n, 1_100n, 10n);
  assert.equal(await settle(), "pending", "nonce unused, deadline ahead");
  timestamp = 1_101n;
  assert.equal(await settle(), "absent", "nonce unused in a block past the deadline: it can never be submitted");
  next = 4n; timestamp = 1_050n;
  logs = [{ args: { requestId: other }, blockNumber: 20n, transactionHash: other }];
  assert.equal(await settle(), "pending", "the nonce went to another signature; logs may lag");
  timestamp = 1_161n;
  assert.equal(await settle(), "absent");
  logs.push({ args: { requestId: ours }, blockNumber: 21n, transactionHash: ours });
  assert.deepEqual(await settle(), { requestId: ours, block: 21n, txHash: ours });
});

test("History and round results read logs in 1,000-block ranges, four at a time, and History stops at the account's first request", async () => {
  const s = await stack(), account = wallet().address;
  const head = BigInt(s.book.application.deployBlock) + 30_500n, id = (n: number) => keccak256(toHex(`req:${n}`));
  // Three requests; the second sits on the last block of its range, so its receipt lands in the next one.
  const submitted = [{ n: 1, block: head - 2_500n }, { n: 2, block: head - 1_000n }, { n: 3, block: head - 5n }];
  const receipts = [{ n: 1, block: head - 2_490n }, { n: 2, block: head - 990n }, { n: 3, block: head - 3n }];
  const roundId = engineRound(s.book, ROUND).spec.registryRoundId.toLowerCase() as Hex;
  const settle = encodeAbiParameters(parseAbiParameters("bytes32, uint256, uint256, uint256, uint256, bytes32, uint256"), [roundId, 2n, 1n, 0n, 0n, roundId, 0n]);
  let total = 3n, inFlight = 0, peak = 0;
  const asked: { event: string; from: bigint; to: bigint }[] = [];
  const client = {
    getBlockNumber: async () => head,
    readContract: async () => total,
    getLogs: async ({ event, args, fromBlock, toBlock }: { event: { name: string }; args: { requestId?: Hex[] }; fromBlock: bigint; toBlock: bigint | "latest" }) => {
      if (typeof toBlock !== "bigint" || toBlock - fromBlock + 1n > 1_000n) throw new Error("Log response size exceeded. Maximum allowed number of requested blocks is 1000");
      asked.push({ event: event.name, from: fromBlock, to: toBlock });
      peak = Math.max(peak, ++inFlight);
      await new Promise((resolve) => setTimeout(resolve, 1));
      inFlight--;
      const within = (x: { block: bigint }) => x.block >= fromBlock && x.block <= toBlock;
      if (event.name === "RequestSubmitted") return submitted.filter(within).map((x) => ({ args: { requestId: id(x.n) }, blockNumber: x.block, logIndex: 0, transactionHash: id(x.n) }));
      if (event.name === "UserEvent") return receipts.filter((x) => within(x) && args.requestId!.includes(id(x.n))).map((x) => ({ args: { requestId: id(x.n), encryptedData: toHex(x.n) }, transactionHash: keccak256(toHex(`done:${x.n}`)) }));
      return [{ args: { data: settle } }];
    },
  } as unknown as PublicClient;
  const chain = viemChain(client, s.book, client);
  const history = await chain.history(account, 0n);
  assert.deepEqual(history.map((h) => [h.requestId, h.ciphertexts.length]), [[id(1), 1], [id(2), 1], [id(3), 1]], "in chain order, each with its receipt");
  assert.ok(asked.filter((x) => x.event === "RequestSubmitted").every((x) => x.from >= head - 3_999n), "one wave of four ranges found all three requests");
  assert.ok(peak <= 4);
  // Requests to another application keep the count short of the total: the scan runs on to the deploy block, still in safe ranges.
  total = 5n; asked.length = 0; peak = 0;
  assert.equal((await chain.history(account, 0n)).length, 3);
  assert.equal(asked.filter((x) => x.event === "RequestSubmitted").at(-1)?.from, BigInt(s.book.application.deployBlock));
  assert.ok(peak <= 4);
  assert.deepEqual(await chain.settled([roundId], 0n), [{ roundId, outcome: 1 }], "the results read asks for the last 1,000 blocks, never \"latest\"");
});
