/** Evaluation-only client side of the ZEDGE Vela guest (adapters/vela/guest).
 * The canonical engine-command encoder, the two envelope bodies the guest
 * accepts and the request IDs its receipts carry. No keys, RPC or storage.
 * The protocol is adapters/vela/guest/README.md; the shared test vectors are
 * adapters/vela/guest/testdata/vectors.json.
 */
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

/** What the guest puts in a receipt envelope's body. `receipt` is the engine's
 * projection for this account only: it never names a counterparty. Every
 * receipt answers a request of the account it goes to, and every plaintext is
 * padded to a multiple of RECEIPT_BYTES. */
export const RECEIPT_BYTES = 2048;
export interface ReceiptBody {
  type: "command" | "deposit" | "sync";
  status: "applied" | "retry" | "rejected" | "credited" | "requested";
  reason?: string;
  receipt?: {
    sequence: number;
    commandId?: string;
    status: string;
    roundId?: string;
    orderId?: string;
    withdrawalId?: string;
    amount?: number;
    fills?: { orderId: string; role: string; side: string; roundId: string; outcome: string; price: number; quantity: number; fee: number }[];
    releasedOrders?: string[];
  };
  deposit?: number;
  registered?: boolean;
  withdrawal?: number;
  /** The trusted clock the request was judged at: the last tick applied before
   * it. Compare `timestamp` with the block that carried the request; a large
   * gap means the clock was stale or held back. All zero before the first tick. */
  at: { tick: number; block: number; timestamp: number };
  /** The tick this request asked for. Absent on a deposit receipt. */
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
/** The request ID of this account's count-th deposit receipt, the one kind of
 * receipt that answers no command of its own. */
export function noticeRequestId(account: string, count: number): string {
  return `${account}:notice:${atoms("count", count)}`;
}

/** Envelope body for a command: `session.encryptCommand(command.id, commandBody(command))`. */
export function commandBody(value: EngineCommand): { type: "command"; command: string } {
  return { type: "command", command: encodeCommand(value) };
}
/** Envelope body that asks the trigger for a clock tick:
 * `session.encryptCommand(syncRequestId(account), syncBody())`. */
export function syncBody(): { type: "sync" } {
  return { type: "sync" };
}
