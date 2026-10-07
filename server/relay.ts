/** ZEDGE's relayer: sends a signed-in user's own EIP-712 request authorization to the order book's ProcessorEndpoint.submitRequestFor
 * on Horizen (a private command, or the key registration), and a user's Base USDC permit to the ZEDGE vault's depositWithPermit on
 * Base. It pays gas on both chains and the request fee; it never signs for a user. Only that endpoint, that application, that vault,
 * those request types and their exact shapes are encoded here. Every check runs before anything is sent; a send is never retried or
 * resubmitted. Withdrawals need nothing from it: they are private requests, and the payout signer pays them on Base. */
import { createHash, randomUUID } from "node:crypto";
import { createLocalJWKSet, jwtVerify, type JSONWebKeySet } from "jose";
import { BaseError, ExecutionRevertedError, createPublicClient, decodeErrorResult, encodeFunctionData, http, keccak256, parseAbi, parseEventLogs, recoverTypedDataAddress, type Address, type Hex, type Log } from "viem";
import { privateKeyToAccount } from "viem/accounts";
import { ASSOCIATEKEY, PROCESS, ZERO_ADDRESS, endpointAbi, parseOrderbookManifest, requestTypedData, type ConfiguredOrderbook } from "../src/chain/orderbook-manifest.ts";
import { usdcPermitTypedData, vaultAbi } from "../src/chain/vault.ts";

type Book = ConfiguredOrderbook;
export type RelayConfig = {
  book: Book; privyAppId: string; jwks: JSONWebKeySet; allowedOrigin: string; inviteOnly: boolean; dailyBudgetWei: bigint; minBalanceWei: bigint;
  baseDailyBudgetWei: bigint; baseMinBalanceWei: bigint;
  limits: { user10m: number; userDay: number; userDeposits: number; globalHour: number; queueBusy: number };
};
export const DEFAULT_LIMITS: RelayConfig["limits"] = { user10m: 20, userDay: 150, userDeposits: 5, globalHour: 400, queueBusy: 6 };
/** The subset of Upstash Redis used: plain SET NX / INCR / EXPIRE, no scripts. Values are raw strings. */
export interface Store {
  set(key: string, value: string, options?: { nx?: true; xx?: true; ex?: number; px?: number }): Promise<unknown>;
  get(key: string): Promise<string | null>;
  del(key: string): Promise<number>;
  incrby(key: string, by: number): Promise<number>;
  decrby(key: string, by: number): Promise<number>;
  expire(key: string, seconds: number): Promise<number>;
  ttl(key: string): Promise<number>;
  sismember(key: string, member: string): Promise<number>;
}
export type ChainState = { nonce: bigint; pending: bigint; balance: bigint; baseFee: bigint; timestamp: bigint };
/** One read of Base at the latest block: the owner's USDC and permit nonce, its allowance to the vault, the vault's limits, the relayer's ETH. */
export type DepositState = {
  timestamp: bigint; baseFee: bigint; balance: bigint; usdcBalance: bigint; usdcNonce: bigint; allowance: bigint;
  limits: { minDeposit: bigint; maxDeposit: bigint; maxPayout: bigint; dailyPayoutCap: bigint };
};
export type Receipt = { status: "success" | "reverted"; gasUsed: bigint; effectiveGasPrice: bigint; l1Fee: bigint; blockNumber: bigint; logs: Log[] };
/** One chain. `state` reads the order book (Horizen); `depositState` reads the vault side (Base). */
export interface Wire {
  state(sender: Address, relayer: Address): Promise<ChainState>;
  depositState(owner: Address, relayer: Address): Promise<DepositState>;
  /** eth_call then eth_estimateGas, from the relayer. */
  simulate(from: Address, to: Address, data: Hex, value: bigint): Promise<{ ok: true; gas: bigint } | { ok: false; reason: string }>;
  pendingNonce(address: Address): Promise<number>;
  send(raw: Hex): Promise<void>;
  known(hash: Hex): Promise<boolean>;
  receipt(hash: Hex): Promise<Receipt | null>;
}
export interface TxSigner { address: Address; signTransaction(tx: { chainId: number; to: Address; data: Hex; value: bigint; gas: bigint; maxFeePerGas: bigint; maxPriorityFeePerGas: bigint; nonce: number; type: "eip1559" }): Promise<Hex> }
/** `wire` is Horizen (requests); `base` is Base (deposits). */
export type Deps = { config: RelayConfig | null; store: Store | null; wire: Wire | null; base?: Wire | null; signer: TxSigner | null; now?: () => number; sleep?: (ms: number) => Promise<void>; log?: (line: string) => void };
export type Answer = { status: number; body: Record<string, unknown> };

const STATUS: Record<string, number> = {
  BAD_REQUEST: 400, UNSUPPORTED_REQUEST: 400, UNAUTHENTICATED: 401, ORIGIN_NOT_ALLOWED: 403, NOT_INVITED: 403, SENDER_NOT_LINKED: 403, SIGNATURE_MISMATCH: 409, IN_FLIGHT: 409,
  PERMIT_MISMATCH: 409, AMOUNT_ABOVE_BALANCE: 409, DEADLINE_OUT_OF_RANGE: 422, SIMULATION_REVERTED: 422, GAS_ABOVE_CAP: 422, AMOUNT_OUT_OF_RANGE: 422,
  RATE_LIMITED: 429, DAILY_LIMIT: 429, QUEUE_BUSY: 503, BUDGET_EXHAUSTED: 503, RELAYER_UNFUNDED: 503, FEE_ABOVE_CAP: 503, STORE_UNAVAILABLE: 503,
  RPC_UNAVAILABLE: 502, SEND_UNKNOWN: 502, REVERTED: 502, SENT_UNCONFIRMED: 202,
};
const MESSAGE: Record<string, string> = {
  BAD_REQUEST: "Malformed request.", UNSUPPORTED_REQUEST: "This request is not supported.", UNAUTHENTICATED: "Sign in again.", ORIGIN_NOT_ALLOWED: "Origin not allowed.",
  NOT_INVITED: "Not invited.", SENDER_NOT_LINKED: "Wallet not linked to this sign-in.", SIGNATURE_MISMATCH: "Signature does not match the request at the current nonce.",
  IN_FLIGHT: "A request from this wallet is being sent.", DEADLINE_OUT_OF_RANGE: "Deadline out of range.", SIMULATION_REVERTED: "The exchange would refuse this request.",
  GAS_ABOVE_CAP: "Gas above the cap.", RATE_LIMITED: "Rate limited.", DAILY_LIMIT: "Today's deposit limit is reached.", QUEUE_BUSY: "The exchange queue is busy.", BUDGET_EXHAUSTED: "Daily budget used up.",
  RELAYER_UNFUNDED: "Relayer unavailable.", FEE_ABOVE_CAP: "Network fee above the cap.", STORE_UNAVAILABLE: "Relayer unavailable.", RPC_UNAVAILABLE: "Network unavailable.",
  SEND_UNKNOWN: "Sent or not: unknown. Follow the chain.", REVERTED: "Reverted on chain.", SENT_UNCONFIRMED: "Sent; not confirmed yet.",
  PERMIT_MISMATCH: "Token permit does not match at the current nonce.", AMOUNT_ABOVE_BALANCE: "Amount above the wallet's balance.", AMOUNT_OUT_OF_RANGE: "Amount outside the vault's deposit limits.",
};
class Refusal extends Error {
  readonly code: string; readonly extra: Record<string, unknown>;
  constructor(code: string, extra: Record<string, unknown> = {}) { super(code); this.code = code; this.extra = extra; }
}
const refuse = (code: string, extra: Record<string, unknown> = {}): never => { throw new Refusal(code, extra); };

/** Tip and fee ceiling per chain, in wei per gas. Horizen pays about 252 wei base; Base about 0.005 gwei. */
export const FEE_CAPS = { horizen: { tip: 1_000_000n, max: 3_000_000n }, base: { tip: 1_000_000n, max: 100_000_000n } } as const;
// PROCESS measured 1.685 M gas (2,076-byte payload) through submitRequest; ×1.2 needs more than 2 M. A Base deposit is about 0.56 M
// (most of it the Horizen deposit fee the portal burns); far above that, someone is pumping that fee, and the relayer waits it out.
export const GAS_CAP = { process: 2_400_000n, associate: 450_000n, "base-deposit": 1_500_000n } as const;
const MWEI = 1_000_000n; // budget counters hold whole Mwei so they stay exact JavaScript numbers
const mwei = (wei: bigint) => Number((wei + MWEI - 1n) / MWEI);
const sha = (text: string) => createHash("sha256").update(text).digest("hex");
const hexOf = (v: unknown, bytes?: number) => typeof v === "string" && /^0x([0-9a-fA-F]{2})*$/.test(v) && (bytes === undefined || v.length === 2 + bytes * 2);
const addressOf = (v: unknown): Address | null => typeof v === "string" && /^0x[0-9a-fA-F]{40}$/.test(v) ? v.toLowerCase() as Address : null;
const atoms = (v: unknown): bigint | null => typeof v === "string" && /^[1-9][0-9]{0,12}$/.test(v) ? BigInt(v) : null;
/** 65 bytes r ‖ s ‖ v with v already 27 or 28, as the browser normalizes it (orderbook-manifest normalizeSignature). */
const signature65 = (v: unknown): Hex | null => typeof v === "string" && /^0x[0-9a-fA-F]{128}(1b|1c)$/i.test(v) ? v.toLowerCase() as Hex : null;
const day = (ms: number) => new Date(ms).toISOString().slice(0, 10).replace(/-/g, "");
const hour = (ms: number) => new Date(ms).toISOString().slice(0, 13).replace(/[-T]/g, "");

const tokenAbi = parseAbi(["function balanceOf(address) view returns (uint256)", "function nonces(address) view returns (uint256)", "function allowance(address, address) view returns (uint256)"]);
const vaultErrors = parseAbi(["error AmountOutOfRange()", "error InvalidRecipient()", "error AlreadyPaid()", "error BadSignature()", "error CapExceeded()", "error SafeERC20FailedOperation(address token)"]);

type Parsed = { kind: "request"; sender: Address; requestType: 1 | 3; payload: Hex; tokenAddress: Address; assetAmount: bigint; deadline: bigint; signature: Hex; permit: Hex; shape: "process" | "associate" }
  | { kind: "base-deposit"; owner: Address; amount: bigint; deadline: bigint; permit: Hex; shape: "base-deposit" };

/** Step 5: the only shapes the relayer will pay for. */
export function parseBody(text: string): Parsed {
  let v: unknown;
  try { v = JSON.parse(text); } catch { return refuse("BAD_REQUEST"); }
  if (!v || typeof v !== "object" || Array.isArray(v)) refuse("BAD_REQUEST");
  const r = v as Record<string, unknown>, keys = Object.keys(r).sort().join(",");
  if (r.kind === "base-deposit") {
    const owner = addressOf(r.owner), amount = atoms(r.amount), permit = signature65(r.permit);
    if (keys !== "amount,deadline,kind,owner,permit" || !owner || !amount || !permit || typeof r.deadline !== "string" || !/^[1-9][0-9]{0,15}$/.test(r.deadline)) refuse("BAD_REQUEST");
    return { kind: "base-deposit", owner: owner!, amount: amount!, deadline: BigInt(r.deadline as string), permit: permit!, shape: "base-deposit" };
  }
  if (r.kind !== "request" || keys !== "assetAmount,deadline,kind,payload,permit,requestType,sender,signature,tokenAddress") refuse("BAD_REQUEST");
  const sender = addressOf(r.sender), token = addressOf(r.tokenAddress);
  if (!sender || !token || !hexOf(r.payload) || !hexOf(r.signature, 65) || !hexOf(r.permit) || typeof r.assetAmount !== "string" || !/^(0|[1-9][0-9]{0,30})$/.test(r.assetAmount) ||
    typeof r.deadline !== "string" || !/^[1-9][0-9]{0,15}$/.test(r.deadline) || (r.requestType !== PROCESS && r.requestType !== ASSOCIATEKEY)) refuse("BAD_REQUEST");
  const payload = (r.payload as string).toLowerCase() as Hex, permit = (r.permit as string).toLowerCase() as Hex, amount = BigInt(r.assetAmount as string), bytes = (payload.length - 2) / 2;
  // No deposit through the endpoint: the guest refuses Horizen custody (the vault on Base holds users' USDC).
  if (token !== ZERO_ADDRESS || amount !== 0n || permit !== "0x") return refuse("UNSUPPORTED_REQUEST");
  let shape: "process" | "associate";
  if (r.requestType === ASSOCIATEKEY && bytes === 133) shape = "associate";
  else if (r.requestType === PROCESS && bytes === 2076) shape = "process";
  else return refuse("UNSUPPORTED_REQUEST");
  return { kind: "request", sender: sender!, requestType: r.requestType as 1 | 3, payload, tokenAddress: token!, assetAmount: amount, deadline: BigInt(r.deadline as string), signature: (r.signature as string).toLowerCase() as Hex, permit, shape };
}

/** Step 2–3: both Privy tokens, verified with the app's public keys only, for the same user; the user's Ethereum wallets. */
export async function authenticate(headers: Headers, config: Pick<RelayConfig, "privyAppId" | "jwks">): Promise<{ sub: string; wallets: Set<string> }> {
  const bearer = /^Bearer ([A-Za-z0-9._-]{20,4096})$/.exec(headers.get("authorization") ?? "")?.[1], identity = headers.get("privy-id-token") ?? "";
  if (!bearer || !/^[A-Za-z0-9._-]{20,16384}$/.test(identity)) refuse("UNAUTHENTICATED");
  const keys = createLocalJWKSet(config.jwks), options = { algorithms: ["ES256"], issuer: "privy.io", audience: config.privyAppId, clockTolerance: 30, requiredClaims: ["sub", "exp", "iat"] };
  try {
    const [access, id] = await Promise.all([jwtVerify(bearer!, keys, options), jwtVerify(identity, keys, options)]);
    if (!access.payload.sub || access.payload.sub !== id.payload.sub) refuse("UNAUTHENTICATED");
    // The Bearer token must be an access token (a session, no identity): an identity token in both headers is not two tokens.
    if (typeof access.payload.sid !== "string" || "linked_accounts" in access.payload) refuse("UNAUTHENTICATED");
    const raw = id.payload.linked_accounts;
    const accounts: unknown = typeof raw === "string" ? JSON.parse(raw) : raw;
    if (!Array.isArray(accounts)) refuse("UNAUTHENTICATED");
    const wallets = new Set((accounts as Record<string, unknown>[]).filter((a) => a?.type === "wallet" && a.chain_type === "ethereum").map((a) => addressOf(a.address)).filter((a): a is Address => Boolean(a)));
    if (!wallets.size) refuse("UNAUTHENTICATED");
    return { sub: access.payload.sub!, wallets };
  } catch (error) {
    if (error instanceof Refusal) throw error;
    return refuse("UNAUTHENTICATED");
  }
}

function encode(book: Book, p: Parsed): Hex {
  if (p.kind === "request") return encodeFunctionData({ abi: endpointAbi, functionName: "submitRequestFor", args: [p.sender, 0, BigInt(book.application.id), p.requestType, p.payload, p.tokenAddress, p.assetAmount, p.deadline, p.signature, p.permit] });
  return encodeFunctionData({ abi: vaultAbi, functionName: "depositWithPermit", args: [p.owner, p.amount, p.deadline, Number.parseInt(p.permit.slice(130), 16), `0x${p.permit.slice(2, 66)}`, `0x${p.permit.slice(66, 130)}`] });
}

export async function handle(request: { method: string; headers: Headers; body: string }, deps: Deps): Promise<Answer> {
  const now = deps.now ?? Date.now, sleep = deps.sleep ?? ((ms: number) => new Promise((r) => setTimeout(r, ms))), started = now();
  const line: Record<string, unknown> = { t: new Date(started).toISOString() };
  // Undone on the way out: the idempotency record of a request never sent, the sender's in-flight mark, the unspent budget reservation.
  let forget: string | null = null, inflight: string | null = null, refund = 0, budgetKey = "", broadcast: Hex | null = null;
  const answer = (code: string, extra: Record<string, unknown> = {}): Answer => {
    line.code = code; line.ms = now() - started;
    // Public data only: never tokens, linked accounts, payload, signature, permit or the key.
    deps.log?.(JSON.stringify(line));
    return code === "OK" ? { status: 200, body: { ok: true, ...extra } } : { status: STATUS[code] ?? 500, body: { ok: false, code, message: MESSAGE[code] ?? "", ...extra } };
  };
  const { config, store, signer } = deps;
  try {
    if (!config) return answer("UNAUTHENTICATED");
    if (request.method !== "POST" || request.headers.get("origin") !== config.allowedOrigin) return answer("ORIGIN_NOT_ALLOWED");
    if (request.body.length > 8192) return answer("BAD_REQUEST");
    if (!signer || signer.address !== config.book.relayer.facilitator) return answer("RELAYER_UNFUNDED");
    if (!store) return answer("STORE_UNAVAILABLE");
    if (!deps.wire) return answer("RPC_UNAVAILABLE");
    const user = await authenticate(request.headers, config);
    line.user = sha(user.sub).slice(0, 16);
    if (config.inviteOnly && !(await store.sismember("relay:invited", user.sub))) return answer("NOT_INVITED");
    const p = parseBody(request.body);
    // The chain this request is sent on: Base for a deposit, Horizen for a request. Lock, nonce, budget and in-flight marks are per chain.
    const onBase = p.kind === "base-deposit", chainId = onBase ? config.book.custody.chainId : config.book.chainId, wire = onBase ? deps.base : deps.wire;
    const fees = onBase ? FEE_CAPS.base : FEE_CAPS.horizen, dailyBudgetWei = onBase ? config.baseDailyBudgetWei : config.dailyBudgetWei, minBalanceWei = onBase ? config.baseMinBalanceWei : config.minBalanceWei;
    const who = p.kind === "request" ? p.sender : p.owner;
    Object.assign(line, { chain: chainId, kind: p.kind, type: p.shape, sender: who }, p.kind === "base-deposit" ? { amount: p.amount.toString() } : {});
    if (!user.wallets.has(who)) return answer("SENDER_NOT_LINKED");
    if (!wire) return answer("RPC_UNAVAILABLE");

    // Step 7: limits, counted before any RPC.
    const t = now(), today = day(t), date = new Date(t), toMidnight = Math.ceil((Date.UTC(date.getUTCFullYear(), date.getUTCMonth(), date.getUTCDate() + 1) - t) / 1000);
    const count = async (key: string, limit: number, ttl: number, code = "RATE_LIMITED") => {
      // The key is created with its expiry: a counter left without one (a failed EXPIRE) would refuse its user for ever.
      await store.set(key, "0", { nx: true, ex: ttl });
      const n = await store.incrby(key, 1);
      if (n === 1) await store.expire(key, ttl);
      if (n > limit) refuse(code, { retryAfter: code === "DAILY_LIMIT" ? toMidnight : Math.max(1, await store.ttl(key)) });
    };
    await count(`relay:u10m:${user.sub}`, config.limits.user10m, 600);
    await count(`relay:uday:${user.sub}:${today}`, config.limits.userDay, 172_800);
    if (p.kind === "base-deposit") await count(`relay:udep:${user.sub}:${today}`, config.limits.userDeposits, 172_800, "DAILY_LIMIT");
    await count(`relay:gh:${hour(t)}`, config.limits.globalHour, 7_200);

    // Step 8: the same signed authorization (or permit) is sent at most once, ever.
    const key = p.kind === "request" ? `relay:req:${keccak256(p.signature)}` : `relay:dep:${keccak256(p.permit)}`;
    line.key = key.slice(-10);
    if (await store.set(key, JSON.stringify({ state: "pending" }), { nx: true, ex: 86_400 })) forget = key;
    else {
      const prior = JSON.parse(await store.get(key) ?? "{}") as { state?: string; code?: string; result?: Record<string, unknown>; txHash?: string };
      if (prior.state === "done") return answer(prior.code ?? "OK", { ...prior.result, duplicate: true });
      return prior.txHash ? answer("SENT_UNCONFIRMED", { txHash: prior.txHash, duplicate: true }) : answer("IN_FLIGHT");
    }
    if (!(await store.set(`relay:inflight:${chainId}:${who}`, "1", { nx: true, ex: 60 }))) return answer("IN_FLIGHT");
    inflight = `relay:inflight:${chainId}:${who}`;

    // Step 9: one batch at the latest block of that chain.
    let to: Address, value = 0n, balance: bigint, baseFee: bigint;
    if (p.kind === "base-deposit") {
      const s = await wire.depositState(p.owner, signer.address).catch(() => refuse("RPC_UNAVAILABLE"));
      // Step 10: the permit at the token's on-chain nonce, to this vault, for exactly the amount (or an allowance that already covers it:
      // the vault tries the permit and pulls exactly the amount).
      const recovered = await recoverTypedDataAddress({ ...usdcPermitTypedData(config.book.custody, { owner: p.owner, value: p.amount, nonce: s.usdcNonce, deadline: p.deadline }), signature: p.permit }).catch(() => null);
      if (recovered?.toLowerCase() !== p.owner && s.allowance < p.amount) return answer("PERMIT_MISMATCH");
      // Step 11: the vault's own limits, read rather than restated, so a refusal here is one the chain would give.
      if (p.amount < s.limits.minDeposit || p.amount > s.limits.maxDeposit) return answer("AMOUNT_OUT_OF_RANGE");
      if (p.amount > s.usdcBalance) return answer("AMOUNT_ABOVE_BALANCE");
      if (p.deadline < s.timestamp + 60n || p.deadline > s.timestamp + 3_600n) return answer("DEADLINE_OUT_OF_RANGE");
      to = config.book.custody.vault.address; balance = s.balance; baseFee = s.baseFee;
    } else {
      const s = await wire.state(p.sender, signer.address).catch(() => refuse("RPC_UNAVAILABLE"));
      // Step 10: the digest with the on-chain nonce and this relayer's fixed domain; nothing in the body chooses the endpoint or the application.
      const typed = requestTypedData(config.book, { sender: p.sender, requestType: p.requestType, payload: p.payload, tokenAddress: p.tokenAddress, assetAmount: p.assetAmount, nonce: s.nonce, deadline: p.deadline });
      const recovered = await recoverTypedDataAddress({ ...typed, signature: p.signature }).catch(() => null);
      if (recovered?.toLowerCase() !== p.sender) return answer("SIGNATURE_MISMATCH");
      if (p.deadline < s.timestamp + 15n || p.deadline > s.timestamp + 600n) return answer("DEADLINE_OUT_OF_RANGE");
      // Step 11: room left in the shared queue.
      if (s.pending >= BigInt(config.limits.queueBusy)) return answer("QUEUE_BUSY", { retryAfter: 20 });
      to = config.book.endpoint.address; value = BigInt(config.book.endpoint.minFeePerRequestWei); balance = s.balance; baseFee = s.baseFee;
    }
    // Step 12: that chain's fee cap and the relayer's own balance there.
    if (baseFee + fees.tip > fees.max) return answer("FEE_ABOVE_CAP");
    const maxFeePerGas = 2n * baseFee + fees.tip < fees.max ? 2n * baseFee + fees.tip : fees.max;
    if (balance < minBalanceWei) return answer("RELAYER_UNFUNDED");
    if (balance < 2n * minBalanceWei) deps.log?.(JSON.stringify({ t: line.t, alert: "RELAYER_LOW", chain: chainId, balanceWei: balance.toString() }));

    // Step 13: simulate, then cap the gas by type. A deposit far above its usual gas pays a pumped Horizen deposit fee: wait it out.
    const data = encode(config.book, p);
    const sim = await wire.simulate(signer.address, to, data, value).catch(() => refuse("RPC_UNAVAILABLE"));
    if (!sim.ok) return answer("SIMULATION_REVERTED", { reason: sim.reason });
    const gas = sim.gas * 12n / 10n;
    if (gas > GAS_CAP[p.shape]) return answer(p.kind === "base-deposit" ? "FEE_ABOVE_CAP" : "GAS_ABOVE_CAP");

    // Step 14: reserve the worst case against that chain's budget for today.
    const reserved = mwei(gas * maxFeePerGas + value);
    budgetKey = `relay:spent:${chainId}:${today}`;
    const spent = await store.incrby(budgetKey, reserved);
    refund = reserved;
    if (spent === reserved) await store.expire(budgetKey, 172_800);
    if (BigInt(spent) * MWEI > dailyBudgetWei) return answer("BUDGET_EXHAUSTED", { retryAfter: toMidnight });

    // Step 15: one sender of relayer transactions per chain at a time, across instances.
    const lock = randomUUID(), lockKey = `relay:lock:${chainId}`, nonceKey = `relay:nonce:${chainId}`;
    let locked = false;
    for (const until = now() + 5_000; !(locked = Boolean(await store.set(lockKey, lock, { nx: true, px: 15_000 }))) && now() < until;) await sleep(250);
    if (!locked) return answer("QUEUE_BUSY", { retryAfter: 5 });
    let txHash: Hex, sent = true;
    try {
      const stored = Number(await store.get(nonceKey) ?? 0), pending = await wire.pendingNonce(signer.address);
      if (stored > pending) deps.log?.(JSON.stringify({ t: line.t, alert: "NONCE_AHEAD", chain: chainId, stored, pending }));
      const nonce = Math.max(stored, pending);
      const raw = await signer.signTransaction({ chainId, to, data, value, gas, maxFeePerGas, maxPriorityFeePerGas: fees.tip, nonce, type: "eip1559" });
      txHash = keccak256(raw);
      line.tx = txHash;
      // Recorded before the broadcast: whatever happens next, this authorization is never sent again.
      await store.set(key, JSON.stringify({ state: "sent", txHash }), { xx: true, ex: 86_400 });
      forget = null;
      broadcast = txHash;
      try { await wire.send(raw); } catch { sent = await wire.known(txHash).catch(() => false); }
      // Only bridges the seconds before the node counts this transaction as pending; after that the chain's count rules again,
      // so a transaction the node accepted and then lost cannot hold every later one behind a nonce gap.
      await store.set(nonceKey, String(nonce + 1), { ex: 30 });
    } finally {
      // Known limit: GET then DEL is not atomic; the 15 s expiry bounds a lock lost between them. A Lua compare-and-delete closes it.
      if (await store.get(lockKey) === lock) await store.del(lockKey);
    }

    // A send error the node does not confirm: the transaction may be out there all the same. Its record stays, so this signature
    // is never sent again, and the client settles the outcome from the chain (the request nonce, the permit nonce, the deadline).
    if (!sent) { refund = 0; inflight = null; return answer("SEND_UNKNOWN", { txHash }); }

    // Step 16: the receipt, briefly, within the function's 30 s; the client follows the chain itself after that.
    // No initializer: Vercel's file tracer would read `null` as the value and fail the build evaluating the cost below.
    let receipt: Receipt | null | undefined;
    for (let i = 0; i < 20 && !receipt && now() - started < 15_000; i++) { await sleep(1_000); receipt = await wire.receipt(txHash).catch(() => null); }
    if (!receipt) { refund = 0; inflight = null; return answer("SENT_UNCONFIRMED", { txHash }); }
    const cost = receipt.gasUsed * receipt.effectiveGasPrice + receipt.l1Fee + value;
    Object.assign(line, { gasUsed: receipt.gasUsed.toString(), costWei: cost.toString() });
    refund = Math.max(0, reserved - mwei(cost));
    const result: Record<string, unknown> = { txHash, block: Number(receipt.blockNumber), facilitator: signer.address };
    let code = receipt.status === "success" ? "OK" : "REVERTED";
    if (code === "OK" && p.kind === "request") {
      const own = parseEventLogs({ abi: endpointAbi, logs: receipt.logs.filter((l) => l.address.toLowerCase() === config.book.endpoint.address), eventName: "RequestSubmitted" })
        .find((l) => l.args.applicationId === BigInt(config.book.application.id));
      if (own && own.args.facilitator.toLowerCase() === signer.address && own.args.sender.toLowerCase() === p.sender) result.requestId = own.args.requestId;
      else code = "REVERTED";
    }
    if (code === "OK" && p.kind === "base-deposit") {
      const own = parseEventLogs({ abi: vaultAbi, logs: receipt.logs.filter((l) => l.address.toLowerCase() === to), eventName: "Deposited" })
        .find((l) => l.args.account.toLowerCase() === p.owner && l.args.amount === p.amount);
      if (own) result.index = own.args.index.toString();
      else code = "REVERTED";
    }
    await store.set(key, JSON.stringify({ state: "done", code, result }), { ex: 86_400 });
    return answer(code, code === "OK" ? result : { txHash });
  } catch (error) {
    // Anything that fails after the broadcast (the store, a read) must not read as "not sent".
    if (broadcast) { refund = 0; inflight = null; return answer("SENT_UNCONFIRMED", { txHash: broadcast }); }
    return error instanceof Refusal ? answer(error.code, error.extra) : answer("STORE_UNAVAILABLE");
  } finally {
    if (store) {
      if (forget) await store.del(forget).catch(() => undefined);
      if (inflight) await store.del(inflight).catch(() => undefined);
      if (refund) await store.decrby(budgetKey, refund).catch(() => undefined);
    }
  }
}

/** Configuration from the environment and the committed manifest. Anything missing or malformed leaves the relayer closed. */
export function configFromEnv(env: Record<string, string | undefined>, manifest: unknown): RelayConfig | null {
  try {
    const book = parseOrderbookManifest(manifest);
    if (book.status !== "configured") return null;
    const appId = env.PRIVY_APP_ID ?? "";
    const jwks = JSON.parse(env.PRIVY_JWKS ?? "null") as JSONWebKeySet;
    if (!/^[a-z0-9-]{3,64}$/.test(appId) || !jwks || !Array.isArray(jwks.keys) || !jwks.keys.length) return null;
    const wei = (v: string | undefined, fallback: bigint) => v === undefined ? fallback : /^[0-9]{1,30}$/.test(v) ? BigInt(v) : null;
    const budget = wei(env.RELAY_DAILY_BUDGET_WEI, 3_000_000_000_000_000n), minimum = wei(env.RELAY_MIN_BALANCE_WEI, 500_000_000_000_000n);
    const baseBudget = wei(env.RELAY_BASE_DAILY_BUDGET_WEI, 2_000_000_000_000_000n), baseMinimum = wei(env.RELAY_BASE_MIN_BALANCE_WEI, 200_000_000_000_000n);
    if (budget === null || minimum === null || baseBudget === null || baseMinimum === null) return null;
    return { book, privyAppId: appId, jwks, allowedOrigin: env.RELAY_ALLOWED_ORIGIN ?? "https://zedge-markets.vercel.app", inviteOnly: env.RELAY_INVITE_ONLY !== "0",
      dailyBudgetWei: budget, minBalanceWei: minimum, baseDailyBudgetWei: baseBudget, baseMinBalanceWei: baseMinimum, limits: DEFAULT_LIMITS };
  } catch { return null; }
}

/** The relayer's key, read at runtime only. Never logged. */
export function signerFromEnv(key: string | undefined): TxSigner | null {
  if (!key || !/^0x[0-9a-fA-F]{64}$/.test(key)) return null;
  const account = privateKeyToAccount(key as Hex);
  return { address: account.address.toLowerCase() as Address, signTransaction: (tx) => account.signTransaction(tx) };
}

const revertAbi = [...endpointAbi, ...vaultErrors];
export function viemWire(rpcUrl: string, book: Book): Wire {
  const client = createPublicClient({ transport: http(rpcUrl, { batch: true, retryCount: 0, timeout: 8_000 }) });
  const endpoint = book.endpoint.address, vault = book.custody.vault.address, usdc = book.custody.usdc.address;
  return {
    async state(sender, relayer) {
      const block = await client.getBlock({ blockTag: "latest" });
      const at = { blockNumber: block.number };
      const [nonce, pending, balance] = await Promise.all([
        client.readContract({ address: endpoint, abi: endpointAbi, functionName: "facilitatorNonces", args: [sender], ...at }),
        client.readContract({ address: endpoint, abi: endpointAbi, functionName: "getPendingRequestsSize", ...at }),
        client.getBalance({ address: relayer, ...at }),
      ]);
      return { nonce, pending, balance, baseFee: block.baseFeePerGas ?? 0n, timestamp: block.timestamp };
    },
    async depositState(owner, relayer) {
      const block = await client.getBlock({ blockTag: "latest" });
      const at = { blockNumber: block.number };
      const [usdcBalance, usdcNonce, allowance, limits, balance] = await Promise.all([
        client.readContract({ address: usdc, abi: tokenAbi, functionName: "balanceOf", args: [owner], ...at }),
        client.readContract({ address: usdc, abi: tokenAbi, functionName: "nonces", args: [owner], ...at }),
        client.readContract({ address: usdc, abi: tokenAbi, functionName: "allowance", args: [owner, vault], ...at }),
        client.readContract({ address: vault, abi: vaultAbi, functionName: "limits", ...at }),
        client.getBalance({ address: relayer, ...at }),
      ]);
      return { timestamp: block.timestamp, baseFee: block.baseFeePerGas ?? 0n, balance, usdcBalance, usdcNonce, allowance, limits };
    },
    async simulate(from, to, data, value) {
      try {
        await client.call({ account: from, to, data, value });
        return { ok: true, gas: await client.estimateGas({ account: from, to, data, value }) };
      } catch (error) {
        // A revert carries data or says so; anything else (timeout, HTTP) is a failed read and passes through.
        const reverted = error instanceof BaseError ? error.walk((e) => typeof (e as { data?: unknown }).data === "string" || e instanceof ExecutionRevertedError) : null;
        if (!reverted) throw error;
        const raw = (reverted as { data?: unknown }).data;
        try {
          const decoded = decodeErrorResult({ abi: revertAbi, data: raw as Hex });
          const name: string = decoded.errorName, args = decoded.args as readonly unknown[] | undefined;
          return { ok: false, reason: name === "Error" ? `token: ${String(args?.[0]).slice(0, 80)}` : name };
        } catch { return { ok: false, reason: "reverted" }; }
      }
    },
    pendingNonce: (address) => client.getTransactionCount({ address, blockTag: "pending" }),
    async send(raw) { await client.request({ method: "eth_sendRawTransaction", params: [raw] }); },
    async known(hash) { return Boolean(await client.request({ method: "eth_getTransactionByHash", params: [hash] })); },
    async receipt(hash) {
      const r = await client.getTransactionReceipt({ hash }).catch(() => null);
      if (!r) return null;
      return { status: r.status, gasUsed: r.gasUsed, effectiveGasPrice: r.effectiveGasPrice, l1Fee: BigInt((r as unknown as { l1Fee?: string }).l1Fee ?? 0), blockNumber: r.blockNumber, logs: r.logs };
    },
  };
}
