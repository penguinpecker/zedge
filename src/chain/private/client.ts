/** The private-account client: request authorizations for the relayer, completion polling, receipt decryption, the account's
 * private view, and the money path (one Base deposit in, one Base payout out). DOM-free so the fork driver can run it in Node.
 * Loaded only with import(): this module pulls in the Vela crypto SDK. Keys live in this object's memory only; nothing here is
 * stored except a key fingerprint hint. */
import { formatUnits, getAbiItem, getAddress, hexToBytes, parseEventLogs, recoverTypedDataAddress, sha256, toHex, type Address, type Hex, type PublicClient } from "viem";
import type { Signer as EthersSigner } from "ethers";
import { EvaluationSession, type EvaluationDomain } from "../../../adapters/vela/crypto/session.ts";
import { commandBody, commandId, syncBody, syncRequestId, type EngineCommand, type ReceiptBody } from "../../../adapters/vela/crypto/guest.ts";
import { padBody } from "../../../adapters/vela/crypto/pad.ts";
import { ASSOCIATEKEY, LOT, OPERATOR_KEYS_CHANGED, PROCESS, ZERO_ADDRESS, endpointAbi, engineRound, normalizeSignature, requestTypedData, type VerifiedOrderbook } from "../orderbook-manifest.ts";
import { SUBTYPES, decodeCredit, decodePayout, decodeSettle, inboxAbi, usdcAbi, usdcPermitTypedData, vaultAbi } from "../vault.ts";
import type { AccountPage, Live } from "../read-api.ts";

export type Book = VerifiedOrderbook["manifest"];
export type TypedData = ReturnType<typeof requestTypedData> | ReturnType<typeof usdcPermitTypedData>;
/** The wallet as the client needs it. Implementations return normalized signatures and sign without prompts where they can. */
export interface Signer { address: Address; signMessage(message: string): Promise<Hex>; signTypedData(data: TypedData): Promise<Hex> }
export type RelayBody =
  | { kind: "request"; sender: Address; requestType: number; payload: Hex; tokenAddress: Address; assetAmount: string; deadline: string; signature: Hex; permit: Hex }
  /** Base USDC into the vault: the owner's permit (65 bytes) to the vault for exactly `amount`, sent by the relayer. */
  | { kind: "base-deposit"; owner: Address; amount: string; deadline: string; permit: Hex };
export type RelayAnswer =
  | { ok: true; status: number; txHash: Hex; requestId?: Hex; block?: number; facilitator?: Address; duplicate?: boolean }
  | { ok: false; status: number; code: string; message: string; retryAfter?: number; txHash?: Hex };
export interface Relay { post(body: RelayBody): Promise<RelayAnswer> }
export type AuthContext = { block: bigint; nonce: bigint; timestamp: bigint; teeSigner: Address; enclaveKey: Hex };
/** Base, read just before the deposit permit is signed. */
export type BaseContext = { block: bigint; timestamp: bigint; permitNonce: bigint; balance: bigint };
export type Settled = { roundId: Hex; outcome: number };
export type Submission = { requestId: Hex; block: bigint; txHash: Hex };
export type Completion = { requestId: Hex; status: number; errorCode: number; errorMessage: string; txHash: Hex; block: bigint; ciphertexts: Uint8Array[]; tick: Hex | null };
export type Logged = { requestId: Hex; block: bigint; txHash: Hex; ciphertexts: Uint8Array[] };
export interface Chain {
  /** One batch at the latest block, read just before signing. */
  context(sender: Address): Promise<AuthContext>;
  /** Where a signed request went, at the latest block: its submission (a submitRequestFor carrying `signature`, since `fromBlock`)
   * once the sender's request nonce moved past `nonce`; "absent" once it can never be submitted (the nonce unchanged in a block past
   * the deadline, or used by another signature well past it); "pending" before either. Never decided from a relayer's answer:
   * `txHash`, the transaction the relayer named, is only read first, as where to look. */
  settle(sender: Address, signature: Hex, nonce: bigint, deadline: bigint, fromBlock: bigint, txHash?: Hex): Promise<Submission | "pending" | "absent">;
  completion(requestId: Hex, fromBlock: bigint): Promise<Completion | null>;
  /** Requests the account has sent, to any application, as of the latest block, and that block's number. */
  sent(account: Address): Promise<{ head: bigint; total: bigint }>;
  /** Receipts of the account's requests in blocks `from` to `to`, in chain order. Ranges are read newest first, a few a second,
   * until `want` requests are found (older blocks then hold none) or `stop()` says to (the read then throws). `head` bounds the
   * receipt reads above `to`. */
  history(account: Address, range: { from: bigint; to: bigint; head: bigint; want: bigint }, stop?: () => boolean): Promise<Logged[]>;
  /** Horizen's latest block number. */
  head(): Promise<bigint>;
  /** Base USDC in the account's own wallet (its deposit address). */
  wallet(account: Address): Promise<bigint>;
  baseContext(owner: Address): Promise<BaseContext>;
  /** The vault's first Deposited event for `owner` since Base block `fromBlock`. */
  deposited(owner: Address, fromBlock: bigint): Promise<{ index: bigint; txHash: Hex } | null>;
  /** The deposit record has reached the Horizen inbox. */
  arrived(index: bigint): Promise<boolean>;
  /** The guest's `credit` event for this Base deposit index since Horizen block `fromBlock` (within the last 1,000 blocks): 1 credited, 2 refunded. */
  credited(index: bigint, fromBlock: bigint): Promise<{ status: number; amount: bigint } | null>;
  /** The guest's `payout` event for this ordinal since Horizen block `fromBlock` (within the last 1,000 blocks). */
  approved(ordinal: bigint, fromBlock: bigint): Promise<boolean>;
  /** The vault's Paid transaction for this ordinal since Base block `fromBlock`. */
  paid(ordinal: bigint, fromBlock: bigint): Promise<Hex | null>;
  /** Resolve and void `settle` events of these engine rounds since Horizen block `fromBlock` (within the last 1,000 blocks). */
  settled(roundIds: Hex[], fromBlock: bigint): Promise<Settled[]>;
  /** The read API's page of the account's requests with their receipts, newest first, below `before`; null to read the chain.
   * Display only (indexedChain). */
  requests?(account: Address, before?: { block: number; logIndex: number }, limit?: number): Promise<AccountPage | null>;
}
export interface HintStore { get(key: string): string | null; set(key: string, value: string): void }

export type View = NonNullable<ReceiptBody["view"]>;
type Outcome = NonNullable<ReceiptBody["outcome"]>;
export type Phase = "signing" | "sending" | "submitted" | "waiting" | "staged" | "matching" | "collecting" | "done" | "refused" | "failed";
/** `chain` names where `tx` is: Horizen unless it is a Base transaction. */
export type ActionState = { id: number; action: string; phase: Phase; text: string; tx?: Hex; chain?: 8453 | 26514; /** Deposit only: stages done of Sent on Base, Reached Horizen, Credited. */ stage?: 1 | 2 | 3; startedAt: number; final: boolean };
type Step = (phase: Phase, text: string, tx?: Hex, chain?: 8453 | 26514, stage?: 1 | 2 | 3) => void;
/** A request the chain shows submitted: its line, where it went, and the context it was signed with. */
type Submitted = { step: Step; submission: Submission; ctx: AuthContext };
export type HistoryEntry = { requestId: Hex; block: bigint; txHash: Hex; text: string; readable: boolean };
export type Order = { roundStart: number; outcome: "up" | "down"; side: "buy" | "sell"; price: number; quantity: number; tif: "ioc" | "gtc"; expiry: number };

const DEADLINE_SECONDS = 120n;
const STILL_WAITING = "Still waiting for the operator. Nothing is resent; your request is on chain.";
const OUTCOME_UNKNOWN = "Outcome unknown — checking the chain";
const NETWORK_BUSY = "Waiting (network busy)";
const NETWORK_DOWN = "The network is busy. Nothing was sent. Try again in a minute.";
export const NOT_SUBMITTED = "The request could not be sent. Nothing was submitted.";
export const KEY_CHANGED = "Your wallet produced a different private key than before. Private records stay unreadable until this is resolved.";
const DEPOSIT_DEADLINE = 1_200n, MONEY_WAIT = 900_000;
const LOCKED = "Your private account was locked.";
const RESULTS_UNREAD = "Round results could not be read. Trying again.";
/** How a Base deposit ended for now: "pending" when this page stopped waiting before the credit (a slower check carries on). */
export type DepositResult = "credited" | "pending" | "refunded";
const usd = (atoms: number | bigint) => `${formatUnits(BigInt(atoms), 6)} USDC`;
/** A failure the user can read: no internal detail, no secret. */
export class PublicError extends Error {
  readonly code: string; readonly retryAfter?: number;
  constructor(message: string, code = "", retryAfter?: number) { super(message); this.code = code; this.retryAfter = retryAfter; }
}

const RELAY_TEXT: Record<string, string> = {
  BAD_REQUEST: "The request was malformed.", UNSUPPORTED_REQUEST: "This request is not supported.", UNAUTHENTICATED: "Sign in again to continue.",
  ORIGIN_NOT_ALLOWED: "Requests are accepted only from the ZEDGE site.", NOT_INVITED: "Private trading is invite-only for now.", SENDER_NOT_LINKED: "This wallet is not linked to your sign-in.",
  SIGNATURE_MISMATCH: "Your signature did not match the request. Try again.", IN_FLIGHT: "Another request from this account is still being sent.",
  DEADLINE_OUT_OF_RANGE: "The request expired before it was sent. Try again.", SIMULATION_REVERTED: "The exchange would refuse this request.", GAS_ABOVE_CAP: "This request costs more than ZEDGE pays for.",
  RATE_LIMITED: "Too many requests.", QUEUE_BUSY: "The exchange queue is busy.", BUDGET_EXHAUSTED: "ZEDGE's network-fee budget for today is used up.",
  RELAYER_UNFUNDED: "ZEDGE's relayer is not available.", FEE_ABOVE_CAP: "Deposits are paused while network fees are unusually high. Your USDC stays in your wallet.", STORE_UNAVAILABLE: "ZEDGE's relayer is not available.",
  RPC_UNAVAILABLE: "The network is unavailable.", REVERTED: "The network refused the request.",
  PERMIT_MISMATCH: "Your token permit did not match. Try again.", AMOUNT_ABOVE_BALANCE: "Your wallet holds less than this deposit.",
  AMOUNT_OUT_OF_RANGE: "This deposit is outside the allowed amounts.", DAILY_LIMIT: "You have reached today's deposit limit. Try again tomorrow.",
};
/** A refusal the relayer gave before anything could be sent. Every other answer (lost, unreadable, a send error) is settled from the chain. */
export const refusedBeforeSending = (answer: RelayAnswer): answer is Extract<RelayAnswer, { ok: false }> => !answer.ok && Object.hasOwn(RELAY_TEXT, answer.code);
export function relayText(answer: { code: string; retryAfter?: number }, now = Date.now()): string {
  const base = RELAY_TEXT[answer.code] ?? "ZEDGE's relayer refused the request.";
  if (!answer.retryAfter || !["RATE_LIMITED", "QUEUE_BUSY", "BUDGET_EXHAUSTED"].includes(answer.code)) return base;
  if (answer.retryAfter <= 120) return `${base} Try again in ${Math.ceil(answer.retryAfter)}s.`;
  const at = new Date(now + answer.retryAfter * 1000);
  return `${base} Try again at ${String(at.getUTCHours()).padStart(2, "0")}:${String(at.getUTCMinutes()).padStart(2, "0")} UTC.`;
}

const isInt = (v: unknown, max = 1e15) => typeof v === "number" && Number.isSafeInteger(v) && v >= 0 && v <= max;
const isText = (v: unknown, max = 128) => typeof v === "string" && v.length <= max;
/** The private view from a decrypted receipt, checked field by field; anything else is treated as unreadable. */
export function readView(value: unknown): View | null {
  if (value === undefined) return null;
  const v = value as View;
  const ok = v && typeof v === "object" && isText(v.account, 42) && isInt(v.sequence) && isInt(v.nonce) && isInt(v.cash) && isInt(v.reservedCash) &&
    Array.isArray(v.holdings) && v.holdings.length <= 128 && v.holdings.every((h) => h && isText(h.roundId, 64) && [h.up, h.down, h.reservedUp, h.reservedDown].every((x) => isInt(x))) &&
    Array.isArray(v.orders) && v.orders.length <= 64 && v.orders.every((o) => o && isText(o.id) && isText(o.roundId, 64) && (o.outcome === "up" || o.outcome === "down") && (o.side === "buy" || o.side === "sell") &&
      isInt(o.price, 99) && o.price >= 1 && [o.original, o.remaining, o.filled, o.filledNotional, o.feePaid, o.reservedCash, o.expiry].every((x) => isInt(x))) && Array.isArray(v.withdrawals);
  if (!ok) throw new PublicError("Your private record could not be read.");
  return v;
}
/** What happened to a staged book command, in the drawer's words. */
export function describeOutcome(outcome: ReceiptBody["outcome"] | undefined, quantity: number): { phase: Phase; text: string } {
  if (!outcome) return { phase: "done", text: "Applied" };
  if (outcome.status === "rejected") return { phase: "refused", text: `Refused: ${outcome.reason ?? "no reason given"}` };
  const r = outcome.receipt, filled = (r?.fills ?? []).reduce((sum, f) => sum + f.quantity, 0);
  if (!r) return { phase: "done", text: "Applied" };
  if (r.status === "filled" || (filled > 0 && filled >= quantity)) return { phase: "done", text: "Filled" };
  if (filled > 0) return { phase: "done", text: r.status === "resting" ? "Partly filled · rest resting" : "Partly filled" };
  if (r.status === "resting") return { phase: "done", text: "Resting" };
  if (r.status === "ioc_complete") return { phase: "done", text: "Not filled: nothing at this price or better" };
  if (r.status === "self_trade_cancelled") return { phase: "done", text: "Cancelled: it would have traded with your own order" };
  return { phase: "done", text: "Applied" };
}
/** A placed order's result when its outcome came back without its receipt (a settlement sweep replaced the stored one, guest §9):
 * the fills are the change in the order round's shares of that outcome, and a new order in the view is its rest. Read right after
 * activation only, while the round is open and no sweep can touch it.
 * Known limit: a maker fill of another of this account's orders in the same round, outcome and tick is counted in too. */
export function inferReceipt(before: View | null, after: View | null, order: { roundId?: string; outcome?: string }): Outcome["receipt"] {
  const shares = (v: View | null) => (v?.holdings ?? []).filter((h) => h.roundId === order.roundId).reduce((n, h) => n + (order.outcome === "up" ? h.up + h.reservedUp : h.down + h.reservedDown), 0);
  const quantity = Math.abs(shares(after) - shares(before)), rests = (after?.orders ?? []).some((o) => !before?.orders.some((b) => b.id === o.id));
  return { sequence: 0, status: rests ? "resting" : "ioc_complete", fills: quantity ? [{ orderId: "", role: "taker", side: "", roundId: order.roundId ?? "", outcome: order.outcome ?? "", price: 0, quantity, fee: 0 }] : [] };
}
const fillsText = (fills: NonNullable<NonNullable<Outcome["receipt"]>["fills"]>) => `Filled · ${fills.map((f) => `${f.side} ${f.quantity / 1e6} ${f.outcome} at ${f.price}¢`).join(", ")}`;
/** Shares (atoms) a buy of `pay` atoms can take at `price` cents, in whole lots. Notional = floor(quantity / 100) · price. */
export function sharesFor(pay: number, price: number): number {
  if (!isInt(pay) || !isInt(price, 99) || price < 1) return 0;
  return Math.floor(pay * 100 / price / 1000) * 1000;
}

/** `wallet`: Base USDC at the account's own address, ready to deposit. `historyMore`: History has older blocks to read ("Load older"),
 * and `historyHours` is how far back it has read. `behind`: a deposit was credited after the last view was read, so the balance
 * shown is short until the next sync. `cached`: `view` is the newest readable receipt the read API had, shown read-only while the
 * unlock sync runs; `unlocked` is still false. */
export type Snapshot = { unlocked: boolean; registered: boolean; view: View | null; fingerprint: string | null; actions: ActionState[]; history: HistoryEntry[]; historyMore: boolean; historyHours: number; wallet: bigint | null; error: string; behind: boolean; cached: boolean };
/** One History page: about six hours of Horizen's ~1 s blocks. */
export const HISTORY_PAGE = 21_600n;

export class PrivateAccount {
  readonly account: Address;
  #session: EvaluationSession;
  #queue: Promise<unknown> = Promise.resolve();
  #state: Snapshot = { unlocked: false, registered: false, view: null, fingerprint: null, actions: [], history: [], historyMore: false, historyHours: 0, wallet: null, error: "", behind: false, cached: false };
  /** History read so far: blocks `oldest` to `head`, the account's requests there in chain order, and its request count at `head`. */
  #scan: { head: bigint; oldest: bigint; total: bigint; logged: Logged[] } | null = null;
  /** History from the read API instead: its entries newest first, each with its log index (the next page's cursor), and whether
   * older requests exist. */
  #indexed: { items: { entry: HistoryEntry; logIndex: number }[]; more: boolean } | null = null;
  /** An unlock is waiting for its sync: only then may a cached view be shown. */
  #unlocking = false;
  #actionId = 0;
  #closed = false;
  /** Rounds whose result line was shown. */
  readonly #reported = new Set<string>();
  /** Ended rounds that got their one sync without a readable result. */
  readonly #synced = new Set<string>();
  /** Results reads after a failure: the next one not before `#resultsAfter`, each wait twice the last; the line saying so. */
  #resultsAfter = 0; #resultsWait = 0; #resultsLine = 0;
  /** When the last fresh receipt was read. */
  #readAt = 0;
  /** Book commands waiting for their result, by command ID: it comes back once, with whichever request of this account is next. */
  readonly #awaiting = new Map<string, (outcome: Outcome) => void>();
  readonly #book: Book; readonly #signer: Signer; readonly #chain: Chain; readonly #relay: Relay;
  readonly #hints: HintStore | null; readonly #onChange: (s: Snapshot) => void; readonly #now: () => number; readonly #sleep: (ms: number) => Promise<void>;

  constructor(book: Book, signer: Signer, chain: Chain, relay: Relay, options: { hints?: HintStore | null; onChange?: (s: Snapshot) => void; now?: () => number; sleep?: (ms: number) => Promise<void> } = {}) {
    this.#book = book; this.#signer = signer; this.#chain = chain; this.#relay = relay;
    this.#hints = options.hints ?? null; this.#onChange = options.onChange ?? (() => {}); this.#now = options.now ?? Date.now;
    this.#sleep = options.sleep ?? ((ms) => new Promise((resolve) => setTimeout(resolve, ms)));
    this.account = signer.address.toLowerCase() as Address;
    const a = book.application;
    // The origin is the manifest's, not this page's: the key is the same on every host that serves this release.
    const domain: EvaluationDomain = { chainId: 26514, endpoint: book.endpoint.address, applicationId: a.id, applicationFingerprint: a.wasmSha256, rulesHash: a.sessionRulesHash, origin: a.origin };
    this.#session = new EvaluationSession(domain, this.account, { id: a.epoch, enclavePublicKey: book.authenticator.enclavePublicKey });
  }

  get snapshot(): Snapshot { return this.#state; }
  #set(patch: Partial<Snapshot>) { this.#state = { ...this.#state, ...patch }; if (!this.#closed) this.#onChange(this.#state); }
  #action(action: string): Step {
    const id = ++this.#actionId, startedAt = this.#now();
    return (phase, text, tx, chain, stage) => {
      const prior = this.#state.actions.find((x) => x.id === id);
      const next: ActionState = { id, action, phase, text, tx: tx ?? prior?.tx, chain: tx ? chain : prior?.chain, stage: stage ?? prior?.stage, startedAt, final: ["done", "refused", "failed"].includes(phase) };
      this.#set({ actions: [next, ...this.#state.actions.filter((x) => x.id !== id)].slice(0, 12) });
    };
  }
  /** One request in flight per account: the facilitator nonce is sequential and the guest freezes an account holding a staged command. */
  #serial<T>(work: () => Promise<T>): Promise<T> {
    const run = this.#queue.then(work, work);
    this.#queue = run.catch(() => undefined);
    return run;
  }

  /** Lock on sign-out, account change and tab close. Drops the key; in-flight work stops at its next step. */
  lock() { this.#closed = true; this.#session.lock(); }
  #alive() { if (this.#closed) throw new PublicError(LOCKED, "LOCKED"); }

  /** Derive the key with one silent signature, then sync; register the key only if the chain has none for this account. */
  unlock(): Promise<void> { return this.#serial(() => this.#unlock()); }

  async #unlock() {
    const signer = { getAddress: async () => this.account, signMessage: (message: string | Uint8Array) => {
      if (typeof message !== "string") throw new Error("Unexpected key challenge.");
      return this.#signer.signMessage(message);
    } } as unknown as EthersSigner;
    await this.#session.unlock(signer);
    const fingerprint = sha256(await this.#session.associationPayload()).slice(2);
    const hintKey = `zedge:key:${this.#book.application.id}:${this.account}`;
    const hint = this.#hints?.get(hintKey) ?? null;
    if (hint && hint !== fingerprint) { this.#session.lock(); throw new PublicError(KEY_CHANGED); }
    this.#set({ fingerprint: fingerprint.slice(0, 16), error: "" });
    const register = async () => (await this.#send("Register key", ASSOCIATEKEY, toHex(await this.#session.associationPayload()))).step("done", "Key registered");
    this.#unlocking = true;
    void this.#cachedView().catch(() => undefined);
    try {
      // Keys live in the operator's state, not on chain. But an account whose request nonce is still 0 has never sent a request, so it
      // has no key: it registers first instead of sending a sync that can only fail (one relayed request and ~20 s less to set up).
      if (!hint && await this.#chain.context(this.account).then((c) => c.nonce === 0n, () => false)) await register();
      // Unlocked only once the key is registered and the first view is in: a refused first request leaves Set up / Unlock in place.
      try { await this.#sync("Unlock"); }
      catch (error) {
        if (!(error instanceof PublicError) || error.code !== "NO_KEY") throw error;
        await register();
        await this.#sync("Unlock");
      }
    } finally {
      this.#unlocking = false;
      // A cached view still shown here was never replaced by a fresh one: the unlock failed, so it goes.
      if (this.#state.cached) this.#set({ view: null, cached: false });
    }
    this.#hints?.set(hintKey, fingerprint);
    this.#set({ unlocked: true, registered: true });
  }

  /** While the unlock sync runs: the view in the newest of this account's receipts the read API has that this key opens, shown
   * read-only (`cached`). Display only: `unlocked` stays false, and it is not a fresh read (#readAt), so it suppresses no sync. */
  async #cachedView() {
    const page = await this.#chain.requests?.(this.account, undefined, 10);
    for (const r of page?.requests ?? []) {
      for (const ciphertext of r.ciphertexts) {
        const o = await this.#session.openReceipt(ciphertext);
        let view: View | null = null;
        try { view = o.status === "readable" ? readView((o.envelope.body as ReceiptBody).view) : null; } catch { /* unreadable: the next one */ }
        if (!view) continue;
        const held = this.#state.view;
        // Never over a fresh view: the sync may have landed first.
        if (this.#unlocking && !this.#closed && (!held || view.sequence > held.sequence)) this.#set({ view, cached: true });
        return;
      }
    }
  }

  sync(): Promise<ReceiptBody> { return this.#serial(() => this.#sync("Sync")); }

  /** The Portfolio's refresh on opening. Every sync is a public request, so one is sent only when something could have changed
   * without this account (a resting order filled, an ended round swept) and no receipt was read in the last minute. */
  async refresh(): Promise<void> {
    const v = this.#state.view;
    if (!v || (!v.orders.length && !v.holdings.length) || this.#now() - this.#readAt < 60_000) return;
    await this.sync();
  }

  async #sync(label: string): Promise<ReceiptBody> { return this.#syncDone(await this.#sendSync(label)); }
  /** A sync signed and relayed; `ctx`: signed right behind another request of this account (see #submit). */
  async #sendSync(label: string, ctx?: AuthContext) {
    const id = syncRequestId(this.account);
    return this.#submit(label, PROCESS, toHex(await this.#session.encryptCommand(id, padBody(this.#session, id, syncBody()))), ctx);
  }
  /** A relayed sync's completion and the view in its receipt. */
  async #syncDone(sent: Submitted): Promise<ReceiptBody> {
    const done = await this.#finish(sent);
    const { body } = await this.#open(done.completion, [syncRequestId(this.account)]);
    done.step("done", "Up to date");
    return body;
  }

  /** Signs and relays one request, then waits for the operator. A FAILED completion throws its public error. */
  async #send(label: string, requestType: typeof PROCESS | typeof ASSOCIATEKEY, payload: Hex) {
    return this.#finish(await this.#submit(label, requestType, payload));
  }

  /** Signs and relays one request, and follows it until the chain shows it submitted. `given`: the context of this account's
   * request just submitted, with the nonce after it, so a request can follow another without a new read. */
  #submit(label: string, requestType: typeof PROCESS | typeof ASSOCIATEKEY, payload: Hex, given?: AuthContext) {
    const step = this.#action(label);
    return this.#failing(step, async () => {
      step("signing", "Signing");
      // A busy RPC (a 429 and this page's cooldown) is waited out, as #landed does; nothing is signed before the read succeeds.
      const ctx = given ?? await this.#poll(() => this.#chain.context(this.account), this.#now() + 90_000);
      if (!ctx) throw new PublicError(NETWORK_DOWN, "NETWORK_BUSY");
      this.#alive();
      // The operator keys are read in the same batch as the nonce: a changed executor key stops every signature.
      if (ctx.teeSigner.toLowerCase() !== this.#book.authenticator.teeSigner || ctx.enclaveKey.toLowerCase() !== this.#book.authenticator.enclavePublicKey) throw new PublicError(OPERATOR_KEYS_CHANGED);
      const deadline = ctx.timestamp + DEADLINE_SECONDS;
      // No asset rides on a request: money moves only through the Base vault.
      const signature = await this.#signed(requestTypedData(this.#book, { sender: this.account, requestType, payload, tokenAddress: ZERO_ADDRESS, assetAmount: 0n, nonce: ctx.nonce, deadline }));
      step("sending", "Sending");
      const answer = await this.#relay.post({ kind: "request", sender: this.account, requestType, payload, tokenAddress: ZERO_ADDRESS, assetAmount: "0", deadline: deadline.toString(), signature, permit: "0x" });
      if (refusedBeforeSending(answer)) throw new PublicError(relayText(answer, this.#now()), answer.code, answer.retryAfter);
      if (!answer.ok) step("sending", OUTCOME_UNKNOWN);
      const submission = await this.#landed(ctx, signature, deadline, step, answer.txHash);
      step("submitted", `Submitted · ${submission.txHash.slice(0, 10)}…`, submission.txHash);
      return { step, submission, ctx };
    });
  }

  /** Waits for the operator on a submitted request. A FAILED completion throws its public error. */
  #finish({ step, submission }: Submitted) {
    return this.#failing(step, async () => {
      const completion = await this.#completion(submission.requestId, submission.block, step);
      if (completion.status !== 0) {
        // PUB_KEY_NOT_REGISTERED: the one public failure the client recovers from, by registering its key.
        if (completion.errorCode === 9) { step("done", "No key registered yet"); throw new PublicError("Your private key is not registered.", "NO_KEY"); }
        throw new PublicError(`Failed: ${completion.errorMessage || "the operator refused the request"}`, "FAILED");
      }
      return { completion, step, submission };
    });
  }

  /** A request's failure, on its own line and as a PublicError. */
  async #failing<T>(step: Step, work: () => Promise<T>): Promise<T> {
    try { return await work(); }
    catch (error) {
      if (!(error instanceof PublicError)) console.warn("ZEDGE request failed", error);
      const message = error instanceof PublicError ? error.message : "The request could not complete.";
      if (!(error instanceof PublicError && error.code === "NO_KEY")) step("failed", message);
      throw error instanceof PublicError ? error : new PublicError(message);
    }
  }

  async #signed(typed: TypedData): Promise<Hex> {
    const signature = normalizeSignature(await this.#signer.signTypedData(typed));
    // Recovered here, before anything leaves the browser: a wallet that hashed other data fails now, with a clear message.
    if ((await recoverTypedDataAddress({ ...typed, signature } as Parameters<typeof recoverTypedDataAddress>[0])).toLowerCase() !== this.account) {
      throw new PublicError("Your wallet signed something other than this request. Nothing was sent.");
    }
    return signature;
  }

  /** Where the signed request went, from the chain alone, whatever the relayer answered (or did not): its submission, or proof that
   * it never will be. Nothing is signed again here, and a failed read is waited out. `txHash`, the relayer's transaction, is
   * read first, once: only where to look. */
  async #landed(ctx: AuthContext, signature: Hex, deadline: bigint, step: (phase: Phase, text: string) => void, txHash?: Hex): Promise<Submission> {
    const started = this.#now();
    for (;;) {
      this.#alive();
      const found = await this.#chain.settle(this.account, signature, ctx.nonce, deadline, ctx.block, txHash).catch(() => null);
      txHash = undefined;
      if (found === "absent") throw new PublicError(NOT_SUBMITTED, "NOT_SUBMITTED");
      if (found && found !== "pending") return found;
      if (this.#now() - started > 1_800_000) throw new PublicError("Whether the request was submitted is still unknown. Check History before trying again.");
      if (!found) step("sending", NETWORK_BUSY);
      await this.#sleep(2_000);
    }
  }

  async #completion(requestId: Hex, fromBlock: bigint, step: (phase: Phase, text: string) => void, limit = 1_800_000): Promise<Completion> {
    const started = this.#now();
    step("waiting", "Waiting for the operator");
    for (;;) {
      this.#alive();
      // A failed read is waited out like a slow operator: the request is on chain whatever this page can read.
      let done: Completion | null = null, busy = false;
      try { done = await this.#chain.completion(requestId, fromBlock); } catch { busy = true; }
      if (done) return done;
      const elapsed = this.#now() - started;
      if (elapsed > limit) throw new PublicError(STILL_WAITING);
      step("waiting", busy ? NETWORK_BUSY : elapsed > 300_000 ? STILL_WAITING : `Waiting for the operator · ${Math.round(elapsed / 1000)}s`);
      // Every second at first: an operator transition takes about 3 s and blocks come every second.
      await this.#sleep(elapsed < 30_000 ? 1_000 : elapsed < 120_000 ? 3_000 : 5_000);
    }
  }

  /** Trial-decrypts every receipt of the completion; never filters by subtype. A receipt older than the view already held (every
   * sync shares one ID) is a replay from the network and is not read. */
  async #open(completion: Completion, ids: string[]): Promise<{ body: ReceiptBody; id: string }> {
    let stale = false;
    for (const ciphertext of completion.ciphertexts) {
      for (const id of ids) {
        const r = await this.#session.decryptReceipt(ciphertext, id);
        if (r.status === "readable") {
          const body = r.envelope.body as ReceiptBody;
          const view = readView(body.view), held = this.#state.view;
          if (view && held && (view.sequence < held.sequence || view.nonce < held.nonce)) { stale = true; break; }
          if (view) this.#set({ view, registered: true, behind: false, cached: false });
          this.#readAt = this.#now();
          if (body.outcome) this.#collected(body.outcome);
          return { body, id };
        }
        if (r.status === "locked") throw new PublicError(LOCKED);
      }
    }
    throw new PublicError(stale ? "The network returned an older record than the one already read. Try again later." : "Your receipt could not be read with this key.");
  }

  /** A book command's result, collected by any request of this account: it finishes the line of the command that is waiting for it,
   * or, for a command of an earlier session or one that stopped waiting, gets a line of its own. */
  #collected(outcome: Outcome) {
    const waiting = this.#awaiting.get(outcome.commandId);
    if (waiting) { this.#awaiting.delete(outcome.commandId); return waiting(outcome); }
    const fills = outcome.receipt?.fills ?? [];
    const f = describeOutcome(outcome, 0);
    this.#action("Order result")(f.phase, outcome.status === "applied" && fills.length ? fillsText(fills) : f.text);
  }

  #command(fields: Omit<EngineCommand, "domain" | "id" | "nonce" | "account">): EngineCommand {
    const view = this.#state.view;
    // An account the engine has not registered has no view; its one possible command is `register` with nonce 1.
    if (!view && fields.op !== "register") throw new PublicError("Unlock your private account first.");
    // The next nonce is always the latest view's: the settlement sweep spends nonces in the account's own name.
    const nonce = (view?.nonce ?? 0) + 1;
    return { domain: this.#book.application.engine.domain, id: commandId(this.account, nonce), nonce, account: this.account, ...fields };
  }

  /** A direct command (applied at once) or a book command (staged, activated by its tick, outcome collected by a sync). */
  #run(label: string, fields: Omit<EngineCommand, "domain" | "id" | "nonce" | "account">, book: boolean, quantity = 0): Promise<ReceiptBody> {
    return this.#serial(async () => {
      for (let attempt = 0; ; attempt++) {
        const c = this.#command(fields), before = this.#state.view;
        // A book command's result comes back with this account's next request of any kind: with this very one when an earlier
        // attempt under the same ID was applied (its answer lost), which then stops here instead of signing again.
        let outcome: Outcome | undefined;
        const capture = (o: Outcome) => { outcome = o; };
        if (book) this.#awaiting.set(c.id, capture);
        let piped: Promise<Submitted | null> | null = null;
        try {
          const sent = await this.#submit(label, PROCESS, toHex(await this.#session.encryptCommand(c.id, padBody(this.#session, c.id, commandBody(c)))));
          // A book command's collect sync goes out as soon as the command is submitted, at the next request nonce: the operator
          // serves ticks first, so it runs the command, its tick and the sync back to back, and the sync's receipt brings the result.
          // A sync that cannot go out now leaves the collection to after the tick, as before.
          // Simplification: if the command's own wait fails, the piped sync's receipt is not read here (see finally).
          piped = book ? this.#sendSync("Collect result", { ...sent.ctx, nonce: sent.ctx.nonce + 1n }).catch(() => null) : null;
          /** The piped sync's receipt, read once; null when none went out. */
          const collect = async () => { const p = await piped; piped = null; return p && this.#syncDone(p); };
          const done = await this.#finish(sent);
          let { body } = await this.#open(done.completion, [c.id]);
          // The one automatic retry: a nonce the sweep spent. A fresh signature, never a resend.
          if (!outcome && body.status === "rejected" && attempt === 0 && /replayed, conflicting or out-of-order nonce/.test(body.reason ?? "")) {
            done.step("refused", "Refused: nonce out of date, signing again");
            body = await collect() ?? await this.#sync("Sync");
            if (!outcome) continue;
          }
          if (!outcome && (!book || body.status !== "staged")) {
            done.step(body.status === "rejected" ? "refused" : "done", body.status === "rejected" ? `Refused: ${body.reason ?? "no reason given"}` : body.status === "retry" ? "Applied (already applied)" : "Applied");
            await collect().catch(() => null);
            return body;
          }
          if (!outcome) {
            done.step("staged", "Staged");
            done.step("matching", "Matching");
            // A tick that never completes (the endpoint drops a trigger that reverts) is not waited on for long: the collect sync's own tick activates the command.
            if (done.completion.tick) await this.#completion(done.completion.tick, done.completion.block, (_phase, text) => done.step("matching", text === "Waiting for the operator" ? "Matching" : text), 120_000).catch(() => undefined);
            done.step("collecting", "Collecting result");
            // At most two collect syncs, the piped one included.
            body = await collect() ?? await this.#sync("Collect result");
            if (!outcome) body = await this.#sync("Collect result");
          }
          if (!outcome) {
            // Still staged, or collected by another session: never shown as applied. It finishes this line when it comes back.
            this.#awaiting.set(c.id, (o) => { const f = describeOutcome(o, quantity); done.step(f.phase, f.text); });
            done.step("collecting", "Result not back yet · it comes with your next request");
            return body;
          }
          const o: Outcome = outcome;
          const final = describeOutcome(o.receipt || o.status !== "applied" || c.op !== "place_order" ? o : { ...o, receipt: inferReceipt(before, this.#state.view, c) }, quantity);
          done.step(final.phase, final.text);
          // A result that came with the command's own receipt leaves the piped sync unread: it still brings the newer view.
          await collect().catch(() => null);
          return { ...body, outcome: o };
        } finally {
          // Nobody reads `outcome` past here: a result that comes later gets a line of its own.
          if (this.#awaiting.get(c.id) === capture) this.#awaiting.delete(c.id);
          // A failure left the piped sync unread: until it is on chain or refused, the next request would sign at its nonce.
          await piped;
        }
      }
    });
  }

  /** Opens the account in the engine before any money is sent, so a full exchange (`account capacity`) is known first.
   * Nothing to do once the account has a view. */
  async register(): Promise<ReceiptBody | null> {
    if (this.#state.view) return null;
    return this.#run("Register account", { op: "register" }, false);
  }

  placeOrder(o: Order) {
    const round = engineRound(this.#book, o.roundStart);
    if (o.expiry > round.spec.cutoff) throw new PublicError("Orders can rest only until the round's cutoff.");
    return this.#run(`${o.side === "buy" ? "Buy" : "Sell"} ${o.outcome === "up" ? "Up" : "Down"}`, { op: "place_order", roundId: round.id, outcome: o.outcome, side: o.side, price: o.price, quantity: o.quantity, tif: o.tif, expiry: o.expiry }, true, o.quantity);
  }
  cancelOrder(orderId: string) { return this.#run("Cancel order", { op: "cancel_order", orderId }, true); }
  cancelAll(roundStart: number) { return this.#run("Cancel all", { op: "cancel_all", roundId: engineRound(this.#book, roundStart).id }, true); }
  mint(roundStart: number, quantity: number) { return this.#run("Mint", { op: "mint", roundId: engineRound(this.#book, roundStart).id, quantity }, false); }
  merge(roundStart: number, quantity: number) { return this.#run("Merge", { op: "merge", roundId: engineRound(this.#book, roundStart).id, quantity }, false); }
  redeem(roundStart: number) { return this.#run("Redeem", { op: "redeem", roundId: engineRound(this.#book, roundStart).id }, false); }

  /** Polls a chain read every `every` ms until it answers, or null once `until` (this clock) passes. A failed read is waited out;
   * a lock stops it. */
  async #poll<T>(read: () => Promise<T | null | false>, until: number, every = 2_000): Promise<T | null> {
    for (;;) {
      this.#alive();
      const value = await read().catch(() => null);
      if (value) return value;
      if (this.#now() > until) return null;
      await this.#sleep(every);
    }
  }

  /** One-click deposit: a silent Base USDC permit to the vault, sent by the relayer (no gas from the user). Then the record's way,
   * from the chain alone: Sent on Base, On its way (the Horizen inbox), Credited or Refunded (the guest's `credit` event).
   * Resolves once credited (and the account unlocked and synced), refunded, or "pending" when this page stopped waiting. */
  depositFromBase(amount: bigint): Promise<DepositResult> {
    // Not queued behind Horizen requests: a Base deposit uses no request nonce and needs no unlock (the engine registers a new
    // account on its first credit), so a stuck unlock or a Horizen halt cannot hold it.
    return (async () => {
      const c = this.#book.custody, min = BigInt(c.vault.limits.minDeposit), max = BigInt(c.vault.limits.maxDeposit);
      if (amount < min || amount > max) throw new PublicError(`Deposits are ${usd(min)} to ${usd(max)}.`);
      const step = this.#action("Deposit");
      try {
        step("signing", "Signing");
        const ctx = await this.#poll(() => this.#chain.baseContext(this.account), this.#now() + 90_000);
        if (!ctx) throw new PublicError(NETWORK_DOWN, "NETWORK_BUSY");
        if (ctx.balance < amount) throw new PublicError("Your wallet holds less than this deposit.");
        const deadline = ctx.timestamp + DEPOSIT_DEADLINE;
        const permit = await this.#signed(usdcPermitTypedData(c, { owner: this.account, value: amount, nonce: ctx.permitNonce, deadline }));
        step("sending", "Sending");
        const answer = await this.#relay.post({ kind: "base-deposit", owner: this.account, amount: amount.toString(), deadline: deadline.toString(), permit });
        if (refusedBeforeSending(answer)) throw new PublicError(relayText(answer, this.#now()), answer.code, answer.retryAfter);
        if (!answer.ok) step("sending", OUTCOME_UNKNOWN);
        // The permit cannot be used past its deadline: no Deposited event by then (a minute's grace for lagging logs) means none.
        const sent = await this.#poll(() => this.#chain.deposited(this.account, ctx.block), this.#now() + Number(DEPOSIT_DEADLINE + 60n) * 1000);
        if (!sent) throw new PublicError(NOT_SUBMITTED, "NOT_SUBMITTED");
        step("submitted", "Sent on Base", sent.txHash, 8453, 1);
        step("waiting", "Reaching Horizen (about 25 s)");
        const result = await this.#credit(sent.index, step, MONEY_WAIT, 2_000);
        // This page stopped waiting, not the deposit: a check every 30 s carries on until the credit (or a lock).
        if (result === "pending") void this.#credit(sent.index, step, Infinity, 30_000).catch(() => undefined);
        return result;
      } catch (error) {
        const message = error instanceof PublicError ? error.message : "The deposit could not complete.";
        step("failed", message);
        throw error instanceof PublicError ? error : new PublicError(message);
      } finally { await this.refreshFunds().catch(() => undefined); }
    })();
  }

  /** After Sent on Base: Reached Horizen (the inbox), then Credited or Refunded (the guest's `credit` event), each read every
   * `every` ms for up to `wait` ms. A credit unlocks the account if it is not, then syncs, so its view and new balance are in. */
  async #credit(index: bigint, step: Step, wait: number, every: number): Promise<DepositResult> {
    if (!await this.#poll(() => this.#chain.arrived(index), this.#now() + wait, every)) { step("waiting", "Still on its way. It is credited when it arrives; nothing more is needed."); return "pending"; }
    step("waiting", "Reached Horizen · crediting", undefined, undefined, 2);
    // The credit is matched by its deposit index, so any start block will do: 0 reads the last 1,000 blocks.
    const credit = await this.#poll(() => this.#chain.credited(index, 0n), this.#now() + wait, every);
    if (!credit) { step("waiting", "Reached Horizen · waiting for the exchange to credit it"); return "pending"; }
    if (credit.status !== 1) { step("refused", "Refunded: the exchange could not take this deposit. It is paid back to your wallet on Base."); return "refunded"; }
    step("done", `Credited · ${usd(credit.amount)}`, undefined, undefined, 3);
    this.#set({ behind: true });
    // A failed unlock or sync shows on its own line; the money is credited either way (and `behind` stays until a view is read).
    await this.#serial<unknown>(() => this.#state.unlocked ? this.#sync("Sync") : this.#unlock()).catch(() => undefined);
    return "credited";
  }

  /** One-click withdrawal of the trading balance (up to the vault's largest payout) to this same address on Base: Requested,
   * Approved (the guest's `payout` event), Paid on Base (the vault's Paid event). */
  async withdraw(): Promise<void> {
    const cash = this.#state.view?.cash ?? 0, amount = Math.min(cash, Number(this.#book.custody.vault.limits.maxPayout));
    if (amount <= 0) throw new PublicError("Your trading balance is empty.");
    const [baseFrom, horizenFrom] = await Promise.all([this.#chain.baseContext(this.account).then((x) => x.block), this.#chain.head()]);
    const body = await this.#run("Withdraw", { op: "request_withdrawal", amount, destination: this.account }, false);
    if (body.status !== "applied" || typeof body.withdrawal !== "number") return;
    const ordinal = BigInt(body.withdrawal), step = this.#action("Payout");
    step("waiting", `Requested · ${usd(amount)}`);
    if (!await this.#poll(() => this.#chain.approved(ordinal, horizenFrom), this.#now() + MONEY_WAIT)) return step("waiting", `Requested · ${usd(amount)} · waiting for approval`);
    step("waiting", "Approved · paying on Base");
    const tx = await this.#poll(() => this.#chain.paid(ordinal, baseFrom), this.#now() + MONEY_WAIT);
    if (!tx) return step("waiting", "Approved · the payment on Base is still pending");
    step("done", `Paid on Base · ${usd(amount)}`, tx, 8453);
    await this.refreshFunds().catch(() => undefined);
  }

  async refreshFunds() { this.#set({ wallet: await this.#chain.wallet(this.account) }); }

  /** Rounds this account holds that have ended: their result once its `settle` event is public (winners are paid in that same
   * transition), then one sync to read the new balance. The event is read from the last 1,000 Horizen blocks (settlement lands
   * 11-35 s after the end). A round whose result cannot be read (the read failed, or it ended before that window) gets one sync
   * anyway, a minute after its end. A failed read is said once, on a Round result line, and retried later each time (10 s,
   * doubling up to 2 min). */
  checkResults(): Promise<void> {
    return this.#serial(async () => {
      const view = this.#state.view, ms = this.#now(), now = Math.floor(ms / 1000);
      if (!view || ms < this.#resultsAfter) return;
      // The guest's `settle` record names a round by its registry round ID; holdings name it by the engine's.
      const ended = new Map<Hex, { id: string; h: View["holdings"][number]; end: number }>();
      for (let k = 1, last = Math.floor(now / 900) * 900; k <= 96; k++) {
        const r = engineRound(this.#book, last - k * 900), h = view.holdings.find((x) => x.roundId === r.id);
        if (h && !this.#reported.has(r.id)) ended.set(r.spec.registryRoundId.toLowerCase() as Hex, { id: r.id, h, end: r.spec.end });
      }
      if (!ended.size) return;
      // Simplification: 900 s stands for the 1,000-block window at Horizen's ~1 s blocks; an older round's event can no longer be read.
      const readable = [...ended].filter(([, e]) => now - e.end < 900).map(([key]) => key);
      let found: Settled[] = [], failed = false;
      if (readable.length) {
        try {
          found = await this.#chain.settled(readable, 0n);
          this.#resultsWait = 0;
          const line = this.#resultsLine;
          if (line) { this.#resultsLine = 0; this.#set({ actions: this.#state.actions.filter((x) => x.id !== line) }); }
        } catch {
          failed = true;
          this.#resultsWait = Math.min(this.#resultsWait * 2 || 10_000, 120_000);
          this.#resultsAfter = ms + this.#resultsWait;
          if (!this.#resultsLine) { this.#action("Round result")("waiting", RESULTS_UNREAD); this.#resultsLine = this.#actionId; }
        }
      }
      let shown = 0;
      for (const s of found) {
        const e = ended.get(s.roundId.toLowerCase() as Hex);
        if (!e || this.#reported.has(e.id)) continue;
        const { id, h } = e;
        this.#reported.add(id);
        shown++;
        const up = h.up + h.reservedUp, down = h.down + h.reservedDown;
        const paid = s.outcome === 1 ? up : s.outcome === 2 ? down : Math.floor((up + down) / 2);
        const name = s.outcome === 1 ? "Up won" : s.outcome === 2 ? "Down won" : "Round voided";
        this.#action("Round result")("done", paid ? `${name} · ${usd(paid)} credited` : `${name} · nothing to collect`);
      }
      // Not when a receipt read since then already shows the round settled.
      const due = [...ended].filter(([key, e]) => (failed || !readable.includes(key)) && !this.#reported.has(e.id) && !this.#synced.has(e.id) && now >= e.end + 60 && this.#readAt < (e.end + 60) * 1000).map(([, e]) => e);
      for (const e of due) this.#synced.add(e.id);
      if (shown || due.length) await this.#sync("Sync");
    });
  }

  /** One-click close: an IOC sell of all this account's free shares of one side in one round, at `price` or better. */
  close(roundStart: number, outcome: "up" | "down", price: number, expiry: number) {
    const id = engineRound(this.#book, roundStart).id, h = this.#state.view?.holdings.find((x) => x.roundId === id);
    const quantity = Math.floor((outcome === "up" ? h?.up ?? 0 : h?.down ?? 0) / LOT) * LOT;
    if (!quantity) throw new PublicError("Nothing to close in this round.");
    return this.placeOrder({ roundStart, outcome, side: "sell", price, quantity, tif: "ioc", expiry });
  }

  /** History in pages of HISTORY_PAGE blocks, newest first, never below `floor`: the first open reads the latest page, a reopen only
   * the blocks since (none when the request count has not moved), and `older` the page before the oldest read. Receipts are
   * decrypted once each, under any request ID of this account (display only); unmatched ones stay listed as unreadable. `stop()`
   * abandons the read (the page closed). The read API, when the chain has one, answers first, in pages of requests (#indexedHistory);
   * any failure there reads the chain. */
  async loadHistory(floor: bigint, older = false, stop: () => boolean = () => false): Promise<void> {
    const quit = () => this.#closed || stop();
    if (this.#chain.requests && (!older || this.#indexed) && (await this.#indexedHistory(floor, older, quit) || quit())) return;
    const page = (to: bigint) => ({ from: to - HISTORY_PAGE + 1n > floor ? to - HISTORY_PAGE + 1n : floor, to });
    try {
      let scan = this.#scan;
      if (older && scan) {
        // Requests older than the oldest block read: the count at the scan's head less those found.
        const want = scan.total - BigInt(scan.logged.length), range = page(scan.oldest - 1n);
        if (want > 0n && range.from <= range.to) {
          const logged = await this.#chain.history(this.account, { ...range, head: scan.head, want }, quit);
          if (quit()) return;
          scan = { ...scan, oldest: range.from, logged: [...logged, ...scan.logged] };
        }
      } else {
        const { head, total } = await this.#chain.sent(this.account);
        // Too long since the last read: start again from the latest page.
        if (scan && head - scan.head > HISTORY_PAGE) scan = null;
        const range = scan ? { from: scan.head + 1n, to: head } : page(head), want = scan ? total - scan.total : total;
        const logged = want > 0n && range.from <= range.to ? await this.#chain.history(this.account, { ...range, head, want }, quit) : [];
        if (quit()) return;
        scan = scan ? { head, total, oldest: scan.oldest, logged: [...scan.logged, ...logged] } : { head, total, oldest: range.from, logged };
      }
      this.#scan = scan;
    } catch {
      if (quit()) return;
      // A failed read is the network's, never the wallet's.
      throw new PublicError("Couldn't load your history. Try again.", "HISTORY");
    }
    const scan = this.#scan;
    if (!scan) return;
    const entries: HistoryEntry[] = [];
    for (const item of scan.logged) entries.unshift(await this.#historyEntry(item));
    // Simplification: hours from block numbers at Horizen's ~1 s blocks, as the seven-day window is.
    this.#set({ history: entries, historyMore: scan.oldest > floor && BigInt(scan.logged.length) < scan.total, historyHours: Math.round(Number(scan.head - scan.oldest + 1n) / 3600) });
  }

  /** One History line: the first of the request's receipts this key opens. */
  async #historyEntry(item: Logged): Promise<HistoryEntry> {
    let body: ReceiptBody | null = null;
    for (const ciphertext of item.ciphertexts) {
      const r = await this.#session.openReceipt(ciphertext);
      if (r.status === "readable") { body = r.envelope.body as ReceiptBody; break; }
    }
    return { requestId: item.requestId, block: item.block, txHash: item.txHash, readable: Boolean(body), text: body ? describeReceipt(body) : item.ciphertexts.length ? "Unreadable record" : "No private record" };
  }

  /** History from the read API: on opening its newest page, merged into what was read (a page that no longer reaches it starts again);
   * `older` the page below the oldest read. A readable line is never decrypted again. False when the API did not answer. */
  async #indexedHistory(floor: bigint, older: boolean, quit: () => boolean): Promise<boolean> {
    const held = this.#indexed, last = held?.items.at(-1);
    const page = await this.#chain.requests!(this.account, older && last ? { block: Number(last.entry.block), logIndex: last.logIndex } : undefined);
    if (!page) { this.#indexed = null; return false; }
    if (quit()) return true;
    const keep = held && (older || page.requests.some((r) => held.items.some((x) => x.entry.requestId === r.requestId)));
    const known = new Map((keep ? held.items : []).map((x) => [x.entry.requestId, x]));
    const within = page.requests.filter((r) => r.block >= floor);
    for (const r of within) {
      if (known.get(r.requestId)?.entry.readable) continue;
      known.set(r.requestId, { logIndex: r.logIndex, entry: await this.#historyEntry({ requestId: r.requestId, block: r.block, txHash: r.completed?.txHash ?? r.txHash, ciphertexts: r.ciphertexts }) });
      if (quit()) return true;
    }
    const items = [...known.values()].sort((a, b) => a.entry.block === b.entry.block ? b.logIndex - a.logIndex : a.entry.block < b.entry.block ? 1 : -1);
    // A reopen leaves the pages below as they were; a page reaching the seven-day floor has nothing older to show.
    const more = within.length === page.requests.length && (older || !keep ? page.more : held.more);
    this.#indexed = { items, more };
    const oldest = items.at(-1)?.entry.block ?? BigInt(page.head.block);
    this.#set({ history: items.map((x) => x.entry), historyMore: more, historyHours: Math.round(Number(BigInt(page.head.block) - oldest + 1n) / 3600) });
    return true;
  }
}

export function describeReceipt(body: ReceiptBody): string {
  if (body.type === "sync") return body.outcome ? `Order result · ${describeOutcome(body.outcome, 0).text}` : "Account synced";
  if (body.status === "rejected") return `Refused · ${body.reason ?? ""}`.trim();
  if (body.status === "staged") return "Order staged";
  const fills = body.receipt?.fills ?? [];
  if (fills.length) return fillsText(fills);
  if (body.withdrawal) return `Withdrawal · ${usd(body.receipt?.amount ?? 0)}`;
  return `Applied${body.receipt?.status ? ` · ${body.receipt.status.replace(/_/g, " ")}` : ""}`;
}

// ---------------------------------------------------------------- chain reads with viem (Horizen, and Base for the vault)

const eventsOf = (book: Book) => ({ app: BigInt(book.application.id), endpoint: book.endpoint.address });
/** thirdweb answers eth_getLogs over at most 1,000 blocks ("Maximum allowed number of requested blocks is 1000"). */
const LOG_BLOCKS = 1_000n;
/** History's reads per second: the site's Horizen proxy (api/horizen.ts) allows each visitor 300 calls per 10 s, and a public
 * endpoint far fewer, so a scan stays at a small share of either. */
const HISTORY_RATE = 5;
/** Waves of HISTORY_RATE reads, each starting at least a second after the last, until `enough()`; `stop()` abandons the scan. */
async function paced<T>(jobs: (() => Promise<T>)[], sleep: (ms: number) => Promise<void>, stop: () => boolean, enough = () => false): Promise<T[]> {
  const out: T[] = [];
  for (let i = 0; i < jobs.length && !enough(); i += HISTORY_RATE) {
    if (stop()) throw new Error("History read stopped.");
    const started = Date.now();
    out.push(...await Promise.all(jobs.slice(i, i + HISTORY_RATE).map((job) => job())));
    if (i + HISTORY_RATE < jobs.length && !enough()) await sleep(Math.max(0, started + 1_000 - Date.now()));
  }
  return out;
}
const authAbi = [
  { type: "function", name: "getTeeSigner", stateMutability: "view", inputs: [], outputs: [{ type: "address" }] },
  { type: "function", name: "getPubSecp521r1", stateMutability: "view", inputs: [], outputs: [{ type: "bytes" }] },
] as const;

/** `chain` with the read API first where only display depends on it: History and the cached Portfolio (`requests`, POST /v1/account)
 * and held rounds' results (`settled`, from the page's shared /v1/live read). Every money path and every request in flight still
 * reads the chain. A failed API read falls back to the chain read, which for results runs at most every 5 s, as before. */
export function indexedChain(chain: Chain, api: { account: NonNullable<Chain["requests"]>; live: () => Promise<Live | null> }, now: () => number = Date.now): Chain {
  let fallback: { at: number; key: string; answer: Promise<Settled[]> } | null = null;
  return {
    ...chain,
    requests: (account, before, limit) => api.account(account, before, limit),
    async settled(roundIds, fromBlock) {
      const wanted = roundIds.map((id) => id.toLowerCase() as Hex), live = await api.live();
      const rounds = new Map((live?.rounds ?? []).map((r) => [r.registryRoundId, r]));
      // /v1/live holds the previous, current and next rounds: the only ones whose result the client reads.
      if (wanted.every((id) => rounds.has(id))) return wanted.flatMap((id) => { const s = rounds.get(id)!.settle; return s ? [{ roundId: id, outcome: s.outcome }] : []; });
      const key = wanted.join(), t = now();
      if (!fallback || fallback.key !== key || t - fallback.at >= 5_000) fallback = { at: t, key, answer: chain.settled(roundIds, fromBlock) };
      return fallback.answer;
    },
  };
}

export function viemChain(client: PublicClient, book: Book, base: PublicClient, options: { sleep?: (ms: number) => Promise<void> } = {}): Chain {
  const { app, endpoint } = eventsOf(book);
  const sleep = options.sleep ?? ((ms: number) => new Promise<void>((resolve) => setTimeout(resolve, ms)));
  const auth = book.authenticator.address, c = book.custody;
  const events = { RequestSubmitted: getAbiItem({ abi: endpointAbi, name: "RequestSubmitted" }), RequestCompleted: getAbiItem({ abi: endpointAbi, name: "RequestCompleted" }), UserEvent: getAbiItem({ abi: endpointAbi, name: "UserEvent" }),
    AppEvent: getAbiItem({ abi: endpointAbi, name: "AppEvent" }), Deposited: getAbiItem({ abi: vaultAbi, name: "Deposited" }), Paid: getAbiItem({ abi: vaultAbi, name: "Paid" }) };
  const ours = <N extends "RequestSubmitted" | "UserEvent">(logs: Parameters<typeof parseEventLogs>[0]["logs"], eventName: N) =>
    parseEventLogs({ abi: endpointAbi, logs: logs.filter((l) => l.address.toLowerCase() === endpoint), eventName }).filter((l) => l.args.applicationId === app);
  // The guest's public events of this application and subtype since `fromBlock`, oldest first, within the last 1,000 blocks: a poll
  // that runs for minutes never asks for more.
  const appEvents = async (subtype: Hex, fromBlock: bigint) => {
    const head = await client.getBlockNumber(), floor = head - LOG_BLOCKS + 1n;
    return (await client.getLogs({ address: endpoint, event: events.AppEvent, args: { applicationId: app, eventSubType: subtype }, fromBlock: fromBlock > floor ? fromBlock : floor, toBlock: head })).map((l) => l.args.data ?? "0x");
  };
  return {
    async context(sender) {
      const block = await client.getBlock({ blockTag: "latest" });
      const at = { blockNumber: block.number };
      const [nonce, teeSigner, enclaveKey] = await Promise.all([
        client.readContract({ address: endpoint, abi: endpointAbi, functionName: "facilitatorNonces", args: [sender], ...at }),
        client.readContract({ address: auth, abi: authAbi, functionName: "getTeeSigner", ...at }),
        client.readContract({ address: auth, abi: authAbi, functionName: "getPubSecp521r1", ...at }),
      ]);
      return { block: block.number, nonce, timestamp: block.timestamp, teeSigner, enclaveKey };
    },
    async settle(sender, signature, nonce, deadline, fromBlock, txHash) {
      // The relayer's transaction and its receipt in one batch, instead of the four reads below: it counts only if its calldata carries
      // the signature and it logged this application's RequestSubmitted for this sender. Anything else reads the nonce as before.
      const named = txHash && await Promise.all([client.getTransaction({ hash: txHash }), client.getTransactionReceipt({ hash: txHash })]).catch(() => null);
      if (named) {
        const [tx, receipt] = named;
        const own = receipt.status === "success" && receipt.blockNumber >= fromBlock && tx.input.toLowerCase().includes(signature.slice(2).toLowerCase())
          ? ours(receipt.logs, "RequestSubmitted").find((l) => l.args.sender.toLowerCase() === sender.toLowerCase()) : undefined;
        if (own) return { requestId: own.args.requestId, block: receipt.blockNumber, txHash: receipt.transactionHash };
      }
      const block = await client.getBlock({ blockTag: "latest" });
      const next = await client.readContract({ address: endpoint, abi: endpointAbi, functionName: "facilitatorNonces", args: [sender], blockNumber: block.number });
      // submitRequestFor reverts past the deadline, and blocks only move forward: an unused nonce there stays unused by this signature.
      if (next <= nonce) return block.timestamp > deadline ? "absent" : "pending";
      const logs = await client.getLogs({ address: endpoint, event: events.RequestSubmitted, args: { applicationId: app, sender: getAddress(sender) }, fromBlock, toBlock: block.number });
      for (const l of logs) {
        // The signature's 65 bytes stand verbatim in the submitRequestFor calldata that carried it.
        const input = (await client.getTransaction({ hash: l.transactionHash! })).input.toLowerCase();
        if (input.includes(signature.slice(2).toLowerCase())) return { requestId: l.args.requestId!, block: l.blockNumber!, txHash: l.transactionHash! };
      }
      // The nonce went to another signature (another tab). A minute's grace past the deadline covers a node whose logs lag its state.
      return block.timestamp > deadline + 60n ? "absent" : "pending";
    },
    async completion(requestId, fromBlock) {
      const [done] = await client.getLogs({ address: endpoint, event: events.RequestCompleted, args: { applicationId: app, requestId }, fromBlock, toBlock: "latest" });
      if (!done) return null;
      // One receipt gives the encrypted receipt and the trigger's tick request of that same transaction.
      const receipt = await client.getTransactionReceipt({ hash: done.transactionHash! });
      const tick = ours(receipt.logs, "RequestSubmitted").find((l) => l.args.sender.toLowerCase() === book.trigger.address);
      return { requestId, status: done.args.status!, errorCode: done.args.errorCode!, errorMessage: done.args.errorMessage ?? "", txHash: done.transactionHash!, block: done.blockNumber!,
        ciphertexts: ours(receipt.logs, "UserEvent").filter((l) => l.args.requestId === requestId).map((l) => hexToBytes(l.args.encryptedData)), tick: tick?.args.requestId ?? null };
    },
    async sent(account) {
      const head = await client.getBlockNumber();
      return { head, total: await client.readContract({ address: endpoint, abi: endpointAbi, functionName: "facilitatorNonces", args: [getAddress(account)], blockNumber: head }) };
    },
    async history(account, { from, to, head, want }, stop = () => false) {
      const sender = getAddress(account), deploy = BigInt(book.application.deployBlock), start = from > deploy ? from : deploy;
      const chunks: [bigint, bigint][] = [];
      for (let top = to; top >= start; top -= LOG_BLOCKS) chunks.push([top - LOG_BLOCKS + 1n > start ? top - LOG_BLOCKS + 1n : start, top]);
      // Newest first: once `want` submissions are found, older blocks hold none of this account's requests.
      let count = 0n;
      const found = (await paced(chunks.map(([fromBlock, toBlock]) => async () => {
        const logs = await client.getLogs({ address: endpoint, event: events.RequestSubmitted, args: { applicationId: app, sender }, fromBlock, toBlock });
        count += BigInt(logs.length);
        return { toBlock, fromBlock, logs };
      }), sleep, stop, () => count >= want)).filter((c) => c.logs.length);
      // Simplification: a receipt is read in its request's chunk and the next one (1,000-2,000 blocks); a completion slower than that is
      // listed as "No private record". Topic lists stay at 50 IDs.
      const reads: (() => Promise<{ requestId: Hex; txHash: Hex; data: Hex }[]>)[] = [];
      for (const { fromBlock: low, toBlock: high, logs } of found) {
        const ranges: [bigint, bigint][] = high < head ? [[low, high], [high + 1n, high + LOG_BLOCKS < head ? high + LOG_BLOCKS : head]] : [[low, high]];
        for (let i = 0; i < logs.length; i += 50) {
          const requestId = logs.slice(i, i + 50).map((l) => l.args.requestId!);
          for (const [fromBlock, toBlock] of ranges) reads.push(async () => (await client.getLogs({ address: endpoint, event: events.UserEvent, args: { applicationId: app, requestId }, fromBlock, toBlock }))
            .map((l) => ({ requestId: l.args.requestId!, txHash: l.transactionHash!, data: l.args.encryptedData! })));
        }
      }
      const receipts = (await paced(reads, sleep, stop)).flat();
      const mine = found.flatMap((c) => c.logs).sort((a, b) => a.blockNumber! === b.blockNumber! ? a.logIndex! - b.logIndex! : a.blockNumber! < b.blockNumber! ? -1 : 1);
      return mine.map((l) => {
        const own = receipts.filter((r) => r.requestId === l.args.requestId);
        return { requestId: l.args.requestId!, block: l.blockNumber!, txHash: own[0]?.txHash ?? l.transactionHash!, ciphertexts: own.map((r) => hexToBytes(r.data)) };
      });
    },
    head: () => client.getBlockNumber(),
    wallet: (account) => base.readContract({ address: c.usdc.address, abi: usdcAbi, functionName: "balanceOf", args: [account] }),
    async baseContext(owner) {
      const block = await base.getBlock({ blockTag: "latest" }), at = { blockNumber: block.number };
      const [permitNonce, balance] = await Promise.all([
        base.readContract({ address: c.usdc.address, abi: usdcAbi, functionName: "nonces", args: [owner], ...at }),
        base.readContract({ address: c.usdc.address, abi: usdcAbi, functionName: "balanceOf", args: [owner], ...at }),
      ]);
      return { block: block.number, timestamp: block.timestamp, permitNonce, balance };
    },
    async deposited(owner, fromBlock) {
      // From the block after the one read before signing: an earlier deposit of this account can never match.
      const [log] = await base.getLogs({ address: c.vault.address, event: events.Deposited, args: { account: getAddress(owner) }, fromBlock: fromBlock + 1n, toBlock: "latest" });
      return log ? { index: log.args.index!, txHash: log.transactionHash! } : null;
    },
    async arrived(index) {
      const [account] = await client.readContract({ address: c.inbox.address, abi: inboxAbi, functionName: "deposits", args: [index] });
      return account.toLowerCase() !== ZERO_ADDRESS;
    },
    async credited(index, fromBlock) {
      const found = (await appEvents(SUBTYPES.credit, fromBlock)).map(decodeCredit).find((x) => x?.index === index);
      return found ? { status: found.status, amount: found.amount } : null;
    },
    async approved(ordinal, fromBlock) {
      return (await appEvents(SUBTYPES.payout, fromBlock)).map(decodePayout).some((x) => x?.applicationId === app && x.ordinal === ordinal);
    },
    async paid(ordinal, fromBlock) {
      const [log] = await base.getLogs({ address: c.vault.address, event: events.Paid, args: { applicationId: app, ordinal }, fromBlock, toBlock: "latest" });
      return log?.transactionHash ?? null;
    },
    async settled(roundIds, fromBlock) {
      const wanted = new Set(roundIds.map((id) => id.toLowerCase()));
      // Kind 1 is an opening; 2 resolves and 3 voids.
      return (await appEvents(SUBTYPES.settle, fromBlock)).map(decodeSettle).flatMap((x) => x && x.kind !== 1 && wanted.has(x.roundId) ? [{ roundId: x.roundId, outcome: x.outcome }] : []);
    },
  };
}

/** The relayer, called with this session's Privy tokens as headers (never cookies). An answer that never arrived or cannot be read
 * (a dropped connection, the host's timeout page) is "UNKNOWN": the request may have been sent, and the client settles it from the chain. */
export function fetchRelay(path: string, headers: () => Promise<Record<string, string>>): Relay {
  return {
    async post(body) {
      let auth: Record<string, string>, response: Response;
      try { auth = await headers(); } catch { return { ok: false, status: 401, code: "UNAUTHENTICATED", message: "no session" }; }
      try {
        response = await fetch(path, { method: "POST", headers: { "content-type": "application/json", ...auth }, body: JSON.stringify(body), credentials: "omit" });
      } catch { return { ok: false, status: 0, code: "UNKNOWN", message: "no answer" }; }
      const answer = await response.json().catch(() => null) as Record<string, unknown> | null;
      if (!answer || typeof answer !== "object") return { ok: false, status: response.status, code: "UNKNOWN", message: "unreadable answer" };
      const txHash = typeof answer.txHash === "string" && /^0x[0-9a-f]{64}$/i.test(answer.txHash) ? answer.txHash as Hex : undefined;
      // 202 SENT_UNCONFIRMED: sent, its receipt not seen yet; the client follows the chain itself.
      const id = (v: unknown) => typeof v === "string" && /^0x[0-9a-f]{64}$/i.test(v) ? v as Hex : undefined;
      if ((answer.ok === true || response.status === 202) && txHash) return { ok: true, status: response.status, txHash, requestId: id(answer.requestId), duplicate: answer.duplicate === true };
      return { ok: false, status: response.status, code: typeof answer.code === "string" ? answer.code : "UNKNOWN", message: typeof answer.message === "string" ? answer.message : "", retryAfter: typeof answer.retryAfter === "number" ? answer.retryAfter : undefined, txHash };
    },
  };
}
