/** Evaluation-only client side of the ZEDGE Vela guest (adapters/vela/guest).
 * The canonical engine-command encoder, the four envelope bodies the guest
 * accepts, the request IDs its receipts carry, decoders for its public
 * records, and the operator-resolved event's round and signed result. No
 * keys, RPC or storage.
 * The protocol is adapters/vela/guest/README.md; the shared test vectors are
 * adapters/vela/guest/testdata/vectors.json.
 */
import { AbiCoder, keccak256, sha256, toUtf8Bytes } from "ethers";

export interface EngineDomain {
  chainId: number;
  endpoint: string;
  applicationId: string;
  rulesVersion: number;
}
export interface EngineRound {
  asset: string;
  feed: string;
  registryRoundId: string;
  start: number;
  end: number;
  cutoff: number;
  observationWindow: number;
  openingDeadline: number;
  voidableAfter: number;
}
export interface EngineObservation {
  feedId: string;
  /** Exact 18-decimal price as decimal text. Never a number. */
  price: string;
  validFromTimestamp: number;
  observationsTimestamp: number;
  expiresAt: number;
  reportHash: string;
  decimals: number;
}
export interface EngineCommand {
  domain: EngineDomain;
  id: string;
  nonce: number;
  op: string;
  account?: string;
  roundId?: string;
  round?: EngineRound;
  amount?: number;
  outcome?: string;
  side?: string;
  price?: number;
  quantity?: number;
  tif?: string;
  expiry?: number;
  maxFee?: number;
  orderId?: string;
  withdrawalId?: string;
  destination?: string;
  evidence?: string;
  registryTime?: number;
  observation?: EngineObservation;
}

/** The engine's projection of one command's receipt for this account only: it
 * never names a counterparty. */
export interface EngineReceipt {
  sequence: number;
  commandId?: string;
  status: string;
  roundId?: string;
  orderId?: string;
  withdrawalId?: string;
  amount?: number;
  fills?: { orderId: string; role: string; side: string; roundId: string; outcome: string; price: number; quantity: number; fee: number }[];
  releasedOrders?: string[];
}
/** What the guest puts in a receipt envelope's body. Every receipt answers a
 * request of the account it goes to, and every plaintext is padded to a
 * multiple of RECEIPT_BYTES. */
export const RECEIPT_BYTES = 8192;
export interface ReceiptBody {
  type: "command" | "sync" | "report" | "resolve";
  /** "staged": a book command waits for the tick that applies it; its result
   * comes back as `outcome` with the account's next request. */
  status: "applied" | "retry" | "rejected" | "staged" | "requested";
  reason?: string;
  receipt?: EngineReceipt;
  /** The payout ordinal of an accepted withdrawal: the vault on Base pays it
   * once, by (applicationId, ordinal). */
  withdrawal?: number;
  /** What a tick did with this account's staged book command, returned once,
   * by the account's next accepted request of any kind. An applied outcome
   * carries that command's receipt (its fills) while it is still the account's
   * stored last receipt. */
  outcome?: { account: string; commandId: string; tick: number; status: "applied" | "rejected"; reason?: string; receipt?: EngineReceipt };
  /** The account after this request (engine.AccountView); absent if it is not
   * registered. A maker learns of its fills here. Take the next nonce from
   * here, never from a local count: a settlement sweep redeems in the
   * account's own name and uses a nonce. */
  view?: {
    account: string; sequence: number; nonce: number; cash: number; reservedCash: number;
    holdings: { roundId: string; up: number; down: number; reservedUp: number; reservedDown: number }[];
    orders: { id: string; roundId: string; outcome: string; side: string; price: number; original: number; remaining: number; filled: number;
      filledNotional: number; feePaid: number; maxFee: number; reservedCash: number; sequence: number; expiry: number }[];
    withdrawals: unknown[];
  };
  /** The trusted clock the request was judged at: the last tick applied before
   * it. Compare `timestamp` with the block that carried the request; a large
   * gap means the clock was stale or held back. All zero before the first tick. */
  at: { tick: number; block: number; timestamp: number };
  /** The tick this request asked for. Absent on a report or resolve receipt: neither asks for one. */
  tick?: number;
  /** Zeros. Ignore. */
  pad: string;
}

type Encode = (name: string, value: unknown) => string;
type Field = readonly [name: string, encode: Encode, required: boolean];

// The engine caps every amount, nonce and time here, below the largest integer
// a JavaScript number holds exactly.
const MAX = 1_000_000_000_000_000;
// Printable ASCII that Go's encoding/json and JSON.stringify write the same
// way: no quote, backslash, <, > or &. No valid command field needs any other.
const plain = /^[\x20\x21\x23-\x25\x27-\x3b\x3d\x3f-\x5b\x5d-\x7e]*$/;

const text: Encode = (name, value) => {
  if (typeof value !== "string" || !plain.test(value)) throw new Error(`Command field ${name} must be plain ASCII text.`);
  return `"${value}"`;
};
const integer = (max: number): Encode => (name, value) => {
  if (typeof value !== "number" || !Number.isSafeInteger(value) || value < 0 || value > max) {
    throw new Error(`Command field ${name} must be an integer from 0 to ${max}.`);
  }
  return String(value);
};
const atoms = integer(MAX);
const u32 = integer(0xffff_ffff);

// Fields go out in the Go struct's order. An optional field that is absent,
// empty or zero is left out, exactly as Go's omitempty leaves it out.
const object = (fields: readonly Field[]): Encode => (name, value) => {
  if (!value || typeof value !== "object" || Array.isArray(value)) throw new Error(`Command field ${name} must be an object.`);
  const record = value as Record<string, unknown>;
  for (const key of Object.keys(record)) {
    if (!fields.some(([known]) => known === key)) throw new Error(`Unknown command field ${name}.${key}.`);
  }
  const parts: string[] = [];
  for (const [key, encode, required] of fields) {
    const item = record[key];
    if (item === undefined || item === null) {
      if (required) throw new Error(`Missing command field ${name}.${key}.`);
      continue;
    }
    // Encode first: an empty value of the wrong type (0 for a text field, ""
    // for a number or an object) must throw, not vanish. Only what Go itself
    // would omit, an empty string or a zero number of the right type, is skipped.
    const encoded = encode(`${name}.${key}`, item);
    if (!required && (encoded === '""' || encoded === "0")) continue;
    parts.push(`"${key}":${encoded}`);
  }
  return `{${parts.join(",")}}`;
};

const domain = object([["chainId", atoms, true], ["endpoint", text, true], ["applicationId", text, true], ["rulesVersion", u32, true]]);
const round = object([["asset", text, true], ["feed", text, true], ["registryRoundId", text, true], ["start", atoms, true],
  ["end", atoms, true], ["cutoff", atoms, true], ["observationWindow", atoms, true], ["openingDeadline", atoms, true],
  ["voidableAfter", atoms, true]]);
const observation = object([["feedId", text, true], ["price", text, true], ["validFromTimestamp", u32, true],
  ["observationsTimestamp", u32, true], ["expiresAt", u32, true], ["reportHash", text, true], ["decimals", integer(0xff), true]]);
const command = object([["domain", domain, true], ["id", text, true], ["nonce", atoms, true], ["op", text, true],
  ["account", text, false], ["roundId", text, false], ["round", round, false], ["amount", atoms, false], ["outcome", text, false],
  ["side", text, false], ["price", atoms, false], ["quantity", atoms, false], ["tif", text, false], ["expiry", atoms, false],
  ["maxFee", atoms, false], ["orderId", text, false], ["withdrawalId", text, false], ["destination", text, false],
  ["evidence", text, false], ["registryTime", atoms, false], ["observation", observation, false]]);

/** The one byte string `engine.DecodeCommand` accepts for this command. Its
 * SHA-256 is the command digest. Throws rather than emit anything the engine
 * would read differently: unsafe or fractional numbers, unknown fields, text
 * that the two JSON writers escape differently. */
export function encodeCommand(value: EngineCommand): string {
  return command("command", value);
}

/** A command's ID, and the request ID of its envelope and of its receipt. */
export function commandId(account: string, nonce: number): string {
  return `${account}:${atoms("nonce", nonce)}`;
}
/** The request ID a sync envelope must carry, and of the receipt it gets. */
export function syncRequestId(account: string): string {
  return `${account}:sync`;
}
/** The request ID a report envelope must carry, and of the receipt it gets:
 * the report's observationsTimestamp, a round boundary. */
export function reportRequestId(account: string, observationsTimestamp: number): string {
  return `${account}:report:${u32("observationsTimestamp", observationsTimestamp)}`;
}

/** Envelope body for a command. The guest accepts only padded requests (pad.ts):
 * `session.encryptCommand(command.id, padBody(session, command.id, commandBody(command)))`. */
export function commandBody(value: EngineCommand): { type: "command"; command: string } {
  return { type: "command", command: encodeCommand(value) };
}
/** Envelope body that asks the trigger for a clock tick, padded like every request (pad.ts):
 * `session.encryptCommand(syncRequestId(account), padBody(session, syncRequestId(account), syncBody()))`. */
export function syncBody(): { type: "sync" } {
  return { type: "sync" };
}
/** Envelope body that hands the guest a Chainlink Data Streams full report
 * (0x-prefixed hex, as the verifier takes it), padded like every request:
 * `session.encryptCommand(reportRequestId(account, ts), padBody(session, reportRequestId(account, ts), reportBody(hex)))`.
 * The guest checks the DON signatures itself; anyone may send one. */
export function reportBody(fullReportHex: string): { type: "report"; report: string } {
  if (!/^0x([0-9a-fA-F]{2})+$/.test(fullReportHex)) throw new Error("A full report is 0x-prefixed hex.");
  let binary = "";
  for (let i = 2; i < fullReportHex.length; i += 2) binary += String.fromCharCode(parseInt(fullReportHex.slice(i, i + 2), 16));
  return { type: "report", report: btoa(binary) };
}

/** The terms of a deployment's operator-resolved Yes/No event (guest README
 * section 13), as its deploy parameters carry them: the 0x Keccak-256 of the
 * exact rules text, and its times in UTC seconds. */
export interface EventTerms {
  question: string;
  start: number;
  cutoff: number;
  end: number;
  voidableAfter: number;
}

/** The event's engine round exactly as engine.NewEventSpec and engine.RoundID
 * derive it, from the deployment's canonical engine configuration JSON (a
 * manifest's engineConfigJson, application ID included). `id` (64 hex, no 0x)
 * names the round in commands, holdings and the resolver's signed result;
 * `spec.registryRoundId` names it in the guest's settle record. Up is Yes,
 * Down is No. */
export function eventRound(engineConfigJson: string, event: EventTerms): { id: string; spec: EngineRound } {
  const { question, start, cutoff, end, voidableAfter } = event;
  // A fraction or an unsafe integer is refused by the ABI encoder below.
  if (!/^0x[0-9a-f]{64}$/.test(question) || /^0x0{64}$/.test(question) || !(0 < start && start < cutoff && cutoff <= end && end < voidableAfter && voidableAfter <= 0xffff_ffff)) {
    throw new Error("Invalid event terms.");
  }
  const o = (JSON.parse(engineConfigJson) as { oracle: { chainId: number; registry: string; rulesHash: string } }).oracle;
  // Asset 2: a registry asset that does not exist, so this can never name a price round.
  const registryRoundId = keccak256(AbiCoder.defaultAbiCoder().encode(["uint256", "address", "bytes32", "uint8", "bytes32", "uint64", "uint64", "uint64", "uint64"],
    [o.chainId, o.registry, o.rulesHash, 2, question, start, cutoff, end, voidableAfter]));
  const spec: EngineRound = { asset: "EVENT", feed: question, registryRoundId, start, end, cutoff, observationWindow: 0, openingDeadline: start, voidableAfter };
  return { id: sha256(toUtf8Bytes(`{"config":${engineConfigJson},"round":${JSON.stringify(spec)}}`)).slice(2), spec };
}

export const EVENT_RESULT_TYPES = {
  EventResult: [{ name: "applicationId", type: "uint64" }, { name: "roundId", type: "bytes32" }, { name: "outcome", type: "uint8" }],
} as const;

/** The EIP-712 typed data the event's resolver signs: outcome 1 (Yes, Up) or
 * 2 (No, Down) for engine round `roundId` of this deployment (engine domain:
 * chain, endpoint, application). viem: `account.signTypedData(t)`; ethers:
 * `wallet.signTypedData(t.domain, t.types, t.message)`. */
export function eventResultTypedData(domain: EngineDomain, roundId: string, outcome: 1 | 2) {
  if (!/^[0-9a-f]{64}$/.test(roundId) || (outcome !== 1 && outcome !== 2)) throw new Error("An event result is outcome 1 or 2 for a 64-hex engine round ID.");
  return { domain: { name: "ZEDGE Event", version: "1", chainId: BigInt(domain.chainId), verifyingContract: domain.endpoint }, types: EVENT_RESULT_TYPES,
    primaryType: "EventResult" as const, message: { applicationId: BigInt(domain.applicationId), roundId: `0x${roundId}`, outcome } };
}

/** The request ID an event result's envelope must carry, and of the receipt it gets. */
export function resolveRequestId(account: string): string {
  return `${account}:resolve`;
}
/** Envelope body that hands the guest the resolver's signed result, padded
 * like every request (pad.ts):
 * `session.encryptCommand(resolveRequestId(account), padBody(session, resolveRequestId(account), resolveBody(outcome, signature)))`.
 * Anyone may send it: the guest checks the signature against the resolver
 * pinned at deploy. `signature` is what signTypedData returns: 0x, r, s, v. */
export function resolveBody(outcome: 1 | 2, signature: string): { type: "resolve"; outcome: 1 | 2; signature: string } {
  if ((outcome !== 1 && outcome !== 2) || !/^0x[0-9a-f]{128}(1b|1c)$/.test(signature)) {
    throw new Error("An event result is outcome 1 or 2 and a 65-byte signature in lowercase 0x hex with v 27 or 28.");
  }
  return { type: "resolve", outcome, signature };
}

/** SHA-256 of each public record's label: the app event subtypes the guest
 * publishes (guest README section 11). */
export const SUBTYPES = {
  receipt: "0x124f25ec420301d96ad47008349df043146fa7ec26b5d9118962a276e3219968",
  tick: "0x8af869f39217eabc1718875ec064086a0e0283d1c1ee8a025b687fd40b5e3850",
  clock: "0xfcec946954aa78965de9f0bba32063a87447ec772e05beb1e50c0e36f5f09460",
  archive: "0xefe437757209e66cb09e68c2bfe69073f2740c38bea74805a8b00d3b3de3df7a",
  settle: "0x9724dc1f896290cab5003edb2c481613b0c459f9303c263ec7329d4cb9a96b8a",
  credit: "0xb1807d8ab6b87b4b474b995387ae70c1a0c01ddb90d1917c6d19137492025a83",
  payout: "0x9fc2837b9dcfdefb06f5377ff328e142b9ed980ed670176fafad9020c17462e9",
  confirm: "0x5e1da736494552c71e66d707b803cd0347c26ea64f7b1dcb89d0c0375ce29b0a",
} as const;

// A record's data as 32-byte words.
function recordWords(data: string, count: number): string[] {
  if (!/^0x[0-9a-fA-F]*$/.test(data) || data.length !== 2 + 64 * count) throw new Error(`A record of ${count} words was expected.`);
  return Array.from({ length: count }, (_, i) => data.slice(2 + 64 * i, 66 + 64 * i).toLowerCase());
}
const big = (word: string) => BigInt(`0x${word}`);
const hash = (word: string) => `0x${word}`;
const addr = (word: string) => `0x${word.slice(24)}`;

/** A round the guest opened (kind 1), resolved (2) or voided (3), from a
 * report (source 1), the registry (2), its own void rule (3, the event's
 * timeout void included) or the event's resolver (4). Outcome 1 Up (Yes),
 * 2 Down (No), 3 Void, 0 while open. Price is the 18-decimal integer; it,
 * the time and the report hash are zero for the event. */
export function decodeSettle(data: string) {
  const w = recordWords(data, 7);
  return { roundId: hash(w[0]!), kind: Number(big(w[1]!)), outcome: Number(big(w[2]!)), price: big(w[3]!), observationsTimestamp: Number(big(w[4]!)),
    reportHash: hash(w[5]!), source: Number(big(w[6]!)) };
}
/** A Base deposit the guest processed: status 1 credited, 2 refunded through
 * the payout with this ordinal (0 when credited). Amount in Base USDC atoms. */
export function decodeCredit(data: string) {
  const w = recordWords(data, 5);
  return { index: big(w[0]!), account: addr(w[1]!), amount: big(w[2]!), status: Number(big(w[3]!)), payout: big(w[4]!) };
}
/** A payout the vault pays once: kind 1 a withdrawal, 2 a deposit refund. */
export function decodePayout(data: string) {
  const w = recordWords(data, 6);
  return { applicationId: big(w[0]!), ordinal: big(w[1]!), kind: Number(big(w[2]!)), account: addr(w[3]!), to: addr(w[4]!), amount: big(w[5]!) };
}
/** The registry's record of a round the guest settled from a report: agree
 * 1 yes, 0 no (the guest's result stands), 2 given up unconfirmed. */
export function decodeConfirm(data: string) {
  const w = recordWords(data, 6);
  return { roundId: hash(w[0]!), agree: Number(big(w[1]!)), engineOutcome: Number(big(w[2]!)), registryOutcome: Number(big(w[3]!)),
    engineClosing: hash(w[4]!), registryClosing: hash(w[5]!) };
}
/** What a tick applied: tick, block, timestamp, registry records applied and
 * skipped, deposits processed, and the Keccak-256 of its payload. */
export function decodeClock(data: string) {
  const w = recordWords(data, 7);
  return { tick: big(w[0]!), block: big(w[1]!), timestamp: Number(big(w[2]!)), applied: Number(big(w[3]!)), skipped: Number(big(w[4]!)),
    deposits: Number(big(w[5]!)), payloadHash: hash(w[6]!) };
}
