import { strict as assert } from "node:assert";
import { readFile } from "node:fs/promises";
import { test } from "node:test";
import { encodeAbiParameters, encodeEventTopics, hexToBytes, keccak256, parseAbiParameters, recoverTypedDataAddress, toHex, type Address, type Hex, type PublicClient } from "viem";
import { generatePrivateKey, privateKeyToAccount } from "viem/accounts";
import { decrypt, encrypt, exportPublicKeyToHex, generateKeyPair, importPublicKeyFromHex } from "@horizen/vela-common-ts";
import { KEY_CHALLENGE_START, endpointAbi, engineRound, parseOrderbookManifest, requestTypedData, signable, type VerifiedOrderbook } from "../orderbook-manifest.ts";
import { usdcPermitTypedData, usdcTransferTypedData } from "../vault.ts";
import type { Transfer } from "../deposit-amount.ts";
import { HISTORY_PAGE, KEY_CHANGED, NOT_SUBMITTED, PrivateAccount, PublicError, describeOutcome, fetchRelay, indexedChain, lastResult, readView, relayText, sharesFor, viemChain, type Chain, type Completion, type Logged, type Relay, type RelayBody, type Settled, type Signer, type Snapshot, type Submission, type View } from "./client.ts";
import type { AccountPage, ApiRound, Live } from "../read-api.ts";

const RELAYER: Address = "0x5555555555555555555555555555555555555555";
const fixture = JSON.parse(await readFile(new URL("../testdata/orderbook-configured.json", import.meta.url), "utf8"));
const encoder = new TextEncoder(), decoder = new TextDecoder();
const ROUND = 1_791_301_500;

/** The operator and the chain in one: it decrypts requests with its own enclave key, keeps each account's view, and answers with
 * encrypted receipts in the guest's shapes. The relay checks each signature as submitRequestFor would. */
async function stack(options: { relayRefuses?: (body: RelayBody) => { code: string; retryAfter?: number } | null; keyChanged?: boolean; activateAfter?: number; noReceipt?: boolean; transfers?: boolean } = {}) {
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
  // `transfers`: the address's Base USDC history, as a transfer index lists it; sends by authorization nonce.
  const history: Transfer[] = [], authorizations = new Map<Hex, Hex>();
  const seal = async (account: string, requestId: string, domain: unknown, body: unknown) => {
    const env = { version: 1, domain, account, epoch: "1", requestId, kind: "receipt", body };
    return encrypt(enclave.privateKey, keys.get(account)!, encoder.encode(JSON.stringify(env)));
  };
  const viewOf = (account: string) => {
    const v = views.get(account)!;
    return { account, sequence, nonce: v.nonce, cash: v.cash, reservedCash: 0, holdings: v.up || v.down || v.round ? [{ roundId: v.round ?? "r", up: v.up, down: v.down, reservedUp: 0, reservedDown: 0 }] : [], orders: [], withdrawals: [] };
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
    async sent() { return { head: block, total: 0n }; },
    async history() { return []; },
    async head() { return block; },
    async wallet() { return wallet; },
    async baseContext(owner) { return { block: baseBlock, timestamp: time, permitNonce: permitNonces.get(owner) ?? 0n, balance: wallet }; },
    async deposited(owner, fromBlock) {
      const d = deposits.findIndex((x) => x.owner === owner && x.block > fromBlock);
      return d < 0 ? null : { index: BigInt(d + 1), txHash: deposits[d].txHash };
    },
    async transferred(_owner, nonce) { return authorizations.get(nonce) ?? null; },
    transfers: options.transfers ? async () => [...history] : undefined,
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
        history.push({ from: body.owner, to: book.custody.vault.address, value: BigInt(body.amount) });
        const v = views.get(body.owner);
        if (v) { v.cash += Number(body.amount); sequence++; }
        credits.set(BigInt(deposits.length), { status: v ? 1 : 2, amount: BigInt(body.amount) });
        log.push(`deposit ${body.amount}`);
        return { ok: true, status: 200, txHash };
      }
      if (body.kind === "base-transfer") {
        const typed = usdcTransferTypedData(book.custody, { from: body.from, to: body.to, value: BigInt(body.amount), validAfter: 0n, validBefore: BigInt(body.validBefore), nonce: body.nonce });
        assert.equal((await recoverTypedDataAddress({ ...typed, signature: body.signature })).toLowerCase(), body.from, "the transfer is the owner's");
        const txHash = keccak256(toHex(`send:${sent.length}`));
        authorizations.set(body.nonce, txHash);
        wallet -= BigInt(body.amount);
        history.push({ from: body.from, to: body.to, value: BigInt(body.amount) });
        log.push(`send ${body.amount}`);
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
  return { book, chain, relay, sent, log, views, fund, settles, nonces, history, wallet: () => wallet };
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

test("the automatic deposit takes only USDC from outside the vault, once; a send is confirmed in the wallet and read back from the chain", async () => {
  const s = await stack({ transfers: true }), signer = wallet(), friend = "0x00000000000000000000000000000000000000cc";
  // The wallet's 50 USDC: 30 from a friend, 20 a payout from the vault.
  s.history.push({ from: friend, to: signer.address, value: 30_000_000n }, { from: s.book.custody.vault.address, to: signer.address, value: 20_000_000n });
  const { account, phases } = open(s, signer);
  await account.unlock();
  await account.refreshFunds();
  await account.autoDeposit();
  await account.autoDeposit();
  assert.deepEqual(s.log.filter((x) => x.startsWith("deposit")), ["deposit 30000000"], "the payout stays on Base");
  assert.deepEqual([account.snapshot.held, account.snapshot.wallet, account.snapshot.view?.cash], [20_000_000n, 20_000_000n, 30_000_000]);
  await assert.rejects(account.sendFromBase(friend, 5_000_000n), /cannot confirm a send/, "never through the silent signature");
  const confirmed: string[] = [];
  signer.confirmTypedData = async (data, text) => { confirmed.push(text); return signer.signTypedData(data); };
  await account.sendFromBase(friend, 5_000_000n);
  assert.deepEqual(confirmed, [`Send 5 USDC on Base to ${friend.slice(0, 10)}…${friend.slice(-8)}`]);
  assert.deepEqual(phases("Send"), ["Confirm in your wallet", "Sending", "Sent on Base · 5 USDC"]);
  assert.equal(account.snapshot.actions.find((x) => x.action === "Send")?.chain, 8453);
  await account.autoDeposit();
  assert.deepEqual([s.log.filter((x) => x.startsWith("deposit")).length, account.snapshot.held], [1, 15_000_000n], "the send spent held USDC; nothing more goes in");
});

test("the automatic deposit stands aside for a deposit the user started while it read the history", async () => {
  const s = await stack({ transfers: true }), signer = wallet();
  s.history.push({ from: "0x00000000000000000000000000000000000000cc", to: signer.address, value: 30_000_000n }, { from: s.book.custody.vault.address, to: signer.address, value: 20_000_000n });
  const { account } = open(s, signer);
  await account.unlock();
  await account.refreshFunds();
  const read = s.chain.transfers!;
  let manual: Promise<unknown> | undefined;
  s.chain.transfers = async (a) => { manual ??= account.depositFromBase(5_000_000n); return read(a); };
  await account.autoDeposit();
  await manual;
  assert.deepEqual(s.log.filter((x) => x.startsWith("deposit")), ["deposit 5000000"]);
});

test("a credit whose sync fails leaves the balance marked behind until a view is read, so the ticket offers a refresh, not a second deposit", async () => {
  let refuse = false;
  const s = await stack({ relayRefuses: (body) => refuse && body.kind === "request" ? { code: "QUEUE_BUSY" } : null }), signer = wallet();
  const { account } = open(s, signer);
  await account.unlock();
  refuse = true;
  assert.equal(await account.depositFromBase(20_000_000n), "credited");
  assert.deepEqual([account.snapshot.behind, account.snapshot.view?.cash], [true, 0]);
  refuse = false;
  await account.sync();
  assert.deepEqual([account.snapshot.behind, account.snapshot.view?.cash], [false, 20_000_000]);
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

test("a book order's collect sync goes out as soon as the order is submitted, before the operator runs it: two requests, then its fills", async () => {
  const s = await stack(), signer = wallet();
  let t = 0;
  // Polls wait a real turn of the event loop, so the sync can be signed and sent while the order is waited on.
  const account = new PrivateAccount(s.book, signer, s.chain, s.relay, { hints: memory(), now: () => (t += 1000), sleep: () => new Promise((resolve) => setImmediate(resolve)) });
  await account.unlock();
  s.fund(account.account, 10_000_000);
  const before = s.sent.length, completion = s.chain.completion;
  // The operator runs nothing of this order, neither it nor its tick, until its collect sync is on chain.
  s.chain.completion = async (id, from) => s.sent.length - before < 2 ? null : completion(id, from);
  const result = await account.placeOrder(ORDER);
  assert.deepEqual([s.sent.length - before, s.log.slice(-2)], [2, ["place_order", "sync"]], "the order and its one collect sync");
  assert.equal(result.outcome?.receipt?.status, "filled");
  assert.equal(account.snapshot.actions.find((a) => a.action === "Buy Up")?.text, "Filled");
});

test("a collect sync the relayer refuses at once (IN_FLIGHT) leaves the collection to after the tick: the result still shows, one sync reaches the operator", async () => {
  let log: string[] = [], refused = 0;
  const s = await stack({ relayRefuses: () => log.at(-1) === "place_order" && refused < 1 ? (refused++, { code: "IN_FLIGHT" }) : null });
  log = s.log;
  const { account, phases } = open(s, wallet());
  await account.unlock();
  s.fund(account.account, 10_000_000);
  const before = s.sent.length;
  await account.placeOrder(ORDER);
  assert.deepEqual([refused, s.sent.length - before, s.log.slice(-2)], [1, 3, ["place_order", "sync"]], "the order, the refused sync, then one collect after the tick");
  assert.deepEqual(phases("Buy Up").slice(3), ["Waiting for the operator", "Staged", "Matching", "Collecting result", "Filled"], "the refusal never shows on the order");
});

test("a book command whose wait fails holds the queue until its collect sync is on chain: the next request never signs at that sync's nonce", async () => {
  const s = await stack(), { account } = open(s, wallet());
  await account.unlock();
  s.fund(account.account, 10_000_000);
  const post = s.relay.post.bind(s.relay), completion = s.chain.completion;
  let release!: () => void, order: Hex | undefined, held = false;
  const gate = new Promise<void>((resolve) => { release = resolve; });
  // The order goes through; its collect sync is held at the relayer; the operator fails the order in public.
  s.relay.post = async (b) => { if (order) { held = true; await gate; } const a = await post(b); order ??= a.ok ? a.requestId : undefined; return a; };
  s.chain.completion = async (id, from) => { const c = await completion(id, from); return c && id === order ? { ...c, status: 1, errorCode: 2, errorMessage: "malformed envelope" } : c; };
  let settled = false;
  const placed = account.placeOrder(ORDER).catch((e: Error) => e).finally(() => { settled = true; });
  const next = account.sync();
  // Until the collect sync reaches the relayer, then a moment more for any wrong early step (signing included) to show.
  for (let i = 0; i < 1_000 && !held; i++) await new Promise((resolve) => setTimeout(resolve, 5));
  await new Promise((resolve) => setTimeout(resolve, 50));
  assert.deepEqual([settled, s.log.at(-1)], [false, "place_order"], "neither the failure nor the next request before the sync is sent");
  release();
  assert.match((await placed as Error).message, /^Failed: malformed envelope/);
  await next;
  assert.deepEqual(s.log.slice(-3), ["place_order", "sync", "sync"], "the collect sync, then the next request at the nonce after it");
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

test("a book order whose nonce the sweep spent is re-signed from its collect sync's view, with no extra sync; History reads every receipt whatever its nonce", async () => {
  const s = await stack(), { account, phases } = open(s, wallet());
  await account.unlock();
  s.fund(account.account, 10_000_000);
  const logged: Logged[] = [], completion = s.chain.completion;
  s.chain.completion = async (id, from) => {
    const c = await completion(id, from);
    if (c?.ciphertexts.length && !logged.some((x) => x.requestId === id)) logged.push({ requestId: id, block: c.block, txHash: c.txHash, ciphertexts: c.ciphertexts });
    return c;
  };
  s.views.get(account.account)!.nonce = 40; // the settlement sweep redeemed in this account's name
  const before = s.log.length;
  await account.placeOrder(ORDER);
  assert.deepEqual(s.log.slice(before), ["place_order", "sync", "place_order", "sync"]);
  assert.equal(phases("Buy Up").at(-1), "Filled");
  // A History page that starts at the re-signed order (nonce 41, its receipt's ID): each receipt opens under its own ID.
  s.chain.sent = async () => ({ head: 1_000n, total: 2n });
  s.chain.history = async () => logged.slice(-2);
  await account.loadHistory(0n);
  assert.deepEqual(account.snapshot.history.map((h) => h.text), ["Order result · Filled", "Order staged"]);
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
  assert.deepEqual(s.log.slice(-2), ["place_order", "sync"], "nor synced again: the refusal itself brought the first order's result, and only the collect sync sent with the order followed");
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
  assert.deepEqual(account.snapshot.lastResult, { start: ROUND, outcome: 2, paid: 2_000_000 }, "kept for the market page");
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

test("a round closed before its end is no win or loss: the market page keeps no result for its emptied holding", async () => {
  const s = await stack();
  const account = new PrivateAccount(s.book, wallet(), s.chain, s.relay, { hints: memory(), now: () => (ROUND + 900 + 30) * 1000, sleep: async () => {} });
  await account.unlock();
  s.fund(account.account, 10_000_000);
  await account.mint(ROUND, 2_000_000);
  // Closed: the engine keeps the emptied holding until the round is archived.
  const v = s.views.get(account.account)!;
  v.up = 0; v.down = 0; v.cash += 2_000_000;
  await account.sync();
  assert.deepEqual(account.snapshot.view?.holdings.map((h) => h.up + h.down), [0]);
  s.settles.push({ roundId: engineRound(s.book, ROUND).spec.registryRoundId, outcome: 2 });
  await account.checkResults();
  assert.equal(account.snapshot.actions.find((x) => x.action === "Round result")?.text, "Down won · nothing to collect");
  assert.equal(account.snapshot.lastResult, null, "not 'You lost'");
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

test("settling on the relayer's transaction: it and its receipt in one batch, used only when they prove the submission", async () => {
  const s = await stack(), mine = `0x${"ab".repeat(65)}` as Hex, tx = keccak256(toHex("tx")), requestId = keccak256(toHex("req"));
  const submitted = (sender: Address) => ({ address: s.book.endpoint.address, data: encodeAbiParameters(parseAbiParameters("address"), [RELAYER]), blockNumber: 21n, logIndex: 0, transactionHash: tx,
    topics: encodeEventTopics({ abi: endpointAbi, eventName: "RequestSubmitted", args: { applicationId: BigInt(s.book.application.id), requestId, sender } }) });
  const proof = { input: `0x9a1b2c3d00${mine.slice(2)}00`, status: "success", sender: RELAYER, fromBlock: 10n, mined: true };
  let it = proof;
  const calls: string[] = [];
  const client = {
    getTransaction: async () => { calls.push("tx"); return { input: it.input }; },
    getTransactionReceipt: async () => { calls.push("receipt"); if (!it.mined) throw new Error("not found"); return { status: it.status, blockNumber: 21n, transactionHash: tx, logs: [submitted(it.sender)] }; },
    getBlock: async () => { calls.push("block"); return { number: 50n, timestamp: 1_000n }; },
    readContract: async () => { calls.push("nonce"); return 3n; },
  } as unknown as PublicClient;
  const settle = () => viemChain(client, s.book, client).settle(RELAYER, mine, 3n, 1_100n, it.fromBlock, tx);
  assert.deepEqual(await settle(), { requestId, block: 21n, txHash: tx });
  assert.deepEqual(calls, ["tx", "receipt"], "no block, nonce or log reads");
  for (const change of [{ input: "0x9a1b2c3d" }, { status: "reverted" }, { sender: `0x${"66".repeat(20)}` as Address }, { fromBlock: 22n }, { mined: false }]) {
    it = { ...proof, ...change }; calls.length = 0;
    assert.equal(await settle(), "pending", Object.keys(change)[0]);
    assert.deepEqual(calls.slice(2), ["block", "nonce"], "the nonce path decides");
  }
});

test("the Base USDC history is read both ways from Alchemy's index, page by page, once per transfer, in chain order; a bad row fails the read", async () => {
  const s = await stack(), me = wallet().address, usdc = s.book.custody.usdc.address, friend = "0x00000000000000000000000000000000000000cc";
  const row = (block: number, log: string, from: string, to: string, value: number) => ({ blockNum: toHex(block), uniqueId: `${keccak256(toHex(block))}:log:${log}`, from, to, rawContract: { value: toHex(value), address: usdc } });
  // Incoming: two pages; a transfer to itself is listed both ways. Outgoing: a deposit in the same block as an inflow, after it.
  const pages: Record<string, { transfers: unknown[]; pageKey?: string }[]> = {
    toAddress: [{ transfers: [row(10, "0", friend, me, 5), row(12, "3", friend, me, 2)], pageKey: "next" }, { transfers: [row(14, "1", me, me, 9)] }],
    fromAddress: [{ transfers: [row(12, "0x4", me, s.book.custody.vault.address, 5), row(14, "1", me, me, 9)] }],
  };
  const asked: string[] = [];
  let bad = false;
  const client = { request: async ({ method, params: [q] }: { method: string; params: [Record<string, unknown>] }) => {
    assert.equal(method, "alchemy_getAssetTransfers");
    assert.deepEqual([q.category, q.contractAddresses, q.order], [["erc20"], [usdc], "asc"]);
    const side = q.fromAddress ? "fromAddress" : "toAddress";
    asked.push(`${side}:${q.pageKey ?? ""}`);
    const page = pages[side][q.pageKey ? 1 : 0];
    return bad ? { transfers: [{ ...row(1, "0", friend, me, 1), rawContract: { value: "1.5", address: usdc } }] } : page;
  } } as unknown as PublicClient;
  const chain = viemChain(client, s.book, client, { assetTransfers: client });
  assert.deepEqual(await chain.transfers!(me), [
    { from: friend, to: me, value: 5n }, { from: friend, to: me, value: 2n }, { from: me, to: s.book.custody.vault.address, value: 5n }, { from: me, to: me, value: 9n }]);
  assert.deepEqual(asked, ["fromAddress:", "toAddress:", "toAddress:next"]);
  bad = true;
  await assert.rejects(chain.transfers!(me), /Unreadable transfer history/);
  assert.equal(viemChain(client, s.book, client).transfers, undefined, "no index: no automatic deposits");
});

test("History reads 1,000-block ranges at most five a second, stops at the account's first request, and can be stopped", async () => {
  const s = await stack(), account = wallet().address;
  const head = BigInt(s.book.application.deployBlock) + 30_500n, id = (n: number) => keccak256(toHex(`req:${n}`));
  // Three requests; the second sits on the last block of its range, so its receipt lands in the next one.
  const submitted = [{ n: 1, block: head - 2_500n }, { n: 2, block: head - 1_000n }, { n: 3, block: head - 5n }];
  const receipts = [{ n: 1, block: head - 2_490n }, { n: 2, block: head - 990n }, { n: 3, block: head - 3n }];
  const roundId = engineRound(s.book, ROUND).spec.registryRoundId.toLowerCase() as Hex;
  const settle = encodeAbiParameters(parseAbiParameters("bytes32, uint256, uint256, uint256, uint256, bytes32, uint256"), [roundId, 2n, 1n, 0n, 0n, roundId, 0n]);
  let inFlight = 0, peak = 0;
  const asked: { event: string; from: bigint; to: bigint }[] = [], waits: number[] = [];
  const client = {
    getBlockNumber: async () => head,
    readContract: async () => 3n,
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
  // Each wave waits out the rest of its second before the next one starts.
  const chain = viemChain(client, s.book, client, { sleep: async (ms) => { waits.push(ms); } });
  assert.deepEqual(await chain.sent(account), { head, total: 3n });
  const range = { from: head - 21_599n, to: head, head };
  const history = await chain.history(account, { ...range, want: 3n });
  assert.deepEqual(history.map((h) => [h.requestId, h.ciphertexts.length]), [[id(1), 1], [id(2), 1], [id(3), 1]], "in chain order, each with its receipt");
  assert.deepEqual(asked.filter((x) => x.event === "RequestSubmitted").map((x) => x.to), [head, head - 1_000n, head - 2_000n, head - 3_000n, head - 4_000n], "one wave of five ranges found all three requests");
  assert.ok(peak <= 5);
  // Requests to another application keep the count short: the scan runs on to the bottom of the range, five reads a wave.
  asked.length = 0; peak = 0; waits.length = 0;
  assert.equal((await chain.history(account, { ...range, want: 5n })).length, 3);
  const scanned = asked.filter((x) => x.event === "RequestSubmitted");
  assert.equal(scanned.length, 22);
  assert.equal(scanned.at(-1)?.from, range.from);
  assert.ok(peak <= 5 && waits.length >= 4 && waits.every((ms) => ms > 0 && ms <= 1_000), "22 ranges in waves of at most five, a second apart");
  // Closing the page stops the scan between waves.
  asked.length = 0;
  let waves = 0;
  await assert.rejects(chain.history(account, { ...range, want: 5n }, () => ++waves > 2));
  assert.equal(asked.length, 10, "two waves, then it stopped");
  assert.deepEqual(await chain.settled([roundId], 0n), [{ roundId, outcome: 1 }], "the results read asks for the last 1,000 blocks, never \"latest\"");
});

test("History opens on its latest page, a reopen reads only the blocks since, and Load older reads the page before", async () => {
  const s = await stack(), signer = wallet();
  let head = 1_000_000n, total = 2n;
  const ranges: { from: bigint; to: bigint; want: bigint }[] = [];
  const req = (n: number, block: bigint) => ({ requestId: keccak256(toHex(`h:${n}`)), block, txHash: keccak256(toHex(`h:${n}`)), ciphertexts: [] });
  s.chain.sent = async () => ({ head, total });
  s.chain.history = async (_account, { from, to, want }) => { ranges.push({ from, to, want }); return from <= 990_000n && 990_000n <= to ? [req(1, 990_000n)] : []; };
  const { account } = open(s, signer);
  const floor = head - 604_800n;
  await account.loadHistory(floor);
  assert.deepEqual(ranges, [{ from: head - HISTORY_PAGE + 1n, to: head, want: 2n }], "the latest six hours first");
  assert.deepEqual([account.snapshot.history.length, account.snapshot.historyMore, account.snapshot.historyHours], [1, true, 6]);
  // Reopened a minute later with no new request: nothing is scanned. One new request: only the new blocks.
  head += 60n;
  await account.loadHistory(floor);
  assert.equal(ranges.length, 1);
  head += 60n; total = 3n;
  await account.loadHistory(floor);
  assert.deepEqual(ranges.at(-1), { from: head - 59n, to: head, want: 1n });
  // Load older: the page below, looking for the one request not found yet.
  await account.loadHistory(floor, true);
  assert.deepEqual(ranges.at(-1), { from: 1_000_000n - 2n * HISTORY_PAGE + 1n, to: 1_000_000n - HISTORY_PAGE, want: 2n });
  assert.equal(account.snapshot.historyHours, 12);
  // A read stopped by the page closing changes nothing.
  await account.loadHistory(floor, true, () => true);
  assert.equal(account.snapshot.historyHours, 12);
});

/** Every completion with a receipt that the account reads, in chain order, as the read API would index it. */
function recording(s: Awaited<ReturnType<typeof stack>>) {
  const logged: Logged[] = [], completion = s.chain.completion;
  s.chain.completion = async (id, from) => {
    const c = await completion(id, from);
    if (c?.ciphertexts.length && !logged.some((x) => x.requestId === id)) logged.push({ requestId: id, block: c.block, txHash: c.txHash, ciphertexts: c.ciphertexts });
    return c;
  };
  /** The read API over them: pages newest first, below `before`. */
  const requests = async (_account: string, before?: { block: number; logIndex: number }, limit = 50): Promise<AccountPage> => {
    const below = logged.filter((x) => !before || x.block < BigInt(before.block)).reverse();
    return { head: { block: 1_000, time: 1 }, more: below.length > limit, requests: below.slice(0, limit).map((x) => ({ requestId: x.requestId, block: x.block, logIndex: 0, txHash: x.txHash, completed: { block: x.block, txHash: x.txHash, status: 0 }, ciphertexts: x.ciphertexts })) };
  };
  return { logged, requests };
}

test("unlock shows the newest readable receipt's view read-only (cached, still locked) until its own sync lands; a failed sync drops it", async () => {
  let refuse = false;
  const s = await stack({ relayRefuses: () => refuse ? { code: "QUEUE_BUSY" } : null }), signer = wallet(), hints = memory(), { requests } = recording(s);
  const first = open(s, signer, hints);
  await first.account.unlock();
  s.fund(first.account.account, 10_000_000);
  await first.account.mint(ROUND, 1_000_000);
  const minted = first.account.snapshot.view!;
  first.account.lock();
  // A reload whose unlock sync is sent only once the cached view is on screen (or after 2 s, which fails below).
  const reload = () => {
    let seen = () => {};
    const shown = new Promise<void>((resolve) => { seen = resolve; setTimeout(resolve, 2_000).unref(); });
    const snapshots: Snapshot[] = [];
    const relay: Relay = { post: async (body) => { await shown; return s.relay.post(body); } };
    return { snapshots, account: new PrivateAccount(s.book, signer, { ...s.chain, requests }, relay, { hints, onChange: (x) => { snapshots.push(x); if (x.cached) seen(); }, now: () => 0, sleep: async () => {} }) };
  };
  const ok = reload();
  await ok.account.unlock();
  const cached = ok.snapshots.find((x) => x.cached);
  assert.deepEqual([cached?.unlocked, cached?.view?.cash, cached?.view?.holdings[0].up], [false, minted.cash, 1_000_000], "the minted position, locked");
  assert.deepEqual([ok.account.snapshot.unlocked, ok.account.snapshot.cached, ok.account.snapshot.view?.sequence], [true, false, minted.sequence]);
  // A failed unlock sync: the cached view goes with it.
  refuse = true;
  const failed = reload();
  await assert.rejects(failed.account.unlock(), /queue is busy/);
  assert.ok(failed.snapshots.some((x) => x.cached), "it was shown");
  assert.deepEqual([failed.account.snapshot.unlocked, failed.account.snapshot.cached, failed.account.snapshot.view], [false, false, null]);
});

test("History from the read API: pages newest first, each receipt decrypted once, Load older below the oldest, and the chain scan when the API fails", async () => {
  const s = await stack(), { logged, requests } = recording(s), pages: (object | undefined)[] = [];
  const { account } = open(s, wallet());
  await account.unlock();
  s.fund(account.account, 10_000_000);
  await account.mint(ROUND, 1_000_000);
  await account.merge(ROUND, 1_000_000);
  let api: Chain["requests"] = async (a, before) => { pages.push(before); return requests(a, before, 2); };
  s.chain.requests = (a, before, limit) => api!(a, before, limit);
  s.chain.sent = async () => { throw new Error("the chain is not read while the API answers"); };
  await account.loadHistory(0n);
  assert.deepEqual([account.snapshot.history.map((h) => h.text), account.snapshot.historyMore], [["Applied · applied", "Applied · applied"], true]);
  // Reopened: the newest page again, merged; a line already read is not decrypted again (its receipt now reads as garbage).
  logged[2].ciphertexts = [new Uint8Array(100)];
  await account.loadHistory(0n);
  assert.equal(account.snapshot.history.length, 2);
  assert.ok(account.snapshot.history.every((h) => h.readable));
  await account.loadHistory(0n, true);
  assert.deepEqual(pages, [undefined, undefined, { block: Number(logged[1].block), logIndex: 0 }]);
  assert.deepEqual([account.snapshot.history.map((h) => h.text), account.snapshot.historyMore], [["Applied · applied", "Applied · applied", "Account synced"], false]);
  // The API fails: the chain scan as before.
  api = async () => null;
  s.chain.sent = async () => ({ head: 1_000n, total: 1n });
  s.chain.history = async () => logged.slice(0, 1);
  await account.loadHistory(0n);
  assert.deepEqual(account.snapshot.history.map((h) => h.text), ["Account synced"]);
});

test("held rounds' results come from the shared live read; the chain is read only for rounds it lacks or when it fails, at most every 5 s", async () => {
  const id = (n: number) => keccak256(toHex(`round:${n}`)), settle = { kind: 2, outcome: 2, price: 1n, observationsTimestamp: 0, reportHash: id(9), source: 1, block: 1, txHash: id(8), logIndex: 0 };
  let live: Live | null = { head: { block: 1, time: 1 }, price: null, house: null, rounds: [{ start: 0, registryRoundId: id(1), open: null, settle }, { start: 900, registryRoundId: id(2), open: null, settle: null }] as ApiRound[] };
  let reads = 0, t = 0;
  const chain = { settled: async () => { reads++; return [{ roundId: id(3), outcome: 1 }]; } } as unknown as Chain;
  const indexed = indexedChain(chain, { account: async () => null, live: async () => live }, () => t);
  assert.deepEqual(await indexed.settled([id(1), id(2)], 0n), [{ roundId: id(1), outcome: 2 }]);
  assert.equal(reads, 0);
  live = null;
  await indexed.settled([id(3)], 0n);
  t += 4_999; await indexed.settled([id(3)], 0n);
  assert.equal(reads, 1, "the chain fallback keeps today's 5 s");
  t += 1; assert.deepEqual(await indexed.settled([id(3)], 0n), [{ roundId: id(3), outcome: 1 }]);
  assert.equal(reads, 2);
  // A stuck or catching-up indexer (head over 30 s behind) answers "no result yet" for a round the chain has settled: the chain.
  live = { head: { block: 1, time: 1 }, price: null, house: null, rounds: [{ start: 0, registryRoundId: id(1), open: null, settle: null }] as ApiRound[] };
  t = 32_000;
  assert.deepEqual(await indexed.settled([id(1)], 0n), [{ roundId: id(3), outcome: 1 }]);
  assert.equal(reads, 3);
  // Its newest History page would leave out the latest requests: the chain scan. An older page does not depend on the head.
  const page: AccountPage = { head: { block: 1, time: 1 }, more: false, requests: [] }, who = "0x00000000000000000000000000000000000000aa" as Address;
  const paged = indexedChain(chain, { account: async () => page, live: async () => live }, () => t);
  assert.equal(await paged.requests!(who), null);
  assert.equal(await paged.requests!(who, { block: 5, logIndex: 0 }), page);
  t = 31_000; assert.equal(await paged.requests!(who), page, "30 s behind is still fresh");
});

test("the last round's result survives a reload: the holding in the newest receipt from before its settle record, as the sweep empties it", async () => {
  const id = (start: number) => `round:${start}`, held = (start: number, up: number, down = 0) => ({ roundId: id(start), up, down, reservedUp: 0, reservedDown: 0 });
  const v = (...holdings: ReturnType<typeof held>[]) => ({ holdings }) as unknown as View, H = keccak256(toHex("h"));
  const settle = (block: number, kind: number, outcome: number) => ({ kind, outcome, price: 1n, observationsTimestamp: 0, reportHash: H, source: 1, block, txHash: H, logIndex: 0 });
  const rounds: ApiRound[] = [{ start: 900, registryRoundId: H, open: null, settle: settle(50, 2, 2) }, { start: 1800, registryRoundId: H, open: null, settle: settle(80, 2, 1) },
    { start: 2700, registryRoundId: H, open: null, settle: null }];
  // 3 Up bought in round 1800, settled Up at block 80; the receipt at 85 is after the sweep emptied it.
  assert.deepEqual(lastResult([{ block: 85, view: v() }, { block: 70, view: v(held(1800, 3_000_000)) }, { block: 40, view: v(held(900, 2_000_000)) }], rounds, id), { start: 1800, outcome: 1, paid: 3_000_000 });
  assert.deepEqual(lastResult([{ block: 70, view: v(held(1800, 0, 3_000_000)) }], rounds, id), { start: 1800, outcome: 1, paid: 0 }, "held Down: lost");
  assert.deepEqual(lastResult([{ block: 70, view: v(held(1800, 0)) }, { block: 40, view: v(held(900, 0, 2_000_000)) }], rounds, id), { start: 900, outcome: 2, paid: 2_000_000 }, "closed before the end: the round before");
  assert.equal(lastResult([{ block: 85, view: v() }], rounds, id), null, "only receipts from after the settlement: unknown, not lost");
  assert.deepEqual(lastResult([{ block: 70, view: v(held(1800, 3_000_000, 1_000_000)) }], [{ ...rounds[1], settle: settle(80, 3, 3) }], id), { start: 1800, outcome: 3, paid: 2_000_000 }, "a void pays half of each side");

  // Through the client: a reload after the sweep reads it from the account's receipts in the read API.
  const s = await stack(), signer = wallet(), { logged, requests } = recording(s);
  const first = open(s, signer);
  await first.account.unlock();
  s.fund(first.account.account, 10_000_000);
  await first.account.mint(ROUND, 2_000_000);
  const minted = logged.at(-1)!.block, v2 = s.views.get(first.account.account)!;
  v2.up = 0; v2.down = 0; v2.cash += 2_000_000;
  await first.account.sync();
  first.account.lock();
  const reload = new PrivateAccount(s.book, signer, { ...s.chain, requests }, s.relay, { hints: first.hints, sleep: async () => {} });
  await reload.unlock();
  await reload.loadLastResult([{ start: ROUND, registryRoundId: H, open: null, settle: settle(Number(minted) + 1, 2, 2) }]);
  assert.deepEqual(reload.snapshot.lastResult, { start: ROUND, outcome: 2, paid: 2_000_000 });
});
